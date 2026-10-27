import { unzipSync } from "fflate";

import { scanXmlTags, unescapeXml } from "../word-to-pdf/docx-parse";

/**
 * XLSX parser (Task b4-a) — PURE, bun-testable, no DOM, no worker APIs.
 *
 * A .xlsx is an OOXML package: a ZIP whose parts are XML documents. This
 * module opens the package with fflate's unzipSync (the same library the
 * app's writers use) and parses the four parts excel-to-pdf needs:
 *
 *   xl/workbook.xml              — the sheet list (name + r:id per sheet)
 *   xl/_rels/workbook.xml.rels   — rId → worksheet part path
 *   xl/worksheets/sheetN.xml     — cell data (the scanner below)
 *   xl/sharedStrings.xml         — the shared string table (t="s" cells)
 *   xl/styles.xml                — bold flags + date number formats
 *
 * CELL TYPES understood (the whole honest v1 set):
 *   t="inlineStr"  <c r="A1" t="inlineStr"><is><t>…</t></is></c>
 *                  — what OUR pdf-to-excel emitter writes (rich <is><r>
 *                  runs join too);
 *   t="s"          <c r="A1" t="s"><v>N</v></c> — shared string index,
 *                  the default REAL Excel writes for every text cell;
 *   t="str"        <c r="A1" t="str"><f>…</f><v>cached</v></c> — a
 *                  formula's CACHED string result (the formula itself
 *                  is never recalculated — the cached value is rendered);
 *   t="b"          <v>1</v> → "TRUE" / <v>0</v> → "FALSE";
 *   t="e"          the cached error literal ("#DIV/0!"…) verbatim;
 *   (no t attr)    <v>12</v> — a plain number, rendered as its stored
 *                  value (the sheet's own number FORMAT is not rebuilt
 *                  — EXCEPT date formats, see below).
 *
 * DATES (the one number-format special case, deliberately): real
 * spreadsheets store dates as serial numbers with a date numFmt, and
 * rendering "45123" where the user sees a date would be a lie about the
 * file's content. Number formats 14-22 / 45-47 (the built-in date/time
 * codes) plus any custom <numFmt> whose code carries date/time letters
 * mark the cell as a date; it renders as a neutral "YYYY-MM-DD" (plus
 * "HH:MM" when the format has time). Currency symbols, thousands
 * separators and the sheet's exact display codes are NOT rebuilt (FAQ).
 *
 * BOLD: styles.xml only, exactly as scoped — cellXfs → fontId → the
 * font's <b/> flag. Rich-run formatting INSIDE shared strings (partial
 * bold) is not rebuilt.
 *
 * r="A1" refs → column index (A=0) + row number; cells/rows without
 * refs fall back to positional counters (some generators omit them).
 * The grid size is the MAX CELL SCAN (the <dimension> tag is only a
 * hint — broken generators lie about it); fully-empty trailing rows
 * and columns are trimmed.
 *
 * Bounds (honest, documented in the FAQ): rows past 10,000 and columns
 * past 128 are dropped at parse time so a pathological sheet cannot
 * hang the worker.
 *
 * Structural failures throw XlsxParseError: "not-zip" for anything
 * unzipSync rejects (the worker checks the legacy .xls OLE magic
 * BEFORE calling in, so it can say that honestly instead), "not-xlsx"
 * for a zip without xl/workbook.xml or with a non-UTF-8 workbook part.
 * Broken optional parts (a single unreadable sheet, a bad styles part)
 * degrade gracefully — the sheet is skipped / styles fall back to
 * plain, and an all-empty selection still fails honestly downstream.
 *
 * iOS-safe (worklog IOS-COMPAT): no matchAll/replaceAll, no regex
 * lookbehind, no Object.hasOwn / structuredClone.
 */

/* ------------------------------------------------------------------ */
/* Limits + geometry constants                                         */
/* ------------------------------------------------------------------ */

/** Rows rendered per sheet (beyond → dropped, the FAQ says so). */
export const MAX_PARSE_ROWS = 10_000;
/** Columns rendered per sheet (beyond → dropped, the FAQ says so). */
export const MAX_PARSE_COLS = 128;
/** Excel char-unit column width → approx pt (1 char ≈ 7px @96dpi). */
export const EXCEL_CHAR_PT = 5.25;

/* ------------------------------------------------------------------ */
/* Cell refs                                                           */
/* ------------------------------------------------------------------ */

/** "A1" / "$BC$12" → 0-based column + 1-based row, or null. */
export function parseCellRef(ref: string): { col: number; row: number } | null {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim());
  if (match === null) return null;
  let col = 0;
  for (let i = 0; i < match[1].length; i += 1) {
    col = col * 26 + (match[1].charCodeAt(i) & 0x1f);
  }
  const row = Number.parseInt(match[2], 10);
  if (!Number.isFinite(row) || row < 1 || col < 1) return null;
  return { col: col - 1, row };
}

/* ------------------------------------------------------------------ */
/* Number formats (the date special case)                              */
/* ------------------------------------------------------------------ */

/** The built-in date/time format codes (ids 14-22 + 45-47). */
const BUILTIN_DATE_FORMATS: Record<number, string> = {
  14: "mm-dd-yy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "hh:mm",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yy h:mm",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mm:ss.0",
};

/** What a number cell's format makes it. */
export type CellFormatKind = "number" | "date" | "datetime" | "time";

/**
 * True when a format code carries date/time meaning: any d/e/m/y/h/s
 * letter OUTSIDE quoted literals ("USD"), escaped chars (\.) and
 * bracketed sections ([Red], [h], [$-409]) means date or time.
 * "General", "" and "@" are plain.
 */
export function isDateFormatCode(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "")
    .trim();
  if (bare.length === 0 || bare === "@" || /^general$/i.test(bare)) {
    return false;
  }
  return /[dmyhs]/i.test(bare);
}

/** Classifies one format code into the render kinds. */
function classifyFormatCode(code: string): CellFormatKind {
  const bare = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "");
  if (!isDateFormatCode(bare)) return "number";
  const date = /[dy]/i.test(bare);
  const time = /[hs]/i.test(bare);
  if (date && time) return "datetime";
  if (date) return "date";
  return "time";
}

/**
 * numFmtId + the sheet's custom formats → the render kind. Custom
 * <numFmt> definitions (any id) win first; then the built-in date ids;
 * everything else is a plain number.
 */
export function resolveCellFormat(
  numFmtId: number,
  custom: Map<number, string>
): CellFormatKind {
  if (Number.isFinite(numFmtId)) {
    const customCode = custom.get(numFmtId);
    if (typeof customCode === "string") {
      return classifyFormatCode(customCode);
    }
    const builtin = BUILTIN_DATE_FORMATS[numFmtId];
    if (typeof builtin === "string") {
      return classifyFormatCode(builtin);
    }
  }
  return "number";
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Excel 1900-system serial → display string. Dates render as the
 * neutral "YYYY-MM-DD" (+ " HH:MM" for datetime kinds); time-only
 * cells render total hours ("54:00" stays duration-honest). Returns
 * null for serials outside the representable range (0 .. 9999-12-31)
 * so the caller can fall back to the raw stored value.
 *
 * The 1900 fake leap day: serials < 61 count from 1899-12-31 (Excel's
 * serial 60 is the non-existent 1900-02-29 — it lands on 1900-03-01,
 * a documented one-day edge in 125-year-old dates).
 */
export function formatExcelSerial(
  serial: number,
  kind: "date" | "datetime" | "time"
): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) {
    return null;
  }
  if (kind === "time") {
    const totalMin = Math.round(serial * 1440);
    return `${pad2(Math.floor(totalMin / 60))}:${pad2(totalMin % 60)}`;
  }
  if (kind === "date") {
    // A date-only format truncates the time part (Excel behaviour).
    const whole = Math.floor(serial);
    const epoch =
      (whole < 61 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30)) +
      whole * 86_400_000;
    const d = new Date(epoch);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(
      d.getUTCDate()
    )}`;
  }
  // Datetime: rounding to the nearest minute kills the float dust the
  // serial carries (0.60416666… of 14:30 would floor to 14:29) — and
  // a rounded 24:00 rolls the date forward, exactly like Excel shows.
  const totalMin = Math.round(serial * 1440);
  const whole = Math.floor(totalMin / 1440);
  const minutesOfDay = ((totalMin % 1440) + 1440) % 1440;
  const epoch =
    (whole < 61 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30)) +
    whole * 86_400_000;
  const d = new Date(epoch);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(
    d.getUTCDate()
  )} ${pad2(Math.floor(minutesOfDay / 60))}:${pad2(minutesOfDay % 60)}`;
}

/* ------------------------------------------------------------------ */
/* xl/workbook.xml + its rels                                          */
/* ------------------------------------------------------------------ */

/** One sheet declaration: its display name + its relationship id. */
export interface WorkbookSheetRef {
  name: string;
  rid: string;
}

/** workbook.xml → the ordered sheet list. */
export function parseWorkbookXml(xml: string): WorkbookSheetRef[] {
  const sheets: WorkbookSheetRef[] = [];
  let open: WorkbookSheetRef | null = null;
  scanXmlTags(
    xml,
    (tag) => {
      if (tag.name !== "sheet") return;
      if (tag.closing) {
        if (open !== null) {
          sheets.push(open);
          open = null;
        }
        return;
      }
      const name = tag.attrs["name"];
      const rid = tag.attrs["r:id"] ?? tag.attrs["id"];
      const entry = {
        name: typeof name === "string" ? name : "",
        rid: typeof rid === "string" ? rid : "",
      };
      if (tag.selfClosing) sheets.push(entry);
      else open = entry;
    },
    () => {
      /* no text matters here */
    }
  );
  if (open !== null) sheets.push(open); // unclosed tail
  return sheets.filter((sheet) => sheet.rid.length > 0);
}

/** "worksheets/sheet1.xml" | "/xl/worksheets/sheet1.xml" → zip part path. */
export function normalizeSheetPart(target: string): string {
  let part = target.replace(/^\//, "");
  if (!part.startsWith("xl/")) part = `xl/${part}`;
  return part;
}

/**
 * xl/_rels/workbook.xml.rels → rId → worksheet part path (relationship
 * types ending in "/worksheet"; styles/sharedStrings rels are unused —
 * parts are read by their canonical names).
 */
export function parseWorkbookRelsXml(xml: string): Map<string, string> {
  const targets = new Map<string, string>();
  scanXmlTags(
    xml,
    (tag) => {
      if (tag.name !== "Relationship" || tag.closing) return;
      const id = tag.attrs["Id"];
      const type = tag.attrs["Type"];
      const target = tag.attrs["Target"];
      if (
        typeof id === "string" &&
        typeof target === "string" &&
        typeof type === "string" &&
        /\/worksheet$/.test(type)
      ) {
        targets.set(id, normalizeSheetPart(target));
      }
    },
    () => {
      /* no text matters here */
    }
  );
  return targets;
}

/* ------------------------------------------------------------------ */
/* xl/sharedStrings.xml                                                */
/* ------------------------------------------------------------------ */

/**
 * The shared string table. Each <si> is either a plain <t> or a rich
 * run list (<r><t>…</t></r>…); runs join in order. <rPh> phonetic
 * payloads never leak in. xml:space="preserve" keeps edge spaces;
 * without it the edges are trimmed (the Word <w:t> semantics).
 */
export function parseSharedStringsXml(xml: string): string[] {
  const strings: string[] = [];
  let siDepth = 0;
  let tDepth = 0;
  let rPhDepth = 0;
  let preserve = false;
  let buf = "";

  // EVERY <si> occupies its array slot (indices are what t="s" cells
  // reference) — whitespace-only entries push their text verbatim.
  const flush = (): void => {
    strings.push(buf);
    buf = "";
  };

  scanXmlTags(
    xml,
    (tag) => {
      if (tag.closing) {
        if (tag.name === "si") {
          siDepth -= 1;
          flush();
        } else if (tag.name === "t") tDepth -= 1;
        else if (tag.name === "rPh") rPhDepth -= 1;
        return;
      }
      if (tag.name === "si") {
        siDepth += 1;
        buf = "";
        if (tag.selfClosing) {
          siDepth -= 1;
          flush();
        }
      } else if (tag.name === "t") {
        tDepth += 1;
        preserve = tag.attrs["xml:space"] === "preserve";
      } else if (tag.name === "rPh") {
        rPhDepth += 1;
      }
    },
    (text) => {
      if (tDepth === 0 || rPhDepth > 0) return;
      buf += preserve ? unescapeXml(text) : unescapeXml(text).trim();
    }
  );
  return strings;
}

/* ------------------------------------------------------------------ */
/* xl/styles.xml                                                       */
/* ------------------------------------------------------------------ */

/** What a cell's style slot (cellXfs index) means for rendering. */
export interface XlsxStyleSlot {
  bold: boolean;
  format: CellFormatKind;
}

/** The resolved cellXfs table (index = the cell's s attribute). */
export type XlsxStyleTable = XlsxStyleSlot[];

/**
 * styles.xml → the cellXfs table. fonts (bold flags) + numFmts (custom
 * format codes) are collected first and each <xf> in cellXfs resolves
 * to { bold, format } — <xf> entries inside cellStyleXfs never pollute
 * the table (the section is tracked).
 */
export function parseStylesXml(xml: string): XlsxStyleTable {
  const fontBold: boolean[] = [];
  let inFonts = false;
  let fontOpen = false;
  let fontBoldFlag = false;

  const customFormats = new Map<number, string>();

  const rawXfs: { fontId: number; numFmtId: number }[] = [];
  let section: "none" | "cellStyleXfs" | "cellXfs" = "none";

  scanXmlTags(
    xml,
    (tag) => {
      if (tag.closing) {
        if (tag.name === "fonts") inFonts = false;
        else if (tag.name === "font" && fontOpen) {
          fontBold.push(fontBoldFlag);
          fontOpen = false;
        } else if (tag.name === "cellStyleXfs" || tag.name === "cellXfs") {
          section = "none";
        }
        return;
      }
      if (tag.name === "fonts") {
        inFonts = true;
        return;
      }
      if (inFonts) {
        if (tag.name === "font") {
          fontOpen = true;
          fontBoldFlag = false;
          if (tag.selfClosing) {
            fontBold.push(false);
            fontOpen = false;
          }
        } else if (tag.name === "b" && fontOpen) {
          const val = tag.attrs["val"];
          fontBoldFlag = val !== "0" && val !== "false";
        }
        return;
      }
      if (tag.name === "numFmt") {
        const id = Number(tag.attrs["numFmtId"]);
        const code = tag.attrs["formatCode"];
        if (Number.isFinite(id) && typeof code === "string") {
          customFormats.set(id, code);
        }
        return;
      }
      if (tag.name === "cellStyleXfs" || tag.name === "cellXfs") {
        section = tag.selfClosing
          ? "none"
          : (tag.name as "cellStyleXfs" | "cellXfs");
        return;
      }
      if (tag.name === "xf" && section === "cellXfs") {
        const fontId = Number(tag.attrs["fontId"]);
        const numFmtId = Number(tag.attrs["numFmtId"]);
        rawXfs.push({
          fontId: Number.isFinite(fontId) ? fontId : 0,
          numFmtId: Number.isFinite(numFmtId) ? numFmtId : 0,
        });
      }
    },
    () => {
      /* no text matters here */
    }
  );

  return rawXfs.map((xf) => ({
    bold: fontBold[xf.fontId] === true,
    format: resolveCellFormat(xf.numFmtId, customFormats),
  }));
}

/* ------------------------------------------------------------------ */
/* xl/worksheets/sheetN.xml                                           */
/* ------------------------------------------------------------------ */

/** One parsed cell: its display text + its resolved bold flag. */
export interface ParsedCell {
  text: string;
  bold: boolean;
}

/** The raw (sparse) scan of one worksheet. */
export interface RawSheetScan {
  /** Sparse cells keyed `${row}:${col}` (1-based row, 0-based col). */
  cells: Map<string, ParsedCell>;
  /** Declared column widths in Excel char units, per 0-based column. */
  colWidthsChars: number[];
}

interface SheetCellDraft {
  col: number;
  row: number;
  type: string;
  styleIndex: number;
  vBuf: string;
  isBuf: string;
  inV: boolean;
  inIs: boolean;
  inT: boolean;
  preserve: boolean;
}

/**
 * worksheet.xml → sparse cells. Handles every cell type listed in the
 * module header, refs + positional fallback, <cols> widths (within the
 * column cap) and the row/column caps.
 */
export function parseSheetXml(
  xml: string,
  shared: string[],
  styles: XlsxStyleTable
): RawSheetScan {
  const cells = new Map<string, ParsedCell>();
  const colWidthsChars: number[] = [];
  let currentRow = 0;
  let rowCellCursor = -1;
  let draft: SheetCellDraft | null = null;

  const finalizeCell = (): void => {
    if (draft === null) return;
    const cell = draft;
    draft = null;
    let text = "";
    let styleBold = false;
    if (cell.styleIndex >= 0 && cell.styleIndex < styles.length) {
      styleBold = styles[cell.styleIndex].bold;
    }
    if (cell.type === "inlineStr") {
      text = cell.isBuf;
    } else if (cell.type === "s") {
      const index = Number(cell.vBuf.trim());
      text =
        Number.isFinite(index) && index >= 0 && index < shared.length
          ? (shared[index] ?? "")
          : "";
    } else if (cell.type === "b") {
      text = /^(1|true)$/i.test(cell.vBuf.trim()) ? "TRUE" : "FALSE";
    } else if (cell.type === "str" || cell.type === "e") {
      text = cell.vBuf; // formula's cached result / error literal
    } else if (cell.vBuf.trim().length > 0) {
      // A plain stored value: dates format, everything else passes
      // through exactly as stored (display formats are not rebuilt).
      const style =
        cell.styleIndex >= 0 && cell.styleIndex < styles.length
          ? styles[cell.styleIndex]
          : null;
      const num = Number(cell.vBuf);
      if (style !== null && style.format !== "number" && Number.isFinite(num)) {
        text = formatExcelSerial(num, style.format) ?? cell.vBuf;
      } else {
        text = cell.vBuf.trim();
      }
    }
    if (text.length === 0) return;
    if (cell.row > MAX_PARSE_ROWS || cell.col >= MAX_PARSE_COLS) return;
    cells.set(`${cell.row}:${cell.col}`, { text, bold: styleBold });
  };

  scanXmlTags(
    xml,
    (tag) => {
      if (tag.closing) {
        if (tag.name === "c") {
          finalizeCell();
        } else if (tag.name === "v" && draft !== null) {
          draft.inV = false;
        } else if (tag.name === "is" && draft !== null) {
          draft.inIs = false;
        } else if (tag.name === "t" && draft !== null) {
          draft.inT = false;
        }
        return;
      }
      switch (tag.name) {
        case "row": {
          finalizeCell(); // an unclosed <c> before the next row
          const r = Number(tag.attrs["r"]);
          currentRow = Number.isFinite(r) && r >= 1 ? Math.floor(r) : currentRow + 1;
          if (currentRow > MAX_PARSE_ROWS) currentRow = MAX_PARSE_ROWS;
          rowCellCursor = -1;
          return;
        }
        case "c": {
          finalizeCell();
          let col = rowCellCursor + 1;
          let row = currentRow;
          const ref = tag.attrs["r"];
          if (typeof ref === "string") {
            const parsed = parseCellRef(ref);
            if (parsed !== null) {
              col = parsed.col;
              row = parsed.row;
            }
          }
          rowCellCursor = col;
          const style = Number(tag.attrs["s"]);
          draft = {
            col,
            row,
            type: typeof tag.attrs["t"] === "string" ? (tag.attrs["t"] ?? "") : "",
            styleIndex: Number.isFinite(style) ? style : -1,
            vBuf: "",
            isBuf: "",
            inV: false,
            inIs: false,
            inT: false,
            preserve: false,
          };
          if (tag.selfClosing) finalizeCell();
          return;
        }
        case "v":
          if (draft !== null) draft.inV = true;
          return;
        case "is":
          if (draft !== null) draft.inIs = true;
          return;
        case "t":
          if (draft !== null) {
            draft.inT = true;
            draft.preserve = tag.attrs["xml:space"] === "preserve";
          }
          return;
        case "f":
          return; // formula — never part of the text
        case "col": {
          const min = Number(tag.attrs["min"]);
          const max = Number(tag.attrs["max"]);
          const width = Number(tag.attrs["width"]);
          if (Number.isFinite(width) && width > 0) {
            const lo = Number.isFinite(min) ? Math.max(1, Math.floor(min)) : 1;
            const hi = Number.isFinite(max) ? Math.min(MAX_PARSE_COLS, Math.floor(max)) : lo;
            for (let c = lo - 1; c < hi; c += 1) {
              colWidthsChars[c] = width;
            }
          }
          return;
        }
        default:
          return;
      }
    },
    (text) => {
      if (draft === null) return;
      if (draft.inV) {
        draft.vBuf += text;
      } else if (draft.inIs && draft.inT) {
        draft.isBuf += draft.preserve ? unescapeXml(text) : unescapeXml(text).trim();
      }
    }
  );
  finalizeCell(); // a truncated tail
  return { cells, colWidthsChars };
}

/* ------------------------------------------------------------------ */
/* Densify + trim                                                      */
/* ------------------------------------------------------------------ */

/** A sheet ready for rendering: a dense, trimmed grid. */
export interface ParsedSheet {
  name: string;
  /** rows[row][col] — dense; fully-empty trailing rows/cols trimmed. */
  rows: ParsedCell[][];
  /** Declared column widths (Excel char units); sparse tail is 0. */
  colWidthsChars: number[];
}

/**
 * Sparse cells → the dense trimmed grid. The bounds come from the
 * actual CELLS (the <dimension> tag is only a producer hint — it can
 * lie, and interior gaps stay visible in the grid).
 */
export function densifySheet(name: string, scan: RawSheetScan): ParsedSheet {
  let lastRow = 0;
  let lastCol = -1;
  for (const [key, cell] of scan.cells) {
    if (cell.text.trim().length === 0) continue;
    const sep = key.indexOf(":");
    const row = Number.parseInt(key.slice(0, sep), 10);
    const col = Number.parseInt(key.slice(sep + 1), 10);
    if (row > lastRow) lastRow = row;
    if (col > lastCol) lastCol = col;
  }
  const rows: ParsedCell[][] = [];
  for (let r = 1; r <= lastRow; r += 1) {
    const row: ParsedCell[] = [];
    for (let c = 0; c <= lastCol; c += 1) {
      row.push(scan.cells.get(`${r}:${c}`) ?? { text: "", bold: false });
    }
    rows.push(row);
  }
  const colWidths: number[] = [];
  for (let c = 0; c <= lastCol; c += 1) {
    colWidths.push(scan.colWidthsChars[c] ?? 0);
  }
  return { name, rows, colWidthsChars: colWidths };
}

/* ------------------------------------------------------------------ */
/* The package reader                                                   */
/* ------------------------------------------------------------------ */

/** Why a package could not be read as a .xlsx. */
export type XlsxParseFailure = "not-zip" | "not-xlsx";

export class XlsxParseError extends Error {
  readonly failure: XlsxParseFailure;

  constructor(failure: XlsxParseFailure) {
    super(failure);
    this.name = "XlsxParseError";
    this.failure = failure;
  }
}

export interface ParsedXlsx {
  sheets: ParsedSheet[];
  /** Non-whitespace chars across every sheet (the empty guard). */
  charCount: number;
}

function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * bytes → the workbook's sheets. Throws XlsxParseError("not-zip") for
 * a non-zip and "not-xlsx" for a zip without a readable workbook
 * part; unreadable sheets are skipped (the all-empty selection guard
 * still fires honestly downstream).
 */
export function parseXlsxBytes(bytes: Uint8Array): ParsedXlsx {
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes);
  } catch {
    throw new XlsxParseError("not-zip");
  }
  const workbookBytes = parts["xl/workbook.xml"];
  if (workbookBytes === undefined) {
    throw new XlsxParseError("not-xlsx");
  }
  const workbookXml = decodeStrictUtf8(workbookBytes);
  if (workbookXml === null) {
    throw new XlsxParseError("not-xlsx");
  }

  const sheetRefs = parseWorkbookXml(workbookXml);
  const relsBytes = parts["xl/_rels/workbook.xml.rels"];
  const rels =
    relsBytes === undefined
      ? new Map<string, string>()
      : parseWorkbookRelsXml(decodeStrictUtf8(relsBytes) ?? "");

  const sharedBytes = parts["xl/sharedStrings.xml"];
  const shared =
    sharedBytes === undefined
      ? []
      : parseSharedStringsXml(decodeStrictUtf8(sharedBytes) ?? "");

  const stylesBytes = parts["xl/styles.xml"];
  const styles: XlsxStyleTable =
    stylesBytes === undefined
      ? []
      : parseStylesXml(decodeStrictUtf8(stylesBytes) ?? "");

  const sheets: ParsedSheet[] = [];
  let charCount = 0;
  for (const ref of sheetRefs) {
    const part = rels.get(ref.rid);
    if (typeof part !== "string") continue;
    const sheetBytes = parts[part];
    if (sheetBytes === undefined) continue; // missing part — skip honestly
    const sheetXml = decodeStrictUtf8(sheetBytes);
    if (sheetXml === null) continue; // unreadable sheet — skip, don't die
    const scan = parseSheetXml(sheetXml, shared, styles);
    const sheet = densifySheet(ref.name, scan);
    for (const row of sheet.rows) {
      for (const cell of row) {
        charCount += cell.text.replace(/\s/g, "").length;
      }
    }
    sheets.push(sheet);
  }
  return { sheets, charCount };
}

/** True when a sheet has at least one non-whitespace cell. */
export function sheetHasContent(sheet: ParsedSheet): boolean {
  for (const row of sheet.rows) {
    for (const cell of row) {
      if (cell.text.trim().length > 0) return true;
    }
  }
  return false;
}
