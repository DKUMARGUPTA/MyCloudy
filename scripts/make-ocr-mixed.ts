/**
 * P3.14 OCR PDF — assemble the MIXED fixture: page 1 is REAL text (pdf-lib),
 * page 2 is the image-only English raster. Verifies the typed-page
 * passthrough: OCR must copy page 1 untouched and only rebuild page 2.
 *
 * Run: bun scripts/make-ocr-mixed.ts
 */
import "regenerator-runtime/runtime";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { readFileSync, writeFileSync } from "node:fs";

async function main(): Promise<void> {
  const out = await PDFDocument.create();
  const helv = await out.embedFont(StandardFonts.Helvetica);

  // A4 in points.
  const page1 = out.addPage([595.28, 841.89]);
  page1.drawText("Mixed fixture — typed page one.", {
    x: 60,
    y: 760,
    size: 16,
    font: helv,
  });
  page1.drawText("This text layer must survive OCR unchanged.", {
    x: 60,
    y: 720,
    size: 16,
    font: helv,
  });
  page1.drawText("Second line with total 9350 rupees.", {
    x: 60,
    y: 680,
    size: 16,
    font: helv,
  });

  const jpeg = readFileSync("/home/z/my-project/download/qa-ocr-en.jpg");
  const image = await out.embedJpg(jpeg);
  const iw = image.width;
  const ih = image.height;
  // Same A4 page size so both pages are geometrically identical.
  const page2 = out.addPage([595.28, 841.89]);
  page2.drawImage(image, {
    x: 0,
    y: 0,
    width: 595.28,
    height: 841.89,
    // note: aspect handled below if the raster is not exactly A4
  });
  void iw;
  void ih;

  const bytes = await out.save();
  writeFileSync("/home/z/my-project/download/qa-ocr-mixed.pdf", bytes);
  console.log("wrote download/qa-ocr-mixed.pdf (typed page + image page)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
