/**
 * Builds the browser-QA fixture for compress-pdf-to-size:
 * download/qa-cts-fixture.pdf — 2 pages, page 1 = text + a 1.6 MB noisy
 * JPEG photo (incompressible, like a real camera scan), page 2 = text
 * only. Original lands ~1.7 MB so every target ladder step kicks in.
 *
 * Run: bun scripts/make-cts-fixture.ts
 */
import { writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const W = 1800;
const H = 1200;

const canvasMod = await import("@napi-rs/canvas");
const noise = canvasMod.createCanvas(W, H);
const ctx = noise.getContext("2d");
const img = ctx.createImageData(W, H);
let seed = 1337;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
for (let i = 0; i < img.data.length; i += 4) {
  img.data[i] = Math.floor(rand() * 256);
  img.data[i + 1] = Math.floor(rand() * 256);
  img.data[i + 2] = Math.floor(rand() * 256);
  img.data[i + 3] = 255;
}
ctx.putImageData(img, 0, 0);
const noiseJpeg = noise.toBuffer("image/jpeg", 88);

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const photo = await doc.embedJpg(new Uint8Array(noiseJpeg));

const p1 = doc.addPage([595.28, 841.89]);
p1.drawText("CTS QA fixture — compress me", { x: 40, y: 790, size: 18, font, color: rgb(0.1, 0.1, 0.1) });
p1.drawText("This page carries a big noisy photo.", { x: 40, y: 760, size: 11, font });
p1.drawImage(photo, { x: 40, y: 300, width: 515, height: 343 });

const p2 = doc.addPage([595.28, 841.89]);
p2.drawText("Second page is text only — must stay selectable.", { x: 40, y: 780, size: 14, font });

const saved = await doc.save();
writeFileSync("download/qa-cts-fixture.pdf", saved);
console.log(`download/qa-cts-fixture.pdf — ${(saved.length / 1000).toFixed(0)} KB, 2 pages, 1 photo`);
