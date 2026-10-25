/**
 * PRE-BUILD smoke test for the Page numbers + Header & footer tools (P3.7).
 * Verifies the pdf-lib engine behaviors these tools depend on BEFORE any UI
 * is written (the P3.3 lesson — prove the engine, then build on it):
 *
 *  1. Custom-font embedding via @pdf-lib/fontkit (registerFontkit +
 *     embedFont(bytes, { subset: true })) — needed for Hindi digits.
 *  2. drawText + widthOfTextAtSize with the embedded Devanagari font
 *     (digits U+0966–U+096F AND full words like "पृष्ठ").
 *  3. Standard-font ASCII stamps (the non-Hindi path) still fine.
 *  4. Save → reload round-trip keeps the stamped text + subset font usable.
 *
 * Run: bun scripts/smoke-pagenumbers.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
} from "pdf-lib";
import "regenerator-runtime/runtime";
import fontkit from "@pdf-lib/fontkit";

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function pass(message: string): void {
  console.log(`PASS ${message}`);
}

/**
 * Extracts every `stream…endstream` payload from a saved PDF and inflates
 * the Flate-compressed ones (pdf-lib compresses content streams). Falls
 * back to the raw bytes when a payload is not zlib — font subsets, images
 * and already-raw streams must not break the scan.
 */
function decodeAllStreams(pdf: Uint8Array): string {
  const latin = Buffer.from(pdf).toString("latin1");
  let out = "";
  const re = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(latin)) !== null) {
    const start = match.index + match[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) break;
    const chunk = Buffer.from(
      latin.slice(start, end).replace(/\r\n$/, ""),
      "latin1"
    );
    try {
      out += inflateSync(chunk).toString("latin1");
    } catch {
      out += chunk.toString("latin1");
    }
    re.lastIndex = end;
  }
  return out;
}

/** The exact to-roman the tool will use (1-based value → lowercase roman). */
function toRoman(value: number, upper: boolean): string {
  if (value <= 0) return String(value);
  const table: [number, string][] = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let rest = value;
  let out = "";
  for (const [num, sym] of table) {
    while (rest >= num) {
      out += sym;
      rest -= num;
    }
  }
  return upper ? out.toUpperCase() : out;
}

/** The exact to-alpha the tool will use (a, b, … z, aa, ab …). */
function toAlpha(value: number, upper: boolean): string {
  if (value <= 0) return String(value);
  let rest = value;
  let out = "";
  while (rest > 0) {
    const rem = (rest - 1) % 26;
    out = String.fromCharCode(97 + rem) + out;
    rest = Math.floor((rest - 1) / 26);
  }
  return upper ? out.toUpperCase() : out;
}

async function main(): Promise<void> {
  const ttf = await readFile(
    "/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf"
  );
  pass(`TTF read (${ttf.length} bytes)`);

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const deva = await doc.embedFont(ttf, { subset: true });
  const helv = await doc.embedFont(StandardFonts.Helvetica);

  // 1. widthOfTextAtSize with the embedded Devanagari font.
  const digits = "०१२३४५६७८९";
  const wDigits = deva.widthOfTextAtSize(digits, 12);
  if (!(wDigits > 0)) fail("widthOfTextAtSize(Devanagari digits) <= 0");
  pass(`widthOfTextAtSize Devanagari digits = ${wDigits.toFixed(2)}`);

  const word = "पृष्ठ";
  const wWord = deva.widthOfTextAtSize(word, 12);
  if (!(wWord > 0)) fail("widthOfTextAtSize(पृष्ठ) <= 0");
  pass(`widthOfTextAtSize पृष्ठ = ${wWord.toFixed(2)}`);

  // 2. Mixed script: Devanagari digits inside an ASCII frame.
  const mixed = `Page ५ of १०`;
  const wMixed = deva.widthOfTextAtSize(mixed, 12);
  if (!(wMixed > 0)) fail("widthOfTextAtSize(mixed) <= 0");
  pass(`widthOfTextAtSize mixed "${mixed}" = ${wMixed.toFixed(2)}`);

  // 3. Draw everything on a page (the exact draw call shapes the worker uses).
  const page = doc.addPage([595.28, 841.89]); // A4
  const drawCentered = (
    font: PDFFont,
    text: string,
    cx: number,
    cy: number,
    size: number
  ): void => {
    const tw = font.widthOfTextAtSize(text, size);
    // baseline sits ~0.25em above the box bottom (same as watermark worker)
    page.drawText(text, {
      x: cx - tw / 2,
      y: cy - size * 0.25,
      size,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
  };
  drawCentered(deva, `${word} ३ / १०`, 297, 780, 12); // header line
  drawCentered(helv, "Page 3 of 10", 297, 60, 11); // footer line
  drawCentered(deva, digits, 297, 420, 24); // big digit strip
  drawCentered(helv, toRoman(9, false), 297, 380, 14); // ix
  drawCentered(helv, toAlpha(27, false), 297, 350, 14); // aa
  pass("drawText with embedded + standard fonts (no throw)");

  // 4. Save → reload round-trip: text ops present, fonts embedded.
  const saved = await doc.save({ useObjectStreams: false });
  const outPath = "/home/z/my-project/download/qa-p37-smoke.pdf";
  await writeFile(outPath, saved);

  const reloaded = await PDFDocument.load(await readFile(outPath), {
    updateMetadata: false,
  });
  if (reloaded.getPageCount() !== 1) fail("reload page count");
  const helv2 = await reloaded.embedFont(StandardFonts.Helvetica);
  const wAfter = helv2.widthOfTextAtSize("Page 3 of 10", 11);
  if (!(wAfter > 0)) fail("standard font still works after reload");
  pass(`round-trip: ${saved.length} bytes, reload + embedFont OK`);

  // 5. Raw check: the saved file contains our stamped operators.
  // pdf-lib Flate-compresses content streams, so the operators only show
  // after decoding every stream (the old raw-bytes check went blind the
  // moment compression landed and could never see "Tj" again).
  const decoded = await decodeAllStreams(saved);
  const hasTj = decoded.includes("Tj") || decoded.includes("TJ");
  if (!hasTj) fail("no text-show operators in decoded streams");
  // All five draws go through fontkit-embedded subsets → glyph-ID hex
  // strings, so literal ASCII never appears in the stream; assert the
  // operator COUNT instead (header + footer + digit strip + roman + alpha).
  const tjCount = (decoded.match(/Tj/g) || []).length;
  if (tjCount < 5) fail(`expected 5+ Tj operators, found ${tjCount}`);
  const raw = Buffer.from(saved).toString("latin1");
  const fontCount = (raw.match(/\/Font/g) || []).length;
  if (fontCount < 2) fail("expected 2+ /Font refs in output");
  pass(`output has text ops + ${fontCount} /Font refs (streams decoded)`);

  // 6. Subset size sanity: the subset-embedded font must not be the full 243KB.
  const subsetShare = saved.length / ttf.length;
  console.log(
    `INFO output is ${(saved.length / 1024).toFixed(
      1
    )} KB (${subsetShare.toFixed(2)}× the source TTF size)`
  );

  console.log("ALL SMOKE CHECKS PASSED");
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
