/**
 * DocoPDF own ZIP/DEFLATE engine — zlib (RFC 1950) and gzip-free helpers.
 * zlibSync: header (CMF/FLG with FCHECK) + deflate + Adler-32 trailer.
 * unzlibSync: validates header + trailer, returns the raw payload.
 * decompressSync: sniffs zlib / gzip / raw-deflate (fflate-compatible).
 */

import { deflate } from "./deflate";
import { inflate } from "./inflate";
import { adler32 } from "./adler32";
import { crc32 } from "./crc32";

/** Compress into a zlib stream. Accepts a level (0-9) or fflate-style opts. */
export function zlibSync(
  data: Uint8Array,
  opts: number | { level?: number } = 6
): Uint8Array {
  const level = typeof opts === "number" ? opts : (opts.level ?? 6);
  const body = deflate(data, level);
  const out = new Uint8Array(body.length + 6);
  // CMF: CM=8 (deflate), CINFO=7 (32K window) → 0x78
  const cmf = 0x78;
  // FLG: FLEVEL from level (0=fastest,1=fast,2=default,3=maximum); FCHECK
  // chosen so (CMF*256 + FLG) % 31 == 0. FDICT never set.
  const flevel = level >= 8 ? 3 : level >= 6 ? 2 : level >= 3 ? 1 : 0;
  let flg = flevel << 6;
  const rem = (cmf * 256 + flg) % 31;
  if (rem !== 0) flg += 31 - rem;
  out[0] = cmf;
  out[1] = flg;
  out.set(body, 2);
  const adler = adler32(data);
  out[out.length - 4] = (adler >>> 24) & 0xff;
  out[out.length - 3] = (adler >>> 16) & 0xff;
  out[out.length - 2] = (adler >>> 8) & 0xff;
  out[out.length - 1] = adler & 0xff;
  return out;
}

/** Decompress a zlib stream; verifies the Adler-32 trailer. */
export function unzlibSync(data: Uint8Array): Uint8Array {
  if (data.length < 6) {
    throw new Error("zlib: stream too short");
  }
  const cmf = data[0];
  const flg = data[1];
  if ((cmf & 0x0f) !== 8) {
    throw new Error("zlib: unsupported compression method");
  }
  if (((cmf << 8) | flg) % 31 !== 0) {
    throw new Error("zlib: header check failed");
  }
  if (flg & 0x20) {
    throw new Error("zlib: preset dictionaries are not supported");
  }
  const { bytes, consumed } = inflate(data.subarray(2, data.length - 4));
  const a =
    ((data[data.length - 4] << 24) |
      (data[data.length - 3] << 16) |
      (data[data.length - 2] << 8) |
      data[data.length - 1]) >>>
    0;
  const expect = adler32(bytes);
  if (a !== expect) {
    throw new Error("zlib: Adler-32 mismatch");
  }
  // All payload bytes must be consumed by the deflate stream (the trailer
  // sits immediately after; the 4 extra slack bytes allow the reader's
  // byte-aligned final byte to be counted).
  if (consumed > data.length - 6) {
    throw new Error("zlib: stream overruns trailer");
  }
  return bytes;
}

/** Decompress auto-detecting zlib (0x78..) / gzip (0x1f 8b) / raw deflate. */
export function decompressSync(data: Uint8Array): Uint8Array {
  if (data.length >= 2 && (data[0] & 0x0f) === 8 && (data[0] * 256 + data[1]) % 31 === 0) {
    return unzlibSync(data);
  }
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    return gunzipSync(data);
  }
  return inflate(data).bytes;
}

/** Strip a gzip container (RFC 1952) — header + deflate + CRC32 + ISIZE. */
export function gunzipSync(data: Uint8Array): Uint8Array {
  if (data[0] !== 0x1f || data[1] !== 0x8b || data[2] !== 8) {
    throw new Error("gzip: bad magic or method");
  }
  const flg = data[3];
  let p = 10;
  if (flg & 0x04) {
    // FEXTRA
    const xlen = data[p] | (data[p + 1] << 8);
    p += 2 + xlen;
  }
  if (flg & 0x08) {
    while (p < data.length && data[p] !== 0) p++;
    p++;
  }
  if (flg & 0x10) {
    while (p < data.length && data[p] !== 0) p++;
    p++;
  }
  if (flg & 0x02) {
    p += 2; // FHCRC
  }
  const { bytes, consumed } = inflate(data.subarray(p, data.length - 8));
  const crc =
    ((data[data.length - 8] << 24) |
      (data[data.length - 7] << 16) |
      (data[data.length - 6] << 8) |
      data[data.length - 5]) >>>
    0;
  if (crc32(bytes) !== crc) {
    throw new Error("gzip: CRC-32 mismatch");
  }
  const isize =
    ((data[data.length - 4] |
      (data[data.length - 3] << 8) |
      (data[data.length - 2] << 16) |
      (data[data.length - 1] << 24)) >>>
      0);
  if (bytes.length !== isize) {
    throw new Error("gzip: length mismatch");
  }
  void consumed;
  return bytes;
}
