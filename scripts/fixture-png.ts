/**
 * Shared smoke fixture: a hand-built REAL PNG (no canvas, no assets —
 * pure node:zlib), used by the word-to-pdf / markdown-to-pdf image
 * embedding smokes (the epub smoke keeps its own 32×48 cover builder).
 * Same byte layout the epub smoke proves valid: 8-bit truecolor RGB,
 * filter 0, zlib IDAT, real CRCs.
 */
import { deflateSync } from "node:zlib";

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A w×h truecolor PNG where every pixel is (r, g, b). */
export function makeFixturePng(
  w = 64,
  h = 40,
  rgb: [number, number, number] = [0x2a, 0x5f, 0x9e]
): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 (truecolor RGB)
  const raw = new Uint8Array((w * 3 + 1) * h);
  let off = 0;
  for (let y = 0; y < h; y++) {
    raw[off++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      raw[off++] = rgb[0];
      raw[off++] = rgb[1];
      raw[off++] = rgb[2];
    }
  }
  const idat = new Uint8Array(deflateSync(Buffer.from(raw)));
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const out = new Uint8Array(sig.length + 25 + 12 + idat.length + 12);
  let pos = 0;
  out.set(sig, pos);
  pos += sig.length;
  out.set(pngChunk("IHDR", ihdr), pos);
  pos += 25;
  out.set(pngChunk("IDAT", idat), pos);
  pos += 12 + idat.length;
  out.set(pngChunk("IEND", new Uint8Array(0)), pos);
  return out;
}
