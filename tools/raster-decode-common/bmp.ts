/**
 * PURE BMP decoder (P3-c, R57) — Windows/OS2 bitmap → RGBA raster.
 *
 * Own implementation from the published format specification (Microsoft
 * Windows DIB docs + OS/2 BMP spec). ZERO third-party code — bentopdf is
 * AGPL, this file is a clean-room spec implementation.
 *
 * Supported (honest, documented):
 *   - headers: BITMAPCOREHEADER (12), BITMAPINFOHEADER (40),
 *     BITMAPV2/V3 (52/56 — colour masks), BITMAPV4HEADER (108),
 *     BITMAPV5HEADER (124)
 *   - compression: BI_RGB (0), BI_RLE8 (1), BI_RLE4 (2),
 *     BI_BITFIELDS (3), BI_ALPHABITFIELDS (6)
 *   - depths: 1, 4, 8 (palette), 16, 24, 32 (direct)
 *   - bottom-up (height > 0) and top-down (height < 0) row order
 *   - BI_BITFIELDS masks incl. alpha (V4/V5 header or the post-INFOHEADER
 *     mask dwords); plain 32-bit BI_RGB keeps the 4th byte reserved
 *     (opaque) exactly like browser decoders
 *
 * Honest refusals (BmpDecodeError):
 *   - "corrupt": truncated data, bad signature, impossible geometry,
 *     truncated RLE stream, palette short of the file
 *   - "unsupported": BI_JPEG (4) / BI_PNG (5) embedded payloads,
 *     exotic bit depths, DIB headers we do not know
 *   - "too-large": over MAX_RASTER_PIXELS (memory guard)
 *
 * Smoke: scripts/smoke-p3c-imports.ts (fixtures authored in-code).
 */

/** Shared raster cap for the P3-c decoders (40 MP ≈ 160 MB RGBA). */
export const MAX_RASTER_PIXELS = 40_000_000;

export interface RasterImage {
  width: number;
  height: number;
  /** RGBA, row-major, TOP-DOWN first row, straight (non-premultiplied) alpha. */
  rgba: Uint8ClampedArray;
  /** True when at least one pixel has alpha < 255 (PNG-vs-JPEG pick hint). */
  hasAlpha: boolean;
  /** Source bit depth (1/4/8/16/24/32 BMP, 8 PSD) — PNG-preference hint. */
  depth?: number;
}

export type RasterFailCode = "corrupt" | "unsupported" | "too-large";

export class BmpDecodeError extends Error {
  constructor(
    public readonly code: RasterFailCode,
    message: string,
  ) {
    super(message);
    this.name = "BmpDecodeError";
  }
}

/** File signature "BM" (0x42 0x4D). */
export function isBmpBytes(head: Uint8Array): boolean {
  return head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d;
}

/* ─── little-endian readers ──────────────────────────────────────────────── */

function u16le(b: Uint8Array, off: number): number {
  if (off < 0 || off + 2 > b.length) throw new BmpDecodeError("corrupt", "short read (u16)");
  return b[off]! | (b[off + 1]! << 8);
}

function u32le(b: Uint8Array, off: number): number {
  if (off < 0 || off + 4 > b.length) throw new BmpDecodeError("corrupt", "short read (u32)");
  return (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0;
}

function i32le(b: Uint8Array, off: number): number {
  return u32le(b, off) | 0;
}

/* ─── channel masks ──────────────────────────────────────────────────────── */

interface ChannelMask {
  mask: number;
  shift: number;
  /** 0 = channel absent (mask 0). */
  bits: number;
}

function channel(mask: number): ChannelMask {
  if (mask === 0) return { mask: 0, shift: 0, bits: 0 };
  let shift = 0;
  while (shift < 32 && ((mask >>> shift) & 1) === 0) shift += 1;
  let bits = 0;
  for (let i = shift; i < 32 && ((mask >>> i) & 1) === 1; i += 1) bits += 1;
  return { mask, shift, bits };
}

/** Scaled 0..255 sample from a masked field value. */
function sample(v: number, m: ChannelMask): number {
  if (m.bits === 0) return 0xff;
  const raw = (v & m.mask) >>> m.shift;
  const max = (1 << m.bits) - 1;
  return Math.round((raw / max) * 255);
}

/* ─── the decoder ────────────────────────────────────────────────────────── */

const BI_RGB = 0;
const BI_RLE8 = 1;
const BI_RLE4 = 2;
const BI_BITFIELDS = 3;
const BI_ALPHABITFIELDS = 6;

type RgbaQuad = readonly [number, number, number, number];

export function decodeBmp(bytes: Uint8Array): RasterImage {
  if (!isBmpBytes(bytes)) {
    throw new BmpDecodeError("corrupt", "missing BM signature");
  }
  if (bytes.length < 18) {
    throw new BmpDecodeError("corrupt", "file shorter than file header + DIB size");
  }
  const dataOffset = u32le(bytes, 10);
  const dibSize = u32le(bytes, 14);

  let width: number;
  let height: number;
  let bitCount: number;
  let compression = BI_RGB;
  let clrUsed = 0;

  if (dibSize === 12) {
    // OS/2 BITMAPCOREHEADER — u16 fields, always BI_RGB, 3-byte palette.
    width = u16le(bytes, 18);
    height = u16le(bytes, 20);
    const planes = u16le(bytes, 22);
    if (planes !== 1) throw new BmpDecodeError("corrupt", `planes ${planes}`);
    bitCount = u16le(bytes, 24);
  } else if (dibSize === 40 || dibSize === 52 || dibSize === 56 || dibSize === 108 || dibSize === 124) {
    width = i32le(bytes, 18);
    height = i32le(bytes, 22);
    const planes = u16le(bytes, 26);
    if (planes !== 1) throw new BmpDecodeError("corrupt", `planes ${planes}`);
    bitCount = u16le(bytes, 28);
    compression = u32le(bytes, 30);
    clrUsed = u32le(bytes, 46);
  } else {
    throw new BmpDecodeError("unsupported", `DIB header size ${dibSize}`);
  }

  if (bitCount !== 1 && bitCount !== 4 && bitCount !== 8 && bitCount !== 16 && bitCount !== 24 && bitCount !== 32) {
    throw new BmpDecodeError("unsupported", `${bitCount}-bit depth`);
  }
  if (compression === 4 || compression === 5) {
    throw new BmpDecodeError("unsupported", "embedded JPEG/PNG payloads are not supported");
  }
  if (
    compression !== BI_RGB &&
    compression !== BI_RLE8 &&
    compression !== BI_RLE4 &&
    compression !== BI_BITFIELDS &&
    compression !== BI_ALPHABITFIELDS
  ) {
    throw new BmpDecodeError("unsupported", `compression ${compression}`);
  }
  if (compression === BI_RLE8 && bitCount !== 8) {
    throw new BmpDecodeError("corrupt", "RLE8 with non-8-bit depth");
  }
  if (compression === BI_RLE4 && bitCount !== 4) {
    throw new BmpDecodeError("corrupt", "RLE4 with non-4-bit depth");
  }
  if ((compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS) && bitCount !== 16 && bitCount !== 32) {
    throw new BmpDecodeError("corrupt", `bitfields with ${bitCount}-bit depth`);
  }

  const topDown = height < 0;
  const rows = Math.abs(height);
  if (width <= 0 || rows <= 0) {
    throw new BmpDecodeError("corrupt", `geometry ${width}x${rows}`);
  }
  if (width > 32768 || rows > 32768) {
    throw new BmpDecodeError("corrupt", `geometry ${width}x${rows} exceeds 32768`);
  }
  if (width * rows > MAX_RASTER_PIXELS) {
    throw new BmpDecodeError("too-large", `${width}x${rows} exceeds ${MAX_RASTER_PIXELS} pixels`);
  }

  /* Colour masks — defaults per depth, BITFIELDS overrides. */
  let rMask: ChannelMask = channel(0);
  let gMask: ChannelMask = channel(0);
  let bMask: ChannelMask = channel(0);
  let aMask: ChannelMask = channel(0);
  if (bitCount === 16 && compression === BI_RGB) {
    // default RGB555
    rMask = channel(0x7c00);
    gMask = channel(0x03e0);
    bMask = channel(0x001f);
  }
  if (compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS) {
    // masks live right after the 40 INFOHEADER fields in every header ≥ V2;
    // with a plain 40-byte header they sit between header and palette.
    const src = 14 + 40;
    rMask = channel(u32le(bytes, src));
    gMask = channel(u32le(bytes, src + 4));
    bMask = channel(u32le(bytes, src + 8));
    if (compression === BI_ALPHABITFIELDS || dibSize >= 56) {
      aMask = channel(u32le(bytes, src + 12));
    }
    if (rMask.bits === 0 || gMask.bits === 0 || bMask.bits === 0) {
      throw new BmpDecodeError("corrupt", "bitfields with a zero colour mask");
    }
  }

  /* Direct 16/24/32-bit (BITFIELDS masks or RGB555 defaults in plan). */
  if (bitCount === 16 || bitCount === 24 || bitCount === 32) {
    return decodeRaster(bytes, {
      width,
      rows,
      topDown,
      bitCount,
      compression,
      dataOffset,
      headerEnd: 14 + dibSize,
      rMask,
      gMask,
      bMask,
      aMask,
      lookup: null,
    });
  }

  /* Palette (≤ 8-bit). BITFIELDS masks sit between header and palette when
   * the DIB header is exactly 40 bytes. */
  let paletteStart = 14 + dibSize;
  if (compression === BI_BITFIELDS && dibSize === 40) paletteStart += 12;
  if (compression === BI_ALPHABITFIELDS && dibSize === 40) paletteStart += 16;
  const entrySize = dibSize === 12 ? 3 : 4;
  const count = clrUsed === 0 ? 1 << bitCount : Math.min(clrUsed, 1 << bitCount);
  const paletteBytes = count * entrySize;
  if (paletteStart + paletteBytes > bytes.length) {
    throw new BmpDecodeError("corrupt", "palette truncated");
  }
  const palette = bytes.subarray(paletteStart, paletteStart + paletteBytes);
  const lookup = (idx: number): RgbaQuad => {
    const base = idx * entrySize;
    if (idx < 0 || base + entrySize > palette.length) {
      return [0, 0, 0, 255]; // out-of-range index → honest black, opaque
    }
    const b = palette[base]!;
    const g = palette[base + 1]!;
    const r = palette[base + 2]!;
    const a = entrySize === 4 ? palette[base + 3]! : 255;
    return [r, g, b, a === 0 ? 255 : a];
  };
  return decodeRaster(bytes, {
    width,
    rows,
    topDown,
    bitCount,
    compression,
    dataOffset,
    headerEnd: paletteStart + paletteBytes,
    rMask,
    gMask,
    bMask,
    aMask,
    lookup,
  });
}

/* ─── pixel engines ──────────────────────────────────────────────────────── */

interface DecodePlan {
  width: number;
  rows: number;
  topDown: boolean;
  bitCount: number;
  compression: number;
  dataOffset: number;
  /** End of header+palette(+masks) — pixel data must start at/after this. */
  headerEnd: number;
  rMask: ChannelMask;
  gMask: ChannelMask;
  bMask: ChannelMask;
  aMask: ChannelMask;
  lookup: ((idx: number) => RgbaQuad) | null;
}

function decodeRaster(bytes: Uint8Array, plan: DecodePlan): RasterImage {
  const { width, rows, topDown, bitCount, compression, dataOffset, headerEnd } = plan;
  const rgba = new Uint8ClampedArray(width * rows * 4);
  let hasAlpha = false;

  const setPx = (x: number, yRow: number, r: number, g: number, b: number, a: number): void => {
    if (x < 0 || x >= width || yRow < 0 || yRow >= rows) return; // RLE overshoot guard
    const y = topDown ? yRow : rows - 1 - yRow;
    const o = (y * width + x) * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = a;
    if (a < 255) hasAlpha = true;
  };

  /* Uncompressed / bitfields: rows padded to 4 bytes. */
  if (compression === BI_RGB || compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS) {
    const rowBytes = Math.ceil((width * bitCount) / 8);
    const rowStride = (rowBytes + 3) & ~3;
    const start = Math.max(dataOffset, headerEnd);
    if (start + rowStride * rows > bytes.length) {
      const have = Math.floor((bytes.length - start) / rowStride);
      throw new BmpDecodeError(
        "corrupt",
        `pixel data truncated (${Math.max(have, 0)}/${rows} rows present)`,
      );
    }
    for (let yRow = 0; yRow < rows; yRow += 1) {
      const row = start + yRow * rowStride;
      for (let x = 0; x < width; x += 1) {
        if (bitCount === 1 || bitCount === 4 || bitCount === 8) {
          const idx = readPaletteIndex(bytes, row, x, bitCount);
          const [r, g, b, a] = plan.lookup!(idx);
          setPx(x, yRow, r, g, b, a);
        } else if (bitCount === 16) {
          const v = u16le(bytes, row + x * 2);
          setPx(
            x,
            yRow,
            sample(v, plan.rMask),
            sample(v, plan.gMask),
            sample(v, plan.bMask),
            plan.aMask.bits > 0 ? sample(v, plan.aMask) : 255,
          );
        } else if (bitCount === 24) {
          const o = row + x * 3;
          setPx(x, yRow, bytes[o + 2]!, bytes[o + 1]!, bytes[o]!, 255);
        } else {
          const o = row + x * 4;
          const v = u32le(bytes, o);
          if (plan.rMask.bits > 0 || plan.gMask.bits > 0 || plan.bMask.bits > 0) {
            // BITFIELDS: every channel (incl. alpha) through its mask.
            setPx(
              x,
              yRow,
              sample(v, plan.rMask),
              sample(v, plan.gMask),
              sample(v, plan.bMask),
              plan.aMask.bits > 0 ? sample(v, plan.aMask) : 255,
            );
          } else {
            // BI_RGB: B,G,R,X byte order, reserved 4th byte (opaque).
            setPx(x, yRow, bytes[o + 2]!, bytes[o + 1]!, bytes[o]!, 255);
          }
        }
      }
    }
    return { width, height: rows, rgba, hasAlpha, depth: bitCount };
  }

  /* RLE8 / RLE4 — encoded stream from the pixel start to end of buffer. */
  const data = bytes.subarray(Math.max(dataOffset, headerEnd));
  let p = 0;
  const readByte = (): number => {
    if (p >= data.length) throw new BmpDecodeError("corrupt", "RLE stream truncated");
    return data[p++]!;
  };
  let x = 0;
  let yRow = 0;
  // Delta holes keep palette-0 (the classic decoder behaviour).
  if (plan.lookup) {
    const [r, g, b, a] = plan.lookup(0);
    if (a < 255) hasAlpha = true;
    for (let o = 0; o < rgba.length; o += 4) {
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    }
  }
  for (;;) {
    const count = readByte();
    const value = readByte();
    if (count > 0) {
      if (bitCount === 8) {
        const [r, g, b, a] = plan.lookup!(value);
        for (let i = 0; i < count; i += 1) {
          setPx(x, yRow, r, g, b, a);
          x += 1;
        }
      } else {
        const hi = (value >> 4) & 0x0f;
        const lo = value & 0x0f;
        for (let i = 0; i < count; i += 1) {
          const [r, g, b, a] = plan.lookup!(i % 2 === 0 ? hi : lo);
          setPx(x, yRow, r, g, b, a);
          x += 1;
        }
      }
      continue;
    }
    if (value === 0) {
      x = 0;
      yRow += 1;
      if (yRow >= rows) break; // trailing EOLs — stop like real decoders
      continue;
    }
    if (value === 1) break; // end of bitmap
    if (value === 2) {
      const dx = readByte();
      const dy = readByte();
      x += dx;
      yRow += dy;
      if (yRow >= rows) break;
      continue;
    }
    // absolute run: `value` pixels follow literally
    if (bitCount === 8) {
      if (p + value > data.length) {
        throw new BmpDecodeError("corrupt", "RLE absolute run truncated");
      }
      for (let i = 0; i < value; i += 1) {
        const [r, g, b, a] = plan.lookup!(data[p + i]!);
        setPx(x, yRow, r, g, b, a);
        x += 1;
      }
      p += value + (value % 2 === 1 ? 1 : 0); // word padding
    } else {
      const byteCount = Math.ceil(value / 2);
      if (p + byteCount > data.length) {
        throw new BmpDecodeError("corrupt", "RLE absolute run truncated");
      }
      for (let i = 0; i < value; i += 1) {
        const b0 = data[p + (i >> 1)]!;
        const nibble = (b0 >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
        const [r, g, b, a] = plan.lookup!(nibble);
        setPx(x, yRow, r, g, b, a);
        x += 1;
      }
      p += byteCount + (byteCount % 2 === 1 ? 1 : 0); // word padding
    }
  }
  return { width, height: rows, rgba, hasAlpha, depth: bitCount };
}

/** Palette index at pixel x of a packed row (1/4/8-bit, MSB-first). */
function readPaletteIndex(bytes: Uint8Array, row: number, x: number, bitCount: number): number {
  if (bitCount === 8) return bytes[row + x]!;
  if (bitCount === 4) {
    const b0 = bytes[row + (x >> 1)]!;
    return (x % 2 === 0 ? b0 >> 4 : b0) & 0x0f;
  }
  const b0 = bytes[row + (x >> 3)]!;
  return (b0 >> (7 - (x & 7))) & 0x01;
}
