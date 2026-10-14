/** Verify the Text (bw) scan output: PNG, DeviceGray, two-tone pixels. */
import { readFile } from "node:fs/promises";
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import { inflateSync } from "node:zlib";
import { statSync } from "node:fs";

import { readdirSync } from "node:fs";
const files = readdirSync("/home/z/Downloads").filter((f) => f.startsWith("scan-") && f.endsWith(".pdf"));
// newest by mtime (browser dedupes name collisions with " (1)")
const arg = process.argv[2];
const name = arg ?? files.sort(
  (a, b) => (statSync(`/home/z/Downloads/${b}`).mtimeMs - statSync(`/home/z/Downloads/${a}`).mtimeMs)
)[0];
const bytes = await readFile(`/home/z/Downloads/${name}`);
console.log(`file: ${name} (${bytes.length} bytes)`);

let pass = 0, fail = 0;
const check = (l: string, ok: boolean, extra = "") => {
  if (ok) { pass++; } else { fail++; }
  console.log(`  ${ok ? "✓" : "✗ FAIL"}: ${l}${extra ? " — " + extra : ""}`);
};

const doc = await PDFDocument.load(bytes, { updateMetadata: false });
check("1 page", doc.getPageCount() === 1);

for (const [, obj] of doc.context.enumerateIndirectObjects()) {
  if (!(obj instanceof PDFRawStream)) continue;
  if (obj.dict.lookup(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
  const w = obj.dict.lookup(PDFName.of("Width"), PDFNumber).asNumber();
  const h = obj.dict.lookup(PDFName.of("Height"), PDFNumber).asNumber();
  const filter = String(obj.dict.get(PDFName.of("Filter")));
  const cs = String(obj.dict.lookup(PDFName.of("ColorSpace")));
  const bpc = obj.dict.lookup(PDFName.of("BitsPerComponent"), PDFNumber).asNumber();
  check("Text filter → FlateDecode PNG", filter.includes("FlateDecode"), filter);
  // Canvas PNGs keep the alpha-derived RGB layout — pdf-lib embeds them
  // as 8bpc DeviceRGB. Two-tone (0/255) is what matters: lossless text.
  check("8-bit colour space (lossless two-tone)", (cs === "/DeviceRGB" || cs === "/DeviceGray") && bpc === 8, `${cs} ${bpc}bpc`);
  check("still cropped", w < 1200 && h < 1000, `${w}x${h}`);
  // pdf-lib embedPng stores raw pixels (already un-filtered) in one zlib
  // stream: RGB rows of stride w*3 for DeviceRGB, w*1 for DeviceGray.
  const raw = inflateSync(Buffer.from(obj.contents));
  const stride = cs === "/DeviceGray" ? w : w * 3;
  let black = 0;
  let total = 0;
  let pureTwoTone = true;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const v = raw[y * stride + x * (cs === "/DeviceGray" ? 1 : 3)];
      if (v === undefined) continue;
      total++;
      if (v < 128) black++;
      if (v !== 0 && v !== 255) pureTwoTone = false;
    }
  }
  const ratio = black / Math.max(1, total);
  check("output is strictly two-tone (0/255)", pureTwoTone);
  check("ink coverage sane (2–60%)", ratio > 0.02 && ratio < 0.6, (ratio * 100).toFixed(1) + "%");
}
console.log(`\n${pass} passed, ${fail} failed${fail === 0 ? " — ALL PASS" : ""}`);
process.exit(fail > 0 ? 1 : 0);
