/**
 * Compress-to-target-size engine (PRD §7.5, device mode) — the PURE part.
 *
 * Goal: given a byte budget (100 KB / 200 KB / … form-portal limits), walk
 * a deterministic ladder from "least damage" to "most damage" and stop at
 * the first attempt whose output fits. The worker owns the impure
 * measure/encode loop; this module defines:
 *
 *   - resolveTargetBytes: option values → a clamped byte budget
 *   - IMAGE_LADDER: text-preserving steps (re-encode embedded photos,
 *     text/fonts/vector art untouched — selectable text stays selectable)
 *   - RASTER_LADDER: whole-page rasterize steps (last resort for
 *     font/vector-heavy files; text becomes an image)
 *
 * Ladder design notes:
 *   - Steps are strictly increasing in damage and decreasing in expected
 *     output size — the first hit is the best-quality hit.
 *   - The image ladder compounds: each step re-collects candidates and
 *     only replaces streams when the re-encode is ≥2% smaller, so a
 *     stronger step can only shrink further, never regress.
 *   - Grayscale steps sit at the END of the image ladder: colour is kept
 *     whenever the budget allows it; scans of B&W documents (marksheets,
 *     certificates) squeeze ~2-3× further once gray is allowed.
 *   - The raster floor (52 DPI, q 0.32) is honest but harsh — used only
 *     when nothing else fits. Workers report a miss instead of lying.
 *
 * No canvas/browser APIs here — scripts can unit-probe under bun.
 */

/** One text-preserving image-recompression attempt. */
export interface ImageStep {
  /** JPEG quality 0..1 for re-encoded photos. */
  quality: number;
  /** Cap for the longest image side, in pixels. */
  maxDim: number;
  /** Convert photos to grayscale luminance. */
  grayscale: boolean;
}

/** One whole-page rasterization attempt (pdf.js render → JPEG page). */
export interface RasterStep {
  /** Render resolution; PDF points are 72 DPI. */
  dpi: number;
  /** JPEG quality 0..1 for the rasterized page. */
  quality: number;
}

export const IMAGE_LADDER: readonly ImageStep[] = [
  { quality: 0.8, maxDim: 2400, grayscale: false },
  { quality: 0.65, maxDim: 1800, grayscale: false },
  { quality: 0.5, maxDim: 1400, grayscale: false },
  { quality: 0.42, maxDim: 1150, grayscale: false },
  { quality: 0.38, maxDim: 1000, grayscale: true },
  { quality: 0.32, maxDim: 900, grayscale: true },
] as const;

export const RASTER_LADDER: readonly RasterStep[] = [
  { dpi: 140, quality: 0.72 },
  { dpi: 110, quality: 0.62 },
  { dpi: 96, quality: 0.52 },
  { dpi: 80, quality: 0.45 },
  { dpi: 66, quality: 0.38 },
  { dpi: 52, quality: 0.32 },
] as const;

/** Preset select values → KB (the "custom" value resolves via customKB). */
export const TARGET_PRESETS: Record<string, number> = {
  "100": 100,
  "200": 200,
  "500": 500,
  "1000": 1000,
};

const CUSTOM_MIN_KB = 30;
const CUSTOM_MAX_KB = 10240;
const CUSTOM_DEFAULT_KB = 300;

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));

/**
 * Worker option values → target byte budget. Presets win when known;
 * "custom" (or anything unknown) falls back to the clamped customKB
 * number — garbage input can never produce a zero/impossible budget.
 */
export function resolveTargetBytes(
  options: Record<string, unknown>
): number {
  const target = String(options.target ?? "100");
  const presetKb = TARGET_PRESETS[target];
  if (presetKb !== undefined) return presetKb * 1024;

  const rawKb = Number(options.customKB ?? CUSTOM_DEFAULT_KB);
  const kb = Number.isFinite(rawKb)
    ? Math.round(clamp(rawKb, CUSTOM_MIN_KB, CUSTOM_MAX_KB))
    : CUSTOM_DEFAULT_KB;
  return kb * 1024;
}

/** Ladder sanity for scripts/QA: strictly descending expected size. */
export function ladderIsStrictlyHarder(
  steps: { quality: number; maxDim?: number; dpi?: number; grayscale?: boolean }[]
): boolean {
  for (let i = 1; i < steps.length; i += 1) {
    const prev = steps[i - 1];
    const next = steps[i];
    if (next.quality >= prev.quality) return false;
    if (prev.maxDim !== undefined && next.maxDim !== undefined) {
      if (next.maxDim > prev.maxDim) return false;
    }
    if (prev.dpi !== undefined && next.dpi !== undefined) {
      if (next.dpi > prev.dpi) return false;
    }
    if (prev.grayscale !== undefined && next.grayscale !== undefined) {
      // Grayscale can only be turned ON going down the ladder — never off.
      if (prev.grayscale && !next.grayscale) return false;
    }
  }
  return true;
}
