/**
 * PURE pixel transforms for the raster color family (P1-b: invert-pdf-
 * colors / pdf-to-greyscale / scanner-effect / posterize-pdf).
 *
 * Every function mutates a `Uint8ClampedArray` in place — exactly the
 * layout of `ImageData.data` (RGBA, 4 bytes per pixel) that the shared
 * worker core hands over after pdf.js renders a page. Keeping them PURE
 * (no canvas, no DOM, no pdf.js) is what makes them smoke-testable in
 * bun (`scripts/smoke-r51-tools.ts`) — the rasterize precedent: bun
 * cannot run the canvas renderer, so the math lives here and the render
 * loop lives in worker-core.
 *
 * Conventions:
 *  - Alpha (every 4th byte) is NEVER touched — pages are opaque anyway,
 *    and JPEG has no alpha; PNG keeps whatever was there.
 *  - Uint8ClampedArray assignment clamps to [0, 255] and rounds
 *    half-to-even — tests avoid .5 boundaries on purpose.
 *  - Greyscale uses Rec. 601 luma (0.299/0.587/0.114) — the same
 *    weights PDF viewers and image editors use for "convert to
 *    grayscale" on RGB data.
 */

/** A pixel transform: mutates `rgba` (ImageData.data layout) in place. */
export type PixelTransform = (rgba: Uint8ClampedArray) => void;

/** Invert every color channel — the photographic negative. */
export function invertPixels(rgba: Uint8ClampedArray): void {
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 255 - rgba[i];
    rgba[i + 1] = 255 - rgba[i + 1];
    rgba[i + 2] = 255 - rgba[i + 2];
  }
}

/**
 * Rec. 601 luma greyscale — r = g = b = luminance. The eye-weighted
 * average, so text on white stays readable (green contributes the most,
 * blue the least).
 */
export function greyscalePixels(rgba: Uint8ClampedArray): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const luma =
      0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    rgba[i] = luma;
    rgba[i + 1] = luma;
    rgba[i + 2] = luma;
  }
}

/**
 * Posterize — snap every channel to `levels` evenly spaced values.
 * levels=2 is pure black/white per channel, 4 is the classic poster
 * look, 8 is a subtle palette crunch. Clamped to [2, 8] by the caller's
 * select, clamped again here (defence in depth — a malformed option
 * must never divide by zero).
 */
export function posterizePixels(
  rgba: Uint8ClampedArray,
  levels: number,
): void {
  const n = Math.max(2, Math.min(8, Math.round(levels)));
  const step = 255 / (n - 1);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = Math.round(Math.round(rgba[i] / step) * step);
    rgba[i + 1] = Math.round(Math.round(rgba[i + 1] / step) * step);
    rgba[i + 2] = Math.round(Math.round(rgba[i + 2] / step) * step);
  }
}

/** Scanner-noise intensity presets (± amplitude around each pixel). */
export const SCANNER_NOISE = {
  light: 8,
  medium: 16,
  heavy: 28,
} as const;

export type ScannerTint = "none" | "cream";

export interface ScannerOptions {
  /** ± noise amplitude in 8-bit levels (SCANNER_NOISE presets). */
  noise: number;
  /** Mid-tone contrast factor; 1 = untouched, 1.15 = the scan crunch. */
  contrast: number;
  /** "cream" warms the page like an old scanner lamp. */
  tint: ScannerTint;
  /** Uniform noise source — injected so tests can seed determinism. */
  rng: () => number;
}

/**
 * The scanner effect — makes a crisp digital page look like it came off
 * a flatbed: greyscale first, then a mid-tone contrast S-curve, then
 * per-pixel sensor noise (uniform ± amplitude), then the optional warm
 * lamp tint. Output is deterministic for a deterministic `rng`.
 */
export function scannerPixels(
  rgba: Uint8ClampedArray,
  options: ScannerOptions,
): void {
  const { noise, contrast, tint, rng } = options;
  const cream = tint === "cream";
  const amplitude = Math.max(0, Math.min(40, noise));
  for (let i = 0; i < rgba.length; i += 4) {
    // 1. luma
    let value =
      0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    // 2. mid-tone contrast (pivot 128)
    value = (value - 128) * contrast + 128;
    // 3. sensor noise
    if (amplitude > 0) {
      value += (rng() * 2 - 1) * amplitude;
    }
    // Uint8ClampedArray clamps + rounds on assign.
    if (cream) {
      // Warm lamp: red up, blue down — whites turn cream, blacks stay.
      rgba[i] = value * 1.08;
      rgba[i + 1] = value * 1.04;
      rgba[i + 2] = value * 0.9;
    } else {
      rgba[i] = value;
      rgba[i + 1] = value;
      rgba[i + 2] = value;
    }
  }
}

/**
 * Deterministic RNG (mulberry32) — for smoke tests only; the worker
 * passes Math.random. Small, public-domain-quality, zero deps.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
