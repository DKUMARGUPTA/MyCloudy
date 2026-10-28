/**
 * PowerPoint to PDF renderer (RB2-a — the 71st tool) — the vector
 * slide painter.
 *
 * Extracted so the worker and the smoke script drive the EXACT drawing
 * code headless in bun (create-resume / word-to-pdf precedent): same
 * geometry, same wrap math, same page sizing.
 *
 *  - One page per slide, sized by the page option:
 *      "slide-native" — the page IS the slide (sldSz/12700 pt), 1:1,
 *                       margins don't shrink the slide (they still
 *                       frame the notes pages);
 *      "a4"           — landscape A4 841.89 × 595.28;
 *      "letter"       — landscape Letter 792 × 612.
 *    Shape coordinates are scaled to the page and the slide is centred
 *    (letterboxed). "fit" fills the page width instead, eating the
 *    vertical margins when the aspect allows — never leaving the page.
 *  - Each text box wraps within its (scaled) width with the house
 *    baseline convention; text that overflows its box height × 1.6 is
 *    still drawn but counted in the report (honesty).
 *  - Title shapes draw bold when a bold face exists (base-14
 *    HelveticaBold); the Noto Devanagari face is Regular-only, so Hindi
 *    hierarchy comes from size.
 *  - Speaker notes (when enabled): after all slides, one page per
 *    slide with the localized "Slide N — notes" heading + the notes
 *    text flowing over extra pages when long.
 *  - Every glyph is drawText — REAL selectable vector text. Pictures,
 *    charts and SmartArt from the source deck are NEVER drawn (honest
 *    limit, see config.ts).
 *
 * Fonts arrive already resolved (worker): `font` is either the
 * non-embedded base-14 Helvetica (pure-WinAnsi decks) or the Noto
 * Devanagari subset; `boldKey` may be null — bold then falls back to
 * the regular face. Justify renders as left (honest — word spacing is
 * not stretched); italic falls back to the regular face too.
 */

import type { CreateContext, CreatePage, StampFontKey } from "@/lib/own/pdf";

import {
  faceOpts,
  faceWidth,
  rgb,
  type ConvertFace,
  type RGB,
} from "../convert-common/face";

import type { ParsedPptx, PptRun, PptShape } from "./model";

/* ------------------------------------------------------------------ */
/* Geometry + type scale                                                */
/* ------------------------------------------------------------------ */

const PAGE_SIZES: Record<"a4" | "letter", [number, number]> = {
  a4: [841.89, 595.28],
  letter: [792, 612],
};

const MARGIN_PT: Record<"normal" | "narrow", number> = {
  normal: 56,
  narrow: 28,
};

/** PowerPoint default text insets (EMU 91440 / 45720) in pt. */
const INS_X = 7.2;
const INS_Y = 3.6;

/** single line spacing ≈ 1.2 em (PowerPoint 100%). */
const LINE_MUL = 1.22;
/** text taller than box height × 1.6 is flagged (still drawn). */
const OVERFLOW_TOL = 1.6;

/** missing a:rPr @sz fallbacks (the master's defaults, approximated). */
const TITLE_DEFAULT_PT = 36;
const BODY_DEFAULT_PT = 18;

const BULLET_GAP = 4; // "•" to text

const NOTES_SIZE = 10.5;
const NOTES_LH = 15;
const NOTES_HEAD_SIZE = 14;
const NOTES_HEAD_AFTER = 22; // heading → rule → first line

const COL_TEXT: RGB = rgb(0.09, 0.09, 0.09);
const COL_MUTED: RGB = rgb(0.42, 0.42, 0.42);
const COL_SLIDE_FRAME: RGB = rgb(0.82, 0.82, 0.82);
const COL_RULE: RGB = rgb(0.62, 0.62, 0.62);

const COLOR_CACHE = new Map<string, RGB>();

function hexColor(hex: string | undefined): RGB {
  if (!hex) return COL_TEXT;
  const cached = COLOR_CACHE.get(hex);
  if (cached) return cached;
  const r = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const g = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const b = Number.parseInt(hex.slice(4, 6), 16) / 255;
  const c = rgb(
    Number.isFinite(r) ? r : 0.09,
    Number.isFinite(g) ? g : 0.09,
    Number.isFinite(b) ? b : 0.09
  );
  COLOR_CACHE.set(hex, c);
  return c;
}

/* ------------------------------------------------------------------ */
/* Options + report                                                    */
/* ------------------------------------------------------------------ */

export interface PptRenderOpts {
  pageSize: "slide-native" | "a4" | "letter";
  margin: "normal" | "narrow";
  /** include speaker-notes pages (one per slide after the slides). */
  notes: boolean;
  /** fill the page width instead of letterboxing (a4/letter only). */
  fit: boolean;
  /** localized notes heading template containing {n} (1-based). */
  notesHeadingFmt: string;
}

export interface PptRenderReport {
  pages: number;
  notesPages: number;
  /** text boxes whose text overflowed their box beyond the tolerance. */
  overflowed: number;
}

/* ------------------------------------------------------------------ */
/* Painter (font access + text draw, house baseline convention)         */
/* ------------------------------------------------------------------ */

class Painter {
  readonly pdfDoc: CreateContext;
  readonly font: ConvertFace;
  readonly boldKey: StampFontKey | null;

  constructor(
    pdfDoc: CreateContext,
    font: ConvertFace,
    boldKey: StampFontKey | null
  ) {
    this.pdfDoc = pdfDoc;
    this.font = font;
    this.boldKey = boldKey;
  }

  fontFor(bold: boolean): ConvertFace {
    // Devanagari mode has no bold variant — hierarchy from size.
    return bold && !this.font.ttf && this.boldKey
      ? { std: this.boldKey }
      : this.font;
  }

  width(text: string, size: number, bold: boolean): number {
    if (!text) return 0;
    return faceWidth(this.pdfDoc, this.fontFor(bold), text, size);
  }

  /** Baseline-aligned draw at (x, yTop) — the house text() convention. */
  text(
    page: CreatePage,
    s: string,
    x: number,
    yTop: number,
    size: number,
    bold: boolean,
    baseline: number,
    color: RGB
  ): void {
    if (!s) return;
    page.drawText({
      x,
      y: yTop - baseline,
      text: s,
      size,
      color,
      ...faceOpts(this.fontFor(bold)),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Styled word layout (mixed bold/size/color runs in one paragraph)     */
/* ------------------------------------------------------------------ */

interface Word {
  text: string;
  size: number;
  bold: boolean;
  color?: string;
  spaceBefore: boolean;
}

type Item = { kind: "word"; word: Word } | { kind: "break" };

interface Line {
  words: Word[];
  width: number;
  lh: number;
  /** baseline offset = the largest word size in the line. */
  maxSeg: number;
}

/** Split runs into word items carrying the whole run style. */
function paraItems(runs: PptRun[], baseSize: number): Item[] {
  const items: Item[] = [];
  let space = false;
  let buf = "";
  let style: { size: number; bold: boolean; color?: string } | null = null;
  const flush = (): void => {
    if (buf && style) {
      items.push({
        kind: "word",
        word: { text: buf, size: style.size, bold: style.bold, color: style.color, spaceBefore: space },
      });
    }
    buf = "";
    space = false;
  };
  for (const r of runs) {
    style = { size: r.sizePt ?? baseSize, bold: r.bold, color: r.color };
    for (const ch of r.text) {
      if (ch === "\n") {
        flush();
        items.push({ kind: "break" });
        continue;
      }
      if (ch === " " || ch === "\t") {
        flush();
        space = true;
        continue;
      }
      buf += ch;
    }
    flush();
  }
  return items;
}

/** Over-wide word → char-level pieces that each fit (styles preserved). */
function hardBreak(
  p: Painter,
  word: Word,
  width: number
): Word[] {
  const pieces: Word[] = [];
  let off = 0;
  while (off < word.text.length) {
    let take = word.text.length - off;
    while (
      take > 1 &&
      p.width(word.text.slice(off, off + take), word.size, word.bold) > width
    ) {
      take -= 1;
    }
    pieces.push({
      ...word,
      text: word.text.slice(off, off + take),
      spaceBefore: off === 0 && word.spaceBefore,
    });
    off += take;
    if (take <= 0) break; // pathological — never spin
  }
  return pieces;
}

/** Greedy fill of styled words within `width`; ≥ 1 line per call. */
function layoutLines(
  p: Painter,
  runs: PptRun[],
  width: number,
  baseSize: number
): Line[] {
  const items = paraItems(runs, baseSize);
  const lines: Line[] = [];
  let words: Word[] = [];
  let lineW = 0;
  let maxSeg = 0;

  const flush = (): void => {
    lines.push({
      words,
      width: lineW,
      lh: Math.max(baseSize * LINE_MUL, maxSeg * LINE_MUL),
      maxSeg: Math.max(maxSeg, 1),
    });
    words = [];
    lineW = 0;
    maxSeg = 0;
  };

  for (const item of items) {
    if (item.kind === "break") {
      flush();
      continue;
    }
    let word = item.word;
    const w = p.width(word.text, word.size, word.bold);
    if (w > width && width > 0) {
      // pathological single word — hard-break it first
      for (const piece of hardBreak(p, word, width)) {
        addWord(piece);
      }
      continue;
    }
    addWord(word);
  }
  if (words.length > 0 || lines.length === 0) flush();
  return lines;

  function addWord(word: Word): void {
    const w = p.width(word.text, word.size, word.bold);
    const spaceW =
      word.spaceBefore && lineW > 0
        ? p.width(" ", word.size, word.bold)
        : 0;
    if (lineW > 0 && lineW + spaceW + w > width) flush();
    words.push(word);
    lineW += spaceW + w;
    maxSeg = Math.max(maxSeg, word.size);
  }
}

/** Plain (unstyled) wrap for the notes flow. */
function layoutPlain(
  p: Painter,
  text: string,
  size: number,
  width: number
): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    let lineW = 0;
    for (const word of words) {
      const w = p.width(word, size, false);
      const space = lineW > 0 ? p.width(" ", size, false) : 0;
      if (lineW > 0 && lineW + space + w > width) {
        out.push(line);
        line = word;
        lineW = w;
      } else {
        line = line ? line + " " + word : word;
        lineW += space + w;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Slide text box                                                       */
/* ------------------------------------------------------------------ */

interface BoxGeo {
  x: number;
  y: number; // top
  w: number;
  h: number;
}

/**
 * Draw one shape's paragraphs inside its (page-space) box. Run sizes are
 * resolved + scaled to page space here, so the layout math and the
 * metrics agree. Returns the total text height drawn (overflow tally).
 */
function drawTextBox(
  p: Painter,
  page: CreatePage,
  shape: PptShape,
  box: BoxGeo,
  scale: number
): number {
  if (shape.paras.length === 0) return 0;

  const innerX = box.x + INS_X * scale;
  const innerW = Math.max(12, box.w - INS_X * 2 * scale);
  let y = box.y + INS_Y * scale;
  let textH = 0;

  const defTitle = TITLE_DEFAULT_PT * scale;
  const defBody = BODY_DEFAULT_PT * scale;

  for (const para of shape.paras) {
    if (para.runs.length === 0) {
      // empty paragraph — one honest blank line
      const lh = (shape.isTitle ? defTitle : defBody) * LINE_MUL;
      y += lh;
      textH += lh;
      continue;
    }
    // resolve + scale runs once; titles draw bold-ish when the family
    // allows it (the Noto face is Regular-only → size hierarchy).
    const runs: PptRun[] = para.runs.map((r) => ({
      ...r,
      bold: r.bold || shape.isTitle,
      sizePt:
        (r.sizePt ?? (shape.isTitle ? TITLE_DEFAULT_PT : BODY_DEFAULT_PT)) *
        scale,
    }));
    const bullet = para.bullet === true;
    const bulletSize = runs[0]?.sizePt ?? (shape.isTitle ? defTitle : defBody);
    const bulletW = bullet
      ? p.width("•", bulletSize, false) + BULLET_GAP * scale
      : 0;
    const avail = Math.max(12, innerW - bulletW);
    const lines = layoutLines(
      p,
      runs,
      avail,
      shape.isTitle ? defTitle : defBody
    );
    for (const ln of lines) {
      let cx = innerX + bulletW;
      if (para.align === "center") {
        cx = innerX + bulletW + Math.max(0, (avail - ln.width) / 2);
      } else if (para.align === "right") {
        cx = innerX + bulletW + Math.max(0, avail - ln.width);
      }
      const startX = cx;
      for (const word of ln.words) {
        if (word.spaceBefore && cx > startX) {
          cx += p.width(" ", word.size, word.bold);
        }
        p.text(
          page,
          word.text,
          cx,
          y,
          word.size,
          word.bold,
          ln.maxSeg,
          hexColor(word.color)
        );
        cx += p.width(word.text, word.size, word.bold);
      }
      if (bullet) {
        p.text(page, "•", innerX, y, bulletSize, false, ln.maxSeg, COL_TEXT);
      }
      y += ln.lh;
      textH += ln.lh;
    }
  }
  return textH;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

/**
 * Paint the whole deck into `pdfDoc` (one page per slide + optional
 * notes pages). `font` must already be resolved (Helvetica standard OR
 * the Noto subset); `boldKey` may be null — bold text then falls back
 * to the regular face (Noto ships Regular only).
 */
export function drawPptxPdf(
  pdfDoc: CreateContext,
  font: ConvertFace,
  boldKey: StampFontKey | null,
  ppt: ParsedPptx,
  opts: PptRenderOpts
): PptRenderReport {
  const p = new Painter(pdfDoc, font, boldKey);
  const slideW = Math.max(32, ppt.slideW);
  const slideH = Math.max(32, ppt.slideH);

  let pageW: number;
  let pageH: number;
  if (opts.pageSize === "slide-native") {
    pageW = slideW;
    pageH = slideH;
  } else {
    const [w, h] = PAGE_SIZES[opts.pageSize];
    pageW = w;
    pageH = h;
  }
  const margin = MARGIN_PT[opts.margin];

  let overflowed = 0;
  const pages: CreatePage[] = [];

  /* ---------------- slide pages ---------------- */
  for (const slide of ppt.slides) {
    const page = pdfDoc.addPage(pageW, pageH);
    pages.push(page);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: pageW,
      height: pageH,
      color: rgb(1, 1, 1),
    });

    let scale = 1;
    let ox = 0;
    let oy = 0;
    if (opts.pageSize !== "slide-native") {
      const availW = pageW - margin * 2;
      const availH = pageH - margin * 2;
      scale = Math.min(availW / slideW, availH / slideH);
      if (opts.fit) {
        const sw = availW / slideW;
        const maxH = pageH - 12; // may eat the vertical margins — never more
        if (slideH * sw <= maxH) scale = sw;
        else scale = Math.max(Math.min(sw, maxH / slideH), 0.05);
      }
      ox = (pageW - slideW * scale) / 2;
      oy = (pageH - slideH * scale) / 2;
      page.drawRectangle({
        x: ox,
        y: oy,
        width: slideW * scale,
        height: slideH * scale,
        borderColor: COL_SLIDE_FRAME,
        borderWidth: 0.75,
      });
    }

    for (const shape of slide.shapes) {
      const box: BoxGeo = {
        x: ox + shape.x * scale,
        y: oy + shape.y * scale,
        w: Math.max(8, shape.w * scale),
        h: shape.h * scale,
      };
      const drawn = drawTextBox(p, page, shape, box, scale);
      if (shape.h > 0 && drawn > shape.h * scale * OVERFLOW_TOL + 0.5) {
        overflowed += 1;
      }
    }
  }

  /* ---------------- notes pages ---------------- */
  let notesPages = 0;
  if (opts.notes) {
    for (let i = 0; i < ppt.slides.length; i += 1) {
      const slide = ppt.slides[i];
      let page = pdfDoc.addPage(pageW, pageH);
      pages.push(page);
      notesPages += 1;
      page.drawRectangle({
        x: 0,
        y: 0,
        width: pageW,
        height: pageH,
        color: rgb(1, 1, 1),
      });

      const heading = opts.notesHeadingFmt
        .slice(0, 60)
        .split("{n}")
        .join(String(i + 1));
      p.text(page, heading, margin, pageH - margin, NOTES_HEAD_SIZE, true, NOTES_HEAD_SIZE, COL_TEXT);
      page.drawLine({
        start: { x: margin, y: pageH - margin - 14 },
        end: { x: pageW - margin, y: pageH - margin - 14 },
        thickness: 0.5,
        color: COL_RULE,
      });

      let y = pageH - margin - NOTES_HEAD_AFTER;
      const availW = pageW - margin * 2;
      for (const para of slide.notes.split("\n")) {
        const lines = layoutPlain(p, para, NOTES_SIZE, availW);
        if (lines.length === 0) lines.push("");
        for (const line of lines) {
          if (y - NOTES_LH < margin) {
            page = pdfDoc.addPage(pageW, pageH);
            pages.push(page);
            notesPages += 1;
            page.drawRectangle({
              x: 0,
              y: 0,
              width: pageW,
              height: pageH,
              color: rgb(1, 1, 1),
            });
            y = pageH - margin;
          }
          if (line) {
            p.text(page, line, margin, y, NOTES_SIZE, false, NOTES_SIZE, COL_MUTED);
          }
          y -= NOTES_LH;
        }
      }
    }
  }

  return { pages: pages.length, notesPages, overflowed };
}
