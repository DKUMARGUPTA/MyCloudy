/**
 * Document edge detection for Scan to PDF (PRD §8.5) — pure TS on raw
 * RGBA pixels: no DOM, no Worker globals, runs in the browser main
 * thread (a few ms on a downscaled frame) and in Node smoke tests.
 *
 * Pipeline (the classic lightweight scanner stack):
 *  1. box-downscale to ~DETECT_W px wide grayscale
 *  2. Otsu threshold → binary; BOTH polarities are tried (page usually
 *     brighter than the desk, but dark covers on white tables exist)
 *  3. morphological close (dilate+erode 3×3) to seal text holes
 *  4. connected components (4-connected BFS); the largest per polarity
 *     is the page candidate
 *  5. convex hull (monotone chain) of the candidate's boundary pixels
 *  6. max-area quadrilateral from hull points (hill-climbing on the
 *     shoelace area — converges to the document corners)
 *  7. score both candidates (quad-ness + area sanity + interior
 *     uniformity — pages are flat/uniform, desks are cluttered) and
 *     return the better one with a confidence value
 *
 * Corners are returned in full-resolution coordinates, ordered
 * TL → TR → BR → BL (screen convention).
 */

export interface Point {
  x: number;
  y: number;
}

/** Ordered TL, TR, BR, BL. */
export type Quad = [Point, Point, Point, Point];

export interface DetectResult {
  quad: Quad;
  /** 0..1 heuristic — UI gates the "document found" state on it. */
  confidence: number;
  /** Quad area / frame area (0..1). */
  areaRatio: number;
}

export interface DetectOptions {
  /** Working width in pixels (height follows aspect). Default 160. */
  targetWidth?: number;
  /**
   * Coordinate space of the returned quad — the ORIGINAL frame size when
   * the caller passes a pre-downscaled buffer (e.g. a 160-px sniff frame
   * drawn from a 1280-px video). Defaults to the input buffer dims.
   */
  frameWidth?: number;
  frameHeight?: number;
}

const DETECT_W = 160;
/** Dilate/erode radius (low-res pixels) for the morphological close. */
const CLOSE_R = 1;

/* ------------------------------------------------------------------ */
/* Step 1 — downscale to grayscale                                     */
/* ------------------------------------------------------------------ */

/** Box-average downscale of RGBA → single-channel Float32 gray [0..255]. */
export function downscaleGray(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  targetWidth: number
): { data: Float32Array; width: number; height: number } {
  const scale = Math.min(1, targetWidth / width);
  const w = Math.max(8, Math.round(width * scale));
  const h = Math.max(8, Math.round(height * scale));
  const out = new Float32Array(w * h);
  const cellW = width / w;
  const cellH = height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * cellH);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * cellH));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * cellW);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * cellW));
      let sum = 0;
      let count = 0;
      for (let yy = y0; yy < y1 && yy < height; yy++) {
        for (let xx = x0; xx < x1 && xx < width; xx++) {
          const i = (yy * width + xx) * 4;
          // Rec.601 luma — cheap and fine for thresholding.
          sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
          count++;
        }
      }
      out[y * w + x] = count > 0 ? sum / count : 0;
    }
  }
  return { data: out, width: w, height: h };
}

/* ------------------------------------------------------------------ */
/* Step 2 — Otsu threshold                                             */
/* ------------------------------------------------------------------ */

/** Otsu's method on 256-bin gray histogram; returns the cut (0..255). */
export function otsuThreshold(gray: Float32Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) {
    hist[Math.min(255, Math.max(0, Math.round(gray[i])))]++;
  }
  const total = gray.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];

  let sumBg = 0;
  let weightBg = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    weightBg += hist[t];
    if (weightBg === 0) continue;
    const weightFg = total - weightBg;
    if (weightFg === 0) break;
    sumBg += t * hist[t];
    const meanBg = sumBg / weightBg;
    const meanFg = (sumAll - sumBg) / weightFg;
    const between = weightBg * weightFg * (meanBg - meanFg) ** 2;
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Step 3 — morphological close                                        */
/* ------------------------------------------------------------------ */

function morph(
  mask: Uint8Array,
  width: number,
  height: number,
  dilate: boolean
): Uint8Array {
  const out = new Uint8Array(mask.length);
  const r = CLOSE_R;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let hit = dilate ? 0 : 1;
      for (let dy = -r; dy <= r && (dilate ? !hit : hit); dy++) {
        for (let dx = -r; dx <= r && (dilate ? !hit : hit); dx++) {
          const yy = Math.min(height - 1, Math.max(0, y + dy));
          const xx = Math.min(width - 1, Math.max(0, x + dx));
          const v = mask[yy * width + xx];
          if (dilate && v) hit = 1;
          if (!dilate && !v) hit = 0;
        }
      }
      out[i] = hit;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Step 4 — connected components                                       */
/* ------------------------------------------------------------------ */

/**
 * Largest 4-connected component of `mask` (1 = keep), preferring one that
 * does NOT touch the frame border: a desk surface always bleeds out of
 * frame, so its region touches the border, while a page floats inside.
 * Falls back to the overall largest when every component touches (page
 * fills the frame / is clipped).
 */
export function largestComponent(
  mask: Uint8Array,
  width: number,
  height: number
): { pixels: number[]; count: number } {
  const labels = new Int32Array(mask.length).fill(-1);
  let best: number[] = [];
  let bestCount = 0;
  let bestInterior: number[] = [];
  let bestInteriorCount = 0;
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || labels[start] !== -1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = start;
    const pixels: number[] = [];
    let touchesBorder = false;
    while (head < tail) {
      const i = queue[head++];
      pixels.push(i);
      const x = i % width;
      const y = (i - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        touchesBorder = true;
      }
      if (x > 0 && mask[i - 1] === 1 && labels[i - 1] === -1) {
        labels[i - 1] = start;
        queue[tail++] = i - 1;
      }
      if (x < width - 1 && mask[i + 1] === 1 && labels[i + 1] === -1) {
        labels[i + 1] = start;
        queue[tail++] = i + 1;
      }
      if (y > 0 && mask[i - width] === 1 && labels[i - width] === -1) {
        labels[i - width] = start;
        queue[tail++] = i - width;
      }
      if (y < height - 1 && mask[i + width] === 1 && labels[i + width] === -1) {
        labels[i + width] = start;
        queue[tail++] = i + width;
      }
    }
    if (pixels.length > bestCount) {
      bestCount = pixels.length;
      best = pixels;
    }
    if (!touchesBorder && pixels.length > bestInteriorCount) {
      bestInteriorCount = pixels.length;
      bestInterior = pixels;
    }
  }
  if (bestInteriorCount > 0 && bestInteriorCount >= bestCount * 0.25) {
    return { pixels: bestInterior, count: bestInteriorCount };
  }
  return { pixels: best, count: bestCount };
}

/* ------------------------------------------------------------------ */
/* Step 5 — convex hull (monotone chain)                               */
/* ------------------------------------------------------------------ */

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

export function convexHull(points: Point[]): Point[] {
  if (points.length <= 3) return points.slice();
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/* ------------------------------------------------------------------ */
/* Step 6 — max-area quadrilateral from the hull                        */
/* ------------------------------------------------------------------ */

function polygonArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

/**
 * Hill-climb the hull indices to maximize the shoelace area of the
 * chosen 4 points. Starts from four equally spaced hull points, then
 * repeatedly moves one index to a hull neighbour when that grows the
 * quadrilateral. Converges in a few passes on real document hulls.
 */
export function maxAreaQuad(hull: Point[]): [Point, Point, Point, Point] {
  const n = hull.length;
  if (n < 4) {
    // Degenerate hull — pad by repeating points; caller scores it low.
    const pts: Point[] = [];
    for (let i = 0; i < 4; i++) pts.push(hull[Math.min(i, Math.max(0, n - 1))] ?? { x: 0, y: 0 });
    return [pts[0], pts[1], pts[2], pts[3]];
  }
  const idx = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4)];
  const areaAt = (ids: number[]): number => {
    const quad = ids.map((i) => hull[i]);
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % 4];
      area += a.x * b.y - b.x * a.y;
    }
    return Math.abs(area) / 2;
  };
  let current = areaAt(idx);
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 64) {
    improved = false;
    for (let k = 0; k < 4; k++) {
      for (const step of [1, -1]) {
        const next = idx.slice();
        next[k] = (next[k] + step + n) % n;
        const area = areaAt(next);
        if (area > current + 1e-6) {
          idx[k] = next[k];
          current = area;
          improved = true;
        }
      }
    }
  }
  return [hull[idx[0]], hull[idx[1]], hull[idx[2]], hull[idx[3]]];
}

/* ------------------------------------------------------------------ */
/* Quad helpers                                                        */
/* ------------------------------------------------------------------ */

export function quadArea(quad: Quad): number {
  return polygonArea(quad as unknown as Point[]);
}

/** Order any 4 points into TL, TR, BR, BL (by angle around centroid). */
export function orderQuad(points: Point[]): Quad {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const sorted = points.slice().sort((a, b) => {
    const aa = Math.atan2(a.y - cy, a.x - cx);
    const ba = Math.atan2(b.y - cy, b.x - cx);
    return aa - ba;
  });
  // Angle sort starting anywhere → rotate so [0] is the top-left-most.
  let tl = 0;
  let bestScore = Infinity;
  for (let i = 0; i < 4; i++) {
    // Top-left = min (x + y) among the four.
    const score = sorted[i].x + sorted[i].y;
    if (score < bestScore) {
      bestScore = score;
      tl = i;
    }
  }
  const out = [
    sorted[tl],
    sorted[(tl + 1) % 4],
    sorted[(tl + 2) % 4],
    sorted[(tl + 3) % 4],
  ];
  return out as Quad;
}

/** Mean absolute deviation of interior angles from 90°, in degrees. */
export function quadAngleDeviation(quad: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const p0 = quad[(i + 3) % 4];
    const p1 = quad[i];
    const p2 = quad[(i + 1) % 4];
    const v1x = p0.x - p1.x;
    const v1y = p0.y - p1.y;
    const v2x = p2.x - p1.x;
    const v2y = p2.y - p1.y;
    const dot = v1x * v2x + v1y * v2y;
    const m1 = Math.hypot(v1x, v1y);
    const m2 = Math.hypot(v2x, v2y);
    if (m1 === 0 || m2 === 0) return 90;
    let angle = (Math.acos(Math.min(1, Math.max(-1, dot / (m1 * m2)))) * 180) / Math.PI;
    if (angle > 90) angle = 180 - angle;
    sum += Math.abs(angle - 90);
  }
  return sum / 4;
}

/* ------------------------------------------------------------------ */
/* Candidate scoring + entry point                                     */
/* ------------------------------------------------------------------ */

interface Candidate {
  quad: Quad;
  areaRatio: number;
  score: number;
}

function buildCandidate(
  mask: Uint8Array,
  width: number,
  height: number
): Candidate | null {
  const closed = morph(morph(mask, width, height, true), width, height, false);
  const { pixels, count } = largestComponent(closed, width, height);
  const total = width * height;
  if (count < total * 0.03) return null; // too small to be a page

  // Boundary pixels only (a non-mask 4-neighbour) — hull input stays small.
  const hullInput: Point[] = [];
  for (const i of pixels) {
    const x = i % width;
    const y = (i - x) / width;
    if (
      x === 0 ||
      y === 0 ||
      x === width - 1 ||
      y === height - 1 ||
      !closed[i - 1] ||
      !closed[i + 1] ||
      !closed[i - width] ||
      !closed[i + width]
    ) {
      hullInput.push({ x, y });
    }
  }
  if (hullInput.length < 4) return null;
  const hull = convexHull(hullInput);
  if (hull.length < 4) return null;
  const quad = orderQuad(maxAreaQuad(hull));

  const areaRatio = quadArea(quad) / total;
  // A "document" covering ≥97% of the frame means no boundary is visible
  // (blank scene / full-frame fill) — reject so the UI falls back to
  // manual inset corners. (The low-res grid maxes out ~0.985, so 0.995
  // would let full-frame hulls through.)
  if (areaRatio < 0.05 || areaRatio > 0.97) return null;

  // Area dominates the score: the page is almost always the largest
  // quad-like region in the frame, so a desk sliver beside a clipped
  // page can never win. (An earlier "interior uniformity" term was
  // REMOVED — it penalised real pages full of text, which is every
  // document.) Quadness is the tie-breaker against skewed blobs.
  const angleDev = quadAngleDeviation(quad);
  const quadness = Math.max(0, 1 - angleDev / 25);
  const areaScore = Math.min(1, areaRatio / 0.3);
  const score = 0.35 * quadness + 0.65 * areaScore;
  return { quad, areaRatio, score };
}

/**
 * Detect the document quad in an RGBA frame.
 * Returns null when nothing page-like is visible; callers fall back to
 * inset full-frame corners.
 */
export function detectDocumentQuad(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options?: DetectOptions
): DetectResult | null {
  const targetWidth = options?.targetWidth ?? DETECT_W;
  const { data: gray, width: w, height: h } = downscaleGray(
    rgba,
    width,
    height,
    targetWidth
  );
  const total = w * h;
  if (total < 64) return null;

  const cut = otsuThreshold(gray);
  const bright = new Uint8Array(total);
  const dark = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    bright[i] = gray[i] > cut ? 1 : 0;
    dark[i] = gray[i] <= cut ? 1 : 0;
  }

  const candidates: Candidate[] = [];
  for (const mask of [bright, dark]) {
    const candidate = buildCandidate(mask, w, h);
    if (candidate) candidates.push(candidate);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  // Upscale corners into the CALLER's coordinate space — the original
  // frame when a pre-downscaled sniff buffer was passed in.
  const sx = (options?.frameWidth ?? width) / w;
  const sy = (options?.frameHeight ?? height) / h;
  const quad: Quad = [
    { x: best.quad[0].x * sx, y: best.quad[0].y * sy },
    { x: best.quad[1].x * sx, y: best.quad[1].y * sy },
    { x: best.quad[2].x * sx, y: best.quad[2].y * sy },
    { x: best.quad[3].x * sx, y: best.quad[3].y * sy },
  ];
  return {
    quad,
    confidence: best.score,
    areaRatio: best.areaRatio,
  };
}

/** Inset full-frame quad (the manual-start fallback). */
export function insetQuad(width: number, height: number, inset = 0.08): Quad {
  const dx = width * inset;
  const dy = height * inset;
  return [
    { x: dx, y: dy },
    { x: width - dx, y: dy },
    { x: width - dx, y: height - dy },
    { x: dx, y: height - dy },
  ];
}
