/** 2-page grayscale run: rotation applied, crop no-op safety, both JPEG. */
import { readFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";

const files = readdirSync("/home/z/Downloads").filter((f) => f.startsWith("scan-") && f.endsWith(".pdf"));
const arg = process.argv[2];
const name = arg ?? files.sort(
  (a, b) => statSync(`/home/z/Downloads/${b}`).mtimeMs - statSync(`/home/z/Downloads/${a}`).mtimeMs
)[0];
const bytes = await readFile(`/home/z/Downloads/${name}`);
console.log(`file: ${name} (${bytes.length} bytes)`);

let pass = 0, fail = 0;
const check = (l: string, ok: boolean, extra = "") => {
  if (ok) { pass++; } else { fail++; }
  console.log(`  ${ok ? "✓" : "✗ FAIL"}: ${l}${extra ? " — " + extra : ""}`);
};

const doc = await PDFDocument.load(bytes, { updateMetadata: false });
check("2 pages", doc.getPageCount() === 2);

const sizes: string[] = [];
const filters: string[] = [];
for (const [, obj] of doc.context.enumerateIndirectObjects()) {
  if (!(obj instanceof PDFRawStream)) continue;
  if (obj.dict.lookup(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
  const w = obj.dict.lookup(PDFName.of("Width"), PDFNumber).asNumber();
  const h = obj.dict.lookup(PDFName.of("Height"), PDFNumber).asNumber();
  sizes.push(`${w}x${h}`);
  filters.push(String(obj.dict.get(PDFName.of("Filter"))));
}
console.log(`    images: ${sizes.join(", ")} (${filters.join(", ")})`);
check("2 images, both JPEG", sizes.length === 2 && filters.every((f) => f.includes("DCTDecode")));
// page 2 (flat) rotated 90° left: 1200x900 → 900x1200 (uncropped, safety)
check("rotated page keeps full frame (no crop on uniform page)", sizes.includes("900x1200"),
  sizes.join(", "));
// page 1 cropped: ~986x750
check("page 1 auto-cropped", sizes.some((s) => s.startsWith("986x")), sizes.join(", "));
console.log(`\n${pass} passed, ${fail} failed${fail === 0 ? " — ALL PASS" : ""}`);
process.exit(fail > 0 ? 1 : 0);
