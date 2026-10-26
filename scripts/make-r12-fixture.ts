/**
 * R12 E2E fixture: 4-page PDF, one distinct Hindi+English line per page
 * (identifiable in the editor by text + by page order), A4 portrait.
 * Written to public/qa/r12-pages-doc.pdf for the agent-browser E2E.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const pages = [
  "R12 PAGE ONE - Alpha",
  "R12 PAGE TWO - Beta",
  "R12 PAGE THREE - Gamma",
  "R12 PAGE FOUR - Delta",
];
for (const label of pages) {
  const page = doc.addPage([595.28, 841.89]);
  page.drawText(label, {
    x: 60,
    y: 760,
    size: 20,
    font,
    color: rgb(0.1, 0.1, 0.1),
  });
}
const bytes = await doc.save();
import { writeFileSync } from "node:fs";
writeFileSync("public/qa/r12-pages-doc.pdf", bytes);
console.log("wrote public/qa/r12-pages-doc.pdf", bytes.length, "bytes");
