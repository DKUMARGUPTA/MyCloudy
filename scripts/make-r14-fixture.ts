/**
 * R14 E2E fixture: 4-page A4 PDF for the assemble-pdf organize E2E —
 * one BIG orientation-obvious line per page (VLM verifies upright vs
 * sideways after ±90° turns) and page 3 shipping /Rotate 90 so the
 * browser flow proves the offset ADDS to (never flattens) a source
 * page's own rotation. Written to public/qa/r14-organize-doc.pdf.
 */
import { writeFileSync } from "node:fs";
import { degrees, PDFDocument, StandardFonts, rgb } from "pdf-lib";

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const pages = [
  "R14 PAGE ONE",
  "R14 PAGE TWO",
  "R14 PAGE THREE",
  "R14 PAGE FOUR",
];
pages.forEach((label, i) => {
  const page = doc.addPage([595.28, 841.89]);
  page.drawText(label, {
    x: 90,
    y: 640,
    size: 44,
    font,
    color: rgb(0.1, 0.1, 0.1),
  });
  page.drawText(`Second line ${i + 1} for VLM`, {
    x: 90,
    y: 560,
    size: 18,
    font,
    color: rgb(0.25, 0.25, 0.25),
  });
  // Page 3 ships rotated 90° — its thumbnail reads sideways BEFORE any
  // user turn; turning it +90° must land it at 180° (upside down), the
  // offset-adds proof for the E2E + smoke.
  if (i === 2) page.setRotation(degrees(90));
});
const bytes = await doc.save();
writeFileSync("public/qa/r14-organize-doc.pdf", bytes);
console.log("wrote public/qa/r14-organize-doc.pdf", bytes.length, "bytes");
