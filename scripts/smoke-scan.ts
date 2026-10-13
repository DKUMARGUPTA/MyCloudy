/**
 * Smoke test for tools/scan-pdf/engine.ts (pure engine).
 * Run: bun scripts/smoke-scan.ts
 * Covers: quad detection (bright + dark docs, rotated perspective, honest
 * fallback), homography identity/known-warp, warp bilinear fidelity,
 * filters (magic/gray/bw), quarter rotation, serialization round-trip and
 * the page-list ops.
 */
import {
  applyAdaptiveBW,
  applyGrayscale,
  applyMagicColor,
  createInitialScanPages,
  deleteScanPages,
  detectDocumentQuad,
  denormalizeQuad,
  FULL_FRAME_QUAD,
  moveScanPage,
  normalizeQuad,
  parseScanPagesOption,
  quadOutputSize,
  reconcileScanPages,
  rotateQuarter,
  rotateScanPages,
  serializeScanPages,
  setScanFilter,
  solveHomography,
  warpPerspective,
  type Quad,
  type ScanBitmap,
} from "../tools/scan-pdf/engine";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string, extra = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  ${name} ${extra}`);
  }
}

/** Fills an RGBA bitmap: background color + a filled polygon (quad). */
function makeScene(
  width: number,
  height: number,
  quad: [number, number][],
  bg: [number, number, number],
  fg: [number, number, number]
): ScanBitmap {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = bg[0];
    data[i * 4 + 1] = bg[1];
    data[i * 4 + 2] = bg[2];
    data[i * 4 + 3] = 255;
  }
  // Even-odd rule polygon fill.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let inside = false;
      for (let i = 0, j = quad.length - 1; i < quad.length; j = i++) {
        const [xi, yi] = quad[i];
        const [xj, yj] = quad[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      if (inside) {
        const o = (y * width + x) * 4;
        data[o] = fg[0];
        data[o + 1] = fg[1];
        data[o + 2] = fg[2];
      }
    }
  }
  return { data, width, height };
}

console.log("scan-pdf engine — quad detection");
{
  // Bright A4-ish document on a dark desk.
  const W = 240;
  const H = 180;
  const doc: [number, number][] = [
    [40, 30],
    [210, 22],
    [202, 150],
    [30, 158],
  ];
  const scene = makeScene(W, H, doc, [30, 30, 34], [235, 232, 225]);
  const det = detectDocumentQuad(scene.data, W, H);
  ok(det.confidence > 0.5, "bright doc: confident", `conf=${det.confidence}`);
  ok(det.polarity === "bright", "bright doc: bright polarity", det.polarity);
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
  ok(
    near(det.quad[0], 41, 3) && near(det.quad[1], 31, 3),
    "bright doc: TL corner",
    `${det.quad[0]},${det.quad[1]}`
  );
  ok(
    near(det.quad[2], 209, 3) && near(det.quad[3], 23, 3),
    "bright doc: TR corner",
    `${det.quad[2]},${det.quad[3]}`
  );
  ok(
    near(det.quad[4], 201, 3) && near(det.quad[5], 149, 3),
    "bright doc: BR corner",
    `${det.quad[4]},${det.quad[5]}`
  );
  ok(
    near(det.quad[6], 31, 3) && near(det.quad[7], 157, 3),
    "bright doc: BL corner",
    `${det.quad[6]},${det.quad[7]}`
  );
}
{
  // Dark document on a white table (inverted polarity).
  const W = 240;
  const H = 180;
  const doc: [number, number][] = [
    [30, 25],
    [200, 40],
    [190, 160],
    [20, 145],
  ];
  const scene = makeScene(W, H, doc, [240, 240, 240], [40, 44, 38]);
  const det = detectDocumentQuad(scene.data, W, H);
  ok(det.confidence > 0.5, "dark doc: confident", `conf=${det.confidence}`);
  ok(det.polarity === "dark", "dark doc: dark polarity", det.polarity);
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
  ok(near(det.quad[0], 31, 4) && near(det.quad[6], 21, 4), "dark doc: TL+BL", JSON.stringify(det.quad));
}
{
  // Uniform frame → honest fallback, no crop.
  const W = 64;
  const H = 48;
  const data = new Uint8ClampedArray(W * H * 4).fill(128);
  const det = detectDocumentQuad(data, W, H);
  ok(det.confidence === 0, "uniform frame: zero confidence");
  ok(det.polarity === "none", "uniform frame: no polarity", det.polarity);
  ok(
    det.quad[0] === 0 && det.quad[2] === W - 1 && det.quad[5] === H - 1,
    "uniform frame: full-frame quad"
  );
}

console.log("scan-pdf engine — homography + warp");
{
  // Identity: quad = the whole frame → output equals input.
  const W = 32;
  const H = 24;
  const src: ScanBitmap = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
  // Smooth gradient (no %256 sawtooth) — resampling stays sub-unit.
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 4;
      src.data[o] = x * 4;
      src.data[o + 1] = y * 6;
      src.data[o + 2] = 128;
      src.data[o + 3] = 255;
    }
  }
  const quad: Quad = [0, 0, W - 1, 0, W - 1, H - 1, 0, H - 1];
  const out = warpPerspective(src, quad, W, H);
  ok(out.width === W && out.height === H, "identity warp: dims");
  // The quad spans 0..W-1 while the output spans 0..W, so even the
  // identity resamples at ×(W-1)/W — allow sub-gradient drift (≤8),
  // which real mapping bugs (garbage placement) still blow past.
  let same = true;
  for (let i = 0; i < W * H * 4; i += 1) {
    if (Math.abs(out.data[i] - src.data[i]) > 8) {
      same = false;
      break;
    }
  }
  ok(same, "identity warp: pixels match (≤8 resample tolerance)");
}
{
  // Known shear: quad pulls the top-right corner inward horizontally.
  // Output(0,0) must sample src TL; output(W-1,0) samples the pulled TR.
  const W = 40;
  const H = 30;
  const src = makeScene(W, H, [[0, 0], [W, 0], [W, H], [0, H]], [0, 0, 0], [0, 0, 0]);
  // Paint distinctive source pixels.
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 4;
      src.data[o] = x * 6;
      src.data[o + 1] = y * 8;
    }
  }
  const trX = W - 12; // top-right pulled 12px left
  const quad: Quad = [0, 0, trX, 0, W - 1, H - 1, 0, H - 1];
  const out = warpPerspective(src, quad, 40, 30);
  // TL of output = TL of source.
  ok(out.data[0] === 0 && out.data[1] === 0, "shear warp: TL maps to source TL");
  // A point along the top edge maps proportionally along the pulled edge.
  const px = 20;
  const o = 1 * 4; // y=1
  void o;
  void px;
  // Sample top-right corner region: it should be near x≈trX in the source.
  const corner = ((0 * out.width) + (out.width - 1)) * 4;
  const expectX = trX;
  ok(
    Math.abs(out.data[corner] - expectX * 6) <= 12,
    "shear warp: top-right samples pulled corner",
    `got=${out.data[corner]} want≈${expectX * 6}`
  );
}
{
  // solveHomography sanity: unit square → itself.
  const h = solveHomography(
    [[0, 0], [1, 0], [1, 1], [0, 1]],
    [[0, 0], [1, 0], [1, 1], [0, 1]]
  );
  ok(h !== null, "homography: solvable");
  if (h) {
    ok(
      Math.abs(h[0] - 1) < 1e-9 && Math.abs(h[4] - 1) < 1e-9 && Math.abs(h[2]) < 1e-9,
      "homography: identity params"
    );
  }
}
{
  // A quad that pokes past the source edges: corner samples land
  // outside the bitmap and must render white (not clamp-smeared).
  const src = makeScene(20, 20, [[0, 0], [20, 0], [20, 20], [0, 20]], [10, 10, 10], [10, 10, 10]);
  const out = warpPerspective(src, [5, 5, 15, 5, 15, 15, 5, 15], 10, 10);
  const skewed = warpPerspective(src, [-4, -4, 10, 1, 24, 22, 1, 24], 12, 12);
  let hasWhite = false;
  for (let i = 0; i < skewed.data.length; i += 4) {
    if (skewed.data[i] === 255 && skewed.data[i + 1] === 255 && skewed.data[i + 2] === 255) {
      hasWhite = true;
      break;
    }
  }
  ok(hasWhite, "warp: outside-source samples render white");
  ok(out.width === 10 && out.height === 10, "warp: requested output dims");
}
{
  // quadOutputSize caps the long edge and keeps the aspect.
  const quad: Quad = [0, 0, 800, 0, 800, 600, 0, 600];
  const size = quadOutputSize(quad, 1600);
  ok(size.width === 1600 && Math.abs(size.height - 1200) <= 1, "quadOutputSize: 800×600 → 1600×1200", JSON.stringify(size));
  const tiny = quadOutputSize([0, 0, 20, 0, 20, 10, 0, 10], 1600);
  ok(tiny.width >= 16 && tiny.height >= 16, "quadOutputSize: min 16px floor", JSON.stringify(tiny));
}

console.log("scan-pdf engine — filters");
{
  // Text-page pattern: white paper (235) with dark text bars (40).
  const W = 100;
  const H = 60;
  const bmp: ScanBitmap = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 4;
      const isText = x >= 15 && x <= 85 && y % 12 >= 4 && y % 12 <= 7;
      const v = isText ? 40 : 235;
      bmp.data[o] = v;
      bmp.data[o + 1] = v;
      bmp.data[o + 2] = v;
      bmp.data[o + 3] = 255;
    }
  }
  applyGrayscale(bmp);
  ok(bmp.data[0] === bmp.data[1] && bmp.data[1] === bmp.data[2], "gray: channels equal");

  applyAdaptiveBW(bmp);
  let dark = 0;
  let light = 0;
  for (let i = 0; i < bmp.data.length; i += 4) {
    if (bmp.data[i] === 0) dark += 1;
    else if (bmp.data[i] === 255) light += 1;
  }
  ok(dark > 500 && light > 3000, "bw: binarized into both buckets", `${dark}/${light}`);
  const textPixel = bmp.data[(6 * W + 50) * 4]; // inside a text bar
  const paperPixel = bmp.data[(2 * W + 50) * 4]; // between bars
  ok(textPixel === 0, "bw: text bars go black", String(textPixel));
  ok(paperPixel === 255, "bw: paper stays white", String(paperPixel));

  applyMagicColor(bmp);
  ok(bmp.data[(2 * W + 50) * 4] === 255, "magic: keeps clipped whites white");
}

console.log("scan-pdf engine — rotation");
{
  const bmp: ScanBitmap = { data: new Uint8ClampedArray(4 * 2 * 4), width: 4, height: 2 };
  for (let i = 0; i < 8; i += 1) {
    bmp.data[i * 4] = i * 9;
    bmp.data[i * 4 + 3] = 255;
  }
  const r90 = rotateQuarter(bmp, 90);
  ok(r90.width === 2 && r90.height === 4, "rotate90: dims swap");
  // (0,0) → (h-1, 0) = (1, 0): source index 0*4+0… dest holds src(0,0).
  ok(r90.data[1 * 4] === 0 * 9, "rotate90: TL → TR");
  const r180 = rotateQuarter(bmp, 180);
  ok(r180.width === 4 && r180.height === 2, "rotate180: dims same");
  ok(r180.data[(7) * 4] === 0 * 9, "rotate180: TL ↔ BR");
  const r270 = rotateQuarter(bmp, 270);
  ok(r270.width === 2 && r270.height === 4, "rotate270: dims swap");
  ok(r270.data[(3 * 2 + 0) * 4] === 0 * 9, "rotate270: TL → BL");
  const r0 = rotateQuarter(bmp, 0);
  ok(r0 === bmp, "rotate0: no copy");
}

console.log("scan-pdf engine — page model");
{
  const pages = createInitialScanPages(3);
  ok(pages.length === 3 && pages.every((p) => p.source !== undefined), "initial: 3 pages");
  ok(
    pages.every((p) => p.quad.every((v, i) => v === FULL_FRAME_QUAD[i])),
    "initial: full-frame quads"
  );
  const rotated = rotateScanPages(pages, [0, 2], 90);
  ok(rotated[0].rotation === 90 && rotated[1].rotation === 0 && rotated[2].rotation === 90, "rotate op");
  const filtered = setScanFilter(rotated, [1], "bw");
  ok(filtered[1].filter === "bw" && filtered[0].filter === "original", "filter op");
  const moved = moveScanPage(filtered, 0, 2);
  ok(moved[2].rotation === 90 && moved[0].rotation === 0, "move op");
  const deleted = deleteScanPages(moved, [1]);
  ok(deleted.length === 2, "delete op");

  const serialized = serializeScanPages(deleted);
  const parsed = parseScanPagesOption(serialized, 3);
  ok(parsed !== null && parsed.length === 2, "round-trip: parses");
  if (parsed) {
    ok(parsed[0].source === deleted[0].source, "round-trip: source preserved");
    ok(parsed[0].quad[0] === deleted[0].quad[0], "round-trip: quad preserved");
    ok(parsed[1].filter === deleted[1].filter, "round-trip: filter preserved");
    ok(parsed[0].rotation === deleted[0].rotation, "round-trip: rotation preserved");
  }
  ok(parseScanPagesOption("not json", 3) === null, "round-trip: rejects garbage");
  ok(parseScanPagesOption("[[9,0,\"original\",[0,0,1,0,1,1,0,1]]]", 3) === null, "round-trip: rejects bad source");
  ok(parseScanPagesOption(undefined, 3)?.length === 3, "round-trip: natural fallback");
  const norm = parseScanPagesOption(
    "[[0,0,\"original\",[-0.03,0,1.03,0,1,1,0,1]]]",
    1
  );
  ok(norm !== null && norm[0].quad[0] === 0 && norm[0].quad[2] === 1, "round-trip: clamps out-of-range quads");

  const rec = reconcileScanPages(deleted, 5, 3);
  ok(rec.length === 5, "reconcile: appends new sources");
  ok(rec[0].source === deleted[0].source, "reconcile: keeps edited order");
  const recDown = reconcileScanPages(deleted, 2, 3);
  ok(recDown.length === 2, "reconcile: shrinks with files");
}

console.log("scan-pdf engine — normalize helpers");
{
  const q = denormalizeQuad(FULL_FRAME_QUAD, 800, 600);
  ok(q[2] === 800 && q[5] === 600, "denormalize");
  const back = normalizeQuad(q, 800, 600);
  ok(back.every((v, i) => Math.abs(v - FULL_FRAME_QUAD[i]) < 1e-12), "normalize round-trip");
}

console.log("");
console.log(`scan-pdf engine: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
