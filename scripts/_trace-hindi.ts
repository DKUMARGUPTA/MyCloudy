/** Scratch: verify the planned Hindi fixture words through the REAL rtf
 *  pipeline (runRtfToPdf + pdf.js) before editing the smoke. DELETE AFTER. */
import { readFile } from "node:fs/promises";

import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

import { runRtfToPdf } from "../tools/rtf-to-pdf/worker";
import type { LoadRtfFonts } from "../tools/rtf-to-pdf/worker";

const TTF_PATH = "/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf";
const ttfBytes = new Uint8Array(await readFile(TTF_PATH));

const loadFonts: LoadRtfFonts = async (doc, needNoto) => {
  if (needNoto) doc.registerFontkit(fontkit);
  const helv = doc.embedStandardFont(StandardFonts.Helvetica);
  const helvBold = doc.embedStandardFont(StandardFonts.HelveticaBold);
  const helvOblique = doc.embedStandardFont(StandardFonts.HelveticaOblique);
  const helvBoldOblique = doc.embedStandardFont(StandardFonts.HelveticaBoldOblique);
  const noto = needNoto ? await doc.embedFont(ttfBytes, { subset: true }) : null;
  const pick = (b: boolean, i: boolean) =>
    b ? (i ? helvBoldOblique : helvBold) : i ? helvOblique : helv;
  const fontFor = (
    spec: { bold: boolean; italic: boolean },
    script: string
  ) => (script === "noto" && noto ? noto : pick(spec.bold, spec.italic));
  return {
    helv,
    helvBold,
    helvOblique,
    helvBoldOblique,
    noto,
    fontFor: (spec, script) => fontFor(spec, script),
    measure: (text: string, spec: { bold: boolean; italic: boolean }, size: number, script: string) =>
      fontFor(spec, script).widthOfTextAtSize(text, size),
  };
};

// The planned fixture: नमस्ते (space-form) + पुस्तक (tight) + देवनागरी (tight)
const rtf = [
  String.raw`{\rtf1\ansi`,
  String.raw`\pard\plain\fs22 Unicode label line.\par`,
  String.raw`\u2344 ?\u2350 ?\u2360 ?\u2381 ?\u2340 ?\u2375 ? \u2346?\u2369?\u2360?\u2381?\u2340?\u2325? \u2342?\u2375?\u2357?\u2344?\u2366?\u2327?\u2368?\u2352?\par`,
  String.raw`{\fs22 A nested group stays.{\b inner bold} after the inner close.\par`,
  String.raw`}`,
].join("\n");

const result = await runRtfToPdf(new TextEncoder().encode(rtf), {}, loadFonts);
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const doc = await getDocument({ data: result.bytes.slice(), verbosity: 0 }).promise;
const page = await doc.getPage(1);
const content = await page.getTextContent();
console.log("=== items ===");
for (const raw of content.items) {
  const item = raw as { str?: string };
  console.log(`  ${JSON.stringify(item.str)}`);
  if (/[\u0900-\u097f]/.test(item.str ?? "")) {
    console.log(
      `    cps: ${Array.from(item.str ?? "")
        .map((c) => `U+${c.charCodeAt(0).toString(16)}`)
        .join(" ")}`
    );
  }
}
const mainText = (content.items as { str?: string }[])
  .map((i) => i.str ?? "")
  .join("\n");
const norm = (t: string): string => t.replace(/\s+/g, " ").trim();
console.log("\n=== verbatim checks ===");
console.log("  includes नमस्ते (raw):", mainText.includes("नमस्ते"));
console.log("  includes पुस्तक (norm):", norm(mainText).includes("पुस्तक"));
console.log("  includes देवनागरी (norm):", norm(mainText).includes("देवनागरी"));
console.log("  includes दुनिया (norm):", norm(mainText).includes("दुनिया"));
console.log("  nested line norm:", JSON.stringify(norm(mainText).match(/A nested[^.]*\./)?.[0]));
console.log(
  "  nested full:",
  JSON.stringify(norm(mainText).split("A nested group")[1]?.slice(0, 80))
);

function devanagariMultiset(text: string): string {
  return Array.from(text)
    .filter((ch) => {
      const cp = ch.charCodeAt(0);
      return cp >= 0x0900 && cp <= 0x097f;
    })
    .sort()
    .join("");
}
console.log(
  "  multiset equal:",
  devanagariMultiset(mainText) === devanagariMultiset(["नमस्ते", "पुस्तक", "देवनागरी"].join(""))
);
console.log(
  "  item starts Deva:",
  (content.items as { str?: string }[]).some((it) => {
    const cp = (it.str ?? "").charCodeAt(0);
    return cp >= 0x0900 && cp <= 0x097f;
  })
);
