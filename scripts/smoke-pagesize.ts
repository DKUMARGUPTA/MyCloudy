/**
 * PRE-BUILD smoke test for Change PDF page size (P4.10, PRD §8.3).
 * Locks the engine + the real pdf-lib resize pipeline BEFORE browser QA:
 *
 *  1. resolvePageSizeOptions: defaults + clamps + garbage tolerance.
 *  2. targetSizePt: presets, orientation forcing, per-page auto, custom mm.
 *  3. sizeLabelPt: preset recognition + custom mm fallback.
 *  4. pageNeedsChange: the ±0.75pt kept-page tolerance boundaries.
 *  5. resizeScale: fit=min / fill=max / none=1.
 *  6. resizePlacement: anchor math for /Rotate 0/90/180/270 × fit/fill/none
 *     (the n-up embedPlacement corner rules generalized).
 *  7. buildSizeInventory + buildPageSizeReport: grouping + honest summary.
 *  8. REAL E2E (bun + pdf-lib + pdf.js + @napi-rs/canvas) — the mixed-size
 *     fixture through the EXACT worker pipeline (runPageSize):
 *       - A4 auto: p1+p3 kept (link annotation SURVIVES on p1; p3 keeps
 *         /Rotate 90), p2/p4/p5 resized; every page lands on A4.
 *       - fit vs fill differential: the same canvas point is dark in fit,
 *         white in fill (Letter square straddling the right edge).
 *       - fill covers the top edge (dark band), fit leaves a white margin.
 *       - none mode: 300x400 content centered on A4, margins white.
 *       - Letter auto: p3's rotated content resized through the rotation
 *         path (792x612, square top-left, text extracts).
 *       - fast path: an all-A4 doc returns the ORIGINAL bytes untouched.
 *       - pages targeting "2": only p2 changes; unselected sizes survive.
 *       - text stays selectable everywhere (vector, no raster).
 *
 * Run: bun scripts/smoke-pagesize.ts   (exit code = failures)
 */
import { readFileSync } from "node:fs";
import type { Canvas } from "@napi-rs/canvas";
import { createCanvas } from "@napi-rs/canvas";
import "regenerator-runtime/runtime";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument } from "pdf-lib";

import {
  PGSZ_DEFAULTS,
  buildPageSizeReport,
  buildSizeInventory,
  pageNeedsChange,
  resizePlacement,
  resizeScale,
  resolvePageSizeOptions,
  sizeLabelPt,
  targetSizePt,
} from "../tools/change-pdf-page-size/engine";
import { runPageSize } from "../tools/change-pdf-page-size/worker-lib";

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

function near(a: number, b: number, tol = 0.05): boolean {
  return Math.abs(a - b) <= tol;
}

/* ------------------------------------------------------------------ */
/* 1. resolvePageSizeOptions                                            */
/* ------------------------------------------------------------------ */
{
  console.log("1. resolvePageSizeOptions");
  const d = resolvePageSizeOptions({});
  check(
    "defaults: a4/auto/fit/all/210x297",
    d.size === "a4" &&
      d.orientation === "auto" &&
      d.scale === "fit" &&
      d.pages === "all" &&
      d.customW === 210 &&
      d.customH === 297
  );
  const full = resolvePageSizeOptions({
    size: "custom",
    customW: 180,
    customH: 260,
    orientation: "landscape",
    scale: "fill",
    pages: "1-2",
  });
  check(
    "all fields honored",
    full.size === "custom" &&
      full.customW === 180 &&
      full.customH === 260 &&
      full.orientation === "landscape" &&
      full.scale === "fill" &&
      full.pages === "1-2"
  );
  const garbage = resolvePageSizeOptions({
    size: "nope",
    customW: 5000,
    customH: NaN,
    orientation: "diagonal",
    scale: "stretch",
    pages: 42,
  });
  check(
    "garbage falls back + clamps",
    garbage.size === PGSZ_DEFAULTS.size &&
      garbage.customW === 2000 &&
      garbage.customH === PGSZ_DEFAULTS.customH &&
      garbage.orientation === PGSZ_DEFAULTS.orientation &&
      garbage.scale === PGSZ_DEFAULTS.scale &&
      garbage.pages === "all",
    `w=${garbage.customW} h=${garbage.customH}`
  );
}

/* ------------------------------------------------------------------ */
/* 2. targetSizePt                                                      */
/* ------------------------------------------------------------------ */
{
  console.log("2. targetSizePt");
  const base = { size: "a4" as const, customW: 210, customH: 297 };
  const portrait = targetSizePt({ ...base, orientation: "portrait" }, {
    w: 1000,
    h: 500,
  });
  check(
    "forced portrait: short side first",
    near(portrait.w, 595.28) && near(portrait.h, 841.89)
  );
  const landscape = targetSizePt({ ...base, orientation: "landscape" }, {
    w: 500,
    h: 1000,
  });
  check(
    "forced landscape: long side first",
    near(landscape.w, 841.89) && near(landscape.h, 595.28)
  );
  const autoLand = targetSizePt({ ...base, orientation: "auto" }, {
    w: 1000,
    h: 500,
  });
  check(
    "auto follows a landscape page",
    near(autoLand.w, 841.89) && near(autoLand.h, 595.28)
  );
  const autoPort = targetSizePt({ ...base, orientation: "auto" }, {
    w: 500,
    h: 1000,
  });
  check(
    "auto follows a portrait page",
    near(autoPort.w, 595.28) && near(autoPort.h, 841.89)
  );
  const custom = targetSizePt(
    { size: "custom", customW: 180, customH: 260, orientation: "portrait" },
    { w: 500, h: 500 }
  );
  check(
    "custom mm -> pt",
    near(custom.w, 510.24, 0.3) && near(custom.h, 737.01, 0.3),
    `${custom.w.toFixed(1)}x${custom.h.toFixed(1)}`
  );
  const customLand = targetSizePt(
    { size: "custom", customW: 180, customH: 260, orientation: "landscape" },
    { w: 500, h: 500 }
  );
  check(
    "custom honors forced landscape",
    near(customLand.w, 737.01, 0.3) && near(customLand.h, 510.24, 0.3)
  );
}

/* ------------------------------------------------------------------ */
/* 3. sizeLabelPt                                                       */
/* ------------------------------------------------------------------ */
{
  console.log("3. sizeLabelPt");
  check(
    "A4 recognized",
    sizeLabelPt(595.28, 841.89) === "A4 · 210 × 297 mm",
    sizeLabelPt(595.28, 841.89)
  );
  check(
    "A4 landscape recognized (orientation-insensitive)",
    sizeLabelPt(841.89, 595.28) === "A4 · 210 × 297 mm"
  );
  check(
    "Letter recognized",
    sizeLabelPt(612, 792) === "Letter · 215.9 × 279.4 mm",
    sizeLabelPt(612, 792)
  );
  check(
    "custom size falls back to mm",
    sizeLabelPt(300, 400) === "105.8 × 141.1 mm",
    sizeLabelPt(300, 400)
  );
}

/* ------------------------------------------------------------------ */
/* 4. pageNeedsChange                                                   */
/* ------------------------------------------------------------------ */
{
  console.log("4. pageNeedsChange");
  const target = { w: 595.28, h: 841.89 };
  check(
    "0.62pt drift -> kept (within 0.75)",
    pageNeedsChange({ w: 595.9, h: 841.89 }, target) === false
  );
  check(
    "1.22pt drift -> change",
    pageNeedsChange({ w: 596.5, h: 841.89 }, target) === true
  );
  check(
    "exact match -> kept",
    pageNeedsChange({ w: 595.28, h: 841.89 }, target) === false
  );
}

/* ------------------------------------------------------------------ */
/* 5. resizeScale                                                       */
/* ------------------------------------------------------------------ */
{
  console.log("5. resizeScale");
  const target = { w: 595.28, h: 841.89 };
  const letter = { w: 612, h: 792 };
  check(
    "fit picks the min ratio",
    near(resizeScale("fit", target, letter), 0.97268, 0.0005),
    resizeScale("fit", target, letter).toFixed(5)
  );
  check(
    "fill picks the max ratio",
    near(resizeScale("fill", target, letter), 1.06301, 0.0005),
    resizeScale("fill", target, letter).toFixed(5)
  );
  check("none keeps 1", resizeScale("none", target, letter) === 1);
}

/* ------------------------------------------------------------------ */
/* 6. resizePlacement                                                   */
/* ------------------------------------------------------------------ */
{
  console.log("6. resizePlacement");
  const a4 = { w: 595.28, h: 841.89 };

  const fit = resizePlacement(a4, 612, 792, 0, "fit");
  check(
    "rot0 fit: centered, width-limited",
    near(fit.x, 0) &&
      near(fit.y, 35.76) &&
      near(fit.width, 595.28) &&
      near(fit.height, 770.36) &&
      fit.rotate === 0 &&
      near(fit.scale, 0.97268, 0.0005),
    `x=${fit.x.toFixed(2)} y=${fit.y.toFixed(2)}`
  );

  const fill = resizePlacement(a4, 612, 792, 0, "fill");
  check(
    "rot0 fill: negative visX (both edges crop), full height",
    near(fill.x, -27.64) &&
      near(fill.y, 0) &&
      near(fill.visW, 650.56) &&
      near(fill.visH, 841.89) &&
      near(fill.scale, 1.06301, 0.0005),
    `x=${fill.x.toFixed(2)}`
  );

  const none = resizePlacement(a4, 612, 792, 0, "none");
  check(
    "rot0 none: 1:1 centered (wider than page -> clipped sides)",
    near(none.x, -8.36) && near(none.y, 24.94) && none.scale === 1,
    `x=${none.x.toFixed(2)} y=${none.y.toFixed(2)}`
  );

  // /Rotate 90: A4 landscape content onto Letter landscape, fit.
  const r90 = resizePlacement({ w: 792, h: 612 }, 595.28, 841.89, 90, "fit");
  check(
    "rot90: anchor top-left, draw 270, swapped vis dims",
    near(r90.x, 0) &&
      near(r90.y, 586.01) &&
      near(r90.width, 560.02) &&
      near(r90.height, 792.0) &&
      r90.rotate === 270 &&
      near(r90.visW, 792.0) &&
      near(r90.visH, 560.02),
    `x=${r90.x.toFixed(2)} y=${r90.y.toFixed(2)} w=${r90.width.toFixed(1)}`
  );

  const r180 = resizePlacement(a4, 300, 400, 180, "none");
  check(
    "rot180: anchor top-right, draw 180",
    near(r180.x, 447.64) &&
      near(r180.y, 620.95) &&
      r180.rotate === 180 &&
      r180.scale === 1,
    `x=${r180.x.toFixed(2)} y=${r180.y.toFixed(2)}`
  );

  const r270 = resizePlacement(a4, 300, 400, 270, "fit");
  check(
    "rot270: anchor bottom-right, draw 90",
    near(r270.x, 595.28) &&
      near(r270.y, 197.71) &&
      r270.rotate === 90 &&
      near(r270.visW, 595.28) &&
      near(r270.visH, 446.46),
    `x=${r270.x.toFixed(2)} y=${r270.y.toFixed(2)}`
  );

  // The visible box must always land centered in the target for fit.
  const centered = resizePlacement({ w: 500, h: 400 }, 300, 700, 90, "fit");
  // effW=700 effH=300 -> scale min(500/700, 400/300)=0.7143; vis 500x214.29.
  check(
    "rot90 fit: vis box centered on target",
    near(centered.visX, 0) &&
      near(centered.visY, 92.857) &&
      near(centered.visW, 500) &&
      near(centered.visH, 214.286) &&
      near(centered.x, 0) &&
      near(centered.y, 307.143) &&
      centered.rotate === 270
  );
}

/* ------------------------------------------------------------------ */
/* 7. inventory + report                                                */
/* ------------------------------------------------------------------ */
{
  console.log("7. buildSizeInventory + buildPageSizeReport");
  const rows = buildSizeInventory([
    { w: 595.28, h: 841.89 },
    { w: 841.89, h: 595.28 }, // same page, landscape — ONE bucket
    { w: 612, h: 792 },
    { w: 595.28, h: 841.89 },
  ]);
  check(
    "A4-portrait + A4-landscape collapse into one row of 3",
    rows.length === 2 &&
      rows[0].count === 3 &&
      rows[0].label === "A4 · 210 × 297 mm" &&
      rows[1].count === 1,
    `${rows.map((r) => `${r.label} x${r.count}`).join(" | ")}`
  );

  const report = buildPageSizeReport(
    { ...PGSZ_DEFAULTS, size: "a4" },
    [
      { page: 1, fromW: 595, fromH: 842, toW: 595, toH: 842, method: "kept-size", scale: 1 },
      { page: 2, fromW: 612, fromH: 792, toW: 595, toH: 842, method: "resized", scale: 0.97 },
      { page: 3, fromW: 300, fromH: 400, toW: 300, toH: 400, method: "kept-unselected", scale: 1 },
    ],
    "doc.pdf"
  );
  check(
    "report: summary line counts methods",
    report.includes("Pages: 3 (1 resized, 1 already correct, 1 not selected)"),
    report.split("\n")[5]
  );
  check(
    "report: target + orientation + scale present",
    report.includes("Target: A4") &&
      report.includes("Orientation: auto") &&
      report.includes("Scale: fit")
  );
}

/* ------------------------------------------------------------------ */
/* 8. REAL E2E                                                          */
/* ------------------------------------------------------------------ */

/** Renders one PDF page at ~1.2 scale via pdf.js onto an @napi-rs canvas. */
async function renderPage(
  bytes: Uint8Array,
  pageIndex: number
): Promise<Canvas> {
  const doc = await getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
    standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  }).promise;
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1.2 });
  const canvas = createCanvas(
    Math.max(1, Math.round(viewport.width)),
    Math.max(1, Math.round(viewport.height))
  );
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    // @napi-rs context is runtime-compatible; pdf.js types disagree.
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;
  page.cleanup();
  await doc.destroy();
  return canvas;
}

function px(
  canvas: Canvas,
  xFrac: number,
  yFracTop: number
): [number, number, number] {
  const ctx = canvas.getContext("2d");
  const data = ctx
    .getImageData(
      Math.min(canvas.width - 1, Math.round(xFrac * canvas.width)),
      Math.min(canvas.height - 1, Math.round(yFracTop * canvas.height)),
      1,
      1
    )
    .data;
  return [data[0], data[1], data[2]];
}

function isDark(c: [number, number, number]): boolean {
  return c[0] < 90 && c[1] < 90 && c[2] < 90;
}

function isLight(c: [number, number, number]): boolean {
  return c[0] > 235 && c[1] > 235 && c[2] > 235;
}

async function pageSizeOf(
  bytes: Uint8Array,
  pageIndex: number
): Promise<{ w: number; h: number }> {
  const doc = await getDocument({
    data: bytes.slice(),
    verbosity: 0,
    standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  }).promise;
  const page = await doc.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale: 1 });
  page.cleanup();
  await doc.destroy();
  return { w: vp.width, h: vp.height };
}

async function textOf(
  bytes: Uint8Array,
  pageIndex: number
): Promise<string> {
  const doc = await getDocument({
    data: bytes.slice(),
    verbosity: 0,
    standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  }).promise;
  const page = await doc.getPage(pageIndex + 1);
  const content = await page.getTextContent();
  page.cleanup();
  await doc.destroy();
  return content.items.map((i) => ("str" in i ? i.str : "")).join(" ");
}

async function annotCount(
  bytes: Uint8Array,
  pageIndex: number
): Promise<number> {
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const annots = doc.getPage(pageIndex).node.Annots();
  return annots === undefined ? 0 : annots.size();
}

const FIXTURE = new Uint8Array(readFileSync("public/qa/qa-pagesize.pdf"));
const FIXTURE_A4 = new Uint8Array(
  readFileSync("public/qa/qa-pagesize-a4.pdf")
);

async function run(
  opts: Partial<Record<string, string | number>> = {}
): Promise<{
  bytes: Uint8Array;
  report: string;
  resized: number;
}> {
  return runPageSize(
    FIXTURE,
    "qa-pagesize.pdf",
    {
      size: opts.size ?? "a4",
      customW: opts.customW ?? 210,
      customH: opts.customH ?? 297,
      orientation: opts.orientation ?? "auto",
      scale: opts.scale ?? "fit",
      pages: opts.pages ?? "all",
    },
    () => undefined
  );
}

{
  console.log("8. REAL E2E — mixed fixture");

  /* ---------- A: A4, auto orientation, fit (the default run) ---------- */
  const outA = await run({});
  check(
    "A: 5 pages out",
    (await pageSizeOf(outA.bytes, 4)).w > 0 && (await annotCount(outA.bytes, 0)) >= 0
  );
  const a1 = await pageSizeOf(outA.bytes, 0);
  check("A: p1 stays A4 portrait (kept)", near(a1.w, 595.28, 0.6) && near(a1.h, 841.89, 0.6));
  const a2 = await pageSizeOf(outA.bytes, 1);
  check("A: p2 Letter -> A4 (resized)", near(a2.w, 595.28, 0.6) && near(a2.h, 841.89, 0.6));
  const a3 = await pageSizeOf(outA.bytes, 2);
  check(
    "A: p3 kept as A4 landscape display (/Rotate 90 intact)",
    near(a3.w, 841.89, 0.6) && near(a3.h, 595.28, 0.6)
  );
  const a4 = await pageSizeOf(outA.bytes, 3);
  check("A: p4 custom -> A4 portrait", near(a4.w, 595.28, 0.6) && near(a4.h, 841.89, 0.6));
  const a5 = await pageSizeOf(outA.bytes, 4);
  check("A: p5 A5 -> A4 (resized)", near(a5.w, 595.28, 0.6) && near(a5.h, 841.89, 0.6));
  check(
    "A: report says 3 resized / 2 already correct",
    outA.report.includes("Pages: 5 (3 resized, 2 already correct)") &&
      outA.resized === 3,
    outA.report.split("\n")[5]
  );

  check(
    "A: p1 link annotation SURVIVES (kept page copied)",
    (await annotCount(outA.bytes, 0)) === 1
  );
  check(
    "A: p2 (resized) annotation honestly dropped",
    (await annotCount(outA.bytes, 1)) === 0
  );

  const textA2 = await textOf(outA.bytes, 1);
  check(
    "A: p2 text still selectable (vector)",
    textA2.includes("PAGE TWO - LETTER"),
    textA2.slice(0, 40)
  );
  const textA4 = await textOf(outA.bytes, 3);
  check("A: p4 text selectable", textA4.includes("PAGE FOUR - SMALL"));

  // fit differential point: canvas (0.9374, 0.5534) — dark in fit.
  const fitP2 = await renderPage(outA.bytes, 1);
  check(
    "A: fit keeps the straddling square edge visible (dark)",
    isDark(px(fitP2, 0.9374, 0.5534)),
    `rgb(${px(fitP2, 0.9374, 0.5534)})`
  );
  check(
    "A: fit leaves a white top margin (band pushed down)",
    isLight(px(fitP2, 0.5, 0.02)),
    `rgb(${px(fitP2, 0.5, 0.02)})`
  );

  /* ---------- B: fill mode on the same page ------------------------- */
  const outB = await run({ scale: "fill" });
  const fillP2 = await renderPage(outB.bytes, 1);
  check(
    "B: fill crops the square's far edge (same point now white)",
    isLight(px(fillP2, 0.9374, 0.5534)),
    `rgb(${px(fillP2, 0.9374, 0.5534)})`
  );
  check(
    "B: fill covers the top edge (band reaches the edge)",
    isDark(px(fillP2, 0.5, 0.02)),
    `rgb(${px(fillP2, 0.5, 0.02)})`
  );

  /* ---------- C: none mode on the small page ------------------------- */
  const outC = await run({ scale: "none" });
  const noneP4 = await renderPage(outC.bytes, 3);
  check(
    "C: none keeps content 1:1 centered (square dark at center)",
    isDark(px(noneP4, 0.5, 0.5)),
    `rgb(${px(noneP4, 0.5, 0.5)})`
  );
  check(
    "C: none leaves big white margins (corner light)",
    isLight(px(noneP4, 0.05, 0.95)),
    `rgb(${px(noneP4, 0.05, 0.95)})`
  );

  /* ---------- D: Letter target exercises the rotation path ----------- */
  const outD = await run({ size: "letter" });
  const d3 = await pageSizeOf(outD.bytes, 2);
  check(
    "D: p3 rotated content resized onto Letter landscape",
    near(d3.w, 792, 0.6) && near(d3.h, 612, 0.6),
    `${d3.w.toFixed(1)}x${d3.h.toFixed(1)}`
  );
  const textD3 = await textOf(outD.bytes, 2);
  check(
    "D: rotated page text still extracts",
    textD3.includes("PAGE THREE ROTATED"),
    textD3.slice(0, 40)
  );
  const d3Canvas = await renderPage(outD.bytes, 2);
  check(
    "D: rotated square lands top-left (dark there)",
    isDark(px(d3Canvas, 0.09, 0.11)),
    `rgb(${px(d3Canvas, 0.09, 0.11)})`
  );
  check(
    "D: bottom-right of the rotated page is clean",
    isLight(px(d3Canvas, 0.9, 0.9)),
    `rgb(${px(d3Canvas, 0.9, 0.9)})`
  );

  /* ---------- E: fast path — all pages already correct --------------- */
  const fast = await runPageSize(FIXTURE_A4, "qa-pagesize-a4.pdf", {}, () =>
    undefined
  );
  check(
    "E: fast path returns the ORIGINAL bytes",
    fast.bytes.length === FIXTURE_A4.length &&
      fast.bytes.every((b, i) => b === FIXTURE_A4[i]),
    `${fast.bytes.length} B`
  );
  check(
    "E: fast-path report is honest",
    fast.report.includes("(0 resized, 3 already correct)") && fast.resized === 0
  );

  /* ---------- F: page targeting -------------------------------------- */
  const outF = await run({ pages: "2" });
  const f2 = await pageSizeOf(outF.bytes, 1);
  check("F: selected p2 resized to A4", near(f2.w, 595.28, 0.6) && near(f2.h, 841.89, 0.6));
  const f4 = await pageSizeOf(outF.bytes, 3);
  check(
    "F: unselected p4 keeps its custom 300x400",
    near(f4.w, 300, 0.6) && near(f4.h, 400, 0.6),
    `${f4.w.toFixed(1)}x${f4.h.toFixed(1)}`
  );
  const f5 = await pageSizeOf(outF.bytes, 4);
  check(
    "F: unselected p5 keeps A5",
    near(f5.w, 419.53, 0.6) && near(f5.h, 595.28, 0.6)
  );
  check(
    "F: report separates 'not selected'",
    outF.report.includes("(1 resized, 0 already correct, 4 not selected)"),
    outF.report.split("\n")[5]
  );

  /* ---------- G: custom mm target ------------------------------------- */
  const outG = await run({ size: "custom", customW: 200, customH: 280 });
  const g2 = await pageSizeOf(outG.bytes, 1);
  const wantW = 200 * (72 / 25.4);
  const wantH = 280 * (72 / 25.4);
  check(
    "G: custom mm target lands exactly",
    near(g2.w, wantW, 0.6) && near(g2.h, wantH, 0.6),
    `${g2.w.toFixed(1)}x${g2.h.toFixed(1)} vs ${wantW.toFixed(1)}x${wantH.toFixed(1)}`
  );

  /* ---------- H: invalid page spec ------------------------------------- */
  let threw = "";
  try {
    await runPageSize(FIXTURE, "x.pdf", { pages: "abc" }, () => undefined);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  check("H: invalid range errors cleanly", threw === "tool.errorInvalidPages", threw);
}

/* ------------------------------------------------------------------ */

console.log(
  `\n${pass} passed, ${fail} failed${fail === 0 ? " — ALL GREEN" : ""}`
);
if (fail > 0) {
  process.exit(1);
}
