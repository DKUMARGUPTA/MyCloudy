/** Verify the scan output PDF: page geometry, crop, filter encoding. */
import { readFile } from "node:fs/promises";
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";

let pass = 0, fail = 0;
const check = (l: string, ok: boolean, extra = "") => {
  if (ok) { pass++; } else { fail++; }
  console.log(`  ${ok ? "✓" : "✗ FAIL"}: ${l}${extra ? " — " + extra : ""}`);
};

// usage: bun scripts/verify-scan.ts [file]  (default: newest scan-*.pdf)
import { readdir, stat } from "node:fs/promises";
const arg = process.argv[2];
let target = arg;
if (!target) {
  const files = (await readdir("/home/z/Downloads")).filter((f) => f.startsWith("scan-") && f.endsWith(".pdf"));
  const withStats = await Promise.all(files.map(async (f) => ({ f, m: (await stat(`/home/z/Downloads/${f}`)).mtimeMs })));
  withStats.sort((a, b) => b.m - a.m);
  target = withStats[0]!.f;
}
const bytes = await readFile(target.startsWith("/") ? target : `/home/z/Downloads/${target}`);
console.log(`file: ${target} (${bytes.length} bytes)`);
const doc = await PDFDocument.load(bytes, { updateMetadata: false });

check("1 page", doc.getPageCount() === 1);
const page = doc.getPage(0);
// Landscape source photo (1600x1200) → landscape A4 page (by design).
check("A4 page (orientation follows the photo)", Math.abs(page.getWidth() - 841.89) < 1 && Math.abs(page.getHeight() - 595.28) < 1,
  `${page.getWidth().toFixed(1)}x${page.getHeight().toFixed(1)}`);

// The one image object
let images = 0;
for (const [, obj] of doc.context.enumerateIndirectObjects()) {
  if (obj instanceof PDFRawStream) {
    const st = obj.dict.lookup(PDFName.of("Subtype"));
    if (st === PDFName.of("Image")) {
      images++;
      const w = obj.dict.lookup(PDFName.of("Width"), PDFNumber).asNumber();
      const h = obj.dict.lookup(PDFName.of("Height"), PDFNumber).asNumber();
      const filter = String(obj.dict.get(PDFName.of("Filter")));
      // crop: fixture page was 1000x760 at offset (300,210) on 1600x1200
      // + inset ~0.5% → expect ≈ 985x745 (not the full 1600x1200)
      check("image cropped below full frame", w < 1200 && h < 1000,
        `${w}x${h}`);
      check("crop keeps the page area", w > 850 && h > 620,
        `expect ~985x745`);
      check("magic filter → JPEG (DCTDecode)", filter.includes("DCTDecode"), filter);
      check("producer = DocoPDF Scan",
        String(doc.getProducer()) === "DocoPDF Scan");
    }
  }
}
check("exactly 1 image object", images === 1);
console.log(`\n${pass} passed, ${fail} failed${fail === 0 ? " — ALL PASS" : ""}`);
process.exit(fail > 0 ? 1 : 0);
