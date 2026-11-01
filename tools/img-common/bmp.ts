/**
 * BMP codec (PHASE-3 batch 3) — a self-written, dependency-free BMP
 * reader + writer shared by pdf-to-bmp / bmp-to-pdf. Pure data-in /
 * data-out so the smoke tests drive it in Node without a DOM.
 *
 *  ENCODE: 24-bit BI_RGB, bottom-up rows, 4-byte row padding — the
 *          maximally-compatible shape every reader opens.
 *  DECODE: BITMAPINFOHEADER (40) + BITMAPV4/V5 (108/124) headers,
 *          24/32-bit BI_RGB, 8-bit palettised, bottom-up AND top-down
 *          (negative height). Anything else is rejected honestly.
 */

/** Raw RGBA image data (premultiplied nothing — straight alpha). */
export interface RawImage {
  width: number;
  height: number;
  /** RGBA, row-major, top-down, length = width * height * 4. */
  rgba: Uint8Array;
}

/* ------------------------------------------------------------------ */
/* Decode                                                              */
/* ------------------------------------------------------------------ */

const u16 = (b: Uint8Array, o: number): number =>
  b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const i32 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24);

/** Decode a BMP into RGBA. Throws on anything unsupported (message
 * starts with "b2p." so workers can surface it honestly). */
export function decodeBmp(bytes: Uint8Array): RawImage {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    throw new Error("b2p.errorNotBmp");
  }
  const pixelOffset = u32(bytes, 10);
  const headerSize = u32(bytes, 14);
  if (headerSize < 40) {
    throw new Error("b2p.errorUnsupportedBmp");
  }
  const width = i32(bytes, 18);
  const heightRaw = i32(bytes, 22);
  const topDown = heightRaw < 0;
  const height = Math.abs(heightRaw);
  const planes = u16(bytes, 26);
  const bpp = u16(bytes, 28);
  const compression = u32(bytes, 30);
  if (
    !Number.isFinite(width) || width <= 0 || width > 30000 ||
    !Number.isFinite(height) || height <= 0 || height > 30000 ||
    planes !== 1 ||
    (bpp !== 8 && bpp !== 24 && bpp !== 32) ||
    compression !== 0
  ) {
    throw new Error("b2p.errorUnsupportedBmp");
  }

  const rowBytes = Math.floor((bpp * width + 31) / 32) * 4;
  const needed = pixelOffset + rowBytes * height;
  if (bytes.length < needed) {
    throw new Error("b2p.errorTruncated");
  }

  // 8-bit palettised: /Colors may be 0 → 2^bpp entries.
  let palette: Uint8Array | null = null;
  if (bpp === 8) {
    const usedColors = u32(bytes, 46);
    const count = usedColors === 0 ? 256 : usedColors;
    palette = bytes.subarray(14 + headerSize, 14 + headerSize + count * 4);
    if (palette.length < count * 4) {
      throw new Error("b2p.errorTruncated");
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  const bytesPerPixel = bpp / 8;

  for (let y = 0; y < height; y += 1) {
    // BMP rows are stored bottom-up by default; top-down when negative.
    const srcRow = topDown ? y : height - 1 - y;
    const src = pixelOffset + srcRow * rowBytes;
    const dst = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const di = dst + x * 4;
      if (bpp === 8) {
        const idx = bytes[src + x]! * 4;
        // Palette entries are BGRX: [B, G, R, 0].
        rgba[di] = palette![idx + 2]!; // R
        rgba[di + 1] = palette![idx + 1]!; // G
        rgba[di + 2] = palette![idx]!; // B
        rgba[di + 3] = 255;
      } else {
        const si = src + x * bytesPerPixel;
        rgba[di] = bytes[si + 2]!; // BGR → RGB
        rgba[di + 1] = bytes[si + 1]!;
        rgba[di + 2] = bytes[si]!;
        rgba[di + 3] = bpp === 32 ? bytes[si + 3]! : 255;
      }
    }
  }

  return { width, height, rgba };
}

/* ------------------------------------------------------------------ */
/* Encode                                                              */
/* ------------------------------------------------------------------ */

/** Encode RGBA pixels as a 24-bit bottom-up BMP (alpha dropped). */
export function encodeBmp(image: RawImage): Uint8Array {
  const { width, height, rgba } = image;
  const rowBytes = Math.floor((24 * width + 31) / 32) * 4;
  const pad = rowBytes - width * 3;
  const pixelBytes = rowBytes * height;
  const size = 54 + pixelBytes;
  const out = new Uint8Array(size);

  // BITMAPFILEHEADER (14)
  out[0] = 0x42; // 'B'
  out[1] = 0x4d; // 'M'
  out[2] = size & 0xff;
  out[3] = (size >>> 8) & 0xff;
  out[4] = (size >>> 16) & 0xff;
  out[5] = (size >>> 24) & 0xff;
  // reserved = 0
  out[10] = 54; // pixel data offset

  // BITMAPINFOHEADER (40)
  out[14] = 40;
  out[18] = width & 0xff;
  out[19] = (width >>> 8) & 0xff;
  out[20] = (width >>> 16) & 0xff;
  out[21] = (width >>> 24) & 0xff;
  out[22] = height & 0xff;
  out[23] = (height >>> 8) & 0xff;
  out[24] = (height >>> 16) & 0xff;
  out[25] = (height >>> 24) & 0xff;
  out[26] = 1; // planes
  out[27] = 0;
  out[28] = 24; // bpp
  out[30] = 0; // BI_RGB
  out[34] = pixelBytes & 0xff;
  out[35] = (pixelBytes >>> 8) & 0xff;
  out[36] = (pixelBytes >>> 16) & 0xff;
  out[37] = (pixelBytes >>> 24) & 0xff;
  out[38] = 0x13; // 72 DPI (2835 ppm)
  out[39] = 0x0b;
  out[42] = 0x13;
  out[43] = 0x0b;

  // Pixels, bottom-up, BGR, padded.
  for (let y = 0; y < height; y += 1) {
    const srcRow = height - 1 - y;
    const dst = 54 + y * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const si = (srcRow * width + x) * 4;
      const di = dst + x * 3;
      out[di] = rgba[si + 2]!; // B
      out[di + 1] = rgba[si + 1]!; // G
      out[di + 2] = rgba[si]!; // R
    }
    for (let p = 0; p < pad; p += 1) {
      out[dst + width * 3 + p] = 0;
    }
  }

  return out;
}
