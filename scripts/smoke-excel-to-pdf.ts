/**
 * Smoke: excel-to-pdf (RB1-c) — .xlsx → PDF, 100% on-device.
 *
 * Real xlsx fixture built with fflate zipSync, real renders through
 * the worker's exact render.ts, node:zlib inflate oracle, parse-level
 * font asserts on reload.
 *
 * Run: bun scripts/smoke-excel-to-pdf.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { zipSync, strToU8 } from "../src/lib/own/zip/index";

import {
  MAX_ROWS,
  MAX_COLS,
  MAX_SHEETS,
  needsNoto,
  parseExcelRun,
  parseXlsx,
  XlsxParseError,
} from "../tools/excel-to-pdf/model";
import { drawWorkbookPdf } from "../tools/excel-to-pdf/render";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(label);
    console.error(`  FAIL ${label}`, actual !== undefined ? JSON.stringify(actual).slice(0, 300) : "");
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

interface SheetSpec {
  name: string;
  shared?: string[];
  rowsXml: string;
}

function makeXlsx(sheets: SheetSpec[], sharedAll: string[] = []): Uint8Array {
  const sharedXml =
    XML_DECL +
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' +
    sharedAll.length +
    '" uniqueCount="' +
    sharedAll.length +
    '">' +
    sharedAll.map((s) => `<si><t>${s}</t></si>`).join("") +
    "</sst>";
  return zipSync({
    "[Content_Types].xml": strToU8(
      XML_DECL +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        (sharedAll.length ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : "") +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
          )
          .join("") +
        "</Types>"
    ),
    "_rels/.rels": strToU8(
      XML_DECL +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>"
    ),
    "xl/workbook.xml": strToU8(
      XML_DECL +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        "<sheets>" +
        sheets
          .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join("") +
        "</sheets></workbook>"
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      XML_DECL +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
          )
          .join("") +
        (sharedAll.length ? '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' : "") +
        "</Relationships>"
    ),
    ...(sharedAll.length ? { "xl/sharedStrings.xml": strToU8(sharedXml) } : {}),
    ...Object.fromEntries(
      sheets.map((s, i) => [
        `xl/worksheets/sheet${i + 1}.xml`,
        strToU8(
          XML_DECL +
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
            s.rowsXml +
            "</sheetData></worksheet>"
        ),
      ])
    ),
  });
}

function cell(ref: string, kind: "s" | "n" | "b" | "str" | "inl", v: string | number): string {
  switch (kind) {
    case "s":
      return `<c r="${ref}" t="s"><v>${v}</v></c>`;
    case "n":
      return `<c r="${ref}"><v>${v}</v></c>`;
    case "b":
      return `<c r="${ref}" t="b"><v>${v}</v></c>`;
    case "str":
      return `<c r="${ref}" t="str"><v>${v}</v></c>`;
    case "inl":
      return `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
  }
}

function inflatedText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  let out = "";
  let idx = 0;
  for (;;) {
    const s = raw.indexOf("stream", idx);
    if (s < 0) break;
    let start = s + 6;
    if (raw[start] === "\r") start++;
    if (raw[start] === "\n") start++;
    const e = raw.indexOf("endstream", start);
    if (e < 0) break;
    try {
      out += inflateSync(Buffer.from(raw.slice(start, e), "latin1")).toString("latin1");
    } catch {
      /* font stream */
    }
    idx = e + 9;
  }
  return out;
}


/** pdf-lib emits text as hex tokens (<...> Tj) — literal, exact-token
 *  or bare byte-sequence match. */
function hasText(stream: string, s: string): boolean {
  if (stream.includes(s)) return true;
  const hex = Buffer.from(s, "latin1").toString("hex").toUpperCase();
  // pdf-lib hex tokens (<517561727465726C79...> Tj) can carry whole
  // strings: exact-token match for short text, bare byte-sequence
  // match (>= 8 hex chars) for words inside longer tokens.
  if (stream.includes(`<${hex}>`)) return true;
  return hex.length >= 8 ? stream.includes(hex) : false;
}

const notoBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);

async function render(wb: ReturnType<typeof parseXlsx>, noto: boolean, landscape = false): Promise<{ bytes: Uint8Array; pages: number }> {
  const pdfDoc = await PDFDocument.create();
  let font: PDFFont;
  let boldFont: PDFFont | null = null;
  if (noto) {
    pdfDoc.registerFontkit(fontkit);
    font = await pdfDoc.embedFont(notoBytes, { subset: true });
  } else {
    font = pdfDoc.embedStandardFont(StandardFonts.Helvetica);
    boldFont = pdfDoc.embedStandardFont(StandardFonts.HelveticaBold);
  }
  drawWorkbookPdf(pdfDoc, font, boldFont, wb, {
    pageSize: "a4",
    orientation: landscape ? "landscape" : "portrait",
    fit: false,
  });
  const bytes = await pdfDoc.save();
  const reloaded = await PDFDocument.load(bytes);
  return { bytes, pages: reloaded.getPageCount() };
}

/* ------------------------------------------------------------------ */
console.log("── 1. parseXlsx on a real fixture ───────────────────────");
{
  const shared = ["Region", "Sales", "North", "South", "East"];
  const rowsXml =
    `<row r="1">${cell("A1", "s", 0)}${cell("B1", "s", 1)}</row>` +
    `<row r="2">${cell("A2", "s", 2)}${cell("B2", "n", 120)}</row>` +
    `<row r="3">${cell("A3", "s", 3)}${cell("B3", "n", 80)}</row>` +
    `<row r="4">${cell("A4", "s", 4)}${cell("B4", "b", 1)}</row>` +
    `<row r="5">${cell("A5", "inl", "Plain inline")}${cell("B5", "str", "=SUM(B2:B3)")}</row>`;
  const xlsx = makeXlsx([{ name: "Data", rowsXml }], shared);
  check("fixture is a zip (PK)", xlsx[0] === 0x50 && xlsx[1] === 0x4b);

  const wb = parseXlsx(xlsx);
  check("one sheet", wb.sheets.length === 1 && wb.sheets[0]?.name === "Data", wb.sheets.map((s) => s.name));
  const rows = wb.sheets[0]?.rows ?? [];
  const c = (r: number, i: number): string => rows[r]?.[i]?.v ?? "";
  check("header row shared strings", c(0, 0) === "Region" && c(0, 1) === "Sales", rows[0]);
  check("numbers parsed", c(1, 1) === "120", rows[1]);
  check("boolean cell", typeof c(3, 1) === "string" && c(3, 1).length > 0, rows[3]);
  check("inline string", c(4, 0) === "Plain inline", rows[4]);
  check("formula cached value kept", typeof c(4, 1) === "string" && c(4, 1).length > 0, rows[4]);
  check("no Noto needed for EN", needsNoto(wb.sheets) === false);
}

console.log("── 2. multi-sheet + hardening ────────────────────────────");
{
  const shared = ["हिन्दी शीट", "प्रिया"];
  const rowsXml = `<row r="1">${cell("A1", "s", 0)}</row><row r="2">${cell("A2", "s", 1)}</row>`;
  const wb = parseXlsx(makeXlsx([{ name: "हिन्दी", rowsXml }], shared));
  check("Hindi sheet needs Noto", needsNoto(wb.sheets) === true);
  check("Hindi shared string parsed", wb.sheets[0]?.rows[0]?.[0]?.v === "हिन्दी शीट", wb.sheets[0]?.rows[0]);

  const many = Array.from({ length: 15 }, (_, i) => ({
    name: `S${i}`,
    rowsXml: `<row r="1">${cell("A1", "n", i)}</row>`,
  }));
  const wbMany = parseXlsx(makeXlsx(many));
  check("sheet cap at 10", wbMany.sheets.length === MAX_SHEETS && wbMany.sheetsTruncated === true, {
    kept: wbMany.sheets.length,
    truncated: wbMany.sheetsTruncated,
  });

  try {
    parseXlsx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    check("legacy .xls throws", false);
  } catch (e) {
    check("legacy .xls throws", e instanceof XlsxParseError);
  }
  try {
    parseXlsx(new Uint8Array([1, 2, 3, 4]));
    check("non-zip throws", false);
  } catch (e) {
    check("non-zip throws", e instanceof XlsxParseError);
  }
  try {
    parseXlsx(zipSync({ hello: strToU8("world") }));
    check("non-ooxml zip throws", false);
  } catch (e) {
    check("non-ooxml zip throws", e instanceof XlsxParseError);
  }

  const run = parseExcelRun(JSON.stringify({ sheetNames: ["Data"], pageSize: "letter", orientation: "landscape", fit: true }), ["Data", "Other"]);
  check("parseExcelRun valid", run.sheetNames[0] === "Data", run);

  const wide = parseXlsx(
    makeXlsx([
      {
        name: "W",
        rowsXml: `<row r="1">${Array.from({ length: MAX_COLS + 20 }, (_, i) => cell(colRef(i), "n", i)).join("")}</row>`,
      },
    ])
  );
  check("column cap", (wide.sheets[0]?.rows[0]?.length ?? 0) <= MAX_COLS, wide.sheets[0]?.rows[0]?.length);
}

function colRef(n: number): string {
  let s = "";
  let v = n;
  while (v >= 0) {
    s = String.fromCharCode(65 + (v % 26)) + s;
    v = Math.floor(v / 26) - 1;
  }
  return s + "1";
}

console.log("── 3. REAL renders ──────────────────────────────────────");
{
  const shared = ["Region", "Sales", "North", "South"];
  const head = `<row r="1">${cell("A1", "s", 0)}${cell("B1", "s", 1)}</row>`;
  const dataRows = Array.from(
    { length: 60 },
    (_, i) =>
      `<row r="${i + 2}">${cell(`A${i + 2}`, "s", 2 + (i % 2))}${cell(`B${i + 2}`, "n", (i + 1) * 7)}</row>`
  ).join("");
  const wb = parseXlsx(makeXlsx([{ name: "Data", rowsXml: head + dataRows }], shared));

  const out = await render(wb, false);
  check("EN: %PDF magic + size", out.bytes[0] === 0x25 && out.bytes.length > 1000, out.bytes.length);
  check("EN: multi-page for 61 rows", out.pages >= 2, out.pages);
  const txt = inflatedText(out.bytes);
  check("EN: header text in stream", hasText(txt, "Region") && hasText(txt, "Sales"));
  check("EN: cell text in stream", hasText(txt, "North"));
  check("EN: no NaN", !txt.includes("NaN"));
  const reloaded = await PDFDocument.load(out.bytes);
  const dump = [...reloaded.context.enumerateIndirectObjects()].map(([, o]) => o.toString()).join("\n");
  check("EN: Helvetica, no embedded font", dump.includes("Helvetica") && !dump.includes("FontFile2"));

  const land = await render(wb, false, true);
  const ls = (await PDFDocument.load(land.bytes)).getPage(0).getSize();
  check("landscape: swapped dims", ls.width > ls.height, `${ls.width}x${ls.height}`);

  const hiShared = ["क्षेत्र", "बिक्री"];
  const hiRows = `<row r="1">${cell("A1", "s", 0)}${cell("B1", "s", 1)}</row><row r="2">${cell("A2", "inl", "उत्तर")}${cell("B2", "n", 12)}</row>`;
  const hiWb = parseXlsx(makeXlsx([{ name: "हिन्दी", rowsXml: hiRows }], hiShared));
  const hiOut = await render(hiWb, true);
  check("HI: %PDF magic", hiOut.bytes[0] === 0x25 && hiOut.bytes.length > 1000, hiOut.bytes.length);
  const hiDump = (await PDFDocument.load(hiOut.bytes));
  const hiStr = [...hiDump.context.enumerateIndirectObjects()].map(([, o]) => o.toString()).join("\n");
  check("HI: Noto embedded (FontFile2)", hiStr.includes("FontFile2"));
  check("HI: Type0 composite", hiStr.includes("Identity-H"));
  check("HI: no NaN", !inflatedText(hiOut.bytes).includes("NaN"));
}

console.log(
  `\nexcel-to-pdf smoke: ${pass} passed, ${fail} failed` +
    (fail ? "\n  " + failures.join("\n  ") : "")
);
process.exit(fail === 0 ? 0 : 1);
