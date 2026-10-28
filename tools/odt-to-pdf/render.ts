/**
 * OpenDocument to PDF renderer (RB2-b — the 72nd tool) — the vector
 * page painter.
 *
 * Extracted so the worker and the smoke script drive the EXACT drawing
 * code headless in bun (create-resume precedent): same geometry, same
 * wrap math, same pagination.
 *
 *  - Text kind (word-to-pdf lineage):
 *      A4 595.28×841.89 (or US Letter 612×792), 56 pt margins (28 pt
 *      narrow). Body 10.5 pt / 15 pt leading. Headings 1-6 = 16/13/11.5/
 *      10.5 pt — bold when a bold face exists (base-14 HelveticaBold),
 *      size-only hierarchy with the Noto Devanagari face (Regular only).
 *      List items: bullet glyphs "•" / "–" / "·" (all WinAnsi AND present
 *      in the Noto face — verified) with hanging indents (14 pt/level).
 *      Tables: measured column widths, hairline 0.5 pt borders, wrapped
 *      top-aligned cells, row-wise pagination.
 *  - Sheets kind (excel-to-pdf lineage): each sheet starts a fresh
 *      page with its name as a 12 pt header + hairline rule; column
 *      widths from a content heuristic, fit-scaled to the printable
 *      width; wrapped cells with honest "…" clipping when one row would
 *      outgrow a page; hairline grid, row-wise pagination.
 *
 * Fonts arrive already resolved (worker): `font` is either the
 * non-embedded base-14 Helvetica (pure-WinAnsi docs) or the Noto
 * Devanagari face; `boldKey` may be null — bold then falls back to
 * the regular face. Every glyph is drawText — REAL selectable text;
 * images/drawings from the source document are NEVER drawn.
 */

import type { CreateContext, CreatePage, StampFontKey } from "@/lib/own/pdf";

import {
  faceOpts,
  faceWidth,
  rgb,
  type ConvertFace,
  type RGB,
} from "../convert-common/face";

import type {
  OdfHeadingBlock,
  OdfListBlock,
  OdfParaBlock,
  OdfRun,
  OdfTableBlock,
  ParsedOdf,
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
const BULLET_GAP = 10; // glyph to text
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

const HEADINGS: Record<1 | 2 | 3 | 4 | 5 | 6, HeadingSpec> = {
  1: { size: 16, before: 12, after: 5, lh: 21 },
  2: { size: 13, before: 9, after: 4, lh: 17 },
  3: { size: 11.5, before: 7, after: 3, lh: 15.5 },
  4: { size: 10.5, before: 6, after: 2.5, lh: 14.5 },
  5: { size: 10.5, before: 5, after: 2.5, lh: 14 },
  6: { size: 10.5, before: 4, after: 2, lh: 13.5 },
};

/** Bullet glyph per nesting level — all WinAnsi + all in Noto Devanagari. */
const BULLETS = ["\u2022", "\u2013", "\u00b7"]; // • – ·

const COL_TEXT: RGB = rgb(0.09, 0.09, 0.09);
const COL_BORDER: RGB = rgb(0.62, 0.62, 0.62);
const COL_GRID: RGB = rgb(0.78, 0.78, 0.78);
const COL_MUTED: RGB = rgb(0.4, 0.4, 0.4);
const COL_HEADER_FILL: RGB = rgb(0.9, 0.91, 0.92);

/* ------------------------------------------------------------------ */
/* Painter (text kind)                                                  */
/* ------------------------------------------------------------------ */

class Painter {
  readonly pdfDoc: CreateContext;
  readonly font: ConvertFace;
  readonly boldKey: StampFontKey | null;
  readonly pages: CreatePage[] = [];
  readonly pageW: number;
  readonly pageH: number;
  readonly margin: number;
  readonly contentW: number;
  page: CreatePage;
  y!: number;

  constructor(
    pdfDoc: CreateContext,
    font: ConvertFace,
    boldKey: StampFontKey | null,
    pageSize: "a4" | "letter",
    marginKind: "normal" | "narrow"
  ) {
    this.pdfDoc = pdfDoc;
    this.font = font;
    this.boldKey = boldKey;
    const [w, h] = PAGE_SIZES[pageSize];
    this.pageW = w;
    this.pageH = h;
    this.margin = MARGIN_PT[marginKind];
    this.contentW = w - this.margin * 2;
    this.page = this.newPage();
  }

  newPage(): CreatePage {
    this.page = this.pdfDoc.addPage(this.pageW, this.pageH);
    this.pages.push(this.page);
    this.y = this.pageH - this.margin;
    return this.page;
  }

  /** Page-break unless `need` points fit above the bottom margin. */
  ensure(need: number): void {
    if (this.y - need < this.margin) this.newPage();
  }

  fontFor(bold: boolean): ConvertFace {
    // Devanagari mode has no bold variant — hierarchy comes from size.
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
    s: string,
    x: number,
    yTop: number,
    size: number,
    bold: boolean,
    baseline: number
  ): void {
    if (!s) return;
    this.page.drawText({
      x,
      y: yTop - baseline,
      text: s,
      size,
      color: COL_TEXT,
      ...faceOpts(this.fontFor(bold)),
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
 * Word items derived from the runs' MERGED text — whitespace is the
 * only true word boundary; each word carries its per-segment styles;
 * "\n" (from text:line-break) is a hard break item.
 */
type Item = { kind: "word"; segs: Seg[] } | { kind: "break" };

function paraItems(runs: OdfRun[], baseSize: number): Item[] {
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
    const text = seg.text;
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
  runs: OdfRun[],
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
/* Text kind: paragraph / heading / list item                           */
/* ------------------------------------------------------------------ */

function drawHeadingOrPara(
  p: Painter,
  blk: OdfHeadingBlock | OdfParaBlock | OdfListBlock
): void {
  const isHeading = blk.kind === "heading";
  const h = isHeading ? HEADINGS[blk.level] : undefined;
  const baseSize = h ? h.size : BODY_SIZE;
  const baseLH = h ? h.lh : BODY_LH;
  const isList = blk.kind === "list-item";
  const level = Math.min(3, blk.kind === "list-item" ? blk.level : 0);

  if (blk.runs.length === 0 && !isList) {
    // ODT's blank spacing paragraph — one honest empty line.
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
      p.text(BULLETS[level] + " ", bulletX, p.y, baseSize, false, ln.maxSeg);
    }
    let cx = textX;
    for (const seg of ln.segs) {
      if (seg.text) {
        p.text(seg.text, cx, p.y, seg.size, seg.bold || isHeading, ln.maxSeg);
      }
      cx += p.width(seg.text, seg.size, seg.bold);
    }
    p.y -= ln.lh;
    first = false;
  }
  p.y -= h ? h.after : isList ? BULLET_AFTER : PARA_AFTER;
}

/* ------------------------------------------------------------------ */
/* Text kind: table                                                     */
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

function drawTextTable(p: Painter, blk: OdfTableBlock): void {
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
        if (line) {
          p.text(line, x + TABLE_PAD, ty, TABLE_CELL_SIZE, false, TABLE_CELL_SIZE);
        }
        ty -= TABLE_CELL_LH;
      }
      x += w;
    }
    p.y -= rowH;
  }
  p.y -= TABLE_AFTER;
}

/* ------------------------------------------------------------------ */
/* Sheets kind (excel-to-pdf grid lineage, portrait, fit to width)       */
/* ------------------------------------------------------------------ */

const SHEET_BODY_SIZE = 9;
const SHEET_HEADER_SIZE = 9;
const SHEET_NAME_SIZE = 12;
const SHEET_LINE_H = 11;
const SHEET_ROW_PAD = 6;
const SHEET_FIRST_BASELINE = 10;
const SHEET_MIN_COL_PT = 40;
const SHEET_MAX_COL_PT = 200;

/** Natural column widths in pt from content length (excel heuristic). */
function sheetColumnWidths(grid: string[][]): number[] {
  const ncols = grid.reduce((m, row) => Math.max(m, row.length), 0);
  const widths = new Array<number>(ncols).fill(SHEET_MIN_COL_PT);
  for (const row of grid) {
    for (let c = 0; c < row.length && c < ncols; c++) {
      const len = row[c]?.length ?? 0;
      // only grow for the first 48 chars per column — long cells wrap
      const eff = Math.min(len, 48);
      const w = 10 + eff * 5.6;
      if (w > widths[c]) widths[c] = w;
    }
  }
  for (let c = 0; c < ncols; c++) {
    widths[c] = Math.min(SHEET_MAX_COL_PT, Math.max(SHEET_MIN_COL_PT, widths[c]));
  }
  return widths;
}

type Measure = (text: string, size: number) => number;

/** Word-wrap with char-breaking for over-long words. */
function wrapCellText(
  text: string,
  width: number,
  size: number,
  measure: Measure
): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    if (para === "") {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(" ")) {
      if (word === "") continue;
      const cand = line === "" ? word : `${line} ${word}`;
      if (measure(cand, size) <= width) {
        line = cand;
        continue;
      }
      if (line !== "") {
        lines.push(line);
        line = "";
      }
      if (measure(word, size) <= width) {
        line = word;
        continue;
      }
      // char-break the over-long word (progress guaranteed)
      let piece = "";
      for (const ch of word) {
        if (measure(piece + ch, size) <= width) {
          piece += ch;
        } else {
          lines.push(piece);
          piece = ch;
        }
      }
      line = piece;
    }
    if (line !== "") lines.push(line);
  }
  return lines.length > 0 ? lines : [""];
}

/** Clips wrapped lines to `cap`, honestly marking the cut with "…". */
function clipLines(
  lines: string[],
  cap: number,
  width: number,
  size: number,
  measure: Measure
): string[] {
  if (cap < 1 || lines.length <= cap) return lines;
  const out = lines.slice(0, cap);
  let last = out[cap - 1];
  while (last.length > 1 && measure(`${last}\u2026`, size) > width) {
    last = last.slice(0, -1);
  }
  out[cap - 1] = `${last}\u2026`;
  return out;
}

function drawSheets(
  pdfDoc: CreateContext,
  font: ConvertFace,
  boldKey: StampFontKey | null,
  doc: Extract<ParsedOdf, { kind: "sheets" }>,
  opts: OdfRenderOpts
): OdfRenderReport {
  const [pageW, pageH] = PAGE_SIZES[opts.pageSize === "letter" ? "letter" : "a4"];
  const margin = MARGIN_PT[opts.margin === "narrow" ? "narrow" : "normal"];
  const x0 = margin;
  const contentWidth = pageW - 2 * margin;
  const tableTopDrop = 54;
  const sheetNameDrop = 34;
  const measure: Measure = (text, size) =>
    faceWidth(pdfDoc, font, text, size);
  const tableTop = pageH - tableTopDrop;
  const bottom = margin;
  let pagesDrawn = 0;

  const boldFace: ConvertFace | null = !font.ttf && boldKey
    ? { std: boldKey }
    : null;

  const drawCellText = (
    page: CreatePage,
    text: string,
    x: number,
    y: number,
    bold: boolean
  ): void => {
    if (text === "") return;
    const face = bold && boldFace ? boldFace : font;
    page.drawText({
      x,
      y,
      text,
      size: SHEET_BODY_SIZE,
      color: COL_TEXT,
      ...faceOpts(face),
    });
    if (bold && !boldFace) {
      // Noto ships Regular only — the invoice double-draw faux-bold
      page.drawText({
        x: x + 0.3,
        y,
        text,
        size: SHEET_BODY_SIZE,
        color: COL_TEXT,
        ...faceOpts(face),
      });
    }
  };

  for (const sheet of doc.sheets) {
    const grid = sheet.grid;
    const natural = sheetColumnWidths(grid);
    const naturalW = natural.reduce((a, b) => a + b, 0);
    const scale = naturalW <= 0 ? 1 : Math.min(1, contentWidth / naturalW);
    const widths = natural.map((w) => w * scale);
    const xEnds: number[] = [];
    let acc = 0;
    for (const w of widths) {
      acc += w;
      xEnds.push(acc);
    }
    const tableWidth = Math.min(acc, contentWidth);

    // ---- first page of the sheet: name header + rule ----
    const page = pdfDoc.addPage(pageW, pageH);
    pagesDrawn += 1;
    const nameFace = boldFace ?? font;
    page.drawText({
      x: x0,
      y: pageH - sheetNameDrop,
      text: sheet.name,
      size: SHEET_NAME_SIZE,
      color: COL_TEXT,
      ...faceOpts(nameFace),
    });
    page.drawLine({
      start: { x: x0, y: pageH - sheetNameDrop - 8 },
      end: { x: x0 + contentWidth, y: pageH - sheetNameDrop - 8 },
      thickness: 0.75,
      color: COL_BORDER,
    });

    // header row = grid row 0 (bold, neutral fill, repeated on breaks)
    const headerRow = grid[0] ?? null;
    const contentHeight = pageH - tableTopDrop - bottom;
    const maxLinesCap = Math.max(
      1,
      Math.floor((contentHeight * 0.6) / SHEET_LINE_H)
    );
    const headerCells =
      headerRow !== null
        ? widths.map((w, c) =>
            clipLines(
              wrapCellText(headerRow[c] ?? "", w - 6, SHEET_HEADER_SIZE, measure),
              maxLinesCap,
              w - 6,
              SHEET_HEADER_SIZE,
              measure
            )
          )
        : null;
    const headerH =
      headerCells !== null
        ? Math.max(...headerCells.map((l) => l.length), 1) * SHEET_LINE_H + SHEET_ROW_PAD
        : 0;

    let y = tableTop;
    let pageTopY = tableTop;
    let pageIdx = 0;
    const pages: CreatePage[] = [page];
    let justBroke = false;

    const finishPage = (): void => {
      const p = pages[pageIdx];
      p.drawLine({
        start: { x: x0, y: pageTopY },
        end: { x: x0 + tableWidth, y: pageTopY },
        thickness: 0.75,
        color: COL_GRID,
      });
      for (let c = 0; c <= widths.length; c++) {
        const vx = x0 + (c === 0 ? 0 : xEnds[c - 1]);
        p.drawLine({
          start: { x: vx, y: pageTopY },
          end: { x: vx, y },
          thickness: 0.5,
          color: COL_GRID,
        });
      }
    };

    const drawHeaderRow = (target: CreatePage, top: number): number => {
      if (headerCells === null) return top;
      const h = headerH;
      target.drawRectangle({
        x: x0,
        y: top - h,
        width: tableWidth,
        height: h,
        color: COL_HEADER_FILL,
      });
      for (let c = 0; c < widths.length; c++) {
        const lines = headerCells[c];
        const cx = x0 + (c === 0 ? 0 : xEnds[c - 1]) + 3;
        for (let i = 0; i < lines.length; i++) {
          drawCellText(
            target,
            lines[i],
            cx,
            top - SHEET_FIRST_BASELINE - i * SHEET_LINE_H,
            true
          );
        }
      }
      target.drawLine({
        start: { x: x0, y: top - h },
        end: { x: x0 + tableWidth, y: top - h },
        thickness: 1,
        color: COL_BORDER,
      });
      return top - h;
    };

    y = drawHeaderRow(page, y);

    for (let r = 1; r < grid.length; r++) {
      const row = grid[r];
      const cells = widths.map((w, c) =>
        wrapCellText(row[c] ?? "", w - 6, SHEET_BODY_SIZE, measure)
      );
      let lineCount = 1;
      for (const l of cells) lineCount = Math.max(lineCount, l.length);
      const rowH = lineCount * SHEET_LINE_H + SHEET_ROW_PAD;

      if (y - rowH < bottom && y < tableTop - 0.5 && !justBroke) {
        finishPage();
        const next = pdfDoc.addPage(pageW, pageH);
        pagesDrawn += 1;
        pages.push(next);
        pageIdx += 1;
        pageTopY = tableTop;
        y = tableTop;
        y = drawHeaderRow(next, y);
        justBroke = true;
      } else {
        justBroke = false;
      }

      const target = pages[pageIdx];
      for (let c = 0; c < widths.length; c++) {
        const lines = cells[c];
        const cx = x0 + (c === 0 ? 0 : xEnds[c - 1]) + 3;
        for (let i = 0; i < lines.length; i++) {
          drawCellText(
            target,
            lines[i],
            cx,
            y - SHEET_FIRST_BASELINE - i * SHEET_LINE_H,
            false
          );
        }
      }
      target.drawLine({
        start: { x: x0, y: y - rowH },
        end: { x: x0 + tableWidth, y: y - rowH },
        thickness: 0.5,
        color: COL_GRID,
      });
      y -= rowH;
    }
    finishPage();
  }

  if (pagesDrawn === 0) {
    // defensive: a workbook with no renderable sheets still yields one page
    pdfDoc.addPage(pageW, pageH);
    pagesDrawn = 1;
  }
  return { pages: pagesDrawn };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

export interface OdfRenderOpts {
  pageSize: "a4" | "letter";
  margin: "normal" | "narrow";
}

export interface OdfRenderReport {
  pages: number;
}

/**
 * Paint the whole document into `pdfDoc` (pages added as needed).
 * `font` must already be resolved (Helvetica standard OR the Noto
 * Devanagari face); `boldKey` may be null — bold text then falls back
 * to the regular face (Noto ships Regular only).
 */
export function drawOdfPdf(
  pdfDoc: CreateContext,
  font: ConvertFace,
  boldKey: StampFontKey | null,
  doc: ParsedOdf,
  opts: OdfRenderOpts
): OdfRenderReport {
  if (doc.kind === "sheets") {
    return drawSheets(pdfDoc, font, boldKey, doc, opts);
  }
  const p = new Painter(
    pdfDoc,
    font,
    boldKey,
    opts.pageSize === "letter" ? "letter" : "a4",
    opts.margin === "narrow" ? "narrow" : "normal"
  );
  for (const blk of doc.blocks) {
    if (blk.kind === "table") {
      drawTextTable(p, blk);
    } else {
      drawHeadingOrPara(p, blk);
    }
  }
  return { pages: p.pages.length };
}
