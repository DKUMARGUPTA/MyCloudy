/** Verify custom+grayscale+stripMetadata output. */
import { readFile } from "node:fs/promises";
import { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFString, PDFArray } from "pdf-lib";
import { decodePDFRawStream } from "pdf-lib/cjs/core/streams/decode";
import { collectImageCandidates } from "../tools/compress-pdf/engine";

const bytes = await readFile("/home/z/Downloads/qa-p312-fixture-compressed (3).pdf");
const doc = await PDFDocument.load(bytes, { updateMetadata: false });

let pass = 0, fail = 0;
const check = (l: string, ok: boolean, extra = "") => {
  if (ok) { pass++; } else { fail++; }
  console.log(`  ${ok ? "✓" : "✗ FAIL"}: ${l}${extra ? " — " + extra : ""}`);
};

check("4 pages survive", doc.getPageCount() === 4);

// metadata stripped: Title/Producer etc gone
const info = doc.context.trailerInfo?.Info;
let title = "", producer = "";
if (info) {
  const infoDict = doc.context.lookup(info);
  if (infoDict instanceof PDFDict) {
    const t = infoDict.get(PDFName.of("Title"));
    if (t) title = String(doc.context.lookup(t));
    const p = infoDict.get(PDFName.of("Producer"));
    if (p) producer = String(doc.context.lookup(p));
  }
}
check("Info dict empty (Title/Producer stripped)", title === "" && producer === "", `title=${JSON.stringify(title)} producer=${JSON.stringify(producer)}`);

// no XMP metadata stream
let xmpCount = 0;
for (const [, obj] of doc.context.enumerateIndirectObjects()) {
  if (obj instanceof PDFRawStream) {
    const ty = obj.dict.get(PDFName.of("Type"));
    if (ty && String(ty) === "/Metadata") xmpCount++;
  }
}
check("XMP metadata stream removed", xmpCount === 0, `${xmpCount} found`);

// images: all DCTDecode now, grayscale = DeviceGray
const cands = collectImageCandidates(doc);
console.log(`    images: ${cands.map(c => `${c.strategy}@${c.width}x${c.height}`).join(", ")}`);
check("3 images present", cands.length === 3);
check("photo capped at 900 (maxDim)", cands.some(c => c.width === 900));
for (const c of cands) {
  const cs = c.stream.dict.get(PDFName.of("ColorSpace"));
  const csStr = cs ? String(doc.context.lookup(cs as never)) : "";
  check(`image ${c.width}x${c.height} is DeviceGray JPEG`, c.strategy === "jpeg" && csStr === "/DeviceGray", csStr);
}

// text still selectable
const hexToText = (m: string) => {
  const h = m.replace(/[^0-9a-fA-F]/g, "");
  const b = Buffer.from(h, "hex");
  if (b[0] === 0xfe && b[1] === 0xff) {
    let s = "";
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  return b.toString("latin1");
};
const page1 = doc.getPage(0);
const cont = doc.context.lookup(page1.node.get(PDFName.of("Contents")));
let content = "";
const streams: PDFRawStream[] = [];
if (cont instanceof PDFRawStream) streams.push(cont);
else if (cont instanceof PDFArray) {
  for (let j = 0; j < cont.size(); j++) {
    const s = doc.context.lookup(cont.get(j) as never);
    if (s instanceof PDFRawStream) streams.push(s);
  }
}
for (const st of streams) {
  try { content += new TextDecoder("latin1").decode(decodePDFRawStream(st).decode()); } catch {}
}
const shown = [...content.matchAll(/<([0-9a-fA-F\s]+)>\s*Tj/g)].map((m) => hexToText(m[1])).join(" ");
check("page 1 text survives", shown.includes("Compress QA Fixture") && shown.includes("selectable text"), JSON.stringify(shown.slice(0, 60)));

console.log(`\n${pass} passed, ${fail} failed${fail === 0 ? " — ALL PASS" : ""}`);
process.exit(fail > 0 ? 1 : 0);
