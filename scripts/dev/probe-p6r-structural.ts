/**
 * P6-r-a probe: where do compress-to-size structural savings come from?
 * Measures pdf-lib load→save(useObjectStreams) vs our own engine on the
 * SAME 60-page text fixture the smoke uses.
 */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFileSync } from "node:fs";
import { parseForOrganize, organizePdf } from "../../src/lib/own/pdf";

const doc = await PDFDocument.create();
doc.setTitle("probe fixture");
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let p = 0; p < 60; p += 1) {
  const page = doc.addPage([612, 792]);
  for (let i = 0; i < 40; i += 1) {
    page.drawText(
      `Line ${i}: the quick brown fox jumps over the lazy dog 0123456789 ${p}-${i}`,
      { x: 40, y: 750 - i * 16, size: 10, font }
    );
  }
}
const input = await doc.save({ useObjectStreams: false });
writeFileSync("download/probe-p6r-input.pdf", input);
console.log("input (no objstm):", input.length);

const withObj = await doc.save({ useObjectStreams: true });
console.log("fresh save (objstm):", withObj.length);

const reloaded = await PDFDocument.load(input, { updateMetadata: false });
const reSaved = await reloaded.save({ useObjectStreams: true });
console.log("load→save (objstm):", reSaved.length);

// Our own engine: identity organize (all pages, no deltas).
try {
  const src = parseForOrganize(input);
  console.log(
    "own parse ok, pages:",
    src.pages.length,
    "xref entries:",
    src.doc.entries.size,
    "recovered:",
    src.doc.recovered,
  );
  const out = organizePdf(
    input,
    src.pages.map((_, i) => ({ kind: "keep" as const, src: i })),
  );
  console.log("own identity organize:", out.bytes.length);
  writeFileSync("download/probe-p6r-own-identity.pdf", out.bytes);
} catch (e) {
  console.log("own organize FAILED:", e);
}
