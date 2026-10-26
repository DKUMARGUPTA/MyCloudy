/**
 * R13 E2E fixture: 4-page A4 PDF, one BIG orientation-obvious line per page
 * (VLM can verify upright vs sideways after a 90° page turn), plus a
 * smaller second line to check F&R/piece work on rotated pages later.
 * Written to public/qa/r13-rotate-doc.pdf for the agent-browser E2E.
 */
import { writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const pages = [
  "R13 PAGE ONE",
  "R13 PAGE TWO",
  "R13 PAGE THREE",
  "R13 PAGE FOUR",
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
  page.drawText(`Second line ${i + 1} for pieces`, {
    x: 90,
    y: 560,
    size: 18,
    font,
    color: rgb(0.25, 0.25, 0.25),
  });
});
const bytes = await doc.save();
writeFileSync("public/qa/r13-rotate-doc.pdf", bytes);
console.log("wrote public/qa/r13-rotate-doc.pdf", bytes.length, "bytes");
