/**
 * Probe: what does pdf.js extract for Devanagari words with reph (र्),
 * conjuncts, and mixed matras, drawn via pdf-lib + Noto Sans Devanagari?
 * Observations here drive the visual→logical repair design.
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const WORDS = [
  "रिपोर्ट",      // reph at end: र्ट
  "शर्मा",        // reph mid: शर्मा
  "कार्य",        // reph before य
  "वर्ष",         // reph before ष
  "सूर्य",        // reph before य, long ū
  "प्रिया शर्मा की टीम",  // the exact failing smoke line
  "त्रैमासिक रिपोर्ट",    // exact failing line 2 (tra + ai-matra + reph)
  "निर्माण",      // mid-cluster र् (NOT reph) — must not be damaged
  "प्रकार",       // pra conjunct, no reph
  "धार्मिक",      // reph + i-matra
  "अनार्यों",      // reph + यों
  "संस्करण",      // anusvara (not matra)
  "हिंदी",         // anusvara-style हिंदी (the candra bindu case)
  "कार्यक्रम",     // two reph syllables
];

const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
const noto = await doc.embedFont(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf"),
  { subset: true }
);
const page = doc.addPage([612, 792]);
WORDS.forEach((w, i) => {
  page.drawText(w, { x: 40, y: 760 - i * 26, size: 14, font: noto, color: rgb(0, 0, 0) });
});
const bytes = new Uint8Array(await doc.save());

const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
const pdf = await task.promise;
const pg = await pdf.getPage(1);
const content = await pg.getTextContent();
const items = content.items as { str?: string; transform?: number[] }[];
const lines = new Map<number, string[]>();
for (const it of items) {
  const y = it.transform ? Math.round(it.transform[5]) : 0;
  if (!lines.has(y)) lines.set(y, []);
  lines.get(y)!.push(it.str ?? "");
}
const rows = [...lines.entries()].sort((a, b) => b[0] - a[0]);
WORDS.forEach((w, i) => {
  const got = (rows[i]?.[1] ?? []).join("");
  const ok = got === w;
  console.log(
    (ok ? "OK  " : "BAD ") +
    JSON.stringify(w) + "  ->  " + JSON.stringify(got)
  );
});
await task.destroy();
process.exit(0);
