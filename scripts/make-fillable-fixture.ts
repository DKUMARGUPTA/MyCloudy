/** Build a form-like QA fixture: labels + underlines + checkbox square. */
import { PDFDocument, rgb } from "pdf-lib";
import { writeFileSync } from "fs";

async function main() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont("Helvetica");
  const page = doc.addPage([612, 792]);

  page.drawText("Application Form", { x: 200, y: 740, size: 18, font });

  const rows = [
    { label: "Full Name:", y: 680 },
    { label: "Email:", y: 640 },
    { label: "Phone:", y: 600 },
    { label: "Address:", y: 560 },
  ];
  for (const r of rows) {
    page.drawText(r.label, { x: 40, y: r.y, size: 12, font });
    page.drawLine({
      start: { x: 140, y: r.y - 3 },
      end: { x: 420, y: r.y - 3 },
      thickness: 1,
      color: rgb(0.2, 0.2, 0.2),
    });
  }

  page.drawText("I agree to the terms and conditions", { x: 60, y: 500, size: 10, font });
  page.drawRectangle({
    x: 40,
    y: 496,
    width: 12,
    height: 12,
    borderColor: rgb(0.2, 0.2, 0.2),
    borderWidth: 1,
  });

  const bytes = await doc.save();
  writeFileSync("public/qa/mf-fixture.pdf", bytes);
  console.log("wrote public/qa/mf-fixture.pdf", bytes.length, "bytes");
}
void main();
