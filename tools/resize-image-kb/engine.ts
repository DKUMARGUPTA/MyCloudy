/**
 * Resize image to KB — PURE targeting logic (PRD §7.10, device mode:
 * "Photo + signature under 100/200 KB for exam and government forms").
 *
 * Everything canvas-touching lives in worker.ts; this module is the
 * bun-testable math the worker streams through:
 *   - resolveTargetBytes  option values → exact byte budget
 *   - capDimensions       user maxDim + hard 40MP pixel budget
 *   - dimLadder           aspect-preserving shrink steps (×0.8 to a 120px
 *                        long-side floor, exact-floor landing)
 *   - searchQuality       largest JPEG quality that fits the budget
 *     (binary search over the monotone size(quality) curve)
 */

/** Lowest JPEG quality the ladder will ever hand back (below this a photo
 *  starts to visibly crumble — better to shrink pixels instead). */
export const QUALITY_MIN = 0.3;
/** Quality ceiling — 0.92 keeps JPEG artifacts invisible while always
 *  re-encoding, so the output is a predictable, deduped-safe file. */
export const QUALITY_MAX = 0.92;
/** Binary-search stop band (quality %). */
export const QUALITY_STEP = 0.05;

/** Long-side pixel floor for the dimension ladder. */
export const DIM_FLOOR_PX = 120;
/** Each ladder step shrinks the image to 80% of the previous step. */
export const DIM_FACTOR = 0.8;

/** Hard per-image pixel budget (same guard as rasterize, PRD NFR §14). */
export const MAX_PIXELS = 40_000_000;

/** Custom-target clamp bounds (KB). */
export const CUSTOM_KB_MIN = 10;
export const CUSTOM_KB_MAX = 5000;

const PRESET_KB: Record<string, number> = {
  "20": 20,
  "50": 50,
  "100": 100,
  "200": 200,
  "500": 500,
};

export interface TargetBytes {
  /** Exact byte budget the output must not exceed. */
  bytes: number;
  /** true when a preset produced it (custom clamping never ran). */
  preset: boolean;
}

/** Option values → byte budget. Unknown presets fall back to 100 KB;
 *  custom values are clamped to [CUSTOM_KB_MIN, CUSTOM_KB_MAX] KB. */
export function resolveTargetBytes(
  options: Record<string, unknown>
): TargetBytes {
  const raw = String(options.target ?? "100");
  if (raw === "custom") {
    const kb = Number(options.customKB);
    const safe = Number.isFinite(kb)
      ? Math.min(
          CUSTOM_KB_MAX,
          Math.max(CUSTOM_KB_MIN, Math.round(kb))
        )
      : CUSTOM_KB_MIN;
    return { bytes: safe * 1024, preset: false };
  }
  const kb = PRESET_KB[raw] ?? 100;
  return { bytes: kb * 1024, preset: true };
}

export interface Dims {
  width: number;
  height: number;
}

/**
 * Cap the long side (never upscales) and enforce the 40MP pixel budget
 * with an aspect-preserving floor — the rasterize clamp recipe: the floor
 * guarantees the product stays under the cap.
 */
export function capDimensions(
  width: number,
  height: number,
  maxDim: number
): Dims {
  let w = Math.max(1, Math.round(width));
  let h = Math.max(1, Math.round(height));

  if (maxDim > 0 && Math.max(w, h) > maxDim) {
    const scale = maxDim / Math.max(w, h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }

  if (w * h > MAX_PIXELS) {
    const factor = Math.sqrt(MAX_PIXELS / (w * h));
    const fw = Math.floor(w * factor);
    const fh = Math.floor(h * factor);
    const scale = Math.min(fw / w, fh / h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }

  return { width: w, height: h };
}

export interface DimStep extends Dims {
  /** Cumulative scale vs the original (1 = untouched). */
  factor: number;
}

/**
 * Shrink ladder, big first: the original size, then ×0.8 steps while the
 * long side stays above the floor, ending with one step that lands exactly
 * on the floor. Images already at/below the floor get a single step — the
 * JPEG quality search still applies, and a PNG that cannot shrink further
 * reports an honest miss instead of an illegible sliver.
 */
export function dimLadder(width: number, height: number): DimStep[] {
  const steps: DimStep[] = [];
  const seen = new Set<string>();
  const push = (factor: number): void => {
    const w = Math.max(1, Math.round(width * factor));
    const h = Math.max(1, Math.round(height * factor));
    const key = `${w}x${h}`;
    if (!seen.has(key)) {
      seen.add(key);
      steps.push({ width: w, height: h, factor });
    }
  };

  const long = Math.max(1, Math.round(Math.max(width, height)));
  push(1);
  if (long > DIM_FLOOR_PX) {
    let factor = DIM_FACTOR;
    while (factor * long > DIM_FLOOR_PX) {
      push(factor);
      factor *= DIM_FACTOR;
    }
    // Exact-floor landing: the last ×0.8 step overshoots below the floor,
    // so one clamped step guarantees a 120px-long-side attempt exists.
    push(DIM_FLOOR_PX / long);
  }
  return steps;
}

/**
 * Largest JPEG quality that fits the caller's budget, or null when even
 * QUALITY_MIN is too big at the current size (the worker then shrinks a
 * step and retries). `fits` must be monotone non-decreasing in quality —
 * real JPEG encoders satisfy this on same-pixels canvases.
 *
 * Probes: 2 + ⌈log2(band/QUALITY_STEP)⌉ ≈ 6 for the default constants.
 */
export async function searchQuality(
  fits: (quality: number) => Promise<boolean>
): Promise<number | null> {
  if (await fits(QUALITY_MAX)) return QUALITY_MAX;
  if (!(await fits(QUALITY_MIN))) return null;

  let lo = QUALITY_MIN;
  let hi = QUALITY_MAX;
  while (hi - lo > QUALITY_STEP) {
    const mid = (lo + hi) / 2;
    if (await fits(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}
