/**
 * PRE-BUILD smoke test for Overlay PDF (P4.9, PRD §8.3).
 * Locks the engine + the real pdf-lib embed path BEFORE browser QA:
 *
 *  1. resolveOverlayOptions: defaults + clamps + garbage tolerance.
 *  2. stampTargets: all / first / odd / even / range (valid + invalid).
 *  3. overlayPageFor: first / match / cycle + short overlay + zero pages.
 *  4. overlayBox + overlayPlacement: aspect math, 9-grid centers, corners,
 *     rotation start points (pdf-lib rotate-around-origin semantics).
 *  5. stampedCount: mapping-aware counting.
 *  6. classifyOverlayError: password vs corrupt vs no-pages.
 *  7. REAL E2E (bun + pdf-lib + pdf.js + @napi-rs/canvas): the two QA
 *     fixtures through the EXACT worker logic (embedPdf + drawPage +
 *     behind-content reorder), rendered and pixel-sampled:
 *       - over-content: red band covers base text zone (tinted red),
 *         base text still visible through the 0.45-alpha band;
 *       - opacity slider: half-opacity output is lighter than full;
 *       - behind-content: the base center square stays fully dark;
 *       - corner + scale: br 30% keeps the top-left region pristine;
 *       - match source: base p3 stays untouched; cycle: p3 gets page 1;
 *       - text extraction still finds the base words (vector, no raster);
 *       - page counts unchanged.
 *
 * Run: bun scripts/smoke-overlay.ts   (exit code = failures)
 */
import { readFileSync } from "node:fs";
import type { Canvas } from "@napi-rs/canvas";
import { createCanvas } from "@napi-rs/canvas";
import "regenerator-runtime/runtime";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument } from "pdf-lib";

import {
  OV_DEFAULTS,
  classifyOverlayError,
  overlayBox,
  overlayPageFor,
  overlayPlacement,
  resolveOverlayOptions,
  stampedCount,
  stampTargets,
} from "../tools/overlay-pdf/engine";
import { overlayPdfs } from "../tools/overlay-pdf/worker-lib";

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
/* 1. resolveOverlayOptions                                            */
/* ------------------------------------------------------------------ */
{
  console.log("1. resolveOverlayOptions");
  const d = resolveOverlayOptions({});
  check(
    "defaults: mc/24/100%/1/0deg/front/all/first",
    d.position === "mc" &&
      d.margin === 24 &&
      d.scale === 100 &&
      d.opacity === 1 &&
      d.rotation === 0 &&
      d.behind === false &&
      d.stampPages === "all" &&
      d.pages === "all" &&
      d.source === "first"
  );
  const full = resolveOverlayOptions({
    position: "br",
    margin: 40,
    scale: 55,
    opacity: 0.5,
    rotation: -30,
    behind: true,
    stampPages: "odd",
    pages: "1-3",
    source: "cycle",
  });
  check(
    "all fields honored",
    full.position === "br" &&
      full.margin === 40 &&
      full.scale === 55 &&
      full.opacity === 0.5 &&
      full.rotation === -30 &&
      full.behind === true &&
      full.stampPages === "odd" &&
      full.pages === "1-3" &&
      full.source === "cycle"
  );
  const garbage = resolveOverlayOptions({
    position: "zz",
    margin: 999,
    scale: 5,
    opacity: 0,
    rotation: 400,
    stampPages: "nope",
    source: "nope",
  });
  check(
    "garbage falls back to defaults + clamps",
    garbage.position === OV_DEFAULTS.position &&
      garbage.margin === 96 &&
      garbage.scale === 10 &&
      garbage.opacity === 0.05 &&
      garbage.rotation === 90 &&
      garbage.stampPages === OV_DEFAULTS.stampPages &&
      garbage.source === OV_DEFAULTS.source
  );
}

/* ------------------------------------------------------------------ */
/* 2. stampTargets                                                     */
/* ------------------------------------------------------------------ */
{
  console.log("2. stampTargets");
  const all = stampTargets({ stampPages: "all", pages: "all" }, 3);
  check("all → [0,1,2]", JSON.stringify(all) === "[0,1,2]");
  const first = stampTargets({ stampPages: "first", pages: "all" }, 3);
  check("first → [0]", JSON.stringify(first) === "[0]");
  const firstEmpty = stampTargets({ stampPages: "first", pages: "all" }, 0);
  check("first on empty doc → []", firstEmpty !== null && firstEmpty.length === 0);
  const odd = stampTargets({ stampPages: "odd", pages: "all" }, 4);
  check("odd → [0,2] (1-based odd)", JSON.stringify(odd) === "[0,2]");
  const even = stampTargets({ stampPages: "even", pages: "all" }, 4);
  check("even → [1,3] (1-based even)", JSON.stringify(even) === "[1,3]");
  const range = stampTargets({ stampPages: "range", pages: "2,4" }, 5);
  check("range '2,4' → [1,3]", JSON.stringify(range) === "[1,3]");
  const bad = stampTargets({ stampPages: "range", pages: "abc" }, 5);
  check("invalid range → null", bad === null);
  const empty = stampTargets({ stampPages: "range", pages: "" }, 5);
  check("empty range falls back to all", JSON.stringify(empty) === "[0,1,2,3,4]");
}

/* ------------------------------------------------------------------ */
/* 3. overlayPageFor                                                    */
/* ------------------------------------------------------------------ */
{
  console.log("3. overlayPageFor");
  check("first → 0 always", overlayPageFor("first", 7, 2) === 0);
  check("match within → same index", overlayPageFor("match", 1, 2) === 1);
  check("match beyond → null", overlayPageFor("match", 2, 2) === null);
  check("cycle wraps", overlayPageFor("cycle", 3, 2) === 1);
  check("cycle 2 mod 2 → 0", overlayPageFor("cycle", 2, 2) === 0);
  check("zero overlay pages → null", overlayPageFor("first", 0, 0) === null);
}

/* ------------------------------------------------------------------ */
/* 4. overlayBox + overlayPlacement                                     */
/* ------------------------------------------------------------------ */
{
  console.log("4. overlayBox + overlayPlacement");
  const box = overlayBox(600, 800, 300, 500, 50);
  check(
    "box: 50% width, aspect kept",
    Math.abs(box.boxW - 300) < 1e-9 && Math.abs(box.boxH - 500) < 1e-9,
    `${box.boxW}×${box.boxH}`
  );
  const box2 = overlayBox(600, 800, 500, 250, 100);
  check(
    "landscape overlay keeps aspect",
    Math.abs(box2.boxW - 600) < 1e-9 && Math.abs(box2.boxH - 300) < 1e-9,
    `${box2.boxW}×${box2.boxH}`
  );

  // mc, full-page overlay: center = page center.
  const mc = overlayPlacement(600, 800, 600, 800, {
    position: "mc",
    margin: 24,
    scale: 100,
    rotation: 0,
  });
  check(
    "mc full-size → exact page center",
    Math.abs(mc.cx - 300) < 1e-9 && Math.abs(mc.cy - 400) < 1e-9
  );
  check(
    "mc rotation 0 → start = center − half",
    Math.abs(mc.sx - 0) < 1e-9 && Math.abs(mc.sy - 0) < 1e-9,
    `(${mc.sx}, ${mc.sy})`
  );

  // br corner with margin: box bottom-right inside the margin.
  const br = overlayPlacement(600, 800, 200, 100, {
    position: "br",
    margin: 24,
    scale: 100 / 3,
    rotation: 0,
  });
  check(
    "br: box center 24pt from both edges",
    Math.abs(br.cx - (600 - 24 - 100)) < 1e-9 &&
      Math.abs(br.cy - 24 - 50) < 1e-9,
    `(${br.cx}, ${br.cy})`
  );

  // Rotation 90: the start point moves so the rotated box is centered.
  const rot = overlayPlacement(600, 800, 200, 100, {
    position: "mc",
    margin: 0,
    scale: 100 / 3,
    rotation: 90,
  });
  // After a 90° rotation around (sx, sy), the box center must still land
  // at (300, 400): center' = start + R(90°)·(w/2, h/2).
  const rad = (90 * Math.PI) / 180;
  const cx2 = rot.sx + Math.cos(rad) * 100 - Math.sin(rad) * 50;
  const cy2 = rot.sy + Math.sin(rad) * 100 + Math.cos(rad) * 50;
  check(
    "rotation 90 keeps the box centered",
    Math.abs(cx2 - 300) < 1e-6 && Math.abs(cy2 - 400) < 1e-6,
    `center' = (${cx2.toFixed(2)}, ${cy2.toFixed(2)})`
  );

  // A big box with a big margin clamps the effective margin (wm math).
  const clampCase = overlayPlacement(200, 200, 400, 400, {
    position: "mc",
    margin: 96,
    scale: 100,
    rotation: 0,
  });
  check(
    "oversized box clamps into the page",
    clampCase.cx >= 0 && clampCase.cx <= 200 && clampCase.cy >= 0 && clampCase.cy <= 200,
    `center (${clampCase.cx.toFixed(1)}, ${clampCase.cy.toFixed(1)})`
  );
}

/* ------------------------------------------------------------------ */
/* 5. stampedCount                                                      */
/* ------------------------------------------------------------------ */
{
  console.log("5. stampedCount");
  check(
    "all×first on 3×2 → 3",
    stampedCount({ stampPages: "all", pages: "all", source: "first" }, 3, 2) === 3
  );
  check(
    "all×match on 3×2 → 2",
    stampedCount({ stampPages: "all", pages: "all", source: "match" }, 3, 2) === 2
  );
  check(
    "all×cycle on 3×2 → 3",
    stampedCount({ stampPages: "all", pages: "all", source: "cycle" }, 3, 2) === 3
  );
  check(
    "even×match on 3×2 → 1 (only page 2)",
    stampedCount({ stampPages: "even", pages: "all", source: "match" }, 3, 2) === 1
  );
  check(
    "invalid range → null",
    stampedCount({ stampPages: "range", pages: "x", source: "first" }, 3, 2) === null
  );
}

/* ------------------------------------------------------------------ */
/* 6. classifyOverlayError                                              */
/* ------------------------------------------------------------------ */
{
  console.log("6. classifyOverlayError");
  check("password → encrypted", classifyOverlayError("Input to PDFDocument.load is encrypted with a password") === "tool.errorEncrypted");
  check("corrupt → corrupt", classifyOverlayError("Failed to parse binary junk") === "tool.errorCorrupt");
  check("no pages → no-pages", classifyOverlayError("The PDF has no pages") === "overlay.errorNoPages");
}

/* ------------------------------------------------------------------ */
/* 7. REAL E2E — the exact worker pipeline, rendered + pixel-sampled     */
/* ------------------------------------------------------------------ */

/** The shipped pipeline (worker-lib.overlayPdfs), driven with fixtures. */
async function runOverlay(
  baseBytes: Uint8Array,
  topBytes: Uint8Array,
  opts: ReturnType<typeof resolveOverlayOptions>
): Promise<Uint8Array> {
  const baseDoc = await PDFDocument.load(baseBytes, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const topDoc = await PDFDocument.load(topBytes, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const stamped = await overlayPdfs(baseDoc, topDoc, opts, () => undefined);
  if (stamped === 0) throw new Error("overlay: no page match");
  return baseDoc.save({ useObjectStreams: true });
}

/** Renders one PDF page at ~1.2 scale via pdf.js onto an @napi-rs canvas. */
async function renderPage(
  bytes: Uint8Array,
  pageIndex: number
): Promise<Canvas> {
  const doc = await getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    useSystemFonts: true,
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

function px(canvas: Canvas, xFrac: number, yFracTop: number): [number, number, number] {
  const ctx = canvas.getContext("2d");
  const data = ctx.getImageData(
    Math.min(canvas.width - 1, Math.round(xFrac * canvas.width)),
    Math.min(canvas.height - 1, Math.round(yFracTop * canvas.height)),
    1,
    1
  ).data;
  return [data[0], data[1], data[2]];
}

function isRed(c: [number, number, number]): boolean {
  // The fixture band is a 0.45-alpha tint over white → (244,158,158)-ish.
  return c[0] > 200 && c[0] - c[1] > 60 && c[0] - c[2] > 60;
}
function isGreenish(c: [number, number, number]): boolean {
  return c[1] > 130 && c[1] > c[0] + 20 && c[1] > c[2] + 20;
}
function isDark(c: [number, number, number]): boolean {
  return c[0] < 110 && c[1] < 110 && c[2] < 110;
}
function isLight(c: [number, number, number]): boolean {
  return c[0] > 235 && c[1] > 235 && c[2] > 235;
}

async function main(): Promise<void> {
  console.log("7. REAL E2E (fixtures through the worker pipeline)");
  const baseBytes = new Uint8Array(
    readFileSync("public/qa/qa-overlay-base.pdf")
  );
  const topBytes = new Uint8Array(
    readFileSync("public/qa/qa-overlay-top.pdf")
  );

  // --- Baseline renders ---------------------------------------------
  const baseP1 = await renderPage(baseBytes, 0);
  const topP1 = await renderPage(topBytes, 0);

  // Sanity: fixtures render as designed.
  const baseCenter = px(baseP1, 0.5, 0.5);
  check("fixture: base center square is dark", isDark(baseCenter), `rgb(${baseCenter})`);
  const baseMidBand = px(baseP1, 0.3, 0.445);
  check("fixture: base band zone starts light", isLight(baseMidBand), `rgb(${baseMidBand})`);
  const topBand = px(topP1, 0.3, 0.445);
  check("fixture: overlay band is red", isRed(topBand), `rgb(${topBand})`);

  // --- Case A: default (first page, all base pages, over content) ----
  const outA = await runOverlay(baseBytes, topBytes, resolveOverlayOptions({}));
  const docA = await PDFDocument.load(outA);
  check("A: page count unchanged (3)", docA.getPageCount() === 3);
  const aP1 = await renderPage(outA, 0);
  // Band spans y-top 0.42..0.58 (x 0.067..0.933); 0.445 dodges the
  // "OVERLAY PAGE ONE" glyphs whose tops sit at y-top ≈ 0.484.
  const aBand = px(aP1, 0.3, 0.445);
  check(
    "A: red band covers the base band zone",
    aBand[0] > 180 && aBand[0] - aBand[1] > 25 && aBand[1] < 200,
    `rgb(${aBand})`
  );
  const aWhite = px(aP1, 0.3, 0.2);
  check("A: untouched top zone stays light", isLight(aWhite), `rgb(${aWhite})`);

  // Vector check: BOTH layers' text is selectable — real PDF layering.
  const textA = await (async () => {
    const doc = await getDocument({ data: outA.slice() }).promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    await doc.destroy();
    return content.items.map((i) => ("str" in i ? i.str : "")).join(" ");
  })();
  check(
    "A: base AND overlay text selectable (vector layering)",
    textA.includes("BASE DOCUMENT — PAGE 1") && textA.includes("OVERLAY PAGE ONE"),
    textA.slice(0, 60)
  );

  // --- Case B: behind content ---------------------------------------
  const outB = await runOverlay(
    baseBytes,
    topBytes,
    resolveOverlayOptions({ behind: true })
  );
  const bP1 = await renderPage(outB, 0);
  const bCenter = px(bP1, 0.5, 0.5);
  check(
    "B: behind-content keeps the base square dark (overlay under it)",
    isDark(bCenter),
    `rgb(${bCenter})`
  );
  const bBand = px(bP1, 0.3, 0.445);
  check(
    "B: red band still visible where no base content",
    bBand[0] > 180 && bBand[0] - bBand[1] > 25,
    `rgb(${bBand})`
  );

  // --- Case C: opacity 0.5 -------------------------------------------
  const outC = await runOverlay(
    baseBytes,
    topBytes,
    resolveOverlayOptions({ opacity: 0.5 })
  );
  const cP1 = await renderPage(outC, 0);
  const cBand = px(cP1, 0.3, 0.445);
  // Effective band alpha 0.45×0.5 = 0.225 → the tint is lighter but tinted.
  check(
    "C: half-opacity band is lighter than full",
    cBand[1] > aBand[1] + 20 && cBand[0] > 200 && cBand[0] - cBand[1] > 20,
    `full rgb(${aBand}) vs half rgb(${cBand})`
  );

  // --- Case C2: strokes dim too (the CA patch) ------------------------
  const outC2 = await runOverlay(
    baseBytes,
    topBytes,
    resolveOverlayOptions({ opacity: 0.5, source: "cycle" })
  );
  const c2P2 = await renderPage(outC2, 1);
  // Base p2 ← top p2 (green stamp, full-page draw). The border stroke is
  // centered on the box edge at x = 178.6pt → ×1.2 = 214px (714px canvas)
  // → fraction 0.298 — safely inside the 3pt stroke. Opaque green
  // (13,140,64) at 0.5 → ~(134,198,160).
  const c2Border = px(c2P2, 0.298, 0.5);
  check(
    "C2: stroke content dims too (stamp border at half opacity)",
    c2Border[1] > 130 && c2Border[1] < 215 && c2Border[1] > c2Border[0] + 25,
    `rgb(${c2Border})`
  );

  // --- Case D: br corner, 30% scale, cycle source --------------------
  const outD = await runOverlay(
    baseBytes,
    topBytes,
    resolveOverlayOptions({
      position: "br",
      scale: 30,
      source: "cycle",
    })
  );
  const dP3 = await renderPage(outD, 2);
  // base p3 (index 2), cycle 2%2=0 → top p1 scaled to 30% width in the br
  // corner (margin 24): its band occupies x-fraction 0.68..0.94,
  // y-top 0.80..0.845 — sample the band center.
  const dCorner = px(dP3, 0.81, 0.82);
  check(
    "D: cycle puts the red band in the br corner at 30%",
    dCorner[0] > 150 && dCorner[0] - dCorner[1] > 25,
    `rgb(${dCorner})`
  );
  const dTopLeft = px(dP3, 0.15, 0.15);
  check("D: top-left stays pristine light", isLight(dTopLeft), `rgb(${dTopLeft})`);

  // --- Case E: match source skips unmatched pages ---------------------
  const outE = await runOverlay(
    baseBytes,
    topBytes,
    resolveOverlayOptions({ source: "match" })
  );
  const eP3 = await renderPage(outE, 2);
  const eMid = px(eP3, 0.3, 0.445);
  const eCenter = px(eP3, 0.5, 0.5);
  check(
    "E: match leaves base p3 untouched",
    isLight(eMid) && isDark(eCenter),
    `band rgb(${eMid}), center rgb(${eCenter})`
  );
  const eP2 = await renderPage(outE, 1);
  const eP2Band = px(eP2, 0.5, 0.5);
  // match → base p2 gets top p2 (the green stamp), centered: greenish-ish
  // region near center. The stamp box interior is light green.
  check(
    "E: base p2 gets the top p2 stamp (center no longer the bare square)",
    !isDark(eP2Band) || isGreenish(eP2Band),
    `rgb(${eP2Band})`
  );
  const textE = await (async () => {
    const doc = await getDocument({ data: outE.slice() }).promise;
    const page = await doc.getPage(3);
    const content = await page.getTextContent();
    await doc.destroy();
    return content.items.map((i) => ("str" in i ? i.str : "")).join(" ");
  })();
  check(
    "E: untouched p3 has no overlay text",
    !textE.includes("OVERLAY PAGE"),
    textE.slice(0, 40)
  );

  // --- Case F: odd selector -------------------------------------------
  const outF = await runOverlay(
    baseBytes,
    topBytes,
    resolveOverlayOptions({ stampPages: "odd" })
  );
  const fP2 = await renderPage(outF, 1);
  const fP2Mid = px(fP2, 0.3, 0.445);
  check("F: odd pages only — p2 untouched", isLight(fP2Mid), `rgb(${fP2Mid})`);

  // --- Case G: honest-refusal paths -----------------------------------
  const beyondMatch = stampedCount(
    { stampPages: "range", pages: "3", source: "match" },
    3,
    2
  );
  check(
    "G: match beyond the overlay selects nothing (0)",
    beyondMatch === 0
  );
  check(
    "G: out-of-range spec is invalid (null)",
    stampedCount({ stampPages: "range", pages: "9", source: "match" }, 3, 2) === null
  );

  // --- Case H: rotation 90 on the stamp --------------------------------
  const outH = await runOverlay(
    baseBytes,
    topBytes,
    resolveOverlayOptions({ source: "cycle", rotation: 90 })
  );
  const hP2 = await renderPage(outH, 1);
  // base p2 (index 1), cycle → top p2 (green stamp) rotated 90°, still
  // centered: sample near the center for the stamp's presence.
  const hCenter = px(hP2, 0.5, 0.5);
  check(
    "H: rotated stamp still lands centered (not black square)",
    !isDark(hCenter) || isGreenish(hCenter),
    `rgb(${hCenter})`
  );
}

await main();

/* ------------------------------------------------------------------ */
/* 8. R6-b named refusals — the REAL worker, encrypted/corrupt inputs  */
/* ------------------------------------------------------------------ */
console.log("\n8. REAL worker: locked/corrupt refusals NAME the file");
{
  const workerGlobal = globalThis as unknown as {
    postMessage: (msg: unknown) => void;
    onmessage: ((event: { data: unknown }) => void) | null;
  };
  const inbox: { type: string; code?: string; detail?: string; runId?: number }[] = [];
  workerGlobal.postMessage = (msg: unknown): void => {
    inbox.push(msg as { type: string });
  };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
  await import("../tools/overlay-pdf/worker");
  check("worker module self-registers onmessage", typeof workerGlobal.onmessage === "function");

  const makeEncrypted = async (): Promise<Uint8Array> => {
    const { PDFDocument: CantooDoc } = await import("@cantoo/pdf-lib");
    const doc = await CantooDoc.create();
    doc.addPage([300, 300]);
    doc.encrypt({ userPassword: "secret", algorithm: "AES-256" });
    return doc.save({ useObjectStreams: false });
  };

  const drive = async (
    runId: number,
    files: File[]
  ): Promise<typeof inbox> => {
    const before = inbox.length;
    workerGlobal.onmessage!({
      data: {
        type: "run",
        runId,
        toolId: "overlay-pdf",
        options: {},
        files,
      },
    });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const terminal = inbox
        .slice(before)
        .some((m) => m.type === "result" || m.type === "error");
      if (terminal) return inbox.slice(before);
      if (Date.now() > deadline) throw new Error(`run ${runId} did not finish`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  // Fixtures need REAL page content: pdf-lib embeds overlay pages at save
  // time and refuses pages with no /Contents ("Can't embed page with
  // missing Contents") — content-free synthetic pages would fail the run.
  const fineBase = await PDFDocument.create();
  const basePage = fineBase.addPage([300, 400]);
  basePage.drawRectangle({ x: 10, y: 10, width: 100, height: 40 });
  const baseBytes = new Uint8Array(await fineBase.save({ useObjectStreams: false }));
  const fineTop = await PDFDocument.create();
  const topPage = fineTop.addPage([300, 400]);
  topPage.drawRectangle({ x: 20, y: 20, width: 120, height: 60 });
  const topBytes = new Uint8Array(await fineTop.save({ useObjectStreams: false }));
  const encBytes = await makeEncrypted();
  const garbage = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x9, 0x9, 0x9]);

  // --- locked BASE names the base file ---------------------------------
  {
    const msgs = await drive(
      8101,
      [
        new File([encBytes as BlobPart], "report.pdf"),
        new File([topBytes as BlobPart], "stamp.pdf"),
      ]
    );
    const errors = msgs.filter((m) => m.type === "error");
    check("locked base: exactly ONE error, no result", errors.length === 1 && !msgs.some((m) => m.type === "result"), JSON.stringify(msgs.map((m) => m.type)));
    check("locked base: code tool.errorEncrypted", errors[0]?.code === "tool.errorEncrypted", errors[0]?.code);
    check("locked base: refusal NAMES the base file", errors[0]?.detail === "report.pdf", errors[0]?.detail);
  }

  // --- locked OVERLAY names the stamp file ------------------------------
  {
    const msgs = await drive(
      8102,
      [
        new File([baseBytes as BlobPart], "report.pdf"),
        new File([encBytes as BlobPart], "stamp.pdf"),
      ]
    );
    const errors = msgs.filter((m) => m.type === "error");
    check("locked overlay: exactly ONE error, no result", errors.length === 1 && !msgs.some((m) => m.type === "result"));
    check("locked overlay: refusal NAMES the stamp file", errors[0]?.code === "tool.errorEncrypted" && errors[0]?.detail === "stamp.pdf", `${errors[0]?.code} / ${errors[0]?.detail}`);
  }

  // --- unparseable base → honest corrupt refusal with the name ----------
  {
    const msgs = await drive(
      8103,
      [
        new File([garbage as BlobPart], "damaged.pdf"),
        new File([topBytes as BlobPart], "stamp.pdf"),
      ]
    );
    const errors = msgs.filter((m) => m.type === "error");
    check("damaged base: exactly ONE error, no result", errors.length === 1 && !msgs.some((m) => m.type === "result"));
    check("damaged base: code tool.errorCorrupt", errors[0]?.code === "tool.errorCorrupt", errors[0]?.code);
    check("damaged base: refusal NAMES the damaged file", errors[0]?.detail === "damaged.pdf", errors[0]?.detail);
  }

  // --- happy path still intact after the probe refactor -----------------
  {
    const msgs = await drive(
      8104,
      [
        new File([baseBytes as BlobPart], "report.pdf"),
        new File([topBytes as BlobPart], "stamp.pdf"),
      ]
    );
    const results = msgs.filter((m) => m.type === "result");
    check("fine inputs: exactly ONE result, no error", results.length === 1 && !msgs.some((m) => m.type === "error"), JSON.stringify(msgs.map((m) => m.type === "error" ? `${m.code}/${m.detail ?? ""}` : m.type)));
  }
}

console.log(
  `\n${pass} passed, ${fail} failed (${pass + fail} checks)`
);
// Unconditional exit — on success, dangling worker/sharp shims keep
// bun’s event loop alive forever (completed-but-never-terminated hangs).
process.exit(fail > 0 ? 1 : 0);
