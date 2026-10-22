/** Probe v3: hex-needle oracle casing + URI visibility. */
import "regenerator-runtime/runtime";
import { inflateSync } from "node:zlib";
import { PDFDocument, StandardFonts, PDFName, PDFString } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const hex16 = (s: string): string =>
  [...s].map((c) => (c.charCodeAt(0).toString(16).padStart(4, "0"))).join("");

async function main() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]);
  p1.drawText("Quarterly Report", { x: 72, y: 720, size: 22, font: helv });
  const annots = doc.context.obj([
    doc.context.obj({
      Type: PDFName.of("Annot"),
      Subtype: PDFName.of("Link"),
      Rect: [10, 10, 60, 30],
      Border: [0, 0, 0],
      F: 4,
      A: doc.context.obj({
        Type: PDFName.of("Action"),
        S: PDFName.of("URI"),
        URI: PDFString.of("https://example.com/handbook"),
      }),
    }),
  ]);
  p1.node.set(PDFName.of("Annots"), annots);
  const bytes = new Uint8Array(await doc.save());

  const latin = Buffer.from(bytes).toString("latin1");
  let inflated = "";
  let off = 0;
  for (;;) {
    const s = latin.indexOf("stream", off);
    if (s < 0) break;
    const e = latin.indexOf("endstream", s);
    if (e < 0) break;
    let start = s + "stream".length;
    if (latin[start] === "\r") start += 1;
    if (latin[start] === "\n") start += 1;
    let end = e;
    while (end > start && (latin[end - 1] === "\n" || latin[end - 1] === "\r")) end -= 1;
    const raw = Buffer.from(latin.slice(start, end), "latin1");
    if (raw[0] === 0x78) {
      try {
        inflated += inflateSync(raw).toString("latin1");
      } catch {
        /* skip */
      }
    }
    off = e + 9;
  }
  const needle = hex16("Quarterly Report");
  console.log("needle hex:", needle);
  console.log("inflated contains lowercase hex:", inflated.includes(needle));
  console.log("inflated contains UPPERCASE hex:", inflated.includes(needle.toUpperCase()));
  console.log("raw contains URI literal:", latin.includes("https://example.com/handbook"));
  console.log("inflated contains URI:", inflated.includes("https://example.com/handbook"));
  // sample of inflated content
  const tj = inflated.indexOf("Tj");
  console.log("around first Tj:", JSON.stringify(inflated.slice(Math.max(0, tj - 60), tj + 5)));
}

main().catch((error) => {
  console.error("PROBE FAILED:", error);
  process.exit(1);
});
