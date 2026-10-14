/**
 * P3.14 OCR PDF — feasibility smoke: invisible (Tr 3) text + Devanagari
 * ToUnicode round-trip through pdf-lib.
 *
 * Builds a one-page PDF that mimics the OCR output contract:
 *  - a full-page JPEG image (the visible content),
 *  - an INVISIBLE text layer: English words via Helvetica, Hindi words via
 *    the embedded Noto Sans Devanagari subset,
 * and asserts on the raw content stream + file bytes.
 *
 * Run: bun scripts/smoke-ocr-invisible.ts
 */
import "regenerator-runtime/runtime";
import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument,
  PDFNumber,
  StandardFonts,
  rgb,
} from "pdf-lib";
import PDFOperator from "pdf-lib/cjs/core/operators/PDFOperator";
import PDFOperatorNames from "pdf-lib/cjs/core/operators/PDFOperatorNames";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const pass: number[] = [];
const fail: number[] = [];
function check(ok: boolean, label: string): void {
  if (ok) {
    pass.push(1);
    console.log(`  ok   ${label}`);
  } else {
    fail.push(1);
    console.log(`  FAIL ${label}`);
  }
}

async function main(): Promise<void> {
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);

  // A 200x100 "raster" — a red/green gradient JPEG, just to have pixels.
  const canvas = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46];
  const jpeg = new Uint8Array([
    ...canvas,
    0x00, 0x01, 0xff, 0xd9,
  ]);
  let embedOk = false;
  try {
    await out.embedJpg(jpeg);
  } catch {
    // Not a real JPEG — fall back to drawing a rectangle instead; the point
    // of this smoke is the TEXT layer, not the image.
    embedOk = false;
  }
  void embedOk;

  const page = out.addPage([300, 200]);
  page.drawRectangle({ x: 0, y: 0, width: 300, height: 200, color: rgb(0.95, 0.95, 0.95) });

  const helv = await out.embedFont(StandardFonts.Helvetica);
  const devaBytes = readFileSync("/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf");
  const deva = await out.embedFont(devaBytes, { subset: true });

  // 1) Invisible render mode: push `3 Tr` (text state persists across the
  // BT/ET blocks that pdf-lib's drawText emits).
  // NOTE: the operator name must be the PLAIN string "Tr" — passing
  // PDFName.of("Tr") serializes as "/Tr", producing an invalid content
  // stream that silently breaks every text extractor.
  const tr3 = PDFOperator.of(PDFOperatorNames.SetTextRenderingMode, [
    PDFNumber.of(3),
  ]);
  page.pushOperators(tr3);

  const englishWords = ["Hello", "searchable", "PDF"];
  for (let i = 0; i < englishWords.length; i += 1) {
    page.drawText(englishWords[i], {
      x: 10,
      y: 150 - i * 20,
      size: 14,
      font: helv,
    });
  }
  const hindiWords = ["नमस्ते", "खोजने", "योग्य"];
  let hindiDrawn = 0;
  for (let i = 0; i < hindiWords.length; i += 1) {
    try {
      page.drawText(hindiWords[i], {
        x: 120,
        y: 150 - i * 20,
        size: 14,
        font: deva,
      });
      hindiDrawn += 1;
    } catch (error) {
      console.log(`  (hindi word rejected: ${String(error).slice(0, 90)})`);
    }
  }

  // 2) Read back the in-memory content stream — `3 Tr` must be present.
  //    (The saved file flates every content stream, so raw-bytes greps on
  //    the .pdf would false-negative; the real extraction check is below.)
  const ops = (page as unknown as { contentStream?: { operators: unknown[] } })
    .contentStream?.operators ?? [];
  const opsText = ops.map((op) => String(op)).join(" | ");
  check(/\b3 Tr\b/.test(opsText), "content stream contains the `3 Tr` invisible operator");
  check(/Tj/.test(opsText), "word show-text operators present");
  check(!/\/Tr/.test(opsText), "no bogus `/Tr` name-object operator left");

  // 3) Hindi words all drew via the subset font.
  check(hindiDrawn === hindiWords.length, `all ${hindiWords.length} Hindi words drew via the subset font (${hindiDrawn} did)`);

  // 4) The REAL contract: pdftotext must recover every word from the saved
  //    file — English via Helvetica, Hindi via the embedded subset font's
  //    ToUnicode CMap.
  const bytes = await out.save();
  writeFileSync("/home/z/my-project/download/smoke-ocr-invisible.pdf", bytes);
  let extracted = "";
  try {
    extracted = execFileSync(
      "pdftotext",
      ["/home/z/my-project/download/smoke-ocr-invisible.pdf", "-"],
      { encoding: "utf8" }
    );
  } catch {
    extracted = "";
  }
  for (const word of [...englishWords, ...hindiWords]) {
    check(extracted.includes(word), `pdftotext round-trip: ${word}`);
  }
  check(!/^\s*$/.test(extracted), "extraction is not empty");

  console.log(`\n${pass.length} passed, ${fail.length} failed`);
  if (fail.length > 0) {
    console.log("--- extracted text was:\n" + extracted);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
