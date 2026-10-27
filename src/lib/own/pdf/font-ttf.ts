/**
 * DocoPDF own PDF engine — TrueType font parsing + subsetting (P6-g).
 *
 * Parses exactly the tables the Devanagari shaping/embedding path needs from a
 * sfnt-wrapped TTF (the self-hosted Noto Sans Devanagari shipped at
 * /fonts/NotoSansDevanagari-Regular.ttf), and writes a PDF FontFile2 subset:
 *
 *   parse:  head, hhea, maxp, hmtx (advance + lsb), cmap (formats 4 + 12),
 *           glyf/loca (raw slices + composite-component closure), OS/2, post,
 *           name (postscriptName), GSUB (lookups 1/2/4/5/6, all classic
 *           formats), GDEF (glyph classes + mark attachment).
 *
 *   subset: the fontkit TTFSubset table set — head, hhea, loca, maxp, prep,
 *           glyf, hmtx (+ cvt/fpgm when present). Glyphs are renumbered in
 *           first-use order with .notdef at 0, composite components are
 *           included recursively and their gid fields rewritten in place, and
 *           variation tables (gvar/fvar/HVAR/avar/STAT) are dropped — the
 *           default instance is exactly what we render. Short loca when the
 *           last offset fits u16 units, long otherwise (fontkit parity).
 *
 * Zero external dependencies. Runs in Web Workers and bun unchanged.
 */

import { PdfError } from "./parser";

/* ─── shared little-endian readers ──────────────────────────────────────── */

class Reader {
  readonly dv: DataView;
  constructor(
    readonly b: Uint8Array,
    public p: number,
    readonly end: number,
  ) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u8(): number {
    if (this.p + 1 > this.end) throw new PdfError("chars", "ttf read past end");
    return this.b[this.p++]!;
  }
  u16(): number {
    if (this.p + 2 > this.end) throw new PdfError("chars", "ttf read past end");
    const v = this.dv.getUint16(this.p);
    this.p += 2;
    return v;
  }
  i16(): number {
    if (this.p + 2 > this.end) throw new PdfError("chars", "ttf read past end");
    const v = this.dv.getInt16(this.p);
    this.p += 2;
    return v;
  }
  u32(): number {
    if (this.p + 4 > this.end) throw new PdfError("chars", "ttf read past end");
    const v = this.dv.getUint32(this.p);
    this.p += 4;
    return v;
  }
  tag(): string {
    return (
      String.fromCharCode(this.u8(), this.u8(), this.u8(), this.u8())
    );
  }
}

function u16(b: Uint8Array, p: number): number {
  return (b[p]! << 8) | b[p + 1]!;
}
/** sign-correct int16 read. */
function i16(b: Uint8Array, p: number): number {
  const v = (b[p]! << 8) | b[p + 1]!;
  return v >= 0x8000 ? v - 0x10000 : v;
}
function u32(b: Uint8Array, p: number): number {
  return ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0;
}
function i32(b: Uint8Array, p: number): number {
  const v = u32(b, p);
  return v >= 0x80000000 ? v - 0x100000000 : v;
}

/* ─── GSUB / GDEF structure types (classic formats only — this font's set) ── */

export interface CoverageRange {
  start: number;
  end: number;
  index: number;
}
export interface Coverage {
  /** format 1: explicit glyph list; format 2: ranges. */
  fmt: 1 | 2;
  glyphs?: number[];
  ranges?: CoverageRange[];
}

export interface ClassDefRange {
  start: number;
  end: number;
  cls: number;
}
export interface ClassDef {
  fmt: 1 | 2;
  start?: number;
  values?: number[];
  ranges?: ClassDefRange[];
}

export function coverageIndex(cov: Coverage | undefined, gid: number): number {
  if (!cov) return -1;
  if (cov.fmt === 1) {
    const glyphs = cov.glyphs!;
    let lo = 0;
    let hi = glyphs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const g = glyphs[mid]!;
      if (gid < g) hi = mid - 1;
      else if (gid > g) lo = mid + 1;
      else return mid;
    }
    return -1;
  }
  const ranges = cov.ranges!;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid]!;
    if (gid < r.start) hi = mid - 1;
    else if (gid > r.end) lo = mid + 1;
    else return r.index + gid - r.start;
  }
  return -1;
}

export function classID(cd: ClassDef | undefined, gid: number): number {
  if (!cd) return 0;
  if (cd.fmt === 1) {
    const i = gid - cd.start!;
    if (i >= 0 && i < cd.values!.length) return cd.values![i]!;
    return 0;
  }
  const ranges = cd.ranges!;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid]!;
    if (gid < r.start) hi = mid - 1;
    else if (gid > r.end) lo = mid + 1;
    else return r.cls;
  }
  return 0;
}

/* Lookup subtables. */
export interface SingleSub1 {
  kind: "single1";
  cov: Coverage;
  delta: number;
}
export interface SingleSub2 {
  kind: "single2";
  cov: Coverage;
  substitutes: number[];
}
export interface MultipleSub1 {
  kind: "multiple1";
  cov: Coverage;
  sequences: number[][];
}
export interface LigatureEntry {
  glyph: number;
  components: number[];
}
export interface LigatureSub1 {
  kind: "ligature1";
  cov: Coverage;
  sets: LigatureEntry[][];
}
export interface LookupRecordEntry {
  sequenceIndex: number;
  lookupListIndex: number;
}
export interface ContextRule {
  input: number[];
  lookups: LookupRecordEntry[];
}
export interface ContextSub1 {
  kind: "context1";
  cov: Coverage;
  ruleSets: ContextRule[][];
}
export interface ClassRuleEntry {
  classes: number[];
  lookups: LookupRecordEntry[];
}
export interface ContextSub2 {
  kind: "context2";
  cov: Coverage;
  classDef: ClassDef;
  classSets: (ClassRuleEntry[] | undefined)[];
}
export interface ContextSub3 {
  kind: "context3";
  coverages: Coverage[];
  lookups: LookupRecordEntry[];
}
export interface ChainRuleEntry {
  backtrack: number[];
  input: number[];
  lookahead: number[];
  lookups: LookupRecordEntry[];
}
export interface ChainSub1 {
  kind: "chain1";
  cov: Coverage;
  ruleSets: ChainRuleEntry[][];
}
export interface ChainClassRule {
  backtrack: number[];
  input: number[];
  lookahead: number[];
  lookups: LookupRecordEntry[];
}
export interface ChainSub2 {
  kind: "chain2";
  cov: Coverage;
  backtrackClassDef: ClassDef;
  inputClassDef: ClassDef;
  lookaheadClassDef: ClassDef;
  classSets: (ChainClassRule[] | undefined)[];
}
export interface ChainSub3 {
  kind: "chain3";
  backtrack: Coverage[];
  input: Coverage[];
  lookahead: Coverage[];
  lookups: LookupRecordEntry[];
}

export type LookupSubtable =
  | SingleSub1
  | SingleSub2
  | MultipleSub1
  | LigatureSub1
  | ContextSub1
  | ContextSub2
  | ContextSub3
  | ChainSub1
  | ChainSub2
  | ChainSub3;

export interface GsubLookup {
  type: number;
  flag: number;
  subtables: LookupSubtable[];
}

export interface GsubFeature {
  tag: string;
  lookupIndexes: number[];
}

export interface GsubTables {
  /** script tag → defaultLangSys feature indexes (in record order). */
  scripts: Map<string, number[]>;
  features: GsubFeature[];
  lookups: GsubLookup[];
}

export interface GdefTables {
  glyphClassDef?: ClassDef;
  markAttachClassDef?: ClassDef;
}

/* ─── parsed font ───────────────────────────────────────────────────────── */

export interface CompositeComponent {
  /** byte offset of the glyphIndex u16 within the glyph's own bytes. */
  pos: number;
  gid: number;
}

export class ParsedTtfFont {
  readonly unitsPerEm: number;
  readonly numGlyphs: number;
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap: number;
  readonly italicAngle: number;
  readonly capHeight: number;
  readonly xHeight: number;
  readonly bbox: readonly [number, number, number, number];
  readonly postscriptName: string;
  readonly os2FamilyClass: number;
  readonly postIsFixedPitch: boolean;
  readonly headMacStyleItalic: boolean;
  readonly gsub: GsubTables | null;
  readonly gdef: GdefTables | null;

  private readonly glyf: Uint8Array;
  private readonly glyfPad: number;
  private readonly locaOffsets: Uint32Array;
  private readonly cmap4: { segCount: number; endCodes: Uint16Array; startCodes: Uint16Array; idDeltas: Int16Array; idRangeOffsets: Uint16Array; glyphIds: Uint16Array } | null;
  private readonly cmap12: { groups: Uint32Array } | null;
  private readonly advances: Uint16Array;
  private readonly lsbs: Int16Array;
  private readonly numberOfHMetrics: number;
  private readonly tables: Map<string, Uint8Array>;
  readonly spaceGid: number;

  private constructor(
    bytes: Uint8Array,
    tables: Map<string, Uint8Array>,
  ) {
    this.tables = tables;
    const need = (tag: string): Uint8Array => {
      const t = tables.get(tag);
      if (!t) throw new PdfError("chars", `ttf table ${tag} missing`);
      return t;
    };
    const head = need("head");
    this.unitsPerEm = u16(head, 18);
    this.headMacStyleItalic = (u16(head, 44) & 2) !== 0;
    this.bbox = [i16(head, 36), i16(head, 38), i16(head, 40), i16(head, 42)];

    const hhea = need("hhea");
    this.ascent = i16(hhea, 4);
    this.descent = i16(hhea, 6);
    this.lineGap = i16(hhea, 8);
    this.numberOfHMetrics = u16(hhea, 34);

    const maxp = need("maxp");
    this.numGlyphs = u16(maxp, 4);

    /* hmtx */
    const hmtx = need("hmtx");
    const nAdv = Math.min(this.numberOfHMetrics, this.numGlyphs);
    this.advances = new Uint16Array(this.numGlyphs);
    this.lsbs = new Int16Array(this.numGlyphs);
    let p = 0;
    for (let i = 0; i < nAdv; i++) {
      this.advances[i] = u16(hmtx, p);
      this.lsbs[i] = i16(hmtx, p + 2);
      p += 4;
    }
    const lastAdvance = nAdv > 0 ? this.advances[nAdv - 1]! : 0;
    for (let i = nAdv; i < this.numGlyphs; i++) {
      this.advances[i] = lastAdvance;
      this.lsbs[i] = i16(hmtx, p);
      p += 2;
    }

    /* cmap — prefer the UCS-4 format 12 subtable, fall back to format 4. */
    const cmap = need("cmap");
    let fmt4: ParsedTtfFont["cmap4"] = null;
    let fmt12: ParsedTtfFont["cmap12"] = null;
    const subCount = u16(cmap, 2);
    for (let i = 0; i < subCount; i++) {
      const rec = 4 + i * 8;
      if (rec + 8 > cmap.length) break;
      const platform = u16(cmap, rec);
      const encoding = u16(cmap, rec + 2);
      const offset = u32(cmap, rec + 4);
      if (offset + 2 > cmap.length) continue;
      const format = u16(cmap, offset);
      const unicode =
        (platform === 3 && (encoding === 1 || encoding === 10)) ||
        (platform === 0 && (encoding === 3 || encoding === 4));
      if (format === 4 && unicode && !fmt4) {
        const r = new Reader(cmap, offset, offset + u16(cmap, offset + 2));
        r.p = offset + 6;
        const segCountX2 = r.u16();
        const segCount = segCountX2 >> 1;
        const endCodes = new Uint16Array(segCount);
        for (let s = 0; s < segCount; s++) endCodes[s] = r.u16();
        r.u16(); // reservedPad
        const startCodes = new Uint16Array(segCount);
        for (let s = 0; s < segCount; s++) startCodes[s] = r.u16();
        const idDeltas = new Int16Array(segCount);
        for (let s = 0; s < segCount; s++) idDeltas[s] = r.i16();
        const idRangeOffsets = new Uint16Array(segCount);
        for (let s = 0; s < segCount; s++) idRangeOffsets[s] = r.u16();
        // glyphIdArray follows directly
        const gidStart = r.p;
        const gidLen = (offset + u16(cmap, offset + 2) - gidStart) >> 1;
        const glyphIds = new Uint16Array(Math.max(0, gidLen));
        for (let g = 0; g < gidLen; g++) glyphIds[g] = u16(cmap, gidStart + g * 2);
        fmt4 = { segCount, endCodes, startCodes, idDeltas, idRangeOffsets, glyphIds };
      } else if (format === 12 && unicode && !fmt12) {
        const r = new Reader(cmap, offset, cmap.length);
        r.p = offset + 12;
        const nGroups = r.u32();
        const groups = new Uint32Array(nGroups * 3);
        for (let g = 0; g < nGroups; g++) {
          groups[g * 3] = r.u32();
          groups[g * 3 + 1] = r.u32();
          groups[g * 3 + 2] = r.u32();
        }
        fmt12 = { groups };
      }
    }
    if (!fmt4 && !fmt12) throw new PdfError("chars", "ttf cmap has no unicode subtable");
    this.cmap4 = fmt4;
    this.cmap12 = fmt12;

    /* glyf + loca */
    const loca = need("loca");
    const longLoca = u16(head, 50) === 1;
    const offCount = this.numGlyphs + 1;
    this.locaOffsets = new Uint32Array(offCount);
    if (longLoca) {
      for (let i = 0; i < offCount; i++) this.locaOffsets[i] = u32(loca, i * 4);
    } else {
      for (let i = 0; i < offCount; i++) this.locaOffsets[i] = u16(loca, i * 2) * 2;
    }
    this.glyf = need("glyf");
    this.glyfPad = 0;

    /* OS/2 */
    const os2 = tables.get("OS/2");
    this.os2FamilyClass = os2 && os2.length >= 32 ? i16(os2, 30) : 0;
    this.capHeight = os2 && os2.length >= 90 && u16(os2, 0) >= 2 ? i16(os2, 88) : this.ascent;
    this.xHeight = os2 && os2.length >= 88 && u16(os2, 0) >= 2 ? i16(os2, 86) : 0;

    /* post */
    const post = tables.get("post");
    this.italicAngle = post ? i32(post, 4) / 65536 : 0;
    this.postIsFixedPitch = post ? u32(post, 12) !== 0 : false;

    /* name → postscriptName (nameID 6) */
    this.postscriptName = parsePostscriptName(tables.get("name"));

    /* GSUB + GDEF */
    this.gsub = parseGsub(tables.get("GSUB"));
    this.gdef = parseGdef(tables.get("GDEF"));

    this.spaceGid = this.glyphForCodePoint(0x20);
  }

  /** Parse a TTF (sfnt, little-endian tables). Throws typed "chars". */
  static parse(bytes: Uint8Array): ParsedTtfFont {
    if (bytes.length < 12) throw new PdfError("chars", "ttf too short");
    if (u32(bytes, 0) !== 0x00010000 && u32(bytes, 0) !== 0x74727565 /* 'true' */) {
      throw new PdfError("chars", "not a TrueType font");
    }
    const numTables = u16(bytes, 4);
    const tables = new Map<string, Uint8Array>();
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (rec + 16 > bytes.length) break;
      const tag = String.fromCharCode(
        bytes[rec]!,
        bytes[rec + 1]!,
        bytes[rec + 2]!,
        bytes[rec + 3]!,
      );
      const offset = u32(bytes, rec + 8);
      const length = u32(bytes, rec + 12);
      if (offset + length > bytes.length) continue;
      tables.set(tag, bytes.subarray(offset, offset + length));
    }
    return new ParsedTtfFont(bytes, tables);
  }

  /** Raw table bytes (for the subsetter passthrough: prep/cvt/fpgm). */
  table(tag: string): Uint8Array | undefined {
    return this.tables.get(tag);
  }

  /* ── cmap lookups ── */

  glyphForCodePoint(cp: number): number {
    if (this.cmap12) {
      const groups = this.cmap12.groups;
      let lo = 0;
      let hi = groups.length / 3 - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const base = mid * 3;
        if (cp < groups[base]!) hi = mid - 1;
        else if (cp > groups[base + 1]!) lo = mid + 1;
        else return groups[base + 2]! + (cp - groups[base]!);
      }
      return 0;
    }
    const c = this.cmap4!;
    let lo = 0;
    let hi = c.segCount - 1;
    let seg = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp < c.startCodes[mid]!) hi = mid - 1;
      else if (cp > c.endCodes[mid]!) lo = mid + 1;
      else {
        seg = mid;
        break;
      }
    }
    if (seg < 0) return 0;
    const rangeOffset = c.idRangeOffsets[seg]!;
    if (rangeOffset === 0) return (cp + c.idDeltas[seg]! + 65536) & 0xffff;
    // glyphIdArray index from the spec addressing:
    //   glyph at (field address) + rangeOffset + 2·(cp − startCode), where the
    //   field lives 2·(segCount − seg) u16s before the array start.
    const gidIndex =
      (rangeOffset >> 1) + (cp - c.startCodes[seg]!) - (c.segCount - seg);
    if (gidIndex < 0 || gidIndex >= c.glyphIds.length) return 0;
    const gid = c.glyphIds[gidIndex]!;
    return gid === 0 ? 0 : (gid + c.idDeltas[seg]! + 65536) & 0xffff;
  }

  /* ── glyph metrics ── */

  advanceWidth(gid: number): number {
    return this.advances[gid] ?? 0;
  }

  lsb(gid: number): number {
    return this.lsbs[gid] ?? 0;
  }

  /* ── glyf access ── */

  /** Raw bytes of one glyph (may be empty for .notdef / empty outlines). */
  glyphBytes(gid: number): Uint8Array {
    const start = this.locaOffsets[gid]!;
    const end = this.locaOffsets[gid + 1]!;
    if (end <= start) return new Uint8Array(0);
    return this.glyf.subarray(start + this.glyfPad, end);
  }

  /**
   * Composite glyph components with the byte position of each component's
   * glyphIndex field (inside glyphBytes(gid)) — the subsetter rewrites them.
   */
  compositeComponents(gid: number): CompositeComponent[] {
    const bytes = this.glyphBytes(gid);
    if (bytes.length < 10) return [];
    const contours = i16(bytes, 0);
    if (contours >= 0) return [];
    const out: CompositeComponent[] = [];
    let p = 10;
    for (;;) {
      if (p + 4 > bytes.length) break;
      const flags = u16(bytes, p);
      const compGid = u16(bytes, p + 2);
      out.push({ pos: p + 2, gid: compGid });
      p += 4;
      // argument treatment
      if (flags & 0x0001) {
        // ARG_1_AND_2_ARE_WORDS
        p += 4;
      } else {
        p += 2;
      }
      if (flags & 0x0008) p += 2; // WE_HAVE_A_SCALE
      else if (flags & 0x0040) p += 4; // X_AND_Y_SCALE
      else if (flags & 0x0080) p += 8; // X_AND_Y_MATRIX
      if (!(flags & 0x0020)) break; // MORE_COMPONENTS
    }
    return out;
  }
}

/* ─── name table → postscriptName ───────────────────────────────────────── */

function parsePostscriptName(name: Uint8Array | undefined): string {
  if (!name || name.length < 6) return "Font";
  const count = u16(name, 2);
  const stringOffset = u16(name, 4);
  let windows: string | null = null;
  let mac: string | null = null;
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12;
    if (rec + 12 > name.length) break;
    const platform = u16(name, rec);
    const encoding = u16(name, rec + 2);
    const language = u16(name, rec + 4);
    const nameId = u16(name, rec + 6);
    const length = u16(name, rec + 8);
    const offset = u16(name, rec + 10);
    if (nameId !== 6) continue;
    const start = stringOffset + offset;
    if (start + length > name.length) continue;
    const raw = name.subarray(start, start + length);
    if (platform === 3 && encoding === 1) {
      if (windows === null || language === 0x409) {
        windows = utf16be(raw);
      }
    } else if (platform === 1 && encoding === 0 && mac === null) {
      mac = latin1String(raw);
    }
  }
  const chosen = windows ?? mac ?? "Font";
  return chosen || "Font";
}

function utf16be(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i + 1 < b.length; i += 2) {
    out += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
  }
  return out;
}

function latin1String(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i++) out += String.fromCharCode(b[i]!);
  return out;
}

/* ─── GSUB / GDEF parsing ───────────────────────────────────────────────── */

function parseCoverage(b: Uint8Array, off: number): Coverage {
  const fmt = u16(b, off);
  if (fmt === 1) {
    const count = u16(b, off + 2);
    const glyphs = new Array<number>(count);
    for (let i = 0; i < count; i++) glyphs[i] = u16(b, off + 4 + i * 2);
    return { fmt: 1, glyphs };
  }
  if (fmt === 2) {
    const count = u16(b, off + 2);
    const ranges: CoverageRange[] = [];
    for (let i = 0; i < count; i++) {
      const p = off + 4 + i * 6;
      ranges.push({
        start: u16(b, p),
        end: u16(b, p + 2),
        index: u16(b, p + 4),
      });
    }
    return { fmt: 2, ranges };
  }
  throw new PdfError("chars", `coverage format ${fmt}`);
}

function parseClassDef(b: Uint8Array, off: number): ClassDef {
  const fmt = u16(b, off);
  if (fmt === 1) {
    const start = u16(b, off + 2);
    const count = u16(b, off + 4);
    const values = new Array<number>(count);
    for (let i = 0; i < count; i++) values[i] = u16(b, off + 6 + i * 2);
    return { fmt: 1, start, values };
  }
  if (fmt === 2) {
    const count = u16(b, off + 2);
    const ranges: ClassDefRange[] = [];
    for (let i = 0; i < count; i++) {
      const p = off + 4 + i * 6;
      ranges.push({ start: u16(b, p), end: u16(b, p + 2), cls: u16(b, p + 4) });
    }
    return { fmt: 2, ranges };
  }
  throw new PdfError("chars", `classdef format ${fmt}`);
}

function parseLookupRecords(b: Uint8Array, off: number, count: number): LookupRecordEntry[] {
  const out: LookupRecordEntry[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      sequenceIndex: u16(b, off + i * 4),
      lookupListIndex: u16(b, off + i * 4 + 2),
    });
  }
  return out;
}

function parseLookupSubtable(
  b: Uint8Array,
  off: number,
  type: number,
): LookupSubtable {
  const fmt = u16(b, off);
  switch (type) {
    case 1: {
      const cov = parseCoverage(b, off + u16(b, off + 2));
      if (fmt === 1) {
        return { kind: "single1", cov, delta: i16(b, off + 4) };
      }
      if (fmt === 2) {
        const count = u16(b, off + 4);
        const substitutes = new Array<number>(count);
        for (let i = 0; i < count; i++) substitutes[i] = u16(b, off + 6 + i * 2);
        return { kind: "single2", cov, substitutes };
      }
      break;
    }
    case 2: {
      const cov = parseCoverage(b, off + u16(b, off + 2));
      if (fmt === 1) {
        const count = u16(b, off + 4);
        const sequences: number[][] = [];
        for (let i = 0; i < count; i++) {
          const seqOff = off + u16(b, off + 6 + i * 2);
          const seqLen = u16(b, seqOff);
          const seq: number[] = [];
          for (let j = 0; j < seqLen; j++) seq.push(u16(b, seqOff + 2 + j * 2));
          sequences.push(seq);
        }
        return { kind: "multiple1", cov, sequences };
      }
      break;
    }
    case 4: {
      const cov = parseCoverage(b, off + u16(b, off + 2));
      if (fmt === 1) {
        const setCount = u16(b, off + 4);
        const sets: LigatureEntry[][] = [];
        for (let i = 0; i < setCount; i++) {
          const setOff = off + u16(b, off + 6 + i * 2);
          const ligCount = u16(b, setOff);
          const entries: LigatureEntry[] = [];
          for (let j = 0; j < ligCount; j++) {
            const ligOff = setOff + u16(b, setOff + 2 + j * 2);
            const ligGlyph = u16(b, ligOff);
            const compCount = u16(b, ligOff + 2);
            const components: number[] = [];
            for (let c = 1; c < compCount; c++) {
              components.push(u16(b, ligOff + 4 + (c - 1) * 2));
            }
            entries.push({ glyph: ligGlyph, components });
          }
          sets.push(entries);
        }
        return { kind: "ligature1", cov, sets };
      }
      break;
    }
    case 5: {
      if (fmt === 1) {
        const cov = parseCoverage(b, off + u16(b, off + 2));
        const setCount = u16(b, off + 4);
        const ruleSets: ContextRule[][] = [];
        for (let i = 0; i < setCount; i++) {
          const setOff = off + u16(b, off + 6 + i * 2);
          const ruleCount = u16(b, setOff);
          const rules: ContextRule[] = [];
          for (let j = 0; j < ruleCount; j++) {
            const ruleOff = setOff + u16(b, setOff + 2 + j * 2);
            const glyphCount = u16(b, ruleOff);
            const lookupCount = u16(b, ruleOff + 2);
            const input: number[] = [];
            for (let g = 1; g < glyphCount; g++) input.push(u16(b, ruleOff + 4 + (g - 1) * 2));
            rules.push({
              input,
              lookups: parseLookupRecords(b, ruleOff + 4 + (glyphCount - 1) * 2, lookupCount),
            });
          }
          ruleSets.push(rules);
        }
        return { kind: "context1", cov, ruleSets };
      }
      if (fmt === 2) {
        const cov = parseCoverage(b, off + u16(b, off + 2));
        const classDef = parseClassDef(b, off + u16(b, off + 4));
        const setCount = u16(b, off + 6);
        const classSets: (ClassRuleEntry[] | undefined)[] = [];
        for (let i = 0; i < setCount; i++) {
          const setOffRel = u16(b, off + 8 + i * 2);
          if (setOffRel === 0) {
            classSets.push(undefined);
            continue;
          }
          const setOff = off + setOffRel;
          const ruleCount = u16(b, setOff);
          const rules: ClassRuleEntry[] = [];
          for (let j = 0; j < ruleCount; j++) {
            const ruleOff = setOff + u16(b, setOff + 2 + j * 2);
            const glyphCount = u16(b, ruleOff);
            const lookupCount = u16(b, ruleOff + 2);
            const classes: number[] = [];
            for (let g = 1; g < glyphCount; g++) classes.push(u16(b, ruleOff + 4 + (g - 1) * 2));
            rules.push({
              classes,
              lookups: parseLookupRecords(b, ruleOff + 4 + (glyphCount - 1) * 2, lookupCount),
            });
          }
          classSets.push(rules);
        }
        return { kind: "context2", cov, classDef, classSets };
      }
      if (fmt === 3) {
        const glyphCount = u16(b, off + 2);
        const lookupCount = u16(b, off + 4);
        const coverages: Coverage[] = [];
        for (let g = 0; g < glyphCount; g++) {
          coverages.push(parseCoverage(b, off + u16(b, off + 6 + g * 2)));
        }
        return {
          kind: "context3",
          coverages,
          lookups: parseLookupRecords(b, off + 6 + glyphCount * 2, lookupCount),
        };
      }
      break;
    }
    case 6: {
      if (fmt === 1) {
        const cov = parseCoverage(b, off + u16(b, off + 2));
        const chainCount = u16(b, off + 4);
        const ruleSets: ChainRuleEntry[][] = [];
        for (let i = 0; i < chainCount; i++) {
          const setOff = off + u16(b, off + 6 + i * 2);
          const ruleCount = u16(b, setOff);
          const rules: ChainRuleEntry[] = [];
          for (let j = 0; j < ruleCount; j++) {
            const ruleOff = setOff + u16(b, setOff + 2 + j * 2);
            let p = ruleOff;
            const backtrackCount = u16(b, p);
            p += 2;
            const backtrack: number[] = [];
            for (let x = 0; x < backtrackCount; x++) backtrack.push(u16(b, p + x * 2));
            p += backtrackCount * 2;
            const inputCount = u16(b, p);
            p += 2;
            const input: number[] = [];
            for (let x = 1; x < inputCount; x++) input.push(u16(b, p + (x - 1) * 2));
            p += (inputCount - 1) * 2;
            const lookaheadCount = u16(b, p);
            p += 2;
            const lookahead: number[] = [];
            for (let x = 0; x < lookaheadCount; x++) lookahead.push(u16(b, p + x * 2));
            p += lookaheadCount * 2;
            const lookupCount = u16(b, p);
            p += 2;
            rules.push({ backtrack, input, lookahead, lookups: parseLookupRecords(b, p, lookupCount) });
          }
          ruleSets.push(rules);
        }
        return { kind: "chain1", cov, ruleSets };
      }
      if (fmt === 2) {
        const cov = parseCoverage(b, off + u16(b, off + 2));
        const backtrackClassDef = parseClassDef(b, off + u16(b, off + 4));
        const inputClassDef = parseClassDef(b, off + u16(b, off + 6));
        const lookaheadClassDef = parseClassDef(b, off + u16(b, off + 8));
        const chainCount = u16(b, off + 10);
        const classSets: (ChainClassRule[] | undefined)[] = [];
        for (let i = 0; i < chainCount; i++) {
          const setOffRel = u16(b, off + 12 + i * 2);
          if (setOffRel === 0) {
            classSets.push(undefined);
            continue;
          }
          const setOff = off + setOffRel;
          const ruleCount = u16(b, setOff);
          const rules: ChainClassRule[] = [];
          for (let j = 0; j < ruleCount; j++) {
            const ruleOff = setOff + u16(b, setOff + 2 + j * 2);
            let p = ruleOff;
            const backtrackCount = u16(b, p);
            p += 2;
            const backtrack: number[] = [];
            for (let x = 0; x < backtrackCount; x++) backtrack.push(u16(b, p + x * 2));
            p += backtrackCount * 2;
            const inputCount = u16(b, p);
            p += 2;
            const input: number[] = [];
            for (let x = 1; x < inputCount; x++) input.push(u16(b, p + (x - 1) * 2));
            p += (inputCount - 1) * 2;
            const lookaheadCount = u16(b, p);
            p += 2;
            const lookahead: number[] = [];
            for (let x = 0; x < lookaheadCount; x++) lookahead.push(u16(b, p + x * 2));
            p += lookaheadCount * 2;
            const lookupCount = u16(b, p);
            p += 2;
            rules.push({ backtrack, input, lookahead, lookups: parseLookupRecords(b, p, lookupCount) });
          }
          classSets.push(rules);
        }
        return { kind: "chain2", cov, backtrackClassDef, inputClassDef, lookaheadClassDef, classSets };
      }
      if (fmt === 3) {
        const backtrackCount = u16(b, off + 2);
        const backtrack: Coverage[] = [];
        let p = off + 4;
        for (let x = 0; x < backtrackCount; x++) {
          backtrack.push(parseCoverage(b, off + u16(b, p)));
          p += 2;
        }
        const inputCount = u16(b, p);
        p += 2;
        const input: Coverage[] = [];
        for (let x = 0; x < inputCount; x++) {
          input.push(parseCoverage(b, off + u16(b, p)));
          p += 2;
        }
        const lookaheadCount = u16(b, p);
        p += 2;
        const lookahead: Coverage[] = [];
        for (let x = 0; x < lookaheadCount; x++) {
          lookahead.push(parseCoverage(b, off + u16(b, p)));
          p += 2;
        }
        const lookupCount = u16(b, p);
        p += 2;
        return { kind: "chain3", backtrack, input, lookahead, lookups: parseLookupRecords(b, p, lookupCount) };
      }
      break;
    }
    default:
      break;
  }
  throw new PdfError("chars", `GSUB lookup type ${type} format ${fmt} unsupported`);
}

function parseGsub(b: Uint8Array | undefined): GsubTables | null {
  if (!b) return null;
  try {
    const scriptListOff = u16(b, 4);
    const featureListOff = u16(b, 6);
    const lookupListOff = u16(b, 8);

    const scripts = new Map<string, number[]>();
    const scriptCount = u16(b, scriptListOff);
    for (let i = 0; i < scriptCount; i++) {
      const rec = scriptListOff + 2 + i * 6;
      const tag = String.fromCharCode(b[rec]!, b[rec + 1]!, b[rec + 2]!, b[rec + 3]!);
      const scriptOff = scriptListOff + u16(b, rec + 4);
      const defaultLangSysOff = u16(b, scriptOff);
      if (defaultLangSysOff === 0) {
        scripts.set(tag, []);
        continue;
      }
      const langSys = scriptOff + defaultLangSysOff;
      const featureCount = u16(b, langSys + 4);
      const indexes: number[] = [];
      for (let f = 0; f < featureCount; f++) indexes.push(u16(b, langSys + 6 + f * 2));
      scripts.set(tag, indexes);
    }

    const featureCount = u16(b, featureListOff);
    const features: GsubFeature[] = [];
    for (let i = 0; i < featureCount; i++) {
      const rec = featureListOff + 2 + i * 6;
      const tag = String.fromCharCode(b[rec]!, b[rec + 1]!, b[rec + 2]!, b[rec + 3]!);
      const featureOff = featureListOff + u16(b, rec + 4);
      const lookupCount = u16(b, featureOff + 2);
      const lookupIndexes: number[] = [];
      for (let l = 0; l < lookupCount; l++) lookupIndexes.push(u16(b, featureOff + 4 + l * 2));
      features.push({ tag, lookupIndexes });
    }

    const lookupCount = u16(b, lookupListOff);
    const lookups: GsubLookup[] = [];
    for (let i = 0; i < lookupCount; i++) {
      const lo = lookupListOff + u16(b, lookupListOff + 2 + i * 2);
      const type = u16(b, lo);
      const flag = u16(b, lo + 2);
      const subCount = u16(b, lo + 4);
      const subtables: LookupSubtable[] = [];
      for (let s = 0; s < subCount; s++) {
        subtables.push(parseLookupSubtable(b, lo + u16(b, lo + 6 + s * 2), type));
      }
      lookups.push({ type, flag, subtables });
    }

    return { scripts, features, lookups };
  } catch (error) {
    if (error instanceof PdfError) throw error;
    throw new PdfError("chars", "GSUB parse failed");
  }
}

function parseGdef(b: Uint8Array | undefined): GdefTables | null {
  if (!b) return null;
  const version = u32(b, 0);
  if (version !== 0x00010000 && version !== 0x00010002 && version !== 0x00010003) return null;
  const out: GdefTables = {};
  const glyphClassOff = u16(b, 4);
  if (glyphClassOff !== 0) out.glyphClassDef = parseClassDef(b, glyphClassOff);
  // markAttachClassDef is at offset 10 (v1.0+) — after ligature/component classes
  if (version >= 0x00010000 && b.length >= 12) {
    const markAttachOff = u16(b, 10);
    if (markAttachOff !== 0) out.markAttachClassDef = parseClassDef(b, markAttachOff);
  }
  return out;
}

/* ─── subsetter ─────────────────────────────────────────────────────────── */

const SUBSET_TAGS = ["cvt ", "fpgm", "prep"] as const;

export class TtfSubsetter {
  private readonly glyphIds: number[] = [];
  private readonly mapping = new Map<number, number>();
  private readonly glyfBuffers: Uint8Array[] = [];
  private readonly hmtxOut: number[] = [];
  private offset = 0;

  constructor(private readonly font: ParsedTtfFont) {
    this.includeGlyph(0); // .notdef → subset id 0 (fontkit Subset parity)
  }

  /** Include a glyph (with composite closure); returns its subset id. */
  includeGlyph(gid: number): number {
    const known = this.mapping.get(gid);
    if (known !== undefined) return known;
    const id = this.glyphIds.length;
    this.glyphIds.push(gid);
    this.mapping.set(gid, id);

    const bytes = this.font.glyphBytes(gid);
    let buffer = new Uint8Array(bytes.length);
    buffer.set(bytes);
    const components = this.font.compositeComponents(gid);
    if (components.length > 0) {
      for (const component of components) {
        const newGid = this.includeGlyph(component.gid);
        buffer[component.pos] = newGid >> 8;
        buffer[component.pos + 1] = newGid & 0xff;
      }
    }
    this.glyfBuffers.push(buffer);
    this.hmtxOut.push(this.font.advanceWidth(gid), this.font.lsb(gid));
    this.offset += buffer.length;
    return id;
  }

  get size(): number {
    return this.glyphIds.length;
  }

  /**
   * Encode the subset font: head, hhea, loca, maxp, prep, glyf, hmtx
   * (+ cvt/fpgm when the source font has them) — the exact table set
   * fontkit's TTFSubset emits for a FontFile2. Proper table checksums and
   * head checkSumAdjustment included.
   */
  encode(): Uint8Array {
    const font = this.font;
    const glyphCount = this.glyphIds.length;

    // pad each glyph to 2 bytes for parity of loca semantics (odd-length
    // simple glyphs exist); fontkit concatenates raw but the 2-byte pad keeps
    // short loca valid without alignment tricks.
    const padded: Uint8Array[] = this.glyfBuffers.map((buf) => {
      if (buf.length % 2 === 0) return buf;
      const out = new Uint8Array(buf.length + 1);
      out.set(buf);
      return out;
    });
    let glyfLen = 0;
    for (const buf of padded) glyfLen += buf.length;

    // loca — short when the final offset fits u16 SHORT units (offset/2).
    const useShort = Math.ceil(glyfLen / 2) <= 0xffff;
    const loca = new Uint8Array((glyphCount + 1) * (useShort ? 2 : 4));
    let pos = 0;
    for (let i = 0; i <= glyphCount; i++) {
      if (useShort) {
        loca[i * 2] = pos >> 9;
        loca[i * 2 + 1] = (pos >> 1) & 0xff;
      } else {
        loca[i * 4] = (pos >>> 24) & 0xff;
        loca[i * 4 + 1] = (pos >>> 16) & 0xff;
        loca[i * 4 + 2] = (pos >>> 8) & 0xff;
        loca[i * 4 + 3] = pos & 0xff;
      }
      if (i < glyphCount) pos += padded[i]!.length;
    }

    const glyf = new Uint8Array(glyfLen);
    pos = 0;
    for (const buf of padded) {
      glyf.set(buf, pos);
      pos += buf.length;
    }

    const hmtx = new Uint8Array(glyphCount * 4);
    for (let i = 0; i < glyphCount; i++) {
      hmtx[i * 4] = this.hmtxOut[i * 2]! >> 8;
      hmtx[i * 4 + 1] = this.hmtxOut[i * 2]! & 0xff;
      hmtx[i * 4 + 2] = (this.hmtxOut[i * 2 + 1]! >> 8) & 0xff;
      hmtx[i * 4 + 3] = this.hmtxOut[i * 2 + 1]! & 0xff;
    }

    /* head — copied with indexToLocFormat + a zeroed checkSumAdjustment. */
    const head = new Uint8Array(54);
    head.set(font.table("head")!.subarray(0, 54));
    // checkSumAdjustment = 0 while checksumming
    for (let i = 8; i < 12; i++) head[i] = 0;
    head[50] = useShort ? 0 : 1;
    head[51] = 0;

    /* hhea — numberOfMetrics = glyphCount. */
    const hhea = new Uint8Array(36);
    hhea.set(font.table("hhea")!.subarray(0, 36));
    hhea[34] = glyphCount >> 8;
    hhea[35] = glyphCount & 0xff;

    /* maxp — numGlyphs = glyphCount. */
    const maxpSrc = font.table("maxp")!;
    const maxp = new Uint8Array(maxpSrc.length);
    maxp.set(maxpSrc);
    maxp[4] = glyphCount >> 8;
    maxp[5] = glyphCount & 0xff;

    const tables: Array<[string, Uint8Array]> = [
      ["head", head],
      ["hhea", hhea],
      ["loca", loca],
      ["maxp", maxp],
      ["prep", font.table("prep") ?? new Uint8Array(0)],
      ["glyf", glyf],
      ["hmtx", hmtx],
    ];
    for (const tag of SUBSET_TAGS) {
      const t = font.table(tag);
      if (t && t.length > 0) tables.push([tag, t]);
    }
    // drop empty prep to keep the directory minimal (parity: fontkit writes
    // undefined tables as nothing)
    const finalTables = tables.filter(([, t]) => t.length > 0);
    finalTables.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    const entrySelector = Math.floor(Math.log2(finalTables.length));
    const searchRange = 2 ** entrySelector * 16;
    const rangeShift = finalTables.length * 16 - searchRange;

    let dirLen = 12 + finalTables.length * 16;
    let bodyLen = 0;
    for (const [, t] of finalTables) bodyLen += (t.length + 3) & ~3;
    const out = new Uint8Array(dirLen + bodyLen);
    const dv = new DataView(out.buffer);

    // sfnt directory
    dv.setUint32(0, 0x00010000);
    dv.setUint16(4, finalTables.length);
    dv.setUint16(6, searchRange);
    dv.setUint16(8, entrySelector);
    dv.setUint16(10, rangeShift);

    let bodyPos = dirLen;
    for (let i = 0; i < finalTables.length; i++) {
      const [tag, data] = finalTables[i]!;
      const paddedLen = (data.length + 3) & ~3;
      const rec = 12 + i * 16;
      out[rec] = tag.charCodeAt(0);
      out[rec + 1] = tag.charCodeAt(1);
      out[rec + 2] = tag.charCodeAt(2);
      out[rec + 3] = tag.charCodeAt(3);
      dv.setUint32(rec + 4, tableChecksum(data, tag === "head"));
      dv.setUint32(rec + 8, bodyPos);
      dv.setUint32(rec + 12, data.length);
      out.set(data, bodyPos);
      bodyPos += paddedLen;
    }

    // head checkSumAdjustment = 0xB1B0AFBA − checksum(whole file)
    const total = fileChecksum(out);
    const adjustment = (0xb11b0afba - total) >>> 0;
    for (let i = 0; i < finalTables.length; i++) {
      const rec = 12 + i * 16;
      if (
        out[rec] === 0x68 && out[rec + 1] === 0x65 &&
        out[rec + 2] === 0x61 && out[rec + 3] === 0x64
      ) {
        const off = dv.getUint32(rec + 8);
        dv.setUint32(off + 8, adjustment);
      }
    }

    return out;
  }
}

/** Table checksum: sum of big-endian u32s over the 4-byte-padded data. */
function tableChecksum(data: Uint8Array, isHead: boolean): number {
  let sum = 0;
  const padded = (data.length + 3) & ~3;
  for (let i = 0; i < padded; i += 4) {
    const b0 = isHead && i === 8 ? 0 : (data[i] ?? 0);
    const b1 = isHead && i === 8 ? 0 : (data[i + 1] ?? 0);
    const b2 = isHead && i === 8 ? 0 : (data[i + 2] ?? 0);
    const b3 = isHead && i === 8 ? 0 : (data[i + 3] ?? 0);
    sum = (sum + (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

function fileChecksum(data: Uint8Array): number {
  let sum = 0;
  const padded = (data.length + 3) & ~3;
  for (let i = 0; i < padded; i += 4) {
    const w =
      ((data[i] ?? 0) << 24) |
      ((data[i + 1] ?? 0) << 16) |
      ((data[i + 2] ?? 0) << 8) |
      (data[i + 3] ?? 0);
    sum = (sum + (w >>> 0)) >>> 0;
  }
  return sum >>> 0;
}
