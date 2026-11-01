import { CreateContext } from "@/lib/own/pdf";

/**
 * CSV → PDF engine (PHASE-3 batch 3): RFC-4180 parsing (quoted fields,
 * embedded commas/newlines/escaped quotes) + a print-grade table layout —
 * measured column widths, bold header, zebra rows, hairline grid — drawn
 * through CreateContext on OUR OWN engine. Pure logic, Node-smokeable.
 */

export interface CsvTable {
  rows: string[][];
  /** True when the file had at least one quoted field (header guess hint). */
  sawQuotes: boolean;
}

/** Parse CSV text into rows (handles quotes, embedded separators). */
export function parseCsv(text: string, delimiter: string): CsvTable {
  const rows: string[][] = [];
  let sawQuotes = false;
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      sawQuotes = true;
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  // Trailing field/row without a newline terminator.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop fully-empty trailing rows (trailing newlines in exports).
  while (rows.length > 0) {
    const last = rows[rows.length - 1]!;
    if (last.length === 1 && last[0]!.trim().length === 0) {
      rows.pop();
    } else {
      break;
    }
  }

  return { rows, sawQuotes };
}

export interface CsvLayoutOptions {
  pageSize: { width: number; height: number };
  fontSize: number;
  header: boolean;
  zebra: boolean;
  grid: boolean;
  orientation: "portrait" | "landscape";
}

/** Fit text into maxWidth, appending an ellipsis when truncated. */
function fitCell(
  text: string,
  maxWidth: number,
  measure: (s: string, size: number, bold: boolean) => number,
  size: number,
  bold: boolean
): { text: string; width: number } {
  let out = text;
  let w = measure(out, size, bold);
  while (out.length > 1 && w > maxWidth) {
    out = `${out.slice(0, out.length - 2).trimEnd()}…`;
    w = measure(out, size, bold);
  }
  return { text: out, width: w };
}

export interface CsvLayoutResult {
  pages: number;
  rows: number;
  columns: number;
}

const MARGIN = 40;
const HEADER_BG = { r: 0.94, g: 0.95, b: 0.97 };
const ZEBRA_BG = { r: 0.965, g: 0.97, b: 0.98 };
const GRID_COLOR = { r: 0.82, g: 0.84, b: 0.87 };
const TEXT_COLOR = { r: 0.12, g: 0.13, b: 0.15 };
const HEADER_TEXT = { r: 0.07, g: 0.08, b: 0.1 };

/** Render the table into a fresh CreateContext. */
export function renderCsvTable(
  ctx: CreateContext,
  table: string[][],
  opts: CsvLayoutOptions
): CsvLayoutResult {
  const pageW =
    opts.orientation === "landscape" ? opts.pageSize.height : opts.pageSize.width;
  const pageH =
    opts.orientation === "landscape" ? opts.pageSize.width : opts.pageSize.height;

  const measure = (s: string, size: number, bold: boolean): number =>
    ctx.measure(s, bold ? "helveticaBold" : "helvetica", size);

  const columnCount = table.reduce((max, row) => Math.max(max, row.length), 0);
  if (columnCount === 0) {
    return { pages: 0, rows: 0, columns: 0 };
  }

  // Column widths: max measured content, capped at 32% of usable width,
  // then scaled down proportionally if the total overflows.
  const usable = pageW - MARGIN * 2;
  const cap = usable * 0.32;
  const sampleSize = Math.min(table.length, 200);
  const widths: number[] = new Array(columnCount).fill(0);
  for (let r = 0; r < sampleSize; r += 1) {
    const row = table[r]!;
    for (let c = 0; c < columnCount; c += 1) {
      const cell = (row[c] ?? "").replace(/[\u0000-\u001f]+/g, " ");
      const w = measure(cell, opts.fontSize, opts.header && r === 0);
      if (w > widths[c]!) widths[c] = w;
    }
  }
  for (let c = 0; c < columnCount; c += 1) {
    widths[c] = Math.min(widths[c]! + 12, cap);
  }
  const total = widths.reduce((sum, w) => sum + w, 0);
  if (total > usable) {
    const shrink = usable / total;
    for (let c = 0; c < columnCount; c += 1) {
      widths[c]! *= shrink;
    }
  }

  const rowHeight = opts.fontSize * 1.9;
  const headerHeight = opts.header ? rowHeight * 1.15 : 0;
  const rowsPerPage = Math.max(
    1,
    Math.floor((pageH - MARGIN * 2 - headerHeight) / rowHeight)
  );

  const drawGridRow = (
    page: ReturnType<CreateContext["addPage"]>,
    y: number,
    x0: number,
    x1: number
  ): void => {
    page.drawLine({
      start: { x: x0, y },
      end: { x: x1, y },
      thickness: 0.6,
      color: GRID_COLOR,
    });
  };

  const drawRow = (
    page: ReturnType<CreateContext["addPage"]>,
    rowIndex: number,
    yTop: number
  ): void => {
    const row = table[rowIndex]!;
    const isHeader = opts.header && rowIndex === 0;
    const x0 = MARGIN;
    const x1 = MARGIN + widths.reduce((sum, w) => sum + w, 0);

    if (isHeader) {
      page.drawRectangle({
        x: x0,
        y: yTop - headerHeight,
        width: x1 - x0,
        height: headerHeight,
        color: HEADER_BG,
      });
    } else if (opts.zebra && rowIndex % 2 === 0) {
      page.drawRectangle({
        x: x0,
        y: yTop - rowHeight,
        width: x1 - x0,
        height: rowHeight,
        color: ZEBRA_BG,
      });
    }

    let x = MARGIN;
    for (let c = 0; c < columnCount; c += 1) {
      // Control characters (embedded newlines/tabs from quoted cells)
      // render as spaces — the grid keeps its row shape.
      const cell = (row[c] ?? "").replace(/[\u0000-\u001f]+/g, " ");
      const fitted = fitCell(cell, widths[c]! - 12, measure, opts.fontSize, isHeader);
      if (fitted.text.length > 0) {
        page.drawText({
          x: x + 6,
          y: yTop - (isHeader ? headerHeight : rowHeight) + (isHeader ? 6 : 4.5),
          text: fitted.text,
          size: opts.fontSize,
          color: isHeader ? HEADER_TEXT : TEXT_COLOR,
          font: isHeader ? "helveticaBold" : "helvetica",
        });
      }
      if (opts.grid) {
        page.drawLine({
          start: { x, y: yTop - (isHeader ? headerHeight : rowHeight) },
          end: { x, y: yTop },
          thickness: 0.6,
          color: GRID_COLOR,
        });
      }
      x += widths[c]!;
    }
    if (opts.grid) {
      page.drawLine({
        start: { x, y: yTop - (isHeader ? headerHeight : rowHeight) },
        end: { x, y: yTop },
        thickness: 0.6,
        color: GRID_COLOR,
      });
      drawGridRow(page, yTop, x0, x1);
    }
  };

  let pages = 0;
  for (let start = 0; start < table.length; ) {
    const page = ctx.addPage(pageW, pageH);
    pages += 1;
    let yTop = pageH - MARGIN;
    let index = start;

    if (opts.header && start > 0 && table.length > 0) {
      // Repeat the header row on every continuation page.
      drawRow(page, 0, yTop);
      yTop -= headerHeight;
    }
    if (opts.header && start === 0) {
      drawRow(page, 0, yTop);
      yTop -= headerHeight;
      index = 1;
    }

    let drawn = 0;
    while (index < table.length && drawn < rowsPerPage) {
      drawRow(page, index, yTop);
      yTop -= rowHeight;
      index += 1;
      drawn += 1;
    }
    start = index;
  }

  return { pages, rows: table.length, columns: columnCount };
}
