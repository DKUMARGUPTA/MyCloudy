/**
 * Card maker drawing engine — ONE implementation shared by the worker
 * (OffscreenCanvas → PDF/JPG/PNG), the surface live preview
 * (HTMLCanvasElement) and the smoke script, so every consumer paints
 * identical pages (the WYSIWYG guarantee).
 *
 * The caller owns the canvas size: everything in the recipe is
 * expressed in PDF points (see model.ts) and scaled here by
 * `canvasWidth / pagePtWidth`, so a 420 px preview and a 1684 px export
 * raster line up exactly. Works with both HTMLCanvasElement 2D and
 * OffscreenCanvas 2D contexts.
 *
 * Template backgrounds are fetched once via the same-origin static
 * route ("/card-templates/<id>.jpg"). ANY fetch/decode failure falls
 * back to a programmatic gradient in the template's palette — a card
 * export never dies because one image 404'd (smoke covers this path).
 */

import {
  coverCrop,
  fitHeadline,
  hexLuminance,
  inkHex,
  layoutMessage,
  pagePtSize,
  sheetPanelsPt,
  templateById,
  wrapText,
  type CardFormat,
  type CardOrientation,
  type CardSheet,
  type CardTexts,
} from "./model";

/* ------------------------------ contexts ------------------------------ */

/** Anything drawImage accepts as a raster source. */
export type CardSource =
  | ImageBitmap
  | HTMLImageElement
  | HTMLCanvasElement
  | OffscreenCanvas;

/** 2D context of either canvas flavour (drawImage-compatible with both). */
export type CardCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Devanagari-capable browser font stacks (collage's stack, reused).
 * EVERY stack puts a Devanagari-capable family first-ish because Hindi
 * text renders in every field. The headline uses a serif display
 * variant of the same family chain. No Google Fonts, no external URLs.
 */
export const TEXT_FONT_STACK =
  "'Noto Sans Devanagari', 'Noto Sans', system-ui, sans-serif";
export const HEADLINE_FONT_STACK =
  "'Noto Serif Devanagari', 'Noto Sans Devanagari', 'Noto Serif', Georgia, serif";

/* ------------------------------ helpers ------------------------------ */

/** Rounded-rect path that works on both context types (collage copy). */
export function roundRectPath(
  ctx: CardCtx,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = /^#[0-9a-fA-F]{6}$/.test(hex.trim())
    ? hex.trim().slice(1)
    : "1c1917";
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ------------------------- backdrop painting ------------------------- */

/**
 * Programmatic backdrop fallback: a diagonal linear gradient in the
 * template's palette colours + the accent hairline frame, so a failed
 * background fetch still looks like a designed card (never white,
 * never a crash).
 */
export function paintBackdropFallback(
  ctx: CardCtx,
  x: number,
  y: number,
  w: number,
  h: number,
  palette: [string, string],
  accent: string
): void {
  const gradient = ctx.createLinearGradient(x, y, x + w, y + h);
  gradient.addColorStop(0, palette[0]);
  gradient.addColorStop(1, palette[1]);
  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, w, h);
  paintAccentFrame(ctx, x, y, w, h, accent);
}

/** Thin rounded frame used by the blank template and the fallback. */
function paintAccentFrame(
  ctx: CardCtx,
  x: number,
  y: number,
  w: number,
  h: number,
  accent: string
): void {
  const inset = Math.min(w, h) * 0.055;
  ctx.save();
  roundRectPath(
    ctx,
    x + inset,
    y + inset,
    w - inset * 2,
    h - inset * 2,
    Math.min(w, h) * 0.045
  );
  ctx.strokeStyle = hexToRgba(accent, 0.55);
  ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.004);
  ctx.stroke();
  ctx.restore();
}

/** Cover-crops an image raster into a pixel rect. */
function drawCoverImage(
  ctx: CardCtx,
  image: CardSource,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const crop = coverCrop(image.width, image.height, w, h);
  if (crop.sw <= 0 || crop.sh <= 0) return;
  ctx.drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, x, y, w, h);
}

/* --------------------------- backdrop loader --------------------------- */

const backdropCache = new Map<string, CardSource | null>();

/** Test hook — the smoke resets the cache between fetch scenarios. */
export function clearBackdropCache(): void {
  for (const source of backdropCache.values()) {
    if (source && "close" in source && typeof source.close === "function") {
      source.close();
    }
  }
  backdropCache.clear();
}

/**
 * Loads a template background once (same-origin static asset). The
 * relative URL resolves against the worker script origin — works in
 * dev and on Vercel. On ANY fetch/decode failure the result is cached
 * as null and the caller paints the gradient fallback instead.
 */
export async function loadTemplateBackdrop(
  templateBg: string | null
): Promise<CardSource | null> {
  if (templateBg === null) return null;
  if (backdropCache.has(templateBg)) return backdropCache.get(templateBg) ?? null;
  try {
    const response = await fetch(templateBg);
    if (!response.ok) throw new Error(`http-${response.status}`);
    const buffer = await response.arrayBuffer();
    const bitmap = await createImageBitmap(
      new Blob([buffer], { type: "image/jpeg" })
    );
    backdropCache.set(templateBg, bitmap);
    return bitmap;
  } catch {
    backdropCache.set(templateBg, null); // negative cache — a 404 stays a 404
    return null;
  }
}

/* ------------------------------ sheet paint ------------------------------ */

/** The recipe drawCardSheet understands (texts already merge-substituted). */
export interface CardRenderStyle {
  template: string;
  format: CardFormat;
  orientation: CardOrientation;
  texts: CardTexts;
  /** Blank-template background colour (#rrggbb). */
  background: string;
}

export interface CardImages {
  /** The selected photo raster (null while decoding). */
  photo: CardSource | null;
  /** Template background raster (null → gradient fallback / blank colour). */
  backdrop: CardSource | null;
}

/** Honest overflow flags for the surface's preview badges. */
export interface CardSheetMetrics {
  headlineOverflowed: boolean;
  messageOverflowed: boolean;
}

interface LineBlock {
  lines: string[];
  fontPt: number;
  lineHeightRatio: number;
  weight: number;
  stack: string;
  fill: string;
}

/**
 * Paints one PDF sheet onto the caller's canvas (the worker paints one
 * per page; the preview paints the currently shown sheet). Layout
 * blocks are computed from the same model math the smoke verifies:
 *  - flat sheet  — one panel with the full text stack (to, headline,
 *    sub, photo, message, venue, from);
 *  - fold-outside — back cover (left half: to + from) and front cover
 *    (right half: headline, sub, photo, venue);
 *  - fold-inside — inside-left (accent rule + venue) and inside-right
 *    (the message panel).
 * Returns the overflow metrics of everything drawn.
 */
export function drawCardSheet(
  ctx: CardCtx,
  sheet: CardSheet,
  style: CardRenderStyle,
  images: CardImages,
  hasPhoto: boolean
): CardSheetMetrics {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  if (W <= 0 || H <= 0) {
    return { headlineOverflowed: false, messageOverflowed: false };
  }
  const pt = pagePtSize(style.format, style.orientation);
  const s = W / pt.w;
  const template = templateById(style.template);
  const blank = template.bg === null;
  const ink = blank ? inkHex(style.background) : template.ink;
  const accent = blank
    ? hexLuminance(style.background) > 0.55
      ? "#a8a29e"
      : "#d6d3d1"
    : template.accent;
  const muted = hexToRgba(ink, 0.82);

  const metrics: CardSheetMetrics = {
    headlineOverflowed: false,
    messageOverflowed: false,
  };

  /* Panel backdrop + accent frame. */
  const panels = sheetPanelsPt(style.format, style.orientation, sheet.kind);
  for (const panel of panels) {
    const px = panel.x * s;
    const py = panel.y * s;
    const pw = panel.w * s;
    const ph = panel.h * s;
    if (blank) {
      ctx.fillStyle = style.background;
      ctx.fillRect(px, py, pw, ph);
      paintAccentFrame(ctx, px, py, pw, ph, accent);
    } else if (images.backdrop !== null) {
      // Each panel cover-crops the SAME artwork independently, so every
      // face of the card reads as a complete portrait design.
      drawCoverImage(ctx, images.backdrop, px, py, pw, ph);
    } else {
      paintBackdropFallback(ctx, px, py, pw, ph, template.palette, accent);
    }
  }

  /* Measurement adapters (font-aware, px-space). */
  const measureWith =
    (stack: string, weight: number) =>
    (text: string, sizePt: number): number => {
      ctx.font = `${weight} ${sizePt * s}px ${stack}`;
      return ctx.measureText(text).width;
    };
  const measureHeadline = measureWith(HEADLINE_FONT_STACK, 700);
  const measureBody = measureWith(TEXT_FONT_STACK, 400);

  /** Centered wrapped text block. */
  const drawCentered = (
    cx: number,
    top: number,
    maxWidth: number,
    block: LineBlock
  ): number => {
    if (block.lines.length === 0) return top;
    ctx.save();
    ctx.font = `${block.weight} ${block.fontPt * s}px ${block.stack}`;
    ctx.fillStyle = block.fill;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let y = top + (block.fontPt * block.lineHeightRatio * s) / 2;
    for (const line of block.lines) {
      if (line !== "") ctx.fillText(line, cx, y);
      y += block.fontPt * block.lineHeightRatio * s;
    }
    ctx.restore();
    return y - (block.fontPt * block.lineHeightRatio * s) / 2;
  };

  /** The photo slot (rounded, white frame, cover-crop) — returns its bottom. */
  const drawPhoto = (cx: number, top: number, photoW: number): number => {
    const photoH = photoW * 0.75;
    const x = cx - photoW / 2;
    const frame = 5; // pt
    const radius = photoW * 0.09;
    ctx.save();
    roundRectPath(
      ctx,
      (x - frame) * s,
      (top - frame) * s,
      (photoW + frame * 2) * s,
      (photoH + frame * 2) * s,
      (radius + frame) * s
    );
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "rgba(28, 25, 23, 0.14)";
    ctx.lineWidth = Math.max(1, s);
    ctx.stroke();
    roundRectPath(ctx, x * s, top * s, photoW * s, photoH * s, radius * s);
    ctx.clip();
    if (images.photo !== null) {
      drawCoverImage(ctx, images.photo, x * s, top * s, photoW * s, photoH * s);
    } else {
      // Decoding placeholder — the final repaint fills the photo in.
      ctx.fillStyle = "rgba(255, 255, 255, 0.38)";
      ctx.fillRect(x * s, top * s, photoW * s, photoH * s);
    }
    ctx.restore();
    return top + photoH;
  };

  /* ------------------------------ flat sheet ------------------------------ */
  if (sheet.kind === "flat") {
    const [panel] = panels;
    const pw = panel.w;
    const ph = panel.h;
    const cx = pw / 2;
    const pad = Math.min(pw, ph) * 0.075;

    // To-line (small, muted).
    let y = pad * 0.8;
    if (style.texts.to.trim() !== "") {
      const toLines = wrapText(style.texts.to, pw - pad * 2, (t) =>
        measureBody(t, 10.5)
      );
      y = drawCentered(cx, y, pw, {
        lines: toLines,
        fontPt: 10.5,
        lineHeightRatio: 1.35,
        weight: 500,
        stack: TEXT_FONT_STACK,
        fill: muted,
      });
    }

    // Headline (shrink-to-fit).
    y += 12;
    const headline = fitHeadline(
      style.texts.headline,
      {
        baseSizePt: 30,
        minSizePt: 14,
        stepPt: 2,
        maxWidthPt: pw - pad * 2,
        maxLines: 3,
        lineHeightRatio: 1.15,
        maxHeightPt: ph * 0.22,
      },
      measureHeadline
    );
    metrics.headlineOverflowed = headline.overflowed;
    if (headline.lines.length > 0) {
      y = drawCentered(cx, y, pw, {
        lines: headline.lines,
        fontPt: headline.sizePt,
        lineHeightRatio: 1.15,
        weight: 700,
        stack: HEADLINE_FONT_STACK,
        fill: ink,
      });
      // Sub-line (scales with the chosen headline size).
      if (style.texts.sub.trim() !== "") {
        const subFont = Math.min(15, Math.max(9, Math.round(headline.sizePt * 0.42)));
        const sub = layoutMessage(
          style.texts.sub,
          {
            fontPt: subFont,
            lineHeightRatio: 1.35,
            maxWidthPt: pw - pad * 2.4,
            maxHeightPt: subFont * 1.35 * 2,
          },
          measureBody
        );
        y = drawCentered(cx, y + 8, pw, {
          lines: sub.lines,
          fontPt: subFont,
          lineHeightRatio: 1.35,
          weight: 500,
          stack: TEXT_FONT_STACK,
          fill: muted,
        });
      }
    }

    // Photo slot.
    if (hasPhoto) {
      y = drawPhoto(cx, y + 14, pw * 0.52);
    }

    // Message body (fixed size, wrap + honest ellipsis).
    y += 14;
    const messageBottom = ph * 0.845;
    if (style.texts.message.trim() !== "" && messageBottom - y > 14) {
      const message = layoutMessage(
        style.texts.message,
        {
          fontPt: 11,
          lineHeightRatio: 1.55,
          maxWidthPt: pw - pad * 2.6,
          maxHeightPt: messageBottom - y,
        },
        measureBody
      );
      metrics.messageOverflowed = message.overflowed;
      drawCentered(cx, y, pw, {
        lines: message.lines,
        fontPt: 11,
        lineHeightRatio: 1.55,
        weight: 400,
        stack: TEXT_FONT_STACK,
        fill: ink,
      });
    }

    // Date / venue line.
    if (style.texts.venue.trim() !== "") {
      drawCentered(cx, ph * 0.865, pw, {
        lines: wrapText(style.texts.venue, pw - pad * 2.4, (t) =>
          measureBody(t, 10.5)
        ),
        fontPt: 10.5,
        lineHeightRatio: 1.4,
        weight: 500,
        stack: TEXT_FONT_STACK,
        fill: muted,
      });
    }

    // From-line.
    if (style.texts.from.trim() !== "") {
      drawCentered(cx, ph - pad * 0.95 - 6, pw, {
        lines: wrapText(style.texts.from, pw - pad * 2, (t) =>
          measureBody(t, 11.5)
        ),
        fontPt: 11.5,
        lineHeightRatio: 1.3,
        weight: 600,
        stack: TEXT_FONT_STACK,
        fill: ink,
      });
    }
    return metrics;
  }

  /* --------------------------- fold-outside sheet --------------------------- */
  if (sheet.kind === "fold-outside") {
    const [back, front] = panels;

    // LEFT half — back cover: to at the top, from at the bottom.
    const bcx = back.x + back.w / 2;
    if (style.texts.to.trim() !== "") {
      drawCentered(bcx, back.h * 0.1, back.w, {
        lines: wrapText(style.texts.to, back.w - back.w * 0.16, (t) =>
          measureBody(t, 11)
        ),
        fontPt: 11,
        lineHeightRatio: 1.4,
        weight: 500,
        stack: TEXT_FONT_STACK,
        fill: muted,
      });
    }
    if (style.texts.from.trim() !== "") {
      drawCentered(bcx, back.h - back.h * 0.1 - 12, back.w, {
        lines: wrapText(style.texts.from, back.w - back.w * 0.16, (t) =>
          measureBody(t, 11)
        ),
        fontPt: 11,
        lineHeightRatio: 1.4,
        weight: 600,
        stack: TEXT_FONT_STACK,
        fill: ink,
      });
    }

    // RIGHT half — front cover: headline, sub, photo, venue.
    const fcx = front.x + front.w / 2;
    let y = front.h * 0.16;
    const headline = fitHeadline(
      style.texts.headline,
      {
        baseSizePt: 34,
        minSizePt: 16,
        stepPt: 2,
        maxWidthPt: front.w - front.w * 0.15,
        maxLines: 3,
        lineHeightRatio: 1.15,
        maxHeightPt: front.h * 0.24,
      },
      measureHeadline
    );
    metrics.headlineOverflowed = headline.overflowed;
    if (headline.lines.length > 0) {
      y = drawCentered(fcx, y, front.w, {
        lines: headline.lines,
        fontPt: headline.sizePt,
        lineHeightRatio: 1.15,
        weight: 700,
        stack: HEADLINE_FONT_STACK,
        fill: ink,
      });
      if (style.texts.sub.trim() !== "") {
        const subFont = Math.min(15, Math.max(9, Math.round(headline.sizePt * 0.42)));
        const sub = layoutMessage(
          style.texts.sub,
          {
            fontPt: subFont,
            lineHeightRatio: 1.35,
            maxWidthPt: front.w - front.w * 0.18,
            maxHeightPt: subFont * 1.35 * 2,
          },
          measureBody
        );
        y = drawCentered(fcx, y + 10, front.w, {
          lines: sub.lines,
          fontPt: subFont,
          lineHeightRatio: 1.35,
          weight: 500,
          stack: TEXT_FONT_STACK,
          fill: muted,
        });
      }
    }
    if (hasPhoto) {
      y = drawPhoto(fcx, Math.max(y + 16, front.h * 0.46), front.w * 0.56);
    }
    if (style.texts.venue.trim() !== "") {
      drawCentered(fcx, front.h - front.h * 0.12, front.w, {
        lines: wrapText(style.texts.venue, front.w - front.w * 0.18, (t) =>
          measureBody(t, 10.5)
        ),
        fontPt: 10.5,
        lineHeightRatio: 1.4,
        weight: 500,
        stack: TEXT_FONT_STACK,
        fill: muted,
      });
    }
    return metrics;
  }

  /* --------------------------- fold-inside sheet --------------------------- */
  const [insideLeft, insideRight] = panels;

  // LEFT half — accent rule + the date/venue panel (centered).
  const lcx = insideLeft.x + insideLeft.w / 2;
  if (style.texts.venue.trim() !== "") {
    ctx.save();
    ctx.fillStyle = accent;
    ctx.fillRect(
      (lcx - 14) * s,
      insideLeft.h * 0.36 * s,
      28 * s,
      Math.max(1, 2 * s)
    );
    ctx.restore();
    drawCentered(lcx, insideLeft.h * 0.42, insideLeft.w, {
      lines: layoutMessage(
        style.texts.venue,
        {
          fontPt: 12,
          lineHeightRatio: 1.5,
          maxWidthPt: insideLeft.w - insideLeft.w * 0.2,
          maxHeightPt: 12 * 1.5 * 4,
        },
        measureBody
      ).lines,
      fontPt: 12,
      lineHeightRatio: 1.5,
      weight: 500,
      stack: TEXT_FONT_STACK,
      fill: ink,
    });
  }

  // RIGHT half — the main message panel (back of the front cover).
  const message = layoutMessage(
    style.texts.message,
    {
      fontPt: 12.5,
      lineHeightRatio: 1.6,
      maxWidthPt: insideRight.w - insideRight.w * 0.18,
      maxHeightPt: insideRight.h - insideRight.h * 0.16 * 2,
    },
    measureBody
  );
  metrics.messageOverflowed = message.overflowed;
  drawCentered(insideRight.x + insideRight.w / 2, insideRight.h * 0.16, insideRight.w, {
    lines: message.lines,
    fontPt: 12.5,
    lineHeightRatio: 1.6,
    weight: 400,
    stack: TEXT_FONT_STACK,
    fill: ink,
  });
  return metrics;
}
