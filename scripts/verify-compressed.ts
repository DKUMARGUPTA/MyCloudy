import { readFile } from "node:fs/promises";
import { PDFDocument, PDFName, PDFRawStream, PDFDict } from "pdf-lib";
import {
  collectImageCandidates,
} from "../tools/compress-pdf/engine";

const bytes = await readFile("/home/z/Downloads/qa-p312-fixture-compressed (2).pdf");
const doc = await PDFDocument.load(bytes, { updateMetadata: false });

let pass = 0, fail = 0;
const check = (l: string, ok: boolean, extra = "") => {
  if (ok) { pass++; } else { fail++; }
  console.log(`  ${ok ? "✓" : "✗ FAIL"}: ${l}${extra ? " — " + extra : ""}`);
};

check("4 pages survive", doc.getPageCount() === 4);

// selectable text: font resources must survive + text-show ops in content
const page1 = doc.getPage(0);
const fonts = page1.node.Resources()?.lookup(PDFName.of("Font"));
check("page 1 has font resources (text preserved)", fonts instanceof PDFDict);

// NOTE: pdf-lib writes text as hex strings (<...> Tj), so plain-ASCII literal
// matching is done in scripts/verify-text.ts instead.
const contentsRef = page1.node.get(PDFName.of("Contents"));
const contObj = doc.context.lookup(contentsRef);
if (contObj instanceof PDFRawStream) {
  const { decodePDFRawStream } = await import("pdf-lib/cjs/core/streams/decode");
  const dec = decodePDFRawStream(contObj).decode();
  const s = new TextDecoder("latin1").decode(dec);
  check(
    "content stream has text-show operators (Tj)",
    /\bTj\b/.test(s),
    `${s.match(/Tj/g)?.length ?? 0} Tj ops`
  );
}

const candidates = collectImageCandidates(doc);
console.log(`    images now: ${candidates.map(c => `${c.strategy}@${c.width}x${c.height}`).join(", ")}`);
check("3 images still present", candidates.length === 3);
check("photo downscaled 2200→1600", candidates.some(c => c.width === 1600 && c.height === 1091));
check("photo now DCTDecode jpeg", candidates.some(c => c.strategy === "jpeg" && c.width === 1600));
const small = candidates.filter(c => c.width === 900);
check("alpha image 900x700 kept", small.length === 1);

// original file had photo stream ~1.3MB; check total image bytes now
let imgBytes = 0;
for (const c of candidates) imgBytes += c.stream.contents.length;
check("image payload shrank (< 160 KB)", imgBytes < 160 * 1024, `${(imgBytes/1024).toFixed(0)} KB`);
check("output smaller than input", bytes.length < 1570455, `${(bytes.length/1024).toFixed(0)} KB vs 1534 KB`);

console.log(`\n${pass} passed, ${fail} failed${fail === 0 ? " — ALL PASS" : ""}`);
process.exit(fail > 0 ? 1 : 0);
