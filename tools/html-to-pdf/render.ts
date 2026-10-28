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
 * R5-b CSS BOX-MODEL SUBSET (blocks with style="…"):
 *  - background rectangles (with border-radius via real bezier arcs —
 *    OUR engine's drawRoundedRectangle, P6-n) drawn UNDER the text,
 *    per-block ink (color), padding insets, and borders as stroked
 *    lines (dashed/dotted via the PDF dash operator). A box that splits
 *    across a page break continues as square-cornered per-line chunks
 *    (no rounded continuation) — the <pre> block precedent.
 *  - text-align shifts every line inside its box; justify is a REAL
 *    last-line-left justify (extra space distributed between words).
 *  - Tables: table-level background under the cells, per-cell
 *    backgrounds/borders/padding/alignment with td/th ← table cascades
 *    for background, colour, alignment and border edges, and the
 *    border-collapse look (adjacent cell rectangles share their edge
 *    position, so the grid never doubles).
 *  - An UNSTYLED document runs the exact pre-R5-b code path — style is
 *    purely additive (byte-identical renders, smoke-locked).
 *
 * Fonts arrive already resolved (worker): `fonts` is either the
 * base-14 Helvetica/Courier set (pure-WinAnsi docs — no FontFile2) or
 * the Noto Devanagari subset for EVERYTHING (Regular only — bold,
 * italic and mono honestly fall back to the one face, hierarchy comes
 * from size alone).
 *
 * P6-n: painted on OUR own engine (CreateContext/CreatePage) through
 * the shared converter faces (ConvertFace — std keys or the embedded
 * ttf); widthOfTextAtSize became faceWidth so wraps/pagination stay
 * identical by construction, and the rounded boxes ride the engine's
 * drawRoundedRectangle (operator-parity with pdf-lib's drawSvgPath
 * rounded-rect shape — probed in scripts/dev/probe-svgpath-*.ts).
 */

import type { CreateContext, CreatePage } from "@/lib/own/pdf";

import {
  faceOpts,
  faceWidth,
  rgb,
  type ConvertFace,
  type RGB,
} from "../convert-common/face";

import {
  HEADING_SIZES,
  type BorderSide,
  type StyleColor,
  type StyleProps,
  type HtmlBlock,
  type HtmlRun,
  type ParsedHtml,
} from "./model";

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
  resolve(bold: boolean, italic: boolean, mono: boolean): ConvertFace;
}

/* ------------------------------------------------------------------ */
/* Painter                                                              */
/* ------------------------------------------------------------------ */

class Painter {
  readonly pdfDoc: CreateContext;
  readonly fonts: HtmlFontSet;
  readonly pages: CreatePage[] = [];
  readonly pageW: number;
  readonly pageH: number;
  readonly margin: number;
  readonly contentW: number;
  readonly base: number;
  page: CreatePage;
  y!: number;

  constructor(
    pdfDoc: CreateContext,
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

  font(bold: boolean, italic: boolean, m: boolean): ConvertFace {
    return this.fonts.resolve(bold, italic, m);
  }

  width(text: string, size: number, bold: boolean, italic: boolean, m: boolean): number {
    if (!text) return 0;
    return faceWidth(this.pdfDoc, this.font(bold, italic, m), text, size);
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
    this.page.drawText({
      x,
      y: yTop - baseline,
      text: s,
      size,
      ...faceOpts(this.font(bold, italic, m)),
      color,
    });
  }

  /** The underline stroke for <u> and links — a real vector line. */
  underline(x: number, yTop: number, w: number, baseline: number, color: RGB = COL_TEXT): void {
    if (w <= 0) return;
    const y = yTop - baseline - 1.4;
    this.page.drawLine({
      start: { x, y },
      end: { x: x + w, y },
      thickness: 0.6,
      color,
    });
  }

  /** The text-decoration: line-through stroke (R5-b) — above baseline. */
  strike(
    x: number,
    yTop: number,
    w: number,
    baseline: number,
    size: number,
    color: RGB
  ): void {
    if (w <= 0) return;
    const y = yTop - baseline - size * 0.3;
    this.page.drawLine({
      start: { x, y },
      end: { x: x + w, y },
      thickness: 0.6,
      color,
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
  /** R5-b text-decoration: line-through. */
  strike: boolean;
  size: number;
}

interface Line {
  segs: Seg[];
  width: number;
  lh: number;
  /** baseline offset = the largest seg size in the line. */
  maxSeg: number;
  /** R5-b: the line ended at a <br> hard break (justify stops here). */
  hardBreak?: boolean;
}

interface CharStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  mono: boolean;
  strike: boolean;
}

/** R5-b: block-level forces from font-weight/style/text-decoration. */
export interface CharForce {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
}

const FORCE_NONE: CharForce = { bold: false, italic: false, underline: false, strike: false };

function sameSegStyle(a: Seg, b: CharStyle): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.mono === b.mono &&
    a.strike === b.strike
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
  force: CharForce
): Item[] {
  let merged = "";
  const styles: CharStyle[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const isLink = r.link !== undefined && r.link !== "";
    for (const ch of r.text) {
      merged += ch;
      styles.push({
        bold: r.bold || force.bold,
        italic: r.italic || force.italic,
        underline: r.underline || isLink || force.underline,
        mono: r.mono,
        strike: force.strike,
      });
    }
    if (isLink && showLinks) {
      for (const ch of ` (${r.link})`) {
        merged += ch;
        styles.push({
          bold: false,
          italic: false,
          underline: false,
          mono: false,
          strike: false,
        });
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
        styles[e].mono === styles[s].mono &&
        styles[e].strike === styles[s].strike
      ) {
        e += 1;
      }
      segs.push({
        text: merged.slice(s, e),
        bold: styles[s].bold,
        italic: styles[s].italic,
        underline: styles[s].underline,
        mono: styles[s].mono,
        strike: styles[s].strike,
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
  force: CharForce,
  baseLH: number
): Line[] {
  const items = paraItems(runs, base, showLinks, force);
  const lines: Line[] = [];
  let segs: Seg[] = [];
  let lineW = 0;
  let maxSeg = 0;

  const flush = (hardBreak = false): void => {
    lines.push({
      segs,
      width: lineW,
      lh: Math.max(baseLH, maxSeg * 1.32),
      maxSeg: Math.max(maxSeg, 1),
      hardBreak: hardBreak || undefined,
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
      flush(true);
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

type TextAlign = "left" | "center" | "right" | "justify";

/** per-line x shift for left/center/right alignment inside `width`. */
function lineShift(align: TextAlign, ln: Line, width: number): number {
  if (align === "center") return (width - ln.width) / 2;
  if (align === "right") return width - ln.width;
  return 0;
}

/** draw a laid-out line's segs at x (the unstyled pre-R5-b loop). */
function drawSegs(p: Painter, ln: Line, x: number, color: RGB): void {
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
          ln.maxSeg,
          color
        );
      }
      if (seg.strike) {
        p.strike(
          cx,
          p.y,
          p.width(seg.text, seg.size, seg.bold, seg.italic, seg.mono),
          ln.maxSeg,
          seg.size,
          color
        );
      }
    }
    cx += p.width(seg.text, seg.size, seg.bold, seg.italic, seg.mono);
  }
}

/**
 * REAL last-line-left justify (R5-b): every line except the last and
 * except <br>-forced lines has (width - lineW) distributed evenly
 * between its word gaps. Underline/strike draw per word piece (the
 * gaps between words stay bare — honest).
 */
function drawJustifiedSegs(p: Painter, ln: Line, x: number, width: number, color: RGB): void {
  const words: { text: string; seg: Seg }[] = [];
  for (const seg of ln.segs) {
    for (const piece of seg.text.split(" ")) {
      if (piece !== "") words.push({ text: piece, seg });
    }
  }
  const gaps = words.length - 1;
  if (gaps < 1 || width - ln.width <= 0) {
    drawSegs(p, ln, x, color);
    return;
  }
  const extra = (width - ln.width) / gaps;
  let cx = x;
  for (let i = 0; i < words.length; i++) {
    const { text, seg } = words[i];
    p.text(text, cx, p.y, seg.size, seg.bold, seg.italic, seg.mono, ln.maxSeg, color);
    const ww = p.width(text, seg.size, seg.bold, seg.italic, seg.mono);
    if (seg.underline) p.underline(cx, p.y, ww, ln.maxSeg, color);
    if (seg.strike) p.strike(cx, p.y, ww, ln.maxSeg, seg.size, color);
    cx += ww;
    if (i < gaps) {
      const next = words[i + 1].seg;
      const spaceW = p.width(" ", next.size, next.bold, next.italic, next.mono);
      cx += spaceW + extra;
    }
  }
}

function drawTextLines(
  p: Painter,
  runs: HtmlRun[],
  x: number,
  width: number,
  baseLH: number,
  forceBold: boolean,
  opts: RenderOpts,
  color: RGB,
  align: TextAlign = "left"
): number {
  const lines = layoutLines(
    p,
    runs,
    width,
    opts.baseFontSize,
    opts.showLinks,
    { bold: forceBold, italic: false, underline: false, strike: false },
    baseLH
  );
  for (const ln of lines) {
    p.ensure(ln.lh);
    let cx = x;
    if (align === "justify" && ln !== lines[lines.length - 1] && !ln.hardBreak) {
      drawJustifiedSegs(p, ln, x, width, color);
    } else {
      cx += lineShift(align, ln, width);
      drawSegs(p, ln, cx, color);
    }
    p.y -= ln.lh;
  }
  return lines.length;
}

type RenderOpts = HtmlRenderOpts;

/* ------------------------------------------------------------------ */
/* R5-b style machinery: boxes, edges, alignment                        */
/* ------------------------------------------------------------------ */

function toRGB(c: StyleColor): RGB {
  return rgb(c[0], c[1], c[2]);
}

/** resolved border edge for drawing. */
interface BEdge {
  width: number;
  color: RGB;
  dash?: number[];
}

function resolveEdge(e: BorderSide | undefined, ink: RGB): BEdge | undefined {
  if (e === undefined) return undefined;
  return {
    width: e.width,
    color: e.color !== undefined ? toRGB(e.color) : ink,
    dash: e.style === "dashed" ? [3, 2] : e.style === "dotted" ? [0.9, 1.6] : undefined,
  };
}

interface BoxEdges {
  top?: BEdge;
  right?: BEdge;
  bottom?: BEdge;
  left?: BEdge;
}

function colorEq(a: RGB | undefined, b: RGB | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

function resolveEdges(st: StyleProps, ink: RGB): BoxEdges {
  return {
    top: resolveEdge(st.borderTop, ink),
    right: resolveEdge(st.borderRight, ink),
    bottom: resolveEdge(st.borderBottom, ink),
    left: resolveEdge(st.borderLeft, ink),
  };
}

function edgesPresent(e: BoxEdges): boolean {
  return e.top !== undefined || e.right !== undefined || e.bottom !== undefined || e.left !== undefined;
}

function edgeLine(
  p: Painter,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  e: BEdge
): void {
  p.page.drawLine({
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    thickness: e.width,
    color: e.color,
    dashArray: e.dash,
  });
}

/**
 * Single-page box chrome: the background fill (rounded via real bezier
 * arcs when radius > 0) plus borders. Uniform borders on a rounded box
 * stroke the same rounded path; asymmetric per-side borders draw as
 * straight inset lines (the corners stay square — honest fallback).
 */
function drawBoxChrome(
  p: Painter,
  x: number,
  yTop: number,
  w: number,
  h: number,
  bg: RGB | undefined,
  edges: BoxEdges,
  radius: number,
  ink: RGB
): void {
  const uniform =
    edges.top !== undefined &&
    edges.right !== undefined &&
    edges.bottom !== undefined &&
    edges.left !== undefined &&
    edges.top.width === edges.right.width &&
    edges.top.width === edges.bottom.width &&
    edges.top.width === edges.left.width &&
    colorEq(edges.top.color, edges.right.color) &&
    colorEq(edges.top.color, edges.bottom.color) &&
    colorEq(edges.top.color, edges.left.color) &&
    edges.top.dash === undefined &&
    edges.right.dash === undefined &&
    edges.bottom.dash === undefined &&
    edges.left.dash === undefined;
  const borderColor = edges.top?.color ?? ink;
  if (radius > 0) {
    if (uniform && edgesPresent(edges)) {
      p.page.drawRoundedRectangle({
        x,
        yTop,
        width: w,
        height: h,
        radius,
        ...(bg !== undefined ? { color: bg } : {}),
        borderColor,
        borderWidth: edges.top?.width ?? 1,
      });
      return;
    }
    if (bg !== undefined) {
      p.page.drawRoundedRectangle({ x, yTop, width: w, height: h, radius, color: bg });
    }
  } else if (bg !== undefined) {
    p.page.drawRectangle({ x, y: yTop - h, width: w, height: h, color: bg });
  }
  if (!edgesPresent(edges)) return;
  if (uniform && radius <= 0) {
    p.page.drawRectangle({
      x,
      y: yTop - h,
      width: w,
      height: h,
      borderColor,
      borderWidth: edges.top?.width ?? 1,
    });
    return;
  }
  // per-side straight edges, inset so the stroke sits INSIDE the box
  const t = edges.top;
  if (t) edgeLine(p, x, yTop - t.width / 2, x + w, yTop - t.width / 2, t);
  const b = edges.bottom;
  if (b) edgeLine(p, x, yTop - h + b.width / 2, x + w, yTop - h + b.width / 2, b);
  const l = edges.left;
  if (l) edgeLine(p, x + l.width / 2, yTop, x + l.width / 2, yTop - h, l);
  const r = edges.right;
  if (r) edgeLine(p, x + w - r.width / 2, yTop, x + w - r.width / 2, yTop - h, r);
}

interface StyledBlockCfg {
  /** spacing above the box (heading spec.before) — outside the box. */
  before: number;
  /** spacing below the box — outside. */
  after: number;
  baseLH: number;
  forceBold: boolean;
  /** default ink for the block kind (COL_TEXT / COL_MUTED). */
  ink: RGB;
  /** left edge of the box (margin / list text / quote indent). */
  xBase: number;
  /** unstyled wrap width available at xBase. */
  width: number;
  /** list marker drawn beside the box (outside it). */
  marker?: { text: string; x: number; size: number };
  /** blockquote accent bar beside the box. */
  quoteBar?: boolean;
}

/**
 * The styled text block (R5-b): resolves the box, lays the lines out
 * inside padding, draws background + borders under/around them, honors
 * text-align (justify = real last-line-left) and the block ink. A box
 * that does not fit the page fragments as square per-line chunks
 * (the <pre> precedent) — rounded corners only apply to unsplit boxes.
 */
function drawStyledTextBlock(
  p: Painter,
  runs: HtmlRun[],
  st: StyleProps,
  opts: RenderOpts,
  cfg: StyledBlockCfg
): void {
  const align: TextAlign = st.textAlign ?? "left";
  const ink = st.color !== undefined ? toRGB(st.color) : cfg.ink;
  const force: CharForce = {
    bold: st.bold !== undefined ? st.bold : cfg.forceBold,
    italic: st.italic === true,
    underline: st.underline === true,
    strike: st.lineThrough === true,
  };
  const padL = st.paddingLeft ?? 0;
  const padR = st.paddingRight ?? 0;
  const padT = st.paddingTop ?? 0;
  const padB = st.paddingBottom ?? 0;
  // width (px/%) shrinks the box, capped honestly at the available width
  const boxW = Math.max(
    MIN_LINE,
    Math.min(
      cfg.width,
      st.widthPt !== undefined
        ? st.widthPt
        : st.widthPct !== undefined
          ? st.widthPct * p.contentW
          : cfg.width
    )
  );
  const innerW = Math.max(MIN_LINE, boxW - padL - padR);
  const lines = layoutLines(
    p,
    runs,
    innerW,
    opts.baseFontSize,
    opts.showLinks,
    force,
    cfg.baseLH
  );
  if (lines.length === 0) return;

  if (cfg.before > 0) {
    p.ensure(cfg.before + padT + lines[0].lh + 6);
    p.y -= cfg.before;
  }

  const bg = st.backgroundColor !== undefined ? toRGB(st.backgroundColor) : undefined;
  const edges = resolveEdges(st, ink);
  const radius = st.radius ?? 0;
  const hasChrome =
    bg !== undefined || edgesPresent(edges) || padT + padR + padB + padL > 0 || radius > 0;

  const drawLine = (ln: Line, idx: number, last: boolean): void => {
    if (cfg.marker !== undefined && idx === 0) {
      p.text(cfg.marker.text, cfg.marker.x, p.y, cfg.marker.size, false, false, false, ln.maxSeg);
    }
    if (cfg.quoteBar === true) {
      const barX = p.margin + QUOTE_BAR_X;
      p.page.drawLine({
        start: { x: barX, y: p.y - ln.lh },
        end: { x: barX, y: p.y },
        thickness: QUOTE_BAR_W,
        color: COL_BAR,
      });
    }
    if (align === "justify" && !last && !ln.hardBreak) {
      drawJustifiedSegs(p, ln, cfg.xBase + padL, innerW, ink);
    } else {
      drawSegs(p, ln, cfg.xBase + padL + lineShift(align, ln, innerW), ink);
    }
  };

  if (!hasChrome) {
    for (let i = 0; i < lines.length; i++) {
      p.ensure(lines[i].lh);
      drawLine(lines[i], i, i === lines.length - 1);
      p.y -= lines[i].lh;
    }
    p.y -= cfg.after;
    return;
  }

  const boxH = padT + lines.reduce((a, ln) => a + ln.lh, 0) + padB;
  if (p.y - p.margin >= boxH) {
    // whole box on one page — rounded corners allowed
    const boxTop = p.y;
    drawBoxChrome(p, cfg.xBase, boxTop, boxW, boxH, bg, edges, radius, ink);
    p.y = boxTop - padT;
    for (let i = 0; i < lines.length; i++) {
      drawLine(lines[i], i, i === lines.length - 1);
      p.y -= lines[i].lh;
    }
    p.y -= padB;
  } else {
    // fragmented box: square per-line chunks that continue across pages
    let started = false;
    for (let i = 0; i < lines.length; i++) {
      const last = i === lines.length - 1;
      const ln = lines[i];
      const extraTop = started ? 0 : padT;
      p.ensure(ln.lh + extraTop + (last ? padB : 0));
      if (!started) {
        p.y -= padT;
        const top = edges.top;
        if (top) edgeLine(p, cfg.xBase, p.y + padT - top.width / 2, cfg.xBase + boxW, p.y + padT - top.width / 2, top);
        started = true;
      }
      if (bg !== undefined) {
        // the first chunk's fill reaches up through the top padding
        p.page.drawRectangle({
          x: cfg.xBase,
          y: p.y - ln.lh,
          width: boxW,
          height: ln.lh + extraTop,
          color: bg,
        });
      }
      const l = edges.left;
      if (l) edgeLine(p, cfg.xBase + l.width / 2, p.y + extraTop, cfg.xBase + l.width / 2, p.y - ln.lh, l);
      const r = edges.right;
      if (r) edgeLine(p, cfg.xBase + boxW - r.width / 2, p.y + extraTop, cfg.xBase + boxW - r.width / 2, p.y - ln.lh, r);
      drawLine(ln, i, last);
      p.y -= ln.lh;
      if (last) {
        if (bg !== undefined) {
          p.page.drawRectangle({
            x: cfg.xBase,
            y: p.y,
            width: boxW,
            height: padB,
            color: bg,
          });
        }
        const b = edges.bottom;
        if (b) edgeLine(p, cfg.xBase, p.y + b.width / 2, cfg.xBase + boxW, p.y + b.width / 2, b);
        p.y -= padB;
      }
    }
  }
  p.y -= cfg.after;
}

function drawHeading(
  p: Painter,
  blk: Extract<HtmlBlock, { kind: "heading" }>,
  opts: RenderOpts
): void {
  const spec = headingSpec(blk.level, opts.baseFontSize);
  if (blk.style !== undefined) {
    drawStyledTextBlock(p, blk.runs, blk.style, opts, {
      before: spec.before,
      after: spec.after,
      baseLH: spec.lh,
      forceBold: true,
      ink: COL_TEXT,
      xBase: p.margin,
      width: Math.max(MIN_LINE, p.contentW),
    });
    return;
  }
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
  if (blk.style !== undefined) {
    drawStyledTextBlock(p, blk.runs, blk.style, opts, {
      before: 0,
      after: PARA_AFTER,
      baseLH: opts.baseFontSize * 1.36,
      forceBold: false,
      ink: COL_TEXT,
      xBase: p.margin,
      width: Math.max(MIN_LINE, p.contentW),
    });
    return;
  }
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

  if (blk.style !== undefined) {
    drawStyledTextBlock(p, blk.runs, blk.style, opts, {
      before: 0,
      after: BULLET_AFTER,
      baseLH: opts.baseFontSize * 1.36,
      forceBold: false,
      ink: COL_TEXT,
      xBase: textX,
      width: avail,
      marker: { text: marker, x: markerX, size: markerSize },
    });
    return;
  }

  const lines = layoutLines(
    p,
    blk.runs,
    avail,
    opts.baseFontSize,
    opts.showLinks,
    FORCE_NONE,
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
        if (seg.strike) {
          p.strike(
            cx,
            p.y,
            p.width(seg.text, seg.size, seg.bold, seg.italic, seg.mono),
            ln.maxSeg,
            seg.size,
            COL_TEXT
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
  if (blk.style !== undefined) {
    drawStyledTextBlock(p, blk.runs, blk.style, opts, {
      before: 0,
      after: PARA_AFTER,
      baseLH: opts.baseFontSize * 1.36,
      forceBold: false,
      ink: COL_MUTED,
      xBase: textX,
      width: avail,
      quoteBar: true,
    });
    return;
  }
  const lines = layoutLines(
    p,
    blk.runs,
    avail,
    opts.baseFontSize,
    opts.showLinks,
    FORCE_NONE,
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
  const st = blk.style;
  const padL = st?.paddingLeft ?? 0;
  const padR = st?.paddingRight ?? 0;
  const padT = st?.paddingTop ?? 0;
  const padB = st?.paddingBottom ?? 0;
  const ink = st?.color !== undefined ? toRGB(st.color) : COL_TEXT;
  const bg = st?.backgroundColor !== undefined ? toRGB(st.backgroundColor) : COL_PRE_BG;
  const inner = Math.max(MIN_LINE, p.contentW - PRE_PAD * 2 - padL - padR);
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
  p.ensure(lh + PRE_PAD + padT);
  p.y -= PRE_PAD + padT;
  const edges = st !== undefined ? resolveEdges(st, ink) : {};
  let preStarted = false;
  for (const line of lines) {
    p.ensure(lh);
    // the background rect follows its line onto continuation pages
    p.page.drawRectangle({
      x: p.margin,
      y: p.y - lh,
      width: p.contentW,
      height: lh,
      color: bg,
    });
    if (edges.left) {
      edgeLine(p, p.margin + edges.left.width / 2, p.y, p.margin + edges.left.width / 2, p.y - lh, edges.left);
    }
    if (edges.right) {
      edgeLine(
        p,
        p.margin + p.contentW - edges.right.width / 2,
        p.y,
        p.margin + p.contentW - edges.right.width / 2,
        p.y - lh,
        edges.right
      );
    }
    if (!preStarted) {
      preStarted = true;
      const top = edges.top;
      if (top) edgeLine(p, p.margin, p.y + PRE_PAD - top.width / 2, p.margin + p.contentW, p.y + PRE_PAD - top.width / 2, top);
    }
    if (line) {
      const lw = p.width(line, size, false, false, true);
      const align = st?.textAlign;
      const shift =
        align === "center"
          ? (inner - lw) / 2
          : align === "right"
            ? inner - lw
            : 0;
      p.text(line, p.margin + PRE_PAD + padL + shift, p.y, size, false, false, true, size, ink);
    }
    p.y -= lh;
  }
  if (edges.bottom) {
    edgeLine(
      p,
      p.margin,
      p.y + PRE_PAD - edges.bottom.width / 2,
      p.margin + p.contentW,
      p.y + PRE_PAD - edges.bottom.width / 2,
      edges.bottom
    );
  }
  p.y -= PRE_PAD + padB + PRE_AFTER;
}

function columnWidths(
  p: Painter,
  rows: string[][],
  ncols: number,
  size: number,
  targetW: number = p.contentW
): number[] {
  const natural = new Array<number>(ncols).fill(0);
  const minWord = new Array<number>(ncols).fill(TABLE_MIN_COL);
  for (const row of rows) {
    for (let c = 0; c < ncols; c++) {
      const cell = row[c] ?? "";
      const full = p.width(cell, size, false, false, false);
      if (full > natural[c]) natural[c] = Math.min(full, targetW);
      for (const word of cell.split(/\s+/)) {
        const w = p.width(word, size, false, false, false) + TABLE_PAD * 2;
        if (w > minWord[c]) minWord[c] = Math.min(w, targetW);
      }
    }
  }
  const ideal = natural.map((n, c) =>
    Math.max(Math.min(n, targetW), minWord[c], TABLE_MIN_COL)
  );
  const sum = ideal.reduce((a, b) => a + b, 0);
  // fit to the printable width (the excel-to-pdf pattern)
  if (sum <= 0) return ideal;
  const scale = targetW / sum;
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
  const tstyle = blk.style;
  const styled = tstyle !== undefined || blk.cellStyles !== undefined;

  // table box: width (px/% via style or the legacy width attribute) and
  // legacy align position the grid; default fills the printable width
  let tableX = p.margin;
  let tableW = p.contentW;
  if (tstyle !== undefined) {
    if (tstyle.widthPt !== undefined || tstyle.widthPct !== undefined) {
      tableW = Math.max(
        60,
        Math.min(
          p.contentW,
          tstyle.widthPt !== undefined
            ? tstyle.widthPt
            : (tstyle.widthPct ?? 1) * p.contentW
        )
      );
      if (tstyle.tableAlign === "center") {
        tableX = p.margin + (p.contentW - tableW) / 2;
      } else if (tstyle.tableAlign === "right") {
        tableX = p.margin + p.contentW - tableW;
      }
    }
  }
  const widths = columnWidths(p, rows, ncols, size, tableW);
  const boldRow = blk.headerRow === true;
  const tableBg = tstyle?.backgroundColor !== undefined ? toRGB(tstyle.backgroundColor) : undefined;
  const tableInk = tstyle?.color !== undefined ? toRGB(tstyle.color) : undefined;
  const tableAlign = tstyle?.textAlign;
  const tableEdges =
    tstyle !== undefined ? resolveEdges(tstyle, tableInk ?? COL_TEXT) : {};

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
    const cellSty = blk.cellStyles?.[ri] ?? [];
    // resolved per-cell values BEFORE measuring (padding affects wraps)
    const cells = row.map((_, c) => {
      const cs = cellSty[c];
      return {
        padL: cs?.paddingLeft ?? 0,
        padR: cs?.paddingRight ?? 0,
        padT: cs?.paddingTop ?? 0,
        padB: cs?.paddingBottom ?? 0,
        bold: cs?.bold !== undefined ? cs.bold : isHeader,
        italic: cs?.italic === true,
        ink: cs?.color !== undefined ? toRGB(cs.color) : tableInk,
        bg: cs?.backgroundColor !== undefined ? toRGB(cs.backgroundColor) : undefined,
        align: cs?.textAlign ?? tableAlign ?? "left",
        edges: cs !== undefined ? resolveEdges(cs, cs.color !== undefined ? toRGB(cs.color) : tableInk ?? COL_TEXT) : {},
      };
    });
    const cellLines = row.map(
      (cell, c) =>
        layoutPlain(p, cell, widths[c] - TABLE_PAD * 2 - cells[c].padL - cells[c].padR, size, cells[c].bold).slice(0, 60)
    );
    let rowLines = 1;
    for (const lines of cellLines) rowLines = Math.max(rowLines, lines.length);
    const rowH = rowLines * lh + TABLE_PAD * 2 + Math.max(...cells.map((c) => c.padT + c.padB), 0);
    p.ensure(rowH);
    // table-level background paints UNDER every cell of the row chunk
    if (tableBg !== undefined) {
      p.page.drawRectangle({
        x: tableX,
        y: p.y - rowH,
        width: tableW,
        height: rowH,
        color: tableBg,
      });
    }
    let x = tableX;
    for (let c = 0; c < ncols; c++) {
      const w = widths[c];
      const cell = cells[c];
      if (isHeader) {
        p.page.drawRectangle({
          x,
          y: p.y - rowH,
          width: w,
          height: rowH,
          color: COL_HEADER_FILL,
        });
      }
      if (cell.bg !== undefined) {
        if (cellSty[c]?.radius) {
          // rounded cell FILL only — cell borders stay square (collapse)
          p.page.drawRoundedRectangle({
            x,
            yTop: p.y,
            width: w,
            height: rowH,
            radius: cellSty[c]?.radius ?? 0,
            color: cell.bg,
          });
        } else {
          p.page.drawRectangle({
            x,
            y: p.y - rowH,
            width: w,
            height: rowH,
            color: cell.bg,
          });
        }
      }
      // border-collapse look: cell edges draw on the shared rectangle
      // boundary, cascading cell ← table; no edges anywhere → the
      // default 0.5pt hairline (the unstyled table look)
      const cTop = cell.edges.top ?? tableEdges.top;
      const cRight = cell.edges.right ?? tableEdges.right;
      const cBottom = cell.edges.bottom ?? tableEdges.bottom;
      const cLeft = cell.edges.left ?? tableEdges.left;
      const anyEdge =
        cTop !== undefined || cRight !== undefined || cBottom !== undefined || cLeft !== undefined;
      const uniform =
        anyEdge &&
        cTop !== undefined &&
        cRight !== undefined &&
        cBottom !== undefined &&
        cLeft !== undefined &&
        cTop.width === cRight.width &&
        cTop.width === cBottom.width &&
        cTop.width === cLeft.width &&
        colorEq(cTop.color, cRight.color) &&
        colorEq(cTop.color, cBottom.color) &&
        colorEq(cTop.color, cLeft.color) &&
        cTop.dash === undefined &&
        cRight.dash === undefined &&
        cBottom.dash === undefined &&
        cLeft.dash === undefined;
      if (anyEdge && uniform) {
        p.page.drawRectangle({
          x,
          y: p.y - rowH,
          width: w,
          height: rowH,
          borderColor: cTop.color,
          borderWidth: cTop.width,
        });
      } else if (anyEdge) {
        if (cTop) edgeLine(p, x, p.y - cTop.width / 2, x + w, p.y - cTop.width / 2, cTop);
        if (cBottom) edgeLine(p, x, p.y - rowH + cBottom.width / 2, x + w, p.y - rowH + cBottom.width / 2, cBottom);
        if (cLeft) edgeLine(p, x + cLeft.width / 2, p.y, x + cLeft.width / 2, p.y - rowH, cLeft);
        if (cRight) edgeLine(p, x + w - cRight.width / 2, p.y, x + w - cRight.width / 2, p.y - rowH, cRight);
      } else {
        p.page.drawRectangle({
          x,
          y: p.y - rowH,
          width: w,
          height: rowH,
          borderColor: COL_BORDER,
          borderWidth: 0.5,
        });
      }
      const lines = cellLines[c] ?? [];
      let ty = p.y - TABLE_PAD - cell.padT;
      for (const line of lines) {
        if (line) {
          const lw = p.width(line, size, cell.bold, cell.italic, false);
          const inner = w - TABLE_PAD * 2 - cell.padL - cell.padR;
          const shift =
            cell.align === "center"
              ? (inner - lw) / 2
              : cell.align === "right"
                ? inner - lw
                : 0;
          p.text(
            line,
            x + TABLE_PAD + cell.padL + shift,
            ty,
            size,
            cell.bold,
            cell.italic,
            false,
            size,
            cell.ink ?? COL_TEXT
          );
        }
        ty -= lh;
      }
      x += w;
    }
    // table-level border: the outer frame, fragmented per row so it
    // continues across pages correctly (top edge only on the first row)
    const hasTableFrame =
      tableEdges.top !== undefined ||
      tableEdges.right !== undefined ||
      tableEdges.bottom !== undefined ||
      tableEdges.left !== undefined;
    if (styled && hasTableFrame) {
      const e = tableEdges.top;
      if (e && ri === 0) {
        edgeLine(p, tableX, p.y - e.width / 2, tableX + tableW, p.y - e.width / 2, e);
      }
      const l = tableEdges.left;
      if (l) edgeLine(p, tableX + l.width / 2, p.y, tableX + l.width / 2, p.y - rowH, l);
      const r = tableEdges.right;
      if (r) edgeLine(p, tableX + tableW - r.width / 2, p.y, tableX + tableW - r.width / 2, p.y - rowH, r);
      if (ri === rows.length - 1) {
        const b = tableEdges.bottom;
        if (b) edgeLine(p, tableX, p.y - rowH + b.width / 2, tableX + tableW, p.y - rowH + b.width / 2, b);
      }
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
 * `fonts` must already be resolved (the base-14 set OR the Noto
 * subset); bold/italic/mono honestly fall back to the single face in
 * Noto mode.
 */
export function drawHtmlPdf(
  pdfDoc: CreateContext,
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
