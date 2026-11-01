/**
 * CSV emission for extract-tables (PHASE-7): RFC-4180 quoting, three
 * delimiter choices, and the combined multi-table document format.
 * Pure string work — bun-smokeable.
 */

export type EtDelimiter = "," | ";" | "\t";

export const ET_DELIMITER_IDS = {
  comma: "comma",
  semicolon: "semicolon",
  tab: "tab",
} as const;

export function resolveDelimiter(value: unknown): EtDelimiter {
  if (value === "semicolon") return ";";
  if (value === "tab") return "\t";
  return ",";
}

/** One CSV cell — quoted only when it must be (delimiter/quote/newline). */
export function csvCell(text: string, delimiter: EtDelimiter): string {
  const needsQuotes =
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r");
  if (!needsQuotes) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/** A whole grid as CSV text (CRLF rows per RFC 4180, final CRLF kept). */
export function rowsToCsv(rows: string[][], delimiter: EtDelimiter): string {
  const lines = rows.map((row) =>
    row.map((cell) => csvCell(cell ?? "", delimiter)).join(delimiter)
  );
  return lines.length === 0 ? "" : `${lines.join("\r\n")}\r\n`;
}

/** CSV file name for one table (`base-p1-t2.csv` style). */
export function tableFileName(base: string, page: number, table: number): string {
  return `${base || "tables"}-p${page}-t${table}.csv`;
}

/**
 * The combined single-file format: every table's CSV with one blank
 * line between tables (the standard "multiple tables in one CSV"
 * convention that spreadsheet apps read as separate blocks).
 */
export function combineCsvs(
  tables: string[][][],
  delimiter: EtDelimiter
): string {
  const parts = tables.map((grid) => rowsToCsv(grid, delimiter).trimEnd());
  return parts.length === 0 ? "" : `${parts.join("\r\n\r\n")}\r\n`;
}
