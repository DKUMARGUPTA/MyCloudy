import { crc32, zlibSync } from "@/lib/own/zip";

/**
 * Minimal PNG encoder (PHASE-3 batch 3) — 8-bit RGBA, no interlace —
 * built on the OWN zip engine's deflate + crc32. Pure data-in/data-out
 * (Node-smokeable), used by bmp-to-pdf / cbz-to-pdf so image conversion
 * never depends on a canvas.
 */

const BE32 = (value: number): Uint8Array =>
  new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  out.set(BE32(data.length), 0);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  out.set(BE32(crc >>> 0), 8 + data.length);
  return out;
}

/** Encode RGBA pixels as a PNG (filter 0 rows, zlib IDAT). */
export function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array
): Uint8Array {
  if (width <= 0 || height <= 0 || rgba.length !== width * height * 4) {
    throw new Error("png-encode: bad dimensions");
  }

  // IHDR: width, height, bit depth 8, color type 6 (RGBA), no filters.
  const ihdr = new Uint8Array(13);
  ihdr.set(BE32(width), 0);
  ihdr.set(BE32(height), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // compression 0, filter 0, interlace 0 (already zero)

  // Raw scanlines: each row prefixed with filter byte 0.
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const dst = y * (1 + width * 4);
    raw[dst] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), dst + 1);
  }

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrChunk = chunk("IHDR", ihdr);
  const idatChunk = chunk("IDAT", zlibSync(raw, 6));
  const iendChunk = chunk("IEND", new Uint8Array(0));

  const out = new Uint8Array(
    signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length
  );
  let at = 0;
  out.set(signature, at);
  at += signature.length;
  out.set(ihdrChunk, at);
  at += ihdrChunk.length;
  out.set(idatChunk, at);
  at += idatChunk.length;
  out.set(iendChunk, at);
  return out;
}
