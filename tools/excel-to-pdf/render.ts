/**
 * Excel to PDF renderer (RB1-c) — the vector table painter.
 *
 * Pure pdf-lib drawing, synchronous by design: fonts arrive already
 * embedded by the caller (Helvetica/HelveticaBold for WinAnsi content,
 * the Noto Sans Devanagari subset when needsNoto flipped) — exactly
 * the create-resume contract, so the smoke script can drive the very
 * same code headless.
 *
 * Per sheet (each starts a fresh page):
 *  - sheet-name header: 12 pt bold + hairline rule;
 *  - column widths from the model's content heuristic, then fit-scaled
 *    to the printable width (fit=true stretches AND shrinks; fit=false
 *    only shrinks when the natural table is too wide);
 *  - first row = header row: bold text on a light neutral fill, drawn
 *    again at the top of every continuation page;
 *  - cell text wrapped to the column width (long words char-broken),
 *    row heights from the wrapped line counts, honestly clipped with
 *    an ellipsis when a single row would outgrow a page;
 *  - grid hairlines, optional zebra striping;
 *  - "Sheet N of M" footers on every page of every sheet;
 *  - every glyph is REAL selectable text (drawText).
 *
 * The one caller-side contract: when the base-14 Helvetica pair is in
 * use, every drawn string must be WinAnsi (the worker enforces this —
 * a localized Hindi footer falls back to the English default rather
 * than crashing WinAnsi encoding).
 */

import type { PDFDocument, PDFFont, PDFPage } from "pdf-lib";
import { rgb, type RGB } from "pdf-lib";

import {
  computeColumnWidths,
  type ExcelOrientation,
  type ExcelPageSize,
  type ParsedWorkbook,
  type XlsxCell,
  type XlsxSheet,
} from "./model";

/* ------------------------------------------------------------------ */
/* Geometry + palette                                                  */
/* ------------------------------------------------------------------ */

const PAGE_SIZES: Record<ExcelPageSize, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

const MARGIN_X = 40;
/** sheet name baseline sits 34 pt below the top edge */
const SHEET_NAME_DROP = 34;
/** table starts 54 pt below the top edge (name + rule + gap) */
const TABLE_TOP_DROP = 54;
const BOTTOM = 56;
const FOOTER_Y = 24;

const BODY_SIZE = 9;
const HEADER_SIZE = 9;
const SHEET_NAME_SIZE = 12;
const FOOTER_SIZE = 8;
const LINE_H = 11;
/** pad(3) + ascent(≈7) — the first baseline drop inside a row */
const FIRST_BASELINE = 10;
const ROW_PAD = 6;

const COL_TEXT: RGB = rgb(0.08, 0.08, 0.08);
const COL_MUTED: RGB = rgb(0.4, 0.4, 0.4);
const COL_GRID: RGB = rgb(0.78, 0.78, 0.78);
const COL_GRID_STRONG: RGB = rgb(0.55, 0.55, 0.55);
const COL_HEADER_FILL: RGB = rgb(0.9, 0.91, 0.92);
const COL_ZEBRA: RGB = rgb(0.955, 0.955, 0.96);

/* ------------------------------------------------------------------ */
/* Options + report                                                    */
/* ------------------------------------------------------------------ */

export interface WorkbookRenderOpts {
  pageSize: ExcelPageSize;
  orientation: ExcelOrientation;
  /** true → scale the table to exactly fill the page width. */
  fit: boolean;
  /** optional zebra striping for data rows. */
  zebra?: boolean;
  /** footer template containing {n} and {m}; default "Sheet {n} of {m}". */
  footerFmt?: string;
}

export interface WorkbookRenderReport {
  pages: number;
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
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
/* Precomputed sheet layout                                            */
/* ------------------------------------------------------------------ */

interface RowLayout {
  /** wrapped lines per cell ("" cells → one empty line). */
  cells: string[][];
  bold: (boolean | undefined)[];
  height: number;
  /** set at draw time — zebra fill for odd data rows. */
  zebraFill?: boolean;
}

interface SheetLayout {
  sheet: XlsxSheet;
  widths: number[];
  xEnds: number[];
  header: RowLayout | null;
  rows: RowLayout[];
  tableWidth: number;
}

function layoutRow(
  row: XlsxCell[],
  widths: number[],
  measure: Measure,
  boldMeasure: Measure,
  maxLines: number
): RowLayout {
  const cells: string[][] = [];
  const bold: (boolean | undefined)[] = [];
  let lineCount = 1;
  for (let c = 0; c < widths.length; c++) {
    const cell = row[c];
    const inner = widths[c] - 6;
    if (!cell || cell.v === "") {
      cells.push([""]);
      bold.push(undefined);
      continue;
    }
    const lines = clipLines(
      wrapCellText(cell.v, inner, BODY_SIZE, measure),
      maxLines,
      inner,
      BODY_SIZE,
      measure
    );
    cells.push(lines);
    bold.push(cell.bold);
    if (lines.length > lineCount) lineCount = lines.length;
  }
  return { cells, bold, height: lineCount * LINE_H + ROW_PAD };
}

function layoutSheet(
  sheet: XlsxSheet,
  contentWidth: number,
  contentHeight: number,
  opts: WorkbookRenderOpts,
  font: PDFFont,
  boldFont: PDFFont | null
): SheetLayout {
  const measure: Measure = (text, size) =>
    font.widthOfTextAtSize(text, size);
  const boldMeasure: Measure = (text, size) =>
    (boldFont ?? font).widthOfTextAtSize(text, size);

  const natural = computeColumnWidths(sheet);
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

  const headerRow = sheet.rows[0] ?? null;
  // 60% page cap on the header row: a monster first row gets honestly
  // ellipsized so at least one data row always fits below it on a
  // fresh page (page-break termination proof)
  const header =
    headerRow !== null
      ? layoutRow(
          headerRow,
          widths,
          boldMeasure,
          boldMeasure,
          Math.max(1, Math.floor((contentHeight * 0.6) / LINE_H))
        )
      : null;
  // worst-case row budget: a fresh page minus the repeated header row
  const usable = contentHeight - (header ? header.height : 0) - 4;
  const maxLines = Math.max(1, Math.floor((usable - ROW_PAD) / LINE_H));

  const rows: RowLayout[] = [];
  for (let r = 1; r < sheet.rows.length; r++) {
    rows.push(layoutRow(sheet.rows[r], widths, measure, boldMeasure, maxLines));
  }
  return { sheet, widths, xEnds, header, rows, tableWidth };
}

/* ------------------------------------------------------------------ */
/* Painter                                                             */
/* ------------------------------------------------------------------ */

function drawTextSafe(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  size: number,
  font: PDFFont,
  boldFont: PDFFont | null,
  bold: boolean | undefined,
  color: RGB
): void {
  if (text === "") return;
  const face = bold && boldFont ? boldFont : font;
  page.drawText(text, { x, y, size, font: face, color });
  if (bold && !boldFont) {
    // Noto ships Regular only — the invoice double-draw faux-bold
    page.drawText(text, { x: x + 0.3, y, size, font: face, color });
  }
}

function drawRowContent(
  page: PDFPage,
  layout: SheetLayout,
  row: RowLayout,
  rowTop: number,
  x0: number,
  font: PDFFont,
  boldFont: PDFFont | null,
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
    const bold = headerStyle || row.bold[c];
    const cx = x0 + (c === 0 ? 0 : layout.xEnds[c - 1]) + 3;
    for (let i = 0; i < lines.length; i++) {
      drawTextSafe(
        page,
        lines[i],
        cx,
        rowTop - FIRST_BASELINE - i * LINE_H,
        headerStyle ? HEADER_SIZE : BODY_SIZE,
        font,
        boldFont,
        bold,
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
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Paints every sheet of `wb` into `pdfDoc` (one fresh page per sheet,
 * continuation pages as the rows demand). Synchronous — the fonts are
 * caller-embedded. Returns the total page count.
 */
export function drawWorkbookPdf(
  pdfDoc: PDFDocument,
  font: PDFFont,
  boldFont: PDFFont | null,
  wb: ParsedWorkbook,
  opts: WorkbookRenderOpts
): WorkbookRenderReport {
  const [pw0, ph0] = PAGE_SIZES[opts.pageSize];
  const pageW = opts.orientation === "landscape" ? ph0 : pw0;
  const pageH = opts.orientation === "landscape" ? pw0 : ph0;
  const x0 = MARGIN_X;
  const contentWidth = pageW - 2 * MARGIN_X;
  const contentHeight = pageH - TABLE_TOP_DROP - BOTTOM;
  const footerFmt = opts.footerFmt ?? "Sheet {n} of {m}";
  const total = wb.sheets.length;
  let pagesDrawn = 0;

  for (let s = 0; s < total; s++) {
    const layout = layoutSheet(
      wb.sheets[s],
      contentWidth,
      contentHeight,
      opts,
      font,
      boldFont
    );
    const tableTop = pageH - TABLE_TOP_DROP;

    const newPage = (): PDFPage => {
      const page = pdfDoc.addPage([pageW, pageH]);
      pagesDrawn++;
      return page;
    };

    // ---- sheet name header (first page of the sheet) ----
    const page = newPage();
    drawTextSafe(
      page,
      layout.sheet.name,
      x0,
      pageH - SHEET_NAME_DROP,
      SHEET_NAME_SIZE,
      font,
      boldFont,
      true,
      COL_TEXT
    );
    page.drawLine({
      start: { x: x0, y: pageH - SHEET_NAME_DROP - 8 },
      end: { x: x0 + contentWidth, y: pageH - SHEET_NAME_DROP - 8 },
      thickness: 0.75,
      color: COL_GRID_STRONG,
    });

    let y = tableTop;
    let pageTopY = tableTop;
    const pages: PDFPage[] = [page];
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

    const drawHeaderRow = (target: PDFPage, top: number): number => {
      if (!layout.header) return top;
      return drawRowContent(
        target,
        layout,
        layout.header,
        top,
        x0,
        font,
        boldFont,
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
      y = drawRowContent(pages[pageIdx], layout, row, y, x0, font, boldFont, false);
    }
    finishPage();

    // ---- "Sheet N of M" footers on every page of this sheet ----
    const footer = footerFmt
      .replace("{n}", String(s + 1))
      .replace("{m}", String(total));
    const fw = font.widthOfTextAtSize(footer, FOOTER_SIZE);
    for (const p of pages) {
      p.drawText(footer, {
        x: (pageW - fw) / 2,
        y: FOOTER_Y,
        size: FOOTER_SIZE,
        font,
        color: COL_MUTED,
      });
    }
  }

  if (pagesDrawn === 0) {
    // defensive: a workbook with no renderable sheets still yields one page
    pdfDoc.addPage([pageW, pageH]);
    pagesDrawn = 1;
  }
  return { pages: pagesDrawn };
}
