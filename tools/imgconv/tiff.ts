/**
 * Clean-room baseline TIFF 6.0 reader — TIFF to PDF (and any TIFF consumer).
 *
 * Why hand-rolled instead of UTIF.js (the PRD §7 hint)? Same reason as the
 * clean-room WRITER in tools/pdf-to-images/tiff-writer.ts: zero vendored
 * bytes, fully typed, and full control over the honest error taxonomy.
 * The writer's output is the decoder's primary round-trip oracle.
 *
 * Scope (the flavours real files actually use):
 * - Endianness: "II" and "MM"; classic IFD chain for multi-page.
 * - Compression: None (1), LZW (5, both code-width flavours via verify+
 *   retry), PackBits (32773), Deflate/Adobe (8/32946 via fflate), G3
 *   (CCITT T.4, 1D + 2D, with EOL sync + fill bits) and G4 (T.6).
 * - Photometric: 0/1 (gray, both polarities), 2 (RGB), 3 (palette),
 *   5 (CMYK, naive inverted conversion).
 * - Bits per sample: 1 (incl. fax + FillOrder 2), 4, 8, 16 (high byte).
 * - Samples/pixel: 1, 2 (gray+alpha), 3, 4 (ExtraSamples alpha).
 * - Predictor: 1 + 2 (horizontal differencing, 8/16-bit).
 * - Strips AND tiles; Orientation 1-8 applied to the RGBA output
 *   (5-8 report swapped width/height).
 *
 * Memory model: IFD metadata for EVERY page is parsed once (cheap), page
 * pixels are decoded on demand — a 20-page 300-DPI scan never holds more
 * than one RGBA page plus the strips of the page being decoded.
 *
 * The CCITT run/mode code tables below are the ITU T.4/T.6 constants,
 * cross-verified bit-by-bit against the published pdfjs lookup tables.
 */

import { inflateSync, unzlibSync } from "fflate";

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export const TIFF_MAX_PIXELS = 80_000_000;

/** TIFF magic: "II*\0" (little) or "MM\0*" (big). */
export function isTiffBytes(head: Uint8Array): boolean {
  if (head.length < 4) return false;
  return (
    (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0) ||
    (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a)
  );
}

export interface TiffPageInfo {
  width: number;
  height: number;
  /** Pixels per inch from XResolution (+ unit), null when absent/invalid. */
  dpi: number | null;
}

export interface TiffRgbaPage extends TiffPageInfo {
  /** RGBA 8-bit, row 0 = top, length = width * height * 4. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
  /**
   * Bilevel/palette pages have few colours — PNG keeps them crisp and
   * small; everything else embeds better as JPEG.
   */
  preferPng: boolean;
}

/** Decode every page (smoke tests, thumbnails, small files). */
export function decodeTiffPages(bytes: Uint8Array): TiffRgbaPage[] {
  const file = TiffFile.parse(bytes);
  return Array.from({ length: file.pageCount }, (_, i) => file.decodePage(i));
}

/** Marker errors — callers map these to localized copy. */
export type TiffErrorKind = "tiff-corrupt" | "tiff-unsupported" | "tiff-too-large";
export class TiffError extends Error {
  readonly kind: TiffErrorKind;
  readonly detail: string;
  constructor(kind: TiffErrorKind, detail: string) {
    super(`${kind}: ${detail}`);
    this.kind = kind;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ */
/* IFD metadata                                                        */
/* ------------------------------------------------------------------ */

const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_LENGTH = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_PHOTOMETRIC = 262;
const TAG_FILL_ORDER = 266;
const TAG_STRIP_OFFSETS = 273;
const TAG_ORIENTATION = 274;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_ROWS_PER_STRIP = 278;
const TAG_STRIP_BYTE_COUNTS = 279;
const TAG_X_RESOLUTION = 282;
const TAG_PLANAR_CONFIG = 284;
const TAG_T4_OPTIONS = 292;
const TAG_RESOLUTION_UNIT = 296;
const TAG_COLOR_MAP = 320;
const TAG_TILE_WIDTH = 322;
const TAG_TILE_LENGTH = 323;
const TAG_TILE_OFFSETS = 324;
const TAG_TILE_BYTE_COUNTS = 325;
const TAG_EXTRA_SAMPLES = 338;
const TAG_SAMPLE_FORMAT = 339;
const TAG_PREDICTOR = 317;

const TYPE_BYTE = 1;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;

interface Ifd {
  width: number;
  height: number;
  compression: number;
  photometric: number;
  bps: number;
  spp: number;
  planar: number;
  predictor: number;
  fillOrder: number;
  orientation: number;
  sampleFormat: number;
  t4Options: number;
  /** Strip or tile offsets/counts (tiles use the tile fields). */
  offsets: number[];
  counts: number[];
  rowsPerStrip: number;
  tileWidth: number;
  tileLength: number;
  colormap: Uint16Array | null;
  extraSamples: number[];
  dpi: number | null;
}

function unsupported(detail: string): never {
  throw new TiffError("tiff-unsupported", detail);
}
function corrupt(detail: string): never {
  throw new TiffError("tiff-corrupt", detail);
}

/** Parse every IFD's metadata (no pixel work). */
function parseIfds(bytes: Uint8Array, view: DataView, le: boolean): Ifd[] {
  const u16 = (at: number) => view.getUint16(at, le);
  const u32 = (at: number) => view.getUint32(at, le);

  const firstIfd = u32(4);
  if (firstIfd < 8 || firstIfd > bytes.length) corrupt("first IFD out of range");

  const ifds: Ifd[] = [];
  const seen = new Set<number>();
  let cursor = firstIfd;
  while (cursor !== 0) {
    if (seen.has(cursor) || ifds.length >= 10_000) corrupt("IFD chain loop");
    seen.add(cursor);
    if (cursor < 8 || cursor + 2 > bytes.length) corrupt("IFD out of range");
    const count = u16(cursor);
    const entriesEnd = cursor + 2 + count * 12;
    if (entriesEnd + 4 > bytes.length) corrupt("IFD entries out of range");

    const scalar: Record<number, number> = {};
    const array: Record<number, number[]> = {};
    for (let e = 0; e < count; e += 1) {
      const at = cursor + 2 + e * 12;
      const tag = u16(at);
      const type = u16(at + 2);
      const n = u32(at + 4);
      let size = 0;
      if (type === TYPE_BYTE) size = 1;
      else if (type === TYPE_SHORT) size = 2;
      else if (type === TYPE_LONG) size = 4;
      else continue; // ASCII/rational/etc: values live out of line
      if (n === 0 || n > 1_000_000) continue;
      const total = size * n;
      const inline = total <= 4;
      // Inline values live in the LOWER-ORDER bytes of the 4-byte field:
      // first bytes when little-endian, last bytes when big-endian
      // (TIFF 6.0 §2: "left-justified ... in the lower-order bytes").
      const base = inline ? (le ? at + 8 : at + 12 - total) : u32(at + 8);
      if (base + total > bytes.length) corrupt(`tag ${tag} value out of range`);
      const values: number[] = [];
      for (let i = 0; i < n; i += 1) {
        const vat = base + i * size;
        values.push(size === 1 ? bytes[vat] : size === 2 ? u16(vat) : u32(vat));
      }
      if (n === 1) scalar[tag] = values[0];
      array[tag] = values;
    }

    const width = scalar[TAG_IMAGE_WIDTH];
    const height = scalar[TAG_IMAGE_LENGTH];
    if (!Number.isInteger(width) || width < 1 || width > 100_000) corrupt("bad width");
    if (!Number.isInteger(height) || height < 1 || height > 100_000) corrupt("bad height");
    if (width * height > TIFF_MAX_PIXELS) {
      throw new TiffError("tiff-too-large", `${width}x${height}`);
    }

    const bpsArray = array[TAG_BITS_PER_SAMPLE] ?? [1];
    const bps = bpsArray[0];
    if (bpsArray.some((b) => b !== bps)) unsupported("mixed bits per sample");
    const spp = scalar[TAG_SAMPLES_PER_PIXEL] ?? 1;
    if (bpsArray.length > 1 && bpsArray.length !== spp) {
      corrupt("BitsPerSample count != SamplesPerPixel");
    }

    const tiled = array[TAG_TILE_OFFSETS] !== undefined;
    const offsets = tiled
      ? array[TAG_TILE_OFFSETS]
      : (array[TAG_STRIP_OFFSETS] ?? []);
    const counts = tiled
      ? array[TAG_TILE_BYTE_COUNTS] ?? []
      : (array[TAG_STRIP_BYTE_COUNTS] ?? []);
    if (offsets.length === 0 || counts.length !== offsets.length) {
      corrupt("missing strip/tile offsets");
    }

    // Rationals for XResolution (unit 1 = none, 2 = inch, 3 = cm).
    let dpi: number | null = null;
    const xresAt = findRational(view, le, cursor, count, TAG_X_RESOLUTION);
    if (xresAt !== null) {
      const num = view.getUint32(xresAt, le);
      const den = view.getUint32(xresAt + 4, le);
      const unit = scalar[TAG_RESOLUTION_UNIT] ?? 2;
      if (den > 0 && num > 0 && num / den < 100_000) {
        dpi = (num / den) * (unit === 3 ? 2.54 : 1);
      }
    }

    ifds.push({
      width,
      height,
      compression: scalar[TAG_COMPRESSION] ?? 1,
      photometric: scalar[TAG_PHOTOMETRIC] ?? 1,
      bps,
      spp,
      planar: scalar[TAG_PLANAR_CONFIG] ?? 1,
      predictor: scalar[TAG_PREDICTOR] ?? 1,
      fillOrder: scalar[TAG_FILL_ORDER] ?? 1,
      orientation: scalar[TAG_ORIENTATION] ?? 1,
      sampleFormat: array[TAG_SAMPLE_FORMAT]?.[0] ?? 1,
      t4Options: scalar[TAG_T4_OPTIONS] ?? 0,
      offsets,
      counts,
      rowsPerStrip: Math.max(1, scalar[TAG_ROWS_PER_STRIP] ?? 0xffffffff),
      tileWidth: scalar[TAG_TILE_WIDTH] ?? 0,
      tileLength: scalar[TAG_TILE_LENGTH] ?? 0,
      colormap: array[TAG_COLOR_MAP] ? Uint16Array.from(array[TAG_COLOR_MAP]) : null,
      extraSamples: array[TAG_EXTRA_SAMPLES] ?? [],
      dpi,
    });

    cursor = u32(entriesEnd);
  }
  if (ifds.length === 0) corrupt("no IFD");
  return ifds;
}

/** Locate an out-of-line RATIONAL value for `tag`; null when absent. */
function findRational(
  view: DataView,
  le: boolean,
  cursor: number,
  count: number,
  tag: number
): number | null {
  const u16 = (at: number) => view.getUint16(at, le);
  const u32 = (at: number) => view.getUint32(at, le);
  for (let e = 0; e < count; e += 1) {
    const at = cursor + 2 + e * 12;
    if (u16(at) !== tag) continue;
    if (u16(at + 2) !== 5 || u32(at + 4) !== 1) return null; // not one RATIONAL
    const valueAt = u32(at + 8);
    if (valueAt + 8 > view.byteLength) return null;
    return valueAt;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Page reader                                                         */
/* ------------------------------------------------------------------ */

export class TiffFile {
  private readonly view: DataView;
  private readonly le: boolean;

  private constructor(
    private readonly bytes: Uint8Array,
    private readonly ifds: Ifd[]
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.le = bytes[0] === 0x49;
  }

  static parse(bytes: Uint8Array): TiffFile {
    if (bytes.length < 8) corrupt("truncated header");
    if (
      (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 43) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[3] === 43)
    ) {
      unsupported("BigTIFF");
    }
    if (!isTiffBytes(bytes)) corrupt("not a TIFF");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return new TiffFile(bytes, parseIfds(bytes, view, bytes[0] === 0x49));
  }

  get pageCount(): number {
    return this.ifds.length;
  }

  pageInfo(index: number): TiffPageInfo {
    const ifd = this.ifds[index];
    if (!ifd) corrupt("no such page");
    if (ifd.orientation >= 5) {
      return { width: ifd.height, height: ifd.width, dpi: ifd.dpi };
    }
    return { width: ifd.width, height: ifd.height, dpi: ifd.dpi };
  }

  decodePage(index: number): TiffRgbaPage {
    const ifd = this.ifds[index];
    if (!ifd) corrupt("no such page");
    const { width, height, spp, bps } = ifd;

    if (ifd.planar !== 1) unsupported("planar sample storage");
    if (ifd.sampleFormat !== 1) unsupported(`sample format ${ifd.sampleFormat}`);
    if (bps !== 1 && bps !== 4 && bps !== 8 && bps !== 16) {
      unsupported(`${bps}-bit samples`);
    }
    if (ifd.predictor !== 1 && ifd.predictor !== 2) {
      unsupported(`predictor ${ifd.predictor}`);
    }
    if (ifd.predictor === 2 && bps !== 8 && bps !== 16) {
      unsupported(`predictor 2 with ${bps}-bit samples`);
    }

    const pixels = width * height;
    const rgba = new Uint8ClampedArray(pixels * 4);
    const preferPng = bps === 1 || ifd.photometric === 3 || (spp === 1 && bps === 4);

    if (ifd.compression === 3 || ifd.compression === 4) {
      this.decodeFaxPage(ifd, rgba);
    } else {
      const compression = ifd.compression;
      if (
        compression !== 1 &&
        compression !== 5 &&
        compression !== 32773 &&
        compression !== 8 &&
        compression !== 32946
      ) {
        unsupported(
          compression === 6 || compression === 7
            ? "JPEG-in-TIFF"
            : `compression ${compression}`
        );
      }
      const bytesPerRow = Math.ceil((width * spp * bps) / 8);
      if (bytesPerRow * height > 1 << 30) corrupt("page too large");

      const raw = new Uint8Array(bytesPerRow * height);
      if (ifd.tileWidth > 0) {
        this.decodeTiles(ifd, raw, bytesPerRow, compression);
      } else {
        this.decodeStrips(ifd, raw, bytesPerRow, compression);
        this.applyPredictor(ifd, raw, bytesPerRow, ifd.width, ifd.height);
      }
      this.samplesToRgba(ifd, raw, bytesPerRow, rgba);
    }

    applyOrientation(ifd.orientation, rgba, width, height);
    const swapped = ifd.orientation >= 5 && ifd.orientation <= 8;
    return {
      width: swapped ? height : width,
      height: swapped ? width : height,
      rgba,
      dpi: ifd.dpi,
      preferPng,
    };
  }

  /* ---------------- strips & tiles ---------------- */

  private stripData(ifd: Ifd, i: number): Uint8Array {
    const offset = ifd.offsets[i];
    const length = ifd.counts[i];
    if (offset + length > this.bytes.length) corrupt("strip out of range");
    return this.bytes.subarray(offset, offset + length);
  }

  /** Decompress one strip; `expected` raw bytes, null when structurally bad. */
  private decompressStrip(
    data: Uint8Array,
    expected: number,
    compression: number
  ): Uint8Array | null {
    switch (compression) {
      case 1:
        return data.length >= expected ? data.subarray(0, expected) : null;
      case 5: {
        // Adobe/libtiff width rhythm first, strict-GIF flavour as the
        // retry (the TIFF spec is famously ambiguous — read both).
        return (
          lzwDecompress(data, expected, true) ?? lzwDecompress(data, expected, false)
        );
      }
      case 32773:
        return packBitsDecompress(data, expected);
      case 8:
      case 32946: {
        // Adobe Deflate is a zlib stream; a few writers store it raw.
        let out: Uint8Array;
        try {
          out = unzlibSync(data);
        } catch {
          try {
            out = inflateSync(data);
          } catch {
            return null;
          }
        }
        return out.length === expected ? out : null;
      }
      default:
        unsupported(`compression ${compression}`);
    }
  }

  /** Decompress strips top-down into the page's raw sample buffer. */
  private decodeStrips(
    ifd: Ifd,
    raw: Uint8Array,
    bytesPerRow: number,
    compression: number
  ): void {
    const strips = Math.ceil(ifd.height / ifd.rowsPerStrip);
    if (ifd.offsets.length < strips) corrupt("missing strips");
    let rawAt = 0;
    for (let i = 0; i < strips; i += 1) {
      const rows = Math.min(ifd.rowsPerStrip, ifd.height - i * ifd.rowsPerStrip);
      if (rows <= 0) break;
      const expected = rows * bytesPerRow;
      const out = this.decompressStrip(this.stripData(ifd, i), expected, compression);
      if (!out || out.length !== expected) corrupt(`strip ${i} failed to decode`);
      raw.set(out, rawAt);
      rawAt += expected;
    }
  }

  private decodeTiles(
    ifd: Ifd,
    raw: Uint8Array,
    bytesPerRow: number,
    compression: number
  ): void {
    const { tileWidth: tw, tileLength: tl } = ifd;
    if (tw < 16 || tl < 16 || tw % 16 !== 0 || tl % 16 !== 0) {
      unsupported("odd tile geometry"); // spec: multiples of 16
    }
    const tileBytesPerRow = Math.ceil((tw * ifd.spp * ifd.bps) / 8);
    const tileStride = tileBytesPerRow * tl;
    const across = Math.ceil(ifd.width / tw);
    const down = Math.ceil(ifd.height / tl);
    if (ifd.offsets.length < across * down) corrupt("tile count mismatch");
    // Whole tile-columns are byte-aligned in the page rows because tiles
    // are multiples of 16 pixels wide (16 × min(bps) = 2 bytes at least).
    const tilePixelBytes = (tw * ifd.spp * ifd.bps) / 8;
    const tile = new Uint8Array(tileStride);
    for (let ty = 0; ty < down; ty += 1) {
      for (let tx = 0; tx < across; tx += 1) {
        const index = ty * across + tx;
        const out = this.decompressStrip(this.stripData(ifd, index), tileStride, compression);
        if (!out || out.length !== tileStride) corrupt(`tile ${index} failed to decode`);
        tile.set(out);
        // Predictor differencing is PER TILE row — undo it before
        // stitching or the tile boundaries break the delta chain.
        this.applyPredictor(ifd, tile, tileBytesPerRow, tw, tl);
        const copyW = Math.min(tw, ifd.width - tx * tw);
        const copyH = Math.min(tl, ifd.height - ty * tl);
        const copyBytes = Math.ceil((copyW * ifd.spp * ifd.bps) / 8);
        for (let r = 0; r < copyH; r += 1) {
          const from = r * tileBytesPerRow;
          const to = (ty * tl + r) * bytesPerRow + tx * tilePixelBytes;
          raw.set(tile.subarray(from, from + copyBytes), to);
        }
      }
    }
  }

  /* ---------------- sample pipeline ---------------- */

  private applyPredictor(
    ifd: Ifd,
    raw: Uint8Array,
    bytesPerRow: number,
    width: number,
    height: number
  ): void {
    if (ifd.predictor !== 2) return;
    const { spp, bps } = ifd;
    if (bps === 8) {
      for (let y = 0; y < height; y += 1) {
        const row = y * bytesPerRow;
        for (let x = spp; x < width * spp; x += 1) {
          raw[row + x] += raw[row + x - spp];
        }
      }
      return;
    }
    // 16-bit: deltas are per-sample words in the file's endianness.
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let y = 0; y < height; y += 1) {
      const row = y * bytesPerRow;
      for (let x = spp; x < width * spp; x += 1) {
        const at = row + x * 2;
        const delta = view.getUint16(at, this.le) + view.getUint16(at - spp * 2, this.le);
        view.setUint16(at, delta & 0xffff, this.le);
      }
    }
  }

  private samplesToRgba(
    ifd: Ifd,
    raw: Uint8Array,
    bytesPerRow: number,
    rgba: Uint8ClampedArray
  ): void {
    const { width, height, spp, bps, photometric } = ifd;

    if (photometric === 0 || photometric === 1) {
      if (spp !== 1 && spp !== 2) corrupt("gray with extra samples");
    } else if (photometric === 2) {
      if (spp !== 3 && spp !== 4) corrupt("RGB sample count");
    } else if (photometric === 3) {
      if (spp !== 1) unsupported("palette with extra samples");
    } else if (photometric === 5) {
      if (spp !== 4) corrupt("CMYK sample count");
    } else {
      unsupported(`photometric ${photometric}`);
    }

    // Palette — resolve once, scaled to 0..255.
    let palette: Uint8Array | null = null;
    const paletteSize = 1 << bps;
    if (photometric === 3) {
      if (!ifd.colormap) corrupt("palette without ColorMap");
      if (ifd.colormap.length < 3 * paletteSize) corrupt("short ColorMap");
      palette = new Uint8Array(3 * paletteSize);
      for (let i = 0; i < paletteSize; i += 1) {
        palette[i] = ifd.colormap[i] >> 8;
        palette[paletteSize + i] = ifd.colormap[paletteSize + i] >> 8;
        palette[2 * paletteSize + i] = ifd.colormap[2 * paletteSize + i] >> 8;
      }
    }

    const hasAlpha = spp === 2 || (spp === 4 && photometric === 2);
    const alphaSample = hasAlpha ? spp - 1 : -1;
    // ExtraSamples 1 = associated (premultiplied) alpha; missing tag or
    // 2 = straight alpha (the safe default — no division surprises).
    const associated = ifd.extraSamples[0] === 1;
    const cmyk = photometric === 5;
    const rawView = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

    const sampleAt = (x: number, y: number, s: number): number => {
      const row = y * bytesPerRow;
      if (bps === 8) return raw[row + x * spp + s];
      if (bps === 16) return rawView.getUint16(row + (x * spp + s) * 2, this.le) >> 8;
      if (bps === 4) {
        const byte = raw[row + ((x * spp + s) >> 1)];
        return (x * spp + s) & 1 ? byte & 0x0f : byte >> 4;
      }
      // bps 1 — fill order respected.
      const bitIndex = x * spp + s;
      const byte = raw[row + (bitIndex >> 3)];
      return ifd.fillOrder === 2
        ? (byte >> (bitIndex & 7)) & 1
        : (byte >> (7 - (bitIndex & 7))) & 1;
    };

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        if (photometric === 3) {
          const index = sampleAt(x, y, 0);
          rgba[at] = palette![index];
          rgba[at + 1] = palette![paletteSize + index];
          rgba[at + 2] = palette![2 * paletteSize + index];
        } else if (spp >= 3) {
          if (cmyk) {
            const c = sampleAt(x, y, 0);
            const m = sampleAt(x, y, 1);
            const yy = sampleAt(x, y, 2);
            const k = sampleAt(x, y, 3);
            rgba[at] = ((255 - c) * (255 - k)) / 255;
            rgba[at + 1] = ((255 - m) * (255 - k)) / 255;
            rgba[at + 2] = ((255 - yy) * (255 - k)) / 255;
          } else {
            rgba[at] = sampleAt(x, y, 0);
            rgba[at + 1] = sampleAt(x, y, 1);
            rgba[at + 2] = sampleAt(x, y, 2);
          }
        } else {
          // Grayscale — WhiteIsZero photometrics are inverted.
          let v = sampleAt(x, y, 0);
          if (bps === 4) v = v * 17;
          if (photometric === 0) v = 255 - v;
          rgba[at] = v;
          rgba[at + 1] = v;
          rgba[at + 2] = v;
        }
        if (alphaSample >= 0) {
          let a = sampleAt(x, y, alphaSample);
          if (bps === 4) a = a * 17;
          rgba[at + 3] = a;
          if (associated && a > 0 && a < 255) {
            // Associated (premultiplied) alpha → straight alpha for canvas.
            rgba[at] = (rgba[at] * 255) / a;
            rgba[at + 1] = (rgba[at + 1] * 255) / a;
            rgba[at + 2] = (rgba[at + 2] * 255) / a;
          }
        } else {
          rgba[at + 3] = 255;
        }
      }
    }
  }

  /* ---------------- fax (G3/G4) ---------------- */

  private decodeFaxPage(ifd: Ifd, rgba: Uint8ClampedArray): void {
    const { width, height } = ifd;
    if (ifd.tileWidth > 0) unsupported("tiled fax");
    if (ifd.photometric !== 0 && ifd.photometric !== 1) {
      unsupported(`fax with photometric ${ifd.photometric}`);
    }
    if (ifd.compression === 3 && (ifd.t4Options & 4) !== 0) {
      unsupported("uncompressed G3 fax");
    }
    const g3 = ifd.compression === 3;
    const g3TwoD = g3 && (ifd.t4Options & 2) !== 0;

    const bitmap = new Uint8Array(width * height); // 0 = white, 1 = black
    const strips = Math.ceil(height / ifd.rowsPerStrip);
    if (ifd.offsets.length < strips) corrupt("missing fax strips");

    outer: for (let i = 0; i < strips; i += 1) {
      const rows = Math.min(ifd.rowsPerStrip, height - i * ifd.rowsPerStrip);
      if (rows <= 0) break;
      const reader = new FaxBitReader(this.stripData(ifd, i), ifd.fillOrder === 2);
      // Each strip restarts from an imaginary all-white reference line.
      let ref: Uint8Array | null = null;
      for (let r = 0; r < rows; r += 1) {
        const line = bitmap.subarray(
          (i * ifd.rowsPerStrip + r) * width,
          (i * ifd.rowsPerStrip + r + 1) * width
        );
        if (!g3) {
          decode2DLine(reader, ref, line, width); // G4
        } else if (g3TwoD) {
          // T.4 2D: EOL then a dimension bit (1 = 1D line, 0 = 2D line).
          if (!reader.syncEol()) {
            if (i === 0 && r === 0) corrupt("G3 2D: EOL expected");
            break outer;
          }
          const bit = reader.readBit();
          if (bit === 1) {
            if (!decode1DLine(reader, line, width)) break outer;
          } else if (bit === 0) {
            decode2DLine(reader, ref, line, width);
          } else {
            break outer;
          }
        } else {
          // 1D: EOLs (and fill bits before them) are optional per writer.
          const sync = reader.syncOptionalEol();
          if (sync !== "none" && sync !== "eol") break outer; // rtc / eof
          if (!decode1DLine(reader, line, width)) break outer;
        }
        ref = line;
      }
    }

    // Bitmap → RGBA. Photometric 0 (WhiteIsZero) is the fax default;
    // photometric 1 inverts.
    const invert = ifd.photometric === 1;
    for (let p = 0, at = 0; p < width * height; p += 1, at += 4) {
      const v = (bitmap[p] ^ (invert ? 1 : 0)) === 0 ? 255 : 0;
      rgba[at] = v;
      rgba[at + 1] = v;
      rgba[at + 2] = v;
      rgba[at + 3] = 255;
    }
  }
}

/* ------------------------------------------------------------------ */
/* LZW (TIFF flavour) + PackBits                                       */
/* ------------------------------------------------------------------ */

/**
 * TIFF LZW decode. `adobeWidth` selects the code-width switch rhythm:
 * true → widen when nextCode reaches 2^width − 1 (the TIFF 6.0 spec /
 * libtiff / our writer), false → at 2^width (strict GIF rhythm).
 * Returns null on any structural inconsistency (caller may retry).
 */
function lzwDecompress(
  input: Uint8Array,
  expected: number,
  adobeWidth: boolean
): Uint8Array | null {
  const out = new Uint8Array(expected);
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  for (let i = 0; i < 256; i += 1) first[i] = i;
  const stack = new Uint8Array(4400);

  let bitBuffer = 0;
  let bitCount = 0;
  let inAt = 0;
  const readCode = (width: number): number => {
    while (bitCount < width) {
      if (inAt >= input.length) return -1;
      bitBuffer = (bitBuffer << 8) | input[inAt++];
      bitCount += 8;
    }
    bitCount -= width;
    return (bitBuffer >>> bitCount) & ((1 << width) - 1);
  };

  let width = 9;
  let nextCode = 258;
  let prev = -1;
  let outLen = 0;

  const emitChain = (code: number, extra: number): boolean => {
    // Write string(code) (+ one optional byte) forward via the stack.
    let depth = 0;
    let c = code;
    while (c >= 256) {
      if (depth >= 4352) return false;
      stack[depth++] = suffix[c];
      c = prefix[c];
    }
    stack[depth++] = c;
    if (outLen + depth + (extra >= 0 ? 1 : 0) > expected) return false;
    while (depth > 0) {
      out[outLen++] = stack[--depth];
    }
    if (extra >= 0) {
      out[outLen++] = extra;
    }
    return true;
  };

  for (;;) {
    const code = readCode(width);
    if (code === -1) break;
    if (code === 256) {
      width = 9;
      nextCode = 258;
      prev = -1;
      continue;
    }
    if (code === 257) break; // End of information.
    if (prev === -1) {
      if (code > 255) return null;
      if (!emitChain(code, -1)) return null;
      prev = code;
      continue;
    }
    if (code > nextCode) return null; // Reference to an undefined code.
    // KwKwK: code === nextCode extends the PREVIOUS string with its own
    // first character — the entry doesn't exist yet, so the chain walked
    // must be prev's, with first[prev] appended as the extra byte.
    const kwkwk = code === nextCode;
    if (!emitChain(kwkwk ? prev : code, kwkwk ? first[prev] : -1)) return null;
    if (nextCode < 4096) {
      prefix[nextCode] = prev;
      suffix[nextCode] = kwkwk ? first[prev] : first[code];
      first[nextCode] = first[prev];
      nextCode += 1;
      const bound = adobeWidth ? (1 << width) - 1 : 1 << width;
      if (width < 12 && nextCode === bound) width += 1;
    }
    prev = code;
    if (outLen === expected) break;
  }
  return outLen === expected ? out : null;
}

function packBitsDecompress(input: Uint8Array, expected: number): Uint8Array | null {
  const out = new Uint8Array(expected);
  let inAt = 0;
  let outAt = 0;
  while (outAt < expected) {
    if (inAt >= input.length) return null;
    const n = (input[inAt++] << 24) >> 24; // int8
    if (n >= 0) {
      const count = n + 1;
      if (inAt + count > input.length || outAt + count > expected) return null;
      out.set(input.subarray(inAt, inAt + count), outAt);
      inAt += count;
      outAt += count;
    } else if (n >= -127) {
      const count = 1 - n;
      if (inAt >= input.length || outAt + count > expected) return null;
      out.fill(input[inAt++], outAt, outAt + count);
      outAt += count;
    } // -128: no-op
  }
  return outAt === expected ? out : null;
}

/* ------------------------------------------------------------------ */
/* CCITT G3/G4 fax                                                     */
/* ------------------------------------------------------------------ */

/** ITU T.4 white terminating codes (runs 0-63), [run, bits]. */
const WHITE_TERM: [number, string][] = [
  [0, "00110101"], [1, "000111"], [2, "0111"], [3, "1000"], [4, "1011"],
  [5, "1100"], [6, "1110"], [7, "1111"], [8, "10011"], [9, "10100"],
  [10, "00111"], [11, "01000"], [12, "001000"], [13, "000011"], [14, "110100"],
  [15, "110101"], [16, "101010"], [17, "101011"], [18, "0100111"], [19, "0001100"],
  [20, "0001000"], [21, "0010111"], [22, "0000011"], [23, "0000100"], [24, "0101000"],
  [25, "0101011"], [26, "0010011"], [27, "0100100"], [28, "0011000"], [29, "00000010"],
  [30, "00000011"], [31, "00011010"], [32, "00011011"], [33, "00010010"], [34, "00010011"],
  [35, "00010100"], [36, "00010101"], [37, "00010110"], [38, "00010111"], [39, "00101000"],
  [40, "00101001"], [41, "00101010"], [42, "00101011"], [43, "00101100"], [44, "00101101"],
  [45, "00000100"], [46, "00000101"], [47, "00001010"], [48, "00001011"], [49, "01010010"],
  [50, "01010011"], [51, "01010100"], [52, "01010101"], [53, "00100100"], [54, "00100101"],
  [55, "01011000"], [56, "01011001"], [57, "01011010"], [58, "01011011"], [59, "01001010"],
  [60, "01001011"], [61, "00110010"], [62, "00110011"], [63, "00110100"],
];

/** ITU T.4 white makeup codes, [run, bits]. */
const WHITE_MAKE: [number, string][] = [
  [64, "11011"], [128, "10010"], [192, "010111"], [256, "0110111"], [320, "00110110"],
  [384, "00110111"], [448, "01100100"], [512, "01100101"], [576, "01101000"], [640, "01100111"],
  [704, "011001100"], [768, "011001101"], [832, "011010010"], [896, "011010011"], [960, "011010100"],
  [1024, "011010101"], [1088, "011010110"], [1152, "011010111"], [1216, "011011000"], [1280, "011011001"],
  [1344, "011011010"], [1408, "011011011"], [1472, "010011000"], [1536, "010011001"], [1600, "010011010"],
  [1664, "011000"], [1728, "010011011"], [1792, "00000001000"], [1856, "00000001100"], [1920, "00000001101"],
  [1984, "000000010010"], [2048, "000000010011"], [2112, "000000010100"], [2176, "000000010101"], [2240, "000000010110"],
  [2304, "000000010111"], [2368, "000000011100"], [2432, "000000011101"], [2496, "000000011110"], [2560, "000000011111"],
];

/** ITU T.4 black terminating codes (runs 0-63), [run, bits]. */
const BLACK_TERM: [number, string][] = [
  [0, "0000110111"], [1, "010"], [2, "11"], [3, "10"], [4, "011"],
  [5, "0011"], [6, "0010"], [7, "00011"], [8, "000101"], [9, "000100"],
  [10, "0000100"], [11, "0000101"], [12, "0000111"], [13, "00000100"], [14, "00000111"],
  [15, "000011000"], [16, "0000010111"], [17, "0000011000"], [18, "0000001000"], [19, "00001100111"],
  [20, "00001101000"], [21, "00001101100"], [22, "00000110111"], [23, "00000101000"], [24, "00000010111"],
  [25, "00000011000"], [26, "000011001010"], [27, "000011001011"], [28, "000011001100"], [29, "000011001101"],
  [30, "000001101000"], [31, "000001101001"], [32, "000001101010"], [33, "000001101011"], [34, "000011010010"],
  [35, "000011010011"], [36, "000011010100"], [37, "000011010101"], [38, "000011010110"], [39, "000011010111"],
  [40, "000001101100"], [41, "000001101101"], [42, "000011011010"], [43, "000011011011"], [44, "000001010100"],
  [45, "000001010101"], [46, "000001010110"], [47, "000001010111"], [48, "000001100100"], [49, "000001100101"],
  [50, "000001010010"], [51, "000001010011"], [52, "000000100100"], [53, "000000110111"], [54, "000000111000"],
  [55, "000000100111"], [56, "000000101000"], [57, "000001011000"], [58, "000001011001"], [59, "000000101011"],
  [60, "000000101100"], [61, "000001011010"], [62, "000001100110"], [63, "000001100111"],
];

/** ITU T.4 black makeup codes, [run, bits]. */
const BLACK_MAKE: [number, string][] = [
  [64, "0000001111"], [128, "000011001000"], [192, "000011001001"], [256, "000001011011"], [320, "000000110011"],
  [384, "000000110100"], [448, "000000110101"], [512, "0000001101100"], [576, "0000001101101"], [640, "0000001001010"],
  [704, "0000001001011"], [768, "0000001001100"], [832, "0000001001101"], [896, "0000001110010"], [960, "0000001110011"],
  [1024, "0000001110100"], [1088, "0000001110101"], [1152, "0000001110110"], [1216, "0000001110111"], [1280, "0000001010010"],
  [1344, "0000001010011"], [1408, "0000001010100"], [1472, "0000001010101"], [1536, "0000001011010"], [1600, "0000001011011"],
  [1664, "0000001100100"], [1728, "0000001100101"], [1792, "00000001000"], [1856, "00000001100"], [1920, "00000001101"],
  [1984, "000000010010"], [2048, "000000010011"], [2112, "000000010100"], [2176, "000000010101"], [2240, "000000010110"],
  [2304, "000000010111"], [2368, "000000011100"], [2432, "000000011101"], [2496, "000000011110"], [2560, "000000011111"],
];

/** T.6 2D mode codes: [bits, mode]. */
const MODE_CODES: [string, number][] = [
  ["1", 0], // V0
  ["011", 1], // VR1
  ["010", 2], // VL1
  ["000011", 3], // VR2
  ["000010", 4], // VL2
  ["0000011", 5], // VR3
  ["0000010", 6], // VL3
  ["0001", 7], // PASS
  ["001", 8], // HORIZONTAL
];

const MODE_V_DELTA = [0, 1, -1, 2, -2, 3, -3];

/** (value | length << 13) → run, one map per colour. */
const RUN_TABLES: [Map<number, number>, Map<number, number>] = (() => {
  const build = (term: [number, string][], make: [number, string][]) => {
    const map = new Map<number, number>();
    for (const [run, bits] of [...term, ...make]) {
      let value = 0;
      for (const ch of bits) value = (value << 1) | (ch === "1" ? 1 : 0);
      map.set(value | (bits.length << 13), run);
    }
    return map;
  };
  return [build(WHITE_TERM, WHITE_MAKE), build(BLACK_TERM, BLACK_MAKE)];
})();

const MODE_TABLE = (() => {
  const map = new Map<number, number>();
  for (const [bits, mode] of MODE_CODES) {
    let value = 0;
    for (const ch of bits) value = (value << 1) | (ch === "1" ? 1 : 0);
    map.set(value | (bits.length << 13), mode);
  }
  return map;
})();

const REVERSE_BITS = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    let v = 0;
    for (let b = 0; b < 8; b += 1) {
      v = (v << 1) | ((i >> b) & 1);
    }
    table[i] = v;
  }
  return table;
})();

/** MSB-first bit reader over (fill-order normalized) fax bytes. */
class FaxBitReader {
  private readonly bytes: Uint8Array;
  private bitAt = 0;

  constructor(bytes: Uint8Array, reverseBytes: boolean) {
    if (!reverseBytes) {
      this.bytes = bytes;
    } else {
      const flipped = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i += 1) {
        flipped[i] = REVERSE_BITS[bytes[i]];
      }
      this.bytes = flipped;
    }
  }

  readBit(): number {
    const byteIndex = this.bitAt >> 3;
    if (byteIndex >= this.bytes.length) return -1;
    const bit = (this.bytes[byteIndex] >> (7 - (this.bitAt & 7))) & 1;
    this.bitAt += 1;
    return bit;
  }

  /** Skip optional fill zeros to an EOL; true when an EOL was consumed. */
  syncEol(): boolean {
    let zeros = 0;
    for (;;) {
      const bit = this.readBit();
      if (bit === -1) return false;
      if (bit === 1) return zeros >= 11;
      zeros += 1;
      if (zeros > 64) return false;
    }
  }

  /**
   * 1D lines may or may not carry EOLs. Peek: an EOL (11 zeros + 1) is
   * consumed (RTC — six back-to-back EOLs — reports "rtc"); any data
   * rewinds to just past the last consumed EOL so the bits stay part of
   * the line. No legal MH code starts with 11 zeros, so data/EOL never
   * collide at a code boundary.
   */
  syncOptionalEol(): "none" | "eol" | "rtc" | "eof" {
    const save = this.bitAt;
    let zeros = 0;
    let eols = 0;
    let afterEol = -1; // bit position just past the last consumed EOL
    for (;;) {
      const bit = this.readBit();
      if (bit === -1) return "eof";
      if (bit === 0) {
        zeros += 1;
        if (eols === 0 && zeros > 64) {
          this.bitAt = save;
          return "none"; // long zero runs are legal run data
        }
        continue;
      }
      // bit === 1
      if (zeros >= 11) {
        eols += 1;
        zeros = 0;
        afterEol = this.bitAt;
        if (eols >= 6) return "rtc";
        continue;
      }
      if (eols === 0) {
        this.bitAt = save;
        return "none";
      }
      // Line data after one or more EOLs — the zeros we read since the
      // last EOL belong to the next line's first code, so rewind there.
      this.bitAt = afterEol;
      return "eol";
    }
  }
}

function readFaxRun(reader: FaxBitReader, white: boolean): number {
  const table = RUN_TABLES[white ? 0 : 1];
  let value = 0;
  let length = 0;
  let total = 0;
  for (;;) {
    const bit = reader.readBit();
    if (bit === -1) return -1;
    value = (value << 1) | bit;
    length += 1;
    if (length > 13) return -1;
    const run = table.get(value | (length << 13));
    if (run !== undefined) {
      total += run;
      if (run < 64) return total; // Terminating code.
      value = 0;
      length = 0; // Makeup code: continue for the terminator.
    }
  }
}

/** One 1D (MH) line. Returns false when the stream ended. */
function decode1DLine(
  reader: FaxBitReader,
  line: Uint8Array,
  width: number
): boolean {
  let x = 0;
  let white = true;
  while (x < width) {
    const run = readFaxRun(reader, white);
    if (run === -1) return false;
    if (!white) line.fill(1, x, Math.min(x + run, width));
    x += run;
    white = !white;
  }
  return true;
}

function fillRun(line: Uint8Array, from: number, to: number, value: number): void {
  if (to > from) {
    line.fill(value, Math.max(0, from), Math.min(line.length, to));
  }
}

/**
 * b1: the first RUN BOUNDARY (changing element) strictly right of a0
 * whose run colour differs from the coding colour — or the line-end
 * sentinel (width) when none exists. A pixel inside a run that started
 * at or before a0 is NOT a changing element (matches the T.6 refLine
 * model: boundaries only, end-of-line as sentinel).
 */
function findB1(
  ref: Uint8Array | null,
  a0: number,
  color: number,
  width: number
): number {
  if (!ref) return width; // imaginary all-white reference
  const from = Math.max(0, a0 + 1);
  if (from === 0 && ref[0] !== color) return 0;
  for (let p = Math.max(1, from); p < width; p += 1) {
    if (ref[p] !== ref[p - 1] && ref[p] !== color) return p;
  }
  return width;
}

/** b2: the next run boundary after b1, or the line-end sentinel. */
function findB2(ref: Uint8Array | null, b1: number, width: number): number {
  if (!ref) return width;
  for (let p = Math.max(1, b1 + 1); p < width; p += 1) {
    if (ref[p] !== ref[p - 1]) return p;
  }
  return width;
}

/** One 2D (MR/MMR) line — G4 and the 2D lines of G3. */
function decode2DLine(
  reader: FaxBitReader,
  ref: Uint8Array | null,
  line: Uint8Array,
  width: number
): void {
  line.fill(0);
  let a0 = -1;
  let color = 0; // white
  for (;;) {
    if (a0 >= width) return;
    const b1 = findB1(ref, a0, color, width);
    const b2 = findB2(ref, b1, width);

    let value = 0;
    let length = 0;
    let mode = -1;
    for (;;) {
      const bit = reader.readBit();
      if (bit === -1) return; // stream exhausted: the rest stays white
      value = (value << 1) | bit;
      length += 1;
      const hit = MODE_TABLE.get(value | (length << 13));
      if (hit !== undefined) {
        mode = hit;
        break;
      }
      if (length > 7) return; // invalid mode code
    }

    if (mode === 7) {
      // PASS — the coding run extends through b2.
      fillRun(line, a0, b2, color);
      if (b2 <= a0) corrupt("fax: pass made no progress");
      a0 = b2;
    } else if (mode === 8) {
      // HORIZONTAL — two MH runs, current colour then opposite. At line
      // start a0 is the IMAGINARY position −1: both runs count from
      // pixel 0, so the fill starts at max(a0, 0).
      const r1 = readFaxRun(reader, color === 0);
      const r2 = readFaxRun(reader, color !== 0);
      if (r1 === -1 || r2 === -1) return;
      const start = a0 < 0 ? 0 : a0;
      fillRun(line, start, start + r1, color);
      fillRun(line, start + r1, start + r1 + r2, color === 0 ? 1 : 0);
      const next = start + r1 + r2;
      if (next <= a0) corrupt("fax: horizontal made no progress");
      a0 = next;
    } else {
      // Vertical: a1 relative to b1. The run covers [a0, a1).
      const a1 = b1 + MODE_V_DELTA[mode];
      fillRun(line, a0, a1, color);
      if (a1 <= a0) corrupt("fax: vertical went backwards");
      a0 = a1;
      color ^= 1;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Orientation                                                         */
/* ------------------------------------------------------------------ */

function applyOrientation(
  orientation: number,
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): void {
  switch (orientation) {
    case 0:
    case 1:
      return;
    case 2: // flip X
      mirrorX(rgba, width, height);
      return;
    case 3: // rotate 180
      reversePixels(rgba);
      return;
    case 4: // flip Y
      flipY(rgba, width, height);
      return;
    case 5: // transpose
      transpose(rgba, width, height);
      return;
    case 6: // rotate 90 CW
      rotate90cw(rgba, width, height);
      return;
    case 7: // anti-transpose
      reversePixels(rgba);
      transpose(rgba, width, height);
      return;
    case 8: // rotate 270 CW
      rotate90cw(rgba, width, height);
      rotate90cw(rgba, height, width);
      return;
  }
}

function mirrorX(rgba: Uint8ClampedArray, width: number, height: number): void {
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width >> 1; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        const i = row + x * 4 + c;
        const j = row + (width - 1 - x) * 4 + c;
        const t = rgba[i];
        rgba[i] = rgba[j];
        rgba[j] = t;
      }
    }
  }
}

function flipY(rgba: Uint8ClampedArray, width: number, height: number): void {
  for (let y = 0; y < height >> 1; y += 1) {
    const top = y * width * 4;
    const bottom = (height - 1 - y) * width * 4;
    for (let i = 0; i < width * 4; i += 1) {
      const t = rgba[top + i];
      rgba[top + i] = rgba[bottom + i];
      rgba[bottom + i] = t;
    }
  }
}

function reversePixels(rgba: Uint8ClampedArray): void {
  const pixels = rgba.length / 4;
  for (let p = 0; p < pixels >> 1; p += 1) {
    const q = pixels - 1 - p;
    for (let c = 0; c < 4; c += 1) {
      const t = rgba[p * 4 + c];
      rgba[p * 4 + c] = rgba[q * 4 + c];
      rgba[q * 4 + c] = t;
    }
  }
}

function transpose(rgba: Uint8ClampedArray, width: number, height: number): void {
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4;
      const to = (x * height + y) * 4;
      for (let c = 0; c < 4; c += 1) out[to + c] = rgba[from + c];
    }
  }
  rgba.set(out);
}

function rotate90cw(rgba: Uint8ClampedArray, width: number, height: number): void {
  // (x, y) → (height − 1 − y, x): W×H frame becomes H×W.
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4;
      const to = (x * height + (height - 1 - y)) * 4;
      for (let c = 0; c < 4; c += 1) out[to + c] = rgba[from + c];
    }
  }
  rgba.set(out);
}
