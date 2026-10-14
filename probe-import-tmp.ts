import { readFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import "regenerator-runtime/runtime";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { joinPageText } from "./tools/compare-pdf/engine";

const doc = await PDFDocument.create();
const helv = await doc.embedFont(StandardFonts.Helvetica);
const notoBytes = readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf");
doc.registerFontkit(fontkit);
const noto = await doc.embedFont(notoBytes, { subset: false });
const page = doc.addPage([595, 842]);
page.drawText("कुल राशि: 1000 रुपये धन्यवाद", { x: 46, y: 700, size: 14, font: noto });
const saved = await doc.save();
console.log("saved KB:", Math.round(saved.length / 1000));

const rd = await getDocument({ data: new Uint8Array(saved), useSystemFonts: true }).promise;
const p = await rd.getPage(1);
const content = await p.getTextContent();
console.log("extracted:", JSON.stringify(joinPageText(content.items as never)));
await rd.destroy();
