/**
 * Scan to PDF engine (PRD §8.4, tools/scan-pdf) — PURE, DOM-free.
 *
 * Used by BOTH the interactive surface (small preview warps on the main
 * thread) and the worker (full-resolution warps at export time), so the
 * preview is always exactly what the exported page will be.
 *
 * Pipeline per captured/uploaded photo:
 *   1. detectDocumentQuad — Otsu + largest connected component + extreme
 *      points → the document's four corners (with an honest confidence).
 *   2. warpPerspective — homography (solved per page, Gaussian
 *      elimination) + bilinear inverse mapping → a flat, straight scan.
 *   3. applyScanFilter — Original / Magic color / B&W (Bradley adaptive
 *      threshold) / Grayscale, per pixel.
 *   4. rotateQuarter — optional 90° quarter turns after the warp.
 *
 * The page list (source file + quad + filter + rotation) serializes into
 * the "scan" option (same compactness idea as the PageGrid/ImageGrid
 * models) so the worker always receives the exact edited state.
 */

/** Bitmap shape satisfied by DOM/worker ImageData without dragging the DOM in. */
export interface ScanBitmap {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type ScanFilter = "original" | "magic" | "bw" | "gray";

export const SCAN_FILTERS: ScanFilter[] = ["original", "magic", "bw", "gray"];

/**
 * Document quad as 8 numbers: [TLx, TLy, TRx, TRy, BRx, BRy, BLx, BLy].
 * Stored NORMALIZED (0..1 of the source image dimensions) so previews and
 * the full-resolution worker warp agree regardless of decode size.
 */
export type Quad = [number, number, number, number, number, number, number, number];

/** The full-frame quad (no crop). */
export const FULL_FRAME_QUAD: Quad = [0, 0, 1, 0, 1, 1, 0, 1];

export interface ScanPage {
  uid: string;
  /** Index into the workspace `files` array. */
  source: number;
  /** Cumulative quarter turns applied AFTER the warp (0/90/180/270). */
  rotation: number;
  /** Post-warp filter. */
  filter: ScanFilter;
  /** Normalized document corners; edits happen here (manual or auto). */
  quad: Quad;
  /** Whether the current quad came from auto detection (badge copy). */
  autoDetected: boolean;
}

/* --------------------------- page list model --------------------------- */

let uidSeq = 0;
function nextUid(): string {
  uidSeq += 1;
  return `sc-${Date.now().toString(36)}-${uidSeq}`;
}

export function normalizeRotation(rotation: number): number {
  return ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
}

/** Natural order — one page per file, full-frame, no filter, no rotation. */
export function createInitialScanPages(fileCount: number): ScanPage[] {
  return Array.from({ length: fileCount }, (_, source) => ({
    uid: nextUid(),
    source,
    rotation: 0,
    filter: "original",
    quad: [...FULL_FRAME_QUAD] as Quad,
    autoDetected: false,
  }));
}

export function serializeScanPages(pages: ScanPage[]): string {
  return JSON.stringify(
    pages.map((page) => [
      page.source,
      page.rotation,
      page.filter,
      Array.from(page.quad, (v) => Math.round(v * 1e4) / 1e4),
    ])
  );
}

/**
 * Parses the "scan" option. Falls back to the natural order for missing
 * values (initial state); null only for structurally invalid data — the
 * CTA gate treats that as "no pages" rather than guessing.
 */
export function parseScanPagesOption(
  value: unknown,
  fileCount: number
): ScanPage[] | null {
  if (value === undefined || value === null || value === "") {
    return createInitialScanPages(fileCount);
  }
  if (typeof value !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const pages: ScanPage[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 4) return null;
    const [source, rotation, filter, quad] = item;
    if (
      typeof source !== "number" ||
      !Number.isInteger(source) ||
      source < 0 ||
      source >= fileCount
    ) {
      return null;
    }
    if (
      typeof rotation !== "number" ||
      ![0, 90, 180, 270].includes(rotation)
    ) {
      return null;
    }
    if (typeof filter !== "string" || !SCAN_FILTERS.includes(filter as ScanFilter)) {
      return null;
    }
    if (!Array.isArray(quad) || quad.length !== 8) return null;
    let ok = true;
    const quadOut: number[] = [];
    for (const v of quad) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < -0.05 || v > 1.05) {
        ok = false;
        break;
      }
      quadOut.push(Math.min(1, Math.max(0, v)));
    }
    if (!ok) return null;
    pages.push({
      uid: nextUid(),
      source,
      rotation,
      filter: filter as ScanFilter,
      quad: quadOut as Quad,
      autoDetected: false,
    });
  }
  return pages;
}

/* ------------------------------ pure ops ------------------------------ */

export function deleteScanPages(pages: ScanPage[], indices: number[]): ScanPage[] {
  const targets = new Set(indices);
  return pages.filter((_, index) => !targets.has(index));
}

export function rotateScanPages(
  pages: ScanPage[],
  indices: number[],
  delta: number
): ScanPage[] {
  const targets = new Set(indices);
  return pages.map((page, index) =>
    targets.has(index)
      ? { ...page, rotation: normalizeRotation(page.rotation + delta) }
      : page
  );
}

export function setScanFilter(
  pages: ScanPage[],
  indices: number[],
  filter: ScanFilter
): ScanPage[] {
  const targets = new Set(indices);
  return pages.map((page, index) =>
    targets.has(index) ? { ...page, filter } : page
  );
}

export function moveScanPage(
  pages: ScanPage[],
  from: number,
  to: number
): ScanPage[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= pages.length ||
    to >= pages.length
  ) {
    return pages;
  }
  const next = [...pages];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Reconciles the edited list against the live workspace files (add-more,
 * chain handoff, removals) — keeps surviving pages in their edited order
 * and appends full-frame defaults for brand-new files.
 */
export function reconcileScanPages(
  pages: ScanPage[],
  fileCount: number,
  previousCount: number
): ScanPage[] {
  if (fileCount === previousCount) return pages;
  const next: ScanPage[] = [];
  const seen = new Set<number>();
  for (const page of pages) {
    if (page.source < fileCount && !seen.has(page.source)) {
      next.push(page);
      seen.add(page.source);
    }
  }
  for (let source = 0; source < fileCount; source += 1) {
    if (!seen.has(source)) {
      next.push({
        uid: nextUid(),
        source,
        rotation: 0,
        filter: "original",
        quad: [...FULL_FRAME_QUAD] as Quad,
        autoDetected: false,
      });
    }
  }
  return next;
}

/* --------------------------- quad detection --------------------------- */

export interface QuadDetection {
  /** Absolute pixel corners at the input image's scale. */
  quad: Quad;
  /** 0 (no confident document — caller shows "adjust corners") … 1. */
  confidence: number;
  /** Which mask produced the quad ("bright" document on dark desk, etc). */
  polarity: "bright" | "dark" | "none";
}

function otsuThreshold(lum: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < lum.length; i += 1) hist[lum[i]] += 1;
  const total = lum.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

interface ComponentInfo {
  area: number;
  /** Extreme-point pixel holders: min(x+y), max(x+y), max(x−y), min(x−y). */
  minSum: [number, number];
  maxSum: [number, number];
  maxDiff: [number, number];
  minDiff: [number, number];
  bbox: [number, number, number, number]; // minX, minY, maxX, maxY
}

/** Largest 8-connected component of `mask` (1 = inside). */
function largestComponent(
  mask: Uint8Array,
  width: number,
  height: number
): ComponentInfo | null {
  const labels = new Int32Array(width * height).fill(-1);
  let best: ComponentInfo | null = null;
  const stack = new Int32Array(width * height);
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || labels[start] !== -1) continue;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = start;
    let area = 0;
    let minSumX = 0;
    let minSumY = 0;
    let minSumV = Infinity;
    let maxSumX = 0;
    let maxSumY = 0;
    let maxSumV = -Infinity;
    let maxDiffX = 0;
    let maxDiffY = 0;
    let maxDiffV = -Infinity;
    let minDiffX = 0;
    let minDiffY = 0;
    let minDiffV = Infinity;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % width;
      const y = (idx - x) / width;
      area += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      const sum = x + y;
      if (sum < minSumV) {
        minSumV = sum;
        minSumX = x;
        minSumY = y;
      }
      if (sum > maxSumV) {
        maxSumV = sum;
        maxSumX = x;
        maxSumY = y;
      }
      const diff = x - y;
      if (diff > maxDiffV) {
        maxDiffV = diff;
        maxDiffX = x;
        maxDiffY = y;
      }
      if (diff < minDiffV) {
        minDiffV = diff;
        minDiffX = x;
        minDiffY = y;
      }
      // 8-connected neighbours.
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (mask[n] === 1 && labels[n] === -1) {
            labels[n] = start;
            stack[sp++] = n;
          }
        }
      }
    }
    const info: ComponentInfo = {
      area,
      minSum: [minSumX, minSumY],
      maxSum: [maxSumX, maxSumY],
      maxDiff: [maxDiffX, maxDiffY],
      minDiff: [minDiffX, minDiffY],
      bbox: [minX, minY, maxX, maxY],
    };
    if (best === null || info.area > best.area) best = info;
  }
  return best;
}

function quadAreaOf(q: Quad): number {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  let area = 0;
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4;
    area += xs[i] * ys[j] - xs[j] * ys[i];
  }
  return Math.abs(area) / 2;
}

/**
 * Finds the document in an RGBA image. Caller passes an already
 * downscaled frame (≈200–320 px long edge keeps this under ~10 ms).
 * Honest about failure: a uniform or fully-covered frame returns the
 * full-frame quad with confidence 0 — the surface then asks the user to
 * adjust corners instead of cropping something imaginary.
 */
export function detectDocumentQuad(
  data: Uint8ClampedArray,
  width: number,
  height: number
): QuadDetection {
  const pixels = width * height;
  const lum = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    lum[i] =
      (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 7;
  }

  const fullFrame: Quad = [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1];
  if (pixels < 16) {
    return { quad: fullFrame, confidence: 0, polarity: "none" };
  }

  const threshold = otsuThreshold(lum);
  const brightMask = new Uint8Array(pixels);
  const darkMask = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    if (lum[i] > threshold) brightMask[i] = 1;
    else darkMask[i] = 1;
  }

  const candidates: { info: ComponentInfo; polarity: "bright" | "dark" }[] = [];
  const bright = largestComponent(brightMask, width, height);
  if (bright) candidates.push({ info: bright, polarity: "bright" });
  const dark = largestComponent(darkMask, width, height);
  if (dark) candidates.push({ info: dark, polarity: "dark" });

  let best: { quad: Quad; confidence: number; score: number; polarity: "bright" | "dark" } | null =
    null;
  for (const candidate of candidates) {
    const { info } = candidate;
    const fraction = info.area / pixels;
    // The document must dominate the frame without covering ALL of it —
    // a full-frame mask means Otsu split nothing useful.
    if (fraction < 0.08 || fraction > 0.985) continue;
    const [minX, minY, maxX, maxY] = info.bbox;
    const bboxArea = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
    // Inset 1 px so the warp doesn't sample the background rim.
    const inset = 1;
    const clamp = (v: number, lo: number, hi: number) =>
      Math.min(hi, Math.max(lo, v));
    const quad: Quad = [
      clamp(info.minSum[0] + inset, 0, width - 1),
      clamp(info.minSum[1] + inset, 0, height - 1),
      clamp(info.maxDiff[0] - inset, 0, width - 1),
      clamp(info.maxDiff[1] + inset, 0, height - 1),
      clamp(info.maxSum[0] - inset, 0, width - 1),
      clamp(info.maxSum[1] - inset, 0, height - 1),
      clamp(info.minDiff[0] + inset, 0, width - 1),
      clamp(info.minDiff[1] - inset, 0, height - 1),
    ];
    const qArea = quadAreaOf(quad);
    const rectangularity = qArea / bboxArea;
    // A paper sheet photographs as a near-rectangle; blobs below ~0.6 are
    // usually hands/objects, not the page.
    if (rectangularity < 0.6) continue;
    // Fill ratio — how much of its own quad the component actually covers.
    // A solid document ≈ 1.0; the desk RING around it hugs the frame
    // corners yet covers only a fraction of the quad it implies, so this
    // is what keeps detection locked on the page instead of the desk.
    const fillRatio = Math.min(1, info.area / qArea);
    if (fillRatio < 0.55) continue;
    const coverage = qArea / pixels;
    const confidence = Math.min(
      1,
      Math.max(0.35, rectangularity * fillRatio * Math.min(1, coverage / 0.25))
    );
    const score = coverage * rectangularity * fillRatio;
    if (best === null || score > best.score) {
      best = { quad, confidence, score, polarity: candidate.polarity };
    }
  }

  if (best === null) {
    return { quad: fullFrame, confidence: 0, polarity: "none" };
  }
  return { quad: best.quad, confidence: best.confidence, polarity: best.polarity };
}

/* -------------------------- homography warp -------------------------- */

/**
 * Solves the 3×3 homography (h33 = 1) mapping `from` points to `to`
 * points via Gaussian elimination with partial pivoting. Points are
 * [x, y] pairs; returns [a, b, c, d, e, f, g, h] such that
 * x' = (a·x + b·y + c) / (g·x + h·y + 1), y' = (d·x + e·y + f) / (g·x + h·y + 1).
 */
export function solveHomography(
  from: [number, number][],
  to: [number, number][]
): number[] | null {
  const n = 8;
  const m: number[][] = [];
  for (let i = 0; i < 4; i += 1) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    m.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    m.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = m[row][col] / m[col][col];
      for (let k = col; k <= n; k += 1) {
        m[row][k] -= factor * m[col][k];
      }
    }
  }
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) out[i] = m[i][n] / m[i][i];
  return out;
}

/** Output size for a quad, long edge capped at `maxEdge` (min 16 px). */
export function quadOutputSize(
  quad: Quad,
  maxEdge: number
): { width: number; height: number } {
  const dist = (x1: number, y1: number, x2: number, y2: number) =>
    Math.hypot(x2 - x1, y2 - y1);
  const w = (dist(quad[0], quad[1], quad[2], quad[3]) +
    dist(quad[6], quad[7], quad[4], quad[5])) / 2;
  const h = (dist(quad[0], quad[1], quad[6], quad[7]) +
    dist(quad[2], quad[3], quad[4], quad[5])) / 2;
  const scale = maxEdge / Math.max(w, h);
  return {
    width: Math.max(16, Math.round(w * scale)),
    height: Math.max(16, Math.round(h * scale)),
  };
}

/**
 * Warps the quad out of `src` into a flat rectangle (`outW` × `outH`) with
 * bilinear sampling; samples that fall outside the source are white (a
 * scan page look, not transparent black). Allocates the output.
 */
export function warpPerspective(
  src: ScanBitmap,
  quad: Quad,
  outW: number,
  outH: number
): ScanBitmap {
  const { data, width: sw, height: sh } = src;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const dstCorners: [number, number][] = [
    [0, 0],
    [outW, 0],
    [outW, outH],
    [0, outH],
  ];
  const quadPts: [number, number][] = [
    [quad[0], quad[1]],
    [quad[2], quad[3]],
    [quad[4], quad[5]],
    [quad[6], quad[7]],
  ];
  const h = solveHomography(dstCorners, quadPts);
  if (h === null) {
    // Degenerate quad (all corners collinear) → blank white page, honest.
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    return { data: out, width: outW, height: outH };
  }
  const [a, b, c, d, e, f, g, hh] = h;

  const maxX = sw - 1;
  const maxY = sh - 1;
  let di = 0;
  for (let v = 0; v < outH; v += 1) {
    for (let u = 0; u < outW; u += 1) {
      const denom = g * u + hh * v + 1;
      const x = (a * u + b * v + c) / denom;
      const y = (d * u + e * v + f) / denom;
      if (x < -1 || y < -1 || x > maxX + 1 || y > maxY + 1) {
        // Outside (with 1px grace for the bilinear clamp) → white.
        out[di] = 255;
        out[di + 1] = 255;
        out[di + 2] = 255;
        out[di + 3] = 255;
      } else {
        const x0 = Math.max(0, Math.min(maxX, Math.floor(x)));
        const y0 = Math.max(0, Math.min(maxY, Math.floor(y)));
        const x1 = Math.min(maxX, x0 + 1);
        const y1 = Math.min(maxY, y0 + 1);
        const fx = Math.max(0, Math.min(1, x - x0));
        const fy = Math.max(0, Math.min(1, y - y0));
        const si00 = (y0 * sw + x0) * 4;
        const si10 = (y0 * sw + x1) * 4;
        const si01 = (y1 * sw + x0) * 4;
        const si11 = (y1 * sw + x1) * 4;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        for (let ch = 0; ch < 4; ch += 1) {
          out[di + ch] =
            data[si00 + ch] * w00 +
            data[si10 + ch] * w10 +
            data[si01 + ch] * w01 +
            data[si11 + ch] * w11;
        }
      }
      di += 4;
    }
  }
  return { data: out, width: outW, height: outH };
}

/* ------------------------------ filters ------------------------------ */

/**
 * "Magic color" — the scanner-app favourite: per-channel percentile
 * contrast stretch (1%…99%) plus a 1.25× saturation lift. Documents come
 * out looking lit by a flatbed even under yellow indoor light.
 */
export function applyMagicColor(bmp: ScanBitmap): void {
  const { data, width, height } = bmp;
  const pixels = width * height;
  const target = Math.max(1, Math.round(pixels * 0.01));
  const low: [number, number, number] = [0, 0, 0];
  const high: [number, number, number] = [255, 255, 255];
  for (let ch = 0; ch < 3; ch += 1) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < pixels; i += 1) hist[data[i * 4 + ch]] += 1;
    let acc = 0;
    let lo = 0;
    for (let v = 0; v < 256; v += 1) {
      acc += hist[v];
      if (acc >= target) {
        lo = v;
        break;
      }
    }
    acc = 0;
    let hi = 255;
    for (let v = 255; v >= 0; v -= 1) {
      acc += hist[v];
      if (acc >= target) {
        hi = v;
        break;
      }
    }
    low[ch] = lo;
    high[ch] = Math.max(lo + 8, hi); // keep at least a small range
  }
  for (let i = 0; i < pixels; i += 1) {
    const o = i * 4;
    let r = ((data[o] - low[0]) * 255) / (high[0] - low[0]);
    let g = ((data[o + 1] - low[1]) * 255) / (high[1] - low[1]);
    let b = ((data[o + 2] - low[2]) * 255) / (high[2] - low[2]);
    const gray = r * 0.299 + g * 0.587 + b * 0.114;
    r = gray + (r - gray) * 1.25;
    g = gray + (g - gray) * 1.25;
    b = gray + (b - gray) * 1.25;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
  }
}

export function applyGrayscale(bmp: ScanBitmap): void {
  const { data } = bmp;
  for (let o = 0; o < data.length; o += 4) {
    const y = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 7;
    data[o] = y;
    data[o + 1] = y;
    data[o + 2] = y;
  }
}

/**
 * "B&W" — Bradley adaptive threshold (integral image, window ≈ min-side/8,
 * bias 0.15): crisp text pages like a real scanner's line-art mode, and
 * it survives uneven lighting far better than a global threshold.
 */
export function applyAdaptiveBW(bmp: ScanBitmap): void {
  const { data, width, height } = bmp;
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const l = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 7;
      rowSum += l;
      integral[(y + 1) * (width + 1) + (x + 1)] =
        integral[y * (width + 1) + (x + 1)] + rowSum;
    }
  }
  const window = Math.max(16, Math.floor(Math.min(width, height) / 8));
  const half = window >> 1;
  const bias = 1 - 0.15;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(height - 1, y + half);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(width - 1, x + half);
      const count = (y1 - y0 + 1) * (x1 - x0 + 1);
      const sum =
        integral[(y1 + 1) * (width + 1) + (x1 + 1)] -
        integral[y0 * (width + 1) + (x1 + 1)] -
        integral[(y1 + 1) * (width + 1) + x0] +
        integral[y0 * (width + 1) + x0];
      const mean = sum / count;
      const o = (y * width + x) * 4;
      const l = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 7;
      const v = l <= mean * bias ? 0 : 255;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
    }
  }
}

/** Applies a scan filter in place ("original" is a no-op by design). */
export function applyScanFilter(bmp: ScanBitmap, filter: ScanFilter): void {
  if (filter === "magic") applyMagicColor(bmp);
  else if (filter === "gray") applyGrayscale(bmp);
  else if (filter === "bw") applyAdaptiveBW(bmp);
}

/** Quarter-turn rotation (0/90/180/270, clockwise) — allocates when ≠ 0. */
export function rotateQuarter(bmp: ScanBitmap, rotation: number): ScanBitmap {
  const { data, width, height } = bmp;
  if (rotation === 0) return bmp;
  const outW = rotation === 180 ? width : height;
  const outH = rotation === 180 ? height : width;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let dx: number;
      let dy: number;
      if (rotation === 90) {
        dx = height - 1 - y;
        dy = x;
      } else if (rotation === 180) {
        dx = width - 1 - x;
        dy = height - 1 - y;
      } else {
        dx = y;
        dy = width - 1 - x;
      }
      const si = (y * width + x) * 4;
      const di = (dy * outW + dx) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return { data: out, width: outW, height: outH };
}

/** Scales a normalized quad into absolute pixel coordinates. */
export function denormalizeQuad(quad: Quad, width: number, height: number): Quad {
  return [
    quad[0] * width, quad[1] * height,
    quad[2] * width, quad[3] * height,
    quad[4] * width, quad[5] * height,
    quad[6] * width, quad[7] * height,
  ];
}

/** Scales an absolute pixel quad into normalized 0..1 coordinates. */
export function normalizeQuad(quad: Quad, width: number, height: number): Quad {
  return [
    quad[0] / width, quad[1] / height,
    quad[2] / width, quad[3] / height,
    quad[4] / width, quad[5] / height,
    quad[6] / width, quad[7] / height,
  ];
}
