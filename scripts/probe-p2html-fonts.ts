/** TEMP probe 2: replicate pdf-to-word's fixture page 1 exactly. */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  StandardFonts,
} from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
const notoBytes = readFileSync(
  new URL("../public/fonts/NotoSansDevanagari-Regular.ttf", import.meta.url)
);
const noto = await doc.embedFont(notoBytes, { subset: true });
const helv = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

const page1 = doc.addPage([612, 792]);
page1.drawText("Quarterly Report", { x: 72, y: 720, size: 22, font: bold });
page1.drawText("This report covers the first quarter of the year.", {
  x: 72,
  y: 680,
  size: 11,
  font: helv,
});
page1.drawText("Numbers improved across every region listed.", {
  x: 72,
  y: 666,
  size: 11,
  font: helv,
});
const x2 = 72 + helv.widthOfTextAtSize("Some parts are ", 11);
const x3 = x2 + bold.widthOfTextAtSize("very important", 11);
page1.drawText("Some parts are ", { x: 72, y: 620, size: 11, font: helv });
page1.drawText("very important", { x: x2, y: 620, size: 11, font: bold });
page1.drawText(" for the team.", { x: x3, y: 620, size: 11, font: helv });
page1.drawText("Notes: revenue & costs, Q1 < Q2 > targets.", {
  x: 72,
  y: 580,
  size: 11,
  font: helv,
});
page1.drawText('She said "ok" and don\'t worry.', {
  x: 72,
  y: 540,
  size: 11,
  font: helv,
});
page1.drawText("प्रिया शर्मा", { x: 72, y: 490, size: 14, font: noto });

const bytes = new Uint8Array(await doc.save());

const pdfLib = await PDFDocument.load(bytes, { ignoreEncryption: true });
{
  const node = pdfLib.getPage(0).node;
  const res = node.lookupMaybe(PDFName.of("Resources"), PDFDict);
  const fonts = res?.lookupMaybe(PDFName.of("Font"), PDFDict);
  const entries: string[] = [];
  if (fonts) {
    for (const [key, value] of fonts.entries()) {
      const dict =
        value instanceof PDFRef
          ? pdfLib.context.lookupMaybe(value, PDFDict)
          : value instanceof PDFDict
            ? value
            : undefined;
      const base = dict?.get(PDFName.of("BaseFont"));
      entries.push(`${key.asString()} → ${base?.toString() ?? "?"}`);
    }
  }
  console.log("P2W PAGE 1 resources:", entries.join(", "));
  const contents = node.get(PDFName.of("Contents"));
  const resolved =
    contents instanceof PDFRef ? pdfLib.context.lookup(contents) : contents;
  const chunks: Uint8Array[] = [];
  const push = (v: unknown): void => {
    if (v instanceof PDFRawStream) chunks.push(decodePDFRawStream(v).decode());
  };
  if (resolved instanceof PDFRawStream) push(resolved);
  else if (resolved instanceof PDFArray) {
    for (let j = 0; j < resolved.size(); j += 1) {
      push(pdfLib.context.lookupMaybe(resolved.get(j) as PDFRef, PDFStream));
    }
  }
  const text = new TextDecoder("latin1").decode(
    chunks.reduce<Uint8Array>((acc, c) => {
      const out = new Uint8Array(acc.length + c.length);
      out.set(acc);
      out.set(c, acc.length);
      return out;
    }, new Uint8Array(0))
  );
  const tfs = [...text.matchAll(/\/([A-Za-z0-9#+.\-]+)\s+[-\d.]+\s+Tf/g)].map(
    (m) => m[1]
  );
  console.log(
    "P2W PAGE 1 Tf sequence:",
    tfs.join(" "),
    `(${tfs.length} ops, ${new Set(tfs).size} distinct)`
  );
}

const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
const pdf = await task.promise;
{
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const ids: string[] = [];
  for (const it of content.items as { str: string; fontName: string }[]) {
    if (!ids.includes(it.fontName)) ids.push(it.fontName);
  }
  console.log(
    "P2W PAGE 1 distinct pdf.js ids:",
    ids.join(" "),
    `(${ids.length})`
  );
  console.log(
    "P2W PAGE 1 items:",
    (content.items as { str: string; fontName: string }[])
      .map((it) => `[${it.fontName}]${JSON.stringify(it.str)}`)
      .join(" ")
  );
  page.cleanup();
}
await task.destroy();
