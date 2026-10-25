/**
 * Smoke test for tools/scan-pdf/engine.ts (pure engine).
 * Run: bun scripts/smoke-scan.ts
 * Covers: quad detection (bright + dark docs, rotated perspective, honest
 * fallback), homography identity/known-warp, warp bilinear fidelity,
 * filters (magic/gray/bw + Round-7 vivid/soft/sharpbw/ocrbw), manual
 * adjustments, deskew estimate+rotate, corner refinement, low-contrast
 * detection, quarter rotation, serialization round-trip (incl. legacy
 * 4-field rows) and the page-list ops + presets.
 */
import { readFileSync } from "node:fs";
import {
  applyAdaptiveBW,
  applyAdjustments,
  applyGrayscale,
  applyMagicColor,
  applyOCRBW,
  applySharpBW,
  applySoftTone,
  applyVivid,
  autoDeskew,
  clampAdjust,
  createInitialScanPages,
  deleteScanPages,
  deskewBitmap,
  detectDocumentQuad,
  denormalizeQuad,
  estimateDeskewAngle,
  FULL_FRAME_QUAD,
  moveScanPage,
  normalizeQuad,
  pageIsEnhanced,
  parseScanPagesOption,
  PRESET_SPECS,
  quadOutputSize,
  reconcileScanPages,
  refineQuadCorners,
  rotateQuarter,
  rotateScanPages,
  SCAN_FILTERS,
  SCAN_PRESETS,
  serializeScanPages,
  setScanAdjust,
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

console.log("scan-pdf engine — Round-7 filters (Doc Scanner parity)");
{
  // Colourful scene: red-ish page on cyan-ish desk (both mid-tone so the
  // colour-aware filters have something to bite on).
  const W = 80;
  const H = 60;
  const mk = (r: number, g: number, b: number): ScanBitmap => {
    const bmp: ScanBitmap = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
    for (let i = 0; i < W * H; i += 1) {
      bmp.data[i * 4] = r;
      bmp.data[i * 4 + 1] = g;
      bmp.data[i * 4 + 2] = b;
      bmp.data[i * 4 + 3] = 255;
    }
    return bmp;
  };
  const satAt = (bmp: ScanBitmap, i: number) => {
    const r = bmp.data[i * 4];
    const g = bmp.data[i * 4 + 1];
    const b = bmp.data[i * 4 + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    return mx - mn;
  };

  // vivid: saturation strongly lifted (1.45×) on a coloured scene.
  const before = mk(200, 120, 80);
  const beforeSat = satAt(before, 0);
  const vivid = mk(200, 120, 80);
  applyVivid(vivid);
  ok(satAt(vivid, 0) > beforeSat * 1.2, "vivid: saturation lifted", `${beforeSat}→${satAt(vivid, 0)}`);

  // soft: saturation reduced (0.88×) and warmed (red ↑, blue ↓).
  const soft = mk(200, 120, 80);
  applySoftTone(soft);
  ok(satAt(soft, 0) < beforeSat * 1.02, "soft: saturation softened", `${beforeSat}→${satAt(soft, 0)}`);
  const warmR = soft.data[0];
  const warmB = soft.data[2];
  ok(
    warmR > 0 && warmB < 255 && warmR - warmB >= 90,
    "soft: colour separation preserved (not nuked)",
    `r=${warmR} b=${warmB}`
  );
  // Uniform colour is NOT nuked to black by the percentile stretch.
  const uni = mk(200, 120, 80);
  applyVivid(uni);
  ok(
    satAt(uni, 0) > 60,
    "vivid: uniform colour survives (no nuke-to-black)",
    String(satAt(uni, 0))
  );

  // Text-page pattern for the two binarizing filters.
  const page = (): ScanBitmap => {
    const bmp = mk(232, 230, 224);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const isText = x >= 10 && x <= 70 && y % 10 >= 3 && y % 10 <= 5;
        if (isText) {
          const o = (y * W + x) * 4;
          bmp.data[o] = 40;
          bmp.data[o + 1] = 40;
          bmp.data[o + 2] = 42;
        }
      }
    }
    return bmp;
  };
  const binarized = (bmp: ScanBitmap) => {
    let zero = 0;
    let twoFiveFive = 0;
    for (let i = 0; i < bmp.data.length; i += 4) {
      if (bmp.data[i] === 0 && bmp.data[i + 1] === 0) zero += 1;
      else if (bmp.data[i] === 255 && bmp.data[i + 1] === 255) twoFiveFive += 1;
    }
    return { zero, twoFiveFive };
  };

  const sharp = page();
  applySharpBW(sharp);
  const sharpStats = binarized(sharp);
  ok(
    sharpStats.zero > 150 && sharpStats.twoFiveFive > 2000,
    "sharpbw: binarized with text black + paper white",
    JSON.stringify(sharpStats)
  );
  ok(sharp.data[(4 * W + 40) * 4] === 0, "sharpbw: text row inside a bar is black");

  const ocr = page();
  applyOCRBW(ocr);
  const ocrStats = binarized(ocr);
  ok(
    ocrStats.zero > 150 && ocrStats.twoFiveFive > 2000,
    "ocrbw: binarized with text black + paper white",
    JSON.stringify(ocrStats)
  );

  ok(SCAN_FILTERS.length === 8, "filters: registry has 8 entries", String(SCAN_FILTERS.length));
  ok(
    ["vivid", "soft", "sharpbw", "ocrbw"].every((f) => SCAN_FILTERS.includes(f as never)),
    "filters: all Round-7 ids registered"
  );
}

console.log("scan-pdf engine — Round-7 adjustments");
{
  const mk = (v: number): ScanBitmap => {
    const bmp: ScanBitmap = {
      data: new Uint8ClampedArray(4 * 4 * 4),
      width: 4,
      height: 4,
    };
    for (let i = 0; i < 16; i += 1) {
      bmp.data[i * 4] = v;
      bmp.data[i * 4 + 1] = v;
      bmp.data[i * 4 + 2] = v;
      bmp.data[i * 4 + 3] = 255;
    }
    return bmp;
  };
  // Brightness +40 → +48 levels on 100 → 148.
  const bright = mk(100);
  applyAdjustments(bright, { brightness: 40, contrast: 0 });
  ok(bright.data[0] === 148, "adjust: brightness +40 lifts 100→148", String(bright.data[0]));
  // Contrast +40 → ×1.6 around 128: 100 → 128−28×1.6=83.2 → 83.
  const contrast = mk(100);
  applyAdjustments(contrast, { brightness: 0, contrast: 40 });
  ok(contrast.data[0] === 83, "adjust: contrast +40 maps 100→83", String(contrast.data[0]));
  // Negative contrast flattens toward 128: ×0.4 → 128−28×0.4=116.8 → 117.
  const flat = mk(100);
  applyAdjustments(flat, { brightness: 0, contrast: -40 });
  ok(flat.data[0] === 117, "adjust: contrast −40 flattens 100→117", String(flat.data[0]));
  // 0/0 is a strict no-op (same reference mutated nothing — value equal).
  const noop = mk(100);
  applyAdjustments(noop, { brightness: 0, contrast: 0 });
  ok(noop.data[0] === 100, "adjust: 0/0 no-op");
  // Out-of-range input clamps to ±40 before applying (both dials combine
  // in one LUT: (100−128)×0.4 + 128 + 48 = 164.8 → 165).
  const clamped = mk(100);
  applyAdjustments(clamped, { brightness: 999, contrast: -999 });
  ok(clamped.data[0] === 165, "adjust: clamps to ±40 (combined LUT)", String(clamped.data[0]));
  ok(clampAdjust(999) === 40 && clampAdjust(-999) === -40 && clampAdjust(7.6) === 8, "adjust: clampAdjust vectors");
}

console.log("scan-pdf engine — Round-7 deskew");
{
  // Text page: 7 horizontal bars on white.
  const W = 220;
  const H = 150;
  const page: ScanBitmap = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 4;
      const isText = x >= 20 && x <= 200 && y % 18 >= 5 && y % 18 <= 9;
      const v = isText ? 30 : 240;
      page.data[o] = v;
      page.data[o + 1] = v;
      page.data[o + 2] = v;
      page.data[o + 3] = 255;
    }
  }
  const flat = estimateDeskewAngle(page);
  ok(Math.abs(flat.angle) < 0.3, "deskew: flat page ≈ 0°", JSON.stringify(flat));
  ok(flat.strength > 1.8, "deskew: text page has structure strength", String(flat.strength));

  // Tilt the page by +3° using the engine's own rotator → estimate recovers it.
  const tilted = deskewBitmap(page, 3);
  const est = estimateDeskewAngle(tilted);
  ok(Math.abs(est.angle - 3) <= 0.5, "deskew: +3° tilt detected", JSON.stringify(est));
  ok(est.strength > 1.8, "deskew: tilted page still structured", String(est.strength));

  // Straighten back via the two-pass helper (what the worker actually
  // runs): residual after double bilinear rotation stays well under 0.5°.
  const straight = autoDeskew(tilted);
  const re = estimateDeskewAngle(straight);
  ok(Math.abs(re.angle) < 0.5, "deskew: autoDeskew restores ≈ 0° (two-pass)", JSON.stringify(re));
  // Exact −angle also restores ≈ 0.
  const exact = estimateDeskewAngle(deskewBitmap(tilted, -3));
  ok(Math.abs(exact.angle) < 0.4, "deskew: exact −3 restores ≈ 0°", JSON.stringify(exact));

  // Blank page: no ink → honest {0, strength 0}.
  const blank: ScanBitmap = { data: new Uint8ClampedArray(60 * 40 * 4).fill(240), width: 60, height: 40 };
  for (let i = 3; i < blank.data.length; i += 4) blank.data[i] = 255;
  const blankEst = estimateDeskewAngle(blank);
  ok(blankEst.angle === 0 && blankEst.strength === 0, "deskew: blank page honest zero", JSON.stringify(blankEst));

  // deskewBitmap no-op under the 0.05° threshold (same object back).
  const same = deskewBitmap(page, 0.01);
  ok(same === page, "deskew: <0.05° returns the same bitmap");
}

console.log("scan-pdf engine — Round-7 corner refinement + low contrast");
{
  // True page edges at 50/190 × 40/140 on a darker desk; pass a quad that is
  // 6 px INSIDE the true page — refinement must snap back out to the edges.
  const W = 240;
  const H = 180;
  const doc: [number, number][] = [
    [50, 40],
    [190, 40],
    [190, 140],
    [50, 140],
  ];
  const scene = makeScene(W, H, doc, [70, 70, 70], [235, 235, 235]);
  const gray = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i += 1) {
    gray[i] = (scene.data[i * 4] * 77 + scene.data[i * 4 + 1] * 150 + scene.data[i * 4 + 2] * 29) >> 7;
  }
  const off: Quad = [56, 46, 184, 46, 184, 134, 56, 134];
  const refined = refineQuadCorners(gray, W, H, off);
  const dist = (q: Quad, cx: number, cy: number) =>
    Math.hypot(q[cx], q[cy]);
  void dist;
  const cornerErr = (q: Quad) =>
    Math.hypot(q[0] - 50, q[1] - 40) +
    Math.hypot(q[2] - 190, q[3] - 40) +
    Math.hypot(q[4] - 190, q[5] - 140) +
    Math.hypot(q[6] - 50, q[7] - 140);
  const before = cornerErr(off);
  const after = cornerErr(refined);
  ok(after < before * 0.5, "refine: snapped toward true edges", `err ${before}→${after}`);
  ok(after <= 8, "refine: final error ≤ 8px total", String(after));

  // Uniform gray + wrong quad → honest no-op (no gradients to chase).
  const uniformGray = new Uint8Array(W * H).fill(128);
  const noOp = refineQuadCorners(uniformGray, W, H, off);
  ok(noOp.every((v, i) => v === off[i]), "refine: uniform frame is a no-op");

  // Low-contrast 3-tone scene: bright-ish desk (225) + page (235) + a dark
  // object (20) that drags the raw Otsu cut down so page+desk merge. The
  // equalized candidate set + border-bleed penalty must still find the PAGE
  // (not the merged full-frame blob).
  const W3 = 240;
  const H3 = 180;
  const scene3 = makeScene(
    W3,
    H3,
    [
      [40, 30],
      [200, 30],
      [200, 150],
      [40, 150],
    ],
    [225, 225, 225],
    [235, 235, 235]
  );
  // Dark object: top-left corner block, 30×26.
  for (let y = 0; y < 26; y += 1) {
    for (let x = 0; x < 30; x += 1) {
      const o = (y * W3 + x) * 4;
      scene3.data[o] = 20;
      scene3.data[o + 1] = 20;
      scene3.data[o + 2] = 20;
    }
  }
  const det3 = detectDocumentQuad(scene3.data, W3, H3);
  ok(det3.confidence > 0.35, "low-contrast: page found", `conf=${det3.confidence}`);
  ok(
    Math.abs(det3.quad[0] - 41) <= 5 &&
      Math.abs(det3.quad[1] - 31) <= 5 &&
      Math.abs(det3.quad[4] - 199) <= 5 &&
      Math.abs(det3.quad[5] - 149) <= 5,
    "low-contrast: quad is the PAGE, not the merged frame",
    JSON.stringify(det3.quad)
  );

  // Luma-cliff scene (regression lock for the >>8 fix): a page whose
  // brightness GRADIENT crosses 128 on a dark desk. With the old >>7 luma
  // (2v mod 256), the page's top half wrapped bright and its bottom half
  // wrapped dark — the page split and detection fell apart. The fixed
  // luma keeps the page one bright region against the desk.
  const W4 = 240;
  const H4 = 180;
  const cliff = makeScene(
    W4,
    H4,
    [
      [40, 30],
      [200, 30],
      [200, 150],
      [40, 150],
    ],
    [30, 30, 30],
    [128, 128, 128] // placeholder — overwritten below
  );
  for (let y = 30; y <= 150; y += 1) {
    for (let x = 40; x <= 200; x += 1) {
      const v = Math.round(120 + ((y - 30) / 120) * 16); // 120..136, crosses 128
      const o = (y * W4 + x) * 4;
      cliff.data[o] = v;
      cliff.data[o + 1] = v;
      cliff.data[o + 2] = v;
    }
  }
  const det4 = detectDocumentQuad(cliff.data, W4, H4);
  ok(det4.confidence > 0.35, "luma-cliff: page found", `conf=${det4.confidence}`);
  ok(
    Math.abs(det4.quad[0] - 41) <= 5 &&
      Math.abs(det4.quad[1] - 31) <= 5 &&
      Math.abs(det4.quad[4] - 199) <= 5 &&
      Math.abs(det4.quad[5] - 149) <= 5,
    "luma-cliff: gradient page stays whole (luma monotonicity)",
    JSON.stringify(det4.quad)
  );
}

console.log("scan-pdf engine — Round-7 model (adjust + presets)");
{
  const pages = createInitialScanPages(2);
  ok(pages.every((p) => p.adjust.brightness === 0 && p.adjust.contrast === 0), "model: initial adjust zero");
  ok(!pageIsEnhanced(pages[0]), "model: initial page not enhanced");

  const adjusted = setScanAdjust(pages, [0], { brightness: 12, contrast: -8 });
  ok(
    adjusted[0].adjust.brightness === 12 && adjusted[0].adjust.contrast === -8,
    "model: setScanAdjust sets values"
  );
  ok(adjusted[1].adjust.brightness === 0, "model: setScanAdjust leaves others");
  ok(pageIsEnhanced(adjusted[0]), "model: adjusted page is enhanced");
  const filteredOnly = setScanFilter(pages, [1], "vivid");
  ok(pageIsEnhanced(filteredOnly[1]), "model: filter counts as enhanced");

  // Serialize round-trip now carries adjust (6-field rows).
  const serialized = serializeScanPages(adjusted);
  const parsed = parseScanPagesOption(serialized, 2);
  ok(parsed !== null && parsed[0].adjust.brightness === 12 && parsed[0].adjust.contrast === -8, "model: adjust round-trip");
  // Adjust values clamp on parse.
  const clampedParse = parseScanPagesOption(
    '[[0,0,"original",[0,0,1,0,1,1,0,1],999,-999]]',
    1
  );
  ok(
    clampedParse !== null && clampedParse[0].adjust.brightness === 40 && clampedParse[0].adjust.contrast === -40,
    "model: parse clamps adjust"
  );
  // Legacy 4-field rows (Round ≤6 shape) still parse with zero adjust.
  const legacy = parseScanPagesOption(
    '[[0,90,"bw",[0,0,1,0,1,1,0,1]]]',
    1
  );
  ok(
    legacy !== null && legacy[0].rotation === 90 && legacy[0].filter === "bw" &&
      legacy[0].adjust.brightness === 0 && legacy[0].adjust.contrast === 0,
    "model: legacy 4-field rows parse"
  );
  // 5-field rows are rejected (no half shapes).
  ok(parseScanPagesOption('[[0,0,"bw",[0,0,1,0,1,1,0,1],5]]', 1) === null, "model: 5-field rows rejected");
  // New filter ids parse.
  ok(
    parseScanPagesOption('[[0,0,"ocrbw",[0,0,1,0,1,1,0,1],0,0]]', 1) !== null,
    "model: ocrbw parses"
  );

  // Presets.
  ok(SCAN_PRESETS.length === 5, "presets: five presets", String(SCAN_PRESETS.length));
  ok(PRESET_SPECS.document.filter === "magic" && PRESET_SPECS.document.autoStraighten === true && PRESET_SPECS.document.pageSize === "a4", "presets: document spec");
  ok(PRESET_SPECS.photo.filter === "original" && PRESET_SPECS.photo.autoStraighten === false, "presets: photo spec");
  ok(PRESET_SPECS.signature.filter === "ocrbw", "presets: signature uses OCR black");
  ok(PRESET_SPECS.book.pageSize === "fit", "presets: book fits page");
}

console.log("scan-pdf engine — Round-7 worker + surface wiring locks");
{
  const read = (p: string) => readFileSync(p, "utf8");
  const worker = read("tools/scan-pdf/worker.ts");
  const surface = read("tools/scan-pdf/surface.tsx");
  const config = read("tools/scan-pdf/config.ts");

  ok(worker.includes("applyAdjustments(warped, page.adjust)"), "worker: adjustments applied after filter");
  ok(worker.includes("autoDeskew(warped)"), "worker: two-pass deskew applied");
  ok(worker.includes("autoStraighten !== false"), "worker: autoStraighten option honoured");
  ok(worker.includes("options.docName"), "worker: docName option read");

  ok(surface.includes("FilterThumb"), "surface: filter thumbnails rendered");
  ok(surface.includes('id="scan-brightness"') && surface.includes('id="scan-contrast"'), "surface: brightness + contrast sliders");
  ok(surface.includes('role="switch"'), "surface: apply-to-all switch");
  ok(surface.includes("onChangeFilter(entry.id, applyAll)"), "surface: filter honours apply-all scope");
  ok(surface.includes("runAutoEnhance"), "surface: AUTO enhance button");
  ok(surface.includes('onChain("ocr-pdf")'), "surface: OCR chain button");
  ok(surface.includes("SCAN_PRESETS.map"), "surface: preset chips rendered");
  ok(surface.includes("PRESET_SPECS[preset].filter"), "surface: new pages adopt preset filter");
  ok(
    surface.includes('viewBox="0 0 100 100"') && surface.includes("normalizeQuad(det.quad, width, height)"),
    "surface: camera overlay coordinate fix (normalized quad + 0..100 viewBox)"
  );
  ok(surface.includes("stableTickRef.current + 1"), "surface: auto-capture stability counter");
  ok(surface.includes("count >= 4"), "surface: auto-capture fires at 4 stable ticks");
  ok(surface.includes("autoCooldownRef.current = Date.now() + 2500"), "surface: auto-capture cooldown");
  ok(surface.includes("Grid3x3"), "surface: composition grid toggle");
  ok(surface.includes("autoStraighten={values.autoStraighten !== false}"), "surface: editor gets autoStraighten option");

  ok(config.includes('"ocr-pdf"'), "config: OCR first in chain targets");
  ok(config.includes('id: "autoStraighten"') && config.includes('default: true'), "config: autoStraighten switch");
  ok(config.includes('id: "docName"'), "config: docName text option");

  // i18n: every new key exists in BOTH locales with real HI.
  const en = JSON.parse(read("src/i18n/en.json")) as { scan: Record<string, unknown> };
  const hi = JSON.parse(read("src/i18n/hi.json")) as { scan: Record<string, unknown> };
  const filterEn = en.scan.filter as Record<string, string>;
  const filterHi = hi.scan.filter as Record<string, string>;
  for (const id of ["vivid", "soft", "sharpbw", "ocrbw"]) {
    ok(typeof filterEn[id] === "string" && filterEn[id].length > 0, `i18n: filter.${id} EN`);
    ok(/[\u0900-\u097F]/.test(filterHi[id] ?? ""), `i18n: filter.${id} HI is Devanagari`);
  }
  const presetEn = en.scan.preset as Record<string, string>;
  const presetHi = hi.scan.preset as Record<string, string>;
  for (const id of ["document", "photo", "idcard", "book", "signature"]) {
    ok(typeof presetEn[id] === "string" && presetEn[id].length > 0, `i18n: preset.${id} EN`);
    ok(/[\u0900-\u097F]/.test(presetHi[id] ?? ""), `i18n: preset.${id} HI is Devanagari`);
  }
  for (const key of [
    "adjustTitle",
    "brightness",
    "contrast",
    "adjustReset",
    "applyAll",
    "autoEnhance",
    "presetTitle",
    "presetApplied",
    "presetOff",
    "detectText",
    "detectTextHint",
    "autoCapture",
    "autoCaptureOn",
    "autoCaptureIn",
    "gridLines",
  ]) {
    ok(
      typeof en.scan[key] === "string" && (en.scan[key] as string).length > 0,
      `i18n: scan.${key} EN`
    );
    ok(
      typeof hi.scan[key] === "string" && /[\u0900-\u097F]/.test(hi.scan[key] as string),
      `i18n: scan.${key} HI is Devanagari`
    );
  }
  // Param coverage: keys with {count} must keep it in both locales.
  for (const key of ["applyAll", "presetApplied", "autoCaptureIn"]) {
    ok((en.scan[key] as string).includes("{count}"), `i18n: ${key} EN keeps {{count}}`);
    ok((hi.scan[key] as string).includes("{count}"), `i18n: ${key} HI keeps {{count}}`);
  }
}

console.log("");
console.log(`scan-pdf engine: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
