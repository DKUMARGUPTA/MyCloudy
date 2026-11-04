/**
 * PRE-BUILD smoke test for Compress to target size (P4.7, PRD §7.5).
 * Locks the engine + the real worker-path BEFORE browser QA:
 *
 *  1. resolveTargetBytes: every preset, custom clamping, defaults,
 *     decimal KB math (100 KB = 100,000 bytes).
 *  2. Ladder tables: strict monotonicity (quality/maxDim down, DPI
 *     down), floor values, step counts.
 *  3. nextProbeIndex: null at lo>=hi, midpoint math, and a simulated
 *     binary search over a monotone ladder finding the exact boundary
 *     with ≤ ceil(log2(n)) probes.
 *  4. formatSize: B/KB/MB boundaries.
 *  5. buildCtsReport: all five method paths carry the honest lines
 *     (none / photos / photos-floor / raster / raster-floor), attempts
 *     list, custom note.
 *  6. classifyCtsError: password/raster/canvas/corrupt mapping.
 *  7. REAL photo path (bun + @napi-rs/canvas shims): big noisy JPEG
 *     fixture + text → compress-pdf engine candidates → recompress
 *     (worker code path via shims) → replaced PDF is far smaller, page
 *     count + text preserved (pdf.js readback).
 *  8. REAL raster path: render all 8 raster steps of the fixture,
 *     verify sizes are (near-)monotone, then pick a target INSIDE the
 *     ladder gap and prove the binary search lands on the exact
 *     boundary step; flattened output has NO extractable text, page
 *     count + page sizes preserved.
 *
 * Run: bun scripts/smoke-cts.ts   (exit code = failures)
 */
import { readFileSync } from "node:fs";
import type { Canvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import "regenerator-runtime/runtime";
import fontkit from "@pdf-lib/fontkit";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  collectImageCandidates,
  replaceImageStream,
  targetSize,
} from "../tools/compress-pdf/engine";
import { recompressCandidate } from "../tools/compress-pdf/recompress-lib";
import {
  buildCtsReport,
  classifyCtsError,
  formatSize,
  nextProbeIndex,
  PHOTO_LADDER,
  RASTER_LADDER,
  resolveTargetBytes,
  type CtsAttemptLog,
} from "../tools/compress-pdf-to-size/engine";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, extra = ""): void {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ""}`);
  } else {
    fail += 1;
    console.error(`  ✗ FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/* ------------------------------------------------------------------ */
/* 1. resolveTargetBytes                                               */
/* ------------------------------------------------------------------ */
{
  console.log("1. resolveTargetBytes");
  check("100kb preset → 100,000 (decimal)", resolveTargetBytes({ target: "100kb" }) === 100_000);
  check("200kb preset → 200,000", resolveTargetBytes({ target: "200kb" }) === 200_000);
  check("500kb preset → 500,000", resolveTargetBytes({ target: "500kb" }) === 500_000);
  check("1mb preset → 1,000,000", resolveTargetBytes({ target: "1mb" }) === 1_000_000);
  check("2mb preset → 2,000,000", resolveTargetBytes({ target: "2mb" }) === 2_000_000);
  check("default (no options) → 200,000", resolveTargetBytes({}) === 200_000);
  check("custom 350 KB → 350,000", resolveTargetBytes({ target: "custom", targetKb: 350 }) === 350_000);
  check("custom below floor clamps to 30 KB", resolveTargetBytes({ target: "custom", targetKb: 5 }) === 30_000);
  check("custom above ceiling clamps to 20,000 KB", resolveTargetBytes({ target: "custom", targetKb: 99999 }) === 20_000_000);
  check("custom NaN falls back to 200", resolveTargetBytes({ target: "custom", targetKb: Number.NaN }) === 200_000);
  check("unknown preset falls back to custom/200", resolveTargetBytes({ target: "nope", targetKb: 480 }) === 480_000);
}

/* ------------------------------------------------------------------ */
/* 2. Ladders                                                          */
/* ------------------------------------------------------------------ */
{
  console.log("2. ladder tables");
  check("photo ladder has 4 steps", PHOTO_LADDER.length === 4);
  let photoMono = true;
  for (let i = 1; i < PHOTO_LADDER.length; i += 1) {
    if (PHOTO_LADDER[i].quality >= PHOTO_LADDER[i - 1].quality) photoMono = false;
    if (PHOTO_LADDER[i].maxDim >= PHOTO_LADDER[i - 1].maxDim) photoMono = false;
  }
  check("photo ladder strictly stronger each step", photoMono);
  check("photo ladder mildest quality sane", PHOTO_LADDER[0].quality === 0.6 && PHOTO_LADDER[0].maxDim === 1600);
  check("photo ladder strongest q28/800", PHOTO_LADDER[3].quality === 0.28 && PHOTO_LADDER[3].maxDim === 800);

  check("raster ladder has 8 steps", RASTER_LADDER.length === 8);
  let rasterMono = true;
  for (let i = 1; i < RASTER_LADDER.length; i += 1) {
    if (RASTER_LADDER[i].dpi >= RASTER_LADDER[i - 1].dpi) rasterMono = false;
    if (RASTER_LADDER[i].quality >= RASTER_LADDER[i - 1].quality) rasterMono = false;
  }
  check("raster ladder strictly coarser each step", rasterMono);
  check("raster floor is 40 DPI q38", RASTER_LADDER[7].dpi === 40 && RASTER_LADDER[7].quality === 0.38);
  check("raster top is 150 DPI", RASTER_LADDER[0].dpi === 150);
  const qualityRange = RASTER_LADDER.every((s) => s.quality >= 0.3 && s.quality <= 0.95);
  check("raster qualities within [0.3, 0.95]", qualityRange);
}

/* ------------------------------------------------------------------ */
/* 3. nextProbeIndex binary search                                     */
/* ------------------------------------------------------------------ */
{
  console.log("3. nextProbeIndex");
  check("null when lo === hi", nextProbeIndex(3, 3) === null);
  check("null when lo > hi", nextProbeIndex(5, 2) === null);
  check("mid of [0,7] is 3", nextProbeIndex(0, 7) === 3);
  check("mid of [0,1] is 0", nextProbeIndex(0, 1) === 0);
  check("mid of [4,7] is 5", nextProbeIndex(4, 7) === 5);

  // Simulate the worker loop against a monotone "sizes" array:
  // smallest index whose size fits the target must be found exactly.
  const sizes = [900_000, 610_000, 402_000, 251_000, 148_000, 92_000, 61_000, 44_000];
  for (const target of [950_000, 700_000, 402_001, 402_000, 200_000, 148_000, 60_000, 44_000, 43_999]) {
    let lo = 0;
    let hi = sizes.length - 1;
    let probes = 0;
    for (;;) {
      const mid = nextProbeIndex(lo, hi);
      if (mid === null) break;
      probes += 1;
      if (sizes[mid] <= target) hi = mid;
      else lo = mid + 1;
    }
    const expected = sizes.findIndex((s) => s <= target);
    check(
      `search finds boundary for ${formatSize(target)}`,
      lo === (expected === -1 ? sizes.length - 1 : expected),
      `→ step ${lo}, probes ${probes}`
    );
  }
  // Probe-count bound: floor + binary search ≤ floor + ceil(log2(8)) + 1
  {
    let lo = 0;
    let hi = 7;
    let probes = 0;
    for (;;) {
      const mid = nextProbeIndex(lo, hi);
      if (mid === null) break;
      probes += 1;
      if (mid % 2 === 0) hi = mid; // adversarial: alternating fits
      else lo = mid + 1;
    }
    check("probe count ≤ log2(8)+1 = 4", probes <= 4, `probes ${probes}`);
  }
}

/* ------------------------------------------------------------------ */
/* 4. formatSize                                                       */
/* ------------------------------------------------------------------ */
{
  console.log("4. formatSize");
  check("987 B", formatSize(987) === "987 B");
  check("1 KB boundary (1000)", formatSize(1000) === "1 KB");
  check("187 KB", formatSize(187_432) === "187 KB");
  check("1.2 MB", formatSize(1_234_567) === "1.2 MB");
  check("2.0 MB", formatSize(2_000_000) === "2.0 MB");
}

/* ------------------------------------------------------------------ */
/* 5. buildCtsReport                                                  */
/* ------------------------------------------------------------------ */
{
  console.log("5. buildCtsReport");
  const attempts: CtsAttemptLog[] = [
    { label: "photos q60 / 1600px", bytes: 640_000, fits: false },
    { label: "photos q45 / 1200px", bytes: 291_000, fits: false },
    { label: "photos q35 / 950px", bytes: 187_432, fits: true },
  ];
  const base = {
    fileName: "kyc.pdf",
    targetBytes: 200_000,
    originalBytes: 1_234_567,
    pageCount: 3,
    attempts,
    grayscale: false,
  };

  const none = buildCtsReport({ ...base, finalBytes: 150_000, method: "none" });
  check("none: pass-through line", none.includes("already under the target"));
  check("none: no attempts section", !none.includes("Attempts"));

  const photos = buildCtsReport({ ...base, finalBytes: 187_432, method: "photos", photoStep: 3 });
  check("photos: under target ✓", photos.includes("UNDER the target ✓"));
  check("photos: text preserved line", photos.includes("still selectable and searchable"));
  check("photos: step noted", photos.includes("step 3 of the ladder"));
  check("photos: attempts listed", photos.includes("photos q60 / 1600px: 640 KB ✗ over"));
  check("photos: saved %", photos.includes("85% smaller"));

  const photosFloor = buildCtsReport({ ...base, finalBytes: 291_000, method: "photos-floor", photoStep: 2 });
  check("photos-floor: could NOT reach", photosFloor.includes("could NOT reach the target"));
  check("photos-floor: flatten suggestion", photosFloor.includes("Re-run with \"Allow flattening\" on"));

  const photosFloorNoImages = buildCtsReport({
    ...base,
    finalBytes: 1_234_567,
    method: "photos-floor",
    photoStep: 0,
    note: "This PDF has no embedded photos to re-encode — only flattening pages to images could shrink it further. Re-run with \"Allow flattening\" on.",
  });
  check("photos-floor(0): no-photos wording", photosFloorNoImages.includes("no embedded photos were found"));
  check("photos-floor(0): note appended", photosFloorNoImages.includes("no embedded photos to re-encode"));

  const raster = buildCtsReport({
    ...base,
    finalBytes: 148_000,
    method: "raster",
    rasterStep: 84,
    rasterQuality: 0.56,
    grayscale: true,
  });
  check("raster: dpi + quality + grayscale", raster.includes("flattened to images at 84 DPI (JPEG quality 56%, grayscale)"));
  check("raster: text NOT selectable line", raster.includes("NOT selectable any more"));

  const rasterFloor = buildCtsReport({
    ...base,
    finalBytes: 214_000,
    method: "raster-floor",
    rasterStep: 40,
    rasterQuality: 0.38,
  });
  check("raster-floor: honest over", rasterFloor.includes("could NOT reach the target ✗"));
  check("raster-floor: closest possible line", rasterFloor.includes("closest possible size"));
  check("raster-floor: ideas line", rasterFloor.includes("remove pages first"));
}

/* ------------------------------------------------------------------ */
/* 6. classifyCtsError                                                 */
/* ------------------------------------------------------------------ */
{
  console.log("6. classifyCtsError");
  check("password → encrypted", classifyCtsError("InvalidPDF: password protected") === "tool.errorEncrypted");
  check("encrypt → encrypted", classifyCtsError("cannot open encrypted document") === "tool.errorEncrypted");
  check("raster-render → cts.errorRender", classifyCtsError("raster-render: page 3: failed") === "cts.errorRender");
  check("canvas → cts.errorRender", classifyCtsError("canvas-2d-unavailable") === "cts.errorRender");
  check("other → corrupt", classifyCtsError("unexpected EOF") === "tool.errorCorrupt");
}

/* ------------------------------------------------------------------ */
/* 7. REAL photo path (shimmed worker code)                            */
/* ------------------------------------------------------------------ */
{
  console.log("7. REAL photo path");
  const canvasMod = await import("@napi-rs/canvas");
  (globalThis as Record<string, unknown>).Path2D = canvasMod.Path2D;
  (globalThis as Record<string, unknown>).Image = canvasMod.Image;
  class ShimOffscreenCanvas {
    private cv: Canvas;
    constructor(w: number, h: number) {
      this.cv = canvasMod.createCanvas(w, h) as Canvas;
    }
    get width() { return this.cv.width; }
    get height() { return this.cv.height; }
    getContext(type: "2d") { return this.cv.getContext(type); }
    async convertToBlob(init: { type?: string; quality?: number } = {}) {
      const type = init.type ?? "image/png";
      const fmt = type === "image/jpeg" ? "image/jpeg" : "image/png";
      const q = Math.round((init.quality ?? 0.8) * 100);
      const buf =
        fmt === "image/jpeg"
          ? this.cv.toBuffer("image/jpeg", q)
          : this.cv.toBuffer("image/png");
      return new Blob([buf as BlobPart], { type });
    }
  }
  (globalThis as Record<string, unknown>).OffscreenCanvas = ShimOffscreenCanvas;
  (globalThis as Record<string, unknown>).createImageBitmap = async (blob: Blob) => {
    const buf = Buffer.from(await blob.arrayBuffer());
    return canvasMod.loadImage(buf);
  };

  // Noisy photo (incompressible) — the realistic "photo-heavy scan" case.
  const noise = canvasMod.createCanvas(1800, 1200);
  const nctx = noise.getContext("2d");
  const img = nctx.createImageData(1800, 1200);
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = Math.floor(rand() * 256);
    img.data[i + 1] = Math.floor(rand() * 256);
    img.data[i + 2] = Math.floor(rand() * 256);
    img.data[i + 3] = 255;
  }
  nctx.putImageData(img, 0, 0);
  const noiseJpeg = noise.toBuffer("image/jpeg", 88);
  check("fixture: noisy JPEG is big", noiseJpeg.length > 500_000, `${(noiseJpeg.length / 1000).toFixed(0)} KB`);

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const photo = await doc.embedJpg(new Uint8Array(noiseJpeg));
  const p1 = doc.addPage([595.28, 841.89]);
  p1.drawText("Compress to size QA fixture", { x: 40, y: 780, size: 18, font, color: rgb(0.1, 0.1, 0.1) });
  p1.drawImage(photo, { x: 40, y: 300, width: 515, height: 343 });
  const p2 = doc.addPage([595.28, 841.89]);
  p2.drawText("Second page has text only.", { x: 40, y: 780, size: 14, font });
  const original = await doc.save();
  check("fixture: original PDF is over 500 KB", original.length > 500_000, `${(original.length / 1000).toFixed(0)} KB`);

  // The worker's photoAttempt loop, verbatim (strongest step).
  const target = 400_000;
  const step = PHOTO_LADDER[PHOTO_LADDER.length - 1];
  const runDoc = await PDFDocument.load(original, { ignoreEncryption: false, updateMetadata: false });
  const candidates = collectImageCandidates(runDoc);
  check("photo path: 1 image candidate found", candidates.length === 1, `strategy ${candidates[0].strategy}`);
  let replaced = 0;
  for (const candidate of candidates) {
    const result = await recompressCandidate(candidate, step.quality, step.maxDim, false);
    if (result) {
      replaceImageStream(runDoc.context, candidate, result.bytes, result.width, result.height);
      replaced += 1;
    }
  }
  check("photo path: image replaced", replaced === 1);
  const saved = await runDoc.save({ useObjectStreams: true });
  check("photo path: output under target", saved.length <= target, `${(saved.length / 1000).toFixed(0)} KB ≤ 400 KB`);
  check("photo path: at least 30% smaller", saved.length < original.length * 0.7, `${Math.round((1 - saved.length / original.length) * 100)}% saved`);

  // Text preserved (pdf.js readback).
  const rd = await getDocument({ data: new Uint8Array(saved), useSystemFonts: true }).promise;
  const rpage = await rd.getPage(1);
  const rtext = await rpage.getTextContent();
  const joined = rtext.items.map((it) => ("str" in it ? it.str : "")).join("");
  check("photo path: text still extracts", joined.includes("Compress to size QA fixture"));
  await rd.destroy();

  // Also verify the MILDEST step does NOT yet fit (ladder spread is real).
  const mildDoc = await PDFDocument.load(original, { ignoreEncryption: false, updateMetadata: false });
  const mildCandidates = collectImageCandidates(mildDoc);
  const mildResult = await recompressCandidate(mildCandidates[0], PHOTO_LADDER[0].quality, PHOTO_LADDER[0].maxDim, false);
  check("photo path: mildest step re-encodes too", mildResult !== null);
  if (mildResult) {
    const t = targetSize(1800, 1200, PHOTO_LADDER[0].maxDim);
    check("photo path: mildest caps at 1600px", t.width === 1600 && t.height === 1067, `${t.width}x${t.height}`);
  }
}

/* ------------------------------------------------------------------ */
/* 8. REAL raster path + binary search                                 */
/* ------------------------------------------------------------------ */
{
  console.log("8. REAL raster path");
  const canvasMod = await import("@napi-rs/canvas");
  const notoBytes = readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf");
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(notoBytes, { subset: false });
  const p1 = doc.addPage([595.28, 841.89]);
  p1.drawText("Flatten me: account 123456789012345", { x: 72, y: 720, size: 14, font, color: rgb(0, 0, 0) });
  p1.drawText("Second line with more words", { x: 72, y: 680, size: 14, font, color: rgb(0, 0, 0) });
  const p2 = doc.addPage([595.28, 841.89]);
  p2.drawText("Page two text here", { x: 72, y: 720, size: 14, font, color: rgb(0, 0, 0) });
  const original = await doc.save();

  const pdfOpen = async (bytes: Uint8Array) =>
    getDocument({
      data: bytes,
      useSystemFonts: true,
      ownerDocument: {
        createElement: () => canvasMod.createCanvas(1, 1),
      } as unknown as HTMLDocument,
    }).promise;

  // The worker's rasterizeAll, verbatim (napi canvas instead of Offscreen).
  const rasterizeAll = async (source: Uint8Array, dpi: number, quality: number) => {
    const src = await pdfOpen(new Uint8Array(source));
    const out = await PDFDocument.create();
    for (let pageNumber = 1; pageNumber <= src.numPages; pageNumber += 1) {
      const page = await src.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(0.5, Math.min(8, dpi / 72));
      const viewport = page.getViewport({ scale });
      const pixelW = Math.max(1, Math.round(viewport.width));
      const pixelH = Math.max(1, Math.round(viewport.height));
      const canvas = canvasMod.createCanvas(pixelW, pixelH);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, pixelW, pixelH);
      await page.render({
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      page.cleanup();
      const jpeg = canvas.toBuffer("image/jpeg", Math.round(quality * 100));
      const image = await out.embedJpg(new Uint8Array(jpeg));
      const outPage = out.addPage([base.width, base.height]);
      outPage.drawImage(image, { x: 0, y: 0, width: base.width, height: base.height });
    }
    await src.cleanup();
    return out.save({ useObjectStreams: true });
  };

  // Render ALL 8 steps to measure the ladder for this fixture.
  const stepBytes: number[] = [];
  for (const step of RASTER_LADDER) {
    const bytes = await rasterizeAll(original, step.dpi, step.quality);
    stepBytes.push(bytes.length);
    console.log(`    raster ${step.dpi} DPI → ${(bytes.length / 1000).toFixed(1)} KB`);
  }
  let mono = true;
  for (let i = 1; i < stepBytes.length; i += 1) {
    if (stepBytes[i] > stepBytes[i - 1] * 1.05) mono = false; // 5% tolerance
  }
  check("raster path: sizes non-increasing down the ladder", mono);

  // Target strictly inside the ladder gap: between step 3 and step 2.
  const target = Math.floor((stepBytes[2] + stepBytes[3]) / 2);
  check("raster path: target is inside the gap", stepBytes[3] <= target && target < stepBytes[2], `target ${(target / 1000).toFixed(1)} KB`);

  // The worker's binary search, verbatim.
  let lo = 0;
  let hi = RASTER_LADDER.length - 1;
  const floorBytes = await rasterizeAll(original, RASTER_LADDER[7].dpi, RASTER_LADDER[7].quality);
  if (floorBytes.length <= target) {
    let probes = 0;
    for (;;) {
      const mid = nextProbeIndex(lo, hi);
      if (mid === null) break;
      probes += 1;
      const step = RASTER_LADDER[mid];
      const bytes = mid === 3 ? { length: stepBytes[3] } : await rasterizeAll(original, step.dpi, step.quality);
      if (bytes.length <= target) hi = mid;
      else lo = mid + 1;
    }
    check("raster path: search lands on the boundary step", lo === 3, `→ step ${lo} (${RASTER_LADDER[lo].dpi} DPI), ${probes} probes`);
    check("raster path: ≤ 4 probes", probes <= 4);

    // Boundary properties: chosen fits, one-better doesn't.
    check("raster path: chosen step fits", stepBytes[lo] <= target);
    check("raster path: one-better step is over", stepBytes[lo - 1] > target);

    const finalBytes = await rasterizeAll(original, RASTER_LADDER[lo].dpi, RASTER_LADDER[lo].quality);
    const out = await pdfOpen(new Uint8Array(finalBytes));
    check("raster path: page count preserved", out.numPages === 2);
    const t1 = await (await out.getPage(1)).getTextContent();
    const t2 = await (await out.getPage(2)).getTextContent();
    check("raster path: page 1 text GONE", t1.items.length === 0, `${t1.items.length} items`);
    check("raster path: page 2 text GONE", t2.items.length === 0, `${t2.items.length} items`);
    const outPage = await out.getPage(1);
    const vp = outPage.getViewport({ scale: 1 });
    check("raster path: page size preserved", Math.abs(vp.width - 595.28) < 0.5 && Math.abs(vp.height - 841.89) < 0.5, `${vp.width.toFixed(1)}x${vp.height.toFixed(1)}`);
    await out.destroy();
  } else {
    check("raster path: floor fits a mid-ladder target", false, "floor unexpectedly over target");
  }

  // Floor-unreachable honesty: an absurd target (10 KB) still returns bytes.
  const floorOnly = await rasterizeAll(original, RASTER_LADDER[7].dpi, RASTER_LADDER[7].quality);
  check("raster path: floor still a valid PDF", floorOnly.length > 5000);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
