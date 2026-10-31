/**
 * PRE-BUILD smoke for PHASE-1 Batch A page-ops tools (reverse-pages,
 * add-blank-page, divide-pages, combine-single-page, pdf-booklet,
 * sanitize-pdf). Proves the engine math + the REAL worker code
 * end-to-end, BEFORE the UI is exercised (the P3.3 lesson).
 *
 *  1. reverse — 3-page marker fixture → reversed reading order (content
 *     stream markers), batch worker path, pdf-lib oracle reload.
 *  2. add-blank — insert positions (start/end/after), sizes (page1/
 *     largest/A4/Letter), blank pages are truly empty, content intact.
 *  3. divide — engine grid math (2×1 halves, 2×2 quadrants, /Rotate 90
 *     axis swap), plan order (rows/columns), E2E box windowing.
 *  4. combine-single — auto columns (ceil sqrt), portrait/landscape
 *     auto, one sheet, form count, page subset.
 *  5. booklet — saddle-stitch sides [8,1][2,7][6,3][4,5], 4-multiple
 *     padding, sheet geometry, E2E form draws.
 *  6. sanitize — raw crafted fixture (JS name tree + OpenAction + URI
 *     annot + EmbeddedFiles + XMP) → all gone, pages byte-exact, names
 *     tree survives for Dests, metadata strip, /Info drop.
 *
 * Run: bun scripts/smoke-pageops-a.ts
 */
import { PDFDocument, StandardFonts } from "pdf-lib";

import type { OptionValues } from "../src/lib/tools/config-types";
import {
  decodeStreamBytes,
  dget,
  latin1,
  listPages,
  parsePdf,
  resolve,
  asName,
  asDict,
} from "../src/lib/own/pdf";
import { runReverse } from "../tools/reverse-pages/worker";
import { runAddBlank } from "../tools/add-blank-page/worker";
import {
  divideCellBox,
  planDivide,
  resolveDivideOptions,
} from "../tools/divide-pages/engine";
import { runDivide } from "../tools/divide-pages/worker";
import { planSheet, resolveCspOptions } from "../tools/combine-single-page/engine";
import { runCombineSingle } from "../tools/combine-single-page/worker";
import {
  bookletSides,
  resolveBklOptions,
  sheetGeometry,
} from "../tools/pdf-booklet/engine";
import { runBooklet } from "../tools/pdf-booklet/worker";
import { planSanitize, resolveSanitizeOptions } from "../tools/sanitize-pdf/engine";
import { runSanitize } from "../tools/sanitize-pdf/worker";

const latin1All = (b: Uint8Array): string => latin1(b, 0, b.length);

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function near(a: number, b: number, eps = 0.01): boolean {
  return Math.abs(a - b) < eps;
}

/** Fixture: n pages, each with a text marker "P1".."Pn" in its content. */
async function markerPdf(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i += 1) {
    const page = doc.addPage([200, 300]);
    page.drawText(`P${i}`, { x: 20, y: 150, size: 24, font });
  }
  return new Uint8Array(await doc.save());
}

/** Read the decoded content stream of a page (own parser). */
function pageContent(bytes: Uint8Array, pageIndex: number): string {
  const doc = parsePdf(bytes);
  const pages = listPages(doc);
  const page = pages[pageIndex]!;
  const contents = resolve(doc, page.dict.get("Contents"));
  if (contents === undefined) return "";
  if (contents.k === "stream") {
    return latin1All(decodeStreamBytes(contents.raw, contents.m));
  }
  if (contents.k === "arr") {
    const parts: string[] = [];
    for (const item of contents.items) {
      const s = resolve(doc, item);
      if (s?.k === "stream") parts.push(latin1All(decodeStreamBytes(s.raw, s.m)));
    }
    return parts.join("\n");
  }
  return "";
}

/* ------------------------------------------------------------------ */
console.log("1. reverse-pages");

{
  const bytes = await markerPdf(3);
  const out = await runReverse(bytes);
  check("page count stays 3", listPages(parsePdf(out)).length === 3);
  const c0 = pageContent(out, 0);
  const c2 = pageContent(out, 2);
  check("page 1 now holds P3", c0.includes("<5033>"), c0.slice(0, 60));
  check("page 3 now holds P1", c2.includes("<5031>"), c2.slice(0, 60));
  const oracle = await PDFDocument.load(out);
  check("pdf-lib oracle reload", oracle.getPageCount() === 3);
}

/* ------------------------------------------------------------------ */
console.log("2. add-blank-page");

{
  const bytes = await markerPdf(3);

  const end = (await runAddBlank(bytes, {
    position: "end", afterPage: 1, count: 2, size: "page1",
  })).bytes;
  const endDoc = parsePdf(end);
  check("end: 5 pages", listPages(endDoc).length === 5);
  check("end: blanks at 4-5 are empty", pageContent(end, 3) === "" && pageContent(end, 4) === "");
  check("end: page 3 still P3", pageContent(end, 2).includes("<5033>"));
  check(
    "end: blank matches page-1 box",
    near(listPages(endDoc)[3]!.mediaBox[2], 200) && near(listPages(endDoc)[3]!.mediaBox[3], 300)
  );

  const after = (await runAddBlank(bytes, {
    position: "after", afterPage: 2, count: 1, size: "a4",
  })).bytes;
  const afterDoc = parsePdf(after);
  check("after: 4 pages", listPages(afterDoc).length === 4);
  check("after: blank at 3, P3 at 4", pageContent(after, 2) === "" && pageContent(after, 3).includes("<5033>"));
  check(
    "after: A4 blank",
    near(listPages(afterDoc)[2]!.mediaBox[2], 595.28) && near(listPages(afterDoc)[2]!.mediaBox[3], 841.89)
  );

  const start = (await runAddBlank(bytes, {
    position: "start", afterPage: 1, count: 1, size: "letter",
  })).bytes;
  const startDoc = parsePdf(start);
  check("start: 4 pages", listPages(startDoc).length === 4);
  check("start: blank first, P1 second", pageContent(start, 0) === "" && pageContent(start, 1).includes("<5031>"));
  check(
    "start: Letter blank",
    near(listPages(startDoc)[0]!.mediaBox[2], 612) && near(listPages(startDoc)[0]!.mediaBox[3], 792)
  );

  // largest: mixed sizes pick the bigger.
  const mixed = await PDFDocument.create();
  const font = await mixed.embedFont(StandardFonts.Helvetica);
  const p1 = mixed.addPage([200, 300]);
  p1.drawText("P1", { x: 20, y: 150, size: 24, font });
  const p2 = mixed.addPage([400, 600]);
  p2.drawText("P2", { x: 20, y: 150, size: 24, font });
  const mixedBytes = new Uint8Array(await mixed.save());
  const largest = (await runAddBlank(mixedBytes, {
    position: "end", afterPage: 1, count: 1, size: "largest",
  })).bytes;
  const largestDoc = parsePdf(largest);
  check(
    "largest: blank matches the 400×600 page",
    near(listPages(largestDoc)[2]!.mediaBox[2], 400) && near(listPages(largestDoc)[2]!.mediaBox[3], 600)
  );

  const oracle = await PDFDocument.load(end);
  check("pdf-lib oracle reload", oracle.getPageCount() === 5);
}

/* ------------------------------------------------------------------ */
console.log("3. divide-pages (engine math)");

{
  const view = { x: 0, y: 0, width: 200, height: 300 };
  const tl = divideCellBox(view, 0, 2, 2, 0, 0);
  const tr = divideCellBox(view, 0, 2, 2, 1, 0);
  const bl = divideCellBox(view, 0, 2, 2, 0, 1);
  check("2×2 TL is top-left quadrant", near(tl.x, 0) && near(tl.y, 150) && near(tl.width, 100) && near(tl.height, 150), JSON.stringify(tl));
  check("2×2 TR is top-right", near(tr.x, 100) && near(tr.y, 150) && near(tr.width, 100));
  check("2×2 BL is bottom-left", near(bl.x, 0) && near(bl.y, 0) && near(bl.width, 100) && near(bl.height, 150));

  // /Rotate 90: display left/right slices the USER-SPACE Y axis.
  const rotL = divideCellBox(view, 90, 2, 1, 0, 0);
  const rotR = divideCellBox(view, 90, 2, 1, 1, 0);
  check("rotate90 left half = user-space BOTTOM", near(rotL.y, 0) && near(rotL.height, 150), JSON.stringify(rotL));
  check("rotate90 right half = user-space TOP", near(rotR.y, 150) && near(rotR.height, 150), JSON.stringify(rotR));

  const rows = planDivide([0], { columns: 3, rows: 2, order: "rows" });
  check(
    "rows order = reading order",
    JSON.stringify(rows.map((e) => `${e.col},${e.row}`)) === JSON.stringify(["0,0", "1,0", "2,0", "0,1", "1,1", "2,1"])
  );
  const cols = planDivide([0], { columns: 3, rows: 2, order: "columns" });
  check(
    "columns order = top-down then right",
    JSON.stringify(cols.map((e) => `${e.col},${e.row}`)) === JSON.stringify(["0,0", "0,1", "1,0", "1,1", "2,0", "2,1"])
  );

  const resolved = resolveDivideOptions({ columns: "99", rows: "0", order: "weird", pages: "2-" });
  check("options clamp (cols≤4, rows≥1, order default)", resolved.columns === 4 && resolved.rows === 1 && resolved.order === "rows");

  // E2E: one 200×300 page → 2×2 = 4 pages.
  const bytes = await markerPdf(1);
  const out = (await runDivide(bytes, { columns: 2, rows: 2, order: "rows", pages: "all" })).bytes;
  const outDoc = parsePdf(out);
  const pages = listPages(outDoc);
  check("E2E: 4 output pages", pages.length === 4);
  check("E2E: each quadrant 100×150", pages.every((p) => near(p.mediaBox[2] - p.mediaBox[0], 100) && near(p.mediaBox[3] - p.mediaBox[1], 150)));
  check("E2E: content marker survives", pageContent(out, 0).includes("<5031>"));
  const oracle = await PDFDocument.load(out);
  check("E2E: pdf-lib oracle reload", oracle.getPageCount() === 4);

  // Grid < 2 pieces → typed error.
  let gridError = "";
  try {
    await runDivide(bytes, { columns: 1, rows: 1, order: "rows", pages: "all" });
  } catch (e) {
    gridError = (e as Error).message;
  }
  check("E2E: 1×1 grid rejected with dv.errorGrid", gridError === "dv.errorGrid", gridError);
}

/* ------------------------------------------------------------------ */
console.log("4. combine-single-page (engine math + E2E)");

{
  const auto6 = planSheet(6, resolveCspOptions({ columns: 0, paper: "a4", orientation: "auto", margin: 6, gap: 4, pages: "all" }), null);
  check("auto columns = ceil(sqrt(6)) = 3", auto6.columns === 3 && auto6.rows === 2);
  check("auto portrait for 3×2 (cols>rows → landscape)", auto6.width === 841.89 && auto6.height === 595.28, `${auto6.width}x${auto6.height}`);
  const auto9 = planSheet(9, resolveCspOptions({ columns: 0, paper: "a4", orientation: "auto", margin: 6, gap: 4, pages: "all" }), null);
  check("auto portrait for square 3×3", auto9.width === 595.28 && auto9.height === 841.89);
  const match = planSheet(4, resolveCspOptions({ columns: 2, paper: "match", orientation: "auto", margin: 0, gap: 0, pages: "all" }), { w: 400, h: 600 });
  check("match paper uses page-1 size", match.width === 400 && match.height === 600);
  check("cells tile the sheet", near(match.cells[0]!.w, 200) && near(match.cells[1]!.x, 200));

  const bytes = await markerPdf(5);
  const out = (await runCombineSingle(bytes, { paper: "a4", orientation: "portrait", columns: 0, margin: 6, gap: 4, pages: "all" })).bytes;
  const outDoc = parsePdf(out);
  const pages = listPages(outDoc);
  check("E2E: exactly one output page", pages.length === 1);
  check("E2E: sheet is A4 portrait", near(pages[0]!.mediaBox[2], 595.28) && near(pages[0]!.mediaBox[3], 841.89));
  const content = pageContent(out, 0);
  const doCount = (content.match(/ Do/g) ?? []).length;
  check("E2E: 5 form draws on the sheet", doCount === 5, `found ${doCount}`);
  const oracle = await PDFDocument.load(out);
  check("E2E: pdf-lib oracle reload", oracle.getPageCount() === 1);

  // Subset: only pages 1-2 → 2 draws.
  const sub = (await runCombineSingle(bytes, { paper: "a4", orientation: "portrait", columns: 0, margin: 6, gap: 4, pages: "1-2" })).bytes;
  const subContent = pageContent(sub, 0);
  check("E2E: subset places 2 pages", ((subContent.match(/ Do/g) ?? []).length) === 2);
}

/* ------------------------------------------------------------------ */
console.log("5. pdf-booklet (imposition math + E2E)");

{
  const sides8 = bookletSides(8);
  check(
    "8-page imposition = [8,1][2,7][6,3][4,5]",
    JSON.stringify(sides8) === JSON.stringify([
      { left: 8, right: 1 }, { left: 2, right: 7 }, { left: 6, right: 3 }, { left: 4, right: 5 },
    ]),
    JSON.stringify(sides8)
  );
  const sides5 = bookletSides(5);
  check("5 pages pad to 8 → 4 sides", sides5.length === 4 && sides5[0]!.left === 8);
  const sides12 = bookletSides(12);
  check("12 pages → 6 sides", sides12.length === 6 && sides12[0]!.left === 12 && sides12[0]!.right === 1);

  const geo = sheetGeometry("a4", 0, 0);
  check("A4 booklet sheet is landscape A4", near(geo.width, 841.89) && near(geo.height, 595.28));
  check("two half slots", near(geo.left.w, 841.89 / 2) && near(geo.right.x, 841.89 / 2));
  const geoGap = sheetGeometry("letter", 6, 3);
  const marginPt = 6 * 72 / 25.4;
  check(
    "margins+gap shrink slots",
    geoGap.left.w < 792 / 2 && near(geoGap.left.x, marginPt) && near(geoGap.right.x - (geoGap.left.x + geoGap.left.w), 3 * 72 / 25.4),
    `slotW=${geoGap.left.w}`
  );

  const bytes = await markerPdf(8);
  const out = (await runBooklet(bytes, { paper: "a4", margin: 0, gap: 0, pages: "all" })).bytes;
  const outDoc = parsePdf(out);
  const pages = listPages(outDoc);
  check("E2E: 4 output sides", pages.length === 4);
  check("E2E: sides are landscape A4", pages.every((p) => near(p.mediaBox[2], 841.89) && near(p.mediaBox[3], 595.28)));
  // Side 1 draws P8 (left) + P1 (right); side 2 draws P2 + P7.
  const sideOps = [0, 1, 2, 3].map((i) => pageContent(out, i));
  check(
    "E2E: every side draws exactly 2 forms",
    sideOps.every((ops) => (ops.match(/ Do/g) ?? []).length === 2)
  );
  const oracle = await PDFDocument.load(out);
  check("E2E: pdf-lib oracle reload", oracle.getPageCount() === 4);

  // 5-page doc: padded booklet still folds cleanly (4 sides, one slot empty).
  const bytes5 = await markerPdf(5);
  const out5 = (await runBooklet(bytes5, { paper: "a4", margin: 0, gap: 0, pages: "all" })).bytes;
  const out5Doc = parsePdf(out5);
  const pages5 = listPages(out5Doc);
  check("E2E: 5-page doc → 4 padded sides", pages5.length === 4);
  let emptySlots = 0;
  for (let i = 0; i < 4; i += 1) {
    const ops = pageContent(out5, i);
    const c = (ops.match(/ Do/g) ?? []).length;
    if (c === 1) emptySlots += 1;
    check(`E2E: side ${i + 1} draws 1-2 forms`, c === 1 || c === 2, `${c} draws`);
  }
  check("E2E: exactly 3 padded blank slots", emptySlots === 3, `${emptySlots} single-draw sides`);
}

/* ------------------------------------------------------------------ */
console.log("6. sanitize-pdf (crafted raw fixture)");

{
  // Hand-authored classic PDF with ALL the active bits: a JS name tree,
  // an /OpenAction, a /URI annotation, an /EmbeddedFiles entry with a
  // real embedded stream, XMP /Metadata, and a Dests name tree that MUST
  // survive. Content page carries a text marker.
  const js = "app.alert\\('pwned'\\);";
  const efPayload = "MALWARE-BYTES-HERE";
  const xmp = "<x:xmpmeta xmlns:x='adobe:ns:meta/'>fake</x:xmpmeta>";
  const parts: string[] = [];
  parts.push("%PDF-1.7\n");
  const offsets: number[] = [];
  const body = (n: number) => {
    switch (n) {
      case 1: return `1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Names 5 0 R /OpenAction 9 0 R /Metadata 11 0 R >>\nendobj\n`;
      case 2: return `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`;
      case 3: return `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 4 0 R /Resources << /Font << /F1 10 0 R >> >> /Annots [12 0 R] >>\nendobj\n`;
      case 4: return `4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 24 Tf 20 150 Td (P1) Tj ET\nendstream\nendobj\n`;
      case 5: return `5 0 obj\n<< /Dests 6 0 R /JavaScript 7 0 R /EmbeddedFiles 8 0 R >>\nendobj\n`;
      case 6: return `6 0 obj\n<< /Names [(d1) [3 0 R /Fit]] >>\nendobj\n`;
      case 7: return `7 0 obj\n<< /Names [(js1) 13 0 R] >>\nendobj\n`;
      case 8: return `8 0 obj\n<< /Names [(evil.exe) 14 0 R] >>\nendobj\n`;
      case 9: return `9 0 obj\n<< /S /JavaScript /JS (${js}) >>\nendobj\n`;
      case 10: return `10 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;
      case 11: return `11 0 obj\n<< /Type /Metadata /Subtype /XML /Length ${xmp.length} >>\nstream\n${xmp}\nendstream\nendobj\n`;
      case 12: return `12 0 obj\n<< /Type /Annot /Subtype /Link /Rect [10 10 80 30] /A << /S /URI /URI (https://evil.example) >> >>\nendobj\n`;
      case 13: return `13 0 obj\n<< /S /JavaScript /JS (${js}) >>\nendobj\n`;
      case 14: return `14 0 obj\n<< /Type /Filespec /F (evil.exe) /EF << /F 15 0 R /UF 15 0 R >> >>\nendobj\n`;
      case 15: return `15 0 obj\n<< /Type /EmbeddedFile /Length ${efPayload.length} >>\nstream\n${efPayload}\nendstream\nendobj\n`;
      default: throw new Error("bad obj");
    }
  };
  for (let n = 1; n <= 15; n += 1) {
    offsets[n] = parts[0].length + parts.slice(1).reduce((a, p) => a + p.length, 0);
    parts.push(body(n));
  }
  const xrefPos = parts.reduce((a, p) => a + p.length, 0);
  parts.push(`xref\n0 16\n0000000000 65535 f \n`);
  for (let n = 1; n <= 15; n += 1) {
    parts.push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  }
  parts.push(`trailer\n<< /Size 16 /Root 1 0 R /Info 16 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  // /Info object appended after startxref computation is tricky — put it
  // BEFORE xref instead. Rebuild cleanly:
  parts.length = 0;
  parts.push("%PDF-1.7\n");
  const offs: number[] = [];
  const all = (n: number) => n === 16
    ? `16 0 obj\n<< /Producer (SmokeTest) /Title (Dirty) >>\nendobj\n`
    : body(n);
  for (let n = 1; n <= 16; n += 1) {
    offs[n] = parts.reduce((a, p) => a + p.length, 0);
    parts.push(all(n));
  }
  const xp = parts.reduce((a, p) => a + p.length, 0);
  parts.push(`xref\n0 17\n0000000000 65535 f \n`);
  for (let n = 1; n <= 16; n += 1) {
    parts.push(`${String(offs[n]).padStart(10, "0")} 00000 n \n`);
  }
  parts.push(`trailer\n<< /Size 17 /Root 1 0 R /Info 16 0 R >>\nstartxref\n${xp}\n%%EOF\n`);
  const dirty = new TextEncoder().encode(parts.join(""));

  // Sanity: our parser reads it.
  const dirtyDoc = parsePdf(dirty);
  check("fixture parses", listPages(dirtyDoc).length === 1);

  const opts = resolveSanitizeOptions({ stripJavaScript: true, stripEmbeddedFiles: true, stripActions: true, stripMetadata: true });
  check("options resolve", opts.stripJavaScript && opts.stripEmbeddedFiles && opts.stripActions && opts.stripMetadata);

  // Plan-level findings.
  const dirtyPages = listPages(dirtyDoc).map((p) => ({ ref: p.ref, dict: p.dict }));
  const plan = planSanitize(dirtyDoc, dirtyPages, opts);
  check("plan: 1 JS entry found", plan.findings.javascript === 1, String(plan.findings.javascript));
  check("plan: 1 embedded file found", plan.findings.embeddedFiles === 1, String(plan.findings.embeddedFiles));
  check("plan: OpenAction + annot URI counted", plan.findings.actions >= 2, String(plan.findings.actions));
  check("plan: metadata flagged", plan.findings.metadata);
  check("plan: catalog replacement present", plan.replacements.has(1));
  check("plan: page replacement present", plan.replacements.has(3));
  check("plan: JS subtree objects deleted", plan.deletions.has(7) && plan.deletions.has(13));
  check("plan: EmbeddedFiles subtree deleted", plan.deletions.has(8) && plan.deletions.has(14) && plan.deletions.has(15));
  check("plan: XMP deleted", plan.deletions.has(11));
  check("plan: /Info dropped", plan.dropInfo);

  // E2E run.
  const out = (await runSanitize(dirty, {
    stripJavaScript: true, stripEmbeddedFiles: true, stripActions: true, stripMetadata: true,
  })).bytes;
  const latin1Out = latin1All(out);
  check("E2E: JS payload gone", !latin1Out.includes("pwned"));
  check("E2E: embedded payload gone", !latin1Out.includes("MALWARE-BYTES"));
  check("E2E: XMP gone", !latin1Out.includes("x:xmpmeta"));
  check("E2E: URI action gone", !latin1Out.includes("evil.example"));
  check("E2E: page marker survives", pageContent(out, 0).includes("(P1)"));

  const cleanDoc = parsePdf(out);
  const catalogObj = resolve(cleanDoc, cleanDoc.trailer.get("Root"));
  const catalog = asDict(catalogObj);
  check("E2E: catalog has no /OpenAction", catalog !== undefined && !catalog.has("OpenAction"));
  const namesObj = resolve(cleanDoc, catalog?.get("Names"));
  const names = asDict(namesObj);
  check("E2E: /Names survives with Dests", names !== undefined && names.has("Dests"));
  check("E2E: /Names lost JavaScript + EmbeddedFiles", names !== undefined && !names.has("JavaScript") && !names.has("EmbeddedFiles"));
  const pagesOut = listPages(cleanDoc);
  check("E2E: 1 page survives", pagesOut.length === 1);
  const annots = resolve(cleanDoc, pagesOut[0]!.dict.get("Annots"));
  const annotArr = annots?.k === "arr" ? annots.items : [];
  const annot0 = annotArr[0] ? asDict(resolve(cleanDoc, annotArr[0])) : undefined;
  check("E2E: annot survives without /A", annot0 !== undefined && annot0.has("Rect") && !annot0.has("A"));
  check("E2E: /Info dropped from trailer", cleanDoc.trailer.get("Info") === undefined);

  const oracle = await PDFDocument.load(out);
  check("E2E: pdf-lib oracle reload", oracle.getPageCount() === 1);

  // Metadata OFF variant: XMP + /Info survive.
  const keep = (await runSanitize(dirty, {
    stripJavaScript: true, stripEmbeddedFiles: true, stripActions: true, stripMetadata: false,
  })).bytes;
  const keepDoc = parsePdf(keep);
  check("E2E: metadata kept when off", keepDoc.trailer.get("Info") !== undefined && latin1All(keep).includes("x:xmpmeta"));
}

/* ------------------------------------------------------------------ */
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
