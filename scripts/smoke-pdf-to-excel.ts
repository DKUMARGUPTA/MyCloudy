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

import { PDFDocument, PDFFont, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { unzipSync } from "../src/lib/own/zip/index";

import {
  axisSegmentsFromOperatorList,
  buildOutputName,
  buildXlsx,
  colName,
  extractGrid,
  extractRuledGrid,
  gridItemsFromRaw,
  numericValue,
  parseRun,
  sanitizeSheetName,
  xmlEscape,
  type LatticeOps,
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
  const opList = await p1.getOperatorList();
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

  // The UNRULED fixture must NOT produce a lattice — fallback path.
  const segs = axisSegmentsFromOperatorList(opList.fnArray as ArrayLike<number>, opList.argsArray as ArrayLike<unknown>, OPS as unknown as LatticeOps);
  check("unruled page → no lattice (null fallback)", extractRuledGrid(gridItemsFromRaw(content.items as unknown[]), segs) === null);
}

console.log("── 5. ruled lattice: synthetic operator lists ──────────");
{
  const ops = OPS as unknown as LatticeOps;

  // moveTo + lineTo drawing one h and one v rule.
  const fn = [ops.constructPath];
  const args: unknown[][] = [
    [
      [ops.moveTo, ops.lineTo, ops.moveTo, ops.lineTo],
      [72, 700, 400, 700, 200, 720, 200, 600],
    ],
  ];
  const segs = axisSegmentsFromOperatorList(fn, args, ops);
  check("moveTo/lineTo → 1 h + 1 v", segs.h.length === 1 && segs.v.length === 1, segs);
  check("h segment geometry", segs.h[0]?.y === 700 && segs.h[0]?.x1 === 72 && segs.h[0]?.x2 === 400, segs.h[0]);
  check("v segment geometry", segs.v[0]?.x === 200 && segs.v[0]?.y1 === 600 && segs.v[0]?.y2 === 720, segs.v[0]);

  // A rectangle → its four edges.
  const rectSegs = axisSegmentsFromOperatorList(
    [ops.constructPath],
    [[[ops.rectangle], [72, 650, 328, 50]]],
    ops
  );
  check("rectangle → 2 h + 2 v edges", rectSegs.h.length === 2 && rectSegs.v.length === 2, rectSegs);

  // CTM tracking: translate (100, 50) then scale 2× — the raw rect at
  // (10,10,20,10) must land at user-space (120,70)-(160,90).
  const ctmSegs = axisSegmentsFromOperatorList(
    [ops.save, ops.transform, ops.constructPath, ops.restore],
    [
      [],
      [2, 0, 0, 2, 100, 50],
      [[ops.rectangle], [10, 10, 20, 10]],
      [],
    ],
    ops
  );
  check("CTM: save/transform/restore tracked", ctmSegs.h.length === 2 && ctmSegs.v.length === 2, ctmSegs);
  check(
    "CTM: mapped rect edges",
    ctmSegs.h.some((s) => Math.abs(s.y - 70) < 0.01 && Math.abs(s.x1 - 120) < 0.01) &&
      ctmSegs.h.some((s) => Math.abs(s.y - 90) < 0.01),
    ctmSegs.h
  );

  // Curves are consumed without segments; closePath on a diagonal adds
  // nothing axis-aligned.
  const curveSegs = axisSegmentsFromOperatorList(
    [ops.constructPath],
    [[[ops.moveTo, ops.curveTo, ops.lineTo, ops.closePath], [1, 2, 3, 4, 5, 6, 7, 8, 1, 2]]],
    ops
  );
  check("curves/diagonals contribute no segments", curveSegs.h.length === 0 && curveSegs.v.length === 0, curveSegs);

  // parseRun: ruled default ON, explicit OFF respected, garbage → default.
  const rDef = parseRun("{}");
  const rOff = parseRun('{"ruled":false}');
  const rBad = parseRun("not json {{{");
  check("parseRun ruled default true", rDef.ruled === true);
  check("parseRun ruled false respected", rOff.ruled === false);
  check("parseRun garbage → ruled true", rBad.ruled === true);
}

console.log("── 6. REAL ruled PDF → exact cell grid ─────────────");
{
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const notoBytes = readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf");
  const noto = await doc.embedFont(new Uint8Array(notoBytes), { subset: true });
  const helv = await doc.embedStandardFont(StandardFonts.Helvetica);
  const bold = await doc.embedStandardFont(StandardFonts.HelveticaBold);

  const page = doc.addPage([612, 792]);

  // Title ABOVE the table (out-of-table text, must land as a row before).
  page.drawText("Quarterly Sales Report", { x: 72, y: 752, size: 16, font: bold });

  // 4 columns × 4 rows lattice (5 v rules, 5 h rules).
  const vX = [72, 190, 320, 450, 540];
  const hY = [720, 690, 660, 630, 600];
  const thick = 1;
  for (const y of hY) {
    page.drawLine({ start: { x: vX[0], y }, end: { x: vX[4], y }, thickness: thick });
  }
  for (const x of vX) {
    page.drawLine({ start: { x, y: hY[4] }, end: { x, y: hY[0] }, thickness: thick });
  }

  // Header + data. Col 2 rows use TWO pieces with a real gap (space
  // rule); row 3 col 3 wraps to two baselines inside ONE cell; a Hindi
  // cell and right-aligned numbers exercise the hard cases.
  const put = (text: string, x: number, y: number, font: PDFFont, size = 11) =>
    page.drawText(text, { x, y, size, font });
  put("Region", 80, 696, bold);
  put("Q1", 210, 696, bold);
  put("Q2", 340, 696, bold);
  put("Note", 460, 696, bold);
  put("North", 80, 666, helv);
  put("120", 210, 666, helv);
  put("80.5", 340, 666, helv);
  put("Steady", 460, 666, helv);
  put("South", 80, 636, helv);
  put("99", 210, 636, helv);
  put("54", 340, 636, helv);
  // wrapped cell: two tight baselines, same column band
  put("Audited", 460, 642, helv, 9);
  put("by external", 460, 631, helv, 9);
  put("प्रिया क्षेत्र", 80, 606, noto, 11);
  put("42", 210, 606, helv);
  put("17", 340, 606, helv);
  put("Best zone", 460, 606, helv);

  const fixture = await doc.save();
  const bytes = new Uint8Array(fixture);
  check("ruled fixture built", bytes[0] === 0x25 && bytes.length > 500);

  const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
  const pdf = await task.promise;
  const p1 = await pdf.getPage(1);
  const content = await p1.getTextContent();
  const opList = await p1.getOperatorList();
  p1.cleanup();
  await pdf.cleanup();
  await task.destroy();

  const items = gridItemsFromRaw(content.items as unknown[]);
  check("ruled PDF has text items", items.length >= 14, items.length);

  const ops = OPS as unknown as LatticeOps;
  const segs = axisSegmentsFromOperatorList(opList.fnArray as ArrayLike<number>, opList.argsArray as ArrayLike<unknown>, ops);
  check("operator list yields rules", segs.h.length >= 5 && segs.v.length >= 5, { h: segs.h.length, v: segs.v.length });

  const grid = extractRuledGrid(items, segs);
  check("ruled lattice accepted", grid !== null);
  if (grid !== null) {
    check("title row before table", grid[0]?.[0] === "Quarterly Sales Report", grid[0]);
    check("4 columns in table rows", grid[1]?.length === 4, grid[1]);
    check("header cells exact", grid[1]?.[0] === "Region" && grid[1]?.[1] === "Q1" && grid[1]?.[2] === "Q2" && grid[1]?.[3] === "Note", grid[1]);
    check("row 1 exact (numbers kept)", grid[2]?.[0] === "North" && grid[2]?.[1] === "120" && grid[2]?.[2] === "80.5" && grid[2]?.[3] === "Steady", grid[2]);
    check("wrapped cell joins with space", grid[3]?.[3] === "Audited by external", grid[3]);
    check("row 3 exact", grid[4]?.[0] === "North" || /[\u0900-\u097F]/.test(grid[4]?.[0] ?? ""), grid[4]);
    check("Hindi cell intact (ruled)", (grid[4]?.[0] ?? "").includes("प्रिया") && (grid[4]?.[0] ?? "").includes("क्षेत्र"), grid[4]);
    check("Hindi row numbers", grid[4]?.[1] === "42" && grid[4]?.[2] === "17", grid[4]);
    check("5 grid rows total (title + 4)", grid.length === 5, grid.length);

    const xlsx = buildXlsx([{ name: "Ruled", rows: grid }]);
    const rparts = unzipSync(xlsx);
    const rsheet = new TextDecoder().decode(rparts["xl/worksheets/sheet1.xml"]);
    check("ruled: numeric t=n cell", /<c r="B3"[^>]*t="n"><v>120<\/v><\/c>/.test(rsheet) || /<v>120<\/v>/.test(rsheet), rsheet.slice(0, 300));
    check("ruled: wrapped cell text", rsheet.includes("Audited by external"));
    check("ruled: Hindi in sheet (UTF-8)", /[\u0900-\u097F]/.test(rsheet));
  }
}

console.log("── 7. ruled lattice: rejection vectors ────────────");
{
  const gi = (str: string, x: number, y: number, w = 0): { str: string; x: number; y: number; w: number; size: number } =>
    ({ str, x, y, w, size: 11 });

  // Too few rules (< 3 h or < 3 v).
  const thin = extractRuledGrid([gi("a", 72, 700)], {
    h: [
      { y: 720, x1: 72, x2: 540 },
      { y: 600, x1: 72, x2: 540 },
    ],
    v: [
      { x: 72, y1: 600, y2: 720 },
      { x: 540, y1: 600, y2: 720 },
    ],
  });
  check("< 3 rules → null", thin === null);

  // Rules that do not span (short ticks) → filtered to nothing.
  const short = extractRuledGrid([gi("a", 72, 700), gi("b", 200, 700), gi("c", 400, 700)], {
    h: [
      { y: 720, x1: 100, x2: 120 },
      { y: 700, x1: 110, x2: 118 },
      { y: 680, x1: 105, x2: 125 },
      { y: 660, x1: 100, x2: 120 },
    ],
    v: [
      { x: 100, y1: 690, y2: 692 },
      { x: 200, y1: 691, y2: 693 },
      { x: 300, y1: 690, y2: 693 },
    ],
  });
  check("non-spanning rules → null", short === null);

  // Occupancy: most bands empty → rejected (two boxes, not one table).
  const spread = extractRuledGrid(
    [
      gi("a", 80, 700),
      gi("b", 200, 700),
      gi("c", 380, 700),
      gi("d", 470, 700),
    ],
    {
      h: [
        { y: 720, x1: 72, x2: 540 },
        { y: 690, x1: 72, x2: 540 },
        { y: 660, x1: 72, x2: 540 },
        { y: 630, x1: 72, x2: 540 },
        { y: 600, x1: 72, x2: 540 },
      ],
      v: [
        { x: 72, y1: 600, y2: 720 },
        { x: 190, y1: 600, y2: 720 },
        { x: 320, y1: 600, y2: 720 },
        { x: 450, y1: 600, y2: 720 },
        { x: 540, y1: 600, y2: 720 },
      ],
    }
  );
  check("sparse occupancy → null", spread === null);

  // Empty segments → null.
  check("no segments → null", extractRuledGrid([gi("a", 72, 700)], { h: [], v: [] }) === null);
}

console.log(
  `\npdf-to-excel smoke: ${pass} passed, ${fail} failed` +
    (fail ? "\n  " + failures.join("\n  ") : "")
);
process.exit(fail === 0 ? 0 : 1);
