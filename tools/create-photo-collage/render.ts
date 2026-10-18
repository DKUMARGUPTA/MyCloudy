/**
 * Photo collage drawing engine — ONE implementation shared by the
 * worker (OffscreenCanvas → PDF/JPG/PNG), the surface live preview
 * (HTMLCanvasElement) and the smoke script, so every consumer paints
 * byte-identical pages (the WYSIWYG guarantee).
 *
 * The caller owns the canvas size: everything in the recipe is expressed
 * in PDF points (see model.ts) and scaled here by `canvasWidth /
 * pagePtWidth`, so a 560 px preview and a 1190 px export raster line up
 * exactly. Works with both HTMLCanvasElement 2D and OffscreenCanvas 2D
 * contexts (the union type below is accepted by drawImage on both).
 */

import {
  GAP_PT,
  MARGIN_PT,
  PAGE_TAG_PT,
  RADIUS_RATIO,
  TITLE_BAND_PT,
  backgroundHex,
  cellRectInArea,
  containFit,
  coverCrop,
  hexLuminance,
  inkHex,
  pagePtSize,
  titleFontPt,
  type CollageStyle,
  type PagePlan,
  type RectPx,
} from "./model";

/** Anything drawImage accepts as a raster source. */
export type CollageSource =
  | ImageBitmap
  | HTMLImageElement
  | HTMLCanvasElement
  | OffscreenCanvas;

/** 2D context of either canvas flavour (drawImage-compatible with both). */
export type CollageCtx =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

export const TEXT_FONT_STACK =
  "'Noto Sans Devanagari', 'Noto Sans', system-ui, sans-serif";

/* --------------------------- path helpers --------------------------- */

/**
 * Rounded-rect path that works on both context types (ctx.roundRect
 * exists in modern engines; the manual path is the fallback and also
 * the verifier — it behaves identically).
 */
export function roundRectPath(
  ctx: CollageCtx,
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

/** Single-line text truncated with an ellipsis to fit `maxWidth`. */
export function truncateText(
  ctx: CollageCtx,
  text: string,
  maxWidth: number
): string {
  if (text === "") return text;
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}\u2026`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  // lo = the longest prefix whose ellipsis form fits (0 → bare ellipsis).
  return `${text.slice(0, lo)}\u2026`;
}

/**
 * Rotates a raster source by quarter turns through a canvas the caller
 * fabricates (OffscreenCanvas in the worker, HTMLCanvasElement on the
 * main thread). Rotation 0 returns the source untouched (zero copies).
 */
export function orientedSource<S extends CollageSource>(
  source: S,
  rotation: number,
  makeCanvas: (w: number, h: number) => { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CollageCtx }
):
  | S
  | HTMLCanvasElement
  | OffscreenCanvas {
  const quarter = ((Math.round(rotation / 90) % 4) + 4) % 4;
  if (quarter === 0) return source;
  const swap = quarter === 1 || quarter === 3;
  const w = swap ? source.height : source.width;
  const h = swap ? source.width : source.height;
  const { ctx } = makeCanvas(w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate((quarter * Math.PI) / 2);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return ctx.canvas;
}

/* ---------------------------- page painting ------------------------- */

interface CellPaint {
  rect: RectPx;
  image: CollageSource | null;
  caption: string;
}

function drawCell(
  ctx: CollageCtx,
  paint: CellPaint,
  style: CollageStyle,
  radiusPx: number,
  background: string
): void {
  const { rect, image } = paint;
  if (rect.w <= 0 || rect.h <= 0) return;

  if (!style.polaroid) {
    if (image === null) return;
    ctx.save();
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, radiusPx);
    ctx.clip();
    if (style.fit === "contain") {
      // Letterbox = page background behind the contained photo.
      ctx.fillStyle = background;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      const fit = containFit(image.width, image.height, rect.w, rect.h);
      ctx.drawImage(
        image,
        rect.x + fit.x,
        rect.y + fit.y,
        fit.w,
        fit.h
      );
    } else {
      const crop = coverCrop(image.width, image.height, rect.w, rect.h);
      ctx.drawImage(
        image,
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        rect.x,
        rect.y,
        rect.w,
        rect.h
      );
    }
    ctx.restore();
    return;
  }

  /* ---------------- polaroid frame ---------------- */
  const pad = Math.round(Math.min(rect.w, rect.h) * 0.05);
  const bottomBand = Math.max(pad * 2.4, rect.h * 0.16);
  const photo: RectPx = {
    x: rect.x + pad,
    y: rect.y + pad,
    w: rect.w - pad * 2,
    h: rect.h - pad - bottomBand,
  };

  // Frame card.
  ctx.save();
  roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, radiusPx);
  ctx.clip();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
  // Hairline so a white card stays visible on white pages.
  ctx.save();
  roundRectPath(ctx, rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, radiusPx);
  ctx.strokeStyle = "rgba(28, 25, 23, 0.12)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  if (image !== null && photo.w > 0 && photo.h > 0) {
    const photoRadius = Math.max(0, radiusPx - pad);
    ctx.save();
    roundRectPath(ctx, photo.x, photo.y, photo.w, photo.h, photoRadius);
    ctx.clip();
    if (style.fit === "contain") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(photo.x, photo.y, photo.w, photo.h);
      const fit = containFit(image.width, image.height, photo.w, photo.h);
      ctx.drawImage(
        image,
        photo.x + fit.x,
        photo.y + fit.y,
        fit.w,
        fit.h
      );
    } else {
      const crop = coverCrop(image.width, image.height, photo.w, photo.h);
      ctx.drawImage(
        image,
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        photo.x,
        photo.y,
        photo.w,
        photo.h
      );
    }
    ctx.restore();
  }

  // Caption under the photo, centred + truncated.
  const caption = paint.caption.trim();
  if (caption !== "" && photo.w > 0) {
    const fontPx = Math.min(32, Math.max(14, Math.round(bottomBand * 0.5)));
    ctx.save();
    ctx.font = `500 ${fontPx}px ${TEXT_FONT_STACK}`;
    ctx.fillStyle = "#3a352f";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const line = truncateText(ctx, caption, photo.w);
    ctx.fillText(line, photo.x + photo.w / 2, rect.y + rect.h - bottomBand / 2);
    ctx.restore();
  }
}

/**
 * Paints one collage page onto the caller's canvas. The canvas size
 * defines the scale (width / page pt width); the page background, the
 * optional title band, every cell (rounded, cover-cropped or contained,
 * optional polaroid frame + caption) and — when the collage spans
 * multiple pages and a margin exists — a small "1 / 3" page tag in the
 * bottom margin all come from the same recipe the preview shows.
 */
export function drawCollagePage(
  ctx: CollageCtx,
  page: PagePlan,
  images: CollageSource[],
  style: CollageStyle,
  pageIndex: number,
  totalPages: number
): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  if (W <= 0 || H <= 0) return;
  const pt = pagePtSize(style);
  const scale = W / pt.w;
  const background = backgroundHex(style);
  const ink = inkHex(background);

  // Page background.
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, H);

  // Content box: margins + the optional title band.
  const margin = MARGIN_PT[style.margin] * scale;
  const title = style.title.trim();
  const titleBand = title !== "" ? TITLE_BAND_PT * scale : 0;
  const area: RectPx = {
    x: margin,
    y: margin + titleBand,
    w: W - margin * 2,
    h: H - margin * 2 - titleBand,
  };

  if (title !== "") {
    const fontPx = titleFontPt(style) * scale;
    ctx.save();
    ctx.font = `600 ${fontPx}px ${TEXT_FONT_STACK}`;
    ctx.fillStyle = ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const line = truncateText(ctx, title, area.w);
    ctx.fillText(line, W / 2, margin + titleBand / 2);
    ctx.restore();
  }

  const gapPx = GAP_PT[style.gap] * scale;
  const radiusPx = RADIUS_RATIO[style.radius] * Math.min(W, H);

  for (const cell of page.cells) {
    const rect = cellRectInArea(cell, area, gapPx);
    const photoIndex = cell.photo;
    drawCell(
      ctx,
      {
        rect,
        image: photoIndex === null ? null : (images[photoIndex] ?? null),
        caption: photoIndex === null ? "" : (style.captions[photoIndex] ?? ""),
      },
      style,
      radiusPx,
      background
    );
  }

  // Page tag "1 / 3": only for multi-page collages, only when a margin
  // band exists to hold it (margin "none" pages have no free strip).
  if (totalPages > 1 && style.margin !== "none") {
    const fontPx = Math.max(9, PAGE_TAG_PT * scale * 0.55);
    const base = H - margin + PAGE_TAG_PT * scale * 0.5;
    const y = Math.min(H - fontPx * 0.5, base);
    ctx.save();
    ctx.font = `500 ${fontPx}px ${TEXT_FONT_STACK}`;
    ctx.fillStyle = hexLuminance(background) > 0.55 ? "#78716c" : "#a8a29e";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${pageIndex + 1} / ${totalPages}`, W / 2, y);
    ctx.restore();
  }
}
