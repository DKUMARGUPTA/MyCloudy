/**
 * DocoPDF own PDF micro-engine — general stream decoding (P6-r).
 *
 * The parser's `decodeForParser` only ever needs Flate/ASCIIHex (xref and
 * object streams). Compress-family tools decode IMAGE streams with the
 * full lossless filter set; this module implements that surface — pure
 * byte-in/byte-out, no DOM, bun-safe:
 *
 *   FlateDecode    zlib with raw-deflate tolerance (parser recipe)
 *   LZWDecode      PDF flavour, /EarlyChange (default 1 = widen at
 *                  2^w − 1), growable output (size unknown ahead)
 *   ASCIIHexDecode  nibbles until '>' (parser recipe, tolerant)
 *   ASCII85Decode   5→4 groups, 'z' shorthand, '~>' EOD
 *   RunLengthDecode literal/run byte pairs, 128 = EOD
 *   Predictors      PNG 10–15 via pngUnfilter; TIFF Predictor 2 (8bpc)
 *
 * DCTDecode/JPXDecode/CCITTFaxDecode/JBIG2Decode throw "unsupported" —
 * the caller classifies those strategies itself (DCT rides the browser's
 * native JPEG decoder, the rest are honest skips).
 */

import { inflateSync, unzlibSync } from "@/lib/own/zip";
import { type PdfObj, asNum, dget } from "./objects";
import { PdfError, pngUnfilter } from "./parser";

/** One /DecodeParms slot (absent keys default per spec). */
interface Parms {
  predictor: number;
  colors: number;
  columns: number;
  bits: number;
  earlyChange: number;
}

const DEFAULT_PARMS: Parms = {
  predictor: 1,
  colors: 1,
  columns: 1,
  bits: 8,
  earlyChange: 1,
};

function parmsOf(dict: Map<string, PdfObj>, index: number): Parms {
  const raw = dget({ k: "dict", m: dict }, "DecodeParms") ??
    dget({ k: "dict", m: dict }, "DP");
  if (raw === undefined || raw.k === "null") return DEFAULT_PARMS;
  let slot: PdfObj | undefined = raw;
  if (raw.k === "arr") slot = raw.items[index];
  if (!slot || (slot.k !== "dict" && slot.k !== "stream")) return DEFAULT_PARMS;
  const m = slot.m;
  return {
    predictor: asNum(m.get("Predictor")) ?? 1,
    colors: asNum(m.get("Colors")) ?? 1,
    columns: asNum(m.get("Columns")) ?? 1,
    bits: asNum(m.get("BitsPerComponent")) ?? 8,
    earlyChange: asNum(m.get("EarlyChange")) ?? 1,
  };
}

/* ── individual filters ─────────────────────────────────────────── */

function flateDecode(data: Uint8Array): Uint8Array {
  try {
    return unzlibSync(data);
  } catch {
    try {
      return inflateSync(data); // raw stream from buggy producers
    } catch {
      throw new PdfError("corrupt", "FlateDecode stream failed to inflate");
    }
  }
}

function asciiHexDecode(data: Uint8Array): Uint8Array {
  const nib: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x3e /* > */) break;
    const c = data[i]!;
    let v = -1;
    if (c >= 0x30 && c <= 0x39) v = c - 0x30;
    else if (c >= 0x41 && c <= 0x46) v = c - 0x41 + 10;
    else if (c >= 0x61 && c <= 0x66) v = c - 0x61 + 10;
    else if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    else return new Uint8Array(0); // malformed hex — degrade to empty
    nib.push(v);
  }
  const out = new Uint8Array(nib.length >> 1);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (nib[2 * i]! << 4) | nib[2 * i + 1]!;
  }
  return out;
}

/** ASCII85: 5 chars → 4 bytes, 'z' = four zeros, '~>' EOD, whitespace skipped. */
export function ascii85Decode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let group: number[] = [];
  const flush = (chars: number[]): void => {
    // A final partial group of n chars encodes n−1 bytes.
    const n = chars.length;
    if (n === 0) return;
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      value = value * 85 + (i < n ? chars[i]! : 84);
    }
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    for (let i = 0; i < n - 1; i += 1) out.push(bytes[i]!);
  };
  for (let i = 0; i < data.length; i += 1) {
    const c = data[i]!;
    if (c === 0x7e /* ~ */) break; // EOD — trailing '>' ignored after
    if (c === 0x7a /* z */) {
      // Only legal between complete groups.
      if (group.length === 0) out.push(0, 0, 0, 0);
      continue;
    }
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c < 0x21 || c > 0x75) {
      throw new PdfError("corrupt", "ASCII85Decode stream has a bad character");
    }
    group.push(c - 0x21);
    if (group.length === 5) {
      flush(group);
      group = [];
    }
  }
  flush(group);
  return Uint8Array.from(out);
}

/** RunLength: 0..127 → n+1 literals; 129..255 → 257−n repeats; 128 = EOD. */
export function runLengthDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const n = data[i]!;
    i += 1;
    if (n === 128) break; // EOD
    if (n < 128) {
      for (let k = 0; k <= n && i < data.length; k += 1) out.push(data[i++]!);
    } else {
      if (i >= data.length) break;
      const byte = data[i]!;
      i += 1;
      for (let k = 0; k < 257 - n; k += 1) out.push(byte);
    }
  }
  return Uint8Array.from(out);
}

/**
 * PDF-flavour LZW decode. Codes: 256 clear, 257 EOD, 258+ table.
 * `earlyChange` 1 (default) widens the code width one code early (at
 * 2^w − 1 — the same rhythm as TIFF's Adobe flavour); 0 widens at 2^w.
 * Output grows on demand — the decoded size is unknown ahead.
 */
export function lzwDecode(input: Uint8Array, earlyChange: boolean): Uint8Array {
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  for (let i = 0; i < 256; i += 1) first[i] = i;
  // Output buffer: doubles when full (images are multi-MB).
  let out = new Uint8Array(1 << 16);
  let outLen = 0;
  const ensure = (extra: number): void => {
    if (outLen + extra <= out.length) return;
    let cap = out.length;
    while (cap < outLen + extra) cap *= 2;
    const grown = new Uint8Array(cap);
    grown.set(out.subarray(0, outLen));
    out = grown;
  };
  // Chain stack — a code's string is at most 4096−258+1 bytes deep.
  const stack = new Uint8Array(4400);
  const emitChain = (code: number, extra: number): void => {
    let depth = 0;
    let c = code;
    while (c >= 256) {
      if (depth >= 4352) throw new PdfError("corrupt", "LZW chain too deep");
      stack[depth++] = suffix[c];
      c = prefix[c];
    }
    stack[depth++] = c;
    ensure(depth + (extra >= 0 ? 1 : 0));
    while (depth > 0) out[outLen++] = stack[--depth];
    if (extra >= 0) out[outLen++] = extra;
  };

  let bitBuffer = 0;
  let bitCount = 0;
  let inAt = 0;
  const readCode = (width: number): number => {
    while (bitCount < width) {
      if (inAt >= input.length) return -1;
      bitBuffer = (bitBuffer << 8) | input[inAt++]!;
      bitCount += 8;
    }
    bitCount -= width;
    return (bitBuffer >>> bitCount) & ((1 << width) - 1);
  };

  let width = 9;
  let nextCode = 258;
  let prev = -1;
  for (;;) {
    const code = readCode(width);
    if (code === -1) break; // input exhausted
    if (code === 256) {
      width = 9;
      nextCode = 258;
      prev = -1;
      continue;
    }
    if (code === 257) break; // end-of-data marker
    if (prev === -1) {
      if (code > 255) {
        throw new PdfError("corrupt", "LZW first code is not a literal");
      }
      emitChain(code, -1);
      prev = code;
      continue;
    }
    if (code > nextCode) {
      throw new PdfError("corrupt", "LZW code references an undefined entry");
    }
    // KwKwK: code === nextCode emits the previous string plus its own
    // first byte (the entry does not exist yet at emit time).
    const kwkwk = code === nextCode;
    emitChain(kwkwk ? prev : code, kwkwk ? first[prev]! : -1);
    if (nextCode < 4096) {
      prefix[nextCode] = prev;
      suffix[nextCode] = kwkwk ? first[prev]! : first[code]!;
      first[nextCode] = first[prev]!;
      nextCode += 1;
      const bound = earlyChange ? (1 << width) - 1 : 1 << width;
      if (width < 12 && nextCode === bound) width += 1;
    }
    prev = code;
  }
  return out.subarray(0, outLen);
}

/** TIFF Predictor 2 (horizontal deltas, 8 bits per component). */
function tiffPredictor2(data: Uint8Array, colors: number, columns: number): Uint8Array {
  if (colors < 1 || columns < 1) return data;
  const rowLen = colors * columns;
  if (rowLen === 0 || data.length % rowLen !== 0) return data; // not row-aligned
  const out = data.slice();
  for (let r = 0; r < out.length; r += rowLen) {
    for (let c = colors; c < rowLen; c += 1) {
      out[r + c] = (out[r + c]! + out[r + c - colors]!) & 0xff;
    }
  }
  return out;
}

function applyPredictor(data: Uint8Array, p: Parms): Uint8Array {
  if (p.predictor >= 10) {
    if (p.bits !== 8) {
      throw new PdfError("unsupported", `PNG predictor with ${p.bits}-bit samples`);
    }
    return pngUnfilter(data, p.colors, p.columns);
  }
  if (p.predictor === 2) {
    if (p.bits !== 8) {
      throw new PdfError("unsupported", `TIFF predictor with ${p.bits}-bit samples`);
    }
    return tiffPredictor2(data, p.colors, p.columns);
  }
  return data;
}

/**
 * Applies a stream's /Filter chain (+/DecodeParms) to its raw body.
 * Throws PdfError("unsupported") for filters this engine does not decode
 * (DCT/JPX/CCITT/JBIG2/…), "corrupt" for undecodable bytes.
 */
export function decodeStreamBytes(raw: Uint8Array, dict: Map<string, PdfObj>): Uint8Array {
  const filterObj = dget({ k: "dict", m: dict }, "Filter");
  if (filterObj === undefined) return raw;

  const filters: string[] = [];
  if (filterObj.k === "name") filters.push(filterObj.v);
  else if (filterObj.k === "arr") {
    for (const f of filterObj.items) {
      if (f.k !== "name") throw new PdfError("corrupt", "bad /Filter array");
      filters.push(f.v);
    }
  } else return raw;

  let data = raw;
  for (let i = 0; i < filters.length; i += 1) {
    const f = filters[i]!;
    const p = parmsOf(dict, i);
    if (f === "FlateDecode" || f === "Fl") {
      data = applyPredictor(flateDecode(data), p);
    } else if (f === "LZWDecode" || f === "LZW") {
      data = applyPredictor(
        lzwDecode(data, p.earlyChange !== 0),
        p,
      );
    } else if (f === "ASCIIHexDecode" || f === "AHx") {
      data = asciiHexDecode(data);
    } else if (f === "ASCII85Decode" || f === "A85") {
      data = ascii85Decode(data);
    } else if (f === "RunLengthDecode" || f === "RL") {
      data = runLengthDecode(data);
    } else {
      throw new PdfError("unsupported", `filter ${f} not decodable here`);
    }
  }
  return data;
}
