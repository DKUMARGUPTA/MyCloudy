/** TEMPORARY probe: what does pdf.js actually return for the fixture? */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { extractGrid, gridItemsFromRaw } from "../tools/pdf-to-excel/model";

const notoBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);

async function main() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const noto = await doc.embedFont(notoBytes, { subset: true });

  const p1 = doc.addPage([595.28, 841.89]);
  const XS = [60, 200, 340, 460];
  ["Item", "Qty", "Price", "Note"].forEach((h, i) =>
    p1.drawText(h, { x: XS[i], y: 780, size: 12, font: bold })
  );
  const rows = [
    ["Apples", "12", "80.5", `Snack & "granny" <smith>`],
    ["Bananas", "7", "30.25", "ripe"],
    ["Cherries", "120", "5", ""],
    ["Dates", "0", "0", "dry"],
    ["प्रिया", "42", "9.5", "hindi name"],
    ["Figs", "3", "60", "jam"],
    ["Grapes", "55", "12.75", "vine"],
    ["Hazelnuts", "9", "150", ""],
  ];
  rows.forEach((r, ri) => {
    const y = 748 - ri * 24;
    r.forEach((cell, ci) => {
      if (!cell) return;
      p1.drawText(cell, {
        x: XS[ci],
        y,
        size: 11,
        font: ci === 0 && ri === 4 ? noto : helv,
      });
    });
  });
  p1.drawText("Note", { x: 60, y: 520, size: 11, font: helv });
  p1.drawText("Quarterly totals are audited", {
    x: 200,
    y: 520,
    size: 11,
    font: helv,
  });
  p1.drawText("by an external accountant", {
    x: 200,
    y: 506,
    size: 11,
    font: helv,
  });

  const p2 = doc.addPage([595.28, 841.89]);
  p2.drawText("Item", { x: 60, y: 780, size: 12, font: bold });
  p2.drawText("Amount", { x: 170, y: 780, size: 12, font: bold });
  const rightEdge = 260;
  const amounts = ["7", "999999", "42", "137"];
  ["A", "B", "C", "D"].forEach((c, i) => {
    p2.drawText(c, { x: 60, y: 748 - i * 24, size: 11, font: helv });
    const a = amounts[i];
    const w = helv.widthOfTextAtSize(a, 11);
    p2.drawText(a, { x: rightEdge - w, y: 748 - i * 24, size: 11, font: helv });
  });

  const bytes = await doc.save();

  const pdf = await getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    verbosity: 0,
    standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  }).promise;
  for (let p = 1; p <= 2; p += 1) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    page.cleanup();
    console.log(`--- page ${p} items ---`);
    for (const item of content.items as { str?: string }[]) {
      console.log(JSON.stringify(item));
    }
    const grid = extractGrid(gridItemsFromRaw(content.items as unknown[]));
    console.log(`--- page ${p} grid (${grid.length} rows) ---`);
    for (const row of grid) console.log(JSON.stringify(row));
  }
  await pdf.destroy();
}

void main();
