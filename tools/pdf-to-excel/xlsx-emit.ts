import { zipSync, type Zippable } from "fflate";

import type { OptionValues } from "@/lib/tools/config-types";
import {
  collectPieces,
  type RawTextItem,
  type TextPiece,
} from "../pdf-to-txt/text-layout";

/**
 * PDF → XLSX engine (Task b3-a) — PURE, bun-testable, no DOM, no pdf.js.
 *
 * A .xlsx is an OOXML package: a ZIP container whose parts are XML
 * documents. This module extracts table-shaped text from pdf.js pieces
 * and emits the minimal VALID part set:
 *
 *   [Content_Types].xml               — content types for every part
 *   _rels/.rels                        — package → xl/workbook.xml
 *   xl/workbook.xml                    — one sheet ("Sheet1")
 *   xl/_rels/workbook.xml.rels          — workbook → sheet + styles +
 *                                        sharedStrings
 *   xl/worksheets/sheet1.xml            — <cols> widths + <sheetData> with
 *                                        one <row> per visual PDF line
 *   xl/sharedStrings.xml               — EMPTY part (count 0): cells use
 *                                        inlineStr instead (see below)
 *   xl/styles.xml                       — Normal font + bold header style
 *
 * CELL STRATEGY (documented choice): text rides INLINE strings
 * (`<c t="inlineStr"><is><t>`) — the simpler of the two OOXML options,
 * no string-table bookkeeping. An empty sharedStrings.xml part is still
 * shipped so the package keeps the standard 7-part shape tools expect;
 * Excel, LibreOffice and openpyxl all open it (smoke-proven).
 *
 * EXTRACTION STRATEGY (honest v1): pdf.js text items → pieces → visual
 * lines (baseline within half a font height, X-sorted — the shared
 * pdf-to-txt recipe) → each line SPLITS into cells wherever the
 * horizontal gap between neighbouring pieces is ≥ 2 × an estimated
 * space width (0.5 × font size ≈ one em). Word-spaced prose (gaps
 * ≈ 0.3 em) stays one cell per line; table columns (gaps ≥ 1 em) split.
 * Merged cells, borders, formulas, images and scanned pages are NOT
 * detected — the tool FAQ says so.
 *
 * SECURITY (the html-emit/docx-emit lesson, same rigor): every cell
 * text goes through escapeXml() — & FIRST via split/join so nothing
 * double-escapes — and stripInvalidXmlChars() removes XML 1.0-invalid
 * control characters. Output is UTF-8 (TextEncoder); Devanagari passes
 * through verbatim.
 *
 * CELL TEXT CAP: Excel refuses cells longer than 32,767 characters —
 * longer text is TRUNCATED HONESTLY: the cell keeps exactly 32,767
 * chars and ends with the marker "…(truncated)" so no data loss is
 * silently disguised (the FAQ documents this too).
 *
 * Excel hard limits respected: 1,048,576 rows / 16,384 columns. Rows
 * beyond the cap are dropped (a realistic PDF cannot reach it: ~1,000
 * pages × 60 lines is 60k rows); columns beyond the cap merge their
 * cells into the last allowed column (nothing is silently dropped).
 *
 * iOS-safe (worklog IOS-COMPAT): no String.prototype.matchAll /
 * replaceAll, no regex lookbehind, no Object.hasOwn / structuredClone —
 * split/join and plain exec/test only.
 */

/* Re-exports: the extraction primitives this engine is built on. */
export { collectPieces, pageCharCount } from "../pdf-to-txt/text-layout";
export type { RawTextItem, TextPiece } from "../pdf-to-txt/text-layout";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One output row: the cells of a single visual PDF line. */
export type SheetRow = string[];

/** Resolved tool options (the worker consumes OptionValues). */
export interface ExcelOutOptions {
  pages: string;
  /** Bold the first line of the first page as a header row. */
  headerRow: boolean;
}

/** Option normalization for the worker (and the smoke). */
export function resolveExcelOptions(options: OptionValues): ExcelOutOptions {
  return {
    pages: typeof options.pages === "string" ? options.pages : "all",
    headerRow: options.headerRow !== false,
  };
}

/* ------------------------------------------------------------------ */
/* Excel hard limits                                                   */
/* ------------------------------------------------------------------ */

/** Excel's per-cell character limit (cells longer than this are refused). */
export const CELL_TEXT_CAP = 32767;
/** Marker appended when a cell had to be truncated to the cap. */
export const CELL_TRUNCATED_MARKER = "…(truncated)";
/** Excel's sheet row limit. */
export const MAX_ROWS = 1_048_576;
/** Excel's sheet column limit (column XFD). */
export const MAX_COLS = 16_384;

/**
 * Honest truncation: keeps exactly CELL_TEXT_CAP characters and ends
 * with the marker so the reader knows the text was cut.
 */
export function capCellText(text: string): string {
  if (text.length <= CELL_TEXT_CAP) return text;
  return (
    text.slice(0, CELL_TEXT_CAP - CELL_TRUNCATED_MARKER.length) +
    CELL_TRUNCATED_MARKER
  );
}

/* ------------------------------------------------------------------ */
/* Escaping (CRITICAL — user content goes into XML)                    */
/* ------------------------------------------------------------------ */

/**
 * XML text escaping. `&` first so nothing double-escapes; split/join
 * (not replaceAll) per the iOS-compat rule. The five XML 1.0 predefined
 * entities cover every character an attacker (or a quirky PDF) can put
 * inside <t>.
 */
export function escapeXml(text: string): string {
  return text
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;")
    .split("'")
    .join("&#39;");
}

/**
 * Removes characters that are invalid in XML 1.0 documents (C0 controls
 * except \t \n \r, plus DEL) — they would make Excel refuse the file.
 */
export function stripInvalidXmlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** Full cell-text pipeline: strip invalids, tidy whitespace, cap. */
export function cellText(text: string): string {
  const cleaned = stripInvalidXmlChars(text).replace(/\s+/g, " ");
  return capCellText(cleaned.replace(/^ /, "").replace(/ $/, ""));
}

/* ------------------------------------------------------------------ */
/* Pieces → visual lines → cells                                       */
/* ------------------------------------------------------------------ */

/**
 * Estimated space width as a fraction of the font size. A typical
 * proportional-font space is ~0.25-0.33 em; 0.5 is the conservative
 * overestimate the shared line builders use, so "2 × space width"
 * lands at one full em — comfortably above word/justified-prose gaps
 * and well below real table column gaps.
 */
const SPACE_WIDTH_FACTOR = 0.5;
/** A gap ≥ this × the estimated space width splits a new cell. */
const CELL_GAP_FACTOR = 2;
/** Floor for the split threshold (protects tiny fonts). */
const MIN_CELL_GAP_PT = 4;

/**
 * Groups pieces into visual lines (the pdf-to-txt recipe: baseline
 * within half a font height, X-sorted inside the line). Unlike
 * buildMdLines this keeps the PIECE boundaries — cell splitting needs
 * to see where the horizontal gaps are.
 */
export function groupPieceLines(pieces: TextPiece[]): TextPiece[][] {
  if (pieces.length === 0) return [];
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);

  const groups: TextPiece[][] = [];
  let current: TextPiece[] = [sorted[0] as TextPiece];
  let groupY = sorted[0].y;
  let groupTol = Math.max(1.5, sorted[0].size * 0.5);

  for (let i = 1; i < sorted.length; i += 1) {
    const piece = sorted[i] as TextPiece;
    if (Math.abs(piece.y - groupY) <= groupTol) {
      current.push(piece);
    } else {
      groups.push(current);
      current = [piece];
      groupY = piece.y;
      groupTol = Math.max(1.5, piece.size * 0.5);
    }
  }
  groups.push(current);
  return groups.map((group) => [...group].sort((a, b) => a.x - b.x));
}

/** The cell-split threshold for a line: ≥ 2 × an estimated space width. */
export function cellGapThreshold(lineSize: number): number {
  return Math.max(
    lineSize * SPACE_WIDTH_FACTOR * CELL_GAP_FACTOR,
    MIN_CELL_GAP_PT
  );
}

/**
 * One visual line's pieces → cells. Two gap signals split a cell:
 *  - a DIRECT horizontal gap ≥ 2 × the estimated space width between
 *    neighbouring pieces (some producers leave the gap empty), or
 *  - a WHITESPACE-ONLY piece at least that wide — pdf.js's combined
 *    text mode bridges wide gaps with a synthetic " " whose width IS
 *    the gap (a 167pt-wide " " is a column gap, not a word space).
 * Narrower blanks and gaps join with a single space (word spacing
 * inside the cell). Cells past Excel's column limit merge into the
 * last allowed cell.
 */
export function piecesToCells(line: TextPiece[]): SheetRow {
  if (line.length === 0) return [];
  const size = line[0]?.size ?? 11;
  const threshold = cellGapThreshold(size);
  const cells: string[] = [];
  let buf = "";
  let endX: number | null = null;

  const flush = (): void => {
    const text = cellText(buf);
    if (text.length > 0) cells.push(text);
    buf = "";
  };

  for (const piece of line) {
    const blank = piece.str.trim().length === 0;
    if (blank && piece.w >= threshold) {
      // A synthetic (or literal) blank run as wide as a column gap.
      flush();
      endX = Math.max(endX ?? 0, piece.x + piece.w);
      continue;
    }
    const gap = endX === null ? 0 : piece.x - endX;
    if (endX !== null && gap >= threshold) {
      flush();
      buf = piece.str;
    } else if (blank) {
      // A real word space — never more than one in the buffer.
      if (!buf.endsWith(" ")) buf += " ";
    } else if (endX !== null && gap > size * 0.25 && !buf.endsWith(" ")) {
      buf += " " + piece.str;
    } else {
      buf += piece.str;
    }
    endX = Math.max(endX ?? 0, piece.x + piece.w);
  }
  flush();

  if (cells.length > MAX_COLS) {
    const kept = cells.slice(0, MAX_COLS - 1);
    const tail = cells
      .slice(MAX_COLS - 1)
      .filter((text) => text.length > 0)
      .join(" ");
    if (tail.length > 0) kept.push(capCellText(tail));
    return kept;
  }
  return cells;
}

/** One visual line → one row ([] when the line has no visible text). */
function lineToRow(line: TextPiece[]): SheetRow {
  const cells = piecesToCells(line);
  if (cells.length === 1 && (cells[0] ?? "").length === 0) return [];
  return cells;
}

/** Raw pdf.js text items → one page's rows (lines → cells). */
export function pageRows(items: RawTextItem[]): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const line of groupPieceLines(collectPieces(items))) {
    const row = lineToRow(line);
    if (row.length > 0) rows.push(row);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Column references + widths                                          */
/* ------------------------------------------------------------------ */

/** 1-based column index → spreadsheet reference (1→A, 27→AA, …). */
export function columnRef(index: number): string {
  let n = index;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const MIN_COL_WIDTH = 8;
const MAX_COL_WIDTH = 60;
const COL_WIDTH_PAD = 2;

/**
 * Content-based column widths, in Excel character units: the widest
 * cell per column (+ padding), clamped so one pathologically long cell
 * cannot blow up the sheet.
 */
export function columnWidths(rows: SheetRow[]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    for (let c = 0; c < row.length; c += 1) {
      const text = row[c] ?? "";
      const len = [...text].length; // surrogate pairs count once
      widths[c] = Math.max(widths[c] ?? 0, len);
    }
  }
  return widths.map((w) =>
    Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, w + COL_WIDTH_PAD))
  );
}

/* ------------------------------------------------------------------ */
/* sheet1.xml emission                                                 */
/* ------------------------------------------------------------------ */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** One cell: `<c r="A1" s="1" t="inlineStr"><is><t>…</t></is></c>`. */
export function cellXml(
  rowNumber: number,
  columnIndex: number,
  text: string,
  styleId: number | null
): string {
  const ref = `${columnRef(columnIndex)}${rowNumber}`;
  const s = styleId === null ? "" : ` s="${styleId}"`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(
    text
  )}</t></is></c>`;
}

/** One row element; the style (header) applies to every cell of the row. */
export function rowXml(
  rowNumber: number,
  cells: string[],
  styleId: number | null
): string {
  const parts: string[] = [`<row r="${rowNumber}">`];
  for (let c = 0; c < cells.length; c += 1) {
    parts.push(cellXml(rowNumber, c + 1, cells[c] ?? "", styleId));
  }
  parts.push("</row>");
  return parts.join("");
}

/**
 * All rows → the complete xl/worksheets/sheet1.xml. The first row uses
 * the bold header style (s="1") when `headerRow` is on; the <cols>
 * block carries content-fitted custom widths.
 */
export function rowsToSheetXml(rows: SheetRow[], headerRow: boolean): string {
  const widths = columnWidths(rows);
  const cols =
    widths.length === 0
      ? ""
      : `<cols>${widths
          .map(
            (w, i) =>
              `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`
          )
          .join("")}</cols>`;

  const sheetData: string[] = [];
  let rowNumber = 0;
  for (const row of rows) {
    if (row.length === 0) continue;
    rowNumber += 1;
    if (rowNumber > MAX_ROWS) break;
    sheetData.push(
      rowXml(rowNumber, row, headerRow && rowNumber === 1 ? 1 : null)
    );
  }

  return [
    XML_DECL,
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    cols,
    `<sheetData>${sheetData.join("")}</sheetData>`,
    "</worksheet>",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* The other OOXML parts                                               */
/* ------------------------------------------------------------------ */

const CONTENT_TYPES_XML = [
  XML_DECL,
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  '<Default Extension="xml" ContentType="application/xml"/>',
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
  '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>',
  "</Types>",
  "",
].join("\n");

const ROOT_RELS_XML = [
  XML_DECL,
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
  "</Relationships>",
  "",
].join("\n");

const WORKBOOK_XML = [
  XML_DECL,
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
  '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>',
  "</workbook>",
  "",
].join("\n");

const WORKBOOK_RELS_XML = [
  XML_DECL,
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>',
  "</Relationships>",
  "",
].join("\n");

/**
 * Cells use inlineStr, so the shared-strings table stays EMPTY — the
 * part is still shipped (related + content-typed) to keep the standard
 * package shape; Excel/LibreOffice/openpyxl all accept it.
 */
const SHARED_STRINGS_XML = [
  XML_DECL,
  '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>',
  "",
].join("\n");

/**
 * xl/styles.xml — the minimal Excel-valid set:
 *  - fonts: Calibri 11 normal + bold (the header style's font)
 *  - fills: "none" + "gray125" (the two Excel itself always writes)
 *    + one light-grey solid used by the header style
 *  - one empty border, cellStyleXfs (Normal), and cellXfs:
 *    xf 0 = default, xf 1 = bold font + grey fill (header row).
 */
const STYLES_XML = [
  XML_DECL,
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
  '<fonts count="2">',
  '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>',
  '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>',
  "</fonts>",
  '<fills count="3">',
  '<fill><patternFill patternType="none"/></fill>',
  '<fill><patternFill patternType="gray125"/></fill>',
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill>',
  "</fills>",
  '<borders count="1">',
  "<border><left/><right/><top/><bottom/><diagonal/></border>",
  "</borders>",
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
  '<cellXfs count="2">',
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>',
  "</cellXfs>",
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
  "</styleSheet>",
  "",
].join("\n");

/* ------------------------------------------------------------------ */
/* The package (ZIP)                                                   */
/* ------------------------------------------------------------------ */

const utf8 = new TextEncoder();

/**
 * Rows → the .xlsx package bytes (fflate zipSync, the same library and
 * level the app's multi-output ZIP button uses). Filenames are all
 * ASCII so no ZIP name flags are needed; parts are UTF-8 XML.
 */
export function buildXlsxBytes(
  rows: SheetRow[],
  headerRow: boolean
): Uint8Array {
  const entries: Zippable = {
    "[Content_Types].xml": utf8.encode(CONTENT_TYPES_XML),
    "_rels/.rels": utf8.encode(ROOT_RELS_XML),
    "xl/workbook.xml": utf8.encode(WORKBOOK_XML),
    "xl/_rels/workbook.xml.rels": utf8.encode(WORKBOOK_RELS_XML),
    "xl/worksheets/sheet1.xml": utf8.encode(rowsToSheetXml(rows, headerRow)),
    "xl/sharedStrings.xml": utf8.encode(SHARED_STRINGS_XML),
    "xl/styles.xml": utf8.encode(STYLES_XML),
  };
  return zipSync(entries, { level: 6 });
}
