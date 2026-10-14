import type { OptionValues } from "@/lib/tools/config-types";

/**
 * Extract PDF images — pure engine (PRD §8.1 "Extract images": pull every
 * embedded image out as PNG or JPG, ZIP download).
 *
 * Zero runtime imports — the interactive surface (main thread), the pool
 * worker (OffscreenCanvas encode) and the bun smoke script all share this
 * module, so the selection keys, size filter and naming are pinned BEFORE
 * the UI exists (the P3.3 lesson).
 *
 * Option contract (what the surface writes via onChange and the worker
 * reads from request.options):
 *   minSize   "0" | "128" | "256" | "512"   minimum longer side in px
 *   format    "png" | "jpg"                output encoding (jpg q90 fixed)
 *   selected  "" | "F0-P1-I2,…"           explicit selection keys; "" = all
 *
 * Selection keys are stable between the read-only surface probe and the
 * worker run because both walk pages in order and count EVERY image op on
 * a page (pre-filter) for the ordinal: F<file>-P<page>-I<ordinal>. The
 * selection only ever applies to file #1 (the previewed file); every other
 * file contributes all of its passing images.
 */

export const EXI_IDS = {
  minSize: "minSize",
  format: "format",
  selected: "selected",
} as const;

export type ExiFormat = "png" | "jpg";

export const MIN_SIZE_VALUES = [0, 128, 256, 512] as const;

/** Output encoding info for a format choice (jpg quality fixed at 90). */
export const EXI_FORMATS: Record<
  ExiFormat,
  { mime: string; ext: string; alpha: boolean; quality: number }
> = {
  png: { mime: "image/png", ext: "png", alpha: true, quality: 1 },
  jpg: { mime: "image/jpeg", ext: "jpg", alpha: false, quality: 0.9 },
};

export interface ExiOptions {
  minSize: number;
  format: ExiFormat;
  selected: string;
}

/** Normalize surface/worker options (unknown values fall back honestly). */
export function resolveExiOptions(options: OptionValues): ExiOptions {
  const rawMin = Number(options[EXI_IDS.minSize]);
  const minSize = (MIN_SIZE_VALUES as readonly number[]).includes(rawMin)
    ? rawMin
    : 128;
  const format: ExiFormat =
    options[EXI_IDS.format] === "jpg" ? "jpg" : "png";
  const rawSelected = options[EXI_IDS.selected];
  return {
    minSize,
    format,
    selected: typeof rawSelected === "string" ? rawSelected : "",
  };
}

/* ------------------------------------------------------------------ */
/* Minimum-size filter                                                */
/* ------------------------------------------------------------------ */

/** True when the image's longer side meets the minimum (0 = everything). */
export function passesMinSize(
  width: number,
  height: number,
  minSize: number
): boolean {
  if (minSize <= 0) return true;
  return Math.max(width, height) >= minSize;
}

/* ------------------------------------------------------------------ */
/* Selection keys (stable probe ⇄ worker contract)                     */
/* ------------------------------------------------------------------ */

const SELECTED_KEY_RE = /^F(\d+)-P(\d+)-I(\d+)$/;

/** Stable identity of the ordinal-th image detection on a page. */
export function imageKey(
  fileIndex: number,
  page: number,
  ordinal: number
): string {
  return `F${fileIndex}-P${page}-I${ordinal}`;
}

/**
 * Parse the "selected" option. null (= every passing image) for "", missing
 * or structurally invalid values; a key set otherwise. Unknown keys are
 * dropped silently — a stale selection must never break a run.
 */
export function parseSelectedSet(value: unknown): ReadonlySet<string> | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return null;
  const keys = new Set<string>();
  for (const part of value.split(",")) {
    const key = part.trim();
    if (SELECTED_KEY_RE.test(key)) keys.add(key);
  }
  return keys;
}

/** Inverse of parseSelectedSet — a stable, sorted, comma-joined list. */
export function serializeSelectedSet(keys: Iterable<string>): string {
  return [...keys].sort().join(",");
}

/* ------------------------------------------------------------------ */
/* Pixel expansion (pdf.js ImageKind data → RGBA)                     */
/* ------------------------------------------------------------------ */

/** pdf.js ImageKind constants (verified against pdfjs-dist 4.10.38). */
export const IMAGE_KIND = {
  GRAYSCALE_1BPP: 1,
  RGB_24BPP: 2,
  RGBA_32BPP: 3,
} as const;

/**
 * GRAYSCALE_1BPP → RGBA. Packed bits, MSB first, each row padded to whole
 * bytes; a set bit renders white, an unset bit black — the same mapping
 * pdf.js's own convertBlackAndWhiteToRGBA uses for canvas painting.
 *
 * Return type is pinned to Uint8ClampedArray<ArrayBuffer> (TS 5.9 generics):
 * the ImageData constructor (worker encode + surface thumbnails) rejects the
 * widened ArrayBufferLike form. Every expander below builds its output via
 * `new Uint8ClampedArray(new ArrayBuffer(n))`, so the pin is honest — no
 * casts anywhere.
 */
export function expandGray1ToRGBA(
  src: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  const rowBytes = (width + 7) >> 3;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const byte = src[y * rowBytes + (x >> 3)] ?? 0;
      const value = (byte >> (7 - (x & 7))) & 1 ? 255 : 0;
      const offset = (y * width + x) * 4;
      out[offset] = value;
      out[offset + 1] = value;
      out[offset + 2] = value;
      out[offset + 3] = 255;
    }
  }
  return out;
}

/** RGB_24BPP → RGBA with an opaque alpha channel. */
export function expandRgb24ToRGBA(
  src: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number
): Uint8ClampedArray<ArrayBuffer> {
  const count = width * height;
  const out = new Uint8ClampedArray(new ArrayBuffer(count * 4));
  for (let i = 0; i < count; i += 1) {
    const si = i * 3;
    out[i * 4] = src[si] ?? 0;
    out[i * 4 + 1] = src[si + 1] ?? 0;
    out[i * 4 + 2] = src[si + 2] ?? 0;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * RGBA_32BPP normalize: pdf.js hands over Uint8Array or Uint8ClampedArray
 * (getImageBytes can return either). ImageData wants a Uint8ClampedArray
 * over its own buffer — always copy into a fresh one (the TS 5.9 pinned
 * `new Uint8ClampedArray(new ArrayBuffer(n))` pattern, no casts).
 */
export function normalizeRgba(
  src: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  out.set(src.subarray(0, out.length));
  return out;
}

/**
 * Expand any data-form pdf.js image to RGBA. Returns null for unknown
 * kinds or payloads that are too short (caller skips the image honestly).
 */
export function expandToRGBA(
  data: Uint8Array | Uint8ClampedArray,
  kind: number,
  width: number,
  height: number
): Uint8ClampedArray<ArrayBuffer> | null {
  if (width <= 0 || height <= 0) return null;
  if (kind === IMAGE_KIND.GRAYSCALE_1BPP) {
    if (data.length < ((width + 7) >> 3) * height) return null;
    return expandGray1ToRGBA(data, width, height);
  }
  if (kind === IMAGE_KIND.RGB_24BPP) {
    if (data.length < width * height * 3) return null;
    return expandRgb24ToRGBA(data, width, height);
  }
  if (kind === IMAGE_KIND.RGBA_32BPP) {
    if (data.length < width * height * 4) return null;
    return normalizeRgba(data, width, height);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Output naming                                                      */
/* ------------------------------------------------------------------ */

/** Shared download-name sanitizer (pdf-to-images rule, bun-testable). */
export function sanitizeExiBase(fileName: string): string {
  return (
    fileName
      .replace(/\.pdf$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .trim()
      .slice(0, 120) || "document"
  );
}

/**
 * One output name: `<base>_p<page>_<n>.<ext>` where n is the running
 * 1-based output index for the file — unique per file by construction.
 */
export function makeImageName(
  base: string,
  page: number,
  outputIndex: number,
  format: ExiFormat
): string {
  const info = EXI_FORMATS[format];
  return `${base}_p${page}_${outputIndex}.${info.ext}`;
}

/* ------------------------------------------------------------------ */
/* Run error classification                                           */
/* ------------------------------------------------------------------ */

/**
 * Map a thrown pdf.js error message to the i18n key the shell toast
 * shows (same families as pdf-to-images / pdf-to-txt):
 *   /password/i  → encrypted (needs its open password first)
 *   /canvas/i    → generic (OffscreenCanvas encode trouble)
 *   otherwise    → corrupt / unreadable PDF
 */
export function classifyExtractError(message: string): string {
  if (/password/i.test(message)) return "tool.errorEncrypted";
  if (/canvas/i.test(message)) return "tool.errorGeneric";
  return "tool.errorCorrupt";
}
