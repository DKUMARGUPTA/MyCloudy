/** probe: why is buildFontStyleMap empty on the pdf-lib fixture? */
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
const helv = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const ital = await doc.embedFont(StandardFonts.HelveticaOblique);
const noto = await doc.embedFont(notoBytes, { subset: true });
const p1 = doc.addPage([612, 792]);
p1.drawText("Quarterly Report", { x: 72, y: 720, size: 22, font: bold });
p1.drawText("This report covers", { x: 72, y: 628, size: 11, font: helv });
p1.drawText("bold words,", { x: 178, y: 518, size: 11, font: bold });
p1.drawText("italic tail", { x: 283, y: 518, size: 11, font: ital });
p1.drawText("नमस्ते दुनिया", { x: 72, y: 480, size: 11, font: noto });
const bytes = new Uint8Array(await doc.save());

const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
const pdf = await task.promise;
const page = await pdf.getPage(1);
const content = await page.getTextContent();
const items = content.items as { str?: unknown; fontName?: unknown }[];
console.log("items:", JSON.stringify(items.map((i) => [i.str, i.fontName]), null, 0).slice(0, 600));
await task.destroy();

// Now the pdf-lib side walk (mirror of the worker's helpers).
const pdf2 = await PDFDocument.load(bytes, {
  ignoreEncryption: true,
  updateMetadata: false,
  throwOnInvalidObject: false,
});
const node = pdf2.getPage(0).node;
const res = node.lookupMaybe(PDFName.of("Resources"), PDFDict);
const fonts = res?.lookupMaybe(PDFName.of("Font"), PDFDict);
console.log("font keys:", fonts ? [...fonts.keys()].map((k) => (k as PDFName).asString()) : "none");
for (const key of (fonts ? [...fonts.keys()] : [])) {
  const v = fonts?.get(key);
  const dict =
    v instanceof PDFRef
      ? pdf2.context.lookupMaybe(v, PDFDict)
      : v instanceof PDFDict
        ? v
        : undefined;
  console.log("font", (key as PDFName).asString(), "BaseFont:", dict?.get(PDFName.of("BaseFont"))?.toString());
}
// Content stream Tf scan.
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
const latin1 = new TextDecoder("latin1").decode(
  chunks.reduce((acc, c) => {
    const out = new Uint8Array(acc.length + c.length);
    out.set(acc);
    out.set(c, acc.length);
    return out;
  }, new Uint8Array(0))
);
const tfMatches = [...latin1.matchAll(/\/([A-Za-z0-9#+.\-]+)\s+[-\d.]+\s+Tf/g)].map((m) => m[1]);
console.log("Tf order:", tfMatches);
process.exit(0);
