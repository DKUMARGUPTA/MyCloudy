/**
 * CSV to PDF (P3-b / R56) — the PURE CSV read engine.
 *
 * A full RFC 4180 document parser: quoted fields, embedded CRLF/LF
 * inside quotes, doubled quotes, no trailing newline on the last row.
 * Feeds the shared data-table painter (tools/data-table-common) with
 * honest clamps (100 columns / 2000 rows — the truncation is REPORTED,
 * never silent) and a delimiter sniffer for the "auto" option.
 *
 * No DOM, no workers, no network — bun-testable pure functions only.
 */

export type CsvDelimiter = "," | ";" | "\t";

/** Honest clamps — anything beyond is cut AND reported. */
export const CSV_MAX_COLS = 100;
export const CSV_MAX_ROWS = 2000;

export interface CsvGrid {
  /** column labels ([] when the caller said "no header row"). */
  header: string[];
  rows: string[][];
  /** columns dropped by the clamp (0 = none). */
  colsDropped: number;
  /** rows dropped by the clamp (0 = none). */
  rowsDropped: number;
}

/* ------------------------------------------------------------------ */
/* The RFC 4180 document parser                                         */
/* ------------------------------------------------------------------ */

/**
 * Parses a whole CSV document. Handles:
 *  - quoted fields ("a,b" is ONE field),
 *  - embedded line breaks inside quotes (they stay in the cell),
 *  - doubled quotes ("" → "),
 *  - CRLF, lone LF and lone CR line ends,
 *  - a missing trailing newline on the last row,
 *  - rows with fewer/more fields than others (ragged grids survive).
 */
export function parseCsvDocument(
  text: string,
  delimiter: CsvDelimiter
): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false; // a field/row was begun (trailing blank line!)

  const pushField = (): void => {
    row.push(field);
    field = "";
    started = true;
  };
  const pushRow = (): void => {
    row.push(field);
    field = "";
    rows.push(row);
    row = [];
    started = false;
  };

  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      // CRLF counts once; a lone CR (old Mac) also ends a row.
      if (ch === "\r" && text[i + 1] === "\n") i += 2;
      else i++;
      // A blank line OUTSIDE quotes is a one-empty-field row only
      // when the file uses it meaningfully — RFC 4180 says the last
      // record may not end in a line break, so a trailing break must
      // NOT spawn a phantom "" row.
      if (i >= n && !started && row.length === 0 && field === "") continue;
      pushRow();
      continue;
    }
    field += ch;
    started = true;
    i++;
  }
  // unterminated final row
  if (started || row.length > 0 || field !== "") pushRow();
  return rows;
}

/* ------------------------------------------------------------------ */
/* Delimiter sniffing                                                   */
/* ------------------------------------------------------------------ */

/**
 * Sniffs the delimiter from the first lines: counts candidate
 * delimiters OUTSIDE quoted fields, then picks the one that yields
 * the most consistent column count (ties → comma > semicolon > tab,
 * the frequency order in the wild). Returns "," for single-column
 * files (any delimiter "works" there).
 */
export function sniffDelimiter(text: string): CsvDelimiter {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;
  const cap = 50; // first 50 physical lines are plenty
  let physical = 0;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (current !== "" || lines.length > 0) lines.push(current);
      current = "";
      physical++;
      if (physical >= cap) break;
      continue;
    }
    current += ch;
  }
  if (current !== "") lines.push(current);

  const candidates: CsvDelimiter[] = [",", ";", "\t"];
  let best: CsvDelimiter = ",";
  let bestScore = -1;
  for (const delim of candidates) {
    const counts: number[] = [];
    let quoted = false;
    for (const line of lines) {
      let c = 1;
      for (const ch of line) {
        if (ch === '"') quoted = !quoted;
        else if (ch === delim && !quoted) c++;
      }
      counts.push(c);
    }
    if (counts.length === 0) continue;
    const max = Math.max(...counts);
    if (max <= 1) continue; // single column — this delimiter isn't it
    // consistency: how many lines agree on the mode column count
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    let mode = 1;
    let modeCount = 0;
    for (const [c, f] of freq) {
      if (f > modeCount || (f === modeCount && c > mode)) {
        mode = c;
        modeCount = f;
      }
    }
    const score = mode * modeCount; // more columns × more agreement wins
    if (score > bestScore) {
      bestScore = score;
      best = delim;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Grid build                                                           */
/* ------------------------------------------------------------------ */

/**
 * Parses the text and applies the honest clamps:
 *  - `headerRow` true → rows[0] becomes the column labels;
 *  - > 100 columns → the rest are dropped (colsDropped reports it);
 *  - > 2000 rows → the rest are dropped (rowsDropped reports it).
 */
export function csvGrid(
  text: string,
  delimiter: CsvDelimiter,
  headerRow: boolean
): CsvGrid {
  const parsed = parseCsvDocument(text, delimiter);
  const colsDropped = parsed.reduce(
    (m, row) => Math.max(m, Math.max(0, row.length - CSV_MAX_COLS)),
    0
  );
  const limited = parsed.map((row) => row.slice(0, CSV_MAX_COLS));
  const body = headerRow ? limited.slice(1) : limited;
  const header = headerRow ? (limited[0] ?? []) : [];
  const rowsDropped = Math.max(0, body.length - CSV_MAX_ROWS);
  const rows = body.slice(0, CSV_MAX_ROWS);
  return { header, rows, colsDropped, rowsDropped };
}

/* ------------------------------------------------------------------ */
/* Output naming                                                        */
/* ------------------------------------------------------------------ */

/** "sales-report.csv" → "sales-report" (no path, no double extension). */
export function csvBaseName(fileName: string): string {
  const noPath = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = noPath.lastIndexOf(".");
  const base = dot > 0 ? noPath.slice(0, dot) : noPath;
  return base.trim() !== "" ? base : "csv-data";
}
