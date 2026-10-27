/** Scratch for b4-d-2 (this agent): verify the CORRECTED e2e Devanagari
 * line through the real rtf pipeline — extraction order of दुनिया (pre-base
 * ि matra), item starts, nested-group items. DELETE AFTER USE. */
import { readFile } from "node:fs/promises";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { runRtfToPdf, type LoadRtfFonts } from "../tools/rtf-to-pdf/worker";

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
  const fontFor = (spec: { bold: boolean; italic: boolean }, script: string) =>
    script === "noto" && noto ? noto : pick(spec.bold, spec.italic);
  return {
    helv,
    helvBold,
    helvOblique,
    helvBoldOblique,
    noto,
    fontFor: (spec, script) => fontFor(spec, script),
    measure: (
      text: string,
      spec: { bold: boolean; italic: boolean },
      size: number,
      script: string
    ) => fontFor(spec, script).widthOfTextAtSize(text, size),
  };
};

// नमस्ते = 2344 2350 2360 2381 2340 2375 (space-form fallbacks)
// दुनिया = 2342 2369 2344 2367 2351 2366 (tight-form fallbacks)
// देवनागरी = 2342 2375 2357 2344 2366 2327 2352 2368 (tight-form chain)
const rtf = [
  String.raw`{\rtf1\ansi`,
  String.raw`\pard\plain\fs22 Unicode: \u2344 ?\u2350 ?\u2360 ?\u2381 ?\u2340 ?\u2375 ? \u2342?\u2369?\u2344?\u2367?\u2351?\u2366? \u2342?\u2375?\u2357?\u2344?\u2366?\u2327?\u2352?\u2368?\par`,
  String.raw`{\fs22 A nested group stays.{\b inner bold} after the inner close.\par`,
  String.raw`}`,
].join("\n");

const result = await runRtfToPdf(new TextEncoder().encode(rtf), {}, loadFonts);
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const task = getDocument({ data: result.bytes.slice(), verbosity: 0 });
const doc = await task.promise;
const page = await doc.getPage(1);
const content = await page.getTextContent();

console.log("=== items ===");
const items: string[] = [];
for (const raw of content.items) {
  const item = raw as { str?: string };
  if ((item.str ?? "").length === 0) continue;
  items.push(item.str ?? "");
  console.log(`  ${JSON.stringify(item.str)}`);
}
const mainText = items.join("\n");
const norm = (t: string): string => t.replace(/\s+/g, " ").trim();
console.log("\n=== checks ===");
console.log("  नमस्ते verbatim (raw):", mainText.includes("नमस्ते"));
console.log("  दुनिया verbatim (norm):", norm(mainText).includes("दुनिया"));
console.log("  देवनागरी verbatim (norm):", norm(mainText).includes("देवनागरी"));
console.log(
  "  nested full:",
  JSON.stringify(norm(mainText).split("A nested group")[1]?.slice(0, 80))
);
console.log(
  "  item starts Deva:",
  items.some((s) => {
    const cp = s.charCodeAt(0);
    return cp >= 0x0900 && cp <= 0x097f;
  })
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
  "  multiset [नमस्ते दुनिया देवनागरी]:",
  devanagariMultiset(mainText) ===
    devanagariMultiset(["नमस्ते", "दुनिया", "देवनागरी"].join(""))
);

await task.destroy?.();
await page.cleanup();
process.exit(0);
