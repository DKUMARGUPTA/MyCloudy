/**
 * PRE-BUILD smoke test for the Crop PDF tool (P3.8, P6-t). Verifies the
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
 * 11. REAL PIPELINE (P6-t, own engine): runCrop (parsePdf → /CropBox
 *     surgery on the parsed graph → rewriteDocument) — pdf-lib reload
 *     asserts the boxes, rotation, annotations and untouched-page bytes;
 *     ObjStm-resident page objects crop correctly; typed error codes.
 *
 * Run: bun scripts/smoke-crop.ts
 */
import { writeFile } from "node:fs/promises";
import { PDFDocument, PDFName, degrees } from "pdf-lib";
import { runCrop, CropRunError } from "../tools/crop-pdf/worker-lib";

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function pass(message: string): void {
  console.log(`PASS ${message}`);
}

/** Assertion helper (the pagesize-smoke check shape) with detail output. */
function check(cond: boolean, message: string, detail = ""): void {
  if (!cond) fail(`${message}${detail ? ` — ${detail}` : ""}`);
  pass(message);
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

  // --- 11. REAL PIPELINE (P6-t): runCrop on the OWN engine --------------
  // Fixture (pdf-lib oracle, object-streams form to exercise the ObjStm
  // resident path): p1 plain 600×400 with a link annot, p2 /Rotate 90,
  // p3 with a pre-existing CropBox (compounding view).
  const fx = await PDFDocument.create();
  const f1 = fx.addPage([600, 400]);
  f1.drawText("PAGE ONE", { x: 40, y: 200, size: 24 });
  // A Square annotation via the low-level context (the 1.17 public path) —
  // crop must NOT drop annotations (the old in-place pdf-lib save kept them).
  const annotRef = fx.context.register(
    fx.context.obj({
      Type: "Annot",
      Subtype: "Square",
      Rect: [40, 180, 180, 220],
      F: 4,
      Border: [0, 0, 1],
      C: [0, 0, 1],
    })
  );
  f1.node.set(PDFName.of("Annots"), fx.context.obj([annotRef]));
  const f2 = fx.addPage([600, 400]);
  f2.setRotation(degrees(90));
  f2.drawText("PAGE TWO", { x: 40, y: 200, size: 24 });
  const f3 = fx.addPage([600, 400]);
  f3.drawText("PAGE THREE", { x: 40, y: 200, size: 24 });
  f3.setCropBox(50, 40, 500, 320); // an existing view to compound from
  const fxBytes = await fx.save({ useObjectStreams: true });

  const cropped = await runCrop(
    fxBytes,
    { cropUnit: "pt", cropLeft: 50, cropTop: 60, cropRight: 100, cropBottom: 20, cropLayout: "all", cropPages: "all" },
    () => undefined
  );
  check(cropped.targets === 3, "runCrop targeted all 3 pages");
  check(cropped.changed === 3, "all 3 boxes actually changed", String(cropped.changed));

  const rc = await PDFDocument.load(cropped.bytes, { ignoreEncryption: true });
  // p1: view was the full MediaBox → box = margins in user space.
  const c1 = rc.getPage(0).getCropBox();
  check(
    near(c1.x, 50) && near(c1.y, 20) && near(c1.width, 450) && near(c1.height, 320),
    `p1 CropBox = (50,20,450,320), got (${c1.x},${c1.y},${c1.width},${c1.height})`
  );
  // p1 link annotation SURVIVES the rewrite (in-place seam — the page dict
  // keeps /Annots; the rewriter copies the annot graph and remaps /P).
  check(
    rc.getPage(0).node.Annots() !== undefined && rc.getPage(0).node.Annots()!.size() === 1,
    "p1 link annotation survives the rewrite"
  );
  // p2: /Rotate 90 intact + the rotated display mapping applied. Display
  // span = 250 wide × 520 tall; user space SWAPS the axes for 90 — the
  // CropBox array lives in unrotated user space (pdf-lib getCropBox).
  const rc2 = rc.getPage(1);
  check(rc2.getRotation().angle === 90, "p2 /Rotate 90 intact");
  const c2 = rc2.getCropBox();
  check(
    near(c2.width, 520) && near(c2.height, 250),
    `p2 rotated crop dims user-space = 520x250, got ${c2.width}x${c2.height}`
  );
  // p3: compounds from the EXISTING CropBox view (50,40,500,320), not the
  // MediaBox — pdf.js re-render consistency.
  const c3 = rc.getPage(2).getCropBox();
  check(
    near(c3.x, 100) && near(c3.y, 60) && near(c3.width, 350) && near(c3.height, 240),
    `p3 compounded from existing view = (100,60,350,240), got (${c3.x},${c3.y},${c3.width},${c3.height})`
  );

  // Untouched-page passthrough: cropping ONLY p2 leaves p1/p3 dicts intact.
  const onlyP2 = await runCrop(
    fxBytes,
    { cropUnit: "pt", cropLeft: 10, cropTop: 10, cropRight: 10, cropBottom: 10, cropLayout: "range", cropPages: "2" },
    () => undefined
  );
  check(onlyP2.changed === 1, "targeted '2' changed exactly 1 box", String(onlyP2.changed));
  const rp = await PDFDocument.load(onlyP2.bytes, { ignoreEncryption: true });
  check(
    near(rp.getPage(0).getCropBox().width, 600) &&
      near(rp.getPage(2).getCropBox().width, 500),
    "un-targeted pages keep their original views"
  );

  // No-op margins (zero all round) → no box changes.
  const noOp = await runCrop(
    fxBytes,
    { cropUnit: "pt", cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLayout: "all", cropPages: "all" },
    () => undefined
  );
  check(noOp.changed === 0, "zero margins are an honest no-op");

  // Typed error codes: corrupt / no pages.
  try {
    await runCrop(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {}, () => undefined);
    check(false, "garbage input should throw");
  } catch (error) {
    check(
      error instanceof CropRunError && error.code === "tool.errorCorrupt",
      "garbage input → tool.errorCorrupt"
    );
  }
  try {
    await runCrop(
      fxBytes,
      { cropUnit: "pt", cropLeft: 10, cropTop: 10, cropRight: 10, cropBottom: 10, cropLayout: "range", cropPages: "99-120" },
      () => undefined
    );
    check(false, "out-of-range targets should throw");
  } catch (error) {
    check(
      error instanceof CropRunError && error.code === "crop.errorNoPages",
      "no valid targets → crop.errorNoPages"
    );
  }
}

void main().catch((error: unknown) => {
  console.error("FAIL unhandled", error);
  process.exit(1);
});
