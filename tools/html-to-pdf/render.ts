/**
 * HTML to PDF renderer (RB2-d — the 74th tool) — the vector page
 * painter. Extracted so the worker and the smoke script drive the
 * EXACT drawing code headless in bun (word-to-pdf precedent): same
 * geometry, same wrap math, same pagination.
 *
 *  - A4 595.28×841.89 (or US Letter 612×792), 56 pt margins (28 pt
 *    narrow option), base font size option (small 10 / normal 11 /
 *    large 12.5 pt).
 *  - Headings scaled h1 22 pt → h6 12 pt at the 11 pt default
 *    (multiplied by base/11), bold when a bold face exists.
 *  - Paragraphs re-wrapped with mixed bold/italic/underline/mono runs;
 *    <br> is a hard break; over-long words char-break.
 *  - Lists: "•" bullets or "1." numbers, 14 pt hanging indent per depth.
 *  - Blockquotes: 18 pt indent + a vertical accent bar beside the text.
 *  - <hr>: a thin rule across the content width.
 *  - <pre>: Courier with a light-gray background rectangle, whitespace
 *    preserved line-for-line.
 *  - Tables: the excel-to-pdf grid pattern — measured column widths
 *    fit to the printable width, hairline borders, wrapped top-aligned
 *    cells, bold header row on a light fill, row-wise pagination.
 *  - Links: real underlined text; with showLinks on, the href is
 *    appended footnote-style (" (https://…)") after the link text.
 *  - Every glyph is drawText — REAL selectable vector text only.
 *
 * Fonts arrive already embedded (worker): `fonts` is either the
 * base-14 Helvetica/Courier set (pure-WinAnsi docs — no FontFile2) or
 * the Noto Devanagari subset for EVERYTHING (Regular only — bold,
 * italic and mono honestly fall back to the one face, hierarchy comes
 * from size alone).
 */

import type { PDFDocument, PDFFont, PDFPage } from "pdf-lib";
import { rgb, type RGB } from "pdf-lib";

import { HEADING_SIZES, type HtmlBlock, type HtmlRun, type ParsedHtml } from "./model";

/* ------------------------------------------------------------------ */
/* Geometry + palette                                                    */
/* ------------------------------------------------------------------ */

const PAGE_SIZES: Record<"a4" | "letter", [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

const MARGIN_PT: Record<"normal" | "narrow", number> = {
  normal: 56,
  narrow: 28,
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

const COL_TEXT: RGB = rgb(0.09, 0.09, 0.09);
const COL_MUTED: RGB = rgb(0.3, 0.3, 0.3);
const COL_BORDER: RGB = rgb(0.62, 0.62, 0.62);
const COL_BAR: RGB = rgb(0.45, 0.45, 0.48);
const COL_PRE_BG: RGB = rgb(0.945, 0.945, 0.95);
const COL_HEADER_FILL: RGB = rgb(0.9, 0.91, 0.92);

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
/* Font set (worker embeds; render resolves)                            */
/* ------------------------------------------------------------------ */

export interface HtmlFontSet {
  /** true when every string goes to the single Noto Devanagari face. */
  isNoto: boolean;
  resolve(bold: boolean, italic: boolean, mono: boolean): PDFFont;
}

/* ------------------------------------------------------------------ */
/* Painter                                                              */
/* ------------------------------------------------------------------ */

class Painter {
  readonly pdfDoc: PDFDocument;
  readonly fonts: HtmlFontSet;
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
    fonts: HtmlFontSet,
    pageSize: "a4" | "letter",
    marginKind: "normal" | "narrow",
    baseFontSize: number
  ) {
    this.pdfDoc = pdfDoc;
    this.fonts = fonts;
    this.base = baseFontSize;
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
 * item. Link text is underlined; with showLinks the href is appended as
 * a plain-style footnote suffix.
 */
function paraItems(
  runs: HtmlRun[],
  base: number,
  showLinks: boolean,
  forceBold: boolean
): Item[] {
  let merged = "";
  const styles: CharStyle[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const isLink = r.link !== undefined && r.link !== "";
    for (const ch of r.text) {
      merged += ch;
      styles.push({
        bold: r.bold || forceBold,
        italic: r.italic,
        underline: r.underline || isLink,
        mono: r.mono,
      });
    }
    if (isLink && showLinks) {
      for (const ch of ` (${r.link})`) {
        merged += ch;
        styles.push({ bold: false, italic: false, underline: false, mono: false });
      }
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
      // \u00A0 renders as a space but never breaks a word
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
  showLinks: boolean,
  forceBold: boolean,
  baseLH: number
): Line[] {
  const items = paraItems(runs, base, showLinks, forceBold);
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
/* Block renderers                                                      */
/* ------------------------------------------------------------------ */

function drawTextLines(
  p: Painter,
  runs: HtmlRun[],
  x: number,
  width: number,
  baseLH: number,
  forceBold: boolean,
  opts: RenderOpts,
  color: RGB
): number {
  const lines = layoutLines(
    p,
    runs,
    width,
    opts.baseFontSize,
    opts.showLinks,
    forceBold,
    baseLH
  );
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

type RenderOpts = HtmlRenderOpts;

function drawHeading(
  p: Painter,
  blk: Extract<HtmlBlock, { kind: "heading" }>,
  opts: RenderOpts
): void {
  const spec = headingSpec(blk.level, opts.baseFontSize);
  // keep the heading with at least its first content line
  p.ensure(spec.lh + spec.after + opts.baseFontSize * 1.36);
  p.y -= spec.before;
  drawTextLines(
    p,
    blk.runs,
    p.margin,
    Math.max(MIN_LINE, p.contentW),
    spec.lh,
    true,
    opts,
    COL_TEXT
  );
  p.y -= spec.after;
}

function drawPara(
  p: Painter,
  blk: Extract<HtmlBlock, { kind: "para" }>,
  opts: RenderOpts
): void {
  drawTextLines(
    p,
    blk.runs,
    p.margin,
    Math.max(MIN_LINE, p.contentW),
    opts.baseFontSize * 1.36,
    false,
    opts,
    COL_TEXT
  );
  p.y -= PARA_AFTER;
}

function drawListItem(
  p: Painter,
  blk: Extract<HtmlBlock, { kind: "list-item" }>,
  opts: RenderOpts
): void {
  const level = Math.min(8, Math.max(0, blk.depth));
  const markerX = p.margin + 4 + LIST_STEP * level;
  const marker = blk.ordered && blk.number > 0 ? `${blk.number}.` : "\u2022";
  const markerSize = opts.baseFontSize;
  const markerW = p.width(marker, markerSize, false, false, false);
  const textX = markerX + markerW + MARKER_GAP;
  const avail = Math.max(MIN_LINE, p.margin + p.contentW - textX);

  const lines = layoutLines(
    p,
    blk.runs,
    avail,
    opts.baseFontSize,
    opts.showLinks,
    false,
    opts.baseFontSize * 1.36
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
  blk: Extract<HtmlBlock, { kind: "quote" }>,
  opts: RenderOpts
): void {
  const textX = p.margin + QUOTE_INDENT;
  const avail = Math.max(MIN_LINE, p.contentW - QUOTE_INDENT);
  const lines = layoutLines(
    p,
    blk.runs,
    avail,
    opts.baseFontSize,
    opts.showLinks,
    false,
    opts.baseFontSize * 1.36
  );
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

function drawPre(
  p: Painter,
  blk: Extract<HtmlBlock, { kind: "pre" }>,
  opts: RenderOpts
): void {
  const size = monoSize(opts.baseFontSize * 0.96);
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

function columnWidths(p: Painter, rows: string[][], ncols: number, size: number): number[] {
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
  blk: Extract<HtmlBlock, { kind: "table" }>,
  opts: RenderOpts
): void {
  const rows = blk.grid;
  if (rows.length === 0) return;
  const ncols = Math.max(1, ...rows.map((r) => r.length));
  const size = opts.baseFontSize * 0.82;
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

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

export interface HtmlRenderOpts {
  pageSize: "a4" | "letter";
  margin: "normal" | "narrow";
  /** body pt (small 10 / normal 11 / large 12.5). */
  baseFontSize: number;
  /** append link hrefs footnote-style after their text. */
  showLinks: boolean;
}

export interface HtmlRenderReport {
  pages: number;
}

/**
 * Paint the whole document into `pdfDoc` (pages added as needed).
 * `fonts` must already be embedded (the base-14 set OR the Noto
 * subset); bold/italic/mono honestly fall back to the single face in
 * Noto mode.
 */
export function drawHtmlPdf(
  pdfDoc: PDFDocument,
  fonts: HtmlFontSet,
  doc: ParsedHtml,
  opts: HtmlRenderOpts
): HtmlRenderReport {
  const p = new Painter(
    pdfDoc,
    fonts,
    opts.pageSize === "letter" ? "letter" : "a4",
    opts.margin === "narrow" ? "narrow" : "normal",
    Math.min(14, Math.max(8, opts.baseFontSize))
  );
  for (const blk of doc.blocks) {
    switch (blk.kind) {
      case "heading":
        drawHeading(p, blk, opts);
        break;
      case "para":
        drawPara(p, blk, opts);
        break;
      case "list-item":
        drawListItem(p, blk, opts);
        break;
      case "quote":
        drawQuote(p, blk, opts);
        break;
      case "rule":
        drawRule(p);
        break;
      case "pre":
        drawPre(p, blk, opts);
        break;
      case "table":
        drawTable(p, blk, opts);
        break;
      default:
        break;
    }
  }
  return { pages: p.pages.length };
}
