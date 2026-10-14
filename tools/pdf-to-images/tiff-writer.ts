/**
 * Clean-room baseline TIFF 6.0 writer (little-endian "II") — PDF to TIFF.
 *
 * Why hand-rolled instead of UTIF.js (the PRD §7 implementation hint)?
 * - UTIF.js's encoder is uncompressed-only (raw RGBA) → 5-15× bigger files
 *   than LZW for page graphics.
 * - This writer is fully typed, ships LZW — the most universally-supported
 *   compressed TIFF flavour (Windows Photos, macOS Preview, Photoshop,
 *   ImageMagick, libvips/sharp all decode it) — and chains multi-page IFDs
 *   into ONE file (the scanner/archive convention).
 * - Zero new vendored bytes or license surface: the PRD itself flags the
 *   UTIF license as "verify"; a clean-room ~300-line writer avoids the
 *   question entirely. Output is verified against real libvips (sharp)
 *   decodes in scripts/smoke-tiff.ts.
 *
 * Scope: baseline RGB 8-bit (Photometric 2, SamplesPerPixel 3), one strip
 * per page, LZW (Compression 5) or none (1), X/YResolution as inch
 * rationals, PageNumber for multi-page files. Row 0 of the incoming RGBA
 * is the top row — exactly canvas ImageData order.
 */

const CLEAR_CODE = 256;
const END_CODE = 257;
const FIRST_FREE_CODE = 258;
const MAX_CODE = 4095;

/** TIFF field types used here. */
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

/** TIFF tags written per page, ascending as the spec requires. */
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
const TAG_PAGE_NUMBER = 297;

/** 13 entries → IFD size = 2 + 13*12 + 4 bytes. */
const ENTRY_COUNT = 13;
const IFD_SIZE = 2 + ENTRY_COUNT * 12 + 4;

export interface TiffPageInput {
  width: number;
  height: number;
  /** RGBA 8-bit, row 0 = top, length = width * height * 4. */
  rgba: Uint8ClampedArray | Uint8Array;
}

export interface TiffWriteOptions {
  /** "lzw" (Compression 5, default) or "none" (Compression 1). */
  compression?: "lzw" | "none";
  /** Pixels per inch, written as X/YResolution with ResolutionUnit inch. */
  dpi?: number;
  /** Test-only: strict-GIF code-width rhythm (the reader must read both). */
  lzwGifFlavor?: boolean;
}

/** MSB-first bit-packed growable byte sink for LZW code words. */
class BitSink {
  private data: Uint8Array;
  private len = 0;
  private bitBuffer = 0;
  private bitCount = 0;

  constructor(capacity: number) {
    // Rough LZW ceiling + slack; doubles when exceeded.
    this.data = new Uint8Array(Math.max(1024, capacity + (capacity >> 3) + 64));
  }

  private pushByte(byte: number): void {
    if (this.len === this.data.length) {
      const grown = new Uint8Array(this.data.length * 2);
      grown.set(this.data.subarray(0, this.len));
      this.data = grown;
    }
    this.data[this.len++] = byte;
  }

  writeCode(code: number, width: number): void {
    // Meaningful bits stay below 8 + 12 = 20; the & 0xff on every push keeps
    // stale high garbage (from earlier shifts) out of the output.
    this.bitBuffer = (this.bitBuffer << width) | code;
    this.bitCount += width;
    while (this.bitCount >= 8) {
      this.bitCount -= 8;
      this.pushByte((this.bitBuffer >>> this.bitCount) & 0xff);
    }
  }

  finish(): Uint8Array {
    if (this.bitCount > 0) {
      this.pushByte((this.bitBuffer << (8 - this.bitCount)) & 0xff);
      this.bitCount = 0;
    }
    return this.data.subarray(0, this.len);
  }
}

/**
 * TIFF-flavoured LZW (the GIF algorithm, MSB-first, codes 9→12 bits,
 * Clear/EOI = 256/257, table full → Clear + reset).
 *
 * Width-switch rule (interop-locked): the decoder adds one entry per code
 * read but lags the encoder by one add, so the encoder must widen BEFORE
 * emitting once (nextCode − 1) no longer fits the current width — this
 * lands the switch on exactly the code position every mainstream decoder
 * (libtiff & friends) widens at. `gifFlavor` selects the strict-GIF rhythm
 * (one code later) — used only by the reader's smoke test to prove the
 * decoder's verify+retry handles BOTH width-switch conventions.
 */
export function lzwCompress(input: Uint8Array, gifFlavor = false): Uint8Array {
  const out = new BitSink(input.length);
  // dictionary[(prefixCode << 8) | byte] = code + 1 (0 = absent).
  // 4096 * 256 uint16 = 2 MB, calloc'd per page — trivial next to the page.
  const dictionary = new Uint16Array((MAX_CODE + 1) * 256);
  let nextCode = FIRST_FREE_CODE;
  let width = 9;

  out.writeCode(CLEAR_CODE, width);
  if (input.length === 0) {
    out.writeCode(END_CODE, width);
    return out.finish();
  }

  let prefix = input[0];
  for (let i = 1; i < input.length; i += 1) {
    const c = input[i];
    const key = (prefix << 8) | c;
    const hit = dictionary[key];
    if (hit !== 0) {
      prefix = hit - 1;
      continue;
    }
    // Widen so this code fits what the decoder will read: the decoder
    // adds one entry per code read but lags the encoder by one add, so the
    // switch must land when nextCode (codes emittable right now, including
    // the KwKwK case the decoder reconstructs one read later) reaches 2^W.
    // Verified empirically against libvips/libtiff output: boundaries are
    // emit #255 / #767 / #1791 (decoder widens after adding entries
    // 510 / 1022 / 2046). gifFlavor widens one code later (#256/#768/#1792).
    while (
      width < 12 &&
      (gifFlavor ? nextCode > (1 << width) : nextCode >= (1 << width))
    ) {
      width += 1;
    }
    out.writeCode(prefix, width);
    if (nextCode <= MAX_CODE) {
      dictionary[key] = nextCode + 1; // stored as code + 1 (0 = absent)
      nextCode += 1;
      prefix = c;
    } else {
      // Table full: emit the prefix while the decoder still knows it,
      // reset, and restart from the current byte.
      out.writeCode(CLEAR_CODE, width);
      dictionary.fill(0);
      nextCode = FIRST_FREE_CODE;
      width = 9;
      prefix = c;
    }
  }
  while (width < 12 && nextCode >= (1 << width)) width += 1;
  out.writeCode(prefix, width);
  out.writeCode(END_CODE, width);
  return out.finish();
}

/** Drop the alpha channel: RGBA (stride 4) → RGB (stride 3). */
function rgbaToRgb(
  rgba: Uint8ClampedArray | Uint8Array,
  pixels: number
): Uint8Array {
  const rgb = new Uint8Array(pixels * 3);
  for (let p = 0, s = 0, d = 0; p < pixels; p += 1, s += 4, d += 3) {
    rgb[d] = rgba[s];
    rgb[d + 1] = rgba[s + 1];
    rgb[d + 2] = rgba[s + 2];
  }
  return rgb;
}

/**
 * Streaming multi-page TIFF builder. Pages are compressed to their strip
 * bytes the moment they are added, so peak memory stays at one page of
 * RGBA + the accumulated compressed strips (a 300-DPI 20-page document
 * never holds 20 RGBA buffers at once).
 */
export class TiffBuilder {
  private readonly strips: Uint8Array[] = [];
  private readonly widths: number[] = [];
  private readonly heights: number[] = [];
  private readonly compression: 1 | 5;
  private readonly dpi: number;

  private readonly gifFlavor: boolean;

  constructor(options: TiffWriteOptions = {}) {
    this.compression = options.compression === "none" ? 1 : 5;
    this.dpi = Math.max(1, Math.round(options.dpi ?? 150));
    this.gifFlavor = options.lzwGifFlavor === true;
  }

  addPage(page: TiffPageInput): void {
    const { width, height, rgba } = page;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      rgba.length !== width * height * 4
    ) {
      throw new Error("tiff-bad-page");
    }
    const rgb = rgbaToRgb(rgba, width * height);
    this.widths.push(width);
    this.heights.push(height);
    this.strips.push(
      this.compression === 5 ? lzwCompress(rgb, this.gifFlavor) : rgb
    );
  }

  /** Serialize every added page into one little-endian TIFF file. */
  finish(): Uint8Array {
    const pages = this.strips.length;
    if (pages === 0) throw new Error("tiff-no-pages");

    // Layout: header (8) + shared extras (22) + strips (even-padded) + IFDs.
    const bitsOffset = 8; // SHORT[3] {8,8,8}
    const xResOffset = bitsOffset + 6; // RATIONAL {dpi,1}
    const yResOffset = xResOffset + 8; // RATIONAL {dpi,1}
    let cursor = yResOffset + 8;

    const stripOffsets: number[] = this.strips.map((strip) => {
      const offset = cursor;
      cursor += strip.length + (strip.length & 1); // even-align pad
      return offset;
    });
    const ifdOffsets: number[] = this.widths.map(() => {
      const offset = cursor;
      cursor += IFD_SIZE;
      return offset;
    });

    const out = new Uint8Array(cursor);
    const view = new DataView(out.buffer);

    // Header: "II", 42, offset of the first IFD.
    out[0] = 0x49;
    out[1] = 0x49;
    view.setUint16(2, 42, true);
    view.setUint32(4, ifdOffsets[0], true);

    // Shared out-of-line values.
    view.setUint16(bitsOffset, 8, true);
    view.setUint16(bitsOffset + 2, 8, true);
    view.setUint16(bitsOffset + 4, 8, true);
    view.setUint32(xResOffset, this.dpi, true);
    view.setUint32(xResOffset + 4, 1, true);
    view.setUint32(yResOffset, this.dpi, true);
    view.setUint32(yResOffset + 4, 1, true);

    // Strip bytes (padding byte left as zero).
    this.strips.forEach((strip, i) => out.set(strip, stripOffsets[i]));

    // IFDs, chained via NextIFD.
    for (let i = 0; i < pages; i += 1) {
      const base = ifdOffsets[i];
      view.setUint16(base, ENTRY_COUNT, true);
      let at = base + 2;
      const entry = (
        tag: number,
        type: number,
        count: number,
        value: number
      ): void => {
        view.setUint16(at, tag, true);
        view.setUint16(at + 2, type, true);
        view.setUint32(at + 4, count, true);
        // SHORT values live in the first (low) bytes of the field; LONG
        // offsets and packed SHORT pairs pass straight through.
        view.setUint32(at + 8, value, true);
        at += 12;
      };
      entry(TAG_IMAGE_WIDTH, TYPE_LONG, 1, this.widths[i]);
      entry(TAG_IMAGE_LENGTH, TYPE_LONG, 1, this.heights[i]);
      entry(TAG_BITS_PER_SAMPLE, TYPE_SHORT, 3, bitsOffset);
      entry(TAG_COMPRESSION, TYPE_SHORT, 1, this.compression);
      entry(TAG_PHOTOMETRIC, TYPE_SHORT, 1, 2); // RGB
      entry(TAG_STRIP_OFFSETS, TYPE_LONG, 1, stripOffsets[i]);
      entry(TAG_SAMPLES_PER_PIXEL, TYPE_SHORT, 1, 3);
      entry(TAG_ROWS_PER_STRIP, TYPE_LONG, 1, this.heights[i]);
      entry(TAG_STRIP_BYTE_COUNTS, TYPE_LONG, 1, this.strips[i].length);
      entry(TAG_X_RESOLUTION, TYPE_RATIONAL, 1, xResOffset);
      entry(TAG_Y_RESOLUTION, TYPE_RATIONAL, 1, yResOffset);
      entry(TAG_RESOLUTION_UNIT, TYPE_SHORT, 1, 2); // inch
      entry(TAG_PAGE_NUMBER, TYPE_SHORT, 2, i | (pages << 16)); // [index, total]
      view.setUint32(
        at,
        i + 1 < pages ? ifdOffsets[i + 1] : 0,
        true
      );
    }
    return out;
  }
}

/** One-shot convenience for single-page (and smoke-test) encodes. */
export function encodeTiff(
  pages: TiffPageInput[],
  options: TiffWriteOptions = {}
): Uint8Array {
  const builder = new TiffBuilder(options);
  for (const page of pages) builder.addPage(page);
  return builder.finish();
}
