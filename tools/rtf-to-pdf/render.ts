/**
 * RTF to PDF renderer (RB2-c — 73rd tool) — the vector page painter.
 *
 * Extracted so the worker and the smoke script drive the EXACT drawing
 * code headless in bun (word-to-pdf precedent): same geometry, same wrap
 * math, same pagination.
 *
 *  - Page size: the document's own \paperw/\paperh (twips → pt, Letter
 *    default) unless the caller overrides A4/Letter; margins likewise
 *    from \marg* or the normal(56pt)/narrow(28pt) overrides.
 *  - Runs carry bold/italic/underline/size/colour: bold → Helvetica-Bold,
 *    italic → Helvetica-Oblique (EN docs — four free standard faces);
 *    with the single Noto face every style renders Regular (honest).
 *  - Alignment: left/center/right honoured, justify renders left
 *    (honest — word spacing is not stretched).
 *  - \tab advances to the next 36 pt stop (measured during layout, so
 *    wrap decisions see the real gap).
 *  - Page breaks: automatic (line no longer fits) + forced (\page) —
 *    a break at a page top never stacks a blank page.
 *  - Underlines are thin stroked lines under the exact run width.
 *  - Every glyph is drawText — REAL selectable text. Images from the
 *    source document are NEVER drawn (honest limit, see config.ts).
 *
 * Fonts arrive already embedded (worker): `font` is either the
 * non-embedded base-14 Helvetica (pure-WinAnsi docs) or the Noto
 * Devanagari subset; the bold/italic faces may be null and fall back.
 */

import type { PDFDocument, PDFFont, PDFPage } from "pdf-lib";
import { rgb, type RGB } from "pdf-lib";

import type { RtfColor, RtfDoc, RtfPara, RtfRun } from "./model";

/* ------------------------------------------------------------------ */
/* Geometry + type scale                                                */
/* ------------------------------------------------------------------ */

const PAGE_OVERRIDE: Record<"a4" | "letter", [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

const MARGIN_OVERRIDE: Record<"normal" | "narrow", number> = {
  normal: 56,
  narrow: 28,
};

const DEFAULT_SIZE = 12;
const LEADING = 1.32; // line advance = size × 1.32
const PARA_AFTER = 2; // small breathing gap after each \par paragraph
const MIN_LINE = 40; // never wrap into a sliver
const TAB_STEP = 36; // 0.5 in — the RTF default tab stop
const UNDERLINE_DROP = 2; // pt below the baseline
const UNDERLINE_THICK = 0.75;

const COL_TEXT: RGB = rgb(0.09, 0.09, 0.09);

/* ------------------------------------------------------------------ */
/* Painter                                                              */
/* ------------------------------------------------------------------ */

export interface RtfFonts {
  regular: PDFFont;
  bold: PDFFont | null;
  italic: PDFFont | null;
  boldItalic: PDFFont | null;
}

class Painter {
  readonly pdfDoc: PDFDocument;
  readonly fonts: RtfFonts;
  readonly pages: PDFPage[] = [];
  readonly pageW: number;
  readonly pageH: number;
  readonly marginL: number;
  readonly marginR: number;
  readonly marginT: number;
  readonly marginB: number;
  readonly contentW: number;
  page: PDFPage;
  y!: number;

  constructor(
    pdfDoc: PDFDocument,
    fonts: RtfFonts,
    pageW: number,
    pageH: number,
    margins: { left: number; right: number; top: number; bottom: number }
  ) {
    this.pdfDoc = pdfDoc;
    this.fonts = fonts;
    this.pageW = pageW;
    this.pageH = pageH;
    this.marginL = margins.left;
    this.marginR = margins.right;
    this.marginT = margins.top;
    this.marginB = margins.bottom;
    this.contentW = Math.max(72, pageW - margins.left - margins.right);
    this.page = this.newPage();
  }

  newPage(): PDFPage {
    this.page = this.pdfDoc.addPage([this.pageW, this.pageH]);
    this.pages.push(this.page);
    this.y = this.pageH - this.marginT;
    return this.page;
  }

  /** Page-break unless `need` points fit above the bottom margin. */
  ensure(need: number): void {
    if (this.y - need < this.marginB) this.newPage();
  }

  fontFor(bold: boolean, italic: boolean): PDFFont {
    const f = this.fonts;
    if (bold && italic && f.boldItalic) return f.boldItalic;
    if (bold && f.bold) return f.bold;
    if (italic && f.italic) return f.italic;
    return f.regular;
  }

  width(text: string, size: number, bold: boolean, italic: boolean): number {
    if (!text) return 0;
    return this.fontFor(bold, italic).widthOfTextAtSize(text, size);
  }

  /** Baseline-aligned draw at (x, yTop) — the house text() convention. */
  text(
    s: string,
    x: number,
    yTop: number,
    size: number,
    bold: boolean,
    italic: boolean,
    baseline: number,
    color: RtfColor | undefined
  ): void {
    if (!s) return;
    this.page.drawText(s, {
      x,
      y: yTop - baseline,
      size,
      font: this.fontFor(bold, italic),
      color: color
        ? rgb(color.r / 255, color.g / 255, color.b / 255)
        : COL_TEXT,
    });
  }

  /** Thin stroked line under a run — the \ul honouring. */
  underline(x: number, yTop: number, w: number, baseline: number, color: RtfColor | undefined): void {
    if (w <= 0) return;
    const y = yTop - baseline - UNDERLINE_DROP;
    this.page.drawLine({
      start: { x, y },
      end: { x: x + w, y },
      thickness: UNDERLINE_THICK,
      color: color
        ? rgb(color.r / 255, color.g / 255, color.b / 255)
        : COL_TEXT,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Styled line layout (mixed bold/italic/size runs in one paragraph)    */
/* ------------------------------------------------------------------ */

interface Seg {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  size: number;
  color: RtfColor | undefined;
}

interface Piece {
  kind: "text";
  seg: Seg;
}

interface TabPiece {
  kind: "tab";
  /** fixed tab advance (computed against the line's running width). */
  tabW: number;
}

type LinePiece = Piece | TabPiece;

interface Line {
  pieces: LinePiece[];
  width: number;
  lh: number;
  /** baseline offset = the largest seg size in the line. */
  maxSeg: number;
}

/**
 * Words derived from the runs' MERGED text — RTF splits words across
 * runs arbitrarily, so whitespace is the only true word boundary. Each
 * word carries its per-segment styles; "\n" (from \line) is a hard break
 * item; "\t" (from \tab / \cell) is a tab-stop item.
 */
type Item =
  | { kind: "word"; segs: Seg[] }
  | { kind: "tab" }
  | { kind: "break" };

function paraItems(runs: RtfRun[]): Item[] {
  let merged = "";
  const bolds: boolean[] = [];
  const italics: boolean[] = [];
  const underlines: boolean[] = [];
  const sizes: number[] = [];
  const colors: (RtfColor | undefined)[] = [];
  for (const r of runs) {
    for (const ch of r.text) {
      merged += ch;
      bolds.push(r.bold);
      italics.push(r.italic);
      underlines.push(r.underline);
      sizes.push(r.sizePt);
      colors.push(r.color);
    }
  }
  const items: Item[] = [];
  const n = merged.length;
  let i = 0;
  while (i < n) {
    const ch = merged[i];
    if (ch === "\n") {
      items.push({ kind: "break" });
      i += 1;
      continue;
    }
    if (ch === "\t") {
      items.push({ kind: "tab" });
      i += 1;
      continue;
    }
    if (ch === " ") {
      i += 1;
      continue;
    }
    const start = i;
    while (i < n) {
      const c = merged[i];
      if (c === " " || c === "\t" || c === "\n") break;
      i += 1;
    }
    const segs: Seg[] = [];
    let s = start;
    while (s < i) {
      let e = s + 1;
      while (
        e < i &&
        bolds[e] === bolds[s] &&
        italics[e] === italics[s] &&
        underlines[e] === underlines[s] &&
        sizes[e] === sizes[s] &&
        colors[e] === colors[s]
      ) {
        e += 1;
      }
      segs.push({
        text: merged.slice(s, e),
        bold: bolds[s],
        italic: italics[s],
        underline: underlines[s],
        size: sizes[s],
        color: colors[s],
      });
      s = e;
    }
    items.push({ kind: "word", segs });
  }
  return items;
}

const segW = (p: Painter, seg: Seg): number =>
  p.width(seg.text, seg.size, seg.bold, seg.italic);
const wordW = (p: Painter, segs: Seg[]): number =>
  segs.reduce((sum, seg) => sum + segW(p, seg), 0);

/** The tab gap for a line currently `used` pt wide. */
function tabGap(used: number): number {
  const at = used % TAB_STEP;
  return at === 0 ? TAB_STEP : TAB_STEP - at;
}

/** Over-wide word → char-level pieces that each fit (styles preserved). */
function hardBreak(p: Painter, segs: Seg[], width: number): Seg[][] {
  const pieces: Seg[][] = [];
  let cur: Seg[] = [];
  let curW = 0;
  for (const seg of segs) {
    let text = seg.text;
    let off = 0;
    while (off < text.length) {
      let take = text.length - off;
      while (
        take > 1 &&
        curW + p.width(text.slice(off, off + take), seg.size, seg.bold, seg.italic) > width
      ) {
        take -= 1;
      }
      const piece = text.slice(off, off + take);
      const pieceW = p.width(piece, seg.size, seg.bold, seg.italic);
      if (curW > 0 && curW + pieceW > width) {
        pieces.push(cur);
        cur = [];
        curW = 0;
        continue; // retry the same piece on an empty line
      }
      const last = cur[cur.length - 1];
      if (
        last &&
        last.bold === seg.bold &&
        last.italic === seg.italic &&
        last.underline === seg.underline &&
        last.size === seg.size &&
        last.color === seg.color
      ) {
        last.text += piece;
      } else {
        cur.push({
          text: piece,
          bold: seg.bold,
          italic: seg.italic,
          underline: seg.underline,
          size: seg.size,
          color: seg.color,
        });
      }
      curW += pieceW;
      off += take;
    }
  }
  if (cur.length > 0) pieces.push(cur);
  return pieces;
}

/** Greedy fill of styled words + tab stops; always ≥ 1 line. */
function layoutLines(p: Painter, runs: RtfRun[], width: number): Line[] {
  const items = paraItems(runs);
  const lines: Line[] = [];
  let pieces: LinePiece[] = [];
  let lineW = 0;
  let maxSeg = 0;

  const flush = (): void => {
    lines.push({
      pieces,
      width: lineW,
      lh: Math.max(12, maxSeg * LEADING),
      maxSeg: Math.max(maxSeg, 1),
    });
    pieces = [];
    lineW = 0;
    maxSeg = 0;
  };

  const addWord = (segsIn: Seg[], spaceBefore: boolean): void => {
    const w = wordW(p, segsIn);
    const spaceW = spaceBefore
      ? p.width(" ", segsIn[0].size, segsIn[0].bold, segsIn[0].italic)
      : 0;
    if (w + spaceW > width && width > 0) {
      // pathological single word — hard-break it first (pieces join
      // without spaces; only the first can carry the preceding space)
      const broken = hardBreak(p, segsIn, width);
      broken.forEach((piece, idx) => {
        addWord(piece, idx === 0 ? spaceBefore && lineW > 0 : false);
      });
      return;
    }
    if (lineW > 0 && lineW + spaceW + w > width) flush();
    const needSpace = lineW > 0 && spaceBefore;
    let first = true;
    for (const seg of segsIn) {
      if (first && needSpace) {
        const last = pieces[pieces.length - 1];
        if (last && last.kind === "text" && segLike(last.seg, seg)) {
          last.seg = { ...last.seg, text: last.seg.text + " " + seg.text };
        } else {
          pieces.push({ kind: "text", seg: { ...seg, text: " " + seg.text } });
        }
      } else {
        const last = pieces[pieces.length - 1];
        if (!first && last && last.kind === "text" && segLike(last.seg, seg)) {
          last.seg = { ...last.seg, text: last.seg.text + seg.text };
        } else {
          pieces.push({ kind: "text", seg: { ...seg } });
        }
      }
      first = false;
    }
    lineW += spaceW + w;
    for (const seg of segsIn) maxSeg = Math.max(maxSeg, seg.size);
  };

  let haveWord = false;
  for (const item of items) {
    if (item.kind === "break") {
      flush();
      haveWord = false;
      continue;
    }
    if (item.kind === "tab") {
      let gap = tabGap(lineW);
      if (lineW > 0 && lineW + gap > width) {
        flush();
        gap = tabGap(0);
      }
      pieces.push({ kind: "tab", tabW: gap });
      lineW += gap;
      continue;
    }
    addWord(item.segs, haveWord);
    haveWord = true;
  }
  if (pieces.length > 0 || lines.length === 0) flush();
  return lines;
}

function colorEq(a: RtfColor | undefined, b: RtfColor | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

function segLike(a: Seg | undefined, b: Seg): boolean {
  if (!a) return false;
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.size === b.size &&
    colorEq(a.color, b.color)
  );
}

/* ------------------------------------------------------------------ */
/* Paragraph                                                            */
/* ------------------------------------------------------------------ */

function drawPara(p: Painter, para: RtfPara): void {
  if (para.pageBreakBefore) {
    // never stack blank pages at a page top
    if (p.y < p.pageH - p.marginT - 1) p.newPage();
  }

  if (para.runs.length === 0) {
    // RTF's blank spacing paragraph — one honest empty line.
    p.y -= DEFAULT_SIZE * LEADING;
    return;
  }

  const lines = layoutLines(p, para.runs, p.contentW);
  for (const ln of lines) {
    p.ensure(ln.lh);
    let x = p.marginL;
    if (para.align === "center") {
      x += Math.max(0, (p.contentW - ln.width) / 2);
    } else if (para.align === "right") {
      x += Math.max(0, p.contentW - ln.width);
    }
    // justify renders left (honest)
    for (const piece of ln.pieces) {
      if (piece.kind === "tab") {
        x += piece.tabW ?? TAB_STEP;
        continue;
      }
      const seg = piece.seg;
      if (!seg || !seg.text) continue;
      p.text(
        seg.text,
        x,
        p.y,
        seg.size,
        seg.bold,
        seg.italic,
        ln.maxSeg,
        seg.color
      );
      const w = p.width(seg.text, seg.size, seg.bold, seg.italic);
      if (seg.underline) {
        p.underline(x, p.y, w, ln.maxSeg, seg.color);
      }
      x += w;
    }
    p.y -= ln.lh;
  }
  p.y -= PARA_AFTER;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

export interface RtfRenderOpts {
  /** "auto" honours the file's \paperw/\paperh (twips → pt). */
  pageSize: "auto" | "a4" | "letter";
  /** "auto" honours the file's \marg* twips. */
  margin: "auto" | "normal" | "narrow";
}

export interface RtfRenderReport {
  pages: number;
  pageW: number;
  pageH: number;
}

/**
 * Paint the whole document into `pdfDoc` (pages added as needed).
 * `fonts` must already be embedded (the 4 Helvetica faces OR the single
 * Noto Devanagari subset — nulls fall back to the regular face).
 */
export function drawRtfPdf(
  pdfDoc: PDFDocument,
  fonts: RtfFonts,
  doc: RtfDoc,
  opts: RtfRenderOpts
): RtfRenderReport {
  const [ow, oh] =
    opts.pageSize === "a4" || opts.pageSize === "letter"
      ? PAGE_OVERRIDE[opts.pageSize]
      : [doc.pageW, doc.pageH];
  const pageW = Math.min(2000, Math.max(200, ow));
  const pageH = Math.min(2800, Math.max(200, oh));
  const margins =
    opts.margin === "normal" || opts.margin === "narrow"
      ? (() => {
          const m = MARGIN_OVERRIDE[opts.margin];
          return { left: m, right: m, top: m, bottom: m };
        })()
      : {
          left: Math.max(18, Math.min(pageW / 2 - 36, doc.margins.left)),
          right: Math.max(18, Math.min(pageW / 2 - 36, doc.margins.right)),
          top: Math.max(18, Math.min(pageH / 2 - 36, doc.margins.top)),
          bottom: Math.max(18, Math.min(pageH / 2 - 36, doc.margins.bottom)),
        };

  const p = new Painter(pdfDoc, fonts, pageW, pageH, margins);
  for (const para of doc.paras) {
    drawPara(p, para);
  }
  return { pages: p.pages.length, pageW, pageH };
}
