/**
 * OCR engine — pure helpers for the ocr-pdf worker (PRD §8.4 "PDF OCR").
 *
 * Everything here is string/number math with zero DOM dependencies, so
 * the bun smoke tests can probe text probing and assembly directly (the
 * worker owns the impure canvas/tesseract half, mirroring the
 * compress-pdf engine/worker split).
 */

/** Joins one file's page texts into the final .txt body. */
export function joinTxtPages(
  pageTexts: string[],
  pageNumbers: number[],
  markPages: boolean
): string {
  const mark = markPages && pageTexts.length > 1;
  return pageTexts
    .map((text, i) =>
      mark
        ? `${i === 0 ? "" : "\n\n"}───── Page ${pageNumbers[i] + 1} ─────\n${text}`
        : text
    )
    .join(mark ? "" : "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Deskew (R4-b) — Hough-lite baseline-angle detection                 */
/* ------------------------------------------------------------------ */

/** Deskew only helps when the tilt is visible; below this it is noise. */
export const SKEW_MIN_ANGLE = 0.3;
/** Scans are never tilted more than this — beyond is a rotated page, not skew. */
export const SKEW_MAX_ANGLE = 10;
/** Height of one sampled horizontal strip (spans several text lines). */
const SKEW_STRIP_HEIGHT = 160;
/** A strip with fewer dark pixels than this carries no baseline to find. */
const SKEW_MIN_DARK = 40;
/** Strips that must agree before the median is trusted. */
const SKEW_MIN_SAMPLES = 2;

export interface SkewDetection {
  /**
   * Detected skew in degrees. POSITIVE = the content is tilted clockwise
   * (the right edge sits lower) — i.e. what a scanner produces with
   * ctx.rotate(+angle). To straighten, rotate the canvas by −angle.
   * 0 when no confident skew was found (blank page, no text lines, or
   * the tilt is inside the ±SKEW_MIN_ANGLE noise band).
   */
  angle: number;
  /** Horizontal strips that produced a confident baseline angle. */
  samples: number;
}

/**
 * Converts RGBA pixel bytes to a one-byte-per-pixel luma plane
 * (Rec. 601, same coefficients as compress's grayscaleImageData — which
 * rounds through Uint8ClampedArray, so this rounds too) so the skew
 * detector can binarize cheaply.
 */
export function rgbaToGray(
  rgba: Uint8ClampedArray | Uint8Array
): Uint8Array {
  const pixels = Math.floor(rgba.length / 4);
  const out = new Uint8Array(pixels);
  for (let i = 0, g = 0; g < pixels; i += 4, g += 1) {
    const y = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    out[g] = y > 255 ? 255 : y < 0 ? 0 : Math.round(y);
  }
  return out;
}

/**
 * Detects page skew with a cheap Hough-lite projection-profile method:
 * the raster is split into horizontal strips; per strip, every candidate
 * correction angle θ (shear y′ = y + (x − cx)·tanθ) is scored by how
 * sharply the dark pixels collapse into rows (Σ bin² — text-line baselines
 * project to a few tall peaks only when θ cancels the true skew). The
 * per-strip winners' MEDIAN is the page angle, so a stamp, a logo or a
 * dirty margin cannot drag the estimate.
 *
 * Runs on the GRAY plane (see rgbaToGray) — no DOM, bun-testable.
 */
export function detectSkewAngle(
  gray: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  opts?: {
    /** Search bound in degrees (default ±SKEW_MAX_ANGLE). */
    maxAngle?: number;
    /** Luma below this counts as ink (default 128). */
    darkThreshold?: number;
  }
): SkewDetection {
  const maxAngle = Math.min(45, Math.max(1, opts?.maxAngle ?? SKEW_MAX_ANGLE));
  const darkAt = opts?.darkThreshold ?? 128;
  if (width < 8 || height < 8 || gray.length < width * height) {
    return { angle: 0, samples: 0 };
  }

  const tanMax = Math.tan((maxAngle * Math.PI) / 180);
  const stripHeight = Math.min(SKEW_STRIP_HEIGHT, height);
  const stripCount = Math.max(1, Math.floor(height / stripHeight));
  const binPad = Math.ceil(width * tanMax) + 2;
  const binCount = stripHeight + 2 * binPad;
  const tanOf = (deg: number) => Math.tan((deg * Math.PI) / 180);

  // Coarse 0.5° sweep, then a 0.05° refinement around each strip's winner.
  const coarseStep = 0.5;
  const fineSpan = 0.5;
  const fineStep = 0.05;

  const angles: number[] = [];
  for (let s = 0; s < stripCount; s += 1) {
    const y0 = s * stripHeight;
    // Middle 80% of the strip horizontally — margins hold borders/staples.
    const x0 = Math.floor(width * 0.1);
    const x1 = Math.ceil(width * 0.9);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let y = y0; y < y0 + stripHeight; y += 1) {
      const row = y * width;
      for (let x = x0; x < x1; x += 1) {
        if (gray[row + x] < darkAt) {
          xs.push(x);
          ys.push(y - y0);
        }
      }
    }
    if (xs.length < SKEW_MIN_DARK) continue;
    const cx = width / 2;

    const scoreAt = (theta: number): number => {
      const t = tanOf(theta);
      const bins = new Int32Array(binCount);
      for (let i = 0; i < xs.length; i += 1) {
        const bin = (ys[i] + (xs[i] - cx) * t + binPad) | 0;
        if (bin >= 0 && bin < binCount) bins[bin] += 1;
      }
      let score = 0;
      for (let b = 0; b < binCount; b += 1) {
        const n = bins[b];
        if (n > 1) score += n * n;
      }
      return score;
    };

    let best = 0;
    let bestScore = -1;
    for (let deg = -maxAngle; deg <= maxAngle + 1e-9; deg += coarseStep) {
      const score = scoreAt(deg);
      if (score > bestScore) {
        bestScore = score;
        best = deg;
      }
    }
    for (
      let deg = best - fineSpan;
      deg <= best + fineSpan + 1e-9;
      deg += fineStep
    ) {
      const score = scoreAt(deg);
      if (score > bestScore) {
        bestScore = score;
        best = deg;
      }
    }
    angles.push(best);
  }

  if (angles.length < SKEW_MIN_SAMPLES) return { angle: 0, samples: angles.length };
  angles.sort((a, b) => a - b);
  const mid = angles.length >> 1;
  const medianCorrection =
    angles.length % 2 === 1 ? angles[mid] : (angles[mid - 1] + angles[mid]) / 2;

  // The projection finds the CORRECTION θ (θ = −skew); report the skew.
  const skew = -medianCorrection;
  if (!Number.isFinite(skew) || Math.abs(skew) > maxAngle) {
    return { angle: 0, samples: angles.length };
  }
  // Inside the noise band the page is straight — deskewing would add a
  // resampling blur for no accuracy gain.
  if (Math.abs(skew) < SKEW_MIN_ANGLE) return { angle: 0, samples: angles.length };
  return { angle: Math.round(skew * 100) / 100, samples: angles.length };
}

/** Count of non-whitespace characters (probe + "did we find anything"). */
export function countChars(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (!/\s/.test(ch)) n += 1;
  }
  return n;
}

/**
 * Quick pass-through text for pages that already carry selectable text
 * when the OCR tool is used in text mode: joins pdf.js text items with
 * single spaces. Deliberately simpler than pdf-to-txt's flow builder —
 * the OCR tool's job here is completeness, not typography.
 */
export function joinTextItems(
  items: { str?: unknown }[],
  minChars: number
): { text: string; chars: number } {
  let text = "";
  for (const item of items) {
    const str = typeof item.str === "string" ? item.str : "";
    if (str.length === 0) continue;
    if (text.length > 0 && !text.endsWith(" ")) text += " ";
    text += str;
  }
  text = text.replace(/\s+/g, " ").trim();
  return { text, chars: countChars(text) >= minChars ? countChars(text) : 0 };
}
