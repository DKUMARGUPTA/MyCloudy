import {
  latin1,
  pdfNumToString,
  type ParsedPdf,
  type PdfObj,
  type PdfPageInfo,
  resolve,
  decodeStreamBytes,
} from "@/lib/own/pdf";
import { parseHexColor } from "../add-watermark/wm-options";
import { zlibSync } from "@/lib/own/zip";

/**
 * Text color (PHASE-7): recolor the text that is already inside a PDF —
 * content-stream surgery on OUR OWN engine, vectors only.
 *
 * Strategy per stream (page /Contents + Form XObjects, recursively):
 *   - INSERT `{r g b} rg` right after every `BT` (overrides any colour
 *     the page state carried INTO the text object);
 *   - REPLACE every in-text fill op (`rg g k sc scn`) and stroke op
 *     (`RG G K SC SCN`) with the target colour — so mid-block colour
 *     switches land on the new colour too;
 *   - re-insert after every in-text `Q` (a q/Q pair can restore the old
 *     colour state);
 *   - everything OUTSIDE text objects is copied byte-for-byte
 *     (position-preserving tokenizer — comments and spacing survive).
 *
 * Honest limits (FAQ): pattern colour spaces become solid colour; text
 * inside annotations or Type3 charprocs is not touched; streams with
 * inline images (BI…EI binary) are skipped, not guessed.
 */

export const TC_IDS = {
  color: "color",
  pages: "pages",
} as const;

export const TC_DEFAULT_COLOR = "#DC2626";

export interface TcOptions {
  color: string;
  pages: string;
}

export function resolveTextColorOptions(
  values: Record<string, unknown>
): TcOptions {
  const colorRaw =
    typeof values[TC_IDS.color] === "string"
      ? String(values[TC_IDS.color])
      : TC_DEFAULT_COLOR;
  const color = parseHexColor(colorRaw) === null ? TC_DEFAULT_COLOR : colorRaw;
  const pagesRaw = values[TC_IDS.pages];
  const pages =
    typeof pagesRaw === "string" && pagesRaw.trim().length > 0
      ? pagesRaw.trim()
      : "all";
  return { color, pages };
}

/* ------------------------------------------------------------------ */
/* Content-stream tokenizer (position preserving)                      */
/* ------------------------------------------------------------------ */

export type TokType = "num" | "name" | "str" | "op" | "delim";

export interface ContentTok {
  start: number;
  end: number;
  type: TokType;
  /** Operator text when type === "op". */
  op: string | null;
}

const WS = " \n\r\t\f\v\0";

function isDelim(c: string): boolean {
  return "()<>[]{}/%".includes(c);
}

/**
 * Tokenize a content stream, KEEPING every source byte addressable via
 * [start, end) spans (whitespace and comments live in the gaps).
 */
export function tokenizeContent(src: string): ContentTok[] {
  const toks: ContentTok[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (WS.includes(c)) {
      i += 1;
      continue;
    }
    if (c === "%") {
      while (i < n && src[i] !== "\n" && src[i] !== "\r") i += 1;
      continue;
    }
    if (c === "(") {
      const start = i;
      i += 1;
      let depth = 1;
      while (i < n && depth > 0) {
        const d = src[i]!;
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (d === "(") depth += 1;
        else if (d === ")") depth -= 1;
        i += 1;
      }
      toks.push({ start, end: i, type: "str", op: null });
      continue;
    }
    if (c === "<") {
      const start = i;
      if (src[i + 1] === "<") {
        i += 2;
        toks.push({ start, end: i, type: "delim", op: null });
        continue;
      }
      while (i < n && src[i] !== ">") i += 1;
      i += 1;
      toks.push({ start, end: i, type: "str", op: null });
      continue;
    }
    if (c === ">" && src[i + 1] === ">") {
      toks.push({ start: i, end: i + 2, type: "delim", op: null });
      i += 2;
      continue;
    }
    if (c === "[" || c === "]") {
      toks.push({ start: i, end: i + 1, type: "delim", op: null });
      i += 1;
      continue;
    }
    if (c === "/") {
      const start = i;
      i += 1;
      while (i < n && !WS.includes(src[i]!) && !isDelim(src[i]!)) i += 1;
      toks.push({ start, end: i, type: "name", op: null });
      continue;
    }
    if (/[0-9+\-.]/.test(c)) {
      const start = i;
      while (i < n && /[0-9+\-.]/.test(src[i]!)) i += 1;
      toks.push({ start, end: i, type: "num", op: null });
      continue;
    }
    // Operator run (letters, *, ', ").
    const start = i;
    while (i < n && !WS.includes(src[i]!) && !isDelim(src[i]!)) i += 1;
    if (i === start) i += 1; // unknown lone byte — never loop
    toks.push({ start, end: i, type: "op", op: src.slice(start, i) });
  }
  return toks;
}

/* ------------------------------------------------------------------ */
/* Recolor one decoded content stream                                  */
/* ------------------------------------------------------------------ */

const FILL_OPS = new Set(["rg", "g", "k", "sc", "scn"]);
const STROKE_OPS = new Set(["RG", "G", "K", "SC", "SCN"]);

export interface RecolorStats {
  textObjects: number;
  fillReplaced: number;
  strokeReplaced: number;
}

export function recolorContent(
  src: string,
  rgb: readonly [number, number, number]
): { out: string; stats: RecolorStats } {
  const rgbText = rgb.map((v) => pdfNumToString(v)).join(" ");
  const toks = tokenizeContent(src);
  const stats: RecolorStats = {
    textObjects: 0,
    fillReplaced: 0,
    strokeReplaced: 0,
  };

  let out = "";
  let pos = 0;
  let inText = false;
  /** End of the last operator seen — operands of the current op start here. */
  let lastOpEnd = 0;

  const emit = (end: number): void => {
    out += src.slice(pos, end);
    pos = end;
  };

  for (const tok of toks) {
    if (tok.type !== "op") continue;
    const op = tok.op!;
    if (op === "BT") {
      emit(tok.end);
      out += `\n${rgbText} rg`;
      inText = true;
      stats.textObjects += 1;
    } else if (op === "ET") {
      emit(tok.end);
      inText = false;
    } else if (inText && FILL_OPS.has(op)) {
      // Skip this op's operands + operator; insert the target colour
      // (leading space — the skipped operand span may have eaten the
      // separator that followed the previous operator).
      emit(lastOpEnd);
      out += ` ${rgbText} rg`;
      pos = tok.end;
      stats.fillReplaced += 1;
    } else if (inText && STROKE_OPS.has(op)) {
      emit(lastOpEnd);
      out += ` ${rgbText} RG`;
      pos = tok.end;
      stats.strokeReplaced += 1;
    } else if (inText && op === "Q") {
      // A restored graphics state may bring the old colour back.
      emit(tok.end);
      out += `\n${rgbText} rg`;
    } else {
      emit(tok.end);
    }
    lastOpEnd = tok.end;
  }
  emit(src.length);
  return { out, stats };
}

/** True when the stream carries inline images (BI…EI) — binary we refuse to guess. */
export function hasInlineImages(src: string): boolean {
  for (const tok of tokenizeContent(src)) {
    if (tok.type === "op" && tok.op === "BI") return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Document plan: pages + Form XObjects → stream replacements          */
/* ------------------------------------------------------------------ */

export interface TextColorPlan {
  replacements: Map<number, PdfObj>;
  stats: RecolorStats & { streamsRecolored: number; streamsSkipped: number };
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** All /Contents stream objects of a page (refs resolved; direct streams skipped). */
function pageContentStreams(
  doc: ParsedPdf,
  page: PdfPageInfo
): Array<{ num: number; obj: PdfObj & { k: "stream" } }> {
  const out: Array<{ num: number; obj: PdfObj & { k: "stream" } }> = [];
  const contents = page.dict.get("Contents");
  if (!contents) return out;
  const direct = resolve(doc, contents);
  if (direct?.k === "arr") {
    for (const item of direct.items) {
      if (item.k !== "ref") continue;
      const obj = doc.getObject(item.num);
      if (obj?.k === "stream") out.push({ num: item.num, obj });
    }
    return out;
  }
  // Single stream: only replaceable when it sits behind a ref.
  if (contents.k === "ref") {
    const obj = doc.getObject(contents.num);
    if (obj?.k === "stream") out.push({ num: contents.num, obj });
  }
  return out;
}

/** Form XObjects reachable from a resource dict (direct objects only here). */
function formStreams(
  doc: ParsedPdf,
  resources: PdfObj | undefined
): Array<{ num: number; obj: PdfObj & { k: "stream" } }> {
  const out: Array<{ num: number; obj: PdfObj & { k: "stream" } }> = [];
  const res = resources ? resolve(doc, resources) : undefined;
  if (!res || (res.k !== "dict" && res.k !== "stream")) return out;
  const xo = resolve(doc, (res.m as Map<string, PdfObj>).get("XObject"));
  if (!xo || xo.k !== "dict") return out;
  for (const value of xo.m.values()) {
    if (value.k !== "ref") continue;
    const obj = doc.getObject(value.num);
    if (obj?.k !== "stream") continue;
    const subtype = resolve(doc, obj.m.get("Subtype"));
    if (subtype?.k === "name" && subtype.v === "Form") {
      out.push({ num: value.num, obj });
    }
  }
  return out;
}

/**
 * Build the replacement set: every selected page's content streams plus
 * every Form XObject they reference (recursively, cycle-safe), each
 * recoloured and re-flated. Shared forms are processed once.
 */
export function planTextColor(
  doc: ParsedPdf,
  pages: readonly PdfPageInfo[],
  rgb: readonly [number, number, number]
): TextColorPlan {
  const replacements = new Map<number, PdfObj>();
  const stats = {
    textObjects: 0,
    fillReplaced: 0,
    strokeReplaced: 0,
    streamsRecolored: 0,
    streamsSkipped: 0,
  };

  const recolorStream = (
    num: number,
    obj: PdfObj & { k: "stream" },
    seen: Set<number>
  ): void => {
    if (seen.has(num)) return;
    seen.add(num);
    let content: string;
    try {
      const decoded = decodeStreamBytes(obj.raw, obj.m);
      content = latin1(decoded, 0, decoded.length);
    } catch {
      stats.streamsSkipped += 1;
      return;
    }
    if (hasInlineImages(content)) {
      stats.streamsSkipped += 1;
      return;
    }
    const { out, stats: s } = recolorContent(content, rgb);
    stats.textObjects += s.textObjects;
    stats.fillReplaced += s.fillReplaced;
    stats.strokeReplaced += s.strokeReplaced;

    const m = new Map<string, PdfObj>();
    for (const [key, value] of obj.m) {
      if (key === "Filter" || key === "Length" || key === "DecodeParms") {
        continue;
      }
      m.set(key, value);
    }
    m.set("Filter", { k: "name", v: "FlateDecode" });
    replacements.set(num, { k: "stream", m, raw: zlibSync(latin1Bytes(out)) });
    stats.streamsRecolored += 1;
  };

  const walkForms = (
    entries: Array<{ num: number; obj: PdfObj & { k: "stream" } }>,
    seen: Set<number>
  ): void => {
    for (const entry of entries) {
      if (seen.has(entry.num)) continue;
      recolorStream(entry.num, entry.obj, seen);
      // Nested forms via this form's own /Resources.
      walkForms(formStreams(doc, entry.obj.m.get("Resources")), seen);
    }
  };

  const seen = new Set<number>();
  for (const page of pages) {
    for (const stream of pageContentStreams(doc, page)) {
      recolorStream(stream.num, stream.obj, seen);
    }
    walkForms(formStreams(doc, page.dict.get("Resources")), seen);
  }

  return { replacements, stats };
}
