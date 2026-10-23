import { decompressSync } from "fflate";

import type {
  DeclaredLevel,
  FontUse,
  PdfaCheck,
  PdfaLevel,
  PdfaReport,
  ReportLabels,
  ReportMeta,
  RunOptions,
  XmpInfo,
} from "./types";

/**
 * Validate PDF/A (RB7-b) — PURE model, bun-testable, no DOM, no pdf.js,
 * no pdf-lib, zero ambient dependencies beyond fflate's decompressSync
 * (itself pure). Every check is a pure function over the raw bytes.
 *
 * Pipeline:
 *   toLatin(bytes) → walkPdf(s)   (xref/trailer chain + linear object scan
 *                                 recovery + object-stream expansion —
 *                                 the verify-pdf-signatures walk pattern,
 *                                 re-written in-model, no cross-tool import)
 *   catalog → pages tree → per-page content streams (inflated) + resources
 *   XMP (/Metadata stream → parseable pdfaid:part/conformance + dc:*)
 *   checks (see types.ts contract) → verdict → report text
 *
 * HONESTY (mirrored in the FAQ + the report footer): this is a
 * veraPDF-inspired HONEST SUBSET of ISO 19005 — roughly 15 rule
 * families, not the full standard. A COMPLIANT verdict means "passed
 * every check in this subset", never "certified PDF/A by an accredited
 * lab". The light PDF/UA hints group is advisory and never affects the
 * PDF/A verdict.
 */

/* ------------------------------------------------------------------ */
/* Sanity caps                                                         */
/* ------------------------------------------------------------------ */

/** Input gate — a PDF larger than this is not a sane validate target. */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_OBJECTS = 200_000;
const MAX_XREF_CHAIN = 64;
const MAX_TREE_DEPTH = 32;
const MAX_TREE_LEAVES = 10_000;
/** Per-stream decode cap (bomb guard). */
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
/** Total decoded content budget across the whole document. */
const MAX_TOTAL_CONTENT_BYTES = 48 * 1024 * 1024;
/** Content token cap per document (bomb guard for the operator scanner). */
const MAX_TOKENS = 400_000;
const MAX_FONTS = 2_000;
const MAX_ANNOTS = 5_000;
const MAX_FORM_DEPTH = 4;
const MAX_STRUCT_NODES = 5_000;

/* ------------------------------------------------------------------ */
/* Errors (worker maps these onto i18n keys)                          */
/* ------------------------------------------------------------------ */

export type PdfaErrorCode =
  | "errNotPdf"
  | "errTooBig"
  | "errCorrupt";

/** Typed model error — the worker maps `code` onto an i18n key. */
export class PdfaError extends Error {
  readonly code: PdfaErrorCode;
  constructor(code: PdfaErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "PdfaError";
  }
}

/* ------------------------------------------------------------------ */
/* Byte-faithful latin1 + sniff                                        */
/* ------------------------------------------------------------------ */

/** Lossless byte→string (one char per byte, codepoints 0x00–0xFF). */
export function toLatin(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(
      null,
      Array.prototype.slice.call(bytes.subarray(i, i + CHUNK)) as number[]
    );
  }
  return out;
}

/** True when the bytes carry the %PDF- magic (header may sit at any offset). */
export function sniffPdfBytes(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 2048);
  for (let i = 0; i + 4 < head.length; i += 1) {
    if (
      head[i] === 0x25 /* % */ &&
      head[i + 1] === 0x50 /* P */ &&
      head[i + 2] === 0x44 /* D */ &&
      head[i + 3] === 0x46 /* F */ &&
      head[i + 4] === 0x2d /* - */
    ) {
      return true;
    }
  }
  return false;
}

/** latin1 string span → bytes. */
function latin1BytesOf(s: string, from: number, to: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, to - from));
  for (let i = 0; i < out.length; i += 1) out[i] = s.charCodeAt(from + i) & 0xff;
  return out;
}

/* ================================================================== */
/* PART 1 — raw PDF value parser (own in-model copy)                   */
/* ================================================================== */

const WS = " \t\r\n\f\0";

/**
 * Decodes a PDF string VALUE for display/comparison: hex strings are
 * byte-decoded (UTF-16BE when the BOM is present, else latin1); literal
 * strings were already unescaped by the parser (pdf-lib writes /Info
 * entries as UTF-16BE hex — the mirror check must read them decoded).
 */
function decodePdfStringText(v: PdfStrVal): string {
  if (!v.hex) return v.text;
  let digits = "";
  for (const c of v.text) {
    if (/^[0-9A-Fa-f]$/.test(c)) digits += c;
  }
  if (digits.length === 0 || digits.length % 2 !== 0) return v.text;
  const bytes = new Uint8Array(digits.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
  }
  return toLatin(bytes);
}

interface PdfNameVal {
  k: "name";
  pos: number;
  end: number;
  name: string;
}
interface PdfStrVal {
  k: "str";
  pos: number;
  end: number;
  hex: boolean;
  text: string;
}
interface PdfNumVal {
  k: "num";
  pos: number;
  end: number;
  num: number;
}
interface PdfRefVal {
  k: "ref";
  pos: number;
  end: number;
  num: number;
  gen: number;
}
interface PdfBoolVal {
  k: "bool";
  pos: number;
  end: number;
  v: boolean;
}
interface PdfNullVal {
  k: "null";
  pos: number;
  end: number;
}
interface PdfArrVal {
  k: "arr";
  pos: number;
  end: number;
  items: PdfVal[];
}
interface PdfDictVal {
  k: "dict";
  pos: number;
  end: number;
  map: Map<string, PdfVal>;
}
type PdfVal =
  | PdfNameVal
  | PdfStrVal
  | PdfNumVal
  | PdfRefVal
  | PdfBoolVal
  | PdfNullVal
  | PdfArrVal
  | PdfDictVal;

function skipWs(s: string, i: number): number {
  let p = i;
  while (p < s.length) {
    const c = s[p];
    if (c === "%") {
      p += 1;
      while (p < s.length && s[p] !== "\n" && s[p] !== "\r") p += 1;
      continue;
    }
    if (WS.indexOf(c) >= 0) {
      p += 1;
      continue;
    }
    break;
  }
  return p;
}

function isPdfDelimiter(c: string): boolean {
  return WS.indexOf(c) >= 0 || "()<>[]{}/%".indexOf(c) >= 0;
}

function readPdfName(s: string, at: number): PdfNameVal | null {
  let i = at + 1; // past '/'
  let name = "";
  while (i < s.length) {
    const c = s[i];
    if (c === "#") {
      const hex = s.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        name += String.fromCharCode(Number.parseInt(hex, 16));
        i += 3;
        continue;
      }
    }
    if (isPdfDelimiter(c)) break;
    name += c;
    i += 1;
  }
  if (name.length === 0) return null;
  return { k: "name", pos: at, end: i, name };
}

/**
 * parsePdfValue — the tolerant raw PDF value parser (dicts, arrays,
 * names, literal + hex strings, numbers, refs, bool, null).
 * Returns null on junk (the caller recovers to the next plausible start).
 */
export function parsePdfValue(
  s: string,
  at: number,
  depth = 0
): { v: PdfVal; end: number } | null {
  if (depth > 64) return null;
  const i = skipWs(s, at);
  if (i >= s.length) return null;
  const c = s[i];
  if (c === "<" && s[i + 1] === "<") {
    let p = i + 2;
    const map = new Map<string, PdfVal>();
    for (;;) {
      p = skipWs(s, p);
      if (s.startsWith(">>", p)) {
        return { v: { k: "dict", pos: i, end: p + 2, map }, end: p + 2 };
      }
      if (p >= s.length) return null;
      if (s[p] !== "/") return null;
      const key = readPdfName(s, p);
      if (key === null) return null;
      p = key.end;
      const value = parsePdfValue(s, p, depth + 1);
      if (value === null) return null;
      map.set(key.name, value.v);
      p = value.end;
    }
  }
  if (c === "[") {
    let p = i + 1;
    const items: PdfVal[] = [];
    for (;;) {
      p = skipWs(s, p);
      if (s[p] === "]") return { v: { k: "arr", pos: i, end: p + 1, items }, end: p + 1 };
      if (p >= s.length) return null;
      const value = parsePdfValue(s, p, depth + 1);
      if (value === null) return null;
      items.push(value.v);
      p = value.end;
    }
  }
  if (c === "/") {
    const name = readPdfName(s, i);
    return name === null ? null : { v: name, end: name.end };
  }
  if (c === "(") {
    let p = i + 1;
    let depthP = 1;
    let text = "";
    while (p < s.length) {
      const ch = s[p];
      if (ch === "\\") {
        const nx = s[p + 1];
        if (nx === "n") { text += "\n"; p += 2; continue; }
        if (nx === "r") { text += "\r"; p += 2; continue; }
        if (nx === "t") { text += "\t"; p += 2; continue; }
        if (nx === "b") { text += "\b"; p += 2; continue; }
        if (nx === "f") { text += "\f"; p += 2; continue; }
        if (nx === "(") { text += "("; p += 2; continue; }
        if (nx === ")") { text += ")"; p += 2; continue; }
        if (nx === "\\") { text += "\\"; p += 2; continue; }
        if (nx >= "0" && nx <= "7") {
          const oct = /^[0-7]{1,3}/.exec(s.slice(p + 1, p + 4));
          if (oct !== null) {
            text += String.fromCharCode(Number.parseInt(oct[0], 8) & 0xff);
            p += 1 + oct[0].length;
            continue;
          }
        }
        if (nx === "\n") { p += 2; continue; }
        if (nx === "\r") {
          p += s[p + 2] === "\n" ? 3 : 2;
          continue;
        }
        text += nx ?? "";
        p += 2;
        continue;
      }
      if (ch === "(") { depthP += 1; text += ch; p += 1; continue; }
      if (ch === ")") {
        depthP -= 1;
        if (depthP === 0) {
          return { v: { k: "str", pos: i + 1, end: p, hex: false, text }, end: p + 1 };
        }
        text += ch;
        p += 1;
        continue;
      }
      text += ch;
      p += 1;
    }
    return null; // unterminated
  }
  if (c === "<") {
    const close = s.indexOf(">", i + 1);
    if (close < 0) return null;
    return {
      v: { k: "str", pos: i + 1, end: close, hex: true, text: s.slice(i + 1, close) },
      end: close + 1,
    };
  }
  if (c === "t" && s.startsWith("true", i)) {
    return { v: { k: "bool", pos: i, end: i + 4, v: true }, end: i + 4 };
  }
  if (c === "f" && s.startsWith("false", i)) {
    return { v: { k: "bool", pos: i, end: i + 5, v: false }, end: i + 5 };
  }
  if (c === "n" && s.startsWith("null", i)) {
    return { v: { k: "null", pos: i, end: i + 4 }, end: i + 4 };
  }
  if (c >= "0" && c <= "9") {
    const ref = /^([0-9]{1,9})[ \t\r\n\f\0]+([0-9]{1,3})[ \t\r\n\f\0]+R(?![a-zA-Z])/.exec(
      s.slice(i, i + 40)
    );
    if (ref !== null) {
      return {
        v: {
          k: "ref",
          pos: i,
          end: i + ref[0].length,
          num: Number.parseInt(ref[1], 10),
          gen: Number.parseInt(ref[2], 10),
        },
        end: i + ref[0].length,
      };
    }
    const numMatch = /^[0-9]*\.?[0-9]+/.exec(s.slice(i, i + 32));
    if (numMatch === null) return null;
    const num = Number.parseFloat(numMatch[0]);
    if (!Number.isFinite(num)) return null;
    return { v: { k: "num", pos: i, end: i + numMatch[0].length, num }, end: i + numMatch[0].length };
  }
  if (c === "-" || c === "+" || c === ".") {
    const numMatch = /^[-+]?[0-9]*\.?[0-9]+/.exec(s.slice(i, i + 32));
    if (numMatch === null) return null;
    const num = Number.parseFloat(numMatch[0]);
    if (!Number.isFinite(num)) return null;
    return { v: { k: "num", pos: i, end: i + numMatch[0].length, num }, end: i + numMatch[0].length };
  }
  return null;
}

/* ---- parsed objects ---------------------------------------------- */

export interface PdfObject {
  num: number;
  gen: number;
  offset: number;
  value: PdfVal | null;
  /** Offset just past the parsed value. */
  end: number;
  /** Stream data span (after "stream" + EOL) when present, else -1. */
  streamStart: number;
  streamEnd: number;
}

function skipEol(s: string, i: number): number {
  if (s[i] === "\r" && s[i + 1] === "\n") return i + 2;
  if (s[i] === "\r" || s[i] === "\n") return i + 1;
  return i;
}

/** Attaches the stream span when a "stream" keyword follows the value. */
function attachStreamSpan(s: string, obj: PdfObject): void {
  if (obj.value === null || obj.value.k !== "dict") return;
  const p = skipWs(s, obj.end);
  if (!s.startsWith("stream", p)) return;
  const data = skipEol(s, p + 6);
  obj.streamStart = data;
  let len = -1;
  const lenVal = obj.value.map.get("Length");
  if (
    lenVal !== undefined &&
    lenVal.k === "num" &&
    Number.isInteger(lenVal.num) &&
    lenVal.num >= 0
  ) {
    len = lenVal.num;
  }
  let streamEnd = -1;
  if (len >= 0 && data + len <= s.length) {
    const afterLen = skipWs(s, data + len);
    if (s.startsWith("endstream", afterLen) || s.startsWith("endstream", data + len)) {
      streamEnd = data + len;
    }
  }
  if (streamEnd < 0) {
    const es = s.indexOf("endstream", data);
    if (es >= 0) streamEnd = es;
  }
  if (streamEnd >= 0) obj.streamEnd = streamEnd;
}

/** Parses the object at `off` ("N G obj" must start exactly there). */
function parseObjectAt(s: string, off: number): PdfObject | null {
  const head = /^([0-9]{1,9})[ \t\r\n\f\0]+([0-9]{1,3})[ \t\r\n\f\0]+obj/.exec(
    s.slice(off, off + 40)
  );
  if (head === null) return null;
  const obj: PdfObject = {
    num: Number.parseInt(head[1], 10),
    gen: Number.parseInt(head[2], 10),
    offset: off,
    value: null,
    end: off + head[0].length,
    streamStart: -1,
    streamEnd: -1,
  };
  const parsed = parsePdfValue(s, obj.end);
  if (parsed !== null) {
    obj.value = parsed.v;
    obj.end = parsed.end;
    attachStreamSpan(s, obj);
  }
  return obj;
}

/** Parses a bare value at `at` and attaches a stream span (object-stream inner objects). */
function parseInnerValueAt(s: string, at: number): { v: PdfVal; end: number } | null {
  const parsed = parsePdfValue(s, at);
  if (parsed === null) return null;
  const fake: PdfObject = {
    num: 0,
    gen: 0,
    offset: at,
    value: parsed.v,
    end: parsed.end,
    streamStart: -1,
    streamEnd: -1,
  };
  attachStreamSpan(s, fake);
  // Streams are not allowed inside object streams (PDF 32000-1 §7.5.7);
  // if a producer wrote one anyway, keep the value, drop the bogus span.
  if (fake.value === null) return null;
  return { v: fake.value, end: fake.end };
}

/* ================================================================== */
/* PART 2 — xref chain (classic tables + xref streams)                  */
/* ================================================================== */

interface XrefWalk {
  kind: "table" | "stream" | "none";
  /** Healthy enough to trust (chain parsed, sampled offsets valid, root found). */
  ok: boolean;
  reason: string | null;
  rootRef: { num: number; gen: number } | null;
  /** Raw /Info value from the newest trailer/xref-stream dict. */
  infoVal: PdfVal | null;
  encrypted: boolean;
  /** All xref offsets (type-2 entries encoded as -1-objectStreamNumber). */
  offsets: Map<number, number>;
}

/** Parses one classic xref table at `at` (the "xref" keyword is there). */
function parseClassicXref(
  s: string,
  at: number
): { entries: Map<number, { offset: number; gen: number }>; end: number } | null {
  const entries = new Map<number, { offset: number; gen: number }>();
  let p = skipWs(s, at + 4); // past "xref"
  let guard = 0;
  for (;;) {
    p = skipWs(s, p);
    if (guard > 65536) return null;
    const head = /^([0-9]{1,9})[ \t]+([0-9]{1,9})(?![0-9])/.exec(s.slice(p, p + 32));
    if (head === null) break; // trailer keyword or junk follows
    const first = Number.parseInt(head[1], 10);
    const count = Number.parseInt(head[2], 10);
    if (!Number.isFinite(first) || !Number.isFinite(count) || count < 0 || count > 500_000) {
      return null;
    }
    p += head[0].length;
    for (let k = 0; k < count; k += 1) {
      p = skipWs(s, p);
      const entry = /^([0-9]{1,10})[ \t]+([0-9]{1,5})[ \t]*([nf])(?![0-9a-zA-Z])/.exec(
        s.slice(p, p + 28)
      );
      if (entry === null) return null;
      if (entry[3] === "n") {
        entries.set(first + k, {
          offset: Number.parseInt(entry[1], 10),
          gen: Number.parseInt(entry[2], 10),
        });
      }
      p += entry[0].length;
    }
    guard += 1;
  }
  return { entries, end: p };
}

/** Reads the trailer dict that follows a classic xref table (or null). */
function trailerAfter(s: string, at: number): { v: PdfVal; end: number } | null {
  const p = skipWs(s, at);
  if (!s.startsWith("trailer", p)) return null;
  return parsePdfValue(s, p + 7);
}

/** Parses an xref STREAM object (PDF 1.5+) at `at` ("N G obj" is there). */
function parseXrefStream(
  s: string,
  at: number
): {
  entries: Map<number, { offset: number; gen: number }>;
  rootRef: { num: number; gen: number } | null;
  infoVal: PdfVal | null;
  encrypted: boolean;
  prev: number | null;
  end: number;
} | null {
  const obj = parseObjectAt(s, at);
  if (obj === null || obj.value === null || obj.value.k !== "dict") return null;
  const d = obj.value.map;
  const typeVal = d.get("Type");
  if (typeVal === undefined || typeVal.k !== "name" || typeVal.name !== "XRef") return null;
  if (obj.streamStart < 0 || obj.streamEnd < obj.streamStart) return null;
  const wVal = d.get("W");
  if (wVal === undefined || wVal.k !== "arr" || wVal.items.length < 3) return null;
  const w = wVal.items.map((it) => (it.k === "num" ? it.num : -1));
  if (w.some((x) => !Number.isInteger(x) || x < 0 || x > 8) || w[0] + w[1] + w[2] === 0) {
    return null;
  }
  const sizeVal = d.get("Size");
  const size = sizeVal !== undefined && sizeVal.k === "num" ? sizeVal.num : -1;
  let index: number[] = [0, size > 0 ? size : 0];
  const indexVal = d.get("Index");
  if (indexVal !== undefined && indexVal.k === "arr" && indexVal.items.length >= 2) {
    const parsed = indexVal.items.map((it) => (it.k === "num" ? it.num : -1));
    if (parsed.length % 2 === 0 && parsed.every((x) => Number.isInteger(x) && x >= 0)) {
      index = parsed;
    }
  }
  let raw = latin1BytesOf(s, obj.streamStart, obj.streamEnd);
  const filterVal = d.get("Filter");
  const isFlate =
    (filterVal !== undefined && filterVal.k === "name" && filterVal.name === "FlateDecode") ||
    (filterVal !== undefined &&
      filterVal.k === "arr" &&
      filterVal.items.some((it) => it.k === "name" && it.name === "FlateDecode"));
  if (isFlate) {
    try {
      raw = decompressSync(raw);
    } catch {
      return null;
    }
  }
  const entries = new Map<number, { offset: number; gen: number }>();
  const rowLen = w[0] + w[1] + w[2];
  let pos = 0;
  for (let pair = 0; pair + 1 < index.length; pair += 2) {
    const first = index[pair];
    const count = index[pair + 1];
    for (let k = 0; k < count; k += 1) {
      if (pos + rowLen > raw.length) break;
      let type = 1;
      if (w[0] > 0) {
        type = 0;
        for (let b = 0; b < w[0]; b += 1) type = type * 256 + raw[pos + b];
      }
      let f2 = 0;
      for (let b = 0; b < w[1]; b += 1) f2 = f2 * 256 + raw[pos + w[0] + b];
      let f3 = 0;
      for (let b = 0; b < w[2]; b += 1) f3 = f3 * 256 + raw[pos + w[0] + w[1] + b];
      if (type === 1) {
        entries.set(first + k, { offset: f2, gen: f3 });
      } else if (type === 2) {
        // Compressed object inside an object stream — encoded as
        // -1-objectStreamNumber, with gen holding the in-stream index.
        entries.set(first + k, { offset: -1 - f2, gen: f3 });
      }
      pos += rowLen;
    }
  }
  let rootRef: { num: number; gen: number } | null = null;
  const rootVal = d.get("Root");
  if (rootVal !== undefined && rootVal.k === "ref") {
    rootRef = { num: rootVal.num, gen: rootVal.gen };
  }
  let prev: number | null = null;
  const prevVal = d.get("Prev");
  if (prevVal !== undefined && prevVal.k === "num" && prevVal.num > 0) prev = prevVal.num;
  return {
    entries,
    rootRef,
    infoVal: d.get("Info") ?? null,
    encrypted: d.has("Encrypt"),
    prev,
    end: obj.streamEnd,
  };
}

/** Walks the xref chain from the last startxref (newest revision first). */
function walkXref(s: string): XrefWalk {
  const xref: XrefWalk = {
    kind: "none",
    ok: false,
    reason: null,
    rootRef: null,
    infoVal: null,
    encrypted: false,
    offsets: new Map<number, number>(),
  };
  const offsets = xref.offsets;
  const sxIdx = s.lastIndexOf("startxref");
  if (sxIdx < 0) {
    xref.reason = "no startxref marker";
    return xref;
  }
  // Producers put whitespace (a newline) between the keyword and the
  // offset — pdf-lib, Acrobat, everyone (the RB6-FIN-c3 lesson).
  const digitsAt = skipWs(s, sxIdx + 9);
  const numMatch = /^[0-9]{1,10}/.exec(s.slice(digitsAt, digitsAt + 10));
  if (numMatch === null) {
    xref.reason = "startxref has no offset";
    return xref;
  }
  let at = Number.parseInt(numMatch[0], 10);
  if (at <= 0 || at >= s.length) {
    xref.reason = `startxref offset ${at} out of bounds`;
    return xref;
  }
  const seen = new Set<number>();
  let chain = 0;
  for (;;) {
    if (seen.has(at)) {
      if (xref.reason === null) xref.reason = "cyclic xref /Prev chain";
      break;
    }
    if (chain >= MAX_XREF_CHAIN) {
      if (xref.reason === null) xref.reason = `xref /Prev chain longer than ${MAX_XREF_CHAIN}`;
      break;
    }
    seen.add(at);
    const p = skipWs(s, at);
    if (s.startsWith("xref", p)) {
      const table = parseClassicXref(s, p);
      if (table === null) {
        if (xref.reason === null) xref.reason = `xref table at ${at} unparseable`;
        break;
      }
      xref.kind = "table";
      for (const [num, entry] of table.entries) {
        if (!offsets.has(num)) offsets.set(num, entry.offset);
      }
      const trailer = trailerAfter(s, table.end);
      if (trailer === null || trailer.v.k !== "dict") {
        if (xref.reason === null) xref.reason = `trailer missing after xref at ${at}`;
        break;
      }
      if (xref.rootRef === null) {
        const root = trailer.v.map.get("Root");
        if (root !== undefined && root.k === "ref") xref.rootRef = { num: root.num, gen: root.gen };
      }
      if (xref.infoVal === null) xref.infoVal = trailer.v.map.get("Info") ?? null;
      if (trailer.v.map.has("Encrypt")) xref.encrypted = true;
      const prev = trailer.v.map.get("Prev");
      const nextAt = prev !== undefined && prev.k === "num" && prev.num > 0 ? prev.num : null;
      chain += 1;
      if (nextAt === null || nextAt >= s.length) break;
      at = nextAt;
      continue;
    }
    const stream = parseXrefStream(s, p);
    if (stream !== null) {
      xref.kind = "stream";
      for (const [num, entry] of stream.entries) {
        if (!offsets.has(num)) offsets.set(num, entry.offset);
      }
      if (xref.rootRef === null) xref.rootRef = stream.rootRef;
      if (xref.infoVal === null) xref.infoVal = stream.infoVal;
      if (stream.encrypted) xref.encrypted = true;
      chain += 1;
      if (stream.prev === null || stream.prev >= s.length) break;
      at = stream.prev;
      continue;
    }
    if (xref.reason === null) xref.reason = `offset ${at} is neither xref table nor xref stream`;
    break;
  }
  if (xref.reason === null && offsets.size === 0) {
    xref.reason = "xref chain resolved no entries";
  }
  // Health check: sampled in-use offsets must hit real object headers.
  if (xref.reason === null && offsets.size > 0) {
    const nums = [...offsets.entries()].filter(([, off]) => off >= 0).sort((a, b) => a[0] - b[0]);
    const samples: Array<[number, number]> = [];
    if (nums.length > 0) samples.push(nums[0]);
    if (nums.length > 2) samples.push(nums[Math.floor(nums.length / 2)]);
    if (nums.length > 1) samples.push(nums[nums.length - 1]);
    for (const [num, off] of samples) {
      const head = /^([0-9]{1,9})[ \t\r\n\f\0]+([0-9]{1,3})[ \t\r\n\f\0]+obj/.exec(
        s.slice(off, off + 40)
      );
      if (head === null || Number.parseInt(head[1], 10) !== num) {
        xref.reason = `xref entry ${num} points at a non-object`;
        break;
      }
    }
  }
  if (xref.reason === null) {
    xref.ok = offsets.size > 0 && xref.rootRef !== null;
    if (!xref.ok) {
      xref.reason = xref.rootRef === null ? "trailer has no /Root" : "xref empty";
    }
  }
  return xref;
}

/* ================================================================== */
/* PART 3 — the whole walk (linear scan recovery + object streams)      */
/* ================================================================== */

export interface PdfWalk {
  s: string;
  bytes: Uint8Array;
  headerOffset: number;
  /** Object table (linear scan, LAST valid occurrence wins — incremental semantics). */
  objects: Map<number, PdfObject>;
  xref: XrefWalk;
  recoveryUsed: boolean;
  rootRef: { num: number; gen: number } | null;
  catalog: PdfDictVal | null;
}

const OBJ_HEADER_RE = /([0-9]{1,9})[ \t\r\n\f\0]+([0-9]{1,3})[ \t\r\n\f\0]+obj(?=[ \t\r\n\f\0<\[(])/g;

/**
 * walkPdf — the raw walk: header, startxref → xref chain (classic tables
 * with /Prev chaining + xref streams, FlateDecode via fflate), a linear
 * "N G obj" scan (the repair-pdf recovery precedent) whose last-wins
 * object table is the analysis source of truth, and object-stream
 * expansion for the xref's type-2 (compressed) entries. `recoveryUsed`
 * is honestly reported whenever the xref chain was unusable.
 */
export function walkPdf(s: string, bytes: Uint8Array): PdfWalk {
  const headerOffset = s.indexOf("%PDF-");
  const xref = walkXref(s);

  /* Linear object scan — last VALID occurrence wins. */
  const objects = new Map<number, PdfObject>();
  OBJ_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let scanned = 0;
  while ((m = OBJ_HEADER_RE.exec(s)) !== null) {
    if (scanned >= MAX_OBJECTS) break;
    const prevChar = m.index > 0 ? s[m.index - 1] : "";
    if (prevChar >= "0" && prevChar <= "9") continue;
    const obj = parseObjectAt(s, m.index);
    if (obj !== null) {
      objects.set(obj.num, obj);
      scanned += 1;
    }
  }

  /* Fallback: xref-only files (scan found nothing) — parse from offsets. */
  if (objects.size === 0 && xref.offsets.size > 0) {
    for (const [num, off] of xref.offsets) {
      if (off < 0) continue;
      const obj = parseObjectAt(s, off);
      if (obj !== null && obj.num === num) objects.set(num, obj);
    }
  }

  /* Object-stream expansion — xref type-2 entries (offset < 0). */
  expandObjectStreams(s, objects, xref.offsets);

  /* Root: trailer /Root first, then the last trailer in the file,
   * then the last /Type /Catalog object the scan saw. */
  let rootRef = xref.rootRef;
  if (rootRef === null) {
    let tAt = s.lastIndexOf("trailer");
    for (let guard = 0; tAt >= 0 && guard < 8; guard += 1) {
      const parsed = parsePdfValue(s, tAt + 7);
      if (parsed !== null && parsed.v.k === "dict") {
        const root = parsed.v.map.get("Root");
        if (root !== undefined && root.k === "ref") {
          rootRef = { num: root.num, gen: root.gen };
          break;
        }
      }
      tAt = s.lastIndexOf("trailer", tAt - 1);
    }
  }
  if (rootRef === null) {
    let catalogNum = -1;
    for (const [num, obj] of objects) {
      const v = obj.value;
      if (
        v !== null &&
        v.k === "dict" &&
        v.map.get("Type")?.k === "name" &&
        (v.map.get("Type") as PdfNameVal).name === "Catalog"
      ) {
        catalogNum = num; // iteration order = insertion order = last wins
      }
    }
    if (catalogNum >= 0) rootRef = { num: catalogNum, gen: 0 };
  }

  let catalog: PdfDictVal | null = null;
  if (rootRef !== null) {
    const cat = objects.get(rootRef.num);
    if (cat !== undefined && cat.value !== null && cat.value.k === "dict") {
      catalog = cat.value;
    }
  }

  return {
    s,
    bytes,
    headerOffset,
    objects,
    xref,
    recoveryUsed: !xref.ok,
    rootRef,
    catalog,
  };
}

/** Expands xref type-2 (compressed) entries out of their /ObjStm containers. */
function expandObjectStreams(
  s: string,
  objects: Map<number, PdfObject>,
  offsets: Map<number, number>
): void {
  let expanded = 0;
  for (const [num, off] of offsets) {
    if (expanded >= MAX_OBJECTS) break;
    if (off >= 0 || objects.has(num)) continue;
    const stmNum = -(off + 1);
    const stm = objects.get(stmNum);
    if (stm === undefined || stm.value === null || stm.value.k !== "dict") continue;
    const d = stm.value.map;
    const typeVal = d.get("Type");
    if (typeVal === undefined || typeVal.k !== "name" || typeVal.name !== "ObjStm") continue;
    const nVal = d.get("N");
    const firstVal = d.get("First");
    if (
      nVal === undefined || nVal.k !== "num" || !Number.isInteger(nVal.num) ||
      nVal.num < 0 || nVal.num > 100_000 ||
      firstVal === undefined || firstVal.k !== "num" ||
      !Number.isInteger(firstVal.num) || firstVal.num < 0
    ) {
      continue;
    }
    if (stm.streamStart < 0 || stm.streamEnd < stm.streamStart) continue;
    let raw = latin1BytesOf(s, stm.streamStart, stm.streamEnd);
    const filterVal = d.get("Filter");
    const isFlate =
      (filterVal !== undefined && filterVal.k === "name" && filterVal.name === "FlateDecode") ||
      (filterVal !== undefined &&
        filterVal.k === "arr" &&
        filterVal.items.some((it) => it.k === "name" && it.name === "FlateDecode"));
    if (isFlate) {
      try {
        raw = decompressSync(raw);
      } catch {
        continue;
      }
    }
    if (raw.length > MAX_STREAM_BYTES) continue;
    const inner = toLatin(raw);
    const pairs: Array<{ num: number; at: number }> = [];
    let p = 0;
    let ok = true;
    for (let k = 0; k < nVal.num; k += 1) {
      // Producers separate the header pairs with whitespace (pdf-lib,
      // Acrobat — one space after each pair): skip it before EVERY pair,
      // not only before the first (the pair digits are the body start).
      const q = skipWs(inner, p);
      const pair = /^([0-9]{1,9})[ \t]+([0-9]{1,9})/.exec(inner.slice(q, q + 24));
      if (pair === null) {
        ok = false;
        break;
      }
      pairs.push({
        num: Number.parseInt(pair[1], 10),
        at: firstVal.num + Number.parseInt(pair[2], 10),
      });
      p = q + pair[0].length;
    }
    if (!ok) continue;
    for (const pair of pairs) {
      const parsed = parseInnerValueAt(inner, pair.at);
      if (parsed === null) continue;
      objects.set(pair.num, {
        num: pair.num,
        gen: 0,
        offset: -1,
        value: parsed.v,
        end: parsed.end,
        streamStart: -1,
        streamEnd: -1,
      });
      expanded += 1;
    }
  }
}

/* ---- resolvers ---------------------------------------------------- */

interface WalkResolvers {
  resolve(v: PdfVal | undefined): PdfVal | undefined;
  dict(v: PdfVal | undefined): PdfDictVal | undefined;
  arr(v: PdfVal | undefined): PdfArrVal | undefined;
  name(v: PdfVal | undefined): string | null;
  text(v: PdfVal | undefined): string | null;
  num(v: PdfVal | undefined): number | null;
  bool(v: PdfVal | undefined): boolean | null;
}

/** Resolves + casts helpers bound to a walk. */
function makeResolvers(walk: PdfWalk): WalkResolvers {
  const resolve = (v: PdfVal | undefined): PdfVal | undefined =>
    v === undefined
      ? undefined
      : v.k === "ref"
        ? (walk.objects.get(v.num)?.value ?? undefined)
        : v;
  return {
    resolve,
    dict: (v) => {
      const r = resolve(v);
      return r !== undefined && r.k === "dict" ? r : undefined;
    },
    arr: (v) => {
      const r = resolve(v);
      return r !== undefined && r.k === "arr" ? r : undefined;
    },
    name: (v) => {
      const r = resolve(v);
      return r !== undefined && r.k === "name" ? r.name : null;
    },
    text: (v) => {
      const r = resolve(v);
      if (r === undefined) return null;
      if (r.k === "str") return r.text;
      if (r.k === "name") return r.name;
      if (r.k === "num") return String(r.num);
      return null;
    },
    num: (v) => {
      const r = resolve(v);
      return r !== undefined && r.k === "num" ? r.num : null;
    },
    bool: (v) => {
      const r = resolve(v);
      return r !== undefined && r.k === "bool" ? r.v : null;
    },
  };
}

/* ---- pages -------------------------------------------------------- */

export interface PageEntry {
  /** 1-based display page index. */
  page: number;
  /** Object number of the page dict (-1 when direct). */
  num: number;
  dict: PdfDictVal;
}

/** Page dicts in reading order (empty when the tree was unreadable). */
function collectPageDicts(walk: PdfWalk): PageEntry[] {
  const { dict, arr } = makeResolvers(walk);
  const pages: PageEntry[] = [];
  if (walk.catalog === null) return pages;
  const pagesDict = dict(walk.catalog.map.get("Pages"));
  if (pagesDict === undefined) return pages;
  const walkTree = (node: PdfDictVal, depth: number): void => {
    if (depth > MAX_TREE_DEPTH || pages.length >= MAX_TREE_LEAVES) return;
    const kids = arr(node.map.get("Kids"));
    if (kids === undefined) return;
    for (const kid of kids.items) {
      if (pages.length >= MAX_TREE_LEAVES) break;
      const kidDict = dict(kid);
      if (kidDict === undefined) continue;
      const type = kidDict.map.get("Type");
      const typeName = type !== undefined && type.k === "name" ? type.name : null;
      if (typeName === "Pages") {
        walkTree(kidDict, depth + 1);
      } else if (typeName === "Page" || kidDict.map.has("MediaBox") || !kidDict.map.has("Kids")) {
        pages.push({
          page: pages.length + 1,
          num: kid.k === "ref" ? kid.num : -1,
          dict: kidDict,
        });
      }
    }
  };
  walkTree(pagesDict, 0);
  return pages;
}

/** A page's /Resources, inherited through the /Parent chain when absent. */
function pageResources(
  walk: PdfWalk,
  resolvers: WalkResolvers,
  pageDict: PdfDictVal
): PdfDictVal | undefined {
  let node: PdfDictVal | undefined = pageDict;
  for (let depth = 0; depth < 8 && node !== undefined; depth += 1) {
    const res = resolvers.dict(node.map.get("Resources"));
    if (res !== undefined) return res;
    const parentVal = node.map.get("Parent");
    if (parentVal === undefined) return undefined;
    const parent = resolvers.dict(parentVal);
    if (parent === undefined) return undefined;
    node = parent;
  }
  return undefined;
}

/* ---- stream decode ------------------------------------------------ */

/**
 * Decodes a stream object's data (FlateDecode only — anything else is
 * honestly reported as undecodable via null).
 */
function decodeStream(walk: PdfWalk, obj: PdfObject | undefined): Uint8Array | null {
  if (
    obj === undefined ||
    obj.streamStart < 0 ||
    obj.streamEnd < obj.streamStart ||
    obj.value === null ||
    obj.value.k !== "dict"
  ) {
    return null;
  }
  let raw = latin1BytesOf(walk.s, obj.streamStart, obj.streamEnd);
  if (raw.length > MAX_STREAM_BYTES) return null;
  const fVal = obj.value.map.get("Filter");
  let names: string[] = [];
  if (fVal !== undefined && fVal.k === "name") names = [fVal.name];
  else if (fVal !== undefined && fVal.k === "arr") {
    names = fVal.items.filter((it) => it.k === "name").map((it) => it.name);
  }
  for (const f of names) {
    if (f === "FlateDecode" || f === "Fl") {
      try {
        raw = decompressSync(raw);
      } catch {
        return null;
      }
    } else {
      return null; // honest: undecodable filter (DCTDecode, …)
    }
  }
  if (raw.length > MAX_STREAM_BYTES) return null;
  return raw;
}

/** Decodes a stream REFerence (a PdfVal that must resolve to a stream object). */
function decodeStreamRef(walk: PdfWalk, v: PdfVal | undefined): Uint8Array | null {
  if (v === undefined || v.k !== "ref") return null;
  return decodeStream(walk, walk.objects.get(v.num));
}

/* ================================================================== */
/* PART 4 — XMP metadata                                               */
/* ================================================================== */

/** Minimal XML entity decode for XMP text values. */
function xmlDecode(raw: string): string {
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/** First rdf:li text inside an element body ("" → null). */
function altLi(body: string): string | null {
  const li = /<rdf:li[^>]*>([^<]*)<\/rdf:li>/.exec(body);
  const v = li !== null ? xmlDecode(li[1] ?? "").trim() : xmlDecode(body).trim();
  return v.length > 0 ? v : null;
}

/**
 * parseXmp — namespace-tolerant scrape of the identification fields:
 * pdfaid:part + pdfaid:conformance (attribute OR element form) and the
 * dc/pdf fields the mirror check compares. Never throws.
 */
export function parseXmp(text: string): XmpInfo {
  const info: XmpInfo = {
    present: true,
    parseError: null,
    part: null,
    conformance: null,
    dcTitle: null,
    dcCreator: null,
    producer: null,
    keywords: null,
  };
  if (!/<\?xml|<x:xmpmeta|<rdf:RDF|<rdf:Description/.test(text)) {
    info.parseError = "no XMP/RDF structure recognized";
    return info;
  }
  const partAttr = /pdfaid:part\s*=\s*"([^"]*)"/.exec(text);
  const partEl = /<pdfaid:part>([^<]*)<\/pdfaid:part>/.exec(text);
  const partRaw = partAttr?.[1] ?? partEl?.[1] ?? null;
  if (partRaw !== null) {
    const n = Number.parseInt(partRaw.trim(), 10);
    if (Number.isFinite(n) && n >= 1 && n <= 9) info.part = n;
  }
  const confAttr = /pdfaid:conformance\s*=\s*"([^"]*)"/.exec(text);
  const confEl = /<pdfaid:conformance>([^<]*)<\/pdfaid:conformance>/.exec(text);
  const confRaw = (confAttr?.[1] ?? confEl?.[1] ?? "").trim();
  if (/^[A-Za-z]{1,2}$/.test(confRaw)) info.conformance = confRaw.toUpperCase();
  const title = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(text);
  if (title !== null) info.dcTitle = altLi(title[1] ?? "");
  const creator = /<dc:creator>([\s\S]*?)<\/dc:creator>/.exec(text);
  if (creator !== null) info.dcCreator = altLi(creator[1] ?? "");
  const producer = /<pdf:Producer>([\s\S]*?)<\/pdf:Producer>/.exec(text);
  if (producer !== null) info.producer = altLi(producer[1] ?? "");
  const keywords = /<pdf:Keywords>([\s\S]*?)<\/pdf:Keywords>/.exec(text);
  if (keywords !== null) info.keywords = altLi(keywords[1] ?? "");
  return info;
}

/** Reads + decodes the catalog /Metadata stream (absent → present:false). */
export function readXmp(walk: PdfWalk): XmpInfo {
  if (walk.catalog === null) {
    return {
      present: false,
      parseError: null,
      part: null,
      conformance: null,
      dcTitle: null,
      dcCreator: null,
      producer: null,
      keywords: null,
    };
  }
  const metaVal = walk.catalog.map.get("Metadata");
  if (metaVal === undefined) {
    return {
      present: false,
      parseError: null,
      part: null,
      conformance: null,
      dcTitle: null,
      dcCreator: null,
      producer: null,
      keywords: null,
    };
  }
  if (metaVal.k !== "ref") {
    return {
      present: false,
      parseError: "catalog /Metadata is not an indirect stream reference",
      part: null,
      conformance: null,
      dcTitle: null,
      dcCreator: null,
      producer: null,
      keywords: null,
    };
  }
  const decoded = decodeStreamRef(walk, metaVal);
  if (decoded === null) {
    return {
      present: false,
      parseError: "metadata stream unreadable (absent / corrupted / non-Flate filter)",
      part: null,
      conformance: null,
      dcTitle: null,
      dcCreator: null,
      producer: null,
      keywords: null,
    };
  }
  const info = parseXmp(toLatin(decoded));
  return info;
}

/* ================================================================== */
/* PART 5 — content stream scan (Tf fonts + k/K operators)              */
/* ================================================================== */

/** One content token (strings are collapsed — the text is NOT decoded). */
interface ContentToken {
  k: "name" | "num" | "word" | "str";
  v: string;
}

export interface StreamScan {
  /** Resource font names referenced by a `/Name <size> Tf` operator. */
  tfNames: Set<string>;
  /** A `k` or `K` (device CMYK) operator appeared. */
  cmykOps: boolean;
}

/**
 * scanContentStream — the string-aware content tokenizer. Literal/hex
 * strings are skipped without decoding (glyph-ID bytes are meaningless
 * as text — the house lesson), inline images (BI … EI) are skipped
 * whole, and `/Name <num> Tf` + `k`/`K` operators are collected.
 */
export function scanContentStream(text: string, budget: { left: number }): StreamScan {
  const scan: StreamScan = { tfNames: new Set<string>(), cmykOps: false };
  const tokens: ContentToken[] = [];
  const n = text.length;
  let i = 0;
  while (i < n && tokens.length < MAX_TOKENS) {
    const c = text[i];
    if (WS.indexOf(c) >= 0) {
      i += 1;
      continue;
    }
    if (c === "%") {
      i += 1;
      while (i < n && text[i] !== "\n" && text[i] !== "\r") i += 1;
      continue;
    }
    if (c === "(") {
      let p = i + 1;
      let depthP = 1;
      while (p < n && depthP > 0) {
        const ch = text[p];
        if (ch === "\\") {
          p += 2;
          continue;
        }
        if (ch === "(") depthP += 1;
        else if (ch === ")") depthP -= 1;
        p += 1;
      }
      tokens.push({ k: "str", v: "" });
      i = p;
      continue;
    }
    if (c === "<" && text[i + 1] === "<") {
      i += 2; // dict delimiters inside content — skip
      continue;
    }
    if (c === "<") {
      const close = text.indexOf(">", i + 1);
      tokens.push({ k: "str", v: "" });
      i = close < 0 ? n : close + 1;
      continue;
    }
    if (c === ">" ) {
      i += 1;
      continue;
    }
    if (c === "/") {
      let p = i + 1;
      let name = "";
      while (p < n && isPdfDelimiter(text[p]) === false) {
        name += text[p];
        p += 1;
      }
      tokens.push({ k: "name", v: name });
      i = p;
      continue;
    }
    if (c === "[" || c === "]" || c === "{" || c === "}") {
      tokens.push({ k: "word", v: c });
      i += 1;
      continue;
    }
    // word / number token
    let p = i;
    while (p < n && isPdfDelimiter(text[p]) === false) p += 1;
    const word = text.slice(i, p);
    if (/^[-+]?[0-9]*\.?[0-9]+$/.test(word)) {
      tokens.push({ k: "num", v: word });
    } else {
      tokens.push({ k: "word", v: word });
      // Inline image: skip its binary body whole (it can contain ANY bytes,
      // including sequences that look like operators).
      if (word === "BI") {
        const ei = /[^A-Za-z0-9]EI[^A-Za-z0-9]|[^A-Za-z0-9]EI$|^EI/.exec(text.slice(p));
        if (ei !== null) {
          i = p + (ei.index ?? 0) + (ei[0]?.length ?? 0);
          continue;
        }
        i = n;
        continue;
      }
    }
    i = p;
  }
  // NOTE: the guard is t < tokens.length (NOT t + 2): the k/K operator
  // check must see the LAST tokens too — a stream may legitimately end
  // with a colour operator (its /Contents sibling continues the state).
  for (let t = 0; t < tokens.length; t += 1) {
    const tk = tokens[t];
    if (tk === undefined) continue;
    if (tk.k === "word" && (tk.v === "k" || tk.v === "K")) {
      scan.cmykOps = true;
      continue;
    }
    if (tk.k === "name") {
      const t1 = tokens[t + 1];
      const t2 = tokens[t + 2];
      if (t1 !== undefined && t2 !== undefined && t1.k === "num" && t2.k === "word" && t2.v === "Tf") {
        scan.tfNames.add(tk.v);
      }
    }
  }
  budget.left -= n;
  return scan;
}

/* ================================================================== */
/* PART 6 — per-page collection (fonts + color + transparency)          */
/* ================================================================== */

const STANDARD_14 = new Set([
  "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
  "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
  "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
  "Symbol", "ZapfDingbats",
]);

/** True when the font dict (or its descendant) carries a FontFile key. */
function fontIsEmbedded(resolvers: WalkResolvers, fontDict: PdfDictVal): boolean {
  const subtypeVal = fontDict.map.get("Subtype");
  const subtype = subtypeVal !== undefined && subtypeVal.k === "name" ? subtypeVal.name : null;
  let descriptor: PdfDictVal | undefined;
  if (subtype === "Type0") {
    const kids = resolvers.arr(fontDict.map.get("DescendantFonts"));
    const firstKid = kids !== undefined ? resolvers.dict(kids.items[0]) : undefined;
    descriptor = firstKid !== undefined ? resolvers.dict(firstKid.map.get("FontDescriptor")) : undefined;
    if (descriptor === undefined) {
      descriptor = resolvers.dict(fontDict.map.get("FontDescriptor"));
    }
  } else {
    descriptor = resolvers.dict(fontDict.map.get("FontDescriptor"));
  }
  if (descriptor === undefined) return false;
  return (
    descriptor.map.has("FontFile") ||
    descriptor.map.has("FontFile2") ||
    descriptor.map.has("FontFile3")
  );
}

/** True when the colorspace value mentions /DeviceCMYK. */
function isDeviceCmyk(resolvers: WalkResolvers, v: PdfVal | undefined): boolean {
  const r = resolvers.resolve(v);
  if (r === undefined) return false;
  if (r.k === "name") return r.name === "DeviceCMYK" || r.name === "CMYK";
  if (r.k === "arr") {
    return r.items.some((it) => it.k === "name" && (it.name === "DeviceCMYK" || it.name === "CMYK"));
  }
  return false;
}

interface PageColorFindings {
  cmykOpPages: number[];
  cmykResPages: number[];
  transparencyPages: number[];
  psfuncPages: number[];
}

/**
 * Walks a function value (dict / array / ref) hunting /FunctionType 4.
 * Depth-capped: function dictionaries can reference each other (or
 * themselves) cyclically — a crafted file must not exhaust the stack.
 */
function hasPostScriptFunction(
  resolvers: WalkResolvers,
  v: PdfVal | undefined,
  depth = 0
): boolean {
  if (depth > 16) return false;
  const r = resolvers.resolve(v);
  if (r === undefined) return false;
  if (r.k === "dict") {
    const ft = r.map.get("FunctionType");
    if (ft !== undefined && ft.k === "num" && ft.num === 4) return true;
    for (const child of r.map.values()) {
      if (child.k === "ref" || child.k === "dict" || child.k === "arr") {
        if (hasPostScriptFunction(resolvers, child, depth + 1)) return true;
      }
    }
    return false;
  }
  if (r.k === "arr") {
    return r.items.some((it) => hasPostScriptFunction(resolvers, it, depth + 1));
  }
  return false;
}

/** Collects fonts used per page + color/transparency findings (forms included). */
function collectPageUsage(
  walk: PdfWalk,
  resolvers: WalkResolvers,
  entry: PageEntry,
  fonts: Map<string, FontUse>,
  findings: PageColorFindings,
  contentBudget: { left: number },
  formDepth: number,
  /** For Form XObjects: the content IS the form object's own stream. */
  directContent: PdfVal | undefined
): void {
  const resources = pageResources(walk, resolvers, entry.dict);
  const scan: StreamScan = { tfNames: new Set<string>(), cmykOps: false };

  /* content: the page /Contents (ref or array of refs), or the form's
   * own stream when recursing into an XObject. */
  let contents: Array<PdfVal | undefined>;
  if (directContent !== undefined) {
    contents = [directContent];
  } else {
    const contentsVal = entry.dict.map.get("Contents");
    contents =
      contentsVal !== undefined && contentsVal.k === "arr" ? contentsVal.items : [contentsVal];
  }
  for (const cv of contents) {
    if (cv === undefined) continue;
    if (contentBudget.left <= 0) break;
    const decoded = decodeStreamRef(walk, cv);
    if (decoded === null) continue;
    const res = scanContentStream(toLatin(decoded), contentBudget);
    scan.tfNames = new Set([...scan.tfNames, ...res.tfNames]);
    scan.cmykOps = scan.cmykOps || res.cmykOps;
  }

  /* resources: fonts actually used, XObjects, ColorSpace, ExtGState, Pattern */
  if (resources !== undefined) {
    const fontRes = resolvers.dict(resources.map.get("Font"));
    if (fontRes !== undefined) {
      for (const [resName, fontVal] of fontRes.map) {
        if (!scan.tfNames.has(resName)) continue; // honest: only fonts USED
        const fontDict = resolvers.dict(fontVal);
        if (fontDict === undefined) continue;
        const baseVal = fontDict.map.get("BaseFont");
        const name =
          baseVal !== undefined && baseVal.k === "name"
            ? baseVal.name
            : baseVal !== undefined && baseVal.k === "str"
              ? baseVal.text
              : "(unnamed)";
        const subtypeVal = fontDict.map.get("Subtype");
        const subtype =
          subtypeVal !== undefined && subtypeVal.k === "name" ? subtypeVal.name : "(unknown)";
        const key = `${name}#${subtype}`;
        const embedded = fontIsEmbedded(resolvers, fontDict);
        let use = fonts.get(key);
        if (use === undefined) {
          if (fonts.size >= MAX_FONTS) continue;
          use = {
            name,
            subtype,
            embedded,
            standard14: STANDARD_14.has(name),
            pages: [],
          };
          fonts.set(key, use);
        } else {
          use.embedded = use.embedded && embedded;
        }
        if (!use.pages.includes(entry.page)) use.pages.push(entry.page);
      }
    }

    /* ColorSpace resource dict — DeviceCMYK mentions */
    const csRes = resolvers.dict(resources.map.get("ColorSpace"));
    if (csRes !== undefined) {
      let hit = false;
      for (const [key, val] of csRes.map) {
        if (key === "DefaultCMYK") hit = true;
        if (isDeviceCmyk(resolvers, val)) hit = true;
      }
      if (hit) findings.cmykResPages.push(entry.page);
    }

    /* ExtGState — soft masks + partial opacity */
    const gsRes = resolvers.dict(resources.map.get("ExtGState"));
    if (gsRes !== undefined) {
      let hit = false;
      for (const val of gsRes.map.values()) {
        const gs = resolvers.dict(val);
        if (gs === undefined) continue;
        const smask = gs.map.get("SMask");
        if (smask !== undefined) {
          const sm = resolvers.resolve(smask);
          if (!(sm !== undefined && sm.k === "name" && sm.name === "None")) hit = true;
        }
        const ca = gs.map.get("ca");
        const CA = gs.map.get("CA");
        if (ca !== undefined && ca.k === "num" && ca.num < 1) hit = true;
        if (CA !== undefined && CA.k === "num" && CA.num < 1) hit = true;
      }
      if (hit) findings.transparencyPages.push(entry.page);
    }

    /* Pattern + Shading — PostScript calculator functions */
    let psHit = false;
    const patRes = resolvers.dict(resources.map.get("Pattern"));
    if (patRes !== undefined) {
      for (const val of patRes.map.values()) {
        const pattern = resolvers.dict(val);
        if (pattern === undefined) continue;
        const shading = resolvers.dict(pattern.map.get("Shading"));
        if (shading !== undefined && hasPostScriptFunction(resolvers, shading.map.get("Function"))) {
          psHit = true;
        }
        if (hasPostScriptFunction(resolvers, pattern.map.get("Function"))) psHit = true;
      }
    }
    const shRes = resolvers.dict(resources.map.get("Shading"));
    if (shRes !== undefined) {
      for (const val of shRes.map.values()) {
        const shading = resolvers.dict(val);
        if (shading !== undefined && hasPostScriptFunction(resolvers, shading.map.get("Function"))) {
          psHit = true;
        }
      }
    }
    if (psHit) findings.psfuncPages.push(entry.page);

    /* XObjects — images (CMYK + SMask), forms (recursion) */
    const xoRes = resolvers.dict(resources.map.get("XObject"));
    if (xoRes !== undefined) {
      for (const val of xoRes.map.values()) {
        const xo = resolvers.dict(val);
        if (xo === undefined) continue;
        const subVal = xo.map.get("Subtype");
        const sub = subVal !== undefined && subVal.k === "name" ? subVal.name : null;
        if (sub === "Image") {
          if (isDeviceCmyk(resolvers, xo.map.get("ColorSpace")) || xo.map.has("DefaultCMYK")) {
            findings.cmykResPages.push(entry.page);
          }
          const smask = xo.map.get("SMask");
          if (smask !== undefined) {
            const sm = resolvers.resolve(smask);
            if (!(sm !== undefined && sm.k === "name" && sm.name === "None")) {
              findings.transparencyPages.push(entry.page);
            }
          }
        } else if (sub === "Form" && formDepth < MAX_FORM_DEPTH) {
          const group = resolvers.dict(xo.map.get("Group"));
          if (group !== undefined) {
            const s = resolvers.name(group.map.get("S"));
            if (s === "Transparency") findings.transparencyPages.push(entry.page);
          }
          // Recurse with the form's OWN resources + its own stream content.
          collectPageUsage(
            walk,
            resolvers,
            { page: entry.page, num: -1, dict: xo },
            fonts,
            findings,
            contentBudget,
            formDepth + 1,
            val
          );
        }
      }
    }
  }

  if (scan.cmykOps) findings.cmykOpPages.push(entry.page);

  /* the page itself may carry a transparency group */
  const group = resolvers.dict(entry.dict.map.get("Group"));
  if (group !== undefined) {
    const s = resolvers.name(group.map.get("S"));
    if (s === "Transparency") findings.transparencyPages.push(entry.page);
  }
}

/* ================================================================== */
/* PART 7 — forbidden content                                         */
/* ================================================================== */

interface ForbiddenFindings {
  encrypt: boolean;
  jsNames: boolean;
  jsPages: number[];
  launchPages: number[];
  openActionDict: boolean;
  openActionDest: boolean;
  embeddedFiles: boolean;
  multimediaPages: number[];
  multimediaSubtypes: Set<string>;
}

/**
 * Judges one action dict (/A, /AA entries, /OpenAction) for JS + Launch.
 * Depth-capped: a /Next chain can be cyclic in crafted files.
 */
function scanActionDict(
  resolvers: WalkResolvers,
  action: PdfDictVal,
  page: number | null,
  out: { js: boolean; launch: boolean },
  depth = 0
): void {
  if (depth > 16) return;
  const s = resolvers.name(action.map.get("S"));
  if (s === "JavaScript") out.js = true;
  if (s === "Launch") out.launch = true;
  if (action.map.has("JS")) out.js = true;
  // /Next can chain more actions.
  const next = resolvers.arr(action.map.get("Next"));
  if (next !== undefined) {
    for (const nv of next.items) {
      const na = resolvers.dict(nv);
      if (na !== undefined) scanActionDict(resolvers, na, page, out, depth + 1);
    }
  }
}

function collectForbidden(
  walk: PdfWalk,
  resolvers: WalkResolvers,
  pages: PageEntry[]
): ForbiddenFindings {
  const out: ForbiddenFindings = {
    encrypt: walk.xref.encrypted,
    jsNames: false,
    jsPages: [],
    launchPages: [],
    openActionDict: false,
    openActionDest: false,
    embeddedFiles: false,
    multimediaPages: [],
    multimediaSubtypes: new Set<string>(),
  };
  const catalog = walk.catalog;
  if (catalog === null) return out;
  if (catalog.map.has("Encrypt")) out.encrypt = true;

  /* catalog /Names — JavaScript tree + EmbeddedFiles tree */
  const names = resolvers.dict(catalog.map.get("Names"));
  if (names !== undefined) {
    if (names.map.has("JavaScript")) out.jsNames = true;
    if (names.map.has("EmbeddedFiles")) out.embeddedFiles = true;
  }
  if (catalog.map.has("AF")) out.embeddedFiles = true;

  /* catalog /OpenAction — destination form required */
  const oa = resolvers.resolve(catalog.map.get("OpenAction"));
  if (oa !== undefined) {
    if (oa.k === "dict") {
      out.openActionDict = true;
      const judge = { js: false, launch: false };
      scanActionDict(resolvers, oa, null, judge);
      if (judge.js) out.jsPages.push(0);
      if (judge.launch) out.launchPages.push(0);
    } else {
      out.openActionDest = true;
    }
  }

  /* per-page annotations: actions + multimedia subtypes */
  for (const entry of pages) {
    const annots = resolvers.arr(entry.dict.map.get("Annots"));
    if (annots === undefined) continue;
    let count = 0;
    for (const av of annots.items) {
      if (count >= MAX_ANNOTS) break;
      const annot = resolvers.dict(av);
      if (annot === undefined) continue;
      count += 1;
      const sub = resolvers.name(annot.map.get("Subtype"));
      if (sub === "Screen" || sub === "Movie" || sub === "Sound" || sub === "RichMedia" || sub === "3D") {
        out.multimediaPages.push(entry.page);
        out.multimediaSubtypes.add(sub ?? "?");
        continue;
      }
      const judge = { js: false, launch: false };
      const a = resolvers.dict(annot.map.get("A"));
      if (a !== undefined) scanActionDict(resolvers, a, entry.page, judge);
      const aa = resolvers.dict(annot.map.get("AA"));
      if (aa !== undefined) {
        for (const av2 of aa.map.values()) {
          const inner = resolvers.dict(av2);
          if (inner !== undefined) scanActionDict(resolvers, inner, entry.page, judge);
        }
      }
      if (judge.js) out.jsPages.push(entry.page);
      if (judge.launch) out.launchPages.push(entry.page);
    }
    /* page-level additional actions */
    const aa = resolvers.dict(entry.dict.map.get("AA"));
    if (aa !== undefined) {
      const judge = { js: false, launch: false };
      for (const av2 of aa.map.values()) {
        const inner = resolvers.dict(av2);
        if (inner !== undefined) scanActionDict(resolvers, inner, entry.page, judge);
      }
      if (judge.js) out.jsPages.push(entry.page);
      if (judge.launch) out.launchPages.push(entry.page);
    }
  }
  return out;
}

/* ================================================================== */
/* PART 8 — structure tree scan (light)                                */
/* ================================================================== */

/** Counts /Alt-bearing nodes in the structure tree (bounded walk). */
export function countStructAlt(walk: PdfWalk, resolvers: WalkResolvers): number {
  const root = resolvers.dict(walk.catalog?.map.get("StructTreeRoot"));
  if (root === undefined) return -1;
  let alt = 0;
  let visited = 0;
  const visit = (d: PdfDictVal, depth: number): void => {
    if (depth > 10 || visited >= MAX_STRUCT_NODES) return;
    visited += 1;
    if (d.map.has("Alt")) alt += 1;
    const kids = resolvers.arr(d.map.get("K"));
    if (kids === undefined) return;
    for (const kv of kids.items) {
      const kd = resolvers.dict(kv);
      if (kd !== undefined) visit(kd, depth + 1);
    }
  };
  visit(root, 0);
  return alt;
}

/* ================================================================== */
/* PART 9 — level resolution                                           */
/* ================================================================== */

export interface LevelResolution {
  effectiveLevel: PdfaLevel;
  detectedLevel: PdfaLevel | null;
  xmpClaim: string | null;
  conformanceA: boolean;
  autoDetected: boolean;
}

/** Normalizes a declared level string ("auto"/"1b"/"2b"/"3b", case-insensitive). */
export function normalizeDeclaredLevel(raw: string): DeclaredLevel {
  const t = raw.trim().toLowerCase();
  if (t === "1b" || t === "2b" || t === "3b") return t;
  return "auto";
}

/**
 * resolveLevel — the honesty core: "auto" takes the XMP pdfaid:part
 * (falling back to 2b with an explicit assumption note via
 * detectedLevel === null); an explicit declaration wins for the checks,
 * with the XMP mismatch surfaced by the xmp check.
 */
export function resolveLevel(declared: DeclaredLevel, xmp: XmpInfo): LevelResolution {
  const part = xmp.part;
  const detectedLevel: PdfaLevel | null =
    part !== null && (part === 1 || part === 2 || part === 3) ? (`${part}b` as PdfaLevel) : null;
  const xmpClaim =
    part !== null ? `${part}${xmp.conformance ?? ""}` : null;
  const conformanceA = xmp.conformance === "A";
  const effectiveLevel: PdfaLevel =
    declared !== "auto" ? declared : (detectedLevel ?? "2b");
  return {
    effectiveLevel,
    detectedLevel,
    xmpClaim,
    conformanceA,
    autoDetected: declared === "auto" && detectedLevel !== null,
  };
}

/* ================================================================== */
/* PART 10 — the checks + the report                                   */
/* ================================================================== */

function dedupeSorted(nums: number[]): number[] {
  return [...new Set(nums)].sort((a, b) => a - b);
}

function pagesLabel(nums: number[]): string {
  const p = dedupeSorted(nums);
  if (p.length === 0) return "";
  if (p.length > 12) return `${p.slice(0, 12).join(", ")} +${p.length - 12}`;
  return p.join(", ");
}

/**
 * analyzePdfa — the whole validation: walk, collect, judge. Throws
 * PdfaError for the fatal gates (not a PDF / too big / nothing
 * walkable); everything else lands in the checks, honestly.
 */
export function analyzePdfa(bytes: Uint8Array, declared: DeclaredLevel): PdfaReport {
  if (bytes.length > MAX_INPUT_BYTES) {
    throw new PdfaError("errTooBig", `${bytes.length} bytes`);
  }
  if (!sniffPdfBytes(bytes)) {
    throw new PdfaError("errNotPdf", "no %PDF- magic");
  }
  const s = toLatin(bytes);
  const walk = walkPdf(s, bytes);
  if (walk.catalog === null) {
    throw new PdfaError("errCorrupt", "no catalog object found in the scan");
  }
  const resolvers = makeResolvers(walk);
  const pages = collectPageDicts(walk);
  const xmp = readXmp(walk);
  const level = resolveLevel(declared, xmp);
  const checks: PdfaCheck[] = [];
  const fonts = new Map<string, FontUse>();
  const findings: PageColorFindings = {
    cmykOpPages: [],
    cmykResPages: [],
    transparencyPages: [],
    psfuncPages: [],
  };
  const contentBudget = { left: MAX_TOTAL_CONTENT_BYTES };
  for (const entry of pages) {
    collectPageUsage(walk, resolvers, entry, fonts, findings, contentBudget, 0, undefined);
  }
  const forbidden = collectForbidden(walk, resolvers, pages);
  const fontList = [...fonts.values()];

  /* ---- 1. XMP identification ---------------------------------- */
  const declaredNum = Number.parseInt(level.effectiveLevel, 10); // 1/2/3
  const declaredLetter = level.effectiveLevel.endsWith("b") ? "B" : "?";
  if (!xmp.present) {
    checks.push({
      id: "xmp",
      group: "identify",
      label: "vpa.kXmp",
      status: "fail",
      pages: [],
      note: "vpa.nXmpNone",
      detail: xmp.parseError ?? undefined,
    });
  } else if (xmp.part === null) {
    checks.push({
      id: "xmp",
      group: "identify",
      label: "vpa.kXmp",
      status: "fail",
      pages: [],
      note: "vpa.nXmpNoPart",
      detail: xmp.parseError ?? undefined,
    });
  } else if (declared !== "auto" && xmp.part !== declaredNum) {
    checks.push({
      id: "xmp",
      group: "identify",
      label: "vpa.kXmp",
      status: "fail",
      pages: [],
      note: "vpa.nXmpMismatch",
      detail: `pdfaid:part=${xmp.part} (conformance ${xmp.conformance ?? "?"}) — target ${level.effectiveLevel}`,
    });
  } else if (
    declared !== "auto" &&
    xmp.conformance !== null &&
    xmp.conformance !== declaredLetter
  ) {
    checks.push({
      id: "xmp",
      group: "identify",
      label: "vpa.kXmp",
      status: "warn",
      pages: [],
      note: "vpa.nXmpConfMismatch",
      detail: `XMP conformance ${xmp.conformance} vs target ${level.effectiveLevel}`,
    });
  } else {
    checks.push({
      id: "xmp",
      group: "identify",
      label: "vpa.kXmp",
      status: "pass",
      pages: [],
      note: "vpa.nXmpOk",
      detail: level.xmpClaim ?? undefined,
    });
  }

  /* ---- 2. dc:title ------------------------------------------- */
  if (!xmp.present) {
    checks.push({
      id: "title",
      group: "identify",
      label: "vpa.kTitle",
      status: "skip",
      pages: [],
      note: "vpa.nTitleSkip",
    });
  } else if (xmp.dcTitle !== null && xmp.dcTitle.length > 0) {
    checks.push({
      id: "title",
      group: "identify",
      label: "vpa.kTitle",
      status: "pass",
      pages: [],
      note: "vpa.nTitleOk",
      detail: xmp.dcTitle.slice(0, 80),
    });
  } else {
    checks.push({
      id: "title",
      group: "identify",
      label: "vpa.kTitle",
      status: "warn",
      pages: [],
      note: "vpa.nTitleWarn",
    });
  }

  /* ---- 3. fonts ----------------------------------------------- */
  const unembedded = fontList.filter((f) => !f.embedded);
  if (fontList.length === 0) {
    checks.push({
      id: "fonts",
      group: "fonts",
      label: "vpa.kFonts",
      status: "pass",
      pages: [],
      note: "vpa.nFontsNone",
    });
  } else if (unembedded.length === 0) {
    checks.push({
      id: "fonts",
      group: "fonts",
      label: "vpa.kFonts",
      status: "pass",
      pages: [],
      note: "vpa.nFontsOk",
      detail: `${fontList.length}`,
    });
  } else {
    const badNonStd = unembedded.filter((f) => !f.standard14);
    const stdOnly = badNonStd.length === 0;
    const fail = !stdOnly || level.effectiveLevel !== "1b";
    const allPages = dedupeSorted(unembedded.flatMap((f) => f.pages));
    checks.push({
      id: "fonts",
      group: "fonts",
      label: "vpa.kFonts",
      status: fail ? "fail" : "pass",
      pages: allPages,
      note: fail ? "vpa.nFontsFail" : "vpa.nFontsStd14",
      detail: unembedded
        .map((f) => `${f.name} (${f.subtype}) — ${pagesLabel(f.pages) || "?"}`)
        .join("; ")
        .slice(0, 300),
    });
  }

  /* ---- 4. device CMYK ------------------------------------------ */
  const cmykPages = dedupeSorted([...findings.cmykOpPages, ...findings.cmykResPages]);
  const cmykOps = findings.cmykOpPages.length > 0;
  checks.push({
    id: "cmyk",
    group: "color",
    label: "vpa.kCmyk",
    status: cmykPages.length > 0 ? "fail" : "pass",
    pages: cmykPages,
    note: cmykPages.length > 0 ? (cmykOps ? "vpa.nCmykOps" : "vpa.nCmykRes") : "vpa.nCmykOk",
    detail:
      cmykPages.length > 0
        ? `${cmykOps ? "k/K operators" : "/DeviceCMYK in resources"} — ${pagesLabel(cmykPages)}`
        : undefined,
  });

  /* ---- 5. transparency ---------------------------------------- */
  const transPages = dedupeSorted(findings.transparencyPages);
  if (level.effectiveLevel === "1b") {
    checks.push({
      id: "transparency",
      group: "color",
      label: "vpa.kTransparency",
      status: transPages.length > 0 ? "fail" : "pass",
      pages: transPages,
      note: transPages.length > 0 ? "vpa.nTransFail1b" : "vpa.nTransOk1b",
      detail:
        transPages.length > 0
          ? `/SMask, transparency group or soft-mask ExtGState — ${pagesLabel(transPages)}`
          : undefined,
    });
  } else {
    checks.push({
      id: "transparency",
      group: "color",
      label: "vpa.kTransparency",
      status: "pass",
      pages: transPages,
      note: transPages.length > 0 ? "vpa.nTransOk2b" : "vpa.nTransOkNone",
      detail:
        transPages.length > 0
          ? `${transPages.length} page(s) — allowed at ${level.effectiveLevel}`
          : undefined,
    });
  }

  /* ---- 6. PostScript functions --------------------------------- */
  const psPages = dedupeSorted(findings.psfuncPages);
  checks.push({
    id: "psfunc",
    group: "color",
    label: "vpa.kPsfunc",
    status: psPages.length > 0 ? "fail" : "pass",
    pages: psPages,
    note: psPages.length > 0 ? "vpa.nPsFail" : "vpa.nPsOk",
    detail: psPages.length > 0 ? `/FunctionType 4 — ${pagesLabel(psPages)}` : undefined,
  });

  /* ---- 7. forbidden: encryption --------------------------------- */
  checks.push({
    id: "encrypt",
    group: "forbidden",
    label: "vpa.kEncrypt",
    status: forbidden.encrypt ? "fail" : "pass",
    pages: [],
    note: forbidden.encrypt ? "vpa.nEncFail" : "vpa.nEncOk",
  });

  /* ---- 8. forbidden: JavaScript --------------------------------- */
  const jsPages = dedupeSorted(forbidden.jsPages);
  if (forbidden.jsNames) jsPages.unshift(0);
  const jsAny = forbidden.jsNames || jsPages.length > 0;
  checks.push({
    id: "js",
    group: "forbidden",
    label: "vpa.kJs",
    status: jsAny ? "fail" : "pass",
    pages: jsPages.filter((p) => p > 0),
    note: jsAny ? "vpa.nJsFail" : "vpa.nJsOk",
    detail: jsAny
      ? `${forbidden.jsNames ? "/Names/JavaScript; " : ""}${
          jsPages.length > 0 ? `/JS actions — ${pagesLabel(jsPages)}` : ""
        }`
      : undefined,
  });

  /* ---- 9. forbidden: /Launch ------------------------------------- */
  const launchPages = dedupeSorted(forbidden.launchPages);
  checks.push({
    id: "launch",
    group: "forbidden",
    label: "vpa.kLaunch",
    status: launchPages.length > 0 ? "fail" : "pass",
    pages: launchPages.filter((p) => p > 0),
    note: launchPages.length > 0 ? "vpa.nLaunchFail" : "vpa.nLaunchOk",
    detail: launchPages.length > 0 ? `/S /Launch — ${pagesLabel(launchPages)}` : undefined,
  });

  /* ---- 10. forbidden: /OpenAction form --------------------------- */
  if (forbidden.openActionDict) {
    checks.push({
      id: "openaction",
      group: "forbidden",
      label: "vpa.kOpenaction",
      status: "fail",
      pages: [],
      note: "vpa.nOaFail",
      detail: "/OpenAction is an action dictionary, not a destination",
    });
  } else if (forbidden.openActionDest) {
    checks.push({
      id: "openaction",
      group: "forbidden",
      label: "vpa.kOpenaction",
      status: "pass",
      pages: [],
      note: "vpa.nOaOk",
    });
  } else {
    checks.push({
      id: "openaction",
      group: "forbidden",
      label: "vpa.kOpenaction",
      status: "pass",
      pages: [],
      note: "vpa.nOaNone",
    });
  }

  /* ---- 11. embedded files (level-dependent) ---------------------- */
  if (forbidden.embeddedFiles) {
    if (level.effectiveLevel === "3b") {
      checks.push({
        id: "embfiles",
        group: "forbidden",
        label: "vpa.kEmbfiles",
        status: "pass",
        pages: [],
        note: "vpa.nEmbOk3",
        detail: "PDF/A-3 allows embedded files",
      });
    } else {
      checks.push({
        id: "embfiles",
        group: "forbidden",
        label: "vpa.kEmbfiles",
        status: "fail",
        pages: [],
        note: "vpa.nEmbFail12",
        detail: `/AF or /Names/EmbeddedFiles present — violates ${level.effectiveLevel}`,
      });
    }
  } else {
    checks.push({
      id: "embfiles",
      group: "forbidden",
      label: "vpa.kEmbfiles",
      status: "pass",
      pages: [],
      note: "vpa.nEmbOk12",
    });
  }

  /* ---- 12. forbidden: multimedia --------------------------------- */
  const mmPages = dedupeSorted(forbidden.multimediaPages);
  checks.push({
    id: "multimedia",
    group: "forbidden",
    label: "vpa.kMultimedia",
    status: mmPages.length > 0 ? "fail" : "pass",
    pages: mmPages,
    note: mmPages.length > 0 ? "vpa.nMmFail" : "vpa.nMmOk",
    detail:
      mmPages.length > 0
        ? `${[...forbidden.multimediaSubtypes].join(", ")} — ${pagesLabel(mmPages)}`
        : undefined,
  });

  /* ---- 13. OutputIntent ----------------------------------------- */
  const ois = resolvers.arr(walk.catalog.map.get("OutputIntents"));
  let oiFound = false;
  let oiCondition: string | null = null;
  if (ois !== undefined) {
    for (const ov of ois.items) {
      const oi = resolvers.dict(ov);
      if (oi === undefined) continue;
      const prof = oi.map.get("DestOutputProfile");
      if (prof !== undefined && prof.k === "ref") {
        const streamObj = walk.objects.get(prof.num);
        if (streamObj !== undefined && streamObj.streamStart >= 0) {
          oiFound = true;
          oiCondition = resolvers.text(oi.map.get("OutputConditionIdentifier"));
          break;
        }
      }
    }
  }
  checks.push({
    id: "oi",
    group: "color",
    label: "vpa.kOi",
    status: oiFound ? "pass" : "warn",
    pages: [],
    note: oiFound ? "vpa.nOiOk" : "vpa.nOiWarn",
    detail: oiCondition ?? undefined,
  });

  /* ---- 14. MarkInfo / StructTree (level-a only) ------------------ */
  if (level.conformanceA) {
    const marked = resolvers.bool(resolvers.dict(walk.catalog.map.get("MarkInfo"))?.map.get("Marked"));
    const hasTree = resolvers.dict(walk.catalog.map.get("StructTreeRoot")) !== undefined;
    checks.push({
      id: "structinfo",
      group: "structure",
      label: "vpa.kStructInfo",
      status: marked === true && hasTree ? "pass" : "fail",
      pages: [],
      note: marked === true && hasTree ? "vpa.nStructAOk" : "vpa.nStructAFail",
      detail: `MarkInfo/Marked=${marked === true ? "true" : "false"}, StructTreeRoot=${hasTree}`,
    });
  } else {
    checks.push({
      id: "structinfo",
      group: "structure",
      label: "vpa.kStructInfo",
      status: "skip",
      pages: [],
      note: "vpa.nStructSkip",
    });
  }

  /* ---- 15. /Info ↔ XMP mirroring (light, warn-level) -------------- */
  const infoDict = resolvers.dict(walk.xref.infoVal ?? undefined);
  if (infoDict === undefined) {
    checks.push({
      id: "mirror",
      group: "meta",
      label: "vpa.kMirror",
      status: "pass",
      pages: [],
      note: "vpa.nMirrorNoInfo",
    });
  } else if (!xmp.present) {
    checks.push({
      id: "mirror",
      group: "meta",
      label: "vpa.kMirror",
      status: "skip",
      pages: [],
      note: "vpa.nMirrorSkip",
    });
  } else {
    const read = (key: string): string | null => {
      const val = infoDict.map.get(key);
      if (val === undefined) return null;
      const resolved = val.k === "ref" ? (walk.objects.get(val.num)?.value ?? val) : val;
      if (resolved.k === "str") return decodePdfStringText(resolved);
      if (resolved.k === "name") return resolved.name;
      return null;
    };
    const pairs: Array<[string, string | null, string | null]> = [
      ["Title", read("Title"), xmp.dcTitle],
      ["Author", read("Author"), xmp.dcCreator],
      ["Keywords", read("Keywords"), xmp.keywords],
      ["Producer", read("Producer"), xmp.producer],
    ];
    const problems: string[] = [];
    for (const [key, infoVal, xmpVal] of pairs) {
      if (infoVal === null || infoVal.length === 0) continue; // nothing to mirror
      if (xmpVal === null) {
        problems.push(`${key} not mirrored in XMP`);
      } else if (xmpVal !== infoVal.trim()) {
        problems.push(`${key}: "${infoVal.trim().slice(0, 40)}" ≠ "${xmpVal.slice(0, 40)}"`);
      }
    }
    checks.push({
      id: "mirror",
      group: "meta",
      label: "vpa.kMirror",
      status: problems.length > 0 ? "warn" : "pass",
      pages: [],
      note: problems.length > 0 ? "vpa.nMirrorWarn" : "vpa.nMirrorOk",
      detail: problems.join("; ").slice(0, 300) || undefined,
    });
  }

  /* ---- 16-18. PDF/UA hints (advisory — never affect the verdict) --- */
  const marked = resolvers.bool(resolvers.dict(walk.catalog.map.get("MarkInfo"))?.map.get("Marked"));
  checks.push({
    id: "uamarked",
    group: "ua",
    label: "vpa.kUaMarked",
    status: marked === true ? "pass" : "fail",
    pages: [],
    note: marked === true ? "vpa.nUaMarkedOk" : "vpa.nUaMarkedFail",
    advisory: true,
  });
  const lang = resolvers.text(walk.catalog.map.get("Lang"));
  checks.push({
    id: "ualang",
    group: "ua",
    label: "vpa.kUaLang",
    status: lang !== null && lang.length > 0 ? "pass" : "warn",
    pages: [],
    note: lang !== null && lang.length > 0 ? "vpa.nUaLangOk" : "vpa.nUaLangWarn",
    detail: lang ?? undefined,
    advisory: true,
  });
  const altCount = countStructAlt(walk, resolvers);
  checks.push({
    id: "uaalt",
    group: "ua",
    label: "vpa.kUaAlt",
    status: altCount < 0 ? "fail" : altCount === 0 ? "warn" : "pass",
    pages: [],
    note: altCount < 0 ? "vpa.nUaAltFail" : altCount === 0 ? "vpa.nUaAltWarn" : "vpa.nUaAltOk",
    detail: altCount > 0 ? `${altCount}` : undefined,
    advisory: true,
  });

  /* ---- verdict ------------------------------------------------- */
  const hard = checks.filter((c) => c.advisory !== true);
  const verdict =
    hard.some((c) => c.status === "fail")
      ? "fail"
      : hard.some((c) => c.status === "warn")
        ? "warnings"
        : "pass";

  return {
    declaredLevel: declared,
    effectiveLevel: level.effectiveLevel,
    autoDetected: level.autoDetected,
    xmpClaim: level.xmpClaim,
    detectedLevel: level.detectedLevel,
    conformanceA: level.conformanceA,
    xmp,
    pageCount: pages.length,
    checks,
    fonts: fontList,
    recoveryUsed: walk.recoveryUsed,
    recoveryReason: walk.xref.reason,
    verdict,
  };
}

/* ================================================================== */
/* PART 11 — the plain-text report (validate-e-invoice pattern)        */
/* ================================================================== */

/** English fallback labels (label-less runs still get a sane report). */
export const REPORT_LABELS_EN: ReportLabels = {
  "vpa.title": "PDF/A conformance report (honest subset)",
  "vpa.file": "File",
  "vpa.docLine": "Document",
  "vpa.pages": "pages",
  "vpa.level": "Level",
  "vpa.declared": "declared",
  "vpa.detected": "auto-detected from XMP",
  "vpa.assumed": "assumed — no XMP identification",
  "vpa.xref": "xref",
  "vpa.recovery": "Recovery",
  "vpa.rSummary": "SUMMARY",
  "vpa.rVerdict": "VERDICT",
  "vpa.rPassed": "passed",
  "vpa.rWarnings": "warnings",
  "vpa.rFailed": "failed",
  "vpa.rPages": "pages",
  "vpa.rFonts": "FONTS USED",
  "vpa.rUnembedded": "UNEMBEDDED FONTS",
  "vpa.vPass": "COMPLIANT",
  "vpa.vWarn": "COMPLIANT WITH WARNINGS",
  "vpa.vFail": "NOT COMPLIANT",
  "vpa.cPass": "PASS",
  "vpa.cWarn": "WARNING",
  "vpa.cFail": "FAIL",
  "vpa.cSkip": "NOT REQUIRED",
  "vpa.gIdentify": "IDENTIFICATION",
  "vpa.gFonts": "FONTS",
  "vpa.gColor": "COLOR & TRANSPARENCY",
  "vpa.gForbidden": "FORBIDDEN CONTENT",
  "vpa.gStructure": "STRUCTURE",
  "vpa.gMeta": "METADATA MIRROR",
  "vpa.gUa": "PDF/UA HINTS (ADVISORY — LIGHT SUBSET)",
  "vpa.kXmp": "XMP identification (pdfaid:part/conformance)",
  "vpa.kTitle": "dc:title in XMP",
  "vpa.kFonts": "Font embedding",
  "vpa.kCmyk": "Device CMYK",
  "vpa.kTransparency": "Transparency",
  "vpa.kPsfunc": "PostScript calculator functions",
  "vpa.kEncrypt": "Encryption",
  "vpa.kJs": "JavaScript",
  "vpa.kLaunch": "Launch actions",
  "vpa.kOpenaction": "OpenAction form",
  "vpa.kEmbfiles": "Embedded files",
  "vpa.kMultimedia": "Multimedia",
  "vpa.kOi": "OutputIntent (ICC profile)",
  "vpa.kStructInfo": "MarkInfo / StructTreeRoot (level a)",
  "vpa.kMirror": "/Info ↔ XMP mirroring (light)",
  "vpa.kUaMarked": "MarkInfo /Marked (UA hint)",
  "vpa.kUaLang": "Catalog /Lang (UA hint)",
  "vpa.kUaAlt": "Structure /Alt text (UA hint)",
  "vpa.nXmpNone": "The catalog carries no readable /Metadata stream — a PDF/A file must identify itself in XMP.",
  "vpa.nXmpNoPart": "XMP metadata is present but has no pdfaid:part identification — the file does not claim PDF/A.",
  "vpa.nXmpMismatch": "The XMP pdfaid:part/conformance does not match the declared level.",
  "vpa.nXmpConfMismatch": "The XMP conformance letter differs from the declared level (a stricter letter is a nuance, not a violation).",
  "vpa.nXmpOk": "The file identifies itself as PDF/A in XMP, matching the target level.",
  "vpa.nTitleSkip": "No XMP metadata — the title check has nothing to read.",
  "vpa.nTitleOk": "dc:title is present in the XMP.",
  "vpa.nTitleWarn": "dc:title is missing from the XMP (recommended, not required).",
  "vpa.nFontsNone": "No fonts are used by the page content — nothing to embed.",
  "vpa.nFontsOk": "Every font used by page content is embedded.",
  "vpa.nFontsStd14": "Only standard-14 fonts are unembedded, which PDF/A-1b allows.",
  "vpa.nFontsFail": "Unembedded fonts are used by page content — this level requires embedding.",
  "vpa.nCmykOk": "No device CMYK found in content streams or resources.",
  "vpa.nCmykOps": "Device CMYK operators (k/K) found in content streams.",
  "vpa.nCmykRes": "/DeviceCMYK found in page resources.",
  "vpa.nTransOk1b": "No transparency found — required at PDF/A-1b.",
  "vpa.nTransFail1b": "Transparency (/SMask, groups, soft masks) is forbidden at PDF/A-1b.",
  "vpa.nTransOk2b": "Transparency is present and allowed at this level.",
  "vpa.nTransOkNone": "No transparency found in the document.",
  "vpa.nPsOk": "No PostScript calculator functions (/FunctionType 4) found.",
  "vpa.nPsFail": "PostScript calculator functions (/FunctionType 4) are forbidden in PDF/A.",
  "vpa.nEncOk": "The document is not encrypted.",
  "vpa.nEncFail": "/Encrypt is present — PDF/A forbids encryption.",
  "vpa.nJsOk": "No JavaScript found.",
  "vpa.nJsFail": "JavaScript found (/Names/JavaScript or /JS actions) — forbidden in PDF/A.",
  "vpa.nLaunchOk": "No /Launch actions found.",
  "vpa.nLaunchFail": "/Launch actions are forbidden in PDF/A.",
  "vpa.nOaOk": "/OpenAction is a destination, as PDF/A requires.",
  "vpa.nOaNone": "No /OpenAction — nothing to judge.",
  "vpa.nOaFail": "/OpenAction is an action dictionary — PDF/A requires the destination form.",
  "vpa.nEmbOk12": "No embedded files — as PDF/A-1b/2b require.",
  "vpa.nEmbFail12": "Embedded files (/AF or /Names/EmbeddedFiles) violate PDF/A-1b/2b.",
  "vpa.nEmbOk3": "Embedded files are allowed at PDF/A-3b.",
  "vpa.nMmOk": "No multimedia content found.",
  "vpa.nMmFail": "Multimedia annotations found — forbidden in PDF/A.",
  "vpa.nOiOk": "An OutputIntent with an ICC profile stream is present.",
  "vpa.nOiWarn": "No OutputIntent with an ICC profile — many honest producers omit it (warning, not a failure).",
  "vpa.nStructAOk": "MarkInfo/Marked and StructTreeRoot are present, as level-a conformance requires.",
  "vpa.nStructAFail": "Level-a conformance requires MarkInfo/Marked and a structure tree.",
  "vpa.nStructSkip": "Not required for -b conformance levels.",
  "vpa.nMirrorNoInfo": "No /Info dictionary — nothing to mirror.",
  "vpa.nMirrorSkip": "No XMP metadata to mirror against.",
  "vpa.nMirrorOk": "The /Info entries are mirrored by the XMP (light check: Title/Author/Keywords/Producer).",
  "vpa.nMirrorWarn": "Some /Info entries are not mirrored by the XMP.",
  "vpa.nUaMarkedOk": "MarkInfo /Marked is true.",
  "vpa.nUaMarkedFail": "MarkInfo /Marked is not true — PDF/UA requires a tagged document.",
  "vpa.nUaLangOk": "The catalog declares a /Lang.",
  "vpa.nUaLangWarn": "The catalog declares no /Lang.",
  "vpa.nUaAltOk": "Alternate text entries found in the structure tree.",
  "vpa.nUaAltWarn": "No /Alt entries found in the structure tree (light scan).",
  "vpa.nUaAltFail": "No structure tree — no /Alt scan possible.",
  "vpa.generatedBy": "Generated on-device by DocoPDF — nothing was uploaded.",
  "vpa.honestyTitle": "NOT CHECKED (honesty)",
  "vpa.honestyBody":
    "This is an honest subset of ISO 19005 rule families, inspired by veraPDF's categories — not the full standard and not a certified validation. Roughly 15 rule families are checked; a COMPLIANT verdict means every check in this subset passed, nothing more. The PDF/UA rows are advisory hints only (full PDF/UA validation is not performed). Take archive-grade decisions to a certified validator.",
};

const L = (labels: ReportLabels, key: string): string =>
  labels[key] ?? REPORT_LABELS_EN[key] ?? key;

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const GROUP_ORDER = [
  "identify",
  "fonts",
  "color",
  "forbidden",
  "structure",
  "meta",
  "ua",
] as const;

/**
 * buildReportText — the honest plain-text conformance report.
 * Deterministic (no timestamps — byte-identical for the same input).
 */
export function buildReportText(
  report: PdfaReport,
  meta: ReportMeta,
  labels: ReportLabels
): string {
  const out: string[] = [];
  out.push("=".repeat(64));
  out.push(`DocoPDF — ${L(labels, "vpa.title")}`);
  out.push("=".repeat(64));
  out.push(`${L(labels, "vpa.file")}: ${meta.fileName} (${humanBytes(meta.bytes)})`);

  const parts: string[] = [];
  if (report.pageCount !== null && report.pageCount > 0) {
    parts.push(`${report.pageCount} ${L(labels, "vpa.pages")}`);
  }
  let levelLine = `${L(labels, "vpa.level")}: ${report.effectiveLevel.toUpperCase()}`;
  if (report.declaredLevel === "auto") {
    levelLine +=
      report.detectedLevel !== null
        ? ` (${L(labels, "vpa.detected")})`
        : ` (${L(labels, "vpa.assumed")})`;
  } else {
    levelLine += ` (${L(labels, "vpa.declared")}`;
    if (report.detectedLevel !== null && report.detectedLevel !== report.effectiveLevel) {
      levelLine += `; XMP ${report.xmpClaim ?? "?"}`;
    }
    levelLine += ")";
  }
  parts.push(levelLine);
  out.push(`${L(labels, "vpa.docLine")}: ${parts.join(" · ")}`);
  out.push(
    `${L(labels, "vpa.xref")}: ${report.recoveryUsed ? "recovery (linear object scan)" : "ok"}`
  );
  if (report.recoveryUsed && report.recoveryReason !== null) {
    out.push(`${L(labels, "vpa.recovery")}: ${report.recoveryReason}`);
  }
  out.push("");

  const nPass = report.checks.filter((c) => c.status === "pass").length;
  const nWarn = report.checks.filter((c) => c.status === "warn").length;
  const nFail = report.checks.filter((c) => c.status === "fail").length;
  out.push(
    `${L(labels, "vpa.rSummary")}: ${nPass} ${L(labels, "vpa.rPassed")}, ` +
      `${nWarn} ${L(labels, "vpa.rWarnings")}, ${nFail} ${L(labels, "vpa.rFailed")}`
  );
  out.push(
    `${L(labels, "vpa.rVerdict")}: ${
      report.verdict === "pass"
        ? L(labels, "vpa.vPass")
        : report.verdict === "warnings"
          ? L(labels, "vpa.vWarn")
          : L(labels, "vpa.vFail")
    }`
  );
  out.push("");

  for (const group of GROUP_ORDER) {
    const rows = report.checks.filter((c) => c.group === group);
    if (rows.length === 0) continue;
    out.push(`── ${L(labels, `vpa.g${group.charAt(0).toUpperCase()}${group.slice(1)}`)} `.padEnd(66, "─"));
    for (const c of rows) {
      const statusWord =
        c.status === "pass"
          ? L(labels, "vpa.cPass")
          : c.status === "warn"
            ? L(labels, "vpa.cWarn")
            : c.status === "skip"
              ? L(labels, "vpa.cSkip")
              : L(labels, "vpa.cFail");
      out.push(`  [${statusWord}] ${L(labels, c.label)}`);
      if (c.note !== undefined) out.push(`      ${L(labels, c.note)}`);
      if (c.detail !== undefined && c.detail.length > 0) out.push(`      (${c.detail})`);
      if (c.pages.length > 0) {
        out.push(`      ${L(labels, "vpa.rPages")}: ${pagesLabel(c.pages)}`);
      }
    }
    out.push("");
  }

  if (report.fonts.length > 0) {
    out.push(`${L(labels, "vpa.rFonts")}:`);
    for (const f of report.fonts.slice(0, 40)) {
      out.push(
        `  - ${f.name} (${f.subtype}) — ${f.embedded ? "embedded" : "NOT embedded"}` +
          ` — ${L(labels, "vpa.rPages")}: ${pagesLabel(f.pages) || "?"}`
      );
    }
    out.push("");
    const unembedded = report.fonts.filter((f) => !f.embedded);
    if (unembedded.length > 0) {
      out.push(`${L(labels, "vpa.rUnembedded")}:`);
      for (const f of unembedded.slice(0, 40)) {
        out.push(`  - ${f.name} (${f.subtype}) — ${L(labels, "vpa.rPages")}: ${pagesLabel(f.pages) || "?"}`);
      }
      out.push("");
    }
  }

  out.push(L(labels, "vpa.honestyTitle"));
  out.push(
    L(labels, "vpa.honestyBody")
      .match(/.{1,62}(\s|$)/g)
      ?.join("\n") ?? L(labels, "vpa.honestyBody")
  );
  out.push("");
  out.push(L(labels, "vpa.generatedBy"));
  out.push("");
  return out.join("\n");
}

/* ================================================================== */
/* PART 12 — worker-boundary coercion + naming                         */
/* ================================================================== */

function sanitizeFileWord(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) out += ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * parseRun — the options.run payload. Garbage JSON degrades to
 * defaults; labels accept any "vpa.*" string keys (≤ 240 chars each).
 */
export function parseRun(raw: string): RunOptions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const o = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const labels: ReportLabels = {};
  if (typeof o.labels === "object" && o.labels !== null) {
    for (const [k, v] of Object.entries(o.labels as Record<string, unknown>)) {
      // "vpa." + ≤ 58 alnum chars keeps keys ≤ 64 total (the RB6-FIN-b2
      // label-cap lesson — real keys are ≤ 16, junk must not ride through).
      if (/^vpa\.[A-Za-z0-9]{1,58}$/.test(k) && typeof v === "string") {
        labels[k] = v.slice(0, 240);
      }
    }
  }
  return {
    level: normalizeDeclaredLevel(typeof o.level === "string" ? o.level : "auto"),
    locale: o.locale === "hi" ? "hi" : "en",
    fileWord: sanitizeFileWord(typeof o.fileWord === "string" ? o.fileWord : ""),
    labels,
  };
}

/** Download base name: strips .pdf, sanitizes, localized fallback. */
export function outputBaseName(
  name: string,
  locale: "en" | "hi",
  fileWord = ""
): string {
  const base = name
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim();
  if (base.length > 0) return base.slice(0, 120);
  const word = fileWord.trim() || (locale === "hi" ? "दस्तावेज़" : "document");
  return word.slice(0, 60);
}
