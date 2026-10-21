/**
 * Word to PDF renderer (RB1-a — 67th tool) — the vector page painter.
 *
 * Extracted so the worker and the smoke script drive the EXACT drawing
 * code headless in bun (create-resume precedent): same geometry, same
 * wrap math, same pagination.
 *
 *  - A4 595.28×841.89 (or US Letter 612×792), 56 pt margins (28 pt
 *    narrow option). Body 10.5 pt / 15 pt leading.
 *  - Headings: Title 22 pt, Heading1 16 pt, Heading2 13 pt, Heading3
 *    11.5 pt — bold when a bold face exists (base-14 HelveticaBold),
 *    size-only hierarchy with the Noto Devanagari face (Regular only).
 *  - Bullets are "• " REAL text with hanging indents (14 pt per level).
 *  - Tables: measured column widths, hairline 0.5 pt borders, wrapped
 *    top-aligned cells, row-wise pagination.
 *  - Page breaks: automatic (line/row no longer fits) + explicit
 *    (w:br type="page" blocks). Consecutive breaks at a page top do
 *    not stack blank pages.
 *  - Every glyph is drawText — REAL selectable text. Images from the
 *    source document are NEVER drawn (honest limit, see config.ts).
 *
 * Fonts arrive already embedded (worker): `font` is either the
 * non-embedded base-14 Helvetica (pure-WinAnsi docs) or the Noto
 * Devanagari subset; `boldFont` may be null — bold then falls back to
 * the regular face. Justify renders as left (honest — word spacing is
 * not stretched); italic falls back to the regular face too (the recipe
 * embeds Regular + Bold only).
 */

import type { PDFDocument, PDFFont, PDFPage } from "pdf-lib";
import { rgb, type RGB } from "pdf-lib";

import type {
  DocxParaBlock,
  DocxRun,
  DocxTableBlock,
  ParsedDoc,
} from "./model";

/* ------------------------------------------------------------------ */
/* Geometry + type scale                                                */
/* ------------------------------------------------------------------ */

const PAGE_SIZES: Record<"a4" | "letter", [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

const MARGIN_PT: Record<"normal" | "narrow", number> = {
  normal: 56,
  narrow: 28,
};

const BODY_SIZE = 10.5;
const BODY_LH = 15;
const PARA_AFTER = 3;
const BULLET_AFTER = 2;
const BULLET_STEP = 14; // indent per list level
const BULLET_GAP = 10; // "• " to text
const MIN_LINE = 40; // never wrap into a sliver

const TABLE_CELL_SIZE = 9;
const TABLE_CELL_LH = 12.4;
const TABLE_PAD = 4;
const TABLE_MIN_COL = 32;
const TABLE_AFTER = 6;

interface HeadingSpec {
  size: number;
  before: number;
  after: number;
  lh: number;
}

const HEADINGS: Record<0 | 1 | 2 | 3, HeadingSpec> = {
  0: { size: 22, before: 10, after: 6, lh: 29 }, // Title
  1: { size: 16, before: 12, after: 5, lh: 21 }, // Heading 1
  2: { size: 13, before: 9, after: 4, lh: 17 }, // Heading 2
  3: { size: 11.5, before: 7, after: 3, lh: 15.5 }, // Heading 3
};

const COL_TEXT: RGB = rgb(0.09, 0.09, 0.09);
const COL_BORDER: RGB = rgb(0.62, 0.62, 0.62);

/* ------------------------------------------------------------------ */
/* Painter                                                              */
/* ------------------------------------------------------------------ */

class Painter {
  readonly pdfDoc: PDFDocument;
  readonly font: PDFFont;
  readonly boldFont: PDFFont | null;
  readonly pages: PDFPage[] = [];
  readonly pageW: number;
  readonly pageH: number;
  readonly margin: number;
  readonly contentW: number;
  page: PDFPage;
  y!: number;

  constructor(
    pdfDoc: PDFDocument,
    font: PDFFont,
    boldFont: PDFFont | null,
    pageSize: "a4" | "letter",
    marginKind: "normal" | "narrow"
  ) {
    this.pdfDoc = pdfDoc;
    this.font = font;
    this.boldFont = boldFont;
    const [w, h] = PAGE_SIZES[pageSize];
    this.pageW = w;
    this.pageH = h;
    this.margin = MARGIN_PT[marginKind];
    this.contentW = w - this.margin * 2;
    this.page = this.newPage();
  }

  newPage(): PDFPage {
    this.page = this.pdfDoc.addPage([this.pageW, this.pageH]);
    this.pages.push(this.page);
    this.y = this.pageH - this.margin;
    return this.page;
  }

  /** Page-break unless `need` points fit above the bottom margin. */
  ensure(need: number): void {
    if (this.y - need < this.margin) this.newPage();
  }

  fontFor(bold: boolean): PDFFont {
    return bold && this.boldFont ? this.boldFont : this.font;
  }

  width(text: string, size: number, bold: boolean): number {
    if (!text) return 0;
    return this.fontFor(bold).widthOfTextAtSize(text, size);
  }

  /** Baseline-aligned draw at (x, yTop) — the house text() convention. */
  text(
    s: string,
    x: number,
    yTop: number,
    size: number,
    bold: boolean,
    baseline: number
  ): void {
    if (!s) return;
    this.page.drawText(s, {
      x,
      y: yTop - baseline,
      size,
      font: this.fontFor(bold),
      color: COL_TEXT,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Styled line layout (mixed bold/size runs in one paragraph)           */
/* ------------------------------------------------------------------ */

interface Seg {
  text: string;
  bold: boolean;
  size: number;
}

interface Line {
  segs: Seg[];
  width: number;
  lh: number;
  /** baseline offset = the largest seg size in the line. */
  maxSeg: number;
}

/**
 * Word items derived from the runs' MERGED text — Word splits words
 * across runs arbitrarily (spell-check, formatting mid-word), so
 * whitespace is the only true word boundary. Each word carries its
 * per-segment styles; "\n" (from w:br) is a hard break item.
 */
type Item = { kind: "word"; segs: Seg[] } | { kind: "break" };

function paraItems(runs: DocxRun[], baseSize: number): Item[] {
  let merged = "";
  const bolds: boolean[] = [];
  const sizes: number[] = [];
  for (const r of runs) {
    const size = r.sizePt ?? baseSize;
    for (const ch of r.text) {
      merged += ch;
      bolds.push(r.bold);
      sizes.push(size);
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
    if (ch === " " || ch === "\t") {
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
      while (e < i && bolds[e] === bolds[s] && sizes[e] === sizes[s]) e += 1;
      segs.push({ text: merged.slice(s, e), bold: bolds[s], size: sizes[s] });
      s = e;
    }
    items.push({ kind: "word", segs });
  }
  return items;
}

const segW = (p: Painter, seg: Seg): number =>
  p.width(seg.text, seg.size, seg.bold);
const wordW = (p: Painter, segs: Seg[]): number =>
  segs.reduce((sum, seg) => sum + segW(p, seg), 0);

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
        curW + p.width(text.slice(off, off + take), seg.size, seg.bold) > width
      ) {
        take -= 1;
      }
      const piece = text.slice(off, off + take);
      const pieceW = p.width(piece, seg.size, seg.bold);
      if (curW > 0 && curW + pieceW > width) {
        pieces.push(cur);
        cur = [];
        curW = 0;
        continue; // retry the same piece on an empty line
      }
      const last = cur[cur.length - 1];
      if (last && last.bold === seg.bold && last.size === seg.size) {
        last.text += piece;
      } else {
        cur.push({ text: piece, bold: seg.bold, size: seg.size });
      }
      curW += pieceW;
      off += take;
    }
  }
  if (cur.length > 0) pieces.push(cur);
  return pieces;
}

/** Greedy fill of styled words; always returns at least one line. */
function layoutLines(
  p: Painter,
  runs: DocxRun[],
  width: number,
  baseSize: number,
  baseLH: number
): Line[] {
  const items = paraItems(runs, baseSize);
  const lines: Line[] = [];
  let segs: Seg[] = [];
  let lineW = 0;
  let maxSeg = 0;

  const flush = (): void => {
    lines.push({
      segs,
      width: lineW,
      lh: Math.max(baseLH, maxSeg * 1.3),
      maxSeg: Math.max(maxSeg, 1),
    });
    segs = [];
    lineW = 0;
    maxSeg = 0;
  };

  const addWord = (segsIn: Seg[], spaceBefore: boolean): void => {
    const w = wordW(p, segsIn);
    const spaceW = spaceBefore ? p.width(" ", segsIn[0].size, segsIn[0].bold) : 0;
    if (w + spaceW > width && width > 0) {
      // pathological single word — hard-break it first (pieces join
      // without spaces; only the first can carry the preceding space)
      const pieces = hardBreak(p, segsIn, width);
      pieces.forEach((piece, idx) => {
        addWord(piece, idx === 0 ? spaceBefore && lineW > 0 : false);
      });
      return;
    }
    if (lineW > 0 && lineW + spaceW + w > width) flush();
    const needSpace = lineW > 0 && spaceBefore;
    let first = true;
    for (const seg of segsIn) {
      if (first && needSpace) {
        const last = segs[segs.length - 1];
        if (last && last.bold === seg.bold && last.size === seg.size) {
          last.text += " " + seg.text;
        } else {
          segs.push({ text: " " + seg.text, bold: seg.bold, size: seg.size });
        }
      } else {
        const last = segs[segs.length - 1];
        if (!first && last && last.bold === seg.bold && last.size === seg.size) {
          last.text += seg.text;
        } else {
          segs.push({ text: seg.text, bold: seg.bold, size: seg.size });
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
      continue;
    }
    addWord(item.segs, haveWord);
    haveWord = true;
  }
  if (segs.length > 0 || lines.length === 0) flush();
  return lines;
}

/** Plain (unstyled) wrap for table cells. */
function layoutPlain(p: Painter, text: string, width: number): string[] {
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
      let piece = word;
      // hard-break pathological single words
      while (p.width(piece, TABLE_CELL_SIZE, false) > width && piece.length > 1) {
        let cut = piece.length;
        while (
          cut > 1 &&
          p.width(piece.slice(0, cut - 1), TABLE_CELL_SIZE, false) > width
        ) {
          cut -= 1;
        }
        out.push((line ? line + " " : "") + piece.slice(0, Math.max(1, cut - 1)));
        line = "";
        lineW = 0;
        piece = piece.slice(Math.max(1, cut - 1));
      }
      const w = p.width(piece, TABLE_CELL_SIZE, false);
      const space = lineW > 0 ? p.width(" ", TABLE_CELL_SIZE, false) : 0;
      if (lineW > 0 && lineW + space + w > width) {
        out.push(line);
        line = piece;
        lineW = w;
      } else {
        line = line ? line + " " + piece : piece;
        lineW += space + w;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Paragraph                                                            */
/* ------------------------------------------------------------------ */

function drawPara(p: Painter, blk: DocxParaBlock): void {
  const h =
    blk.headingLevel !== undefined ? HEADINGS[blk.headingLevel] : undefined;
  const baseSize = h ? h.size : BODY_SIZE;
  const baseLH = h ? h.lh : BODY_LH;
  const isList = blk.listLevel !== undefined;
  const level = Math.min(3, blk.listLevel ?? 0);

  if (blk.runs.length === 0 && !isList) {
    // Word's blank spacing paragraph — one honest empty line.
    p.y -= baseLH;
    return;
  }

  const bulletX = p.margin + 4 + BULLET_STEP * level;
  const textX = isList ? bulletX + BULLET_GAP : p.margin;
  const avail = Math.max(MIN_LINE, p.margin + p.contentW - textX);

  if (h) {
    // keep the heading with at least its first content line
    p.ensure(h.lh + h.after + baseLH);
    p.y -= h.before;
  }

  const lines = layoutLines(p, blk.runs, avail, baseSize, baseLH);
  let first = true;
  for (const ln of lines) {
    p.ensure(ln.lh);
    if (isList && first) {
      p.text("\u2022 ", bulletX, p.y, baseSize, false, ln.maxSeg);
    }
    let x = textX;
    if (blk.align === "center") {
      x = textX + Math.max(0, (avail - ln.width) / 2);
    } else if (blk.align === "right") {
      x = textX + Math.max(0, avail - ln.width);
    }
    let cx = x;
    for (const seg of ln.segs) {
      if (seg.text) {
        p.text(seg.text, cx, p.y, seg.size, seg.bold, ln.maxSeg);
      }
      cx += p.width(seg.text, seg.size, seg.bold);
    }
    p.y -= ln.lh;
    first = false;
  }
  p.y -= h ? h.after : isList ? BULLET_AFTER : PARA_AFTER;
}

/* ------------------------------------------------------------------ */
/* Table                                                                */
/* ------------------------------------------------------------------ */

function columnWidths(p: Painter, rows: string[][], ncols: number): number[] {
  const natural = new Array<number>(ncols).fill(0);
  const minWord = new Array<number>(ncols).fill(TABLE_MIN_COL);
  for (const row of rows) {
    for (let c = 0; c < ncols; c++) {
      const cell = row[c] ?? "";
      const full = p.width(cell, TABLE_CELL_SIZE, false);
      if (full > natural[c]) natural[c] = Math.min(full, p.contentW);
      for (const word of cell.split(/\s+/)) {
        const w = p.width(word, TABLE_CELL_SIZE, false) + TABLE_PAD * 2;
        if (w > minWord[c]) minWord[c] = Math.min(w, p.contentW);
      }
    }
  }
  const ideal = natural.map((n, c) =>
    Math.max(Math.min(n, p.contentW), minWord[c], TABLE_MIN_COL)
  );
  const sum = ideal.reduce((a, b) => a + b, 0);
  if (sum > p.contentW) {
    const scale = p.contentW / sum;
    return ideal.map((w) => Math.max(w * scale, 24));
  }
  if (sum < p.contentW) {
    const extra = (p.contentW - sum) / ncols;
    return ideal.map((w) => w + extra);
  }
  return ideal;
}

function drawTable(p: Painter, blk: DocxTableBlock): void {
  const rows = blk.rows;
  if (rows.length === 0) return;
  const ncols = Math.max(1, ...rows.map((r) => r.length));
  const widths = columnWidths(p, rows, ncols);

  // keep the first row + one more line together on a page
  let firstRowLines = 1;
  rows[0].forEach((cell, c) => {
    firstRowLines = Math.max(
      firstRowLines,
      layoutPlain(p, cell, widths[c] - TABLE_PAD * 2).length
    );
  });
  p.ensure(firstRowLines * TABLE_CELL_LH + TABLE_PAD * 2 + TABLE_CELL_LH);

  for (const row of rows) {
    const cellLines = row.map(
      (cell, c) => layoutPlain(p, cell, widths[c] - TABLE_PAD * 2).slice(0, 40)
    );
    let rowLines = 1;
    for (const lines of cellLines) rowLines = Math.max(rowLines, lines.length);
    const rowH = rowLines * TABLE_CELL_LH + TABLE_PAD * 2;
    p.ensure(rowH);
    let x = p.margin;
    for (let c = 0; c < ncols; c++) {
      const w = widths[c];
      p.page.drawRectangle({
        x,
        y: p.y - rowH,
        width: w,
        height: rowH,
        borderColor: COL_BORDER,
        borderWidth: 0.5,
      });
      const lines = cellLines[c] ?? [];
      let ty = p.y - TABLE_PAD;
      for (const line of lines) {
        if (line) p.text(line, x + TABLE_PAD, ty, TABLE_CELL_SIZE, false, TABLE_CELL_SIZE);
        ty -= TABLE_CELL_LH;
      }
      x += w;
    }
    p.y -= rowH;
  }
  p.y -= TABLE_AFTER;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

export interface DocxRenderOpts {
  pageSize: "a4" | "letter";
  margin: "normal" | "narrow";
}

export interface DocxRenderReport {
  pages: number;
}

/**
 * Paint the whole document into `pdfDoc` (pages added as needed).
 * `font` must already be embedded (Helvetica standard OR the Noto
 * subset); `boldFont` may be null — bold text then falls back to the
 * regular face (Noto ships Regular only).
 */
export function drawDocxPdf(
  pdfDoc: PDFDocument,
  font: PDFFont,
  boldFont: PDFFont | null,
  doc: ParsedDoc,
  opts: DocxRenderOpts
): DocxRenderReport {
  const p = new Painter(
    pdfDoc,
    font,
    boldFont,
    opts.pageSize === "letter" ? "letter" : "a4",
    opts.margin === "narrow" ? "narrow" : "normal"
  );
  for (const blk of doc.blocks) {
    if (blk.kind === "para") {
      drawPara(p, blk);
    } else if (blk.kind === "table") {
      drawTable(p, blk);
    } else {
      // explicit page break — no stacked blanks when already at a page top
      if (p.y < p.pageH - p.margin - 1) p.newPage();
    }
  }
  return { pages: p.pages.length };
}
