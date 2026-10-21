import { zipSync, strToU8, type Zippable } from "fflate";

/**
 * PDF → Excel model (RB1-d — the 70th tool). PURE TypeScript: no pdfjs,
 * no DOM, no imports beyond fflate — the smoke script drives every export
 * headless in bun.
 *
 * The extraction is honest rule-based geometry (the FAQ says so):
 *   1. rows    — text items cluster into y-bands (baseline within half a
 *                font height, the pdf-to-txt recipe);
 *   2. columns — unique x-starts are chain-merged within a tolerance
 *                (8 pt) into column anchors, then anchors that never
 *                share a row merge too (right-aligned numeric columns
 *                get one logical column instead of one per value width);
 *   3. cells   — items assigned to (row, column); wide gaps inside a
 *                cell insert a space (pdf.js emits per-Tj pieces without
 *                carrying spaces);
 *   4. wraps   — a tightly-spaced line whose columns are a PROPER subset
 *                of the row above joins those cells (wrapped cell text
 *                becomes one cell); equal sets never merge, so dense
 *                tables and plain text pages stay row-per-line.
 *
 * Limits (clamped in buildXlsx): 20 sheets, 500 rows, 60 columns.
 */

/* ------------------------------ limits ------------------------------ */

export const MAX_SHEETS = 20;
export const MAX_ROWS_PER_SHEET = 500;
export const MAX_COLS_PER_SHEET = 60;

/** Adjacent x-starts closer than this (pt) share one column anchor. */
export const COL_MERGE_TOL = 8;
/** A continuation line within this factor of the font size joins the cell above. */
export const WRAP_GAP_FACTOR = 1.6;

/** Baseline tolerance for one visual row (× font size, min 1.5pt). */
const ROW_TOL_FACTOR = 0.5;
/** Horizontal gap inside a cell (× font size) that inserts a space. */
const CELL_SPACE_FACTOR = 0.25;

/* ------------------------------- types ------------------------------- */

/** One positioned text piece — pdf.js text item reduced to geometry.
 *  x/y are the PDF-space baseline start (y grows UP the page). */
export interface GridTextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
}

export interface GridExtractOptions {
  /** x-start cluster tolerance in pt (default 8). */
  colTol?: number;
  /** wrap-join gap factor (default 1.6). */
  wrapGapFactor?: number;
}

/** Coerce pdf.js `getTextContent().items` into grid items (pure, defensive). */
export function gridItemsFromRaw(items: Iterable<unknown>): GridTextItem[] {
  const out: GridTextItem[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const str = (raw as { str?: unknown }).str;
    if (typeof str !== "string" || str.trim().length === 0) continue;
    const transform = (raw as { transform?: unknown }).transform;
    if (!Array.isArray(transform) || transform.length < 6) continue;
    const x = Number(transform[4]);
    const y = Number(transform[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const size = Math.hypot(
      Number(transform[1]) || 0,
      Number(transform[3]) || 0
    );
    const w = Number((raw as { width?: unknown }).width) || 0;
    out.push({ str, x, y, w, size: size > 0 ? size : 10 });
  }
  return out;
}

/* --------------------------- column helpers -------------------------- */

/* Devanagari visual→logical repair. pdf.js concatenates per-glyph
 * ToUnicode in stream order, and shaping puts the three PRE-base
 * matras (ि े ै) BEFORE their base cluster — so text drawn from shaped
 * glyph streams (pdf-lib/Noto, many cheap generators) extracts with
 * "िप्रया" instead of "प्रिया". The inverse move is only applied where
 * it is PROVABLY visual: the matra starts the run, or follows anything
 * that can never end a logical syllable (space, vowel, another sign,
 * virama, Latin…). After a plain CONSONANT the reading is ambiguous
 * ("म ि स् त" could be logical "मेस्त" or visual "नमस्ते" mid-word) and
 * is left untouched — OCR-style logical text is never damaged. */

const DEV_PRE_MATRA = new Set(["\u093F", "\u0947", "\u0948"]); // ि े ै
const DEV_VIRAMA = "\u094D";
const DEV_NUKTA = "\u093C";

function isDevConsonant(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 0x0915 && c <= 0x0939) || (c >= 0x0958 && c <= 0x095f) ||
    c === 0x0979 || c === 0x097a
  );
}

/** Greedy match of a base/conjunct cluster: C (nukta?) (virama C (nukta?))*. */
function matchDevCluster(text: string, i: number): string | null {
  let j = i;
  if (!isDevConsonant(text[j])) return null;
  j += 1;
  if (text[j] === DEV_NUKTA) j += 1;
  for (;;) {
    if (text[j] !== DEV_VIRAMA || !isDevConsonant(text[j + 1])) break;
    j += 2;
    if (text[j] === DEV_NUKTA) j += 1;
  }
  return text.slice(i, j);
}

/** Move provably-visual pre-base matras behind their cluster. */
export function fixDevanagariVisual(text: string): string {
  let needsFix = false;
  for (const ch of text) {
    if (DEV_PRE_MATRA.has(ch)) {
      needsFix = true;
      break;
    }
  }
  if (!needsFix) return text;
  let out = "";
  let prev = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (DEV_PRE_MATRA.has(ch)) {
      const cluster = matchDevCluster(text, i + 1);
      const ambiguous =
        isDevConsonant(prev) || prev === DEV_NUKTA; // logical reading exists
      if (cluster !== null && !ambiguous) {
        out += cluster + ch;
        prev = cluster[cluster.length - 1];
        i += 1 + cluster.length;
        continue;
      }
    }
    out += ch;
    prev = ch;
    i += 1;
  }
  return out;
}

/**
 * 1-based column index → spreadsheet reference letters: 1→A, 26→Z,
 * 27→AA, 702→ZZ, 16384→XFD. Returns "" for out-of-range input.
 */
export function colName(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 16384) return "";
  let name = "";
  let rest = n;
  while (rest > 0) {
    const rem = (rest - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    rest = Math.floor((rest - 1) / 26);
  }
  return name;
}

/** XML-escape text and drop XML-1.0-invalid control characters. */
export function xmlEscape(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Pure numbers ("42", "-3.5", "+7", "0.5") become Excel numeric cells;
 * anything else — leading zeros ("007" codes), thousands separators,
 * percentages, mixed text — stays text, honestly.
 */
const NUMERIC_RE = /^[+-]?(0|[1-9]\d*)(\.\d+)?$/;

export function numericValue(text: string): number | null {
  const t = text.trim();
  if (t.length === 0 || t.length > 15) return null;
  if (!NUMERIC_RE.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Excel sheet names: ≤31 chars, no []:*?/\, no leading/trailing
 *  apostrophe; duplicates get a numeric suffix (case-insensitive). */
export function sanitizeSheetName(
  raw: string,
  used: Set<string> = new Set()
): string {
  let name = raw
    .replace(/[\\/:*?[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^'+|'+$/g, "");
  if (name.length === 0) name = "Sheet";
  name = name.slice(0, 31);
  let candidate = name;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` ${n}`;
    candidate = name.slice(0, 31 - suffix.length) + suffix;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/* ----------------------------- extractGrid ---------------------------- */

interface Piece {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
}

/** A column anchor plus the x-range of everything merged into it. */
interface ColumnCluster {
  lo: number;
  hi: number;
  anchor: number;
}

/** A fully assembled visual row (before wrap-joining). */
interface GridRowRaw {
  y: number;
  size: number;
  cols: number[];
  cells: string[];
  hasText: boolean[];
}

/**
 * The core: cluster text items into rows (y-bands) and columns (x
 * clusters with a gap threshold), producing a rectangular grid. See the
 * header comment for the exact rules and their honest limits.
 */
export function extractGrid(
  items: GridTextItem[],
  options: GridExtractOptions = {}
): string[][] {
  const colTol = options.colTol ?? COL_MERGE_TOL;
  const wrapGapFactor = options.wrapGapFactor ?? WRAP_GAP_FACTOR;

  /* -- sanitize: collapse whitespace, drop empty/insane geometry -- */
  const pieces: Piece[] = [];
  for (const item of items) {
    if (typeof item?.str !== "string") continue;
    const str = item.str.replace(/\s+/g, " ").trim();
    if (str.length === 0) continue;
    const x = Number(item.x);
    const y = Number(item.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const w = Number.isFinite(Number(item?.w)) ? Math.max(0, Number(item.w)) : 0;
    const sizeRaw = Number(item?.size);
    pieces.push({ str, x, y, w, size: sizeRaw > 0 ? sizeRaw : 10 });
  }
  if (pieces.length === 0) return [];

  /* -- 1. visual rows: y-bands, top of the page first (PDF y is up) -- */
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: Piece[][] = [];
  let current: Piece[] = [sorted[0]];
  let groupY = sorted[0].y;
  let groupTol = Math.max(1.5, sorted[0].size * ROW_TOL_FACTOR);
  for (let i = 1; i < sorted.length; i += 1) {
    const piece = sorted[i];
    if (Math.abs(piece.y - groupY) <= groupTol) {
      current.push(piece);
    } else {
      groups.push(current);
      current = [piece];
      groupY = piece.y;
      groupTol = Math.max(1.5, piece.size * ROW_TOL_FACTOR);
    }
  }
  groups.push(current);

  /* -- 2. column anchors: unique x-starts, chain-merged within colTol -- */
  const xs = [...new Set(pieces.map((p) => p.x))].sort((a, b) => a - b);
  const clusters: ColumnCluster[] = [];
  let lo = xs[0];
  let hi = xs[0];
  for (let i = 1; i <= xs.length; i += 1) {
    if (i < xs.length && xs[i] - hi < colTol) {
      hi = xs[i];
      continue;
    }
    clusters.push({ lo, hi, anchor: (lo + hi) / 2 });
    if (i < xs.length) {
      lo = xs[i];
      hi = xs[i];
    }
  }

  /* -- 2b. co-occurrence refinement: adjacent anchors that never share
   *    a row are ONE logical column (right-aligned numbers, centered
   *    headers over ragged value widths). Iterate to a fixpoint. -- */
  function clusterOf(x: number): number {
    let idx = 0;
    for (let i = 0; i < clusters.length; i += 1) {
      if (clusters[i].lo <= x) idx = i;
      else break;
    }
    return idx;
  }
  for (;;) {
    const sets = groups.map(
      (group) => new Set(group.map((piece) => clusterOf(piece.x)))
    );
    let mergedPair = false;
    for (let i = 0; i + 1 < clusters.length && !mergedPair; i += 1) {
      const coOccurs = sets.some((set) => set.has(i) && set.has(i + 1));
      if (!coOccurs) {
        const a = clusters[i];
        const b = clusters[i + 1];
        clusters.splice(i, 2, {
          lo: a.lo,
          hi: b.hi,
          anchor: (a.anchor + b.anchor) / 2,
        });
        mergedPair = true;
      }
    }
    if (!mergedPair) break;
  }
  const columnCount = clusters.length;

  /* -- 3. assemble rows: assign pieces to (row, column), join cell
   *    pieces with a space wherever the horizontal gap exceeds a
   *    quarter of the font size (the pdf-to-txt rule) -- */
  const rowsRaw: GridRowRaw[] = groups.map((group) => {
    const byX = [...group].sort((a, b) => a.x - b.x);
    const cells: string[] = [];
    const hasText: boolean[] = [];
    const ends: number[] = [];
    let rowSize = 10;
    for (const piece of byX) {
      rowSize = Math.max(rowSize, piece.size);
      const col = clusterOf(piece.x);
      const end = ends[col];
      let text = cells[col] ?? "";
      if (text.length > 0 && piece.x - end > rowSize * CELL_SPACE_FACTOR) {
        text += " ";
      }
      cells[col] = text + piece.str;
      hasText[col] = true;
      ends[col] = Math.max(end ?? 0, piece.x + piece.w);
    }
    return {
      y: group[0].y,
      size: rowSize,
      cols: hasText.reduce<number[]>((list, has, i) => {
        if (has) list.push(i);
        return list;
      }, []),
      cells,
      hasText,
    };
  });

  /* -- 4. wrapped continuations: a tight line (gap ≤ wrapGapFactor ×
   *    size) whose columns are a PROPER subset of the open row above
   *    joins those cells. Equal sets never merge (dense table rows and
   *    plain text pages stay one row per line). -- */
  interface OpenRow extends GridRowRaw {
    lastY: number;
    union: Set<number>;
  }
  const merged: OpenRow[] = [];
  for (const row of rowsRaw) {
    const open = merged[merged.length - 1];
    if (open) {
      const gap = open.lastY - row.y;
      const tight =
        gap >= 0 && gap <= wrapGapFactor * Math.max(open.size, row.size);
      const properSubset =
        row.cols.length < open.union.size &&
        row.cols.every((c) => open.union.has(c));
      if (tight && properSubset) {
        for (const col of row.cols) {
          open.cells[col] = open.cells[col]
            ? `${open.cells[col]} ${row.cells[col]}`
            : row.cells[col];
        }
        for (const col of row.cols) open.union.add(col);
        open.lastY = row.y;
        continue;
      }
    }
    merged.push({ ...row, lastY: row.y, union: new Set(row.cols) });
  }

  /* -- 5. rectangular output: pad every row to the column count and
   *    repair visual-ordered Devanagari matras in each finished cell -- */
  return merged.map((row) =>
    Array.from({ length: columnCount }, (_, i) =>
      row.hasText[i]
        ? fixDevanagariVisual((row.cells[i] ?? "").trim())
        : ""
    )
  );
}

/* ------------------------------ buildXlsx ----------------------------- */

export interface XlsxSheet {
  name: string;
  rows: string[][];
}

export interface XlsxBuildOptions {
  /** Pure numbers become numeric cells (default true). */
  numericCells?: boolean;
  /** Row 1 of each sheet renders bold (default true). */
  boldHeader?: boolean;
}

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** One worksheet body — inline strings + explicit t="n" numeric cells. */
function sheetXml(
  rows: string[][],
  options: { numeric: boolean; bold: boolean }
): string {
  const parts: string[] = [
    XML_DECL,
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
  ];
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    let rowOpen = false;
    for (let c = 0; c < row.length; c += 1) {
      const text = row[c];
      if (text.length === 0) continue;
      if (!rowOpen) {
        parts.push(`<row r="${r + 1}">`);
        rowOpen = true;
      }
      const ref = `${colName(c + 1)}${r + 1}`;
      const style = options.bold && r === 0 ? ` s="1"` : "";
      const number = options.numeric ? numericValue(text) : null;
      if (number !== null) {
        parts.push(`<c r="${ref}"${style} t="n"><v>${number}</v></c>`);
      } else {
        parts.push(
          `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`
        );
      }
    }
    if (rowOpen) parts.push("</row>");
  }
  parts.push("</sheetData></worksheet>");
  return parts.join("");
}

/**
 * Build a minimal but VALID .xlsx (Office Open XML) package with fflate
 * zipSync: [Content_Types].xml, _rels/.rels, xl/workbook.xml + its
 * rels, xl/styles.xml (default + bold named style) and one worksheet
 * per sheet. Everything is clamped to the limits above.
 */
export function buildXlsx(
  sheets: XlsxSheet[],
  options: XlsxBuildOptions = {}
): Uint8Array {
  const numeric = options.numericCells !== false;
  const bold = options.boldHeader !== false;

  const used = new Set<string>();
  const clamped = sheets
    .slice(0, MAX_SHEETS)
    .map((sheet) => ({
      name: sanitizeSheetName(sheet.name, used),
      rows: sheet.rows
        .slice(0, MAX_ROWS_PER_SHEET)
        .map((row) => row.slice(0, MAX_COLS_PER_SHEET)),
    }));
  if (clamped.length === 0) {
    clamped.push({ name: sanitizeSheetName("Sheet", used), rows: [] });
  }

  /* [Content_Types].xml */
  const ctParts = [
    XML_DECL,
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
  ];
  clamped.forEach((_, i) => {
    ctParts.push(
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    );
  });
  ctParts.push("</Types>");

  /* _rels/.rels */
  const rootRels =
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>";

  /* xl/workbook.xml */
  const wbParts = [
    XML_DECL,
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>',
  ];
  clamped.forEach((sheet, i) => {
    wbParts.push(
      `<sheet name="${xmlEscape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
    );
  });
  wbParts.push("</sheets></workbook>");

  /* xl/_rels/workbook.xml.rels */
  const wbRelsParts = [
    XML_DECL,
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  ];
  clamped.forEach((_, i) => {
    wbRelsParts.push(
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    );
  });
  wbRelsParts.push(
    `<Relationship Id="rId${clamped.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    "</Relationships>"
  );

  /* xl/styles.xml — Calibri 11 default + a bold style (xf 1) */
  const styles =
    XML_DECL +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    "</cellXfs>" +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    "</styleSheet>";

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(ctParts.join("")),
    "_rels/.rels": strToU8(rootRels),
    "xl/workbook.xml": strToU8(wbParts.join("")),
    "xl/_rels/workbook.xml.rels": strToU8(wbRelsParts.join("")),
    "xl/styles.xml": strToU8(styles),
  };
  clamped.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      sheetXml(sheet.rows, { numeric, bold })
    );
  });

  return zipSync(files as Zippable, { level: 6 });
}

/* ------------------------------- run parse ---------------------------- */

export interface ExcelRunLabels {
  /** Output-name suffix ("spreadsheet" / "स्प्रेडशीट"). */
  fileWord: string;
  /** Per-page sheet prefix ("Page" / "पेज"). */
  pageWord: string;
  /** Fallback sheet title ("Sheet" / "शीट"). */
  sheetWord: string;
}

export interface ExcelRun {
  sheetMode: "single" | "perPage";
  numericCells: boolean;
  boldHeader: boolean;
  locale: "en" | "hi";
  labels: ExcelRunLabels;
}

/**
 * Boundary coercion for the serialized `excel` option: a tampered or
 * stale payload can never reach the builder as a wrong type, an
 * oversized label or an unknown mode. Unreadable JSON → defaults.
 */
export function parseRun(raw: string): ExcelRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const o = (typeof parsed === "object" && parsed !== null
    ? parsed
    : {}) as Record<string, unknown>;
  const labelsIn = (typeof o.labels === "object" && o.labels !== null
    ? o.labels
    : {}) as Record<string, unknown>;
  const label = (value: unknown, max: number): string =>
    typeof value === "string"
      ? value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max)
      : "";
  return {
    sheetMode: o.sheetMode === "perPage" ? "perPage" : "single",
    numericCells: o.numericCells !== false,
    boldHeader: o.boldHeader !== false,
    locale: o.locale === "hi" ? "hi" : "en",
    labels: {
      fileWord: label(labelsIn.fileWord, 40),
      pageWord: label(labelsIn.pageWord, 16) || "Page",
      sheetWord: label(labelsIn.sheetWord, 16) || "Sheet",
    },
  };
}

/* ------------------------------- naming ------------------------------- */

/** "Annual report.pdf" → "Annual-report" (unicode-safe, path-free). */
export function excelBaseName(fileName: string): string {
  const base = fileName
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base;
}

/** Output name: base + localized "-spreadsheet" suffix + .xlsx. */
export function buildOutputName(base: string, fileWord: string): string {
  const parts = [base.trim(), fileWord.trim()]
    .filter((part) => part.length > 0)
    .map((part) => part.slice(0, 60));
  const joined = parts.join("-").slice(0, 100);
  return `${joined || "spreadsheet"}.xlsx`;
}
