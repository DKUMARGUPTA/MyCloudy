/**
 * PRE-BUILD smoke test for the OCR PDF tool (P4.4, PRD §8.4).
 * Locks the engine behaviors the worker depends on BEFORE browser QA:
 *
 *  1. resolveOcrOptions: defaults + defensive clamps (bad langs / dpi /
 *     outputMode, the string "false" for the skip switch).
 *  2. Viewport math: invertViewportPoint round-trips identity, scale-flip
 *     and all four /Rotate transforms; wordBoxToPdfRect pins known values
 *     (y flip, positive extents, rotated-page mapping).
 *  3. fitWordFontSize: height fit, width shrink, min-1/max-400 clamps.
 *  4. sanitizeWordText / hasDevanagari / pageTextOf / buildTextOutput.
 *  5. extractWords: real Tesseract v5 block shape, garbage shapes,
 *     zero-area + empty-text drops, mean confidence.
 *  6. Invisible layer ROUND-TRIP (the searchable proof): pdf-lib doc +
 *     drawInvisibleWords with Helvetica + embedded Noto Devanagari
 *     (subset) — save → reload with pdf.js (legacy build, bun) →
 *     (a) getTextContent EXTRACTS every word incl. Devanagari,
 *     (b) item positions round-trip to the original boxes (±0.5pt),
 *     (c) a /Rotate 90 page maps through the rotated transform too,
 *     (d) the page RENDERS unchanged (bun + @napi-rs/canvas): the layer
 *         is invisible — max channel diff 0 across the page.
 *  7. Asset sanity: /tessdata/{eng,hin}.traineddata + /tesseract files
 *     exist with the expected shapes.
 *
 * Run: bun scripts/smoke-ocr.ts   (exit code = failures)
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  PDFArray,
  PDFDocument,
  PDFName,
  StandardFonts,
  degrees,
  decodePDFRawStream,
} from "pdf-lib";
import "regenerator-runtime/runtime";
import fontkit from "@pdf-lib/fontkit";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  buildTextOutput,
  drawInvisibleWords,
  extractWords,
  fitWordFontSize,
  hasDevanagari,
  invertViewportPoint,
  pageTextOf,
  resolveOcrOptions,
  sanitizeWordText,
  wordBoxToPdfRect,
  type OcrWord,
  type ViewportTransform,
} from "../tools/ocr-pdf/engine";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`  ✗ ${name}`);
  }
}
function close(a: number, b: number, tol = 0.5): boolean {
  return Math.abs(a - b) <= tol;
}

/* ------------------------------------------------------------------ */
/* 1. resolveOcrOptions                                               */
/* ------------------------------------------------------------------ */

{
  const d = resolveOcrOptions({});
  check("defaults: eng/150/all/skip/pdf", 
    d.langs === "eng" && d.dpi === 150 && d.pages === "all" && d.skipTextPages && d.outputMode === "pdf");

  check("langs hin", resolveOcrOptions({ langs: "hin" }).langs === "hin");
  check("langs eng+hin", resolveOcrOptions({ langs: "eng+hin" }).langs === "eng+hin");
  check("langs garbage -> eng", resolveOcrOptions({ langs: "fra" }).langs === "eng");
  check("dpi string 300 -> 300", resolveOcrOptions({ dpi: "300" }).dpi === 300);
  check("dpi 999 -> 150", resolveOcrOptions({ dpi: 999 }).dpi === 150);
  check("dpi NaN -> 150", resolveOcrOptions({ dpi: "abc" }).dpi === 150);
  check("skip 'false' -> false", resolveOcrOptions({ skipTextPages: "false" }).skipTextPages === false);
  check("skip false -> false", resolveOcrOptions({ skipTextPages: false }).skipTextPages === false);
  check("skip undefined -> true", resolveOcrOptions({}).skipTextPages === true);
  check("output text", resolveOcrOptions({ outputMode: "text" }).outputMode === "text");
  check("output both", resolveOcrOptions({ outputMode: "both" }).outputMode === "both");
  check("output garbage -> pdf", resolveOcrOptions({ outputMode: "docx" }).outputMode === "pdf");
  check("pages passthrough", resolveOcrOptions({ pages: "2-4" }).pages === "2-4");
}

/* ------------------------------------------------------------------ */
/* 2. Viewport math                                                    */
/* ------------------------------------------------------------------ */

// pdf.js viewport transforms for a 612x792 page (user space, origin BL):
const S = 2; // 144 DPI
const W = 612;
const H = 792;
const T_ROT0: ViewportTransform = [S, 0, 0, -S, 0, H * S];
const T_ROT90: ViewportTransform = [0, S, S, 0, 0, W * S];
const T_ROT180: ViewportTransform = [-S, 0, 0, S, W * S, 0];
const T_ROT270: ViewportTransform = [0, -S, -S, 0, H * S, W * S];

{
  const id: ViewportTransform = [1, 0, 0, 1, 0, 0];
  const p = invertViewportPoint(id, 12, 34);
  check("identity invert", p.x === 12 && p.y === 34);
}

{
  // Unrotated: viewport (x, y) -> user (x/s, (H*s - y)/s)
  const p = invertViewportPoint(T_ROT0, 100, 200);
  check("rot0 x maps to user x/s", close(p.x, 50, 1e-9));
  check("rot0 y flips to (H - vy)/s", close(p.y, (H * S - 200) / S, 1e-9));
}

{
  // Round-trips: forward(transform, inverse(transform, v)) === v for all rotations.
  const forward = (t: ViewportTransform, x: number, y: number) => ({
    x: t[0] * x + t[2] * y + t[4],
    y: t[1] * x + t[3] * y + t[5],
  });
  let all = true;
  for (const t of [T_ROT0, T_ROT90, T_ROT180, T_ROT270]) {
    for (const [vx, vy] of [[37, 411], [600, 900], [1, 1]] as const) {
      const inv = invertViewportPoint(t, vx, vy);
      const fwd = forward(t, inv.x, inv.y);
      if (!close(fwd.x, vx, 1e-6) || !close(fwd.y, vy, 1e-6)) all = false;
    }
  }
  check("invert round-trips all rotations", all);
  check("degenerate transform falls back", (() => {
    const p = invertViewportPoint([0, 0, 0, 0, 0, 0], 5, 6);
    return p.x === 5 && p.y === 6;
  })());
}

{
  // Known rect on an unrotated page: word box (100,200)-(300,260) px
  // at scale 2 -> user rect x 50, w 100, y (1584-260)/2 = 662, h 30.
  const rect = wordBoxToPdfRect({ x0: 100, y0: 200, x1: 300, y1: 260 }, T_ROT0);
  check("rect x", close(rect.x, 50, 1e-9));
  check("rect y (bottom-up)", close(rect.y, (H * S - 260) / S, 1e-9));
  check("rect width", close(rect.width, 100, 1e-9));
  check("rect height", close(rect.height, 30, 1e-9));

  // Zero-area protection: min/max keeps extents non-negative everywhere.
  const weird = wordBoxToPdfRect({ x0: 5, y0: 5, x1: 5, y1: 5 }, T_ROT90);
  check("degenerate box -> zero extents", weird.width === 0 && weird.height === 0);
}

/* ------------------------------------------------------------------ */
/* 3. fitWordFontSize                                                  */
/* ------------------------------------------------------------------ */

{
  const wide = (_t: string, size: number) => size * 0.6; // "wide" font
  check("height fit when narrow enough", close(fitWordFontSize("Hi", 100, 40, wide), 40, 1e-9));
  check("width shrink fits the box", close(fitWordFontSize("Hello", 20, 40, (_t, s) => s * 2), 10, 1e-9));
  check("min clamp 1", fitWordFontSize("Word", 1, 0.001, wide) === 1);
  check("max clamp 400", fitWordFontSize("Word", 10_000, 10_000, wide) === 400);
  check("empty box height falls back", fitWordFontSize("Word", 10, -5, wide) === 4);
  check("zero-width box keeps height", fitWordFontSize("Word", 0, 24, wide) === 24);
}

/* ------------------------------------------------------------------ */
/* 4. sanitize / hasDevanagari / text output                           */
/* ------------------------------------------------------------------ */

{
  check("sanitize newline+spaces", sanitizeWordText("  a\nb\tc  ") === "a b c");
  check("sanitize control chars", sanitizeWordText("x\u0000\u0007y") === "x y");
  check("sanitize empty -> null", sanitizeWordText("   \n\t ") === null);
  check("sanitize cap 200", sanitizeWordText("a".repeat(300))?.length === 200);
  check("hasDevanagari true", hasDevanagari("नमस्ते"));
  check("hasDevanagari false", !hasDevanagari("Hello 123"));
  check("pageTextOf passthrough", pageTextOf({ text: "abc" }) === "abc");
  check("pageTextOf garbage -> empty", pageTextOf(null) === "" && pageTextOf(42) === "");
  const txt = buildTextOutput([" one ", "two\n", "\u0000three"]);
  check("buildTextOutput form-feed join", txt === " one\n\f\ntwo\n\f\nthree");
}

/* ------------------------------------------------------------------ */
/* 5. extractWords                                                     */
/* ------------------------------------------------------------------ */

{
  // Real Tesseract v5 shape: blocks -> paragraphs -> lines -> words.
  const blocks = [
    {
      paragraphs: [
        {
          lines: [
            {
              words: [
                { text: "INVOICE", confidence: 95, bbox: { x0: 0, y0: 0, x1: 80, y1: 20 } },
                { text: "#2026", confidence: 85, bbox: { x0: 90, y0: 0, x1: 130, y1: 20 } },
              ],
            },
          ],
        },
      ],
    },
    {
      paragraphs: [
        {
          lines: [
            {
              words: [
                { text: "नमस्ते", confidence: 80, bbox: { x0: 0, y0: 40, x1: 100, y1: 70 } },
                { text: "", confidence: 99, bbox: { x0: 0, y0: 0, x1: 50, y1: 10 } },
                { text: "zero", confidence: 99, bbox: { x0: 50, y0: 40, x1: 50, y1: 40 } },
              ],
            },
          ],
        },
      ],
    },
  ];
  const { words, confidence } = extractWords(blocks);
  check("extractWords keeps 3 valid words", words.length === 3);
  check("extractWords drops empty text", words.every((w) => w.text.length > 0));
  check("extractWords drops zero-area box", words.every((w) => w.x1 > w.x0 && w.y1 > w.y0));
  check("extractWords mean confidence", close(confidence, (95 + 85 + 80) / 3, 1e-9));
  check("extractWords first word", words[0].text === "INVOICE" && words[0].confidence === 95);

  check("extractWords garbage null", extractWords(null).words.length === 0);
  check("extractWords garbage object", extractWords({ nope: 1 }).words.length === 0);
  check(
    "extractWords missing levels",
    extractWords([{ paragraphs: [{ lines: [{}] }] }]).words.length === 0
  );
}

/* ------------------------------------------------------------------ */
/* 6. Invisible-layer round-trip (pdf-lib write -> pdf.js read)        */
/* ------------------------------------------------------------------ */

async function roundTrip(): Promise<void> {
  const devaBytes = new Uint8Array(
    readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
  );

  // A4 pages: page 1 plain, page 2 rotated 90° (the /Rotate path).
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Original visible content", {
    x: 72,
    y: 700,
    size: 18,
    font: helv,
  });
  const rotPage = doc.addPage([595.28, 841.89]);
  rotPage.setRotation(degrees(90));
  rotPage.drawText("Rotated page content", {
    x: 72,
    y: 700,
    size: 18,
    font: helv,
  });
  const originalBytes = await doc.save();

  // THE transforms the worker will use: real pdf.js viewport transforms
  // at 150 DPI (the run's default render scale).
  const scale = 150 / 72;
  const baseDoc = await getDocument({
    data: originalBytes.slice(),
    standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  }).promise;
  const transform = (
    await (await baseDoc.getPage(1)).getViewport({ scale })
  ).transform as unknown as ViewportTransform;
  const rotViewport = (
    await (await baseDoc.getPage(2)).getViewport({ scale })
  ).transform as unknown as ViewportTransform;
  await baseDoc.destroy();

  const words: OcrWord[] = [
    { text: "INVOICE", x0: 100, y0: 120, x1: 320, y1: 160, confidence: 96 },
    { text: "#2026-789", x0: 340, y0: 120, x1: 560, y1: 160, confidence: 88 },
    { text: "TOTAL", x0: 100, y0: 200, x1: 220, y1: 235, confidence: 93 },
    { text: "₹12,345", x0: 240, y0: 200, x1: 420, y1: 235, confidence: 71 },
    { text: "नमस्ते", x0: 100, y0: 300, x1: 280, y1: 345, confidence: 84 },
  ];
  const rects = words.map((w) => wordBoxToPdfRect(w, transform));

  // Draw with the EXACT engine code the worker uses.
  const layerDoc = await PDFDocument.load(originalBytes);
  layerDoc.registerFontkit(fontkit);
  const deva = await layerDoc.embedFont(devaBytes, { subset: true });
  const layerHelv = await layerDoc.embedFont(StandardFonts.Helvetica);
  drawInvisibleWords(layerDoc.getPages()[0], words, transform, layerHelv, deva);
  const rotWords: OcrWord[] = [
    { text: "SIDEWAYS", x0: 120, y0: 100, x1: 320, y1: 150, confidence: 90 },
  ];
  drawInvisibleWords(
    layerDoc.getPages()[1],
    rotWords,
    rotViewport,
    layerHelv,
    deva
  );
  const layeredBytes = await layerDoc.save();

  check(
    "layered output is bigger (text added)",
    layeredBytes.length > originalBytes.length
  );

  // (a) Content stream carries text-show operators + a zero-alpha ExtGState.
  const checkDoc = await PDFDocument.load(layeredBytes);
  const [checkPage] = checkDoc.getPages();
  const contents = checkPage.node.Contents();
  const streamRefs: unknown[] =
    contents instanceof PDFArray ? contents.asArray() : [contents];
  let decoded = "";
  for (const ref of streamRefs) {
    const stream = checkPage.doc.context.lookup(ref as never);
    if (stream && typeof stream === "object" && "getContents" in stream) {
      try {
        decoded += new TextDecoder().decode(
          decodePDFRawStream(stream as never).decode()
        );
      } catch {
        /* a stream we can't decode — skip */
      }
    }
  }
  check("content stream has text ops", decoded.includes("BT") && decoded.includes("ET"));
  check("content stream sets a gs (alpha 0)", /\/GS-?\d+\s+gs/.test(decoded));
  // pdf-lib writes strings as hex operators — "Original" is 4F726967696E616C.
  check("content stream keeps original text", decoded.includes("4F726967696E616C"));
  check("content stream carries layered words", (decoded.match(/Tj/g) ?? []).length >= 6);

  // ExtGState with ca 0 must be in the page resources.
  const resources = checkPage.node.Resources();
  const extGState = resources?.get(PDFName.of("ExtGState"));
  check("ExtGState resource present", extGState !== undefined);

  // (b) pdf.js EXTRACTION readback — the searchable proof.
  const pdfjs = await getDocument({
    data: layeredBytes.slice(),
    standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  }).promise;
  const textPage = await (await pdfjs.getPage(1)).getTextContent();
  const extracted = textPage.items
    .map((item) => ("str" in item ? item.str : ""))
    .join(" ");
  check("extraction has INVOICE", extracted.includes("INVOICE"));
  check("extraction has #2026-789", extracted.includes("#2026-789"));
  check("extraction has TOTAL", extracted.includes("TOTAL"));
  check("extraction has rupee amount", extracted.includes("₹12,345"));
  check("extraction has Devanagari", extracted.includes("नमस्ते"));
  check("extraction keeps original text", extracted.includes("Original visible content"));

  // (c) Position round-trip: each layered item's transform must land back
  // on its box origin (baseline == rect.y, left == rect.x).
  const positioned = textPage.items.filter(
    (item): item is typeof item & { str: string; transform: number[] } =>
      "transform" in item && typeof (item as { str?: unknown }).str === "string"
  );
  let positionsOk = 0;
  for (const word of ["INVOICE", "TOTAL", "नमस्ते"]) {
    const item = positioned.find((candidate) => candidate.str === word);
    if (!item) continue;
    const index = words.findIndex((w) => w.text === word);
    const rect = rects[index];
    if (
      close(item.transform[4], rect.x, 0.5) &&
      close(item.transform[5], rect.y, 0.5)
    ) {
      positionsOk += 1;
    }
  }
  check("position round-trip x/y on boxes", positionsOk === 3);

  // (c2) /Rotate 90 page: SIDEWAYS was drawn through the ROTATED viewport
  // transform — extraction (user space) must land on the same rect.
  const rotRect = wordBoxToPdfRect(rotWords[0], rotViewport);
  const rotText = await (await pdfjs.getPage(2)).getTextContent();
  const sideways = rotText.items.find(
    (item): item is typeof item & { transform: number[] } =>
      "str" in item && item.str === "SIDEWAYS"
  );
  check(
    "rotated page position round-trip",
    sideways !== undefined &&
      close(sideways.transform[4], rotRect.x, 0.5) &&
      close(sideways.transform[5], rotRect.y, 0.5)
  );

  // (d) The layer is INVISIBLE: render page 1 before/after, pixel-identical.
  const canvasMod = await import("@napi-rs/canvas");
  (globalThis as Record<string, unknown>).Path2D = canvasMod.Path2D;
  (globalThis as Record<string, unknown>).Image = canvasMod.Image;
  async function renderPage1(bytes: Uint8Array): Promise<Uint8ClampedArray> {
    const d = await getDocument({
      data: bytes.slice(),
      standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
    }).promise;
    const p = await d.getPage(1);
    const viewport = p.getViewport({ scale: 1.5 });
    const canvas = canvasMod.createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height)
    );
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await p.render({
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    p.cleanup();
    await d.destroy();
    return img.data;
  }
  const before = await renderPage1(originalBytes);
  const after = await renderPage1(layeredBytes);
  let maxDiff = 0;
  for (let i = 0; i < before.length; i += 1) {
    const diff = Math.abs(before[i] - after[i]);
    if (diff > maxDiff) maxDiff = diff;
  }
  check("invisible layer renders pixel-identical", maxDiff === 0);

  await pdfjs.destroy();
}

await roundTrip().catch((error: unknown) => {
  fail += 1;
  console.error("  ✗ roundTrip threw:", error);
});

/* ------------------------------------------------------------------ */
/* 7. Asset sanity                                                     */
/* ------------------------------------------------------------------ */

{
  for (const lang of ["eng", "hin"] as const) {
    const path = `public/tessdata/${lang}.traineddata`;
    check(`${lang}.traineddata exists`, existsSync(path));
    if (existsSync(path)) {
      const size = statSync(path).size;
      check(`${lang}.traineddata plausible size`, size > 500_000 && size < 15_000_000);
      const head = readFileSync(path).slice(0, 4);
      // tessdata: little-endian version int first (0x18 = v24 current).
      check(`${lang}.traineddata magic`, head[0] === 0x18 && head[1] === 0);
    }
  }
  for (const asset of [
    "public/tesseract/tesseract.min.js",
    "public/tesseract/worker.min.js",
    "public/tesseract/tesseract-core-simd-lstm.wasm.js",
    "public/tesseract/tesseract-core-lstm.wasm.js",
  ]) {
    check(`${asset} exists`, existsSync(asset) && statSync(asset).size > 1000);
  }
  // The UMD build must bind to `self` (worker-safe), not `this` (ESM-unsafe).
  const umd = readFileSync("public/tesseract/tesseract.min.js", "utf8");
  check("UMD binds to self", /\}\(self,/.test(umd));
  check("UMM has no process.env", !umd.includes("process.env"));
}

/* ------------------------------------------------------------------ */

console.log(
  `smoke-ocr: ${pass} passed, ${fail} failed`
);
process.exit(fail === 0 ? 0 : 1);
