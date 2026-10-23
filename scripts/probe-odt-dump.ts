/** Probe: dump the generated ODT content.xml heading/span segments. */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  buildOdt,
  extractOdtBlocks,
  type PdfTextItemInput,
} from "../tools/pdf-to-odt/model";

const workerGlobal = globalThis as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  location: { href: string };
};
workerGlobal.postMessage = (): void => undefined;
workerGlobal.location = { href: "http://localhost/" };
(globalThis as unknown as Record<string, unknown>).self = workerGlobal;
const { buildFontStyleMap } = await import("../tools/pdf-to-odt/worker");

const doc = await PDFDocument.create();
doc.setTitle("Falcon Quarterly Report");
const helv = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const ital = await doc.embedFont(StandardFonts.HelveticaOblique);
const p1 = doc.addPage([612, 792]);
p1.drawText("Quarterly Report", { x: 72, y: 720, size: 22, font: bold });
p1.drawText("Falcon Division Results", { x: 72, y: 692, size: 16, font: bold });
p1.drawText("Regional performance detail", { x: 72, y: 662, size: 14, font: helv });
p1.drawText("This report covers the first quarter.", { x: 72, y: 628, size: 11, font: helv });
p1.drawText("Numbers improved across every region.", { x: 72, y: 614, size: 11, font: helv });
p1.drawText("A later section with a clear gap.", { x: 72, y: 556, size: 11, font: helv });
p1.drawText("Plain start, then", { x: 72, y: 518, size: 11, font: helv });
p1.drawText("bold words,", { x: 178, y: 518, size: 11, font: bold });
p1.drawText("italic tail ends here.", { x: 283, y: 518, size: 11, font: ital });
const bytes = new Uint8Array(await doc.save());

const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
const pdf = await task.promise;
const pages: PdfTextItemInput[][] = [];
for (let n = 1; n <= pdf.numPages; n += 1) {
  const page = await pdf.getPage(n);
  const content = await page.getTextContent();
  pages.push(content.items as PdfTextItemInput[]);
  page.cleanup();
}
await task.destroy();

const styleMap = await buildFontStyleMap(bytes, pages);
console.log("styleMap:", JSON.stringify([...styleMap.entries()]));
const model = extractOdtBlocks(pages, { styleMap });
console.log("blocks:");
for (const [i, b] of model.blocks.entries()) {
  console.log(
    `  [${i}] L${b.headingLevel ?? 0} ` +
    b.runs.map((r) => `${r.bold ? "B" : ""}${r.italic ? "I" : ""}${JSON.stringify(r.text)}`).join(" ")
  );
}
const style = { bodyPt: model.bodyPt, headingPt: model.headingPt };
const odt = buildOdt(model.blocks, { ...style, title: "Falcon Quarterly Report" });

// unzip with node:zlib
const buf = Buffer.from(odt);
let off = 0;
const parts: Record<string, string> = {};
while (off + 4 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
  const method = buf.readUInt16LE(off + 8);
  const compSize = buf.readUInt32LE(off + 18);
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const name = buf.slice(off + 30, off + 30 + nameLen).toString("utf8");
  const dataStart = off + 30 + nameLen + extraLen;
  const raw = buf.slice(dataStart, dataStart + compSize);
  parts[name] = method === 0 ? raw.toString("utf8") : inflateRawSync(raw).toString("utf8");
  off = dataStart + compSize;
}
const content = parts["content.xml"] ?? "";
const bodyStart = content.indexOf("<office:body");
console.log("\n--- content.xml body (first 2600 chars) ---");
console.log(content.slice(bodyStart, bodyStart + 2600));
process.exit(0);
