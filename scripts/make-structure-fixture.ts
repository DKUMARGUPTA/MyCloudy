/**
 * Makes qa/qa-structure-fixture.pdf — 2 pages with clear heading
 * hierarchy, bullets and numbered lists for the pdf-to-html/markdown E2E.
 * Run: bun scripts/make-structure-fixture.ts
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync } from "node:fs";

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

function page1() {
  const page = doc.addPage([595, 842]);
  let y = 780;
  const text = (
    f: typeof font,
    size: number,
    x: number,
    s: string
  ) => {
    page.drawText(s, { x, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
    y -= size * 1.5;
  };
  text(bold, 24, 60, "Quarterly Field Report");
  y -= 6;
  text(font, 10, 60, "Prepared by the district monitoring team for internal review purposes.");
  y -= 10;
  text(bold, 16, 60, "1. Summary of Activities");
  text(font, 10, 60, "The team completed twenty-three site visits across four blocks during the");
  text(font, 10, 60, "quarter. Attendance remained above the target threshold at every site.");
  y -= 6;
  text(bold, 13, 60, "1.1 Key Highlights");
  text(font, 10, 70, "- Twelve schools received new library stock");
  text(font, 10, 70, "- Four health sub-centres passed the hygiene audit");
  text(font, 10, 70, "- Two villages reported full immunisation coverage");
  y -= 6;
  text(bold, 16, 60, "2. Observations");
  text(font, 10, 60, "Field staff noted three recurring issues that require attention:");
  text(font, 10, 70, "1. Delayed supply of printed registers");
  text(font, 10, 70, "2. Irregular internet connectivity at two centres");
  text(font, 10, 70, "3. Vacant positions affecting weekend coverage");
  y -= 8;
  text(font, 10, 60, "Overall, the quarter closed within the approved budget and all statutory");
  text(font, 10, 60, "filings were submitted before the fifteenth of the closing month.");
}

function page2() {
  const page = doc.addPage([595, 842]);
  let y = 780;
  const text = (
    f: typeof font,
    size: number,
    x: number,
    s: string
  ) => {
    page.drawText(s, { x, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
    y -= size * 1.5;
  };
  text(bold, 16, 60, "3. Next Quarter Plan");
  text(font, 10, 60, "The following priorities were agreed at the review meeting held on the");
  text(font, 10, 60, "last Friday of the quarter, pending secretariat approval:");
  text(font, 10, 70, "- Complete the pending two blocks of site visits");
  text(font, 10, 70, "- Publish the consolidated attendance dashboard");
  text(font, 10, 70, "- Conduct refresher training for new field assistants");
  y -= 8;
  text(bold, 13, 60, "3.1 Budget Notes");
  text(font, 10, 60, "Funds already sanctioned cover travel and printing costs. Any additional");
  text(font, 10, 60, "expenditure above the delegated limit will need committee clearance.");
}

page1();
page2();

const bytes = await doc.save();
writeFileSync("qa/qa-structure-fixture.pdf", bytes);
console.log(`qa-structure-fixture.pdf written (${bytes.length} bytes, 2 pages)`);
