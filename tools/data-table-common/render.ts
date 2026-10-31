/**
 * Data-table renderer (P3-b) — the shared vector table painter for the
 * data → PDF import family (csv-to-pdf, json-to-pdf, xml-to-pdf).
 *
 * Pure OWN-engine drawing (src/lib/own/pdf, P6-m), synchronous by
 * design — the face arrives already picked by the caller (the base-14
 * Helvetica/HelveticaBold pair for WinAnsi content, the embedded Noto
 * Sans Devanagari subset when tablesNeedNoto flipped) — exactly the
 * excel-to-pdf / create-resume contract, so the smoke script drives the
 * very same code headless.
 *
 * Per table (each starts a fresh page):
 *  - title header: 12 pt bold + hairline rule (the file's base name);
 *  - column widths from content (5.6 pt/char heuristic, clamped
 *    [40, 200]), then fit-scaled to the printable width (fit=true
 *    stretches AND shrinks; fit=false only shrinks when too wide);
 *  - optional header row: bold text on a light neutral fill, drawn
 *    again at the top of every continuation page;
 *  - cell text wrapped to the column width (long words char-broken),
 *    row heights from the wrapped line counts, honestly clipped with
 *    an ellipsis when a single row would outgrow a page;
 *  - grid hairlines, optional zebra striping;
 *  - "Page {n} of {m}" footers on every page of every table;
 *  - every glyph is REAL selectable text (drawText).
 *
 * No DOM, no workers, no network — bun-testable pure functions only.
 */

import type { CreateContext, CreatePage, StampFontKey } from "@/lib/own/pdf";

import {
  faceOpts,
  faceWidth,
  rgb,
  type ConvertFace,
  type RGB,
} from "../convert-common/face";
import { isWinAnsiText } from "../excel-to-pdf/model";

/* ------------------------------------------------------------------ */
/* The table model                                                      */
/* ------------------------------------------------------------------ */

/** One renderable table: a title, optional header labels, data rows. */
export interface DataTable {
  /** Table heading — the input file's base name (or a record label). */
  title: string;
  /** Column labels; [] → header-less table (plain grid). */
  header: string[];
  rows: string[][];
}

/** Page geometry options (the excel-to-pdf pair). */
export type TablePageSize = "a4" | "letter";
export type TableOrientation = "portrait" | "landscape";

export interface TableRenderOpts {
  pageSize: TablePageSize;
  orientation: TableOrientation;
  /** true → scale the table to exactly fill the page width. */
  fit: boolean;
  /** optional zebra striping for data rows. */
  zebra?: boolean;
  /** footer template containing {n} and {m}; default "Page {n} of {m}". */
  footerFmt?: string;
}

export interface TableRenderReport {
  pages: number;
}

/* ------------------------------------------------------------------ */
/* Geometry + palette (the excel-to-pdf proven values)                  */
/* ------------------------------------------------------------------ */

const PAGE_SIZES: Record<TablePageSize, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

const MARGIN_X = 40;
/** title baseline sits 34 pt below the top edge */
const TITLE_DROP = 34;
/** table starts 54 pt below the top edge (title + rule + gap) */
const TABLE_TOP_DROP = 54;
const BOTTOM = 56;
const FOOTER_Y = 24;

const BODY_SIZE = 9;
const HEADER_SIZE = 9;
const TITLE_SIZE = 12;
const FOOTER_SIZE = 8;
const LINE_H = 11;
/** pad(3) + ascent(≈7) — the first baseline drop inside a row */
const FIRST_BASELINE = 10;
const ROW_PAD = 6;

const MIN_COL_PT = 40;
const MAX_COL_PT = 200;

const COL_TEXT: RGB = rgb(0.08, 0.08, 0.08);
const COL_MUTED: RGB = rgb(0.4, 0.4, 0.4);
const COL_GRID: RGB = rgb(0.78, 0.78, 0.78);
const COL_GRID_STRONG: RGB = rgb(0.55, 0.55, 0.55);
const COL_HEADER_FILL: RGB = rgb(0.9, 0.91, 0.92);
const COL_ZEBRA: RGB = rgb(0.955, 0.955, 0.96);

/* ------------------------------------------------------------------ */
/* Font need detection                                                  */
/* ------------------------------------------------------------------ */

/**
 * true → the renderer must embed the self-hosted Noto Sans Devanagari
 * (any non-WinAnsi cell — Devanagari, ₹, CJK …); false → pure-WinAnsi
 * content stays on the base-14 Helvetica pair (nothing embedded).
 */
export function tablesNeedNoto(tables: DataTable[]): boolean {
  for (const table of tables) {
    if (!isWinAnsiText(table.title)) return true;
    for (const label of table.header) {
      if (label !== "" && !isWinAnsiText(label)) return true;
    }
    for (const row of table.rows) {
      for (const cell of row) {
        if (cell !== "" && !isWinAnsiText(cell)) return true;
      }
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                         */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Column widths                                                        */
/* ------------------------------------------------------------------ */

/**
 * Natural column widths in pt from content length: ~5.6 pt per char at
 * 9 pt body size + padding, clamped to [40, 200] — the excel-to-pdf
 * heuristic, applied to plain string grids (header labels included).
 */
export function computeTableColumnWidths(table: DataTable): number[] {
  const ncols = table.header.length ||
    table.rows.reduce((m, row) => Math.max(m, row.length), 0);
  if (ncols === 0) return [];
  const widths = new Array<number>(ncols).fill(MIN_COL_PT);
  const grow = (cell: string | undefined, c: number): void => {
    if (cell === undefined) return;
    // only grow for the first 48 chars per column — long cells wrap
    const eff = Math.min(cell.length, 48);
    const w = 10 + eff * 5.6;
    if (w > widths[c]) widths[c] = w;
  };
  for (let c = 0; c < table.header.length && c < ncols; c++) {
    grow(table.header[c], c);
  }
  for (const row of table.rows) {
    for (let c = 0; c < row.length && c < ncols; c++) grow(row[c], c);
  }
  for (let c = 0; c < ncols; c++) {
    widths[c] = Math.min(MAX_COL_PT, Math.max(MIN_COL_PT, widths[c]));
  }
  return widths;
}

/* ------------------------------------------------------------------ */
/* Precomputed table layout                                             */
/* ------------------------------------------------------------------ */

interface RowLayout {
  /** wrapped lines per cell ("" cells → one empty line). */
  cells: string[][];
  height: number;
  /** set at draw time — zebra fill for odd data rows. */
  zebraFill?: boolean;
}

interface TableLayout {
  table: DataTable;
  widths: number[];
  xEnds: number[];
  header: RowLayout | null;
  rows: RowLayout[];
  tableWidth: number;
}

function layoutRow(
  row: string[],
  widths: number[],
  measure: Measure,
  maxLines: number
): RowLayout {
  const cells: string[][] = [];
  let lineCount = 1;
  for (let c = 0; c < widths.length; c++) {
    const cell = row[c] ?? "";
    const inner = widths[c] - 6;
    if (cell === "") {
      cells.push([""]);
      continue;
    }
    const lines = clipLines(
      wrapCellText(cell, inner, BODY_SIZE, measure),
      maxLines,
      inner,
      BODY_SIZE,
      measure
    );
    cells.push(lines);
    if (lines.length > lineCount) lineCount = lines.length;
  }
  return { cells, height: lineCount * LINE_H + ROW_PAD };
}

function layoutTable(
  pdfDoc: CreateContext,
  table: DataTable,
  contentWidth: number,
  contentHeight: number,
  opts: TableRenderOpts,
  font: ConvertFace
): TableLayout {
  const measure: Measure = (text, size) =>
    faceWidth(pdfDoc, font, text, size);

  const natural = computeTableColumnWidths(table);
  const naturalW = natural.reduce((a, b) => a + b, 0);
  const scale =
    naturalW <= 0
      ? 1
      : opts.fit
        ? contentWidth / naturalW
        : Math.min(1, contentWidth / naturalW);
  const widths = natural.map((w) => w * scale);

  const xEnds: number[] = [];
  let acc = 0;
  for (const w of widths) {
    acc += w;
    xEnds.push(acc);
  }
  const tableWidth = acc;

  const hasHeader = table.header.length > 0;
  // 60% page cap on the header row: a monster first row gets honestly
  // ellipsized so at least one data row always fits below it on a
  // fresh page (page-break termination proof)
  const header = hasHeader
    ? layoutRow(
        table.header,
        widths,
        measure,
        Math.max(1, Math.floor((contentHeight * 0.6) / LINE_H))
      )
    : null;
  // worst-case row budget: a fresh page minus the repeated header row
  const usable = contentHeight - (header ? header.height : 0) - 4;
  const maxLines = Math.max(1, Math.floor((usable - ROW_PAD) / LINE_H));

  const rows: RowLayout[] = [];
  for (const row of table.rows) {
    rows.push(layoutRow(row, widths, measure, maxLines));
  }
  return { table, widths, xEnds, header, rows, tableWidth };
}

/* ------------------------------------------------------------------ */
/* Painter                                                              */
/* ------------------------------------------------------------------ */

/** The face for a bold request — std docs promote to the bold key;
 *  the Noto face ships Regular only (faux-bold at draw time). */
function fontFor(
  font: ConvertFace,
  boldKey: StampFontKey | null,
  bold: boolean
): ConvertFace {
  return bold && !font.ttf && boldKey ? { std: boldKey } : font;
}

function drawTextSafe(
  page: CreatePage,
  text: string,
  x: number,
  y: number,
  size: number,
  font: ConvertFace,
  boldKey: StampFontKey | null,
  bold: boolean,
  color: RGB
): void {
  if (text === "") return;
  const face = fontFor(font, boldKey, bold);
  page.drawText({ x, y, text, size, color, ...faceOpts(face) });
  if (bold && (!boldKey || font.ttf)) {
    // Noto ships Regular only — the invoice double-draw faux-bold
    page.drawText({ x: x + 0.3, y, text, size, color, ...faceOpts(face) });
  }
}

function drawRowContent(
  page: CreatePage,
  layout: TableLayout,
  row: RowLayout,
  rowTop: number,
  x0: number,
  font: ConvertFace,
  boldKey: StampFontKey | null,
  headerStyle: boolean
): number {
  // fills first (header fill / zebra)
  if (headerStyle) {
    page.drawRectangle({
      x: x0,
      y: rowTop - row.height,
      width: layout.tableWidth,
      height: row.height,
      color: COL_HEADER_FILL,
    });
  } else if (row.zebraFill) {
    page.drawRectangle({
      x: x0,
      y: rowTop - row.height,
      width: layout.tableWidth,
      height: row.height,
      color: COL_ZEBRA,
    });
  }
  // cell text
  for (let c = 0; c < layout.widths.length; c++) {
    const lines = row.cells[c];
    if (!lines) continue;
    const cx = x0 + (c === 0 ? 0 : layout.xEnds[c - 1]) + 3;
    for (let i = 0; i < lines.length; i++) {
      drawTextSafe(
        page,
        lines[i],
        cx,
        rowTop - FIRST_BASELINE - i * LINE_H,
        headerStyle ? HEADER_SIZE : BODY_SIZE,
        font,
        boldKey,
        headerStyle,
        COL_TEXT
      );
    }
  }
  // row bottom hairline
  page.drawLine({
    start: { x: x0, y: rowTop - row.height },
    end: { x: x0 + layout.tableWidth, y: rowTop - row.height },
    thickness: headerStyle ? 1 : 0.5,
    color: headerStyle ? COL_GRID_STRONG : COL_GRID,
  });
  return rowTop - row.height;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

/**
 * Paints every table into `pdfDoc` (one fresh page per table,
 * continuation pages as the rows demand). Synchronous — the face is
 * caller-picked (base-14 keys or the embedded Noto subset); `boldKey`
 * may be null — the header row then falls back to the regular face
 * with the faux-bold double-draw. Returns the total page count.
 */
export function drawDataTablesPdf(
  pdfDoc: CreateContext,
  font: ConvertFace,
  boldKey: StampFontKey | null,
  tables: DataTable[],
  opts: TableRenderOpts
): TableRenderReport {
  const [pw0, ph0] = PAGE_SIZES[opts.pageSize];
  const pageW = opts.orientation === "landscape" ? ph0 : pw0;
  const pageH = opts.orientation === "landscape" ? pw0 : ph0;
  const x0 = MARGIN_X;
  const contentWidth = pageW - 2 * MARGIN_X;
  const contentHeight = pageH - TABLE_TOP_DROP - BOTTOM;
  const footerFmt = opts.footerFmt ?? "Page {n} of {m}";
  let pagesDrawn = 0;

  for (const table of tables) {
    const layout = layoutTable(
      pdfDoc,
      table,
      contentWidth,
      contentHeight,
      opts,
      font
    );
    const tableTop = pageH - TABLE_TOP_DROP;

    const newPage = (): CreatePage => {
      const page = pdfDoc.addPage(pageW, pageH);
      pagesDrawn++;
      return page;
    };

    // ---- title header (first page of the table) ----
    const page = newPage();
    drawTextSafe(
      page,
      table.title,
      x0,
      pageH - TITLE_DROP,
      TITLE_SIZE,
      font,
      boldKey,
      true,
      COL_TEXT
    );
    page.drawLine({
      start: { x: x0, y: pageH - TITLE_DROP - 8 },
      end: { x: x0 + contentWidth, y: pageH - TITLE_DROP - 8 },
      thickness: 0.75,
      color: COL_GRID_STRONG,
    });

    let y = tableTop;
    let pageTopY = tableTop;
    const pages: CreatePage[] = [page];
    let pageIdx = 0;
    let justBroke = false;

    const finishPage = (): void => {
      const p = pages[pageIdx];
      // table top border
      p.drawLine({
        start: { x: x0, y: pageTopY },
        end: { x: x0 + layout.tableWidth, y: pageTopY },
        thickness: 0.75,
        color: COL_GRID,
      });
      // verticals
      for (let c = 0; c <= layout.widths.length; c++) {
        const vx = x0 + (c === 0 ? 0 : layout.xEnds[c - 1]);
        p.drawLine({
          start: { x: vx, y: pageTopY },
          end: { x: vx, y },
          thickness: 0.5,
          color: COL_GRID,
        });
      }
    };

    const drawHeaderRow = (target: CreatePage, top: number): number => {
      if (!layout.header) return top;
      return drawRowContent(
        target,
        layout,
        layout.header,
        top,
        x0,
        font,
        boldKey,
        true
      );
    };

    y = drawHeaderRow(page, y);

    for (let r = 0; r < layout.rows.length; r++) {
      const row = layout.rows[r];
      row.zebraFill = opts.zebra === true && r % 2 === 1;
      if (
        y - row.height < BOTTOM &&
        y < tableTop - 0.5 &&
        !justBroke
      ) {
        finishPage();
        const next = newPage();
        pages.push(next);
        pageIdx++;
        pageTopY = tableTop;
        y = tableTop;
        y = drawHeaderRow(next, y);
        justBroke = true;
      } else {
        justBroke = false;
      }
      y = drawRowContent(pages[pageIdx], layout, row, y, x0, font, boldKey, false);
    }
    finishPage();

    // ---- "Page {n} of {m}" footers on every page of this table ----
    const m = pages.length;
    pages.forEach((p, idx) => {
      const footer = footerFmt
        .replace("{n}", String(idx + 1))
        .replace("{m}", String(m));
      const fw = faceWidth(pdfDoc, font, footer, FOOTER_SIZE);
      p.drawText({
        x: (pageW - fw) / 2,
        y: FOOTER_Y,
        text: footer,
        size: FOOTER_SIZE,
        color: COL_MUTED,
        ...faceOpts(font),
      });
    });
  }

  if (pagesDrawn === 0) {
    // defensive: an empty table list still yields one page
    pdfDoc.addPage(pageW, pageH);
    pagesDrawn = 1;
  }
  return { pages: pagesDrawn };
}
