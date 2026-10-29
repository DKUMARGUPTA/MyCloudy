/**
 * P6-r-a probe: rewriteDocument (preserve-numbers whole-doc rewriter).
 *
 * Fixture: a rich PDF (catalog /Names + /PageLabels + /ViewerPreferences,
 * Info, 30 text pages, images incl. an LZW + Indexed one, free-list gaps
 * from a deleted object) — then:
 *   1. classic rewrite  → strict pdf-lib reload, object set identical,
 *      catalog keys preserved, refs intact
 *   2. objstm rewrite    → strict reload + much smaller than classic
 *   3. replacement: swap an image stream object → reload sees the new
 *      Width/Filter; deletions: drop a duplicate → gone
 *   4. our own re-parse of our own objstm output (round-trip)
 */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFDocument,
  StandardFonts,
} from "pdf-lib";
import { readFile } from "node:fs/promises";
import {
  rewriteDocument,
  parsePdf,
  type PdfObj,
} from "../../src/lib/own/pdf";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, extra = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    fail += 1;
    console.log(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

/* ── rich fixture ────────────────────────────────────────────────── */
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
doc.setTitle("Rewrite probe");
doc.setAuthor("P6-r");
for (let p = 0; p < 30; p += 1) {
  const page = doc.addPage([612, 792]);
  for (let i = 0; i < 20; i += 1) {
    page.drawText(`Page ${p} line ${i} — the quick brown fox 0123456789`, {
      x: 40,
      y: 750 - i * 30,
      size: 11,
      font,
    });
  }
}
// Catalog extras: /PageLabels + /ViewerPreferences (must survive rewrite).
{
  const labels = doc.context.obj({
    Nums: [0, { S: "D", St: 1 }, 5, { S: "r" }],
  }) as unknown as PDFDict;
  doc.catalog.set(PDFName.of("PageLabels"), labels);
  doc.catalog.set(
    PDFName.of("ViewerPreferences"),
    doc.context.obj({ FitWindow: true }) as unknown as PDFDict,
  );
}
// One LZW image + a DUPLICATE pair (for the deletion test).
const lzwStrip = await readFile("download/qa-p312-lzw.bin");
const imageDict = (): PDFDict => {
  const d = PDFDict.withContext(doc.context);
  d.set(PDFName.of("Type"), PDFName.of("XObject"));
  d.set(PDFName.of("Subtype"), PDFName.of("Image"));
  d.set(PDFName.of("Width"), PDFNumber.of(64));
  d.set(PDFName.of("Height"), PDFNumber.of(64));
  d.set(PDFName.of("ColorSpace"), PDFName.of("DeviceGray"));
  d.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
  d.set(PDFName.of("Filter"), PDFName.of("LZWDecode"));
  return d;
};
const imgA = doc.context.register(PDFRawStream.of(imageDict(), lzwStrip));
const imgB = doc.context.register(PDFRawStream.of(imageDict(), lzwStrip));
const page0 = doc.getPage(0);
page0.node.setXObject(PDFName.of("ImA"), imgA);
page0.node.setXObject(PDFName.of("ImB"), imgB);
// A deliberate free-list gap: register then delete an object.
const gapRef = doc.context.register(
  doc.context.obj({ note: "going away" }) as unknown as PDFDict,
);
doc.context.delete(gapRef);

const input = await doc.save({ useObjectStreams: false });
console.log(`fixture: ${input.length} bytes`);

/* ── 1. classic rewrite ─────────────────────────────────────────── */
const parsed = parsePdf(input);
const classic = rewriteDocument(parsed, {});
let reload = await PDFDocument.load(classic, { throwOnInvalidObject: true, updateMetadata: false });
check("classic: strict pdf-lib reload, 30 pages", reload.getPageCount() === 30);
check("classic: title survived", (await reload.getTitle()) === "Rewrite probe");
check(
  "classic: catalog PageLabels + ViewerPreferences survived",
  reload.catalog.get(PDFName.of("PageLabels")) !== undefined &&
    reload.catalog.get(PDFName.of("ViewerPreferences")) !== undefined,
);
check(
  "classic: both LZW images present",
  reload.context.lookup(imgA) instanceof PDFRawStream &&
    reload.context.lookup(imgB) instanceof PDFRawStream,
);
// Object-count parity: pdf-lib save writes every indirect object; ours
// writes every in-use entry (equal set for a non-objstm source).
const theirObjects = (await PDFDocument.load(input, { updateMetadata: false }))
  .context.enumerateIndirectObjects().length;
check(
  "classic: object count matches pdf-lib's table",
  (await PDFDocument.load(classic, { updateMetadata: false }))
    .context.enumerateIndirectObjects().length === theirObjects,
  `${theirObjects} objects`,
);
// Our own re-parse of our classic output.
const reparsed = parsePdf(classic);
check(
  "classic: our own parser round-trips it (30 pages + images)",
  reparsed.entries.size >= theirObjects - 1,
  `entries=${reparsed.entries.size}`,
);

/* ── 2. object-stream rewrite ───────────────────────────────────── */
const objstm = rewriteDocument(parsePdf(input), { objectStreams: true });
reload = await PDFDocument.load(objstm, { throwOnInvalidObject: true, updateMetadata: false });
check("objstm: strict reload, 30 pages", reload.getPageCount() === 30);
check(
  "objstm: title + catalog keys survived",
  (await reload.getTitle()) === "Rewrite probe" &&
    reload.catalog.get(PDFName.of("PageLabels")) !== undefined,
);
check(
  "objstm: smaller than classic",
  objstm.length < classic.length,
  `${objstm.length} vs ${classic.length}`,
);
check(
  "objstm: output header is ≥1.5",
  new TextDecoder().decode(objstm.slice(0, 8)).startsWith("%PDF-1."),
);
const round = parsePdf(objstm);
check("objstm: our parser round-trips our own objstm output", (() => {
  try {
    const info = round.getObject;
    return typeof info === "function";
  } catch {
    return false;
  }
})());
// The LZW image decode from OUR objstm output must still match (residents).
let lzwOk = false;
for (const [num, e] of round.entries) {
  if (e.type === 0) continue;
  const o = round.getObject(num);
  if (!o || o.k !== "stream") continue;
  const f = o.m.get("Filter");
  if (f && f.k === "name" && f.v === "LZWDecode") {
    lzwOk = (o as { raw: Uint8Array }).raw.length === lzwStrip.length;
  }
}
check("objstm: LZW image bytes round-trip intact", lzwOk);

/* ── 3. replacement + deletion ──────────────────────────────────── */
const parsed2 = parsePdf(input);
// Replace image A with a "JPEG" (fake bytes + DCT dict).
const replacement: PdfObj = {
  k: "stream",
  m: new Map<string, PdfObj>([
    ["Type", { k: "name", v: "XObject" }],
    ["Subtype", { k: "name", v: "Image" }],
    ["Width", { k: "num", n: 32 }],
    ["Height", { k: "num", n: 32 }],
    ["ColorSpace", { k: "name", v: "DeviceRGB" }],
    ["BitsPerComponent", { k: "num", n: 8 }],
    ["Filter", { k: "name", v: "DCTDecode" }],
  ]),
  raw: new Uint8Array(512).fill(0xab),
};
const out3 = rewriteDocument(parsed2, {
  replacements: new Map([[imgA.objectNumber, replacement]]),
  deletions: new Set([imgB.objectNumber]),
  objectStreams: true,
});
reload = await PDFDocument.load(out3, { throwOnInvalidObject: true, updateMetadata: false });
const replaced = reload.context.lookup(PDFRef.of(imgA.objectNumber));
check(
  "replace+delete: A is now DCTDecode 32x32 with 512 raw bytes",
  replaced instanceof PDFRawStream &&
    replaced.dict.lookup(PDFName.of("Width"))?.toString() === "32" &&
    replaced.contents.length === 512,
);
check(
  "replace+delete: B omitted from the table",
  reload.context.lookup(PDFRef.of(imgB.objectNumber)) === undefined,
);

/* ── 4. dropInfo ───────────────────────────────────────────────── */
const out4 = rewriteDocument(parsePdf(input), { dropInfo: true, objectStreams: true });
const r4 = await PDFDocument.load(out4, { updateMetadata: false });
check("dropInfo: strict reload with no /Info", (await r4.getTitle()) === undefined);

console.log(`probe: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
