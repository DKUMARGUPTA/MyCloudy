/**
 * JSON to PDF (P3-b / R56) — the PURE JSON → table engine.
 *
 * Six honest shapes, auto-detected:
 *  1. array of objects  → columns = the union of keys (first-seen
 *     order), one row per object (the API-export case);
 *  2. array of arrays   → header-less grid, rows as-is (the matrix
 *     case);
 *  3. array of scalars  → single column;
 *  4. mixed array       → every item stringified into one column;
 *  5. plain object      → Key / Value two-column table;
 *  6. scalar            → a single cell.
 *
 * Nested values inside records render as their compact JSON text —
 * nothing is silently dropped or faked. NDJSON / JSON-Lines files
 * (one JSON value per line) are detected by fallback: when the whole
 * document fails to parse but every non-blank line does, the lines
 * become the array.
 *
 * No DOM, no workers, no network — bun-testable pure functions only.
 */

import type { DataTable } from "../data-table-common/render";

/** Honest clamps — anything beyond is cut AND reported. */
export const JSON_MAX_COLS = 100;
export const JSON_MAX_ROWS = 2000;

export type JsonTableShape =
  | "records" // array of objects
  | "matrix" // array of arrays
  | "values" // array of scalars / mixed
  | "object" // key/value
  | "scalar"; // a single value

export interface JsonTable {
  table: DataTable;
  shape: JsonTableShape;
  /** columns dropped by the clamp (0 = none). */
  colsDropped: number;
  /** rows dropped by the clamp (0 = none). */
  rowsDropped: number;
}

/* ------------------------------------------------------------------ */
/* Value stringification                                                */
/* ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One JSON value → its cell text (spreadsheet conventions). */
export function jsonCell(v: unknown): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isPlainObject(v) || Array.isArray(v)) return JSON.stringify(v);
  return "";
}

/* ------------------------------------------------------------------ */
/* NDJSON fallback                                                      */
/* ------------------------------------------------------------------ */

/**
 * One JSON value per line (blank lines skipped). Returns null when
 * ANY non-blank line fails to parse — the caller then reports the
 * honest corrupt error instead of guessing.
 */
export function parseNdjson(text: string): unknown[] | null {
  const values: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      values.push(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return values.length > 0 ? values : null;
}

/* ------------------------------------------------------------------ */
/* The shape detector                                                   */
/* ------------------------------------------------------------------ */

/** The table build for one already-parsed JSON value. */
export function jsonToTable(value: unknown, title: string): JsonTable {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isPlainObject)) {
      return recordsTable(value, title);
    }
    if (value.length > 0 && value.every((v) => Array.isArray(v))) {
      // matrix: header-less grid, clamped
      const rows = value.slice(0, JSON_MAX_ROWS).map((row) =>
        (row as unknown[]).slice(0, JSON_MAX_COLS).map(jsonCell)
      );
      const colsDropped = value.reduce(
        (m, row) =>
          Math.max(m, Array.isArray(row) ? row.length - JSON_MAX_COLS : 0),
        0
      );
      return {
        table: { title, header: [], rows },
        shape: "matrix",
        colsDropped,
        rowsDropped: Math.max(0, value.length - JSON_MAX_ROWS),
      };
    }
    // scalars or mixed → one column per item
    const rows = value
      .slice(0, JSON_MAX_ROWS)
      .map((v) => [jsonCell(v)]);
    return {
      table: { title, header: [], rows },
      shape: "values",
      colsDropped: 0,
      rowsDropped: Math.max(0, value.length - JSON_MAX_ROWS),
    };
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    const rows = entries.slice(0, JSON_MAX_ROWS).map(([k, v]) => [
      k,
      jsonCell(v),
    ]);
    return {
      table: { title, header: ["Key", "Value"], rows },
      shape: "object",
      colsDropped: 0,
      rowsDropped: Math.max(0, entries.length - JSON_MAX_ROWS),
    };
  }
  return {
    table: { title, header: [], rows: [[jsonCell(value)]] },
    shape: "scalar",
    colsDropped: 0,
    rowsDropped: 0,
  };
}

function recordsTable(records: Record<string, unknown>[], title: string): JsonTable {
  // union of keys in first-seen order
  const keys = new Map<string, true>();
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      if (!keys.has(key)) keys.set(key, true);
    }
  }
  const allKeys = [...keys.keys()];
  const useKeys = allKeys.slice(0, JSON_MAX_COLS);
  const rows = records
    .slice(0, JSON_MAX_ROWS)
    .map((rec) => useKeys.map((key) => jsonCell(rec[key])));
  return {
    table: { title, header: useKeys, rows },
    shape: "records",
    colsDropped: Math.max(0, allKeys.length - JSON_MAX_COLS),
    rowsDropped: Math.max(0, records.length - JSON_MAX_ROWS),
  };
}

/* ------------------------------------------------------------------ */
/* File-level helpers                                                   */
/* ------------------------------------------------------------------ */

export interface JsonParseOutcome {
  value: unknown;
  /** true when the document arrived as NDJSON lines. */
  ndjson: boolean;
}

/**
 * Whole-document parse: strict JSON.parse first; on failure the
 * NDJSON fallback. Returns null only when both honestly failed.
 */
export function parseJsonDocument(text: string): JsonParseOutcome | null {
  try {
    return { value: JSON.parse(text), ndjson: false };
  } catch {
    const lines = parseNdjson(text);
    if (lines !== null && lines.length >= 2) {
      return { value: lines, ndjson: true };
    }
    return null;
  }
}

/** "sales-report.json" → "sales-report" (no path, no double extension). */
export function jsonBaseName(fileName: string): string {
  const noPath = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = noPath.lastIndexOf(".");
  const base = dot > 0 ? noPath.slice(0, dot) : noPath;
  return base.trim() !== "" ? base : "json-data";
}
