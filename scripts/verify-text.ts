/**
 * Verify text layer integrity of the browser-compressed PDF.
 * pdf-lib writes text as hex strings (<FEFF...> Tj in UTF-16 w/ BOM),
 * so decode hex pairs before matching.
 */
import { readFile } from "node:fs/promises";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { decodePDFRawStream } from "pdf-lib/cjs/core/streams/decode";

const bytes = await readFile("/home/z/Downloads/qa-p312-fixture-compressed (2).pdf");
const doc = await PDFDocument.load(bytes, { updateMetadata: false });

let pass = 0, fail = 0;
const check = (l: string, ok: boolean, extra = "") => {
  if (ok) { pass++; } else { fail++; }
  console.log(`  ${ok ? "✓" : "✗ FAIL"}: ${l}${extra ? " — " + extra : ""}`);
};

const hexToText = (m: string) => {
  const h = m.replace(/[^0-9a-fA-F]/g, "");
  const b = Buffer.from(h, "hex");
  // UTF-16BE BOM → decode as utf16be
  if (b[0] === 0xfe && b[1] === 0xff) {
    let s = "";
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  return b.toString("latin1");
};

for (const [i, page] of doc.getPages().entries()) {
  const contentsObj = page.node.get(PDFName.of("Contents"));
  const resolved = doc.context.lookup(contentsObj);
  const streams: PDFRawStream[] = [];
  if (resolved instanceof PDFRawStream) streams.push(resolved);
  else if (resolved && "asArray" in (resolved as object)) {
    const arr = resolved as unknown as { size(): number; get(n: number): unknown };
    for (let j = 0; j < arr.size(); j++) {
      const s = doc.context.lookup(arr.get(j) as never);
      if (s instanceof PDFRawStream) streams.push(s);
    }
  }
  let content = "";
  for (const s of streams) {
    try { content += new TextDecoder("latin1").decode(decodePDFRawStream(s).decode()); } catch (e) { console.log(e); }
  }
  const tjCount = (content.match(/Tj\b/g) ?? []).length;
  const shown = [...content.matchAll(/<([0-9a-fA-F\s]+)>\s*Tj/g)].map((m) => hexToText(m[1]));
  const all = shown.join(" | ");
  check(`page ${i + 1}: text-show ops present`, tjCount >= 2, `${tjCount} Tj ops`);
  check(`page ${i + 1}: "Compress QA Fixture" text survives`, shown.some((t) => t.includes("Compress QA Fixture")), JSON.stringify(all).slice(0, 90));
  check(`page ${i + 1}: selectable-body text survives`, shown.some((t) => t.includes("selectable text")), "");
}
console.log(`\n${pass} passed, ${fail} failed${fail === 0 ? " — ALL PASS" : ""}`);
process.exit(fail > 0 ? 1 : 0);
