/**
 * Perspective correction + scanner filters for Scan to PDF (PRD §8.5).
 * Pure TS on raw RGBA buffers: solves the document→rectangle
 * homography, inverse-maps it with bilinear sampling, then applies the
 * PRD filter set. No DOM — Node-testable, Worker-run.
 */

import type { Point, Quad } from "./detect";

export type ScanFilter = "original" | "magic" | "bw" | "gray";

/* ------------------------------------------------------------------ */
/* Homography (direct linear transform on 4 point pairs)                */
/* ------------------------------------------------------------------ */

/**
 * Solve H (3×3, last element fixed at 1) mapping dst points to src
 * points — the INVERSE direction warpPerspective needs, so the output
 * raster pass is a pure multiply per pixel.
 */
export function computeHomography(
  src: [Point, Point, Point, Point],
  dst: [Point, Point, Point, Point]
): number[] | null {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x: xs, y: ys } = src[i];
    const { x: xd, y: yd } = dst[i];
    A.push([xd, yd, 1, 0, 0, 0, -xd * xs, -yd * xs]);
    b.push(xs);
    A.push([0, 0, 0, xd, yd, 1, -xd * ys, -yd * ys]);
    b.push(ys);
  }
  // Gaussian elimination with partial pivoting on the 8×8 system.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    }
    if (Math.abs(A[pivot][col]) < 1e-12) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const factor = A[row][col] / A[col][col];
      if (factor === 0) continue;
      for (let k = col; k < 8; k++) A[row][k] -= factor * A[col][k];
      b[row] -= factor * b[col];
    }
  }
  const h: number[] = new Array(9).fill(0);
  for (let i = 0; i < 8; i++) h[i] = b[i] / A[i][i];
  h[8] = 1;
  return h;
}

/** Output size from the source quad's edge lengths (max of opposite sides). */
export function warpTargetSize(quad: Quad, maxPixels = 20_000_000): { width: number; height: number } {
  const top = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
  const bottom = Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y);
  const left = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
  const right = Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y);
  let width = Math.max(top, bottom);
  let height = Math.max(left, right);
  if (width < 1 || height < 1) return { width: 1, height: 1 };
  const pixels = width * height;
  if (pixels > maxPixels) {
    const scale = Math.sqrt(maxPixels / pixels);
    width *= scale;
    height *= scale;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * Inverse-mapped perspective warp with bilinear sampling.
 * `h` must map OUTPUT (u,v) → SOURCE (x,y); build it with
 * computeHomography(srcCorners, dstRect).
 */
export function warpPerspective(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  h: number[],
  outWidth: number,
  outHeight: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  for (let v = 0; v < outHeight; v++) {
    for (let u = 0; u < outWidth; u++) {
      const w = h[6] * u + h[7] * v + h[8];
      if (w === 0) continue;
      const sx = (h[0] * u + h[1] * v + h[2]) / w;
      const sy = (h[3] * u + h[4] * v + h[5]) / w;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      // Clamp sample window to the source bounds.
      const xa = Math.min(width - 1, Math.max(0, x0));
      const ya = Math.min(height - 1, Math.max(0, y0));
      const xb = Math.min(width - 1, Math.max(0, x0 + 1));
      const yb = Math.min(height - 1, Math.max(0, y0 + 1));
      const i00 = (ya * width + xa) * 4;
      const i10 = (ya * width + xb) * 4;
      const i01 = (yb * width + xa) * 4;
      const i11 = (yb * width + xb) * 4;
      const o = (v * outWidth + u) * 4;
      for (let c = 0; c < 3; c++) {
        const top = rgba[i00 + c] * (1 - fx) + rgba[i10 + c] * fx;
        const bottom = rgba[i01 + c] * (1 - fx) + rgba[i11 + c] * fx;
        out[o + c] = top * (1 - fy) + bottom * fy;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

/** "Magic color" — per-channel percentile stretch + gentle saturation. */
export function filterMagic(rgba: Uint8ClampedArray): void {
  const total = rgba.length / 4;
  if (total < 16) return;
  const hists = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < rgba.length; i += 4) {
    hists[0][rgba[i]]++;
    hists[1][rgba[i + 1]]++;
    hists[2][rgba[i + 2]]++;
  }
  // 0.5%..99.5% percentile per channel → kills colour casts, whitens paper.
  const lowCut = total * 0.005;
  const highCut = total * 0.995;
  const mapR = new Uint8ClampedArray(256);
  const mapG = new Uint8ClampedArray(256);
  const mapB = new Uint8ClampedArray(256);
  const maps = [mapR, mapG, mapB];
  for (let c = 0; c < 3; c++) {
    let acc = 0;
    let lo = 0;
    let hi = 255;
    for (let t = 0; t < 256; t++) {
      acc += hists[c][t];
      if (acc >= lowCut) {
        lo = t;
        break;
      }
    }
    acc = 0;
    for (let t = 255; t >= 0; t--) {
      acc += hists[c][t];
      if (acc >= total - highCut) {
        hi = t;
        break;
      }
    }
    const span = Math.max(1, hi - lo);
    for (let t = 0; t < 256; t++) {
      maps[c][t] = ((Math.min(255, Math.max(0, t - lo)) * 255) / span) | 0;
    }
  }
  for (let i = 0; i < rgba.length; i += 4) {
    let r = mapR[rgba[i]];
    let g = mapG[rgba[i + 1]];
    let b = mapB[rgba[i + 2]];
    // Gentle saturation boost (1.25) around the post-stretch luma.
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    r = lum + (r - lum) * 1.25;
    g = lum + (g - lum) * 1.25;
    b = lum + (b - lum) * 1.25;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
  }
}

/** Grayscale (Rec.601 luma). */
export function filterGray(rgba: Uint8ClampedArray): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    rgba[i] = lum;
    rgba[i + 1] = lum;
    rgba[i + 2] = lum;
  }
}

/**
 * "B&W" — Bradley adaptive threshold (integral image, 1/16th window):
 * crisp text under uneven lighting, where global Otsu would fail.
 */
export function filterBw(rgba: Uint8ClampedArray, width: number, height: number): void {
  const total = width * height;
  const gray = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const j = i * 4;
    gray[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }
  // Integral image with a zero row/col head.
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      integral[(y + 1) * (width + 1) + (x + 1)] =
        integral[y * (width + 1) + (x + 1)] + rowSum;
    }
  }
  const radius = Math.max(4, (Math.min(width, height) / 16) | 0);
  const bias = 8; // mean − 8 → text darker than its neighbourhood wins
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * (width + 1) + (x1 + 1)] -
        integral[y0 * (width + 1) + (x1 + 1)] -
        integral[(y1 + 1) * (width + 1) + x0] +
        integral[y0 * (width + 1) + x0];
      const value = gray[y * width + x] * area;
      const black = value < sum - bias * area ? 0 : 255;
      const j = (y * width + x) * 4;
      rgba[j] = black;
      rgba[j + 1] = black;
      rgba[j + 2] = black;
    }
  }
}

/** Apply a scanner filter in place on a warped RGBA buffer. */
export function applyFilter(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  filter: ScanFilter
): void {
  if (filter === "magic") filterMagic(rgba);
  else if (filter === "gray") filterGray(rgba);
  else if (filter === "bw") filterBw(rgba, width, height);
}

/** Full pipeline: warp the quad out of the frame, then filter it. */
export function warpAndFilter(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  quad: Quad,
  filter: ScanFilter
): { data: Uint8ClampedArray; width: number; height: number } {
  const { width: outWidth, height: outHeight } = warpTargetSize(quad);
  const rect: [Point, Point, Point, Point] = [
    { x: 0, y: 0 },
    { x: outWidth - 1, y: 0 },
    { x: outWidth - 1, y: outHeight - 1 },
    { x: 0, y: outHeight - 1 },
  ];
  const h = computeHomography(quad, rect);
  if (!h) {
    // Degenerate quad — return the raw frame unchanged (caller decides).
    return { data: rgba, width, height };
  }
  const out = warpPerspective(rgba, width, height, h, outWidth, outHeight);
  applyFilter(out, outWidth, outHeight, filter);
  return { data: out, width: outWidth, height: outHeight };
}
