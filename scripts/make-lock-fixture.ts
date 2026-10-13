// QA fixture: 2-page PDF with text + a filled form + title/author info
import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import * as fs from "node:fs";

async function main() {
  const doc = await PDFDocument.create();
  doc.setTitle("Salary Slip October");
  doc.setAuthor("HR Department");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const p1 = doc.addPage([595, 842]);
  p1.drawText("SALARY SLIP", { x: 50, y: 780, size: 20, font: bold });
  p1.drawText("Employee: Ramesh Kumar", { x: 50, y: 740, size: 12, font });
  p1.drawText("Net pay: Rs 45,000", { x: 50, y: 710, size: 12, font });

  const p2 = doc.addPage([595, 842]);
  p2.drawText("Confidential annexure", { x: 50, y: 780, size: 14, font: bold });

  const form = doc.getForm();
  const tf = form.createTextField("ack_name");
  tf.setText("Ramesh Kumar");
  tf.addToPage(p1, { x: 50, y: 660, width: 240, height: 22 });
  const cb = form.createCheckBox("confirmed");
  cb.check();
  cb.addToPage(p1, { x: 50, y: 620, width: 18, height: 18 });
  p1.drawRectangle({ x: 46, y: 616, width: 26, height: 26, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 1 });

  fs.writeFileSync("download/qa-lock-fixture.pdf", await doc.save());
  console.error("fixture written: download/qa-lock-fixture.pdf");
}
main();
