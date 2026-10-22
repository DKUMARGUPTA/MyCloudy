/**
 * Publisher to PDF renderer (RB4-e) — the vector page painter.
 *
 * Extracted so the worker and the smoke script drive the EXACT drawing
 * code headless in bun (create-resume / word-to-pdf precedent): same
 * geometry, same wrap math, same pagination.
 *
 *  - A4 595.28×841.89 (or US Letter 612×792), 56 pt margins (28 pt
 *    narrow option). Body size is the worker option (8–18 pt, default
 *    10.5) with 1.43× leading.
 *  - Headings are HONEST HEURISTICS (see model.ts): the sizes come from
 *    fixed multipliers of the base size — Title 1.9×, Heading1 1.5×,
 *    Heading2 1.22× — because .pub story records do not expose reliable
 *    size data. Bold is used when the Helvetica path is active; the
 *    Noto Devanagari face ships Regular only (hierarchy from size).
 *  - Wrapping: greedy word wrap with danda-aware break points and
 *    cluster-safe hard splits for overlong words (combining marks and
 *    ZWJ/ZWNJ are never stranded) — the txt-to-pdf discipline.
 *  - Every glyph is drawText — REAL selectable text. Publication
 *    images/shapes/columns are NEVER drawn (honest limit, config.ts).
 *
 * Fonts arrive already embedded (worker): `font` is either the
 * non-embedded base-14 Helvetica (pure-WinAnsi docs) or the Noto
 * Devanagari subset; `boldFont` may be null — headings then fall back
 * to the regular face.
 */

import type { PDFDocument, PDFFont, PDFPage } from "pdf-lib";
import { rgb, type RGB } from "pdf-lib";

import { HEADING_SCALE, MARGIN_PT, PAGE_SIZES, type ParsedPub, type PubPara } from "./model";

/* ------------------------------------------------------------------ */
/* Geometry + type scale                                                */
/* ------------------------------------------------------------------ */

const BODY_LH_FACTOR = 1.43;
const BODY_AFTER_FACTOR = 0.3; // gap after a body paragraph (× base size)
const HEAD_BEFORE_FACTOR = 0.9; // gap above a heading (× heading size)
const HEAD_AFTER_FACTOR = 0.4; // gap below a heading (× heading size)
const MIN_LINE = 40; // never wrap into a sliver

const COL_TEXT: RGB = rgb(0.09, 0.09, 0.09);

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
/* Word wrap (danda-aware, cluster-safe hard splits)                    */
/* ------------------------------------------------------------------ */

/** Combining marks that must never start a line after a hard split. */
function isCombiningForCut(cp: number): boolean {
  return (
    (cp >= 0x0900 && cp <= 0x0903) || // signs + anusvara/candrabindu
    (cp >= 0x093a && cp <= 0x094f) || // matras
    (cp >= 0x0951 && cp <= 0x0957) || // stress marks
    (cp >= 0x0962 && cp <= 0x0963)
  );
}

function isZeroWidth(cp: number): boolean {
  return cp === 0x200b || cp === 0x200c || cp === 0x200d;
}

/** Splits on whitespace; a danda (। ॥) also ends a fragment. */
function splitWords(text: string): string[] {
  const out: string[] = [];
  for (const w of text.split(/\s+/).filter(Boolean)) {
    let start = 0;
    for (let i = 0; i < w.length; i += 1) {
      const cp = w.charCodeAt(i);
      if (cp === 0x0964 || cp === 0x0965) {
        out.push(w.slice(start, i + 1));
        start = i + 1;
      }
    }
    if (start < w.length) out.push(w.slice(start));
  }
  return out;
}

/**
 * Greedy wrap; overlong single words hard-split cluster-safely. All
 * width probes use the DRAWING face (`bold`) — a bold heading measured
 * with the regular face wraps late and overflows the content width
 * (HelveticaBold runs ~5-8% wider per glyph).
 */
function wrapText(
  p: Painter,
  text: string,
  width: number,
  size: number,
  bold: boolean
): string[] {
  const lines: string[] = [];
  const spaceW = p.width(" ", size, bold);
  let cur = "";
  let curW = 0;
  for (const word of splitWords(text)) {
    let piece = word;
    while (p.width(piece, size, bold) > width && piece.length > 1) {
      let cut = piece.length;
      while (
        cut > 1 &&
        p.width(piece.slice(0, cut - 1), size, bold) > width
      ) {
        cut -= 1;
      }
      while (cut > 1 && isCombiningForCut(piece.charCodeAt(cut))) cut -= 1;
      while (cut > 1 && isZeroWidth(piece.charCodeAt(cut - 1))) cut -= 1;
      if (cur) {
        lines.push(cur);
        cur = "";
        curW = 0;
      }
      lines.push(piece.slice(0, cut));
      piece = piece.slice(cut);
    }
    const w = p.width(piece, size, bold);
    const add = cur.length > 0 ? spaceW + w : w;
    if (cur.length > 0 && curW + add > width) {
      lines.push(cur);
      cur = piece;
      curW = w;
    } else {
      cur = cur.length > 0 ? `${cur} ${piece}` : piece;
      curW += add;
    }
  }
  if (cur.length > 0 || lines.length === 0) lines.push(cur);
  return lines;
}

/* ------------------------------------------------------------------ */
/* Paragraph                                                            */
/* ------------------------------------------------------------------ */

function drawPara(p: Painter, para: PubPara, baseSize: number): void {
  const h = para.heading;
  const size = h !== undefined ? baseSize * HEADING_SCALE[h] : baseSize;
  const lh = size * BODY_LH_FACTOR;
  const bold = h !== undefined;

  if (h !== undefined) {
    // keep the heading with at least one following body line
    p.ensure(lh + size * HEAD_AFTER_FACTOR + baseSize * BODY_LH_FACTOR);
    p.y -= size * HEAD_BEFORE_FACTOR;
  }

  const width = Math.max(MIN_LINE, p.contentW);
  const lines = wrapText(p, para.text, width, size, bold);
  for (const ln of lines) {
    p.ensure(lh);
    p.text(ln, p.margin, p.y, size, bold, size);
    p.y -= lh;
  }
  p.y -= h !== undefined ? size * HEAD_AFTER_FACTOR : baseSize * BODY_AFTER_FACTOR;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

export interface PubRenderOpts {
  pageSize: "a4" | "letter";
  margin: "normal" | "narrow";
  /** Body font size in pt (8–18; headings are fixed multipliers). */
  baseSize: number;
}

export interface PubRenderReport {
  pages: number;
}

/**
 * Paint the salvaged story text into `pdfDoc` (pages added as needed).
 * `font` must already be embedded (Helvetica standard OR the Noto
 * subset); `boldFont` may be null — headings then fall back to the
 * regular face (Noto ships Regular only).
 */
export function drawPubPdf(
  pdfDoc: PDFDocument,
  font: PDFFont,
  boldFont: PDFFont | null,
  doc: ParsedPub,
  opts: PubRenderOpts
): PubRenderReport {
  const p = new Painter(
    pdfDoc,
    font,
    boldFont,
    opts.pageSize === "letter" ? "letter" : "a4",
    opts.margin === "narrow" ? "narrow" : "normal"
  );
  const baseSize = Math.min(18, Math.max(8, opts.baseSize));
  for (const para of doc.paras) {
    drawPara(p, para, baseSize);
  }
  return { pages: p.pages.length };
}
