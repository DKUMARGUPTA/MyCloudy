/**
 * R15 E2E fixture: 4-page A4 PDF for crop verification. Each page has a
 * BIG label near the top, a corner-anchored quadrant marker and a centre
 * dot — after cropping, the strip thumbnail / exported PDF must show
 * exactly the framed region (VLM can check which markers survive).
 * Written to public/qa/r15-crop-doc.pdf for the agent-browser E2E.
 */
import { writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const pages = [
  "R15 PAGE ONE",
  "R15 PAGE TWO",
  "R15 PAGE THREE",
  "R15 PAGE FOUR",
];
const W = 595.28;
const H = 841.89;
pages.forEach((label, i) => {
  const page = doc.addPage([W, H]);
  page.drawText(label, {
    x: 90,
    y: 700,
    size: 44,
    font,
    color: rgb(0.1, 0.1, 0.1),
  });
  // Quadrant markers: which survive a crop is visually unambiguous.
  page.drawText("TOP-LEFT", { x: 40, y: 780, size: 16, font, color: rgb(0.7, 0.1, 0.1) });
  page.drawText("TOP-RIGHT", { x: 400, y: 780, size: 16, font, color: rgb(0.1, 0.5, 0.1) });
  page.drawText("BOTTOM-LEFT", { x: 40, y: 60, size: 16, font, color: rgb(0.1, 0.1, 0.7) });
  page.drawText("BOTTOM-RIGHT", { x: 400, y: 60, size: 16, font, color: rgb(0.8, 0.5, 0) });
  // Centre dot — stays inside most crop frames.
  page.drawCircle({
    x: W / 2,
    y: H / 2,
    size: 14,
    color: rgb(0.85, 0.1, 0.3),
  });
  page.drawText(`centre ${i + 1}`, {
    x: W / 2 - 40,
    y: H / 2 - 60,
    size: 18,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });
});
const bytes = await doc.save();
writeFileSync("public/qa/r15-crop-doc.pdf", bytes);
console.log("wrote public/qa/r15-crop-doc.pdf", bytes.length, "bytes");
