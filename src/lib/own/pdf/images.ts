/**
 * DocoPDF own PDF micro-engine — image embedding (P6-f).
 *
 * JPEG + PNG → PDF Image XObject inputs, mirroring pdf-lib's embedders:
 *
 *  - JPEG (JpegEmbedder parity): marker scan for SOF0..SOF15 (minus DHT/JPG/
 *    DAC), take precision/height/width/channels, pass the WHOLE file through
 *    as a DCTDecode stream (progressive SOF2 included — pdf-lib does the
 *    same). 4-channel → DeviceCMYK + /Decode [1 0 1 0 1 0 1 0] hedge.
 *  - PNG (PngEmbedder/@pdf-lib/upng parity): decode to 8-bit RGBA — all
 *    color types, bit depths 1/2/4/8/16 (16 → high byte), palette via PLTE,
 *    alpha via tRNS/GA/RGBA — then split into rgb + optional alpha (alpha is
 *    dropped when fully opaque, exactly like pdf-lib's hasAlphaValues check).
 *    Interlaced and animated PNGs are refused (upng refuses them too).
 *
 * All decompression/compression runs on OUR zip engine. Zero external code.
 */

import { unzlibSync, zlibSync } from "@/lib/own/zip";
import { PdfError } from "./parser";

export interface JpegInfo {
  width: number;
  height: number;
  /** Sample precision in bits (almost always 8). */
  bitsPerComponent: number;
  components: number;
  colorSpace: "DeviceGray" | "DeviceRGB" | "DeviceCMYK";
  /** The original, untouched JPEG bytes (DCT passthrough). */
  bytes: Uint8Array;
}

const SOF_MARKERS = new Set<number>([
  0xffc0, 0xffc1, 0xffc2, 0xffc3, 0xffc5, 0xffc6, 0xffc7,
  0xffc8, 0xffc9, 0xffca, 0xffcb, 0xffcc, 0xffcd, 0xffce, 0xffcf,
]);

/** Parse a JPEG header — the pdf-lib JpegEmbedder.for() recipe. */
export function parseJpeg(bytes: Uint8Array): JpegInfo {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new PdfError("logo", "SOI not found in JPEG");
  }
  let pos = 2;
  let marker = 0;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos += 1;
      continue; // tolerate stuffing garbage between segments
    }
    marker = (bytes[pos]! << 8) | bytes[pos + 1]!;
    pos += 2;
    if (SOF_MARKERS.has(marker)) break;
    if (pos + 2 > bytes.length) break;
    const segLen = (bytes[pos]! << 8) | bytes[pos + 1]!;
    pos += segLen;
  }
  if (!SOF_MARKERS.has(marker)) {
    throw new PdfError("logo", "Invalid JPEG (no SOF segment)");
  }
  // SOF payload: [len(2)] [precision(1)] [height(2)] [width(2)] [components(1)]
  // (pdf-lib skips the segment length AFTER breaking out of the scan loop.)
  pos += 2;
  if (pos + 8 > bytes.length) {
    throw new PdfError("logo", "Invalid JPEG (truncated SOF)");
  }
  const bitsPerComponent = bytes[pos]!;
  const height = (bytes[pos + 1]! << 8) | bytes[pos + 2]!;
  const width = (bytes[pos + 3]! << 8) | bytes[pos + 4]!;
  const components = bytes[pos + 5]!;
  const colorSpace =
    components === 1
      ? ("DeviceGray" as const)
      : components === 3
        ? ("DeviceRGB" as const)
        : components === 4
          ? ("DeviceCMYK" as const)
          : undefined;
  if (!colorSpace || width === 0 || height === 0 || bitsPerComponent === 0) {
    throw new PdfError("logo", "Unknown JPEG channel or dimensions");
  }
  return { width, height, bitsPerComponent, components, colorSpace, bytes };
}

export interface PngImage {
  width: number;
  height: number;
  /** RGB bytes, 3 per pixel (pdf-lib always expands to DeviceRGB). */
  rgb: Uint8Array;
  /** Alpha bytes, 1 per pixel — PRESENT only when some alpha < 255. */
  alpha: Uint8Array | undefined;
}

/** PNG signature bytes. */
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Decode a PNG to pdf-lib's embed shape (8-bit RGB + optional alpha). */
export function decodePng(bytes: Uint8Array): PngImage {
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (bytes[i] !== PNG_SIG[i]) {
      throw new PdfError("logo", "Not a PNG file");
    }
  }
  const chunks = readPngChunks(bytes);
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr || ihdr.data.length < 13) {
    throw new PdfError("logo", "PNG IHDR missing or truncated");
  }
  const width = readU32(ihdr.data, 0);
  const height = readU32(ihdr.data, 4);
  const bitDepth = ihdr.data[8]!;
  const colorType = ihdr.data[9]!;
  const interlace = ihdr.data[12]!;
  if (width === 0 || height === 0) throw new PdfError("logo", "PNG has zero size");
  if (interlace !== 0) throw new PdfError("logo", "Interlaced PNGs are not supported");
  if (bitDepth !== 1 && bitDepth !== 2 && bitDepth !== 4 && bitDepth !== 8 && bitDepth !== 16) {
    throw new PdfError("logo", `PNG bit depth ${bitDepth} unsupported`);
  }
  const channelsOf: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsOf[colorType];
  if (channels === undefined) throw new PdfError("logo", `Unknown PNG color type ${colorType}`);

  // Animated PNGs (acTL with >1 frame) — refused exactly like @pdf-lib/upng.
  const actl = chunks.find((c) => c.type === "acTL");
  if (actl && actl.data.length >= 4 && readU32(actl.data, 0) > 1) {
    throw new PdfError("logo", "Animated PNGs are not supported");
  }

  const idat = concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  if (idat.length === 0) throw new PdfError("logo", "PNG has no image data");
  let raw: Uint8Array;
  try {
    raw = unzlibSync(idat);
  } catch {
    throw new PdfError("logo", "PNG image data failed to decompress");
  }

  const plte = chunks.find((c) => c.type === "PLTE");
  const trns = chunks.find((c) => c.type === "tRNS");

  // ── unfilter (bit-depth aware: bpp = bytes per complete pixel) ──
  const bitsPerPixel = bitDepth * channels;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const bytesPerRow = (bitsPerPixel * width + 7) >> 3;
  if (raw.length < (bytesPerRow + 1) * height) {
    throw new PdfError("logo", "PNG image data truncated");
  }
  const unfiltered = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (bytesPerRow + 1)]!;
    const src = y * (bytesPerRow + 1) + 1;
    const cur = y * bytesPerRow;
    for (let i = 0; i < bytesPerRow; i++) {
      const x = raw[src + i] ?? 0;
      const a = i >= bpp ? unfiltered[cur + i - bpp]! : 0;
      const b = y > 0 ? unfiltered[cur - bytesPerRow + i]! : 0;
      const c = y > 0 && i >= bpp ? unfiltered[cur - bytesPerRow + i - bpp]! : 0;
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: v = x; break;
      }
      unfiltered[cur + i] = v & 0xff;
    }
  }

  // ── expand to 8-bit RGBA (upng toRGBA8 parity) ──
  const rgb = new Uint8Array(width * height * 3);
  const alpha = new Uint8Array(width * height);
  let hasAlpha = false;

  const scale = (sample: number, depth: number): number => {
    if (depth === 1) return sample ? 255 : 0;
    if (depth === 2) return Math.round((sample * 255) / 3);
    if (depth === 4) return sample * 17;
    return sample;
  };

  for (let y = 0; y < height; y++) {
    const row = unfiltered.subarray(y * bytesPerRow, (y + 1) * bytesPerRow);
    for (let x = 0; x < width; x++) {
      const o = y * width + x;
      let r = 0;
      let g = 0;
      let b = 0;
      let al = 255;
      if (colorType === 0) {
        const [sample, bits] = readSample(row, x, bitDepth, 1);
        const v = scale(sample, bitDepth);
        r = g = b = v;
        if (trns && trns.data.length >= 2) {
          const key = readU16(trns.data, 0);
          const keyV = bitDepth === 16 ? key >> 8 : scale(key, bitDepth);
          if (v === keyV) al = 0;
        }
      } else if (colorType === 2) {
        if (bitDepth === 16) {
          r = row[x * 6]!; g = row[x * 6 + 2]!; b = row[x * 6 + 4]!;
        } else {
          r = row[x * 3]!; g = row[x * 3 + 1]!; b = row[x * 3 + 2]!;
        }
        if (trns && trns.data.length >= 6) {
          const kr = trns.data[0]!;
          const kg = trns.data[2]!;
          const kb = trns.data[4]!;
          if (r === kr && g === kg && b === kb) al = 0;
        }
      } else if (colorType === 3) {
        if (!plte || plte.data.length < 3) {
          throw new PdfError("logo", "Palette PNG without PLTE");
        }
        const [index] = readSample(row, x, bitDepth, 1);
        const base = index * 3;
        r = plte.data[base] ?? 0;
        g = plte.data[base + 1] ?? 0;
        b = plte.data[base + 2] ?? 0;
        if (trns && index < trns.data.length) {
          al = trns.data[index]!;
        }
      } else if (colorType === 4) {
        if (bitDepth === 16) {
          const gray = row[x * 4]!;
          al = row[x * 4 + 2]!;
          r = g = b = gray;
        } else {
          const gray = scale(row[x * 2]!, bitDepth);
          r = g = b = gray;
          al = row[x * 2 + 1]!;
        }
      } else {
        // colorType 6 (RGBA)
        if (bitDepth === 16) {
          r = row[x * 8]!; g = row[x * 8 + 2]!; b = row[x * 8 + 4]!;
          al = row[x * 8 + 6]!;
        } else {
          r = row[x * 4]!; g = row[x * 4 + 1]!; b = row[x * 4 + 2]!;
          al = row[x * 4 + 3]!;
        }
      }
      rgb[o * 3] = r;
      rgb[o * 3 + 1] = g;
      rgb[o * 3 + 2] = b;
      alpha[o] = al;
      if (al < 255) hasAlpha = true;
    }
  }

  return { width, height, rgb, alpha: hasAlpha ? alpha : undefined };
}

/* ─── PNG plumbing ─────────────────────────────────────────────────────── */

interface PngChunk {
  type: string;
  data: Uint8Array;
}

function readPngChunks(bytes: Uint8Array): PngChunk[] {
  const chunks: PngChunk[] = [];
  let pos = PNG_SIG.length;
  while (pos + 8 <= bytes.length) {
    const len = readU32(bytes, pos);
    if (len > bytes.length - pos - 12) {
      throw new PdfError("logo", "PNG chunk overruns file");
    }
    const type = String.fromCharCode(
      bytes[pos + 4]!,
      bytes[pos + 5]!,
      bytes[pos + 6]!,
      bytes[pos + 7]!,
    );
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    chunks.push({ type, data });
    pos += 12 + len; // len + type + crc
    if (type === "IEND") break;
  }
  return chunks;
}

function readU32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

function readU16(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}

/**
 * Read sample #x (0-based) of a packed row with `channels` samples per pixel
 * at the given bit depth. Returns [sampleValue, bitsConsumed] — for 16-bit,
 * the HIGH byte (upng truncates to 8-bit RGBA too).
 */
function readSample(
  row: Uint8Array,
  x: number,
  bitDepth: number,
  _channels: number,
): [number, number] {
  if (bitDepth === 16) return [row[x * 2]!, 2];
  if (bitDepth === 8) return [row[x]!, 1];
  const bits = bitDepth;
  const bitPos = x * bits;
  const byte = row[bitPos >> 3]!;
  const shift = 8 - bits - (bitPos & 7);
  const mask = (1 << bits) - 1;
  return [(byte >> shift) & mask, 0];
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** zlib-compress image samples for a FlateDecode XObject. */
export function flateImageBytes(data: Uint8Array): Uint8Array {
  return zlibSync(data, 6);
}
