import {
  decodeStreamBytes,
  latin1,
  pdfNumToString,
  ParsedTtfFont,
  type ParsedPdf,
  type PdfObj,
  type PdfPageInfo,
  resolve,
} from "@/lib/own/pdf";
import {
  formStreams,
  hasInlineImages,
  pageContentStreams,
  tokenizeContent,
} from "../text-color/engine";
import { glyphContours, glyphToPathOps } from "./glyf";
import { zlibSync } from "@/lib/own/zip";

/**
 * Font to outline (PHASE-7): convert text drawn with an embedded
 * TrueType font into pure vector BEZIER PATHS — the "curves" print
 * shops ask for. The words stop being text (nothing to select, copy or
 * re-flow); the drawing keeps every stroke of the original.
 *
 * Honest scope (the modern mainstream): Type0 /CIDFontType2 fonts with
 * /Identity-H encoding and /CIDToGIDMap /Identity — what Chrome, Word,
 * LibreOffice and OUR OWN CreateContext embed. Anything else (Type1,
 * CFF, non-embedded, Type3, other CMaps) is counted and left as text —
 * reported, never guessed.
 *
 * Content surgery (position-preserving tokenizer, the text-color
 * pattern): q/Q/cm CTM stack + full text state (Tm/Tlm/Tfs/Tz/Tc/Tw/
 * TL/Ts) tracked; Tj/TJ/'/" ops of convertible fonts are replaced by
 * absolute-coordinate path ops. Non-convertible text ops stay.
 */

type M = [number, number, number, number, number, number];

const IDENT: M = [1, 0, 0, 1, 0, 0];

function mMul(m: M, n: M): M {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function mApply(m: M, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const translate = (tx: number, ty: number): M => [1, 0, 0, 1, tx, ty];

/* ------------------------------------------------------------------ */
/* String operand decoding                                             */
/* ------------------------------------------------------------------ */

/** A PDF string operand token (`(…)` literal or `<…>` hex) → raw bytes. */
export function decodeStringOperand(text: string): Uint8Array | null {
  if (text.startsWith("<")) {
    const hex = text.slice(1, text.lastIndexOf(">")).replace(/[^0-9a-fA-F]/g, "");
    const padded = hex.length % 2 === 0 ? hex : hex + "0";
    const out = new Uint8Array(padded.length / 2);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  if (text.startsWith("(")) {
    const inner = text.slice(1, text.length - 1);
    const out: number[] = [];
    for (let i = 0; i < inner.length; i += 1) {
      const c = inner[i]!;
      if (c === "\\") {
        const d = inner[i + 1] ?? "";
        if (d >= "0" && d <= "7") {
          let oct = d;
          while (
            oct.length < 3 &&
            (inner[i + 1 + oct.length] ?? "") >= "0" &&
            (inner[i + 1 + oct.length] ?? "") <= "7"
          ) {
            oct += inner[i + 1 + oct.length]!;
          }
          out.push(Number.parseInt(oct, 8) & 0xff);
          i += oct.length;
          continue;
        }
        if (d === "n") out.push(10);
        else if (d === "r") out.push(13);
        else if (d === "t") out.push(9);
        else if (d === "b") out.push(8);
        else if (d === "f") out.push(12);
        else if (d === "\n") {
          // line continuation — nothing
        } else out.push(d.charCodeAt(0) & 0xff);
        i += 1;
        continue;
      }
      out.push(c.charCodeAt(0) & 0xff);
    }
    return new Uint8Array(out);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Font resolution (Type0 / Identity-H / CIDFontType2 / FontFile2)      */
/* ------------------------------------------------------------------ */

export interface OutlineFont {
  font: ParsedTtfFont;
  /** CID → advance width in 1000-unit glyph space. */
  widths: Map<number, number>;
  dw: number;
}

/** CIDFont /W array + /DW default → width map (1000-basis). */
function cidWidths(cidDict: Map<string, PdfObj>, doc: ParsedPdf): {
  widths: Map<number, number>;
  dw: number;
} {
  const widths = new Map<number, number>();
  let dw = 1000;
  const dwObj = resolve(doc, cidDict.get("DW"));
  if (dwObj?.k === "num") dw = dwObj.n;
  const wObj = resolve(doc, cidDict.get("W"));
  if (wObj?.k === "arr") {
    const items = wObj.items;
    let i = 0;
    while (i < items.length) {
      const head = resolve(doc, items[i]!);
      if (head?.k === "num") {
        const arr = resolve(doc, items[i + 1] ?? items[i]!);
        if (arr?.k === "arr") {
          // c [w1 w2 …] — consecutive CIDs.
          arr.items.forEach((wv, k) => {
            const w = resolve(doc, wv);
            if (w?.k === "num") widths.set(head.n + k, w.n);
          });
          i += 2;
        } else {
          // cfirst clast w — range.
          const last = resolve(doc, items[i + 1]!);
          const w = resolve(doc, items[i + 2]!);
          if (last?.k === "num" && w?.k === "num") {
            for (let c = head.n; c <= last.n; c += 1) widths.set(c, w.n);
          }
          i += 3;
        }
      } else {
        i += 1;
      }
    }
  }
  return { widths, dw };
}

/**
 * Classify one font object. Returns the outline source when the font is
 * a Type0/CIDFontType2 with Identity-H + Identity CIDToGIDMap and an
 * embedded TrueType program; null otherwise (counted as unsupported).
 */
export function resolveOutlineFont(
  doc: ParsedPdf,
  fontObj: PdfObj | undefined
): OutlineFont | null {
  const font = fontObj ? resolve(doc, fontObj) : undefined;
  if (!font || (font.k !== "dict" && font.k !== "stream")) return null;
  const m = font.m as Map<string, PdfObj>;

  const subtype = resolve(doc, m.get("Subtype"));
  if (subtype?.k !== "name" || subtype.v !== "Type0") return null;

  const encoding = resolve(doc, m.get("Encoding"));
  if (encoding?.k !== "name" || encoding.v !== "Identity-H") return null;

  const descendants = resolve(doc, m.get("DescendantFonts"));
  if (descendants?.k !== "arr" || descendants.items.length === 0) return null;
  const cidObj = resolve(doc, descendants.items[0]!);
  if (!cidObj || (cidObj.k !== "dict" && cidObj.k !== "stream")) return null;
  const cidDict = cidObj.m as Map<string, PdfObj>;

  const cidSub = resolve(doc, cidDict.get("Subtype"));
  if (cidSub?.k !== "name" || cidSub.v !== "CIDFontType2") return null;

  const gidMap = resolve(doc, cidDict.get("CIDToGIDMap"));
  if (gidMap?.k !== "name" || gidMap.v !== "Identity") return null;

  const fdObj = resolve(doc, cidDict.get("FontDescriptor"));
  if (!fdObj || (fdObj.k !== "dict" && fdObj.k !== "stream")) return null;
  const fdDict = fdObj.m as Map<string, PdfObj>;
  const fileObj = resolve(doc, fdDict.get("FontFile2"));
  if (!fileObj || fileObj.k !== "stream") return null;

  let ttf: ParsedTtfFont;
  try {
    // FontFile2 carries a (usually Flate) compressed font program.
    const fontBytes = decodeStreamBytes(
      fileObj.raw,
      fileObj.m as Map<string, PdfObj>
    );
    ttf = ParsedTtfFont.parse(fontBytes);
  } catch {
    return null;
  }
  const { widths, dw } = cidWidths(cidDict, doc);
  return { font: ttf, widths, dw };
}

/** Resource name → convertible font for one resource dict. */
export function outlineFontsByResourceName(
  doc: ParsedPdf,
  resources: PdfObj | undefined
): Map<string, OutlineFont> {
  const out = new Map<string, OutlineFont>();
  const res = resources ? resolve(doc, resources) : undefined;
  if (!res || (res.k !== "dict" && res.k !== "stream")) return out;
  const fonts = resolve(doc, (res.m as Map<string, PdfObj>).get("Font"));
  if (!fonts || fonts.k !== "dict") return out;
  for (const [name, ref] of fonts.m) {
    const resolvedFont = resolveOutlineFont(doc, ref);
    if (resolvedFont) out.set(name, resolvedFont);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Content-stream surgery (text state machine)                         */
/* ------------------------------------------------------------------ */

export interface OutlineStats {
  /** Text-show ops converted to paths. */
  showsConverted: number;
  /** Text-show ops left as text (unsupported font). */
  showsSkipped: number;
  glyphPaths: number;
}

interface TextState {
  tfs: number;
  tz: number;
  tc: number;
  tw: number;
  tl: number;
  ts: number;
  fontName: string | null;
}

/** One show-op's operand tokens (strings + numbers, TJ-aware). */
interface ShowOperand {
  kind: "str" | "num";
  text: string;
  value: number;
}

function collectShowOperands(
  src: string,
  toks: { start: number; end: number; type: string }[],
  from: number,
  to: number
): ShowOperand[] {
  const out: ShowOperand[] = [];
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (t.start < from || t.start >= to) continue;
    if (t.type === "str") {
      out.push({ kind: "str", text: src.slice(t.start, t.end), value: 0 });
    } else if (t.type === "num") {
      const v = Number(src.slice(t.start, t.end));
      if (Number.isFinite(v)) out.push({ kind: "num", text: "", value: v });
    }
  }
  return out;
}

/** Convert one show op's operands to path ops. Mutates tm (advances). */
function convertShow(
  operands: ShowOperand[],
  st: TextState,
  tm: M,
  ctm: M,
  of: OutlineFont
): { ops: string; tmOut: M; glyphs: number } {
  const parts: string[] = [];
  let glyphs = 0;
  let m: M = tm;

  const upem = of.font.unitsPerEm;
  // text-space local matrix [Tfs·Th 0 0 Tfs 0 Ts]
  const local: M = [
    st.tfs * (st.tz / 100),
    0,
    0,
    st.tfs,
    0,
    st.ts,
  ];

  const drawGlyph = (cid: number): void => {
    const w0 = of.widths.get(cid) ?? of.dw;
    // Combined transform: glyph units → page.
    const combined = mMul(mMul(local, m), ctm);
    const contours = glyphContours(of.font, cid);
    if (contours.length > 0) {
      const path = glyphToPathOps(contours, (gx, gy) => {
        const p = mApply(combined, gx / upem, gy / upem);
        return [pdfNumToString(p[0]), pdfNumToString(p[1])];
      });
      if (path.length > 0) {
        parts.push(path);
        glyphs += 1;
      }
    }
    const tx = ((w0 / 1000) * st.tfs + st.tc) * (st.tz / 100);
    m = mMul(translate(tx, 0), m);
  };

  for (const op of operands) {
    if (op.kind === "num") {
      // TJ adjustment: −n/1000 em, scaled by Th.
      const tx = (-(op.value / 1000) * st.tfs) * (st.tz / 100);
      m = mMul(translate(tx, 0), m);
      continue;
    }
    const bytes = decodeStringOperand(op.text);
    if (!bytes) continue;
    for (let b = 0; b + 1 < bytes.length; b += 2) {
      drawGlyph(((bytes[b]! << 8) | bytes[b + 1]!) >>> 0);
    }
  }

  return { ops: parts.join("\n"), tmOut: m, glyphs };
}

/**
 * The stream surgery: converts every show op that uses a convertible
 * font into path ops; everything else (including unsupported-font text)
 * is copied byte-for-byte.
 */
export function outlineContent(
  src: string,
  fonts: Map<string, OutlineFont>
): { out: string; stats: OutlineStats } {
  const toks = tokenizeContent(src);
  const stats: OutlineStats = {
    showsConverted: 0,
    showsSkipped: 0,
    glyphPaths: 0,
  };

  const st: TextState = {
    tfs: 0,
    tz: 100,
    tc: 0,
    tw: 0,
    tl: 0,
    ts: 0,
    fontName: null,
  };

  let out = "";
  let pos = 0;
  let inText = false;
  let lastOpEnd = 0;
  let tm: M = IDENT;
  let tlm: M = IDENT;
  let ctm: M = IDENT;
  const ctmStack: M[] = [];

  const emit = (end: number): void => {
    out += src.slice(pos, end);
    pos = end;
  };

  const nums = (from: number, to: number): number[] =>
    collectShowOperands(src, toks, from, to)
      .filter((o) => o.kind === "num")
      .map((o) => o.value);

  for (const tok of toks) {
    if (tok.type !== "op") continue;
    const op = tok.op!;
    const operandStart = lastOpEnd;
    switch (op) {
      case "q":
        ctmStack.push(ctm);
        emit(tok.end);
        break;
      case "Q":
        ctm = ctmStack.pop() ?? IDENT;
        emit(tok.end);
        break;
      case "cm": {
        const a = nums(operandStart, tok.start);
        if (a.length === 6) {
          ctm = mMul(
            [a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!],
            ctm
          );
        }
        emit(tok.end);
        break;
      }
      case "BT":
        tm = IDENT;
        tlm = IDENT;
        inText = true;
        emit(tok.end);
        break;
      case "ET":
        inText = false;
        emit(tok.end);
        break;
      case "Tf": {
        const nameTok = toks.find(
          (t) => t.start >= operandStart && t.start < tok.start && t.type === "name"
        );
        if (nameTok) st.fontName = src.slice(nameTok.start + 1, nameTok.end);
        const size = nums(operandStart, tok.start);
        if (size.length >= 1) st.tfs = size[0]!;
        emit(tok.end);
        break;
      }
      case "Tm": {
        const a = nums(operandStart, tok.start);
        if (a.length === 6) {
          tm = [a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!];
          tlm = tm;
        }
        emit(tok.end);
        break;
      }
      case "Td": {
        const a = nums(operandStart, tok.start);
        if (a.length === 2) {
          tlm = mMul(translate(a[0]!, a[1]!), tlm);
          tm = tlm;
        }
        emit(tok.end);
        break;
      }
      case "TD": {
        const a = nums(operandStart, tok.start);
        if (a.length === 2) {
          st.tl = -a[1]!;
          tlm = mMul(translate(a[0]!, a[1]!), tlm);
          tm = tlm;
        }
        emit(tok.end);
        break;
      }
      case "TL": {
        const a = nums(operandStart, tok.start);
        if (a.length >= 1) st.tl = a[0]!;
        emit(tok.end);
        break;
      }
      case "Tc": {
        const a = nums(operandStart, tok.start);
        if (a.length >= 1) st.tc = a[0]!;
        emit(tok.end);
        break;
      }
      case "Tw": {
        const a = nums(operandStart, tok.start);
        if (a.length >= 1) st.tw = a[0]!;
        emit(tok.end);
        break;
      }
      case "Tz": {
        const a = nums(operandStart, tok.start);
        if (a.length >= 1) st.tz = a[0]!;
        emit(tok.end);
        break;
      }
      case "Ts": {
        const a = nums(operandStart, tok.start);
        if (a.length >= 1) st.ts = a[0]!;
        emit(tok.end);
        break;
      }
      case "T*":
        tm = mMul(translate(0, -st.tl), tlm);
        emit(tok.end);
        break;
      case "Tj":
      case "TJ": {
        const of = inText && st.fontName ? fonts.get(st.fontName) : undefined;
        if (of) {
          const operands = collectShowOperands(src, toks, operandStart, tok.start);
          const converted = convertShow(operands, st, tm, ctm, of);
          tm = converted.tmOut;
          emit(operandStart);
          if (converted.ops.length > 0) {
            out += `\n${converted.ops}\n`;
          }
          pos = tok.end;
          stats.showsConverted += 1;
          stats.glyphPaths += converted.glyphs;
        } else {
          if (inText) stats.showsSkipped += 1;
          emit(tok.end);
        }
        break;
      }
      case "'": {
        // Next line, then show.
        tm = mMul(translate(0, -st.tl), tlm);
        const of = inText && st.fontName ? fonts.get(st.fontName) : undefined;
        if (of) {
          const operands = collectShowOperands(src, toks, operandStart, tok.start);
          const converted = convertShow(operands, st, tm, ctm, of);
          tm = converted.tmOut;
          emit(operandStart);
          if (converted.ops.length > 0) out += `\n${converted.ops}\n`;
          pos = tok.end;
          stats.showsConverted += 1;
          stats.glyphPaths += converted.glyphs;
        } else {
          if (inText) stats.showsSkipped += 1;
          emit(tok.end);
        }
        break;
      }
      case '"': {
        // aw ac string " — set Tw, Tc, then '.
        const a = nums(operandStart, tok.start);
        if (a.length >= 2) {
          st.tw = a[0]!;
          st.tc = a[1]!;
        }
        tm = mMul(translate(0, -st.tl), tlm);
        const of = inText && st.fontName ? fonts.get(st.fontName) : undefined;
        if (of) {
          const operands = collectShowOperands(src, toks, operandStart, tok.start)
            .filter((o) => o.kind === "str");
          const converted = convertShow(operands, st, tm, ctm, of);
          tm = converted.tmOut;
          emit(operandStart);
          if (converted.ops.length > 0) out += `\n${converted.ops}\n`;
          pos = tok.end;
          stats.showsConverted += 1;
          stats.glyphPaths += converted.glyphs;
        } else {
          if (inText) stats.showsSkipped += 1;
          emit(tok.end);
        }
        break;
      }
      default:
        emit(tok.end);
        break;
    }
    lastOpEnd = tok.end;
  }
  emit(src.length);
  return { out, stats };
}

/* ------------------------------------------------------------------ */
/* Document plan                                                       */
/* ------------------------------------------------------------------ */

export interface FontOutlinePlan {
  replacements: Map<number, PdfObj>;
  stats: OutlineStats & { streamsRewritten: number; streamsSkipped: number };
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Pages + their Form XObjects (recursive, cycle-safe): each stream's
 * convertible text becomes paths; the re-flated stream replaces the
 * original object. Streams that only hold unsupported text are left
 * untouched (byte-identical).
 */
export function planFontToOutline(
  doc: ParsedPdf,
  pages: readonly PdfPageInfo[]
): FontOutlinePlan {
  const replacements = new Map<number, PdfObj>();
  const stats = {
    showsConverted: 0,
    showsSkipped: 0,
    glyphPaths: 0,
    streamsRewritten: 0,
    streamsSkipped: 0,
  };

  const rewriteStream = (
    num: number,
    obj: PdfObj & { k: "stream" },
    resources: PdfObj | undefined,
    seen: Set<number>
  ): void => {
    if (seen.has(num)) return;
    seen.add(num);
    const fonts = outlineFontsByResourceName(doc, resources);
    if (fonts.size === 0) return; // nothing convertible here — leave bytes alone

    let content: string;
    try {
      const decoded = decodeStreamBytesSafe(obj);
      content = decoded;
    } catch {
      stats.streamsSkipped += 1;
      return;
    }
    if (hasInlineImages(content)) {
      stats.streamsSkipped += 1;
      return;
    }
    const { out, stats: s } = outlineContent(content, fonts);
    if (s.showsConverted === 0) return; // untouched — keep original bytes

    stats.showsConverted += s.showsConverted;
    stats.showsSkipped += s.showsSkipped;
    stats.glyphPaths += s.glyphPaths;

    const m = new Map<string, PdfObj>();
    for (const [key, value] of obj.m) {
      if (key === "Filter" || key === "Length" || key === "DecodeParms") {
        continue;
      }
      m.set(key, value);
    }
    m.set("Filter", { k: "name", v: "FlateDecode" });
    replacements.set(num, {
      k: "stream",
      m,
      raw: zlibSync(latin1Bytes(out)),
    });
    stats.streamsRewritten += 1;
  };

  const seen = new Set<number>();
  const walkForms = (
    entries: Array<{ num: number; obj: PdfObj & { k: "stream" } }>,
    seen: Set<number>
  ): void => {
    for (const entry of entries) {
      if (seen.has(entry.num)) continue;
      const res = entry.obj.m.get("Resources");
      rewriteStream(entry.num, entry.obj, res, seen);
      walkForms(formStreams(doc, res), seen);
    }
  };

  for (const page of pages) {
    const res = page.resources;
    for (const stream of pageContentStreams(doc, page)) {
      rewriteStream(stream.num, stream.obj, res, seen);
    }
    walkForms(formStreams(doc, res), seen);
  }

  return { replacements, stats };
}

function decodeStreamBytesSafe(obj: PdfObj & { k: "stream" }): string {
  const decoded = decodeStreamBytes(obj.raw, obj.m);
  return latin1(decoded, 0, decoded.length);
}
