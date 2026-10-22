/**
 * EPUB to PDF renderer (RB3-a — the 75th tool) — the vector page
 * painter. Extracted so the worker and the smoke script drive the
 * EXACT drawing code headless in bun (word-to-pdf/html-to-pdf
 * precedent): same geometry, same wrap math, same pagination.
 *
 *  - A4 595.28×841.89 (or US Letter 612×792); margins normal 56 pt,
 *    narrow 28 pt, WIDE 80 pt (the honest book spread); base font
 *    size option (small 10 / normal 11 / large 12.5 pt).
 *  - Chapter bodies draw with html-to-pdf's block painter (headings
 *    h1–h6, styled runs, nested lists, quotes, <pre>, tables) — the
 *    html-to-pdf scope, nothing more. Every chapter starts on a
 *    FRESH page (the odt per-chapter pagination pattern).
 *  - Cover page: the EPUB's PNG/JPG cover, contain-fit and centered.
 *  - TOC page ("Contents"): chapter titles with EXACT page numbers —
 *    chapters are painted first and their start pages recorded, then
 *    the TOC pages are INSERTED between cover and chapters
 *    (pdf-lib insertPage), so the printed number = recorded start +
 *    toc-page count + 1. No guessing, no links without numbers.
 *  - Page numbers option: a centered folio in the bottom margin of
 *    every non-cover page, stamped after the TOC insertion so the
 *    numbers match the final page order.
 *  - Metadata: the worker writes PDF title/author from the OPF.
 *  - Every glyph is drawText — REAL selectable vector text only.
 *
 * Fonts arrive already embedded (worker): `fonts` is either the
 * base-14 Helvetica/Courier set (pure-WinAnsi books — no FontFile2) or
 * the Noto Devanagari subset for EVERYTHING (Regular only — bold,
 * italic and mono honestly fall back to the one face, hierarchy comes
 * from size alone).
 */

import type { PDFDocument, PDFFont, PDFImage, PDFPage } from "pdf-lib";
import { rgb, type RGB } from "pdf-lib";

import {
  HEADING_SIZES,
  type HtmlBlock,
  type HtmlRun,
} from "../html-to-pdf/model";
import type { EpubChapter, ParsedEpub } from "./model";

/* ------------------------------------------------------------------ */
/* Geometry + palette                                                    */
/* ------------------------------------------------------------------ */

const PAGE_SIZES: Record<"a4" | "letter", [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

export type MarginKind = "normal" | "narrow" | "wide";

const MARGIN_PT: Record<MarginKind, number> = {
  normal: 56,
  narrow: 28,
  wide: 80,
};

const PARA_AFTER = 4;
const HEADING_AFTER = 3;
const BULLET_AFTER = 2;
const LIST_STEP = 14; // indent per list depth level
const MARKER_GAP = 6; // marker to text
const QUOTE_INDENT = 18;
const QUOTE_BAR_X = 6; // bar offset inside the margin
const QUOTE_BAR_W = 2.4;
const RULE_GAP = 7;
const MIN_LINE = 40; // never wrap into a sliver

const PRE_PAD = 8;
const PRE_AFTER = 8;

const TABLE_PAD = 4;
const TABLE_MIN_COL = 32;
const TABLE_AFTER = 8;

const FOLIO_SIZE = 9; // page-number pt
const FOLIO_GAP = 10; // baseline above the page edge inside the margin

const TOC_HEADER_SIZE = 1.9; // × base
const TOC_LH = 1.5; // × base per entry line
const TOC_ENTRY_GAP = 5;
const TOC_NUM_COL = 34; // fixed-width page-number column (pt)
const TOC_NUM_GAP = 10;
const TOC_MAX_LINES = 3; // per entry — long titles truncate honestly

const COL_TEXT: RGB = rgb(0.09, 0.09, 0.09);
const COL_MUTED: RGB = rgb(0.3, 0.3, 0.3);
const COL_BORDER: RGB = rgb(0.62, 0.62, 0.62);
const COL_BAR: RGB = rgb(0.45, 0.45, 0.48);
const COL_PRE_BG: RGB = rgb(0.945, 0.945, 0.95);
const COL_HEADER_FILL: RGB = rgb(0.9, 0.91, 0.92);
const COL_TOC_NUM: RGB = rgb(0.25, 0.25, 0.28);

/** mono runs render a touch smaller — Courier's em box is wider. */
function monoSize(base: number): number {
  return base * 0.92;
}

interface HeadingSpec {
  size: number;
  before: number;
  after: number;
  lh: number;
}

function headingSpec(level: number, base: number): HeadingSpec {
  const size = (HEADING_SIZES[Math.min(6, Math.max(1, level)) - 1] ?? 12) * (base / 11);
  return {
    size,
    before: size * 0.55,
    after: Math.max(HEADING_AFTER, size * 0.3),
    lh: size * 1.28,
  };
}

/* ------------------------------------------------------------------ */
/* Font set (worker embeds; render resolves)                             */
/* ------------------------------------------------------------------ */

export interface EpubFontSet {
  /** true when every string goes to the single Noto Devanagari face. */
  isNoto: boolean;
  resolve(bold: boolean, italic: boolean, mono: boolean): PDFFont;
}

/* ------------------------------------------------------------------ */
/* Painter (html-to-pdf's, with margin passed directly)                 */
/* ------------------------------------------------------------------ */

class Painter {
  readonly pdfDoc: PDFDocument;
  readonly fonts: EpubFontSet;
  readonly pages: PDFPage[] = [];
  readonly pageW: number;
  readonly pageH: number;
  readonly margin: number;
  readonly contentW: number;
  readonly base: number;
  page: PDFPage;
  y!: number;

  constructor(
    pdfDoc: PDFDocument,
    fonts: EpubFontSet,
    pageSize: "a4" | "letter",
    margin: number,
    baseFontSize: number
  ) {
    this.pdfDoc = pdfDoc;
    this.fonts = fonts;
    this.base = baseFontSize;
    const [w, h] = PAGE_SIZES[pageSize];
    this.pageW = w;
    this.pageH = h;
    this.margin = margin;
    this.contentW = w - margin * 2;
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

  font(bold: boolean, italic: boolean, m: boolean): PDFFont {
    return this.fonts.resolve(bold, italic, m);
  }

  width(text: string, size: number, bold: boolean, italic: boolean, m: boolean): number {
    if (!text) return 0;
    return this.font(bold, italic, m).widthOfTextAtSize(text, size);
  }

  /** Baseline-aligned draw at (x, yTop) — the house text() convention. */
  text(
    s: string,
    x: number,
    yTop: number,
    size: number,
    bold: boolean,
    italic: boolean,
    m: boolean,
    baseline: number,
    color: RGB = COL_TEXT
  ): void {
    if (!s) return;
    this.page.drawText(s, {
      x,
      y: yTop - baseline,
      size,
      font: this.font(bold, italic, m),
      color,
    });
  }

  /** The underline stroke for <u> and links — a real vector line. */
  underline(x: number, yTop: number, w: number, baseline: number): void {
    if (w <= 0) return;
    const y = yTop - baseline - 1.4;
    this.page.drawLine({
      start: { x, y },
      end: { x: x + w, y },
      thickness: 0.6,
      color: COL_TEXT,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Styled line layout (mixed bold/italic/underline/mono runs)           */
/* ------------------------------------------------------------------ */

interface Seg {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  mono: boolean;
  size: number;
}

interface Line {
  segs: Seg[];
  width: number;
  lh: number;
  /** baseline offset = the largest seg size in the line. */
  maxSeg: number;
}

interface CharStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  mono: boolean;
}

function sameSegStyle(a: Seg, b: CharStyle): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.mono === b.mono
  );
}

/**
 * Runs are split on whitespace — the only true word boundary — and each
 * word carries its per-segment styles. "\n" (from <br>) is a hard break
 * item. Link text is underlined (its href is honestly not printed).
 */
function paraItems(runs: HtmlRun[], base: number): Item[] {
  let merged = "";
  const styles: CharStyle[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const isLink = r.link !== undefined && r.link !== "";
    for (const ch of r.text) {
      merged += ch;
      styles.push({
        bold: r.bold,
        italic: r.italic,
        underline: r.underline || isLink,
        mono: r.mono,
      });
    }
  }
  const sizeOf = (st: CharStyle): number => (st.mono ? monoSize(base) : base);

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
      while (
        e < i &&
        styles[e].bold === styles[s].bold &&
        styles[e].italic === styles[s].italic &&
        styles[e].underline === styles[s].underline &&
        styles[e].mono === styles[s].mono
      ) {
        e += 1;
      }
      segs.push({
        text: merged.slice(s, e),
        bold: styles[s].bold,
        italic: styles[s].italic,
        underline: styles[s].underline,
        mono: styles[s].mono,
        size: sizeOf(styles[s]),
      });
      s = e;
    }
    items.push({ kind: "word", segs });
  }
  return items;
}

type Item = { kind: "word"; segs: Seg[] } | { kind: "break" };

const segW = (p: Painter, seg: Seg): number =>
  p.width(seg.text, seg.size, seg.bold, seg.italic, seg.mono);
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
        curW + p.width(text.slice(off, off + take), seg.size, seg.bold, seg.italic, seg.mono) > width
      ) {
        take -= 1;
      }
      const piece = text.slice(off, off + take);
      const pieceW = p.width(piece, seg.size, seg.bold, seg.italic, seg.mono);
      if (curW > 0 && curW + pieceW > width) {
        pieces.push(cur);
        cur = [];
        curW = 0;
        continue; // retry the same piece on an empty line
      }
      const last = cur[cur.length - 1];
      if (last && sameSegStyle(last, seg)) {
        last.text += piece;
      } else {
        cur.push({ ...seg, text: piece });
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
  runs: HtmlRun[],
  width: number,
  base: number,
  forceBold: boolean,
  baseLH: number
): Line[] {
  const items = paraItems(runs, base);
  const lines: Line[] = [];
  let segs: Seg[] = [];
  let lineW = 0;
  let maxSeg = 0;

  const flush = (): void => {
    lines.push({
      segs,
      width: lineW,
      lh: Math.max(baseLH, maxSeg * 1.32),
      maxSeg: Math.max(maxSeg, 1),
    });
    segs = [];
    lineW = 0;
    maxSeg = 0;
  };

  const addWord = (segsIn: Seg[], spaceBefore: boolean): void => {
    const w = wordW(p, segsIn);
    const spaceW = spaceBefore
      ? p.width(" ", segsIn[0].size, false, false, false)
      : 0;
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
        if (last && sameSegStyle(last, seg)) {
          last.text += " " + seg.text;
        } else {
          segs.push({ ...seg, text: " " + seg.text });
        }
      } else {
        const last = segs[segs.length - 1];
        if (!first && last && sameSegStyle(last, seg)) {
          last.text += seg.text;
        } else {
          segs.push({ ...seg });
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
function layoutPlain(
  p: Painter,
  text: string,
  width: number,
  size: number,
  bold: boolean
): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    let lineW = 0;
    for (const word of para.split(" ")) {
      if (word === "") continue;
      let piece = word;
      while (p.width(piece, size, bold, false, false) > width && piece.length > 1) {
        let cut = piece.length;
        while (cut > 1 && p.width(piece.slice(0, cut - 1), size, bold, false, false) > width) {
          cut -= 1;
        }
        out.push((line ? line + " " : "") + piece.slice(0, Math.max(1, cut - 1)));
        line = "";
        lineW = 0;
        piece = piece.slice(Math.max(1, cut - 1));
      }
      const w = p.width(piece, size, bold, false, false);
      const space = lineW > 0 ? p.width(" ", size, bold, false, false) : 0;
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
/* Block renderers (html-to-pdf's)                                      */
/* ------------------------------------------------------------------ */

function drawTextLines(
  p: Painter,
  runs: HtmlRun[],
  x: number,
  width: number,
  baseLH: number,
  forceBold: boolean,
  color: RGB
): number {
  const lines = layoutLines(p, runs, width, p.base, forceBold, baseLH);
  for (const ln of lines) {
    p.ensure(ln.lh);
    let cx = x;
    for (const seg of ln.segs) {
      if (seg.text) {
        p.text(
          seg.text,
          cx,
          p.y,
          seg.size,
          seg.bold,
          seg.italic,
          seg.mono,
          ln.maxSeg,
          color
        );
        if (seg.underline) {
          p.underline(
            cx,
            p.y,
            p.width(seg.text, seg.size, seg.bold, seg.italic, seg.mono),
            ln.maxSeg
          );
        }
      }
      cx += p.width(seg.text, seg.size, seg.bold, seg.italic, seg.mono);
    }
    p.y -= ln.lh;
  }
  return lines.length;
}

function drawHeading(
  p: Painter,
  blk: Extract<HtmlBlock, { kind: "heading" }>
): void {
  const spec = headingSpec(blk.level, p.base);
  // keep the heading with at least its first content line
  p.ensure(spec.lh + spec.after + p.base * 1.36);
  p.y -= spec.before;
  drawTextLines(
    p,
    blk.runs,
    p.margin,
    Math.max(MIN_LINE, p.contentW),
    spec.lh,
    true,
    COL_TEXT
  );
  p.y -= spec.after;
}

function drawPara(p: Painter, blk: Extract<HtmlBlock, { kind: "para" }>): void {
  drawTextLines(
    p,
    blk.runs,
    p.margin,
    Math.max(MIN_LINE, p.contentW),
    p.base * 1.36,
    false,
    COL_TEXT
  );
  p.y -= PARA_AFTER;
}

function drawListItem(
  p: Painter,
  blk: Extract<HtmlBlock, { kind: "list-item" }>
): void {
  const level = Math.min(8, Math.max(0, blk.depth));
  const markerX = p.margin + 4 + LIST_STEP * level;
  const marker = blk.ordered && blk.number > 0 ? `${blk.number}.` : "\u2022";
  const markerSize = p.base;
  const markerW = p.width(marker, markerSize, false, false, false);
  const textX = markerX + markerW + MARKER_GAP;
  const avail = Math.max(MIN_LINE, p.margin + p.contentW - textX);

  const lines = layoutLines(
    p,
    blk.runs,
    avail,
    p.base,
    false,
    p.base * 1.36
  );
  let first = true;
  for (const ln of lines) {
    p.ensure(ln.lh);
    if (first) {
      p.text(marker, markerX, p.y, markerSize, false, false, false, ln.maxSeg);
    }
    let cx = textX;
    for (const seg of ln.segs) {
      if (seg.text) {
        p.text(seg.text, cx, p.y, seg.size, seg.bold, seg.italic, seg.mono, ln.maxSeg);
        if (seg.underline) {
          p.underline(
            cx,
            p.y,
            p.width(seg.text, seg.size, seg.bold, seg.italic, seg.mono),
            ln.maxSeg
          );
        }
      }
      cx += p.width(seg.text, seg.size, seg.bold, seg.italic, seg.mono);
    }
    p.y -= ln.lh;
    first = false;
  }
  p.y -= BULLET_AFTER;
}

function drawQuote(
  p: Painter,
  blk: Extract<HtmlBlock, { kind: "quote" }>
): void {
  const textX = p.margin + QUOTE_INDENT;
  const avail = Math.max(MIN_LINE, p.contentW - QUOTE_INDENT);
  const lines = layoutLines(p, blk.runs, avail, p.base, false, p.base * 1.36);
  const barX = p.margin + QUOTE_BAR_X;
  for (const ln of lines) {
    p.ensure(ln.lh);
    // one accent-bar piece per line — pieces stack seamlessly and
    // restart correctly on continuation pages
    p.page.drawLine({
      start: { x: barX, y: p.y - ln.lh },
      end: { x: barX, y: p.y },
      thickness: QUOTE_BAR_W,
      color: COL_BAR,
    });
    let cx = textX;
    for (const seg of ln.segs) {
      if (seg.text) {
        p.text(
          seg.text,
          cx,
          p.y,
          seg.size,
          seg.bold,
          seg.italic,
          seg.mono,
          ln.maxSeg,
          COL_MUTED
        );
        if (seg.underline) {
          p.underline(
            cx,
            p.y,
            p.width(seg.text, seg.size, seg.bold, seg.italic, seg.mono),
            ln.maxSeg
          );
        }
      }
      cx += p.width(seg.text, seg.size, seg.bold, seg.italic, seg.mono);
    }
    p.y -= ln.lh;
  }
  p.y -= PARA_AFTER;
}

function drawRule(p: Painter): void {
  p.ensure(RULE_GAP * 2 + 1);
  const y = p.y - RULE_GAP;
  p.page.drawLine({
    start: { x: p.margin, y },
    end: { x: p.margin + p.contentW, y },
    thickness: 0.8,
    color: COL_BORDER,
  });
  p.y = y - RULE_GAP;
}

function drawPre(p: Painter, blk: Extract<HtmlBlock, { kind: "pre" }>): void {
  const size = monoSize(p.base * 0.96);
  const lh = size * 1.35;
  const inner = Math.max(MIN_LINE, p.contentW - PRE_PAD * 2);
  const lines: string[] = [];
  for (const raw of blk.text.split("\n")) {
    if (raw === "") {
      lines.push("");
      continue;
    }
    if (p.width(raw, size, false, false, true) <= inner) {
      lines.push(raw);
      continue;
    }
    // char-break over-long pre lines
    let cur = "";
    for (const ch of raw) {
      const cand = cur + ch;
      if (p.width(cand, size, false, false, true) > inner) {
        lines.push(cur);
        cur = ch;
      } else {
        cur = cand;
      }
    }
    if (cur) lines.push(cur);
  }
  p.ensure(lh + PRE_PAD);
  p.y -= PRE_PAD;
  for (const line of lines) {
    p.ensure(lh);
    // the background rect follows its line onto continuation pages
    p.page.drawRectangle({
      x: p.margin,
      y: p.y - lh,
      width: p.contentW,
      height: lh,
      color: COL_PRE_BG,
    });
    if (line) {
      p.text(line, p.margin + PRE_PAD, p.y, size, false, false, true, size);
    }
    p.y -= lh;
  }
  p.y -= PRE_PAD + PRE_AFTER;
}

function columnWidths(
  p: Painter,
  rows: string[][],
  ncols: number,
  size: number
): number[] {
  const natural = new Array<number>(ncols).fill(0);
  const minWord = new Array<number>(ncols).fill(TABLE_MIN_COL);
  for (const row of rows) {
    for (let c = 0; c < ncols; c++) {
      const cell = row[c] ?? "";
      const full = p.width(cell, size, false, false, false);
      if (full > natural[c]) natural[c] = Math.min(full, p.contentW);
      for (const word of cell.split(/\s+/)) {
        const w = p.width(word, size, false, false, false) + TABLE_PAD * 2;
        if (w > minWord[c]) minWord[c] = Math.min(w, p.contentW);
      }
    }
  }
  const ideal = natural.map((n, c) =>
    Math.max(Math.min(n, p.contentW), minWord[c], TABLE_MIN_COL)
  );
  const sum = ideal.reduce((a, b) => a + b, 0);
  // fit to the printable width (the excel-to-pdf pattern)
  if (sum <= 0) return ideal;
  const scale = p.contentW / sum;
  return ideal.map((w) => Math.max(w * scale, 24));
}

function drawTable(
  p: Painter,
  blk: Extract<HtmlBlock, { kind: "table" }>
): void {
  const rows = blk.grid;
  if (rows.length === 0) return;
  const ncols = Math.max(1, ...rows.map((r) => r.length));
  const size = p.base * 0.82;
  const lh = size * 1.35;
  const widths = columnWidths(p, rows, ncols, size);
  const boldRow = blk.headerRow === true;

  // keep the first row + one more line together on a page
  let firstRowLines = 1;
  rows[0].forEach((cell, c) => {
    firstRowLines = Math.max(
      firstRowLines,
      layoutPlain(p, cell, widths[c] - TABLE_PAD * 2, size, boldRow).length
    );
  });
  p.ensure(firstRowLines * lh + TABLE_PAD * 2 + lh);

  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    const isHeader = boldRow && ri === 0;
    const cellLines = row.map(
      (cell, c) =>
        layoutPlain(p, cell, widths[c] - TABLE_PAD * 2, size, isHeader).slice(0, 60)
    );
    let rowLines = 1;
    for (const lines of cellLines) rowLines = Math.max(rowLines, lines.length);
    const rowH = rowLines * lh + TABLE_PAD * 2;
    p.ensure(rowH);
    let x = p.margin;
    for (let c = 0; c < ncols; c++) {
      const w = widths[c];
      if (isHeader) {
        p.page.drawRectangle({
          x,
          y: p.y - rowH,
          width: w,
          height: rowH,
          color: COL_HEADER_FILL,
        });
      }
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
        if (line) p.text(line, x + TABLE_PAD, ty, size, isHeader, false, false, size);
        ty -= lh;
      }
      x += w;
    }
    p.y -= rowH;
  }
  p.y -= TABLE_AFTER;
}

/** Paint one chapter's blocks into a fresh Painter (new page). */
function drawChapter(p: Painter, chapter: EpubChapter): void {
  for (const blk of chapter.doc.blocks) {
    switch (blk.kind) {
      case "heading":
        drawHeading(p, blk);
        break;
      case "para":
        drawPara(p, blk);
        break;
      case "list-item":
        drawListItem(p, blk);
        break;
      case "quote":
        drawQuote(p, blk);
        break;
      case "rule":
        drawRule(p);
        break;
      case "pre":
        drawPre(p, blk);
        break;
      case "table":
        drawTable(p, blk);
        break;
      default:
        break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Cover page                                                            */
/* ------------------------------------------------------------------ */

function drawCoverPage(
  pdfDoc: PDFDocument,
  image: PDFImage,
  pageW: number,
  pageH: number
): void {
  const page = pdfDoc.addPage([pageW, pageH]);
  const iw = image.width;
  const ih = image.height;
  if (iw <= 0 || ih <= 0) return;
  // contain-fit, centred, full-bleed (cover art carries its own frame)
  const s = Math.min(pageW / iw, pageH / ih);
  const w = iw * s;
  const h = ih * s;
  page.drawImage(image, {
    x: (pageW - w) / 2,
    y: (pageH - h) / 2,
    width: w,
    height: h,
  });
}

/* ------------------------------------------------------------------ */
/* TOC pages (inserted between cover and chapters)                      */
/* ------------------------------------------------------------------ */

interface TocEntrySpec {
  title: string;
  lines: string[];
  number: string;
}

/** Plain wrap of a TOC title within the title column. */
function wrapTocTitle(
  fonts: EpubFontSet,
  title: string,
  width: number,
  size: number
): string[] {
  const out: string[] = [];
  let line = "";
  let lineW = 0;
  for (const word of title.split(" ")) {
    if (word === "") continue;
    const font = fonts.resolve(false, false, false);
    const w = font.widthOfTextAtSize(word, size);
    const space = lineW > 0 ? font.widthOfTextAtSize(" ", size) : 0;
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
  return out.length > 0 ? out : [""];
}

/**
 * Lays the TOC out and paints it onto pages INSERTED at
 * `insertAt`. Page numbers are exact: `starts[i]` are the recorded
 * pre-insertion 0-based starts, and every chapter shifts by exactly
 * the number of TOC pages painted here (the fixed-width number column
 * cannot change line wraps, so the layout is number-value-independent).
 */
function drawTocPages(
  pdfDoc: PDFDocument,
  fonts: EpubFontSet,
  book: ParsedEpub,
  starts: number[],
  opts: EpubRenderOpts,
  insertAt: number
): number {
  const [pageW, pageH] = PAGE_SIZES[opts.pageSize === "letter" ? "letter" : "a4"];
  const margin = MARGIN_PT[opts.margin];
  const contentW = pageW - margin * 2;
  const titleW = Math.max(MIN_LINE, contentW - TOC_NUM_COL - TOC_NUM_GAP);
  const size = opts.baseFontSize;
  const lh = size * TOC_LH;
  const font = fonts.resolve(false, false, false);
  const boldFont = fonts.resolve(true, false, false);

  // --- measure: entry lines (numbers not needed for the layout) ---
  const specs: TocEntrySpec[] = [];
  for (let i = 0; i < book.chapters.length; i++) {
    const ch = book.chapters[i];
    const title = ch.title !== "" ? ch.title : `${opts.chapterWord} ${i + 1}`;
    let lines = wrapTocTitle(fonts, title, titleW, size);
    if (lines.length > TOC_MAX_LINES) {
      lines = lines.slice(0, TOC_MAX_LINES);
      const last = lines[lines.length - 1] ?? "";
      lines[lines.length - 1] = `${last.slice(0, Math.max(0, last.length - 1))}…`;
    }
    specs.push({ title, lines, number: "" });
  }

  // --- paginate the entries (heights in POINTS against the page box) ---
  const headerSize = size * TOC_HEADER_SIZE;
  const headerH = headerSize * 1.3 + size * 1.4;
  const usable = pageH - margin * 2;
  const entryH = (i: number): number => specs[i].lines.length * lh;
  const pageOf: number[][] = [];
  let page: number[] = [];
  let used = 0;
  let capacity = usable - headerH; // the first page carries the heading
  for (let i = 0; i < specs.length; i++) {
    const h = entryH(i) + (i > 0 && page.length > 0 ? TOC_ENTRY_GAP : 0);
    if (used + h > capacity && page.length > 0) {
      pageOf.push(page);
      page = [];
      used = 0;
      capacity = usable;
    }
    page.push(i);
    used += h;
  }
  if (page.length > 0) pageOf.push(page);

  // --- paint: exact numbers now that the page count is known ---
  const tocPages = pageOf.length;
  for (let i = 0; i < specs.length; i++) {
    const finalIndex = starts[i] + tocPages; // shift by the TOC itself
    specs[i].number = String(finalIndex + 1);
  }

  let pageNo = 0;
  for (const entries of pageOf) {
    const page = pdfDoc.insertPage(insertAt + pageNo, [pageW, pageH]);
    let y = pageH - margin;
    if (pageNo === 0) {
      page.drawText(opts.tocTitle, {
        x: margin,
        y: y - headerSize,
        size: headerSize,
        font: boldFont,
        color: COL_TEXT,
      });
      y -= headerH;
    }
    for (const i of entries) {
      const spec = specs[i];
      for (let l = 0; l < spec.lines.length; l++) {
        const text = spec.lines[l];
        if (l === 0) {
          const numW = font.widthOfTextAtSize(spec.number, size);
          page.drawText(spec.number, {
            x: margin + contentW - numW,
            y: y - size,
            size,
            font,
            color: COL_TOC_NUM,
          });
        }
        if (text !== "") {
          page.drawText(text, {
            x: margin,
            y: y - size,
            size,
            font,
            color: COL_TEXT,
          });
        }
        y -= lh;
      }
      y -= TOC_ENTRY_GAP;
    }
    pageNo += 1;
  }
  return tocPages;
}

/* ------------------------------------------------------------------ */
/* Page numbers (folios)                                                 */
/* ------------------------------------------------------------------ */

function stampPageNumbers(
  pdfDoc: PDFDocument,
  fonts: EpubFontSet,
  skipPages: number,
  margin: number
): void {
  const font = fonts.resolve(false, false, false);
  const pages = pdfDoc.getPages();
  for (let i = skipPages; i < pages.length; i++) {
    const label = String(i + 1);
    const { width } = pages[i].getSize();
    const w = font.widthOfTextAtSize(label, FOLIO_SIZE);
    pages[i].drawText(label, {
      x: (width - w) / 2,
      y: Math.max(12, margin - FOLIO_GAP - FOLIO_SIZE),
      size: FOLIO_SIZE,
      font,
      color: COL_MUTED,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

export interface EpubRenderOpts {
  pageSize: "a4" | "letter";
  margin: MarginKind;
  /** body pt (small 10 / normal 11 / large 12.5). */
  baseFontSize: number;
  /** centered folio in the bottom margin of every non-cover page. */
  pageNumbers: boolean;
  /** the "Contents" page between cover and chapters. */
  includeToc: boolean;
  /** only effective when a cover image is supplied. */
  includeCover: boolean;
  /** localized "Contents" heading (tocTitleFor). */
  tocTitle: string;
  /** localized "Chapter" word for untitled chapters (chapterWordFor). */
  chapterWord: string;
}

export interface EpubRenderReport {
  pages: number;
  /** number of TOC pages inserted (0 when the TOC is off). */
  tocPages: number;
  /** number of cover pages painted (0 or 1). */
  coverPages: number;
  /**
   * FINAL 0-based page index where each chapter starts (cover + TOC
   * included) — the TOC prints exactly starts[i] + 1.
   */
  chapterStarts: number[];
}

/**
 * Paint the whole book into `pdfDoc` (pages added/inserted as needed).
 * `fonts` must already be embedded (the base-14 set OR the Noto
 * subset); `coverImage` must already be embedded by the caller (the
 * worker's embedPng/embedJpg). Chapters always start on a fresh page,
 * so the TOC page numbers are exact without a second render pass.
 */
export function drawEpubPdf(
  pdfDoc: PDFDocument,
  fonts: EpubFontSet,
  book: ParsedEpub,
  coverImage: PDFImage | null,
  opts: EpubRenderOpts
): EpubRenderReport {
  const pageSize = opts.pageSize === "letter" ? "letter" : "a4";
  const [pageW, pageH] = PAGE_SIZES[pageSize];
  const margin = MARGIN_PT[opts.margin === "narrow" ? "narrow" : opts.margin === "wide" ? "wide" : "normal"];
  const base = Math.min(14, Math.max(8, opts.baseFontSize));

  // 1. cover (page 0)
  let coverPages = 0;
  if (opts.includeCover && coverImage !== null) {
    drawCoverPage(pdfDoc, coverImage, pageW, pageH);
    coverPages = 1;
  }

  // 2. chapters — one fresh Painter (fresh page) each, starts recorded
  const starts: number[] = [];
  for (const chapter of book.chapters) {
    starts.push(pdfDoc.getPageCount());
    const p = new Painter(pdfDoc, fonts, pageSize, margin, base);
    drawChapter(p, chapter);
  }

  // 3. TOC — inserted between cover and chapters; numbers exact
  let tocPages = 0;
  if (opts.includeToc && book.chapters.length > 0) {
    tocPages = drawTocPages(
      pdfDoc,
      fonts,
      book,
      starts,
      {
        ...opts,
        pageSize,
        margin: opts.margin,
        baseFontSize: base,
      },
      coverPages
    );
  }

  // 4. folios — stamped after insertion so numbers match final order
  if (opts.pageNumbers) {
    stampPageNumbers(pdfDoc, fonts, coverPages, margin);
  }

  return {
    pages: pdfDoc.getPageCount(),
    tocPages,
    coverPages,
    chapterStarts: starts.map((s) => s + tocPages),
  };
}
