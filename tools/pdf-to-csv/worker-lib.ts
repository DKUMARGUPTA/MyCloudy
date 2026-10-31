/**
 * PDF to CSV (P3-a / R55) — the PURE CSV emit engine.
 *
 * Reuses the pdf-to-excel grid extraction (y-band rows + chain-merged
 * column anchors) and ships the result as RFC 4180 CSV instead of a
 * workbook: comma / semicolon / tab delimiter, CRLF line ends, quotes
 * escaped by doubling. Single mode stacks every page into one CSV with a
 * leading Page column; per-page mode emits one CSV per page.
 *
 * No DOM, no workers, no network — bun-testable pure functions only.
 */

export type CsvDelimiter = "," | ";" | "\t";

export interface CsvOptions {
  delimiter: CsvDelimiter;
  mode: "single" | "per-page";
}

/** Extension follows the delimiter (tab → .tsv, the reader convention). */
export function csvExtension(delimiter: CsvDelimiter): string {
  return delimiter === "\t" ? "tsv" : "csv";
}

export function csvMimeType(delimiter: CsvDelimiter): string {
  return delimiter === "\t"
    ? "text/tab-separated-values;charset=utf-8"
    : "text/csv;charset=utf-8";
}

/**
 * RFC 4180 field escaping: wrap in quotes when the field contains the
 * delimiter, a double quote, CR or LF; embedded quotes double up.
 */
export function csvEscape(field: string, delimiter: CsvDelimiter): string {
  if (
    field.includes(delimiter) ||
    field.includes('"') ||
    field.includes("\r") ||
    field.includes("\n")
  ) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/** One grid row → one CSV line (CRLF, RFC 4180). */
export function csvLine(row: string[], delimiter: CsvDelimiter): string {
  return row.map((cell) => csvEscape(cell, delimiter)).join(delimiter);
}

/** A whole grid → CSV text (CRLF line ends, trailing CRLF). */
export function renderCsv(grid: string[][], delimiter: CsvDelimiter): string {
  if (grid.length === 0) return "";
  return grid.map((row) => csvLine(row, delimiter)).join("\r\n") + "\r\n";
}

export interface CsvOutput {
  name: string;
  body: string;
}

/**
 * Builds the download set from per-page grids.
 *  - single:   every page stacked, with a leading "Page" column;
 *  - per-page: one file per page (…_page1.csv, …_page2.csv).
 */
export function buildCsvOutputs(
  baseName: string,
  pageGrids: string[][][],
  options: CsvOptions,
): CsvOutput[] {
  const ext = csvExtension(options.delimiter);
  if (options.mode === "per-page") {
    return pageGrids.map((grid, index) => ({
      name:
        pageGrids.length === 1
          ? `${baseName}.${ext}`
          : `${baseName}_page${index + 1}.${ext}`,
      body: renderCsv(grid, options.delimiter),
    }));
  }
  const stacked: string[][] = [];
  pageGrids.forEach((grid, index) => {
    const pageLabel = String(index + 1);
    if (grid.length === 0) {
      stacked.push([pageLabel]);
      return;
    }
    for (const row of grid) stacked.push([pageLabel, ...row]);
  });
  return [
    {
      name: `${baseName}.${ext}`,
      body: renderCsv(stacked, options.delimiter),
    },
  ];
}

/** Parse a CSV line back into fields (the smoke oracle). */
export function parseCsvLine(
  line: string,
  delimiter: CsvDelimiter,
): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}
