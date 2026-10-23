/**
 * Minimal PNG encoder (RGBA, 8-bit, filter Sub) for the image pipeline —
 * used by pdf-to-svg extract-images (and any future path that needs the
 * exact RGBA bytes in a PNG without a canvas premultiply/color
 * round-trip that nudges pixels by ±4).
 *
 * Structure: signature, IHDR, one IDAT (zlib stream via fflate zlibSync),
 * IEND. The Sub filter (left-neighbour delta, bpp 4) typically shrinks
 * photo data 30-50% versus no filtering.
 */

import { zlibSync } from "fflate";

/** Raw RGBA pixels: the decode-side shape this encoder consumes. */
export interface RgbaImage {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Applies the Sub filter to one row (in place into `dst`). */
function filterSub(
  row: Uint8Array | Uint8ClampedArray,
  dst: Uint8Array
): void {
  for (let i = 0; i < row.length; i += 1) {
    dst[i] = (row[i] - (i >= 4 ? row[i - 4] : 0)) & 0xff;
  }
}

export function pngEncode(image: RgbaImage): Blob {
  const { width, height, data } = image;
  if (width <= 0 || height <= 0 || data.length < width * height * 4) {
    throw new Error("invalid-rgba");
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const filtered = new Uint8Array((stride + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    filtered[offset] = 1; // Sub filter
    filterSub(data.subarray(y * stride, (y + 1) * stride), filtered.subarray(offset + 1, offset + 1 + stride));
    offset += stride + 1;
  }

  const idat = zlibSync(filtered, { level: 6 });
  const signature = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const ihdrChunk = chunk("IHDR", ihdr);
  const idatChunk = chunk("IDAT", idat);
  const iendChunk = chunk("IEND", new Uint8Array(0));

  const total =
    signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const png = new Uint8Array(total);
  let at = 0;
  png.set(signature, at);
  at += signature.length;
  png.set(ihdrChunk, at);
  at += ihdrChunk.length;
  png.set(idatChunk, at);
  at += idatChunk.length;
  png.set(iendChunk, at);

  return new Blob([png as unknown as BlobPart], { type: "image/png" });
}
