/** Quick probe: what does pdf-lib emit for font tags in the content
 *  stream + resources, so the smoke's bold-font oracle can be written
 *  against the REAL structure. */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { inflateSync } from "node:zlib";

const doc = await PDFDocument.create();
const page = doc.addPage([595.28, 841.89]);
const helv = doc.embedStandardFont(StandardFonts.Helvetica);
const helvBold = doc.embedStandardFont(StandardFonts.HelveticaBold);
const helvOblique = doc.embedStandardFont(StandardFonts.HelveticaOblique);

page.drawText("plain text here", { x: 60, y: 700, size: 11, font: helv });
page.drawText("bold run", { x: 60, y: 650, size: 11, font: helvBold });
page.drawText("italic run", { x: 60, y: 600, size: 11, font: helvOblique });

const bytes = await doc.save({ useObjectStreams: true });
const raw = Buffer.from(bytes).toString("latin1");

// inflate every stream
let all = "";
let idx = 0;
for (;;) {
  const at = raw.indexOf("stream", idx);
  if (at < 0) break;
  const start = raw.indexOf("\n", at) + 1;
  const end = raw.indexOf("endstream", start);
  if (end < 0) break;
  try {
    all += Buffer.from(inflateSync(new Uint8Array(Buffer.from(raw.slice(start, end), "latin1")))).toString("latin1");
  } catch {
    /* not zlib */
  }
  idx = end + "endstream".length;
}
console.log("=== INFLATED STREAMS ===");
console.log(all);
