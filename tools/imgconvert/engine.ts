/**
 * Pure conversion engine for the four PRD §7.10 P1 image converters
 * (webp-to-jpg, webp-to-png, heic-to-jpg, heic-to-png) — one engine, four
 * configs, mirroring how pdf-to-jpg + pdf-to-png share
 * tools/pdf-to-images/worker.ts.
 *
 * NO DOM, no worker globals: every helper here is bun-testable
 * (scripts/smoke-imgconvert.ts) so the HEIC sniff, output naming, quality
 * clamps and alpha math are proven before the browser worker leans on them.
 */

/** ftyp major brands that mark a HEIC/HEIF payload (incl. multisegment). */
const HEIC_BRANDS: readonly string[] = [
  "heic",
  "heix",
  "hevc",
  "mif1",
  "msf1",
];

/**
 * HEIC magic sniff on a file HEAD (pure). Mirrors the drop-zone sniff
 * (ftyp box at offset 4, major brand at offset 8) but accepts every brand
 * libheif reads, so heic/heix/hevc/mif1/msf1 files all reach the wasm
 * decoder while PNG/JPEG/WEBP bytes fall through to the honest
 * "not an image this browser can read" error.
 */
export function sniffIsHeic(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  const tag = (offset: number): string =>
    String.fromCharCode(
      head[offset],
      head[offset + 1],
      head[offset + 2],
      head[offset + 3]
    );
  return tag(4) === "ftyp" && HEIC_BRANDS.includes(tag(8));
}

/** Trailing image extensions stripped when deriving an output base name. */
const IMAGE_EXT_RE =
  /\.(webp|heic|heif|hif|avif|jpg|jpeg|jpe|jfif|png|gif|bmp|tif|tiff)$/i;

/**
 * "photo.heic" → "photo": strip ONE known image extension (if any), replace
 * path-hostile characters, collapse whitespace, cap the length. Falls back
 * to "image" when nothing usable remains (e.g. a bare ".heic").
 */
export function sanitizeBaseName(name: string): string {
  const base = name
    .replace(IMAGE_EXT_RE, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return base.length > 0 ? base : "image";
}

/**
 * Deterministic output naming: the first "photo" becomes "photo.jpg", the
 * next same-base input becomes "photo-2.jpg", then "photo-3.jpg" — in file
 * order, no clocks, no randomness. `taken` is the caller's set of names
 * already emitted for this run.
 */
export function uniqueOutputName(
  base: string,
  ext: string,
  taken: Set<string>
): string {
  let candidate = `${base}.${ext}`;
  if (!taken.has(candidate)) {
    taken.add(candidate);
    return candidate;
  }
  for (let n = 2; n <= 9999; n += 1) {
    candidate = `${base}-${n}.${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  // Unreachable with maxFiles 20 (each iteration tests a fresh string), but
  // keep the function total and deterministic instead of inventing a name.
  taken.add(candidate);
  return candidate;
}

/** JPG quality option bounds (percent), shared by both JPG tools. */
export const JPEG_QUALITY_MIN = 40;
export const JPEG_QUALITY_MAX = 95;
export const JPEG_QUALITY_DEFAULT = 90;

/**
 * Clamp a worker option to a sane JPG quality percent. Anything non-numeric
 * (missing option on PNG tools, bad input) becomes the default 90.
 */
export function clampQualityPercent(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return JPEG_QUALITY_DEFAULT;
  return Math.min(
    JPEG_QUALITY_MAX,
    Math.max(JPEG_QUALITY_MIN, Math.round(value))
  );
}

/**
 * Expand an interleaved RGB plane into RGBA ImageData layout (alpha 255).
 * Rows are read honoring `stride` — libheif planes are copies whose rows
 * may be padded, so the walk must never assume width*3.
 */
export function rgbToRgba(
  rgb: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  stride = width * 3
): Uint8ClampedArray<ArrayBuffer> {
  if (width <= 0 || height <= 0) throw new Error("rgbToRgba: empty image");
  if (stride < width * 3) throw new Error("rgbToRgba: stride too small");
  if (rgb.length < (height - 1) * stride + width * 3) {
    throw new Error("rgbToRgba: plane too small");
  }
  const out = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    const dst = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const src = row + x * 3;
      const px = dst + x * 4;
      out[px] = rgb[src];
      out[px + 1] = rgb[src + 1];
      out[px + 2] = rgb[src + 2];
      out[px + 3] = 255;
    }
  }
  return out;
}

export interface RgbaToRgbOptions {
  /** Row stride of the RGBA plane in bytes (default width * 4). */
  stride?: number;
  /** Composite colour for transparent pixels (default opaque white). */
  background?: readonly [number, number, number];
}

/**
 * Flatten an RGBA plane onto an opaque RGB one — JPG has no alpha, so
 * transparent and semi-transparent pixels are composited over the
 * background (src-over, non-premultiplied: out = src*a + bg*(1-a), /255,
 * rounded). This is the exact math the JPG path runs in the worker, pinned
 * by the smoke test so canvas-less environments behave identically.
 */
export function rgbaToRgb(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: RgbaToRgbOptions = {}
): Uint8Array<ArrayBuffer> {
  const stride = options.stride ?? width * 4;
  const background = options.background ?? [255, 255, 255];
  if (width <= 0 || height <= 0) throw new Error("rgbaToRgb: empty image");
  if (stride < width * 4) throw new Error("rgbaToRgb: stride too small");
  if (rgba.length < (height - 1) * stride + width * 4) {
    throw new Error("rgbaToRgb: plane too small");
  }
  const out = new Uint8Array(new ArrayBuffer(width * height * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    const dst = y * width * 3;
    for (let x = 0; x < width; x += 1) {
      const src = row + x * 4;
      const px = dst + x * 3;
      const alpha = rgba[src + 3];
      if (alpha === 255) {
        out[px] = rgba[src];
        out[px + 1] = rgba[src + 1];
        out[px + 2] = rgba[src + 2];
      } else if (alpha === 0) {
        out[px] = background[0];
        out[px + 1] = background[1];
        out[px + 2] = background[2];
      } else {
        const inv = 255 - alpha;
        out[px] = Math.round(
          (rgba[src] * alpha + background[0] * inv) / 255
        );
        out[px + 1] = Math.round(
          (rgba[src + 1] * alpha + background[1] * inv) / 255
        );
        out[px + 2] = Math.round(
          (rgba[src + 2] * alpha + background[2] * inv) / 255
        );
      }
    }
  }
  return out;
}

/** Where the decoded pixels of a run came from. */
export type ImageDecodeSource = "bitmap" | "heif-wasm";

/**
 * EXIF-orientation note helper: BOTH decode paths bake orientation into
 * the pixels before anything here runs — the browser path calls
 * createImageBitmap with `imageOrientation: "from-image"` (EXIF in
 * JPEG/WEBP, irot/imir in Safari-decoded HEIC), and libheif applies the
 * irot/imir transformations inside heif_decode_image. The worker never
 * adds a rotation pass; configs cite this guarantee in their copy and the
 * smoke test pins it so nobody "optimizes" it away.
 */
export function decodeAppliesOrientation(source: ImageDecodeSource): boolean {
  return source === "bitmap" || source === "heif-wasm";
}
