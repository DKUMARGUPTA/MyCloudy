/**
 * DocoPDF own PDF micro-engine — document parser (P6-a).
 *
 * Own implementation end-to-end (user mandate: only our code):
 *  - header sniffing (junk-tolerant, %PDF- within first 1KB)
 *  - startxref discovery from EOF (last occurrence = newest section)
 *  - CLASSIC xref tables: subsections, free/in-use entries, byte-tolerant
 *  - XREF STREAMS: /W widths (big-endian), /Index, FlateDecode decoded with
 *    OUR OWN zip engine (src/lib/own/zip), PNG predictors 10-15
 *    (None/Sub/Up/Average/Paeth, 8-bit), /Prev chains + /XRefStm hybrid
 *    (stream entries take precedence over the table per spec)
 *  - OBJECT STREAMS (ObjStm): pair table + lazy inner-object parsing
 *  - indirect /Length resolution + endstream-scan fallback
 *  - /Encrypt → typed "encrypted" refusal (never attempts decryption)
 *  - broken xref → one-shot brute-force header scan recovery (degraded:
 *    ObjStm-resident objects invisible; hopeless files belong to repair-pdf)
 *
 * Content streams are NEVER decoded — captured as raw byte views.
 */

import { inflateSync, unzlibSync } from "@/lib/own/zip";
import {
  type PdfObj,
  type PdfRef,
  asNum,
  dget,
} from "./objects";
import { Lexer, PdfSyntaxError, latin1, scanObjectHeaders } from "./lexer";

export class PdfError extends Error {
  constructor(
    public readonly code:
      | "encrypted"
      | "corrupt"
      | "unsupported"
      /** Stamp-family: an image could not be parsed (maps to the legacy
       *  "logo…" pdf-lib error messages the workers match on). */
      | "logo"
      /** Stamp-family: text contains glyphs WinAnsi cannot encode (the
       *  parity of pdf-lib's encodeText throw → tool.errorWatermarkChars). */
      | "chars",
    message: string,
  ) {
    super(message);
    this.name = "PdfError";
  }
}

/** One xref entry. type 1: a=byte offset. type 2: a=objstm num, b=index. */
export interface XrefEntry {
  type: 0 | 1 | 2;
  a: number;
  b: number;
}

export interface ParsedPdf {
  readonly data: Uint8Array;
  readonly version: string;
  /** xref entries by object number (newest section wins). */
  readonly entries: Map<number, XrefEntry>;
  /** merged trailer keys (Root/Size/Info/ID/Encrypt…). */
  readonly trailer: Map<string, PdfObj>;
  /** true when the xref chain was unusable and we brute-scanned. */
  readonly recovered: boolean;
  getObject(num: number): PdfObj | undefined;
}

// ─── Stream decoding (xref streams + ObjStm only) ───────────────────────────

/** PNG predictors 10–15 (8-bit samples). data = filtered rows. */
export function pngUnfilter(
  data: Uint8Array,
  colors: number,
  columns: number,
): Uint8Array {
  const bpp = Math.max(1, colors); // 8-bit → one byte per color sample
  const rowLen = Math.max(1, columns);
  const stride = 1 + rowLen;
  const rows = Math.floor(data.length / stride);
  if (rows <= 0) return new Uint8Array(0);
  const out = new Uint8Array(rows * rowLen);
  let prevStart = -1;
  for (let r = 0; r < rows; r++) {
    const filter = data[r * stride]!;
    const src = r * stride + 1;
    const curStart = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const x = data[src + i] ?? 0;
      const a = i >= bpp ? out[curStart + i - bpp]! : 0;
      const b = prevStart >= 0 ? out[prevStart + i]! : 0;
      const c = prevStart >= 0 && i >= bpp ? out[prevStart + i - bpp]! : 0;
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
        default: v = x; break; // unknown filter → treat as None (tolerant)
      }
      out[curStart + i] = v & 0xff;
    }
    prevStart = curStart;
  }
  return out;
}

interface DecodeParms {
  predictor: number;
  colors: number;
  columns: number;
  bits: number;
}

function parmsOf(dict: Map<string, PdfObj>, index: number): DecodeParms | undefined {
  const dp = dget({ k: "dict", m: dict }, "DecodeParms");
  let m: Map<string, PdfObj> | undefined;
  if (dp?.k === "arr") {
    const item = dp.items[index] ?? dp.items[0];
    m = item?.k === "dict" ? item.m : undefined;
  } else if (dp?.k === "dict") {
    m = dp.m;
  }
  if (!m) return undefined;
  return {
    predictor: asNum(m.get("Predictor")) ?? 1,
    colors: asNum(m.get("Colors")) ?? 1,
    columns: asNum(m.get("Columns")) ?? 1,
    bits: asNum(m.get("BitsPerComponent")) ?? 8,
  };
}

/**
 * Apply /Filter + /DecodeParms (FlateDecode/ASCIIHex only — this engine
 * never needs more for xref streams and ObjStm). `raw` = UNDECODED body.
 * `filterIndex` selects the DecodeParms slot for array filters.
 */
export function decodeForParser(
  raw: Uint8Array,
  dict: Map<string, PdfObj>,
  filterIndex = 0,
): Uint8Array {
  const filterObj = dget({ k: "dict", m: dict }, "Filter");
  if (!filterObj) return raw;

  let data = raw;
  const filters: string[] = [];
  if (filterObj.k === "name") filters.push(filterObj.v);
  else if (filterObj.k === "arr") {
    for (const f of filterObj.items) {
      if (f.k !== "name") throw new PdfError("corrupt", "bad /Filter array");
      filters.push(f.v);
    }
  } else return raw;

  for (let i = 0; i < filters.length; i++) {
    const f = filters[i]!;
    if (f === "FlateDecode" || f === "Fl") {
      data = flateDecodeTolerant(data);
      const p = parmsOf(dict, i === 0 ? filterIndex : 0);
      if (p && p.predictor >= 10) {
        if (p.bits !== 8) {
          throw new PdfError("unsupported", `PNG predictor with ${p.bits}-bit samples`);
        }
        data = pngUnfilter(data, p.colors, p.columns);
      } else if (p && p.predictor === 2) {
        throw new PdfError("unsupported", "TIFF predictor (Pred=2) not supported");
      }
    } else if (f === "ASCIIHexDecode" || f === "AHx") {
      data = asciiHexDecode(data);
    } else {
      throw new PdfError("unsupported", `filter ${f} not supported here`);
    }
  }
  return data;
}

/** zlib (spec-mandated) with raw-deflate tolerance via our own zip engine. */
function flateDecodeTolerant(data: Uint8Array): Uint8Array {
  try {
    return unzlibSync(data);
  } catch {
    try {
      return inflateSync(data); // raw stream written by buggy producers
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
  const out = new Uint8Array(Math.ceil(nib.length / 2));
  for (let i = 0; i < nib.length; i += 2) {
    out[i >> 1] = ((nib[i]! << 4) | (i + 1 < nib.length ? nib[i + 1]! : 0)) & 0xff;
  }
  return out;
}

// ─── Document parser ────────────────────────────────────────────────────────

interface ObjStm {
  /** [objNum, relativeOffsetFromFirst] in stream order. */
  pairs: Array<[number, number]>;
  data: Uint8Array;
  first: number;
}

class ParserImpl {
  readonly entries = new Map<number, XrefEntry>();
  readonly trailer = new Map<string, PdfObj>();
  private readonly objectCache = new Map<number, PdfObj>();
  private readonly objstmCache = new Map<number, ObjStm>();
  recovered = false;
  private bruteDone = false;
  readonly version: string;

  constructor(readonly data: Uint8Array) {
    this.version = sniffHeader(data);
  }

  private get lexer(): Lexer {
    return new Lexer(this.data);
  }

  // ── top level ──

  parse(): void {
    const startxref = findLastStartxref(this.data);
    if (startxref >= 0) {
      try {
        this.parseXrefChain(startxref, new Set());
      } catch (err) {
        if (err instanceof PdfError) throw err; // typed errors stay typed
        this.bruteRecover();
      }
    } else {
      this.bruteRecover();
    }
    if (this.trailer.has("Encrypt")) {
      throw new PdfError("encrypted", "document is encrypted — unlock it first");
    }
  }

  private bruteRecover(): void {
    if (this.bruteDone) {
      throw new PdfError("corrupt", "xref chain and brute recovery both failed");
    }
    this.bruteDone = true;
    this.recovered = true;
    this.entries.clear();
    for (const h of scanObjectHeaders(this.data)) {
      if (!this.entries.has(h.num)) {
        this.entries.set(h.num, { type: 1, a: h.offset, b: h.gen });
      }
    }
    // Recovery needs a usable catalog for page surgery: (1) try the last
    // intact "trailer" dict for /Root; (2) fall back to scanning objects
    // for /Type /Catalog. Encrypt detection still works afterwards.
    const trailerDict = this.findLastTrailer();
    if (trailerDict) mergeTrailer(this.trailer, trailerDict);
    if (!this.trailer.has("Root")) {
      const cat = this.findCatalogByScan();
      if (cat) this.trailer.set("Root", cat);
    }
  }

  /** Backward scan (last 64KB) for a parseable "trailer <<…>>" dict. */
  private findLastTrailer(): Map<string, PdfObj> | undefined {
    const needle = "trailer";
    const floor = Math.max(0, this.data.length - 65_536);
    outer: for (let i = this.data.length - needle.length; i >= floor; i--) {
      for (let j = 0; j < needle.length; j++) {
        if (this.data[i + j] !== needle.charCodeAt(j)) continue outer;
      }
      try {
        const lex = new Lexer(this.data, i + needle.length);
        const value = this.parseValueFrom(lex);
        if (value.k === "dict") return value.m;
      } catch {
        // false-positive bytes — keep scanning backwards
      }
    }
    return undefined;
  }

  /** Scan recovered objects for /Type /Catalog (bounded). */
  private findCatalogByScan(): PdfObj | undefined {
    let checked = 0;
    for (const h of scanObjectHeaders(this.data)) {
      if (checked++ > 2000) break;
      try {
        const obj = this.parseIndirectAt(h.offset, h.num);
        if (!obj || (obj.k !== "dict" && obj.k !== "stream")) continue;
        const t = obj.m.get("Type");
        if (t && t.k === "name" && t.v === "Catalog") {
          return { k: "ref", num: h.num, gen: h.gen };
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  // ── xref chain (newest → oldest; set-if-absent = newest wins) ──

  private parseXrefChain(offset: number, seen: Set<number>): void {
    let cursor = offset;
    let guard = 0;
    while (cursor > 0 && !seen.has(cursor) && guard++ < 128) {
      seen.add(cursor);
      cursor = this.parseXrefSection(cursor, seen);
    }
  }

  /** Returns the /Prev offset (0 = end of chain). */
  private parseXrefSection(offset: number, seen: Set<number>): number {
    if (offset < 0 || offset >= this.data.length) {
      throw new PdfSyntaxError("startxref out of range", offset);
    }
    const lex = this.lexer;
    lex.pos = offset;
    lex.skipWsAndComments();
    const first = lex.readToken();
    if (first.t === "kw" && first.v === "xref") {
      return this.parseClassicTable(lex);
    }
    if (first.t === "num" && first.isInt) {
      const gen = lex.readToken();
      const kw = lex.readToken();
      if (gen.t === "num" && gen.isInt && kw.t === "kw" && kw.v === "obj") {
        return this.parseXrefStream(lex);
      }
    }
    throw new PdfSyntaxError("not an xref section", offset);
  }

  /** Classic table: subsections + "trailer" dict. Returns /Prev or 0. */
  private parseClassicTable(lex: Lexer): number {
    for (;;) {
      lex.skipWsAndComments();
      if (lex.pos >= this.data.length) break;
      if (matchWord(this.data, lex.pos, "trailer")) break;
      const startTok = lex.readToken();
      if (!(startTok.t === "num" && startTok.isInt)) break;
      const countTok = lex.readToken();
      if (!(countTok.t === "num" && countTok.isInt)) break;
      const start = startTok.n;
      const count = countTok.n;
      if (start < 0 || count < 0 || count > 10_000_000) {
        throw new PdfSyntaxError("xref subsection out of range", lex.pos);
      }
      for (let i = 0; i < count; i++) {
        const e = this.readClassicEntry(lex);
        const objNum = start + i;
        if (!this.entries.has(objNum)) this.entries.set(objNum, e);
      }
    }
    const trailer = this.readTrailerDict(lex);
    mergeTrailer(this.trailer, trailer);
    const xrefStm = asNum(trailer.get("XRefStm"));
    if (xrefStm !== undefined && xrefStm > 0) {
      // Hybrid-reference file: the stream section has priority over THIS
      // table — parsed first, set-if-absent gives it precedence.
      this.parseXrefChain(xrefStm, new Set());
    }
    return asNum(trailer.get("Prev")) ?? 0;
  }

  private readClassicEntry(lex: Lexer): XrefEntry {
    lex.skipWsAndComments();
    const off = readIntBytes(this.data, lex.pos);
    lex.pos = off.end;
    lex.skipWsAndComments();
    const gen = readIntBytes(this.data, lex.pos);
    lex.pos = gen.end;
    lex.skipWsAndComments();
    const typeChar = this.data[lex.pos];
    lex.pos++;
    // Tolerate classic "nnnnnnnnnn ggggg n\r\n" plus loose EOLs.
    if (typeChar === 0x6e /* n */) return { type: 1, a: off.value, b: gen.value };
    if (typeChar === 0x66 /* f */) return { type: 0, a: off.value, b: gen.value };
    throw new PdfSyntaxError("bad xref entry type", lex.pos);
  }

  private readTrailerDict(lex: Lexer): Map<string, PdfObj> {
    lex.skipWsAndComments();
    if (!matchWord(this.data, lex.pos, "trailer")) {
      throw new PdfSyntaxError("trailer keyword missing", lex.pos);
    }
    lex.pos += 7;
    const value = this.parseValueFrom(lex);
    if (value.k !== "dict") {
      throw new PdfSyntaxError("trailer must be a dict", lex.pos);
    }
    return value.m;
  }

  /** XRef stream: entries decoded from /W + /Index. Returns /Prev or 0. */
  private parseXrefStream(lex: Lexer): number {
    const obj = this.parseStreamObject(lex);
    if (obj.k !== "stream") {
      throw new PdfSyntaxError("xref stream body missing", lex.pos);
    }
    const decoded = decodeForParser(obj.raw, obj.m);
    const wArr = dget(obj, "W");
    const w: number[] = [];
    if (wArr?.k === "arr") {
      for (const item of wArr.items) {
        const n = asNum(item);
        if (n === undefined || n < 0 || n > 8) throw new PdfError("corrupt", "bad /W entry");
        w.push(n);
      }
    }
    if (w.length !== 3) throw new PdfError("corrupt", "/W must have 3 widths");
    const [w1, w2, w3] = w as [number, number, number];
    const entryLen = w1 + w2 + w3;
    if (entryLen <= 0) throw new PdfError("corrupt", "empty xref entry width");

    let ranges: Array<[number, number]> = [];
    const indexArr = dget(obj, "Index");
    if (indexArr?.k === "arr") {
      for (let i = 0; i + 1 < indexArr.items.length; i += 2) {
        const s = asNum(indexArr.items[i]!);
        const c = asNum(indexArr.items[i + 1]!);
        if (s === undefined || c === undefined) throw new PdfError("corrupt", "bad /Index");
        ranges.push([s, c]);
      }
    } else {
      const size = asNum(dget(obj, "Size")) ?? 0;
      ranges = [[0, size]];
    }

    let pos = 0;
    const readWidth = (from: number, width: number): number => {
      let v = 0;
      for (let i = 0; i < width; i++) v = v * 256 + (decoded[from + i] ?? 0);
      return v;
    };
    for (const [startObj, count] of ranges) {
      for (let i = 0; i < count; i++) {
        if (pos + entryLen > decoded.length) break;
        const type = w1 === 0 ? 1 : readWidth(pos, w1);
        const f2 = w2 === 0 ? 0 : readWidth(pos + w1, w2);
        const f3 = w3 === 0 ? 0 : readWidth(pos + w1 + w2, w3);
        pos += entryLen;
        const objNum = startObj + i;
        if (this.entries.has(objNum)) continue; // newer section already won
        if (type === 0) this.entries.set(objNum, { type: 0, a: f2, b: f3 });
        else if (type === 1) this.entries.set(objNum, { type: 1, a: f2, b: f3 });
        else if (type === 2) this.entries.set(objNum, { type: 2, a: f2, b: f3 });
      }
    }

    mergeTrailer(this.trailer, obj.m);
    return asNum(obj.m.get("Prev")) ?? 0;
  }

  // ── object access ──

  getObject(num: number): PdfObj | undefined {
    const cached = this.objectCache.get(num);
    if (cached) return cached;
    const entry = this.entries.get(num);
    if (!entry || entry.type === 0) return undefined;

    if (entry.type === 1) {
      const value = this.parseIndirectAt(entry.a, num);
      if (value) {
        this.objectCache.set(num, value);
        return value;
      }
      // Bad offset → one-shot brute recovery, retry once.
      if (!this.bruteDone) {
        this.bruteRecover();
        const retry = this.entries.get(num);
        if (retry && retry.type === 1) {
          const v2 = this.parseIndirectAt(retry.a, num);
          if (v2) {
            this.objectCache.set(num, v2);
            return v2;
          }
        }
      }
      return undefined;
    }

    const value = this.parseFromObjStm(entry.a, entry.b);
    this.objectCache.set(num, value);
    return value;
  }

  private parseIndirectAt(offset: number, expectedNum: number): PdfObj | undefined {
    if (offset < 0 || offset >= this.data.length) return undefined;
    const lex = this.lexer;
    lex.pos = offset;
    try {
      lex.skipWsAndComments();
      const numTok = lex.readToken();
      const genTok = lex.readToken();
      const kw = lex.readToken();
      if (!(numTok.t === "num" && genTok.t === "num" && kw.t === "kw" && kw.v === "obj")) {
        return undefined; // bad offset (corrupt xref) — caller may recover
      }
      if (numTok.n !== expectedNum) return undefined; // points elsewhere
      // Streams live here too (content streams, ObjStm, xref streams) —
      // parse the optional "stream … endstream" tail when the value is a dict.
      const value = this.parseStreamObject(lex);
      lex.skipWsAndComments();
      if (matchWord(this.data, lex.pos, "endobj")) lex.pos += 6; // tolerant
      return value;
    } catch (err) {
      if (err instanceof PdfError) throw err;
      return undefined; // syntax garbage at this offset → recovery path
    }
  }

  /** value, then optional "stream … endstream" when the value is a dict. */
  private parseStreamObject(lex: Lexer): PdfObj {
    return this.maybeInlineStream(lex, this.parseValueFrom(lex));
  }

  /**
   * A dict value followed by an inline "stream … endstream" body — DIRECT
   * streams inside object dicts/arrays (technically illegal per spec
   * §7.3.8.1, but pdf-lib writes them for unregistered form XObjects and
   * pdf.js reads them; the flatten fixtures carry exactly that shape).
   * Uses the LEXER's buffer — correct in ObjStm-member contexts too.
   */
  private maybeInlineStream(lex: Lexer, value: PdfObj): PdfObj {
    if (value.k !== "dict") return value;
    const save = lex.pos;
    lex.skipWsAndComments();
    if (!matchWord(lex.data, lex.pos, "stream")) {
      lex.pos = save;
      return value;
    }
    lex.pos += 6;
    const length = this.resolveLength(value.m);
    const raw = lex.readStreamBody(length);
    return { k: "stream", m: value.m, raw };
  }

  private resolveLength(m: Map<string, PdfObj>): number {
    const lenObj = m.get("Length");
    if (!lenObj) return -1; // forces endstream scan
    if (lenObj.k === "num") return lenObj.n >= 0 ? lenObj.n : -1;
    if (lenObj.k === "ref") {
      const resolved = this.getObject(lenObj.num);
      const n = resolved ? asNum(resolved) : undefined;
      return n !== undefined && n >= 0 ? n : -1;
    }
    return -1;
  }

  private parseFromObjStm(objstmNum: number, index: number): PdfObj {
    let stm = this.objstmCache.get(objstmNum);
    if (!stm) {
      const entry = this.entries.get(objstmNum);
      if (!entry || entry.type !== 1) {
        throw new PdfError("corrupt", `ObjStm ${objstmNum} unreachable`);
      }
      let obj = this.parseIndirectAt(entry.a, objstmNum);
      if ((!obj || obj.k !== "stream") && !this.bruteDone) {
        // Bad offset → one-shot brute recovery, retry once.
        this.bruteRecover();
        const retry = this.entries.get(objstmNum);
        if (retry && retry.type === 1) {
          obj = this.parseIndirectAt(retry.a, objstmNum);
        }
      }
      if (!obj || obj.k !== "stream") {
        throw new PdfError("corrupt", `ObjStm ${objstmNum} is not a stream`);
      }
      const n = asNum(dget(obj, "N")) ?? -1;
      const first = asNum(dget(obj, "First")) ?? -1;
      if (n < 0 || first < 0) throw new PdfError("corrupt", "ObjStm missing N/First");
      const data = decodeForParser(obj.raw, obj.m);
      const pairs: Array<[number, number]> = [];
      const lex = new Lexer(data, 0);
      for (let i = 0; i < n; i++) {
        const a = lex.readToken();
        const b = lex.readToken();
        if (!(a.t === "num" && a.isInt) || !(b.t === "num" && b.isInt)) {
          throw new PdfError("corrupt", "bad ObjStm pair table");
        }
        pairs.push([a.n, b.n]);
      }
      stm = { pairs, data, first };
      this.objstmCache.set(objstmNum, stm);
    }
    const pair = stm.pairs[index];
    if (!pair) throw new PdfError("corrupt", `ObjStm index ${index} out of range`);
    const start = stm.first + pair[1];
    const nextRel = stm.pairs[index + 1]?.[1];
    const end = nextRel !== undefined ? stm.first + nextRel : stm.data.length;
    if (start < 0 || start >= stm.data.length) {
      throw new PdfError("corrupt", "ObjStm object offset out of range");
    }
    const lex = new Lexer(stm.data, start);
    return this.parseValueFrom(lex);
  }

  // ── value grammar ──

  private parseValueFrom(lex: Lexer, first?: ReturnType<Lexer["readToken"]>): PdfObj {
    const tok = first ?? lex.readToken();
    switch (tok.t) {
      case "num": {
        if (tok.isInt) {
          // Reference lookahead: INT INT R (snapshot + restore).
          const save = lex.pos;
          const t2 = lex.readToken();
          if (t2.t === "num" && t2.isInt) {
            const t3 = lex.readToken();
            if (t3.t === "kw" && t3.v === "R") {
              const r: PdfRef = { k: "ref", num: tok.n, gen: t2.n };
              return r;
            }
          }
          lex.pos = save;
        }
        return { k: "num", n: tok.n };
      }
      case "str":
        return { k: "str", b: tok.b };
      case "name":
        return { k: "name", v: tok.v };
      case "openArr": {
        const items: PdfObj[] = [];
        for (;;) {
          const inner = lex.readToken();
          if (inner.t === "closeArr") return { k: "arr", items };
          if (inner.t === "eof") throw new PdfSyntaxError("unterminated array", lex.pos);
          items.push(this.maybeInlineStream(lex, this.parseValueFrom(lex, inner)));
        }
      }
      case "openDict": {
        const m = new Map<string, PdfObj>();
        for (;;) {
          const keyTok = lex.readToken();
          if (keyTok.t === "closeDict") return { k: "dict", m };
          if (keyTok.t === "eof") throw new PdfSyntaxError("unterminated dict", lex.pos);
          if (keyTok.t !== "name") {
            throw new PdfSyntaxError("dict key must be a name", lex.pos);
          }
          m.set(keyTok.v, this.maybeInlineStream(lex, this.parseValueFrom(lex)));
        }
      }
      case "kw":
        if (tok.v === "true") return { k: "bool", b: true };
        if (tok.v === "false") return { k: "bool", b: false };
        if (tok.v === "null") return { k: "null" };
        throw new PdfSyntaxError(`unexpected keyword ${tok.v} in value`, lex.pos);
      default:
        throw new PdfSyntaxError("unexpected token in value", lex.pos);
    }
  }
}

function mergeTrailer(target: Map<string, PdfObj>, source: Map<string, PdfObj>): void {
  for (const [key, value] of source) {
    if (!target.has(key)) target.set(key, value);
  }
}

function matchWord(data: Uint8Array, pos: number, word: string): boolean {
  if (pos + word.length > data.length) return false;
  for (let i = 0; i < word.length; i++) {
    if (data[pos + i] !== word.charCodeAt(i)) return false;
  }
  return true;
}

function readIntBytes(data: Uint8Array, from: number): { value: number; end: number } {
  let v = 0;
  let i = from;
  let any = false;
  while (i < data.length && data[i]! >= 0x30 && data[i]! <= 0x39) {
    v = v * 10 + (data[i]! - 0x30);
    i++;
    any = true;
    if (i - from > 12) break; // offsets ≤ 12 digits
  }
  if (!any) throw new PdfSyntaxError("expected integer", from);
  return { value: v, end: i };
}

function sniffHeader(data: Uint8Array): string {
  const limit = Math.min(data.length - 5, 1024);
  for (let i = 0; i < limit; i++) {
    if (
      data[i] === 0x25 && data[i + 1] === 0x50 && data[i + 2] === 0x44 &&
      data[i + 3] === 0x46 && data[i + 4] === 0x2d
    ) {
      let end = i + 5;
      while (end < data.length && end - (i + 5) < 12) {
        const c = data[end]!;
        if (!((c >= 0x30 && c <= 0x39) || c === 0x2e)) break;
        end++;
      }
      return latin1(data, i + 5, end);
    }
  }
  throw new PdfError("corrupt", "%PDF- header not found in first 1024 bytes");
}

function findLastStartxref(data: Uint8Array): number {
  const needle = "startxref";
  const tailStart = Math.max(0, data.length - 2048);
  let found = -1;
  outer: for (let i = data.length - needle.length; i >= tailStart; i--) {
    for (let j = 0; j < needle.length; j++) {
      if (data[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    found = i;
    break;
  }
  if (found < 0) return -1;
  let p = found + needle.length;
  while (p < data.length && (data[p] === 0x20 || data[p] === 0x0a || data[p] === 0x0d || data[p] === 0x09)) p++;
  let v = 0;
  let any = false;
  while (p < data.length && data[p]! >= 0x30 && data[p]! <= 0x39) {
    v = v * 10 + (data[p]! - 0x30);
    p++;
    any = true;
  }
  return any ? v : -1;
}

// ─── Public surface ─────────────────────────────────────────────────────────

/**
 * Parse a PDF byte buffer into a lazily-resolving document.
 * Throws PdfError("encrypted"|"corrupt"|"unsupported").
 */
export function parsePdf(data: Uint8Array): ParsedPdf {
  if (!(data instanceof Uint8Array) || data.length < 8) {
    throw new PdfError("corrupt", "not enough bytes for a PDF");
  }
  const impl = new ParserImpl(data);
  impl.parse();
  return {
    data: impl.data,
    version: impl.version,
    entries: impl.entries,
    trailer: impl.trailer,
    recovered: impl.recovered,
    getObject: (num: number) => impl.getObject(num),
  };
}

/**
 * Resolve a value that may be an indirect reference (one level).
 * Returns the direct object, or undefined when the ref dangles.
 */
export function resolve(doc: ParsedPdf, o: PdfObj | undefined): PdfObj | undefined {
  if (!o) return undefined;
  if (o.k !== "ref") return o;
  return doc.getObject(o.num);
}
