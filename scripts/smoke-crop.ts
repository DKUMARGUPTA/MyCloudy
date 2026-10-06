/**
 * PRE-BUILD smoke test for the Crop PDF tool (P3.8). Verifies the pdf-lib
 * engine behaviors the tool depends on BEFORE any UI is written (the P3.3
 * lesson — prove the engine, then build on it):
 *
 *  1. getCropBox() falls back to the MediaBox when no CropBox is set.
 *  2. setCropBox() round-trips through save() → load() (crop survives).
 *  3. The display-space → user-space mapping for /Rotate 0/90/180/270
 *     (the exact math the worker will use) produces the expected boxes.
 *  4. Cropping a page that ALREADY has a CropBox compounds from that view
 *     (what pdf.js re-renders after a crop — consistent iteration).
 *  5. Per-page clamping keeps the box inside the view + a minimum size.
 *
 * Run: bun scripts/smoke-crop.ts
 */
import { writeFile } from "node:fs/promises";
import { PDFDocument, degrees } from "pdf-lib";

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function pass(message: string): void {
  console.log(`PASS ${message}`);
}

/** Display-space margins (points, display orientation: y down). */
interface CropMargins {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Maps a display-space point (dx from left, dyUp from bottom, display dims
 * dw×dh after /Rotate) to PDF user space, given the page's current view box
 * (vx0, vy0, vw, vh) and rotation. Derived from pdf.js getViewport()
 * transforms — see tools/crop-pdf/crop-options.ts for the same math.
 */
function displayToUser(
  rotation: number,
  vx0: number,
  vy0: number,
  vw: number,
  vh: number,
  dx: number,
  dyUp: number
): { x: number; y: number } {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return { x: vx0 + vw - dyUp, y: vy0 + dx };
    case 180:
      return { x: vx0 + vw - dx, y: vy0 + vh - dyUp };
    case 270:
      return { x: vx0 + dyUp, y: vy0 + vh - dx };
    default:
      return { x: vx0 + dx, y: vy0 + dyUp };
  }
}

/** Display dims (dw, dh) for a view box + rotation. */
function displayDims(rotation: number, vw: number, vh: number): { dw: number; dh: number } {
  const r = ((rotation % 360) + 360) % 360;
  return r === 90 || r === 270 ? { dw: vh, dh: vw } : { dw: vw, dh: vh };
}

/** Clamp margins into a page + keep a minimum size, display space. */
function fitCropRect(
  crop: CropMargins,
  dw: number,
  dh: number,
  minSize: number
): { x0: number; yUp0: number; x1: number; yUp1: number } {
  // x from the left edge; y from the top edge (display = CSS orientation).
  const x0 = Math.min(Math.max(0, crop.left), dw - minSize);
  const x1 = Math.max(x0 + minSize, Math.min(dw, dw - crop.right));
  const yT = Math.min(Math.max(0, crop.top), dh - minSize);
  const yB = Math.max(yT + minSize, Math.min(dh, dh - crop.bottom));
  // Convert to y-up (from the bottom edge) for the user-space mapping.
  return { x0, x1, yUp0: dh - yB, yUp1: dh - yT };
}

/** The worker's core operation: margins + view box + rotation → setCropBox args. */
function cropBoxForPage(
  crop: CropMargins,
  view: { x: number; y: number; width: number; height: number },
  rotation: number,
  minSize: number
): { x: number; y: number; width: number; height: number } {
  const { dw, dh } = displayDims(rotation, view.width, view.height);
  const rect = fitCropRect(crop, dw, dh, minSize);
  const p00 = displayToUser(rotation, view.x, view.y, view.width, view.height, rect.x0, rect.yUp0);
  const p11 = displayToUser(rotation, view.x, view.y, view.width, view.height, rect.x1, rect.yUp1);
  return {
    x: Math.min(p00.x, p11.x),
    y: Math.min(p00.y, p11.y),
    width: Math.abs(p11.x - p00.x),
    height: Math.abs(p11.y - p00.y),
  };
}

function near(a: number, b: number, eps = 0.01): boolean {
  return Math.abs(a - b) < eps;
}

async function main(): Promise<void> {
  // --- 1. getCropBox() falls back to MediaBox ---
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const fallback = page.getCropBox();
  if (!near(fallback.x, 0) || !near(fallback.y, 0) || !near(fallback.width, 600) || !near(fallback.height, 400)) {
    fail(`getCropBox fallback expected (0,0,600,400), got (${fallback.x},${fallback.y},${fallback.width},${fallback.height})`);
  }
  pass("getCropBox() falls back to MediaBox when unset");

  // --- 2. Rotation 0: plain margins ---
  const r0 = cropBoxForPage(
    { left: 72, right: 72, top: 54, bottom: 54 },
    { x: 0, y: 0, width: 600, height: 400 },
    0,
    18
  );
  if (!near(r0.x, 72) || !near(r0.y, 54) || !near(r0.width, 600 - 144) || !near(r0.height, 400 - 108)) {
    fail(`rot0 crop expected (72,54,456,292), got (${r0.x},${r0.y},${r0.width},${r0.height})`);
  }
  pass("rotation 0 margins map to the obvious box");

  // --- 3. Rotation 90 (worked example: centered 200×200 on 600×400) ---
  const r90 = cropBoxForPage(
    { left: 100, right: 100, top: 200, bottom: 200 },
    { x: 0, y: 0, width: 600, height: 400 },
    90,
    18
  );
  if (!near(r90.x, 200) || !near(r90.y, 100) || !near(r90.width, 200) || !near(r90.height, 200)) {
    fail(`rot90 crop expected (200,100,200,200), got (${r90.x},${r90.y},${r90.width},${r90.height})`);
  }
  pass("rotation 90 display margins map to the worked example (200,100,200,200)");

  // --- 4. Rotation 180 with asymmetric margins ---
  const r180 = cropBoxForPage(
    { left: 50, right: 100, top: 60, bottom: 120 },
    { x: 0, y: 0, width: 600, height: 400 },
    180,
    18
  );
  if (!near(r180.x, 100) || !near(r180.y, 60) || !near(r180.width, 450) || !near(r180.height, 220)) {
    fail(`rot180 crop expected (100,60,450,220), got (${r180.x},${r180.y},${r180.width},${r180.height})`);
  }
  pass("rotation 180 asymmetric margins map to (100,60,450,220)");

  // --- 5. Rotation 270 with asymmetric margins ---
  const r270 = cropBoxForPage(
    { left: 50, right: 100, top: 60, bottom: 120 },
    { x: 0, y: 0, width: 600, height: 400 },
    270,
    18
  );
  if (!near(r270.x, 120) || !near(r270.y, 100) || !near(r270.width, 420) || !near(r270.height, 250)) {
    fail(`rot270 crop expected (120,100,420,250), got (${r270.x},${r270.y},${r270.width},${r270.height})`);
  }
  pass("rotation 270 asymmetric margins map to (120,100,420,250)");

  // --- 6. Negative rotation (-90) normalizes like 270 ---
  const rNeg = cropBoxForPage(
    { left: 50, right: 100, top: 60, bottom: 120 },
    { x: 0, y: 0, width: 600, height: 400 },
    -90,
    18
  );
  if (!near(rNeg.x, 120) || !near(rNeg.y, 100)) {
    fail(`rot -90 expected same as 270, got (${rNeg.x},${rNeg.y})`);
  }
  pass("negative rotation (-90) normalizes to the 270 mapping");

  // --- 7. Over-sized margins clamp per page + keep the minimum size ---
  const tiny = cropBoxForPage(
    { left: 5000, right: 5000, top: 5000, bottom: 5000 },
    { x: 0, y: 0, width: 600, height: 400 },
    0,
    18
  );
  if (!near(tiny.x, 582) || !near(tiny.y, 0) || !near(tiny.width, 18) || !near(tiny.height, 18)) {
    fail(`clamped crop expected (582,0,18,18) pinned top-right, got (${tiny.x},${tiny.y},${tiny.width},${tiny.height})`);
  }
  pass("over-sized margins clamp to a minimum 18pt box (pinned top-right)");

  // --- 8. setCropBox + save/load round trip on rotated pages ---
  const rt = await PDFDocument.create();
  const p1 = rt.addPage([600, 400]);
  p1.setRotation(degrees(90));
  const box = cropBoxForPage(
    { left: 100, right: 100, top: 200, bottom: 200 },
    { x: 0, y: 0, width: 600, height: 400 },
    90,
    18
  );
  p1.setCropBox(box.x, box.y, box.width, box.height);
  const saved = await rt.save();
  const reloaded = await PDFDocument.load(saved);
  const rp1 = reloaded.getPage(0);
  const rtBox = rp1.getCropBox();
  if (!near(rtBox.x, 200) || !near(rtBox.y, 100) || !near(rtBox.width, 200) || !near(rtBox.height, 200)) {
    fail(`round trip expected (200,100,200,200), got (${rtBox.x},${rtBox.y},${rtBox.width},${rtBox.height})`);
  }
  if (rp1.getRotation().angle !== 90) {
    fail(`rotation lost in round trip: ${rp1.getRotation().angle}`);
  }
  pass("setCropBox survives save → load with /Rotate 90 intact");

  // --- 9. Compounding: crop an already-cropped page (pdf.js view = CropBox) ---
  const second = cropBoxForPage(
    { left: 10, right: 10, top: 10, bottom: 10 },
    { x: 200, y: 100, width: 200, height: 200 },
    90,
    18
  );
  if (!near(second.x, 210) || !near(second.y, 110) || !near(second.width, 180) || !near(second.height, 180)) {
    fail(`compound crop expected (210,110,180,180), got (${second.x},${second.y},${second.width},${second.height})`);
  }
  pass("re-cropping compounds from the existing CropBox view");

  // --- 10. Non-zero view origin (view not at 0,0) ---
  const off = cropBoxForPage(
    { left: 20, right: 20, top: 10, bottom: 10 },
    { x: 30, y: 40, width: 200, height: 100 },
    0,
    18
  );
  if (!near(off.x, 50) || !near(off.y, 50) || !near(off.width, 160) || !near(off.height, 80)) {
    fail(`offset view crop expected (50,50,160,80), got (${off.x},${off.y},${off.width},${off.height})`);
  }
  pass("non-zero view origin offsets the user-space box correctly");

  // QA fixture for the browser round: 612×792 page with a visible content
  // frame (border only, drawn as 4 filled bars) + corner marks, so visual
  // crop QA and auto-detect have a clear content edge to find.
  const qa = await PDFDocument.create();
  const qp = qa.addPage([612, 792]);
  const { rgb } = await import("pdf-lib");
  const ink = rgb(0.1, 0.1, 0.12);
  qp.drawRectangle({ x: 96, y: 664, width: 420, height: 6, color: ink }); // top bar
  qp.drawRectangle({ x: 96, y: 120, width: 420, height: 6, color: ink }); // bottom bar
  qp.drawRectangle({ x: 96, y: 126, width: 6, height: 538, color: ink }); // left bar
  qp.drawRectangle({ x: 510, y: 126, width: 6, height: 538, color: ink }); // right bar
  const out = await qa.save();
  await writeFile("/home/z/my-project/download/qa-p38-smoke.pdf", out);
  pass("wrote download/qa-p38-smoke.pdf (612×792 framed fixture for browser QA)");
}

void main().catch((error: unknown) => {
  console.error("FAIL unhandled", error);
  process.exit(1);
});
