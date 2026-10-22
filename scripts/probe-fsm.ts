/**
 * Probe: why does buildFontStyleMap return an empty map on the odt smoke
 * fixture? Dumps the decoded content stream Tf ops + pdf.js ids per page.
 */
import "regenerator-runtime/runtime";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  PDFName,
  PDFRawStream,
  PDFArray,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from "pdf-lib";

const doc = await PDFDocument.create();
doc.setTitle("Falcon Quarterly Report");
const helv = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const ital = await doc.embedFont(StandardFonts.HelveticaOblique);
const page1 = doc.addPage([612, 792]);
page1.drawText("Quarterly Report", { x: 72, y: 720, size: 22, font: bold });
page1.drawText("Regional performance detail", { x: 72, y: 662, size: 14, font: helv });
page1.drawText("Plain start, then", { x: 72, y: 518, size: 11, font: helv });
page1.drawText("bold words,", { x: 178, y: 518, size: 11, font: bold });
page1.drawText("italic tail ends here.", { x: 283, y: 518, size: 11, font: ital });
const bytes = new Uint8Array(await doc.save());

// --- dump content stream + resources with plain pdf-lib ---
const pdf = await PDFDocument.load(bytes);
const node = pdf.getPage(0).node;
const contents = node.get(PDFName.of("Contents"));
console.log("Contents type:", contents?.constructor.name);
const resolved = contents instanceof PDFRef ? pdf.context.lookup(contents) : contents;
console.log("Resolved type:", resolved?.constructor.name);
const chunks: Uint8Array[] = [];
const push = (v: unknown) => {
  if (v instanceof PDFRawStream) chunks.push(decodePDFRawStream(v).decode());
};
if (resolved instanceof PDFRawStream) push(resolved);
else if (resolved instanceof PDFArray) {
  for (let i = 0; i < resolved.size(); i += 1) {
    push(pdf.context.lookupMaybe(resolved.get(i) as PDFRef, PDFStream));
  }
}
console.log("chunks:", chunks.length);
if (chunks.length > 0) {
  const text = new TextDecoder("latin1").decode(
    chunks.reduce((acc, c) => {
      const out = new Uint8Array(acc.length + c.length);
      out.set(acc); out.set(c, acc.length); return out;
    }, new Uint8Array(0))
  );
  console.log("STREAM (first 900):", JSON.stringify(text.slice(0, 900)));
  const re = /\/([A-Za-z0-9#+.\-]+)\s+[-\d.]+\s+Tf/g;
  let m; const keys: string[] = [];
  while ((m = re.exec(text)) !== null) if (!keys.includes(m[1]!)) keys.push(m[1]!);
  console.log("Tf keys in order:", keys);
}
const res = node.lookupMaybe(PDFName.of("Resources"), (await import("pdf-lib")).PDFDict);
if (res) {
  const fonts = res.lookupMaybe(PDFName.of("Font"), (await import("pdf-lib")).PDFDict);
  if (fonts) {
    for (const [k, v] of fonts.entries()) {
      console.log("Resource", k.toString(), "->", String(v));
      const d = v instanceof PDFRef ? pdf.context.lookupMaybe(v, (await import("pdf-lib")).PDFDict) : undefined;
      if (d) {
        const bf = d.get(PDFName.of("BaseFont"));
        console.log("   BaseFont:", bf ? String(bf) : "(none)", "keys:", d.entries().map(([kk]) => kk.toString()).join(","));
      }
    }
  }
}

// --- pdf.js ids ---
const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
const p = await task.promise;
const content = await (await p.getPage(1)).getTextContent();
const ids: string[] = [];
for (const item of content.items as { fontName?: string }[]) {
  const fn = item?.fontName;
  if (typeof fn === "string" && fn.length > 0 && !ids.includes(fn)) ids.push(fn);
}
console.log("pdf.js ids in order:", ids);
await task.destroy();
process.exit(0);
