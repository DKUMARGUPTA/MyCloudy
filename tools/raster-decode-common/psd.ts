/**
 * PURE PSD composite decoder (P3-c, R57) — Adobe Photoshop file → the
 * flattened composite raster (what Photoshop saves for previews).
 *
 * Own implementation from the published Adobe "Photoshop File Format"
 * specification. ZERO third-party code — bentopdf is AGPL, this file is a
 * clean-room spec implementation.
 *
 * What this reads (and ALL it reads — layers are NOT interpreted, the
 * saved composite image is the honest "flatten" Photoshop itself embeds):
 *   - File header: 8BPS signature, version 1 (PSD) and 2 (PSB — the only
 *     composite-relevant difference is the 8-byte layer section length)
 *   - Color mode: Grayscale (1) and RGB (3), depth 8
 *   - Composite image data: raw (compression 0) and PackBits RLE (1),
 *     channel-planar, interleaved to RGBA (4th channel = alpha when
 *     present, Photoshop semantics 0 = transparent)
 *
 * Honest refusals (PsdDecodeError):
 *   - "corrupt": wrong signature, truncated sections/rows
 *   - "unsupported": depth ≠ 8 (16/32-bit deep composites), colour modes
 *     other than Grayscale/RGB (Bitmap/Indexed/CMYK/Lab/Multichannel),
 *     composite larger than MAX_RASTER_PIXELS
 *
 * Smoke: scripts/smoke-p3c-imports.ts (fixtures authored in-code).
 */

import { MAX_RASTER_PIXELS, type RasterImage, type RasterFailCode } from "./bmp";

export class PsdDecodeError extends Error {
  constructor(
    public readonly code: RasterFailCode,
    message: string,
  ) {
    super(message);
    this.name = "PsdDecodeError";
  }
}

/** File signature "8BPS" (0x38 0x42 0x50 0x53). */
export function isPsdBytes(head: Uint8Array): boolean {
  return (
    head.length >= 4 &&
    head[0] === 0x38 &&
    head[1] === 0x42 &&
    head[2] === 0x50 &&
    head[3] === 0x53
  );
}

export interface PsdImage extends RasterImage {
  /** Number of channels in the composite (3/4 RGB, 1/2 gray). */
  channels: number;
  /** Grayscale composite (PNG-preferred render hint). */
  gray: boolean;
}

/* ─── big-endian readers ─────────────────────────────────────────────────── */

function u16be(b: Uint8Array, off: number): number {
  if (off < 0 || off + 2 > b.length) throw new PsdDecodeError("corrupt", "short read (u16)");
  return (b[off]! << 8) | b[off + 1]!;
}

function u32be(b: Uint8Array, off: number): number {
  if (off < 0 || off + 4 > b.length) throw new PsdDecodeError("corrupt", "short read (u32)");
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

function u64be(b: Uint8Array, off: number): number {
  const hi = u32be(b, off);
  const lo = u32be(b, off + 4);
  return hi * 0x1_0000_0000 + lo;
}

/* ─── PackBits ───────────────────────────────────────────────────────────── */

/** Decode one PackBits row of `width` bytes; returns the consumed length. */
function unpackBits(
  src: Uint8Array,
  srcStart: number,
  width: number,
  out: Uint8Array,
  outStart: number,
): number {
  let sp = srcStart;
  let dp = outStart;
  const end = outStart + width;
  while (dp < end) {
    if (sp >= src.length) {
      throw new PsdDecodeError("corrupt", "PackBits stream truncated");
    }
    const n = src[sp++]!;
    if (n <= 127) {
      // literal run: n + 1 bytes
      const count = n + 1;
      if (sp + count > src.length || dp + count > end + 1) {
        throw new PsdDecodeError("corrupt", "PackBits literal run overflows the row");
      }
      for (let i = 0; i < count; i += 1) out[dp + i] = src[sp + i]!;
      sp += count;
      dp += count;
    } else if (n >= 129) {
      // repeat run: 257 − n copies of the next byte
      const count = 257 - n;
      if (sp >= src.length || dp + count > end) {
        throw new PsdDecodeError("corrupt", "PackBits repeat run overflows the row");
      }
      const v = src[sp++]!;
      for (let i = 0; i < count; i += 1) out[dp + i] = v;
      dp += count;
    }
    // n === 128: no-op
  }
  return sp - srcStart;
}

/* ─── the decoder ────────────────────────────────────────────────────────── */

export function decodePsd(bytes: Uint8Array): PsdImage {
  if (!isPsdBytes(bytes)) {
    throw new PsdDecodeError("corrupt", "missing 8BPS signature");
  }
  if (bytes.length < 26) {
    throw new PsdDecodeError("corrupt", "file shorter than the PSD header");
  }
  const version = u16be(bytes, 4);
  if (version !== 1 && version !== 2) {
    throw new PsdDecodeError("unsupported", `PSD version ${version}`);
  }
  const channels = u16be(bytes, 12);
  const height = u32be(bytes, 14);
  const width = u32be(bytes, 18);
  const depth = u16be(bytes, 22);
  const colorMode = u16be(bytes, 24);

  if (width === 0 || height === 0 || width > 30000 || height > 30000) {
    throw new PsdDecodeError("corrupt", `geometry ${width}x${height}`);
  }
  if (width * height > MAX_RASTER_PIXELS) {
    throw new PsdDecodeError("too-large", `${width}x${height} exceeds ${MAX_RASTER_PIXELS} pixels`);
  }
  if (depth !== 8) {
    throw new PsdDecodeError("unsupported", `${depth}-bit depth composites are not supported`);
  }
  const gray = colorMode === 1;
  if (!gray && colorMode !== 3) {
    throw new PsdDecodeError(
      "unsupported",
      `colour mode ${colorMode} (only Grayscale and RGB composites are supported)`,
    );
  }
  const expectedChannels = gray ? 1 : 3;
  const hasAlpha = channels === expectedChannels + 1;
  if (channels !== expectedChannels && !hasAlpha) {
    throw new PsdDecodeError(
      "unsupported",
      `${channels} channels for ${gray ? "grayscale" : "RGB"} composite`,
    );
  }

  /* Skip colour-mode data + image resources. */
  let off = 26;
  const colorDataLen = u32be(bytes, off);
  off += 4 + colorDataLen;
  const resourcesLen = u32be(bytes, off);
  off += 4 + resourcesLen;
  const layerLen = version === 2 ? u64be(bytes, off) : u32be(bytes, off);
  off += version === 2 ? 8 : 4;
  off += layerLen;

  if (off + 2 > bytes.length) {
    throw new PsdDecodeError("corrupt", "composite section missing");
  }
  const compression = u16be(bytes, off);
  off += 2;
  if (compression !== 0 && compression !== 1) {
    throw new PsdDecodeError("unsupported", `compression ${compression}`);
  }

  /* Channel-planar composite → interleaved RGBA. */
  const plane = width * height;
  const planes: Uint8Array[] = [];
  for (let c = 0; c < channels; c += 1) planes.push(new Uint8Array(plane));

  if (compression === 0) {
    if (off + plane * channels > bytes.length) {
      throw new PsdDecodeError("corrupt", "raw composite data truncated");
    }
    for (let c = 0; c < channels; c += 1) {
      planes[c].set(bytes.subarray(off, off + plane));
      off += plane;
    }
  } else {
    // RLE: per-row byte counts, channel-major (all rows of channel 0, then 1…)
    const countsOff = off;
    const countsLen = 2 * channels * height;
    if (countsOff + countsLen > bytes.length) {
      throw new PsdDecodeError("corrupt", "RLE row-size table truncated");
    }
    let dataOff = countsOff + countsLen;
    for (let c = 0; c < channels; c += 1) {
      for (let row = 0; row < height; row += 1) {
        const rowLen = u16be(bytes, countsOff + 2 * (c * height + row));
        const consumed = unpackBits(bytes, dataOff, width, planes[c]!, row * width);
        if (consumed !== rowLen) {
          // The row-size table and the data disagree — decode what the
          // stream itself says, advance by the table (Photoshop writes
          // both consistently; a mismatch means a damaged file).
          if (dataOff + rowLen > bytes.length) {
            throw new PsdDecodeError("corrupt", "RLE row data truncated");
          }
        }
        dataOff += rowLen;
      }
    }
  }

  const rgba = new Uint8ClampedArray(plane * 4);
  let sawAlpha = false;
  const alphaPlane = hasAlpha ? planes[channels - 1]! : null;
  for (let i = 0; i < plane; i += 1) {
    if (gray) {
      const g = planes[0]![i]!;
      rgba[i * 4] = g;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = g;
    } else {
      rgba[i * 4] = planes[0]![i]!;
      rgba[i * 4 + 1] = planes[1]![i]!;
      rgba[i * 4 + 2] = planes[2]![i]!;
    }
    const a = alphaPlane ? alphaPlane[i]! : 255;
    rgba[i * 4 + 3] = a;
    if (a < 255) sawAlpha = true;
  }
  return { width, height, rgba, hasAlpha: sawAlpha, depth: 8, channels, gray };
}
