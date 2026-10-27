/**
 * Baseline TIFF encoder for pdf-to-tiff (task 2-a, PRD §8.6 image matrix).
 *
 * Clean-room, pure TypeScript, zero dependencies — Bun-smokeable and
 * worker-safe (no DOM globals touched at module scope). Writes the most
 * conservative TIFF that every decoder on earth opens:
 *
 *   - little-endian ("II", version 42) baseline TIFF 6.0
 *   - RGB 8-bit (PhotometricInterpretation 2, SamplesPerPixel 3,
 *     BitsPerSample 8/8/8)
 *   - UNCOMPRESSED (Compression 1) — every pixel stored raw, so a file is
 *     exactly width × height × 3 bytes of pixel data. Honest trade-off,
 *     stated in the tool copy: use pdf-to-jpg / -png / -webp for smaller
 *     files; keep TIFF for archives, publishing and fax workflows.
 *   - ONE IFD per output image, NextIFD 0 (each PDF page = its own .tif)
 *   - XResolution/YResolution {dpi, 1} with ResolutionUnit 2 (inch), so
 *     scanners and printers read the chosen DPI straight from the file
 *
 * File layout (deliberately the simplest sound one):
 *
 *   [8-byte header][RGB pixel data][out-of-line values][IFD]
 *
 * The pixel data starts immediately after the header, so StripOffsets is
 * the single known constant 8 when the IFD is written — no fix-up pass.
 * The out-of-line values between pixels and IFD are BitsPerSample (SHORT×3)
 * and the X/YResolution rationals; the IFD comes last and terminates the
 * chain. Every section starts on an even byte (TIFF word alignment).
 *
 * RGBA → RGB: canvas ImageData is RGBA; TIFF baseline RGB has no alpha, so
 * each pixel is flattened over white (alpha 255 passes through untouched,
 * alpha 0 lands on pure white).
 */

/** MIME handed to the worker's output Blob (extension .tif lives in formats.ts). */
export const TIFF_MIME = "image/tiff";

/** TIFF field types written by this encoder. */
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

/** TIFF tags — ascending order as the spec requires. */
const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_LENGTH = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_PHOTOMETRIC = 262;
const TAG_STRIP_OFFSETS = 273;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_ROWS_PER_STRIP = 278;
const TAG_STRIP_BYTE_COUNTS = 279;
const TAG_X_RESOLUTION = 282;
const TAG_Y_RESOLUTION = 283;
const TAG_RESOLUTION_UNIT = 296;

/** 12 entries → IFD = 2 (count) + 12 × 12 (entries) + 4 (NextIFD) bytes. */
const ENTRY_COUNT = 12;
const IFD_SIZE = 2 + ENTRY_COUNT * 12 + 4;

/** Pixels start right after the 8-byte header — the one known StripOffset. */
const PIXEL_OFFSET = 8;

/** One image to encode: RGBA 8-bit, row 0 = top (canvas ImageData order). */
export interface TiffImageInput {
  width: number;
  height: number;
  /** Length must be width × height × 4. */
  rgba: Uint8ClampedArray | Uint8Array;
}

/**
 * Flatten RGBA onto white into a fresh RGB (stride 3) buffer.
 * alpha 255 → source bytes pass through untouched; alpha 0 → white.
 */
export function flattenRgbaToRgb(
  rgba: Uint8ClampedArray | Uint8Array,
  pixelCount: number
): Uint8Array {
  const rgb = new Uint8Array(pixelCount * 3);
  for (let p = 0, s = 0, d = 0; p < pixelCount; p += 1, s += 4, d += 3) {
    const alpha = rgba[s + 3];
    if (alpha === 255) {
      rgb[d] = rgba[s];
      rgb[d + 1] = rgba[s + 1];
      rgb[d + 2] = rgba[s + 2];
      continue;
    }
    // out = src × (a/255) + white × (1 − a/255), rounded half-up.
    const inv = 255 - alpha;
    rgb[d] = (rgba[s] * alpha + 255 * inv + 127) / 255 | 0;
    rgb[d + 1] = (rgba[s + 1] * alpha + 255 * inv + 127) / 255 | 0;
    rgb[d + 2] = (rgba[s + 2] * alpha + 255 * inv + 127) / 255 | 0;
  }
  return rgb;
}

/**
 * Encode one image as a single-IFD uncompressed baseline RGB TIFF.
 * `dpi` is stamped into XResolution/YResolution as {dpi, 1} per inch
 * (default 150 — the family's balanced choice); non-finite values fall
 * back to it, fractional values are rounded, minimum 1.
 */
export function encodeTiffPage(
  image: TiffImageInput,
  dpi = 150
): Uint8Array {
  const { width, height, rgba } = image;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    rgba.length !== width * height * 4
  ) {
    throw new Error("tiff-bad-image");
  }
  const cleanDpi = Math.max(1, Math.round(Number.isFinite(dpi) ? dpi : 150));
  const pixels = width * height;
  const rgb = flattenRgbaToRgb(rgba, pixels);

  // Layout: [header 8][rgb (padded even)][bits 6][xRes 8][yRes 8][IFD 150].
  const pixelBytes = pixels * 3;
  const pad = pixelBytes & 1; // keep every following section word-aligned
  const bitsOffset = PIXEL_OFFSET + pixelBytes + pad;
  const xResOffset = bitsOffset + 6;
  const yResOffset = xResOffset + 8;
  const ifdOffset = yResOffset + 8;

  const out = new Uint8Array(ifdOffset + IFD_SIZE);
  const view = new DataView(out.buffer);

  // Header: "II", version 42, offset of the (single) IFD.
  out[0] = 0x49;
  out[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);

  // Pixel data — StripOffsets is the constant 8, StripByteCounts is exact.
  out.set(rgb, PIXEL_OFFSET);

  // Out-of-line values.
  view.setUint16(bitsOffset, 8, true);
  view.setUint16(bitsOffset + 2, 8, true);
  view.setUint16(bitsOffset + 4, 8, true);
  view.setUint32(xResOffset, cleanDpi, true);
  view.setUint32(xResOffset + 4, 1, true);
  view.setUint32(yResOffset, cleanDpi, true);
  view.setUint32(yResOffset + 4, 1, true);

  // IFD — entries in ascending tag order, NextIFD terminates the chain.
  view.setUint16(ifdOffset, ENTRY_COUNT, true);
  let at = ifdOffset + 2;
  const entry = (
    tag: number,
    type: number,
    count: number,
    value: number
  ): void => {
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    // SHORT (≤ 4 bytes total) values ride in the low bytes of the value
    // field; LONG offsets and RATIONAL offsets pass straight through.
    view.setUint32(at + 8, value, true);
    at += 12;
  };
  entry(TAG_IMAGE_WIDTH, TYPE_LONG, 1, width);
  entry(TAG_IMAGE_LENGTH, TYPE_LONG, 1, height);
  entry(TAG_BITS_PER_SAMPLE, TYPE_SHORT, 3, bitsOffset);
  entry(TAG_COMPRESSION, TYPE_SHORT, 1, 1); // uncompressed
  entry(TAG_PHOTOMETRIC, TYPE_SHORT, 1, 2); // RGB
  entry(TAG_STRIP_OFFSETS, TYPE_LONG, 1, PIXEL_OFFSET);
  entry(TAG_SAMPLES_PER_PIXEL, TYPE_SHORT, 1, 3);
  entry(TAG_ROWS_PER_STRIP, TYPE_LONG, 1, height);
  entry(TAG_STRIP_BYTE_COUNTS, TYPE_LONG, 1, pixelBytes);
  entry(TAG_X_RESOLUTION, TYPE_RATIONAL, 1, xResOffset);
  entry(TAG_Y_RESOLUTION, TYPE_RATIONAL, 1, yResOffset);
  entry(TAG_RESOLUTION_UNIT, TYPE_SHORT, 1, 2); // inch
  view.setUint32(at, 0, true); // NextIFD = 0 — one image per file
  return out;
}

export interface TiffVerify {
  ok: boolean;
  /** Why not — surfaced as the worker error detail. */
  detail: string;
}

/**
 * Sanity self-check on freshly encoded bytes (the family verifies its
 * blobs — WebP checks the MIME, TIFF checks the magic): accepts both
 * byte orders ("II*\0" little / "MM\0*" big), requires version 42 and a
 * first-IFD offset inside the buffer. The deep structure is the smoke's
 * job — this is the guard that runs on every page in the worker.
 */
export function verifyTiffBytes(bytes: Uint8Array): TiffVerify {
  if (bytes.length < 8) return { ok: false, detail: "short-header" };
  const littleEndian = bytes[0] === 0x49 && bytes[1] === 0x49;
  const bigEndian = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!littleEndian && !bigEndian) return { ok: false, detail: "bad-magic" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(2, littleEndian);
  if (version !== 42) return { ok: false, detail: `version-${version}` };
  const ifdOffset = view.getUint32(4, littleEndian);
  if (ifdOffset < 8 || ifdOffset + 2 > bytes.length) {
    return { ok: false, detail: `ifd-offset-${ifdOffset}` };
  }
  return { ok: true, detail: littleEndian ? "II" : "MM" };
}
