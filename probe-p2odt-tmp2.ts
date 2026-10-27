/** probe 2: replicate the p2w fixture page-1 exactly, print Tf order. */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";

import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from "pdf-lib";

const notoBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);

const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
const noto = await doc.embedFont(notoBytes, { subset: true });
const helv = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

const page1 = doc.addPage([612, 792]);
page1.drawText("Quarterly Report", { x: 72, y: 720, size: 22, font: bold });
page1.drawText("This report covers the first quarter of the year.", { x: 72, y: 680, size: 11, font: helv });
page1.drawText("Numbers improved across every region listed.", { x: 72, y: 666, size: 11, font: helv });
const x2 = 72 + helv.widthOfTextAtSize("Some parts are ", 11);
const x3 = x2 + bold.widthOfTextAtSize("very important", 11);
page1.drawText("Some parts are ", { x: 72, y: 620, size: 11, font: helv });
page1.drawText("very important", { x: x2, y: 620, size: 11, font: bold });
page1.drawText(" for the team.", { x: x3, y: 620, size: 11, font: helv });
page1.drawText("Notes: revenue & costs, Q1 < Q2 > targets.", { x: 72, y: 580, size: 11, font: helv });
page1.drawText("प्रिया शर्मा", { x: 72, y: 490, size: 14, font: noto });

const bytes = new Uint8Array(await doc.save());

const pdf2 = await PDFDocument.load(bytes, {
  ignoreEncryption: true,
  updateMetadata: false,
  throwOnInvalidObject: false,
});
const node = pdf2.getPage(0).node;
const res = node.lookupMaybe(PDFName.of("Resources"), PDFDict);
const fonts = res?.lookupMaybe(PDFName.of("Font"), PDFDict);
console.log("font keys:", fonts ? [...fonts.keys()].map((k) => (k as PDFName).asString()) : "none");
const contents = node.get(PDFName.of("Contents"));
const resolved = contents instanceof PDFRef ? pdf2.context.lookup(contents) : contents;
const chunks: Uint8Array[] = [];
if (resolved instanceof PDFRawStream) chunks.push(decodePDFRawStream(resolved).decode());
else if (resolved instanceof PDFArray) {
  for (let i = 0; i < resolved.size(); i++) {
    const v = pdf2.context.lookupMaybe(resolved.get(i) as PDFRef, PDFStream);
    if (v instanceof PDFRawStream) chunks.push(decodePDFRawStream(v).decode());
  }
}
let acc = new Uint8Array(0);
for (const c of chunks) {
  const out = new Uint8Array(acc.length + c.length);
  out.set(acc);
  out.set(c, acc.length);
  acc = out;
}
const latin1 = new TextDecoder("latin1").decode(acc);
console.log("Tf order:", [...latin1.matchAll(/\/([A-Za-z0-9#+.\-]+)\s+[-\d.]+\s+Tf/g)].map((m) => m[1]));

const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
const pdf = await task.promise;
const page = await pdf.getPage(1);
const content = await page.getTextContent();
const items = content.items as { str?: unknown; fontName?: unknown }[];
const ids: string[] = [];
for (const it of items) {
  const fn = String(it.fontName ?? "");
  if (fn && !ids.includes(fn)) ids.push(fn);
}
console.log("distinct pdf.js ids (item order):", ids);
await task.destroy();
process.exit(0);
