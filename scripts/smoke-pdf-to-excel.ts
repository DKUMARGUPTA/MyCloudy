/**
 * Smoke: pdf-to-excel (RB1-d) — PDF → xlsx, 100% on-device.
 *
 * Real tabular PDF via pdf-lib → pdf.js in-process extraction →
 * extractGrid → buildXlsx → unzip + assert the OOXML.
 *
 * Run: bun scripts/smoke-pdf-to-excel.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";

import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { unzipSync } from "fflate";

import {
  buildOutputName,
  buildXlsx,
  colName,
  extractGrid,
  gridItemsFromRaw,
  numericValue,
  parseRun,
  sanitizeSheetName,
  xmlEscape,
} from "../tools/pdf-to-excel/model";

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
console.log("── 1. pure helpers ──────────────────────────────────────");
{
  check("colName 1→A", colName(1) === "A", colName(1));
  check("colName 26→Z", colName(26) === "Z", colName(26));
  check("colName 27→AA", colName(27) === "AA", colName(27));
  check("colName 52→AZ", colName(52) === "AZ", colName(52));
  check("colName 53→BA", colName(53) === "BA", colName(53));

  check("xmlEscape & < > \" '", xmlEscape(`a & b < c > d "e" 'f'`) === "a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;");
  check("xmlEscape keeps Devanagari", xmlEscape("प्रिया") === "प्रिया");

  check("numericValue int", numericValue("120") === 120);
  check("numericValue float", numericValue("12.5") === 12.5);
  check("numericValue negative", numericValue("-3") === -3);
  check("numericValue rejects text", numericValue("North") === null);
  check("numericValue rejects empty", numericValue("") === null);
  check("numericValue rejects long", numericValue("1".repeat(16)) === null);

  const s1 = sanitizeSheetName("a/b:c*d?", new Set());
  check("sanitizeSheetName replaces illegal with spaces", s1 === "a b c d", s1);
  check("sanitizeSheetName cap 31", sanitizeSheetName("x".repeat(40), new Set()).length === 31);
  check("sanitizeSheetName empty → Sheet", sanitizeSheetName("", new Set()) === "Sheet");
  const u2 = new Set(["data"]);
  check("sanitizeSheetName dedupe", sanitizeSheetName("DATA", u2) === "DATA 2", sanitizeSheetName("DATA", u2));

  const items = gridItemsFromRaw([
    { str: "Region", x: 72, y: 700, w: 40, size: 11, transform: [11, 0, 0, 11, 72, 700] },
    null,
    { str: 42 },
    { str: "Sales", x: 200, y: 700, w: 30, size: 11, transform: [11, 0, 0, 11, 200, 700] },
    "garbage",
  ] as unknown as Iterable<unknown>);
  check("gridItemsFromRaw filters garbage", items.length === 2, items);
}

console.log("── 2. extractGrid clustering ────────────────────────────");
{
  const gi = (str: string, x: number, y: number, w = 0): { str: string; x: number; y: number; w: number; size: number } =>
    ({ str, x, y, w, size: 11 });

  const rows = extractGrid([
    gi("Region", 72, 700, 40),
    gi("Sales", 200, 700, 30),
    gi("North", 72, 680, 30),
    gi("120", 200, 680, 20),
    gi("South", 72, 660, 30),
    gi("80", 200, 660, 15),
  ]);
  check("3 rows detected", rows.length === 3, rows);
  check("2 columns detected", rows[0]?.length === 2, rows[0]);
  check("header cells", rows[0]?.[0] === "Region" && rows[0]?.[1] === "Sales", rows[0]);
  check("data cells", rows[1]?.[0] === "North" && rows[1]?.[1] === "120", rows[1]);

  const xtol = extractGrid([gi("A", 72, 700), gi("B", 75, 700), gi("C", 300, 700)]);
  check("near x merges into one column", xtol[0]?.length === 2, xtol);

  const sparse = extractGrid([gi("only one cell", 72, 700)]);
  check("single cell → 1×1", sparse.length === 1 && sparse[0]?.length === 1, sparse);

  const empty = extractGrid([]);
  check("empty input → no rows", empty.length === 0, empty);

  const tampered = extractGrid(
    [
      { str: "x", x: "NaN", y: 700, w: 0, size: 11 },
      { str: "ok", x: 72, y: "bad", w: 0, size: 11 },
      { str: "good", x: 72, y: 700, w: 10, size: 0 },
    ] as unknown as Parameters<typeof extractGrid>[0]
  );
  check("non-numeric x/y dropped", tampered.length === 1 && tampered[0]?.[0] === "good", tampered);
}

console.log("── 3. buildXlsx package shape ────────────────────────────");
{
  const xlsx = buildXlsx([{ name: "Data", rows: [["Region", "Sales"], ["North", "120"]] }]);
  check("output is a zip (PK)", xlsx[0] === 0x50 && xlsx[1] === 0x4b);
  const parts = unzipSync(xlsx);
  const names = Object.keys(parts);
  check("[Content_Types].xml present", names.includes("[Content_Types].xml"), names);
  check("workbook + sheet1 present", names.includes("xl/workbook.xml") && names.includes("xl/worksheets/sheet1.xml"), names);
  const ct = new TextDecoder().decode(parts["[Content_Types].xml"]);
  check("Content_Types declares spreadsheetml", ct.includes("spreadsheetml") && ct.includes("/xl/workbook.xml"));
  const sheet = new TextDecoder().decode(parts["xl/worksheets/sheet1.xml"]);
  check("inline strings present, escaped", sheet.includes("Region") && sheet.includes("North"), sheet.slice(0, 200));
  check("numeric cell as t=n", /<c r="B2"[^>]*><v>120<\/v><\/c>/.test(sheet) || /t="n"/.test(sheet), sheet.slice(0, 300));

  const esc = buildXlsx([{ name: "E", rows: [["a & <b>"]] }]);
  const escSheet = new TextDecoder().decode(unzipSync(esc)["xl/worksheets/sheet1.xml"]);
  check("XML escaping in cells", escSheet.includes("a &amp; &lt;b&gt;"), escSheet.slice(0, 200));

  const multi = buildXlsx([
    { name: "S1", rows: [["a"]] },
    { name: "S2", rows: [["b"]] },
  ]);
  const mparts = unzipSync(multi);
  check("two sheets", mparts["xl/worksheets/sheet1.xml"] !== undefined && mparts["xl/worksheets/sheet2.xml"] !== undefined, Object.keys(mparts));

  const clamped = buildXlsx(
    Array.from({ length: 25 }, (_, i) => ({ name: `S${i}`, rows: [["x"]] }))
  );
  const cparts = Object.keys(unzipSync(clamped));
  check("sheet cap at 20", cparts.filter((n) => n.includes("sheet")).length <= 20, cparts.filter((n) => n.includes("sheet")).length);

  const run = parseRun(JSON.stringify({ sheetMode: "perPage", numericCells: false, locale: "hi", labels: { fileWord: "स्प्रेडशीट", pageWord: "पेज", sheetWord: "शीट" } }));
  check("parseRun round-trip", run.sheetMode === "perPage" && run.locale === "hi" && run.labels.fileWord === "स्प्रेडशीट", run);
  const bad = parseRun("not json {{{");
  check("parseRun garbage → defaults", bad.sheetMode === "single" && bad.locale === "en", bad);
  check("buildOutputName", buildOutputName("report", "excel") === "report-excel" || buildOutputName("report", "excel").includes("report"), buildOutputName("report", "excel"));
}

console.log("── 4. REAL PDF → grid → xlsx round-trip ──────────────────");
{
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const notoBytes = readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf");
  const noto = await doc.embedFont(new Uint8Array(notoBytes), { subset: true });
  const helv = await doc.embedStandardFont(StandardFonts.Helvetica);
  const bold = await doc.embedStandardFont(StandardFonts.HelveticaBold);

  const page = doc.addPage([612, 792]);
  // header row
  page.drawText("Region", { x: 72, y: 700, size: 11, font: bold });
  page.drawText("Sales", { x: 200, y: 700, size: 11, font: bold });
  page.drawText("Growth", { x: 320, y: 700, size: 11, font: bold });
  // 6 data rows
  for (let i = 0; i < 6; i += 1) {
    const y = 680 - i * 20;
    page.drawText(`Zone ${i + 1}`, { x: 72, y, size: 11, font: helv });
    page.drawText(`${(i + 1) * 25}`, { x: 200, y, size: 11, font: helv });
    page.drawText(`${i}.${i}`, { x: 320, y, size: 11, font: helv });
  }
  page.drawText("प्रिया क्षेत्र", { x: 72, y: 520, size: 12, font: noto });

  const fixture = await doc.save();
  const bytes = new Uint8Array(fixture);
  check("fixture built", bytes[0] === 0x25 && bytes.length > 500);

  const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
  const pdf = await task.promise;
  const p1 = await pdf.getPage(1);
  const content = await p1.getTextContent();
  p1.cleanup();
  await pdf.cleanup();
  await task.destroy();
  check("pdf.js extracted items", content.items.length > 10, content.items.length);

  const grid = extractGrid(gridItemsFromRaw(content.items));
  check("grid rows ≥ 7", grid.length >= 7, grid.length);
  check("grid columns === 3", (grid[0] ?? []).length === 3, grid[0]);
  check("header text", grid[0]?.[0] === "Region" && grid[0]?.[1] === "Sales", grid[0]);
  check("number cells", grid[1]?.[1] === "25" || grid[1]?.[1] === "25", grid[1]);
  const flat = grid.flat().join(" ");
  check("Hindi survives extraction", /[\u0900-\u097F]/.test(flat), flat.slice(-80));

  const xlsx = buildXlsx([{ name: "Page 1", rows: grid }]);
  const parts = unzipSync(xlsx);
  const sheet = new TextDecoder().decode(parts["xl/worksheets/sheet1.xml"]);
  check("round-trip: header strings in sheet", sheet.includes("Region") && sheet.includes("Growth"), sheet.slice(0, 200));
  check("round-trip: numeric cells as t=n", /<v>25<\/v>/.test(sheet), sheet.slice(0, 400));
  check("round-trip: Hindi in sheet (UTF-8)", /[\u0900-\u097F]/.test(sheet));
}

console.log(
  `\npdf-to-excel smoke: ${pass} passed, ${fail} failed` +
    (fail ? "\n  " + failures.join("\n  ") : "")
);
process.exit(fail === 0 ? 0 : 1);
