/**
 * Excel to PDF — pure model (RB1-c, the 69th MyCloudy tool). No DOM, no
 * pdf-lib, no storage: an OOXML (.xlsx/.xlsm) reader built on fflate's
 * unzipSync plus a dependency-free XML tokenizer (no DOMParser in
 * workers), the worker-boundary option coercion and the font-pick
 * helper. The same module runs on the main thread (surface live
 * summary) and inside the worker (the real render).
 *
 *  - parseXlsx(bytes): xl/workbook.xml (sheet names + r:id) →
 *    xl/_rels/workbook.xml.rels (rId → worksheets/sheetN.xml) →
 *    xl/sharedStrings.xml (indexed strings, rich runs concatenated,
 *    phonetic runs skipped) → xl/styles.xml (bold fonts + date number
 *    formats, best-effort) → each worksheet (r="B3" ref parse, t="s"
 *    shared index, t="inlineStr", t="str", t="b", t="n"; dates are
 *    Excel serials converted through the 1899-12-30 epoch when the
 *    cell's style says date — otherwise the raw number is printed
 *    honestly).
 *  - Hard caps with honest truncation flags: 10 sheets, 500 rows,
 *    100 columns per sheet (FAQ documents them).
 *  - needsNoto: WinAnsi check copied from create-resume (CR-66) — ₹
 *    (U+20B9) is NOT in WinAnsi, so any rupee forces the embedded
 *    Noto Sans Devanagari subset.
 *  - parseExcelRun: worker-boundary coercion + clamps (parseResumeRun
 *    pattern) — a tampered options payload can never reach the
 *    renderer as a wrong type.
 */

import { unzipSync, type Unzipped } from "fflate";

/* ------------------------------------------------------------------ */
/* Hard caps (documented in the FAQ + surfaced as honest badges)        */
/* ------------------------------------------------------------------ */

export const MAX_SHEETS = 10;
export const MAX_ROWS = 500;
export const MAX_COLS = 100;
/** per-cell text cap — longer strings are cut honestly */
export const MAX_CELL_CHARS = 2000;
/** natural column width bounds (pt) before fit-scaling */
export const MIN_COL_PT = 40;
export const MAX_COL_PT = 200;

/** Option ids shared by the surface, the worker boundary and the smoke. */
export const OPT_IDS = {
  sheets: "xlSheetIds",
  pageSize: "xlPageSize",
  orientation: "xlOrientation",
  fit: "xlFit",
  zebra: "xlZebra",
  footer: "xlFooter",
  fileWord: "xlFileWord",
} as const;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface XlsxCell {
  /** Display value (already stringified: TRUE/FALSE, dates as ISO). */
  v: string;
  /** Bold cell (from xl/styles.xml fonts — best-effort). */
  bold?: boolean;
}

export interface XlsxSheet {
  name: string;
  /** Dense rows; missing cells are {v: ""}; trailing blanks trimmed. */
  rows: XlsxCell[][];
}

export interface ParsedWorkbook {
  sheets: XlsxSheet[];
  /** true when the file had more than MAX_SHEETS sheets (first 10 kept). */
  sheetsTruncated: boolean;
  /** original sheet count (before the 10-sheet cap). */
  totalSheetsSeen: number;
  /** true when at least one sheet exceeded MAX_ROWS rows. */
  rowsTruncated: boolean;
  /** true when at least one sheet exceeded MAX_COLS columns. */
  colsTruncated: boolean;
}

export type ExcelPageSize = "a4" | "letter";
export type ExcelOrientation = "portrait" | "landscape";

export interface ExcelRun {
  /** Ordered sheet selection (a subset of the workbook's names). */
  sheetNames: string[];
  pageSize: ExcelPageSize;
  orientation: ExcelOrientation;
  fit: boolean;
  zebra: boolean;
  /** Localized footer template containing {n} and {m}. */
  footerFmt: string;
  /** Localized fallback output name word ("Spreadsheet"). */
  fileWord: string;
}

/* ------------------------------------------------------------------ */
/* Error codes thrown by parseXlsx (mapped to i18n keys in the worker) */
/* ------------------------------------------------------------------ */

export type XlsxErrorCode =
  | "xlsx-legacy"
  | "xlsx-not-zip"
  | "xlsx-not-ooxml"
  | "xlsx-corrupt"
  | "xlsx-empty";

export class XlsxParseError extends Error {
  readonly code: XlsxErrorCode;
  constructor(code: XlsxErrorCode) {
    super(code);
    this.code = code;
    this.name = "XlsxParseError";
  }
}

/* ------------------------------------------------------------------ */
/* Magic sniffing (shared by the surface DropZone + the worker)         */
/* ------------------------------------------------------------------ */

/** Legacy .xls (OLE2 compound document) — the honest "convert first" case. */
export function isLegacyXlsBytes(head: Uint8Array): boolean {
  return (
    head.length >= 8 &&
    head[0] === 0xd0 &&
    head[1] === 0xcf &&
    head[2] === 0x11 &&
    head[3] === 0xe0 &&
    head[4] === 0xa1 &&
    head[5] === 0xb1 &&
    head[6] === 0x1a &&
    head[7] === 0xe1
  );
}

/** ZIP local-file magic "PK\x03\x04" (empty/spanned zips rejected). */
export function isZipBytes(head: Uint8Array): boolean {
  return (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    head[2] === 0x03 &&
    head[3] === 0x04
  );
}

/* ------------------------------------------------------------------ */
/* WinAnsi detection → Helvetica vs embedded Noto (create-resume copy) */
/* ------------------------------------------------------------------ */

const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/** true when every char is encodable in WinAnsi (CP1252) minus controls. */
export function isWinAnsiText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) continue;
    if (c >= 0xa0 && c <= 0xff) continue;
    if (WINANSI_EXTRA.has(c)) continue;
    return false;
  }
  return true;
}

/**
 * true → the renderer must embed the self-hosted Noto Sans Devanagari
 * (fontkit subset); false → pure-WinAnsi content stays on the base-14
 * Helvetica. ₹ is NOT in WinAnsi, so Indian rupee cells flip to Noto.
 */
export function needsNoto(sheets: XlsxSheet[]): boolean {
  for (const sheet of sheets) {
    if (!isWinAnsiText(sheet.name)) return true;
    for (const row of sheet.rows) {
      for (const cell of row) {
        if (cell.v && !isWinAnsiText(cell.v)) return true;
      }
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* XML tokenizer (dependency-free — no DOMParser in workers)            */
/* ------------------------------------------------------------------ */

export interface XmlAttrMap {
  [name: string]: string;
}

export type XmlEvent =
  | { kind: "open"; name: string; attrs: XmlAttrMap; selfClose: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string };

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Decodes &amp; &lt; &gt; &quot; &apos; &#NN; &#xHH; (unknown pass through). */
export function decodeXmlEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(
    /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (whole, entity: string) => {
      if (entity.startsWith("#")) {
        const code =
          entity[1] === "x" || entity[1] === "X"
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
          try {
            return String.fromCodePoint(code);
          } catch {
            return whole;
          }
        }
        return whole;
      }
      const named = NAMED_ENTITIES[entity];
      return named !== undefined ? named : whole;
    }
  );
}

/**
 * Streams XML as open/close/text events. The callback may return false
 * to abort the scan early (used by the row cap). Comments, PIs, DOCTYPE
 * and CDATA are handled; attribute names keep their prefixes ("r:id").
 */
export function scanXml(
  xml: string,
  onEvent: (event: XmlEvent) => boolean | void
): void {
  const n = xml.length;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0; // strip BOM
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      if (i < n) onEvent({ kind: "text", text: decodeXmlEntities(xml.slice(i)) });
      return;
    }
    if (lt > i) {
      if (onEvent({ kind: "text", text: decodeXmlEntities(xml.slice(i, lt)) }) === false) return;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (xml.startsWith("!--", lt + 1)) {
      const end = xml.indexOf("-->", lt);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("![CDATA[", lt + 1)) {
      const end = xml.indexOf("]]>", lt + 9);
      const stop = end < 0 ? n : end;
      if (onEvent({ kind: "text", text: xml.slice(lt + 9, stop) }) === false) return;
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("!", lt + 1)) {
      // DOCTYPE etc. — skip to the matching ">"
      const end = xml.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    // find the closing ">" that is not inside a quoted attribute value
    let j = lt + 1;
    let quote = 0;
    while (j < n) {
      const ch = xml.charCodeAt(j);
      if (quote !== 0) {
        if (ch === quote) quote = 0;
      } else if (ch === 0x22 || ch === 0x27) {
        quote = ch;
      } else if (ch === 0x3e) {
        break;
      }
      j++;
    }
    if (j >= n) return; // malformed tail
    const inner = xml.slice(lt + 1, j);
    i = j + 1;
    if (inner.charCodeAt(0) === 0x2f) {
      // "</name>"
      if (onEvent({ kind: "close", name: inner.slice(1).trim() }) === false) return;
      continue;
    }
    const selfClose = inner.charCodeAt(inner.length - 1) === 0x2f;
    const body = selfClose ? inner.slice(0, -1) : inner;
    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const attrs: XmlAttrMap = {};
    const attrRe = /([^\s=/<>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(body)) !== null) {
      const raw = am[2] !== undefined ? am[2] : am[3] ?? "";
      attrs[am[1]] = decodeXmlEntities(raw);
    }
    if (onEvent({ kind: "open", name, attrs, selfClose }) === false) return;
  }
}

/* ------------------------------------------------------------------ */
/* Cell ref parsing ("B3" → col 2, row 3)                              */
/* ------------------------------------------------------------------ */

/** "A" → 1, "B" → 2, "AA" → 27 (Excel base-26). */
export function colLettersToIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    const c = letters.charCodeAt(i);
    if (c < 65 || (c > 90 && c < 97) || c > 122) return 0;
    const v = c <= 90 ? c - 64 : c - 96;
    n = n * 26 + v;
  }
  return n;
}

export function parseCellRef(ref: string): { col: number; row: number } | null {
  const m = /^([A-Za-z]+)([0-9]+)$/.exec(ref.trim());
  if (!m) return null;
  const col = colLettersToIndex(m[1]);
  const row = Number.parseInt(m[2], 10);
  if (col < 1 || row < 1) return null;
  return { col, row };
}

/* ------------------------------------------------------------------ */
/* Excel date serials (1899-12-30 epoch; 1904 system honoured)          */
/* ------------------------------------------------------------------ */

const EPOCH_1900_MS = Date.UTC(1899, 11, 30);
const EPOCH_1904_MS = Date.UTC(1904, 0, 1);
const MAX_SERIAL = 2958465; // 9999-12-31

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Converts an Excel serial to "YYYY-MM-DD" (date) or "YYYY-MM-DD HH:MM"
 * (when the serial carries a time part ≥ ~30 s). Returns "" when the
 * value is not a plausible date (< 61 dodges the 1900 leap-year bug
 * zone, > MAX_SERIAL, non-finite) — the caller then prints the raw
 * number honestly.
 */
export function excelSerialToDateString(
  serial: number,
  date1904 = false
): string {
  if (!Number.isFinite(serial) || serial < 61 || serial > MAX_SERIAL) return "";
  const epoch = date1904 ? EPOCH_1904_MS : EPOCH_1900_MS;
  const ms = epoch + Math.round(serial * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const frac = serial - Math.floor(serial);
  if (frac >= 0.00035) {
    return `${date} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  }
  return date;
}

/* ------------------------------------------------------------------ */
/* Cell text cleaning                                                  */
/* ------------------------------------------------------------------ */

function cleanCellText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // keep \t; newlines become spaces (cells wrap, they don't break lines)
    if ((c >= 0x20 && c <= 0x7e) || c >= 0xa0 || c === 0x09) out += s[i];
    else if (c === 0x0a || c === 0x0d) out += " ";
  }
  return out.length > MAX_CELL_CHARS ? out.slice(0, MAX_CELL_CHARS) : out;
}

/* ------------------------------------------------------------------ */
/* Part parsers                                                        */
/* ------------------------------------------------------------------ */

interface SheetRef {
  name: string;
  rid: string;
}

function parseWorkbook(xml: string): { sheets: SheetRef[]; date1904: boolean } {
  const sheets: SheetRef[] = [];
  let date1904 = false;
  scanXml(xml, (e) => {
    if (e.kind === "open" && e.name === "workbookPr") {
      const flag = e.attrs.date1904 ?? "";
      date1904 = flag === "1" || flag.toLowerCase() === "true";
      return;
    }
    if (e.kind !== "open" || e.name !== "sheet") return;
    const name = e.attrs.name ?? "";
    const rid = e.attrs["r:id"] ?? e.attrs.rid ?? "";
    if (name) sheets.push({ name, rid });
  });
  return { sheets, date1904 };
}

/** rId → normalized "xl/worksheets/sheetN.xml" part path. */
function parseWorkbookRels(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  scanXml(xml, (e) => {
    if (e.kind !== "open" || e.name !== "Relationship") return;
    const id = e.attrs.Id ?? "";
    let target = (e.attrs.Target ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!id || !target) return;
    if (!target.startsWith("xl/")) target = `xl/${target}`;
    map.set(id, target);
  });
  return map;
}

/** Indexed shared strings; rich <r><t> runs concatenated, <rPh> skipped. */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  let inSi = false;
  let inPh = false;
  let inT = false;
  let buf = "";
  scanXml(xml, (e) => {
    if (e.kind === "open") {
      if (e.name === "si") {
        inSi = true;
        inPh = false;
        inT = false;
        buf = "";
      } else if (inSi && e.name === "rPh") {
        inPh = true;
      } else if (inSi && !inPh && e.name === "t") {
        inT = true;
      }
      return;
    }
    if (e.kind === "close") {
      if (e.name === "t") inT = false;
      else if (e.name === "rPh") inPh = false;
      else if (e.name === "si") {
        out.push(cleanCellText(buf));
        inSi = false;
      }
      return;
    }
    if (e.kind === "text" && inSi && inT && !inPh) buf += e.text;
  });
  return out;
}

interface StyleInfo {
  bold: boolean;
  date: boolean;
}

const BUILTIN_DATE_FMTS = new Set<number>([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47,
]);

/** true when a custom formatCode looks like a date (after [..] and ".."). */
function formatCodeIsDate(code: string): boolean {
  const stripped = code
    .replace(/\[[^\]]*\]/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "");
  return /[ymdhs]/i.test(stripped);
}

/**
 * Minimal styles parse: bold font flags + date number formats → the
 * per-xf StyleInfo cells reference with s="N" (best-effort, optional).
 */
function parseStyles(xml: string): StyleInfo[] {
  const fontBold: boolean[] = [];
  const customDate = new Map<number, boolean>();
  const cellXfs: StyleInfo[] = [];
  let zone: "fonts" | "numFmts" | "cellXfs" | null = null;
  let fontIsBold = false;
  scanXml(xml, (e) => {
    if (e.kind === "open") {
      if (e.name === "fonts" || e.name === "numFmts" || e.name === "cellXfs") {
        zone = e.name;
        return;
      }
      if (zone === "fonts" && e.name === "font") {
        fontIsBold = false;
        return;
      }
      if (zone === "fonts" && e.name === "b") {
        fontIsBold = true;
        return;
      }
      if (zone === "numFmts" && e.name === "numFmt") {
        const id = Number.parseInt(e.attrs.numFmtId ?? "", 10);
        const code = e.attrs.formatCode ?? "";
        if (Number.isFinite(id)) customDate.set(id, formatCodeIsDate(code));
        return;
      }
      if (zone === "cellXfs" && e.name === "xf") {
        const fontId = Number.parseInt(e.attrs.fontId ?? "", 10);
        const fmtId = Number.parseInt(e.attrs.numFmtId ?? "", 10);
        cellXfs.push({
          bold: Number.isFinite(fontId) ? (fontBold[fontId] ?? false) : false,
          date: Number.isFinite(fmtId)
            ? BUILTIN_DATE_FMTS.has(fmtId) || (customDate.get(fmtId) ?? false)
            : false,
        });
        return;
      }
      return;
    }
    if (e.kind === "close") {
      if (e.name === "font") fontBold.push(fontIsBold);
      else if (e.name === "fonts" || e.name === "numFmts" || e.name === "cellXfs") {
        zone = null;
      }
    }
  });
  return cellXfs;
}

/* ------------------------------------------------------------------ */
/* Worksheet parse                                                     */
/* ------------------------------------------------------------------ */

function parseSheetXml(
  xml: string,
  shared: string[],
  styles: StyleInfo[],
  date1904: boolean
): { rows: XlsxCell[][]; colsTruncated: boolean } {
  const grid: (XlsxCell | undefined)[][] = [];
  let colsTruncated = false;
  let rowNumber = 0;
  let colNumber = 0;
  let inCell = false;
  let cellType = "n";
  let cellStyle = -1;
  let cellCol = 0;
  let vText = "";
  let fText = "";
  let inlineText = "";
  let inV = false;
  let inF = false;
  let inIs = false;
  let inIsT = false;

  const ensureRow = (r0: number): XlsxCell[] => {
    let row = grid[r0] as XlsxCell[] | undefined;
    if (!row) {
      row = [];
      grid[r0] = row;
    }
    return row;
  };

  scanXml(xml, (e) => {
    if (e.kind === "open") {
      switch (e.name) {
        case "row": {
          const r = Number.parseInt(e.attrs.r ?? "", 10);
          rowNumber = Number.isFinite(r) && r >= 1 ? r : rowNumber + 1;
          if (rowNumber > MAX_ROWS) return false; // honest row cap
          ensureRow(rowNumber - 1);
          colNumber = 0;
          return;
        }
        case "c": {
          const ref = parseCellRef(e.attrs.r ?? "");
          if (ref) {
            colNumber = ref.col;
            if (rowNumber < 1) {
              // stray cell before any row element — implied row 1
              rowNumber = ref.row;
              ensureRow(rowNumber - 1);
            }
          } else {
            colNumber += 1;
          }
          cellCol = colNumber;
          if (cellCol > MAX_COLS) {
            colsTruncated = true;
            inCell = false;
            return;
          }
          inCell = true;
          cellType = e.attrs.t ?? "n";
          const s = Number.parseInt(e.attrs.s ?? "", 10);
          cellStyle = Number.isFinite(s) ? s : -1;
          vText = "";
          fText = "";
          inlineText = "";
          inV = false;
          inF = false;
          inIs = false;
          inIsT = false;
          return;
        }
        case "v":
          if (inCell) inV = true;
          return;
        case "f":
          if (inCell) inF = true;
          return;
        case "is":
          if (inCell) inIs = true;
          return;
        case "t":
          if (inIs) inIsT = true;
          return;
        default:
          return;
      }
    }
    if (e.kind === "close") {
      switch (e.name) {
        case "v":
          inV = false;
          return;
        case "f":
          inF = false;
          return;
        case "t":
          inIsT = false;
          return;
        case "is":
          inIs = false;
          return;
        case "c": {
          if (!inCell) return;
          inCell = false;
          if (cellCol < 1 || cellCol > MAX_COLS || rowNumber < 1 || rowNumber > MAX_ROWS) {
            return;
          }
          const style =
            cellStyle >= 0 && cellStyle < styles.length ? styles[cellStyle] : null;
          let value = "";
          switch (cellType) {
            case "s": {
              const idx = Number.parseInt(vText, 10);
              value = Number.isFinite(idx) ? (shared[idx] ?? "") : "";
              break;
            }
            case "inlineStr":
              value = inlineText;
              break;
            case "str":
              // formula string result — the cached text in <v>; when
              // the cache is missing, the raw formula text (honest)
              value = vText || (fText ? `=${fText}` : "");
              break;
            case "b":
              value = vText.trim() === "1" ? "TRUE" : "FALSE";
              break;
            case "e":
              value = vText; // #DIV/0! etc. — shown verbatim
              break;
            case "d":
              value = vText.slice(0, 10); // ISO date string
              break;
            default: {
              // "n" or missing → number; date styles convert via epoch
              if (vText === "") {
                value = fText ? `=${fText}` : "";
                break;
              }
              if (style?.date) {
                const serial = Number.parseFloat(vText);
                if (Number.isFinite(serial)) {
                  const dateStr = excelSerialToDateString(serial, date1904);
                  if (dateStr) {
                    value = dateStr;
                    break;
                  }
                }
              }
              // honest raw number (rounded to dodge JS float noise)
              const num = Number.parseFloat(vText);
              value = Number.isFinite(num)
                ? String(Math.round(num * 1e10) / 1e10)
                : vText;
              break;
            }
          }
          const row = ensureRow(rowNumber - 1);
          if (value !== "") {
            row[cellCol - 1] = {
              v: value,
              bold: style?.bold ? true : undefined,
            };
          } else if (row[cellCol - 1]) {
            row[cellCol - 1] = { v: "" };
          }
          return;
        }
        default:
          return;
      }
    }
    // text content
    if (inV) vText += e.text;
    else if (inF) fText += e.text;
    else if (inIsT) inlineText += e.text;
  });

  // densify: fill holes with empty cells, trim trailing blanks
  const rows: XlsxCell[][] = [];
  for (let r = 0; r < grid.length; r++) {
    const src = grid[r];
    if (!src) {
      rows.push([]);
      continue;
    }
    let last = -1;
    for (let c = 0; c < src.length; c++) {
      if (src[c] && src[c]!.v !== "") last = c;
    }
    const dense: XlsxCell[] = [];
    for (let c = 0; c <= last; c++) {
      dense.push(src[c] ?? { v: "" });
    }
    rows.push(dense);
  }
  while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop();
  return { rows, colsTruncated };
}

/* ------------------------------------------------------------------ */
/* parseXlsx                                                           */
/* ------------------------------------------------------------------ */

function readPart(files: Unzipped, decoder: TextDecoder, path: string): string {
  const entry = files[path];
  if (!entry) return "";
  return decoder.decode(entry);
}

/**
 * Parses an OOXML workbook (.xlsx/.xlsm) from raw bytes. Throws
 * XlsxParseError with an honest code for everything that is not a
 * readable spreadsheet (legacy .xls, plain zips, corrupt parts).
 */
export function parseXlsx(bytes: Uint8Array): ParsedWorkbook {
  if (isLegacyXlsBytes(bytes.subarray(0, 8))) {
    throw new XlsxParseError("xlsx-legacy");
  }
  if (!isZipBytes(bytes.subarray(0, 4))) {
    throw new XlsxParseError("xlsx-not-zip");
  }
  let files: Unzipped;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new XlsxParseError("xlsx-corrupt");
  }
  const decoder = new TextDecoder("utf-8");
  if (!readPart(files, decoder, "[Content_Types].xml")) {
    throw new XlsxParseError("xlsx-not-ooxml");
  }
  const workbookXml = readPart(files, decoder, "xl/workbook.xml");
  if (!workbookXml) {
    throw new XlsxParseError("xlsx-not-ooxml");
  }
  const relsXml = readPart(files, decoder, "xl/_rels/workbook.xml.rels");
  const relTargets = relsXml
    ? parseWorkbookRels(relsXml)
    : new Map<string, string>();
  const { sheets: sheetRefs, date1904 } = parseWorkbook(workbookXml);

  const sharedXml = readPart(files, decoder, "xl/sharedStrings.xml");
  const shared = sharedXml ? parseSharedStrings(sharedXml) : [];
  const stylesXml = readPart(files, decoder, "xl/styles.xml");
  const styles = stylesXml ? parseStyles(stylesXml) : [];

  const sheets: XlsxSheet[] = [];
  let rowsTruncated = false;
  let colsTruncated = false;
  let totalSheetsSeen = 0;
  const seenNames = new Set<string>();
  for (const ref of sheetRefs) {
    totalSheetsSeen++;
    if (sheets.length >= MAX_SHEETS) continue; // honest sheet cap
    const target = ref.rid ? relTargets.get(ref.rid) : undefined;
    if (!target || !/\.xml$/i.test(target)) continue; // .xlsb binaries etc.
    const sheetXml = readPart(files, decoder, target);
    if (!sheetXml) continue;
    const parsed = parseSheetXml(sheetXml, shared, styles, date1904);
    if (parsed.colsTruncated) colsTruncated = true;
    if (parsed.rows.length >= MAX_ROWS) rowsTruncated = true;
    // duplicate sheet names would confuse the picker — dedupe honestly
    let name = ref.name;
    let n = 2;
    while (seenNames.has(name)) {
      name = `${ref.name} (${n})`;
      n++;
    }
    seenNames.add(name);
    sheets.push({ name, rows: parsed.rows });
  }

  if (sheets.length === 0) {
    throw new XlsxParseError("xlsx-empty");
  }

  return {
    sheets,
    sheetsTruncated: totalSheetsSeen > sheets.length,
    totalSheetsSeen,
    rowsTruncated,
    colsTruncated,
  };
}

/* ------------------------------------------------------------------ */
/* Column width heuristic (feeds the renderer)                          */
/* ------------------------------------------------------------------ */

/**
 * Natural column widths in pt from content length: ~5.6 pt per char at
 * 9 pt body size + padding, clamped to [40, 200]. The renderer then
 * fit-scales these to the page width.
 */
export function computeColumnWidths(sheet: XlsxSheet): number[] {
  const ncols = sheet.rows.reduce((m, row) => Math.max(m, row.length), 0);
  const widths = new Array<number>(ncols).fill(MIN_COL_PT);
  for (const row of sheet.rows) {
    for (let c = 0; c < row.length && c < ncols; c++) {
      const len = row[c]?.v.length ?? 0;
      // only grow for the first 48 chars per column — long cells wrap
      // anyway, they must not stretch columns to absurd widths
      const eff = Math.min(len, 48);
      const w = 10 + eff * 5.6;
      if (w > widths[c]) widths[c] = w;
    }
  }
  for (let c = 0; c < ncols; c++) {
    widths[c] = Math.min(MAX_COL_PT, Math.max(MIN_COL_PT, widths[c]));
  }
  return widths;
}

/* ------------------------------------------------------------------ */
/* Sheet selection + worker-boundary coercion                          */
/* ------------------------------------------------------------------ */

/**
 * Coerces a raw sheet-selection value (JSON string or array, from the
 * surface's serialized option) into an ordered, de-duplicated list of
 * names that actually exist in the workbook. Empty/unparseable → all.
 */
export function parseSheetSelection(raw: unknown, available: string[]): string[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = [];
    }
  }
  const allowed = new Set(available);
  const picked = new Set<string>();
  for (const item of list) {
    if (typeof item === "string" && allowed.has(item)) picked.add(item);
  }
  if (picked.size === 0) return available.slice(0, MAX_SHEETS);
  // preserve workbook order, cap the count
  return available.filter((name) => picked.has(name)).slice(0, MAX_SHEETS);
}

function cleanLabel(raw: unknown, fallback: string, max: number): string {
  if (typeof raw !== "string") return fallback;
  let s = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c >= 0x20 || c === 0x0a) s += raw[i];
  }
  s = s.trim();
  if (s === "") return fallback;
  return s.length > max ? s.slice(0, max) : s;
}

const DEFAULT_FOOTER_FMT = "Sheet {n} of {m}";

function coerceFooterFmt(raw: unknown): string {
  const s = cleanLabel(raw, "", 60);
  if (s.includes("{n}") && s.includes("{m}")) return s;
  return DEFAULT_FOOTER_FMT;
}

/**
 * Worker-boundary parser: coerces the raw options record (typed as
 * unknown — it crossed the postMessage boundary) into a fully-clamped
 * ExcelRun. Garbage can never reach the renderer as a wrong type.
 */
export function parseExcelRun(raw: unknown, available: string[]): ExcelRun {
  const rec =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const pageSize: ExcelPageSize =
    rec[OPT_IDS.pageSize] === "letter" ? "letter" : "a4";
  const orientation: ExcelOrientation =
    rec[OPT_IDS.orientation] === "landscape" ? "landscape" : "portrait";
  return {
    sheetNames: parseSheetSelection(rec[OPT_IDS.sheets], available),
    pageSize,
    orientation,
    fit: rec[OPT_IDS.fit] === undefined ? true : rec[OPT_IDS.fit] === true,
    zebra: rec[OPT_IDS.zebra] === true,
    footerFmt: coerceFooterFmt(rec[OPT_IDS.footer]),
    fileWord: cleanLabel(rec[OPT_IDS.fileWord], "Spreadsheet", 40),
  };
}

/* ------------------------------------------------------------------ */
/* Output name                                                         */
/* ------------------------------------------------------------------ */

/** Strips the extension + path-unsafe chars from a download base name. */
export function safeOutputBase(name: string, fallback: string): string {
  const base = name.replace(/\.(xlsx|xlsm|xlsb|xls)$/i, "");
  let cleaned = "";
  for (let i = 0; i < base.length; i++) {
    const ch = base[i];
    const c = base.charCodeAt(i);
    cleaned +=
      c >= 0x20 && !/[\\/:*?"<>|]/.test(ch) ? ch : "_";
  }
  cleaned = cleaned.trim().replace(/\s+/g, "-");
  if (cleaned !== "") return cleaned.slice(0, 80);
  return fallback !== "" ? fallback.slice(0, 80) : "spreadsheet";
}
