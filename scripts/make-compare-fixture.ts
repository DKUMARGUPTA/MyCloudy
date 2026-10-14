/**
 * Builds the browser-QA fixture pair for compare-pdf:
 *   public/qa/qa-compare-a.pdf — 5-page "original"
 *   public/qa/qa-compare-b.pdf — 6-page "revised"
 *
 * Layout (A page i ↔ B page i unless noted):
 *   A p1 "Invoice"   ↔ B p1  — SAME page but words changed (1000→1200, a
 *                             Hindi word, one removed sentence) → "similar"
 *   A p2            ↔ B p2  — identical static page → "equal"
 *   (none)          ↔ B p3  — page ONLY in the revised → "added"
 *   A p3            ↔ B p4  — identical static (the smart-mapping shift)
 *   A p4            ↔ B p5  — identical static
 *   A p5            ↔ B p6  — identical static
 *
 * Under POSITION mapping, A p3 pairs with the new B p3 → visibly
 * "changed" everywhere after; under SMART mapping the inserted page
 * becomes an "added" pair and A3..A5 snap to B4..B6 — exactly what the
 * QA recipe switches between.
 *
 * Hindi text (embedded Noto subset) on page 1 exercises the report's
 * Devanagari font path. Run: bun scripts/make-compare-fixture.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import "regenerator-runtime/runtime";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const PW = 595.28;
const PH = 841.89;

async function build(pages: string[][], hindiPages: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const notoBytes = readFileSync(
    "public/fonts/NotoSansDevanagari-Regular.ttf"
  );
  doc.registerFontkit(fontkit);
  const noto = await doc.embedFont(new Uint8Array(notoBytes), {
    subset: true,
  });

  for (let i = 0; i < pages.length; i += 1) {
    const page = doc.addPage([PW, PH]);
    let y = PH - 70;
    for (const line of pages[i]) {
      if (line.startsWith("@hi ")) {
        const text = line.slice(4);
        page.drawText(text, {
          x: 46,
          y,
          size: 14,
          font: noto,
          color: rgb(0.1, 0.1, 0.12),
        });
        y -= 24;
      } else {
        page.drawText(line, {
          x: 46,
          y,
          size: 13,
          font: helv,
          color: rgb(0.1, 0.1, 0.12),
        });
        y -= 22;
      }
    }
    // A fixed footer, IDENTICAL across both files — page numbers would
    // make every "identical" page pair differ in its last line.
    page.drawText("compare QA fixture footer", {
      x: 46,
      y: 50,
      size: 10,
      font: helv,
      color: rgb(0.35, 0.35, 0.4),
    });
  }
  return doc.save();
}

const staticPage = (label: string): string[] => [
  `Static content page ${label}`,
  "This page is byte-for-byte identical in both fixtures.",
  "Shared Services Agreement — Annexure.",
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do",
  "eiusmod tempor incididunt ut labore et dolore magna aliqua.",
  "Ut enim ad minim veniam, quis nostrud exercitation ullamco.",
];

const pagesA: string[][] = [
  [
    "INVOICE ORIGINAL — ACME Supplies",
    "Invoice number: INV-2024-0107",
    "Date: 12 March 2024",
    "Total amount: 1000",
    "Payment due in 30 days.",
    "Late fees apply after the due date.",
    "@hi कुल राशि: 1000 रुपये",
    "@hi धन्यवाद",
  ],
  staticPage("two — terms"),
  staticPage("three — annexure"),
  staticPage("four — schedule A"),
  staticPage("five — signature"),
];

const pagesB: string[][] = [
  [
    "INVOICE ORIGINAL — ACME Supplies",
    "Invoice number: INV-2024-0107",
    "Date: 15 March 2024",
    "Total amount: 1200",
    "Payment due in 45 days.",
    "@hi कुल राशि: 1200 रुपये",
    "@hi धन्यवाद",
  ],
  staticPage("two — terms"),
  [
    "Schedule B — NEW page in the revised",
    "This page exists only in the revised file.",
    "Inserted to demonstrate the added-pair detection.",
    "It should pair with nothing under smart mapping.",
  ],
  staticPage("three — annexure"),
  staticPage("four — schedule A"),
  staticPage("five — signature"),
];

const bytesA = await build(pagesA, [0]);
const bytesB = await build(pagesB, [0]);
writeFileSync("public/qa/qa-compare-a.pdf", bytesA);
writeFileSync("public/qa/qa-compare-b.pdf", bytesB);
console.log(
  `public/qa/qa-compare-a.pdf — ${(bytesA.length / 1000).toFixed(0)} KB, 5 pages`,
);
console.log(
  `public/qa/qa-compare-b.pdf — ${(bytesB.length / 1000).toFixed(0)} KB, 6 pages`,
);
