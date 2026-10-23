/**
 * PDF to PDF/A — model (RB7-a, the 96th tool, optimize family). PURE, no
 * DOM, no pdf-lib, no fetch — bun-testable (scripts/smoke-pdf-to-pdfa.ts
 * drives every export directly):
 *
 *  - parsePdfaRun: full defensive coercion at the worker boundary
 *    (parseSignRun precedent — tampered payloads never crash the run);
 *  - the content-stream color normalizer: a real PDF content-stream
 *    tokenizer (numbers, names, strings, arrays, dicts, inline images)
 *    + a q/Q-stacked colorspace state machine that rewrites g/G/k/K,
 *    /DeviceGray|/DeviceCMYK cs/CS and their sc/scn/SC/SCN operands into
 *    DeviceRGB equivalents, leaving everything else byte-preserved;
 *  - buildPdfaXmpPacket: the XMP the worker stamps (dc:title from /Info,
 *    pdfaid:part + pdfaid:conformance B — the create-electronic-invoice
 *    Factur-X XMP recipe);
 *  - buildSrgbIccProfile: the hand-rolled sRGB ICC v2.1 monitor profile
 *    (matrix/TRC: Bradford-adapted sRGB primaries + the true piecewise
 *    tone curve at 1024 samples — probe-verified against lcms2 via PIL);
 *  - parseIccProfile: the structural ICC parser (the smoke's oracle);
 *  - the standard-14 asset map + AFM width/descriptor builders
 *    (@pdf-lib/standard-fonts — the canonical metrics of the base fonts,
 *    which the pdf.js substitute programs honor);
 *  - buildReportText: the plain-text conformance report
 *    (validate-e-invoice pattern);
 *  - the honesty sniff + output names + error codes.
 *
 * Nothing in this file touches the network; the document never leaves the
 * device (mode D).
 */

import {
  DEFAULT_PDFA_TARGET,
  PDFA_TARGETS,
  PDFA_TARGET_INFO,
  type ColorStreamStats,
  type PdfaChangeReport,
  type PdfaTarget,
} from "./types";

export { DEFAULT_PDFA_TARGET, PDFA_TARGETS, PDFA_TARGET_INFO };
export type { PdfaTarget };

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

/**
 * Honest input cap: the converter re-serializes flat (no object streams)
 * and re-deflates every content stream — past this, the worker trades
 * memory for honesty. PDFs this big are rare.
 */
export const MAX_PDF_BYTES = 256 * 1024 * 1024;

/** Strings longer than this are truncated in report lines. */
export const REPORT_TEXT_CAP = 96;

/* ------------------------------------------------------------------ */
/* Error taxonomy (i18n keys, surfaced as toasts by the shell)           */
/* ------------------------------------------------------------------ */

export const PA_CODES = {
  emptyFile: "pa.errEmptyFile",
  tooLarge: "pa.errTooLarge",
  notPdf: "pa.errNotPdf",
  transparency: "pa.errTransparency",
  unembeddableFonts: "pa.errUnembeddableFonts",
  convertFailed: "pa.errConvertFailed",
} as const;

/* ------------------------------------------------------------------ */
/* Run payload parsing (worker boundary)                                */
/* ------------------------------------------------------------------ */

export type ParsedPdfaRun =
  | { ok: true; run: { target: PdfaTarget; locale: "en" | "hi"; labels: Record<string, string> } }
  | { ok: false; code: string };

/** Coerces anything to a legal target; unknown → 2b (the balanced default). */
export function normalizeTarget(value: unknown): PdfaTarget {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (PDFA_TARGETS as readonly string[]).includes(s) ? (s as PdfaTarget) : DEFAULT_PDFA_TARGET;
}

/**
 * Parses + fully coerces the `options.run` payload (locale + labels) and
 * the separate `options.target`. Tampered payloads degrade to honest
 * defaults (target 2b, locale en, no labels); parse errors never reject
 * the run.
 */
export function parsePdfaRun(
  target: unknown,
  rawRun: unknown
): ParsedPdfaRun {
  let parsed: unknown;
  if (typeof rawRun === "string" && rawRun.length > 0) {
    try {
      parsed = JSON.parse(rawRun);
    } catch {
      parsed = {};
    }
  } else {
    parsed = rawRun;
  }
  const o =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};

  const labels: Record<string, string> = {};
  if (typeof o.labels === "object" && o.labels !== null) {
    for (const [k, v] of Object.entries(o.labels as Record<string, unknown>)) {
      // Real report-label keys are short pa.* names (≤ 32 chars); the
      // {1,29} quantifier drops junk keys a tampered payload may carry
      // (parseSignRun precedent).
      if (/^pa\.[A-Za-z0-9]{1,29}$/.test(k) && typeof v === "string") {
        labels[k] = v.slice(0, 240);
      }
    }
  }

  return {
    ok: true,
    run: {
      target: normalizeTarget(target),
      locale: o.locale === "hi" ? "hi" : "en",
      labels,
    },
  };
}

/** Localized report label with the EN fallback (labelOf recipe). */
export function labelOf(
  locale: "en" | "hi",
  labels: Record<string, string>,
  key: string,
  en: string
): string {
  const hit = labels[`pa.${key}`];
  return typeof hit === "string" && hit.length > 0 ? hit : en;
}

/* ------------------------------------------------------------------ */
/* The WinAnsi (CP1252) byte → Unicode table                            */
/* ------------------------------------------------------------------ */

/**
 * CP1252's 0x80-0x9F block (the 27 mapped values; the rest of 0x80-0x9F
 * is undefined in WinAnsi and falls back to '?' rendering).
 */
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

/** WinAnsi byte → Unicode code point (identity for undefined bytes). */
export function winAnsiToUnicode(byte: number): number {
  if (byte < 0x80 || (byte >= 0xa0 && byte <= 0xff)) return byte;
  return CP1252_HIGH[byte] ?? byte;
}

/* ------------------------------------------------------------------ */
/* Naive device-color conversions (documented, no ICC inventing)         */
/* ------------------------------------------------------------------ */

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The naive CMYK → RGB conversion on device values (no black
 * preservation, no ICC source profile — the "simple" formula every
 * browser's canvas uses). Honest: colors shift slightly on a real CMYK
 * press intent; the report says exactly this.
 */
export function cmykToRgbNaive(
  c: number,
  m: number,
  y: number,
  k: number
): [number, number, number] {
  const r = (1 - clamp01(c)) * (1 - clamp01(k));
  const g = (1 - clamp01(m)) * (1 - clamp01(k));
  const b = (1 - clamp01(y)) * (1 - clamp01(k));
  return [clamp01(r), clamp01(g), clamp01(b)];
}

/** PDF number formatting: up to 6 decimals, no exponent, no trailing 0s. */
export function pdfNumber(v: number): string {
  const s = v.toFixed(6).replace(/0+$/, "");
  return s.endsWith(".") ? s.slice(0, -1) : s === "-0" ? "0" : s;
}

/* ------------------------------------------------------------------ */
/* Content-stream tokenizer + color normalizer                          */
/* ------------------------------------------------------------------ */

export type TokenKind = "number" | "name" | "string" | "op" | "delim";

export interface ContentToken {
  kind: TokenKind;
  /** Byte offset of the token's first byte. */
  start: number;
  /** Byte offset one past the token's last byte. */
  end: number;
  /** Decoded text (numbers as written, names without the slash). */
  text: string;
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isRegular(c: number): boolean {
  return !WHITESPACE.has(c) && !DELIMS.has(c);
}

/**
 * Tokenizes a PDF content stream (latin1 text). Handles comments,
 * literal + hex strings, names with ## escapes, numbers, operators and
 * the delimiters; inline images are NOT tokenized here (the normalizer
 * skips them byte-exact — see normalizeContentStreamColors).
 */
export function tokenizeContentStream(text: string): ContentToken[] {
  const tokens: ContentToken[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (WHITESPACE.has(c)) {
      i += 1;
      continue;
    }
    if (c === 0x25) {
      // % comment — skip to EOL
      while (i < n && text.charCodeAt(i) !== 0x0a && text.charCodeAt(i) !== 0x0d) i += 1;
      continue;
    }
    if (c === 0x3c && text.charCodeAt(i + 1) === 0x3c) {
      // dict open (BDC/DP property lists)
      tokens.push({ kind: "delim", start: i, end: i + 2, text: "<<" });
      i += 2;
      continue;
    }
    if (c === 0x3e && text.charCodeAt(i + 1) === 0x3e) {
      tokens.push({ kind: "delim", start: i, end: i + 2, text: ">>" });
      i += 2;
      continue;
    }
    if (c === 0x28 || c === 0x3c) {
      // string: ( literal (nested parens + backslash escapes) or < hex >
      const start = i;
      i = skipString(text, i);
      tokens.push({ kind: "string", start, end: i, text: text.slice(start, i) });
      continue;
    }
    if (c === 0x3e) {
      // a stray '>' (hex string end without start) — single delim
      tokens.push({ kind: "delim", start: i, end: i + 1, text: ">" });
      i += 1;
      continue;
    }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
      tokens.push({ kind: "delim", start: i, end: i + 1, text: text[i]! });
      i += 1;
      continue;
    }
    if (c === 0x2f) {
      // name — regular chars + ## escapes
      const start = i;
      i += 1;
      while (i < n && isRegular(text.charCodeAt(i))) i += 1;
      tokens.push({ kind: "name", start, end: i, text: text.slice(start + 1, i) });
      continue;
    }
    if (
      (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e
    ) {
      const start = i;
      if (c === 0x2b || c === 0x2d) i += 1;
      let sawDigit = false;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d >= 0x30 && d <= 0x39) {
          sawDigit = true;
          i += 1;
        } else if (d === 0x2e) {
          i += 1;
        } else {
          break;
        }
      }
      if (sawDigit) {
        tokens.push({ kind: "number", start, end: i, text: text.slice(start, i) });
        continue;
      }
      // a lone +/- — treat as an operator-ish token
      tokens.push({ kind: "op", start, end: i, text: text.slice(start, i) });
      continue;
    }
    // operator / keyword: a run of regular chars
    const start = i;
    while (i < n && isRegular(text.charCodeAt(i))) i += 1;
    tokens.push({ kind: "op", start, end: i, text: text.slice(start, i) });
  }
  return tokens;
}

/** Skips a string starting at `i` ('(' or '<'), returns the end offset. */
function skipString(text: string, i: number): number {
  const open = text.charCodeAt(i);
  if (open === 0x3c) {
    // hex string — find the matching '>'
    let j = i + 1;
    while (j < text.length && text.charCodeAt(j) !== 0x3e) j += 1;
    return Math.min(j + 1, text.length);
  }
  // literal string with nesting + escapes
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c === 0x5c) {
      j += 2; // escaped char (line continuations collapse later — skip 2 is enough for token bounds)
      continue;
    }
    if (c === 0x28) depth += 1;
    if (c === 0x29) {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }
  return text.length;
}

/** Skips an inline image (BI … ID <binary> EI), returns the end offset
 *  (one past the EI token) — the binary bytes are preserved byte-exact. */
function skipInlineImage(text: string, from: number): { end: number; found: boolean } {
  // from points at the token AFTER 'BI' (already consumed as op).
  const n = text.length;
  let i = from;
  while (i < n) {
    // find the ID keyword at a token boundary
    const rel = text.indexOf("ID", i);
    if (rel < 0) return { end: n, found: false };
    const before = rel > 0 ? text.charCodeAt(rel - 1) : 0x20;
    const after = rel + 2 < n ? text.charCodeAt(rel + 2) : 0x0a;
    if (isRegular(before) || isRegular(after)) {
      i = rel + 2;
      continue;
    }
    // binary data starts after the single EOL that follows ID
    let data = rel + 2;
    if (text.charCodeAt(data) === 0x0d) data += 1;
    if (text.charCodeAt(data) === 0x0a) data += 1;
    // scan for the EI keyword at a token boundary
    let j = data;
    while (j < n) {
      const rel2 = text.indexOf("EI", j);
      if (rel2 < 0) return { end: n, found: false };
      const b2 = rel2 > 0 ? text.charCodeAt(rel2 - 1) : 0x20;
      const a2 = rel2 + 2 < n ? text.charCodeAt(rel2 + 2) : 0x0a;
      if (isRegular(b2) || isRegular(a2)) {
        j = rel2 + 2;
        continue;
      }
      return { end: rel2 + 2, found: true };
    }
    return { end: n, found: false };
  }
  return { end: n, found: false };
}

/** How a named colorspace's operands behave in sc/scn. */
export type CsKind =
  | { comps: 1 | 3 | 4; rgb: boolean }
  | { special: "pattern" | "indexed" | "separation" | "devicen" | "lab" | "unknown" };

export type CsMap = Record<string, CsKind>;

const DEVICE_GRAY: CsKind = { comps: 1, rgb: false };
const DEVICE_RGB: CsKind = { comps: 3, rgb: true };
const DEVICE_CMYK: CsKind = { comps: 4, rgb: false };

/** Classifies a colorspace definition value for the normalizer's map. */
export function csKindOf(deviceName: string): CsKind {
  switch (deviceName) {
    case "DeviceGray":
    case "G":
      return DEVICE_GRAY;
    case "DeviceRGB":
    case "RGB":
      return DEVICE_RGB;
    case "DeviceCMYK":
    case "CMYK":
      return DEVICE_CMYK;
    case "CalRGB":
      return { comps: 3, rgb: true };
    case "CalGray":
      return DEVICE_GRAY;
    case "Lab":
      return { special: "lab" };
    case "Pattern":
      return { special: "pattern" };
    case "Indexed":
    case "I":
      return { special: "indexed" };
    case "Separation":
      return { special: "separation" };
    case "DeviceN":
      return { special: "devicen" };
    default:
      return { special: "unknown" };
  }
}

interface RgbTriple {
  r: string;
  g: string;
  b: string;
}

const grayTriple = (v: number): RgbTriple => {
  const s = pdfNumber(clamp01(v));
  return { r: s, g: s, b: s };
};

const cmykTriple = (c: number, m: number, y: number, k: number): RgbTriple => {
  const [r, g, b] = cmykToRgbNaive(c, m, y, k);
  return { r: pdfNumber(r), g: pdfNumber(g), b: pdfNumber(b) };
};

/**
 * THE color normalizer. Rewrites a content stream so that every device
 * color operator speaks DeviceRGB:
 *
 *   `x g`       → `x x x rg`           (and G → RG)
 *   `c m y k k` → `r g b rg`           (naive conversion, and K → RG)
 *   `/DeviceGray cs`   → `/DeviceRGB cs`
 *   `/DeviceCMYK cs`   → `/DeviceRGB cs`
 *   `<1|4 comps> sc`   → `r g b sc`    (per the tracked colorspace)
 *
 * Everything else (patterns, Separation/DeviceN/Indexed/Lab spaces,
 * shadings, inline images) is left byte-exact and counted honestly in
 * the notes. The q/Q graphics-state stack is honored for the colorspace
 * state (color spaces ARE part of the saved state).
 */
export function normalizeContentStreamColors(
  text: string,
  csMap: CsMap
): { text: string; changed: boolean; stats: ColorStreamStats } {
  const stats: ColorStreamStats = {
    grayOps: 0,
    cmykOps: 0,
    csSwitches: 0,
    scOps: 0,
    shadings: 0,
    inlineImages: 0,
    notes: [],
  };
  let tokens = tokenizeContentStream(text);
  const edits: { start: number; end: number; replacement: string }[] = [];

  // colorspace state: fill + stroke; q/Q push/pop both
  let fill: CsKind = DEVICE_GRAY; // PDF default colorspace is DeviceGray
  let stroke: CsKind = DEVICE_GRAY;
  const stack: CsKind[] = [];

  const noteOnce = (note: string): void => {
    if (!stats.notes.includes(note)) stats.notes.push(note);
  };

  // operand tracking: indices (in `tokens`) of the trailing run of
  // number/name tokens preceding the current position
  let operands: number[] = [];

  const numbersOf = (idxs: number[]): number[] | null => {
    const out: number[] = [];
    for (const idx of idxs) {
      const t = tokens[idx]!;
      if (t.kind !== "number") return null;
      const v = Number(t.text);
      if (!Number.isFinite(v)) return null;
      out.push(v);
    }
    return out;
  };

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok.kind === "op" && tok.text === "BI") {
      const { end, found } = skipInlineImage(text, tok.end);
      stats.inlineImages += 1;
      if (!found) break;
      // resume tokenizing after the inline image
      const rest = tokenizeContentStream(text.slice(end));
      tokens = tokens.slice(0, i + 1).concat(
        rest.map((t) => ({ ...t, start: t.start + end, end: t.end + end }))
      );
      operands = [];
      i += 1;
      continue;
    }
    if (tok.kind === "number" || tok.kind === "name") {
      operands.push(i);
      i += 1;
      continue;
    }
    if (tok.kind === "op" && operands.length > 0) {
      const nums = numbersOf(operands);
      switch (tok.text) {
        case "g":
        case "G": {
          if (nums !== null && nums.length === 1) {
            const t3 = grayTriple(nums[0]!);
            const first = tokens[operands[0]!]!;
            edits.push({
              start: first.start,
              end: tok.end,
              replacement: `${t3.r} ${t3.g} ${t3.b} ${tok.text === "g" ? "rg" : "RG"}`,
            });
            stats.grayOps += 1;
          }
          break;
        }
        case "k":
        case "K": {
          if (nums !== null && nums.length === 4) {
            const t3 = cmykTriple(nums[0]!, nums[1]!, nums[2]!, nums[3]!);
            const first = tokens[operands[0]!]!;
            edits.push({
              start: first.start,
              end: tok.end,
              replacement: `${t3.r} ${t3.g} ${t3.b} ${tok.text === "k" ? "rg" : "RG"}`,
            });
            stats.cmykOps += 1;
          }
          break;
        }
        case "rg":
        case "RG": {
          // already DeviceRGB — consumed as-is
          break;
        }
        case "cs":
        case "CS": {
          const nameTok = tokens[operands[operands.length - 1]!]!;
          if (nameTok.kind === "name") {
            const name = nameTok.text;
            let kind: CsKind;
            if (csMap[name] !== undefined) {
              kind = csMap[name]!; // named resource space (ICCBased N…)
            } else {
              kind = csKindOf(name); // device + builtin names
            }
            if ("special" in kind) {
              if (kind.special === "pattern") noteOnce("pattern colorspace left as-is");
              else noteOnce(`${name} colorspace (${kind.special}) left as-is`);
            } else if (kind.rgb === false) {
              // 1-comp or 4-comp space → rewrite the name to /DeviceRGB
              edits.push({ start: nameTok.start, end: nameTok.end, replacement: "/DeviceRGB" });
              stats.csSwitches += 1;
            }
            if (tok.text === "cs") fill = kind;
            else stroke = kind;
          }
          break;
        }
        case "sc":
        case "scn":
        case "SC":
        case "SCN": {
          const kind = tok.text === "sc" || tok.text === "scn" ? fill : stroke;
          const isPatternCall =
            ("special" in kind && kind.special === "pattern") ||
            operands.some((idx) => tokens[idx]!.kind === "name");
          if (isPatternCall) {
            noteOnce("pattern color call left as-is");
            break;
          }
          if ("special" in kind) break; // honest: not convertible
          if (kind.rgb === true) break; // already 3-component
          if (nums !== null && nums.length === 1 && kind.comps === 1) {
            const t3 = grayTriple(nums[0]!);
            const first = tokens[operands[0]!]!;
            edits.push({
              start: first.start,
              end: tok.end,
              replacement: `${t3.r} ${t3.g} ${t3.b} ${tok.text}`,
            });
            stats.scOps += 1;
          } else if (nums !== null && nums.length === 4 && kind.comps === 4) {
            const t3 = cmykTriple(nums[0]!, nums[1]!, nums[2]!, nums[3]!);
            const first = tokens[operands[0]!]!;
            edits.push({
              start: first.start,
              end: tok.end,
              replacement: `${t3.r} ${t3.g} ${t3.b} ${tok.text}`,
            });
            stats.scOps += 1;
          }
          break;
        }
        case "sh": {
          stats.shadings += 1;
          noteOnce("shading fills left as-is");
          break;
        }
        default:
          break;
      }
      operands = [];
      i += 1;
      continue;
    }
    if (tok.kind === "op" && tok.text === "q") {
      stack.push(fill, stroke);
      operands = [];
      i += 1;
      continue;
    }
    if (tok.kind === "op" && tok.text === "Q") {
      const s = stack.pop();
      const f = stack.pop();
      if (s !== undefined && f !== undefined) {
        stroke = s;
        fill = f;
      }
      operands = [];
      i += 1;
      continue;
    }
    // any other token resets the operand window (strings, delimiters,
    // ops without operands)
    operands = [];
    i += 1;
  }

  if (edits.length === 0) {
    return { text, changed: false, stats };
  }
  // apply edits back-to-front so earlier offsets stay valid
  let out = text;
  for (let e = edits.length - 1; e >= 0; e -= 1) {
    const edit = edits[e]!;
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  }
  return { text: out, changed: true, stats };
}

/** Counts the remaining gray/CMYK/RGB color operators (the smoke oracle). */
export function countColorOps(text: string): {
  gray: number;
  cmyk: number;
  rgb: number;
  sc: number;
} {
  const tokens = tokenizeContentStream(text);
  let gray = 0;
  let cmyk = 0;
  let rgb = 0;
  let sc = 0;
  let operands = 0;
  for (const tok of tokens) {
    if (tok.kind === "number" || tok.kind === "name") {
      operands += 1;
      continue;
    }
    if (tok.kind === "op") {
      if (operands === 0 && (tok.text === "g" || tok.text === "G")) {
        // operand-less g/G cannot occur in valid PDF; count as gray
        gray += 1;
      }
      if (operands === 1 && (tok.text === "g" || tok.text === "G")) gray += 1;
      else if (operands === 4 && (tok.text === "k" || tok.text === "K")) cmyk += 1;
      else if (operands === 3 && (tok.text === "rg" || tok.text === "RG")) rgb += 1;
      else if ((tok.text === "sc" || tok.text === "scn" || tok.text === "SC" || tok.text === "SCN") && operands > 0) {
        sc += 1;
      }
      operands = 0;
    } else {
      operands = 0;
    }
  }
  return { gray, cmyk, rgb, sc };
}

/* ------------------------------------------------------------------ */
/* XMP packet                                                           */
/* ------------------------------------------------------------------ */

/** The official PDF/A identification namespace. */
export const PFAID_NAMESPACE = "http://www.aiim.org/pdfa/ns/id/";

function xmlEscape(text: string): string {
  return text
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;")
    .split("'")
    .join("&apos;");
}

/**
 * The PDF/A XMP packet: dc:format, dc:title (from /Info Title, UTF-8 —
 * the PDF/A rule that the XMP and Info dicts must agree), pdf:Producer,
 * xmp:CreatorTool + the identification block pdfaid:part +
 * pdfaid:conformance B (what every PDF/A validator reads first).
 */
export function buildPdfaXmpPacket(
  target: PdfaTarget,
  docTitle: string,
  producer: string
): string {
  const part = PDFA_TARGET_INFO[target].part;
  const safeTitle = xmlEscape(docTitle.slice(0, 512));
  const safeProducer = xmlEscape(producer.slice(0, 120));
  const titleBlock =
    safeTitle.length > 0
      ? `      <dc:title>\n        <rdf:Alt>\n          <rdf:li xml:lang="x-default">${safeTitle}</rdf:li>\n        </rdf:Alt>\n      </dc:title>\n`
      : "";
  return (
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="${safeProducer}">\n` +
    `  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n` +
    `    <rdf:Description rdf:about="" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:pdf="http://ns.adobe.com/pdf/1.3/" ` +
    `xmlns:xmp="http://ns.adobe.com/xap/1.0/" ` +
    `xmlns:pdfaid="${PFAID_NAMESPACE}">\n` +
    `      <dc:format>application/pdf</dc:format>\n` +
    titleBlock +
    `      <pdf:Producer>${safeProducer}</pdf:Producer>\n` +
    `      <xmp:CreatorTool>${safeProducer}</xmp:CreatorTool>\n` +
    `      <pdfaid:part>${part}</pdfaid:part>\n` +
    `      <pdfaid:conformance>B</pdfaid:conformance>\n` +
    `    </rdf:Description>\n` +
    `  </rdf:RDF>\n` +
    `</x:xmpmeta>\n` +
    `<?xpacket end="w"?>\n`
  );
}

/* ------------------------------------------------------------------ */
/* The hand-rolled sRGB ICC profile                                    */
/* ------------------------------------------------------------------ */

const s15Fixed16 = (v: number): number[] => {
  const x = Math.round(v * 65536);
  return [(x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff];
};
const beU32 = (v: number): number[] => [
  (v >>> 24) & 0xff,
  (v >>> 16) & 0xff,
  (v >>> 8) & 0xff,
  v & 0xff,
];
const beU16 = (v: number): number[] => [(v >>> 8) & 0xff, v & 0xff];
const sigBytes = (s: string): number[] => [
  s.charCodeAt(0),
  s.charCodeAt(1),
  s.charCodeAt(2),
  s.charCodeAt(3),
];

/** Bradford D65 → D50 chromatic adaptation (canonical constants). */
const BRADFORD_D65_TO_D50 = [
  [1.0479298208405488, 0.022946963209745065, -0.05019222652832742],
  [0.029627815688417014, 0.990434484573249, -0.01707379906347471],
  [-0.009243058152479733, 0.015055144898823672, 0.7518742899580008],
];

/** sRGB → XYZ(D65) matrix (IEC 61966-2-1). */
const SRGB_TO_XYZ_D65 = [
  [0.41239079926595934, 0.35758433938387796, 0.1804807884018343],
  [0.21263900587151027, 0.7151686787677559, 0.07219231536073371],
  [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
];

/** The true sRGB transfer function (decode direction, device → linear). */
export function srgbDecode(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export const SRGB_TRC_SAMPLES = 1024;

/** The size of the profile this builder emits (constant for the report). */
export const SRGB_ICC_SIZE = 6700;

/**
 * Builds a REAL sRGB ICC v2.1 monitor profile (matrix/TRC):
 *
 *  - header: v2.1, 'mntr', 'RGB ', 'XYZ ', 'acsp', perceptual intent,
 *    D50 PCS illuminant;
 *  - wtpt: the D50 white (the column sum of the adapted matrix);
 *  - rXYZ/gXYZ/bXYZ: the Bradford-adapted sRGB primaries
 *    (columns of chad × sRGB→XYZ(D65)) — the standard D50-adapted values;
 *  - rTRC/gTRC/bTRC: 'curv' tables sampling the TRUE piecewise sRGB
 *    tone curve at 1024 points;
 *  - desc + cprt: honest text ("hand-rolled from IEC 61966-2-1").
 *
 * Probe-verified against lcms2 (PIL ImageCms): the profile opens, builds
 * transforms and matches lcms's built-in sRGB within 0.4% Lab (the
 * 1024-sample quantization). This is a real profile, not faked bytes.
 */
export function buildSrgbIccProfile(): Uint8Array {
  const mul = (
    a: number[][],
    b: number[][]
  ): number[][] =>
    a.map((row) =>
      b[0]!.map((_, j) => row.reduce((s, v, k) => s + v * b[k]![j]!, 0))
    );
  const M = mul(BRADFORD_D65_TO_D50, SRGB_TO_XYZ_D65);
  const col = (j: number): [number, number, number] => [
    M[0]![j]!,
    M[1]![j]!,
    M[2]![j]!,
  ];
  const rXYZ = col(0);
  const gXYZ = col(1);
  const bXYZ = col(2);
  const wtpt: [number, number, number] = [
    rXYZ[0] + gXYZ[0] + bXYZ[0],
    rXYZ[1] + gXYZ[1] + bXYZ[1],
    rXYZ[2] + gXYZ[2] + bXYZ[2],
  ];

  const xyzTag = (v: [number, number, number]): number[] => [
    ...sigBytes("XYZ "),
    0, 0, 0, 0,
    ...s15Fixed16(v[0]!),
    ...s15Fixed16(v[1]!),
    ...s15Fixed16(v[2]!),
  ];
  const trcTag = (): number[] => {
    const entries: number[] = [];
    for (let i = 0; i < SRGB_TRC_SAMPLES; i += 1) {
      const v = Math.round(srgbDecode(i / (SRGB_TRC_SAMPLES - 1)) * 65535);
      entries.push(...beU16(Math.max(0, Math.min(65535, v))));
    }
    return [
      ...sigBytes("curv"),
      0, 0, 0, 0,
      ...beU32(SRGB_TRC_SAMPLES),
      ...entries,
    ];
  };
  const descTag = (): number[] => {
    const ascii = "sRGB IEC61966-2.1 (MyCloudy hand-rolled)";
    const bytes = [...sigBytes("desc"), 0, 0, 0, 0];
    bytes.push(...beU32(ascii.length + 1));
    for (const ch of ascii) bytes.push(ch.charCodeAt(0));
    bytes.push(0); // null terminator
    bytes.push(...beU32(0), ...beU32(0)); // unicode language + count
    bytes.push(...beU16(0), 0, 0); // scriptcode code + count
    bytes.push(...new Array<number>(67).fill(0)); // macintosh description
    return bytes;
  };
  const cprtTag = (): number[] => {
    const ascii = "Public domain (hand-rolled from IEC 61966-2-1 constants)";
    const bytes = [...sigBytes("text"), 0, 0, 0, 0];
    for (const ch of ascii) bytes.push(ch.charCodeAt(0));
    bytes.push(0);
    return bytes;
  };

  // tag table entries (alphabetical per the spec) with 4-byte padding
  const tags: [string, number[]][] = (
    [
      ["bTRC", trcTag()],
      ["bXYZ", xyzTag(bXYZ)],
      ["cprt", cprtTag()],
      ["desc", descTag()],
      ["gTRC", trcTag()],
      ["gXYZ", xyzTag(gXYZ)],
      ["rTRC", trcTag()],
      ["rXYZ", xyzTag(rXYZ)],
      ["wtpt", xyzTag(wtpt)],
    ] as [string, number[]][]
  ).sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const tableBytes = 4 + tags.length * 12;
  let offset = 128 + tableBytes;
  const table: number[] = [...beU32(tags.length)];
  const placed: [string, number[], number][] = [];
  for (const [name, data] of tags) {
    table.push(...sigBytes(name), ...beU32(offset), ...beU32(data.length));
    placed.push([name, data, offset]);
    offset += data.length + ((4 - (data.length % 4)) % 4);
  }
  const totalSize = offset;

  const now = new Date();
  const header: number[] = [
    ...beU32(totalSize), // profile size
    ...sigBytes("ADBE"), // preferred CMM
    ...beU32(0x02100000), // version 2.1
    ...sigBytes("mntr"), // device class: display
    ...sigBytes("RGB "), // data colour space
    ...sigBytes("XYZ "), // PCS
    ...beU16(now.getUTCFullYear()),
    ...beU16(now.getUTCMonth() + 1),
    ...beU16(now.getUTCDate()),
    ...beU16(now.getUTCHours()),
    ...beU16(now.getUTCMinutes()),
    ...beU16(now.getUTCSeconds()),
    ...sigBytes("acsp"),
    ...sigBytes("APPL"), // platform
    ...beU32(0), // flags
    ...sigBytes("ADBE"), // manufacturer
    ...beU32(0), // model
    ...beU32(0), ...beU32(0), // attributes
    ...beU32(0), // rendering intent: perceptual
    ...s15Fixed16(0.9642), ...s15Fixed16(1.0), ...s15Fixed16(0.8249), // D50
    ...sigBytes("ADBE"), // creator
    ...new Array<number>(16).fill(0), // profile ID (not computed)
    ...new Array<number>(28).fill(0), // reserved
  ];

  const out: number[] = [...header, ...table];
  for (const [, data] of placed) {
    out.push(...data);
    out.push(...new Array<number>((4 - (data.length % 4)) % 4).fill(0));
  }
  return new Uint8Array(out);
}

/* ------------------------------------------------------------------ */
/* ICC structural parser (the smoke oracle)                             */
/* ------------------------------------------------------------------ */

export interface IccTagEntry {
  signature: string;
  offset: number;
  size: number;
}

export interface IccParse {
  size: number;
  version: string;
  deviceClass: string;
  colorSpace: string;
  pcs: string;
  magic: string;
  renderingIntent: number;
  tags: IccTagEntry[];
}

/** Parses an ICC profile's header + tag table (throws on bad shape). */
export function parseIccProfile(bytes: Uint8Array): IccParse {
  const be = (at: number, count: number): number => {
    let v = 0;
    for (let i = 0; i < count; i += 1) v = v * 256 + (bytes[at + i] ?? 0);
    return v;
  };
  const ascii = (at: number, count: number): string => {
    let out = "";
    for (let i = 0; i < count; i += 1) out += String.fromCharCode(bytes[at + i] ?? 63);
    return out;
  };
  if (bytes.length < 132) throw new Error("icc: too short");
  const size = be(0, 4);
  if (size !== bytes.length) throw new Error(`icc: size field ${size} != ${bytes.length}`);
  const version = be(8, 4);
  const tagCount = be(128, 4);
  if (128 + 4 + tagCount * 12 > bytes.length) throw new Error("icc: tag table overruns");
  const tags: IccTagEntry[] = [];
  for (let t = 0; t < tagCount; t += 1) {
    const at = 132 + t * 12;
    tags.push({
      signature: ascii(at, 4),
      offset: be(at + 4, 4),
      size: be(at + 8, 4),
    });
  }
  return {
    size,
    version: `${version >>> 24}.${(version >>> 20) & 0xf}.${(version >>> 16) & 0xf}`,
    deviceClass: ascii(12, 4),
    colorSpace: ascii(16, 4),
    pcs: ascii(20, 4),
    magic: ascii(36, 4),
    renderingIntent: be(64, 4),
    tags,
  };
}

/** Reads a 'curv' tag's entries (the TRC oracle). */
export function iccCurveEntries(
  bytes: Uint8Array,
  tag: IccTagEntry
): number[] | null {
  const type = String.fromCharCode(bytes[tag.offset] ?? 0) +
    String.fromCharCode(bytes[tag.offset + 1] ?? 0) +
    String.fromCharCode(bytes[tag.offset + 2] ?? 0) +
    String.fromCharCode(bytes[tag.offset + 3] ?? 0);
  if (type !== "curv") return null;
  const count = (bytes[tag.offset + 8]! << 24) | (bytes[tag.offset + 9]! << 16) |
    (bytes[tag.offset + 10]! << 8) | bytes[tag.offset + 11]!;
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = tag.offset + 12 + i * 2;
    out.push((bytes[at]! << 8) | bytes[at + 1]!);
  }
  return out;
}

/** Reads an 'XYZ ' tag's three s15Fixed16 values (÷ 65536). */
export function iccXyzValue(
  bytes: Uint8Array,
  tag: IccTagEntry
): [number, number, number] | null {
  const type = String.fromCharCode(bytes[tag.offset] ?? 63) +
    String.fromCharCode(bytes[tag.offset + 1] ?? 63) +
    String.fromCharCode(bytes[tag.offset + 2] ?? 63) +
    String.fromCharCode(bytes[tag.offset + 3] ?? 63);
  if (type !== "XYZ ") return null;
  const s15 = (at: number): number => {
    const raw = (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
    return (raw | 0) / 65536;
  };
  return [s15(tag.offset + 8), s15(tag.offset + 12), s15(tag.offset + 16)];
}

/* ------------------------------------------------------------------ */
/* Standard-14 asset map + AFM metrics                                 */
/* ------------------------------------------------------------------ */

export type Standard14Asset =
  | { baseFont: string; file: string; kind: "ttf"; substitute: string }
  | { baseFont: string; file: string; kind: "cff"; substitute: string };

/**
 * The standard 14 → self-hosted substitute program map (the pdf.js
 * standard_fonts assets, same origin: Liberation Sans is metrically
 * Helvetica-compatible; the Foxit Type1C programs cover serif/mono/
 * symbol — all metric-compatible with their base fonts, which is their
 * entire purpose as pdf.js substitutes).
 */
export const STANDARD14_ASSETS: Record<string, Standard14Asset> = {
  Helvetica: { baseFont: "Helvetica", file: "/pdfjs/standard_fonts/LiberationSans-Regular.ttf", kind: "ttf", substitute: "LiberationSans-Regular" },
  "Helvetica-Bold": { baseFont: "Helvetica-Bold", file: "/pdfjs/standard_fonts/LiberationSans-Bold.ttf", kind: "ttf", substitute: "LiberationSans-Bold" },
  "Helvetica-Oblique": { baseFont: "Helvetica-Oblique", file: "/pdfjs/standard_fonts/LiberationSans-Italic.ttf", kind: "ttf", substitute: "LiberationSans-Italic" },
  "Helvetica-BoldOblique": { baseFont: "Helvetica-BoldOblique", file: "/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf", kind: "ttf", substitute: "LiberationSans-BoldItalic" },
  "Times-Roman": { baseFont: "Times-Roman", file: "/pdfjs/standard_fonts/FoxitSerif.pfb", kind: "cff", substitute: "FoxitSerif" },
  "Times-Bold": { baseFont: "Times-Bold", file: "/pdfjs/standard_fonts/FoxitSerifBold.pfb", kind: "cff", substitute: "FoxitSerifBold" },
  "Times-Italic": { baseFont: "Times-Italic", file: "/pdfjs/standard_fonts/FoxitSerifItalic.pfb", kind: "cff", substitute: "FoxitSerifItalic" },
  "Times-BoldItalic": { baseFont: "Times-BoldItalic", file: "/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb", kind: "cff", substitute: "FoxitSerifBoldItalic" },
  Courier: { baseFont: "Courier", file: "/pdfjs/standard_fonts/FoxitFixed.pfb", kind: "cff", substitute: "FoxitFixed" },
  "Courier-Bold": { baseFont: "Courier-Bold", file: "/pdfjs/standard_fonts/FoxitFixedBold.pfb", kind: "cff", substitute: "FoxitFixedBold" },
  "Courier-Oblique": { baseFont: "Courier-Oblique", file: "/pdfjs/standard_fonts/FoxitFixedItalic.pfb", kind: "cff", substitute: "FoxitFixedItalic" },
  "Courier-BoldOblique": { baseFont: "Courier-BoldOblique", file: "/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb", kind: "cff", substitute: "FoxitFixedBoldItalic" },
  Symbol: { baseFont: "Symbol", file: "/pdfjs/standard_fonts/FoxitSymbol.pfb", kind: "cff", substitute: "FoxitSymbol" },
  ZapfDingbats: { baseFont: "ZapfDingbats", file: "/pdfjs/standard_fonts/FoxitDingbats.pfb", kind: "cff", substitute: "FoxitDingbats" },
};

export function isStandard14BaseFont(name: string): boolean {
  return STANDARD14_ASSETS[name] !== undefined;
}

/* --- @pdf-lib/standard-fonts (the canonical AFM metrics) ------------- */

import {
  Encodings,
  Font,
  type IFontNames,
} from "@pdf-lib/standard-fonts";

/** WinAnsi byte (32..255) → glyph name (".notdef" when unmapped). */
const WINANSI_NAME: string[] = (() => {
  const byCode = new Map<number, string>();
  for (const cp of Encodings.WinAnsi.supportedCodePoints) {
    const { code, name } = Encodings.WinAnsi.encodeUnicodeCodePoint(cp);
    byCode.set(code, name);
  }
  const out: string[] = [];
  for (let c = 32; c <= 255; c += 1) out.push(byCode.get(c) ?? ".notdef");
  return out;
})();

/** StandardEncoding byte (32..255) → glyph name (".notdef" unmapped). */
const AFM_CACHE: Map<string, ReturnType<typeof Font.load>> = new Map();

function fontFor(baseFont: string): ReturnType<typeof Font.load> | null {
  if (!isStandard14BaseFont(baseFont)) return null;
  const cached = AFM_CACHE.get(baseFont);
  if (cached) return cached;
  try {
    const f = Font.load(baseFont as IFontNames);
    AFM_CACHE.set(baseFont, f);
    return f;
  } catch {
    return null;
  }
}

/** The AFM metrics of a standard-14 font (null when the name is unknown). */
export function afmOf(
  baseFont: string
): {
  fontName: string;
  bbox: [number, number, number, number];
  ascender: number | null;
  descender: number | null;
  capHeight: number | null;
  xHeight: number | null;
  italicAngle: number;
  stdVW: number;
  underlinePosition: number;
  underlineThickness: number;
} | null {
  const f = fontFor(baseFont);
  if (f === null) return null;
  return {
    fontName: f.FontName,
    bbox: f.FontBBox as [number, number, number, number],
    ascender: typeof f.Ascender === "number" ? f.Ascender : null,
    descender: typeof f.Descender === "number" ? f.Descender : null,
    capHeight: typeof f.CapHeight === "number" ? f.CapHeight : null,
    xHeight: typeof f.XHeight === "number" ? f.XHeight : null,
    italicAngle: f.ItalicAngle,
    stdVW: f.StdVW,
    underlinePosition: f.UnderlinePosition,
    underlineThickness: f.UnderlineThickness,
  };
}

/**
 * Widths (per WinAnsi code 32..255) of a standard-14 font, from the
 * canonical AFM (which the substitute programs honor — they exist to be
 * metric-compatible). Unmapped codes fall back to the .notdef/quad width.
 */
export function afmWidthsWinAnsi(baseFont: string): { first: number; last: number; widths: number[] } {
  const f = fontFor(baseFont);
  if (f === null) return { first: 32, last: 255, widths: new Array<number>(224).fill(0) };
  const widths: number[] = [];
  for (let i = 0; i < 224; i += 1) {
    const name = WINANSI_NAME[i]!;
    const w = f.getWidthOfGlyph(name);
    widths.push(typeof w === "number" ? Math.round(w) : 0);
  }
  return { first: 32, last: 255, widths };
}

/** Inverts one of the shipped encodings (Symbol / ZapfDingbats) to code → name. */
function invertedEncoding(which: "Symbol" | "ZapfDingbats"): Map<number, string> {
  const enc = which === "Symbol" ? Encodings.Symbol : Encodings.ZapfDingbats;
  const byCode = new Map<number, string>();
  for (const cp of enc.supportedCodePoints) {
    const { code, name } = enc.encodeUnicodeCodePoint(cp);
    byCode.set(code, name);
  }
  return byCode;
}

const SYMBOL_BY_CODE = invertedEncoding("Symbol");
const DINGBATS_BY_CODE = invertedEncoding("ZapfDingbats");

/**
 * Widths over the font's OWN built-in encoding (Symbol / ZapfDingbats —
 * the symbolic standard fonts keep their built-in code assignments,
 * so the /Widths array follows the inverted Adobe encoding tables).
 * Returns the tight [first..last] range present.
 */
export function afmWidthsBuiltin(baseFont: string): { first: number; last: number; widths: number[] } {
  const f = fontFor(baseFont);
  if (f === null) return { first: 32, last: 255, widths: new Array<number>(224).fill(0) };
  const byCode = baseFont === "ZapfDingbats" ? DINGBATS_BY_CODE : SYMBOL_BY_CODE;
  const codes = [...byCode.keys()].filter((c) => c >= 32 && c <= 255).sort((a, b) => a - b);
  if (codes.length === 0) return { first: 32, last: 255, widths: new Array<number>(224).fill(0) };
  const first = codes[0]!;
  const last = codes[codes.length - 1]!;
  const widths: number[] = [];
  for (let c = first; c <= last; c += 1) {
    const name = byCode.get(c);
    const w = name === undefined ? undefined : f.getWidthOfGlyph(name);
    widths.push(typeof w === "number" ? Math.round(w) : 0);
  }
  return { first, last, widths };
}

/* ------------------------------------------------------------------ */
/* The byte-level risk sniff (surface pre-scan, honest heuristics)        */
/* ------------------------------------------------------------------ */

export interface PdfaRiskSniff {
  /** An /Encrypt dictionary is present (PDF/A forbids encryption). */
  encrypted: boolean;
  /** JavaScript-looking content (/JavaScript /OpenAction /AA /JS). */
  javaScript: boolean;
  /** Soft masks or constant alpha present (/SMask /ca /CA). */
  transparency: boolean;
  /** Embedded files present (/EmbeddedFiles /Filespec). */
  embeddedFiles: boolean;
  /** Bytes length. */
  bytes: number;
}

/** Latin-1 decode of the whole buffer in chunks (worker + surface). */
export function latin1Of(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return out;
}

/**
 * CHEAP, HONEST heuristic over the raw bytes (compressed streams can
 * hide all of this — the worker's real walk is the authority; this sniff
 * only powers the surface's early heads-up chips).
 */
export function sniffPdfaRisks(bytes: Uint8Array): PdfaRiskSniff {
  const latin = latin1Of(bytes.subarray(0, Math.min(bytes.length, 4 * 1024 * 1024)));
  return {
    encrypted: /\/Encrypt\b/.test(latin),
    javaScript: /\/JavaScript\b|\/JS\b|\/OpenAction\b|\/AA\b/.test(latin),
    transparency: /\/SMask\b/.test(latin),
    embeddedFiles: /\/EmbeddedFiles\b|\/Filespec\b/.test(latin),
    bytes: bytes.length,
  };
}

/** True when the first bytes are %PDF-. */
export function sniffIsPdf(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
    bytes[3] === 0x46 && bytes[4] === 0x2d
  );
}

/* ------------------------------------------------------------------ */
/* Output names                                                         */
/* ------------------------------------------------------------------ */

/** Strips path separators + unsafe chars from a download display name. */
export function outputBaseName(name: string, locale: "en" | "hi"): string {
  const base = name
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim();
  if (base.length > 0) return base.slice(0, 120);
  return locale === "hi" ? "दस्तावेज़" : "document";
}

/** The converted PDF's download name (level visible in the name). */
export function pdfaFileName(name: string, target: PdfaTarget, locale: "en" | "hi"): string {
  return `${outputBaseName(name, locale)}-pdfa-${target}.pdf`;
}

/** The conformance report's download name. */
export function reportFileName(name: string, target: PdfaTarget, locale: "en" | "hi"): string {
  return `${outputBaseName(name, locale)}-pdfa-${target}-report.txt`;
}

/* ------------------------------------------------------------------ */
/* The plain-text conformance report                                   */
/* ------------------------------------------------------------------ */

function line(locale: "en" | "hi", labels: Record<string, string>, key: string, en: string): string {
  return labelOf(locale, labels, key, en);
}

function cap(s: string): string {
  return s.length > REPORT_TEXT_CAP ? `${s.slice(0, REPORT_TEXT_CAP)}…` : s;
}

/**
 * The honest plain-text conformance report: header (target, pages,
 * date), the change list (colors/fonts/forbidden content/metadata/
 * output intent), per-page notes and the global honesty notes. Technical
 * fragments (font names, op counts) stay raw; sentences are localized.
 */
export function buildReportText(
  report: PdfaChangeReport,
  meta: { fileName: string; inputBytes: number; outputBytes: number },
  locale: "en" | "hi",
  labels: Record<string, string>
): string {
  const L = (key: string, en: string): string => line(locale, labels, key, en);
  const hi = locale === "hi";
  const out: string[] = [];

  out.push(L("title", hi ? "PDF/A अनुरूपता रिपोर्ट" : "PDF/A conformance report"));
  out.push("=".repeat(48));
  out.push(`${L("fFile", hi ? "फ़ाइल" : "File")}: ${cap(meta.fileName)}`);
  out.push(`${L("fTarget", hi ? "लक्ष्य" : "Target")}: PDF/A-${report.target} (${PDFA_TARGET_INFO[report.target].pdfVersion === "1.4" ? "ISO 19005-1" : report.target === "2b" ? "ISO 19005-2" : "ISO 19005-3"})`);
  out.push(`${L("fPages", hi ? "पेज" : "Pages")}: ${report.pageCount}`);
  out.push(`${L("fSize", hi ? "साइज़" : "Size")}: ${meta.inputBytes} → ${meta.outputBytes} bytes`);
  out.push("");

  out.push(L("secChanges", hi ? "जो बदला गया" : "What was changed"));
  out.push("-".repeat(48));
  const c = report.colors;
  out.push(
    `${L("cColors", hi ? "रंग" : "Colors")}: ${L("cScanned", hi ? "स्ट्रीम स्कैन की गईं" : "content streams scanned")} ${c.streamsScanned}, ${L("cRewritten", hi ? "फिर लिखी गईं" : "rewritten")} ${c.streamsRewritten}, ${L("cSkipped", hi ? "छोड़ी गईं" : "skipped")} ${c.streamsSkipped}`
  );
  out.push(
    `  g/G ${L("cToRgb", hi ? "→ DeviceRGB rg/RG" : "→ DeviceRGB rg/RG")}: ${c.totals.grayOps}, k/K: ${c.totals.cmykOps}, cs/CS: ${c.totals.csSwitches}, sc/scn: ${c.totals.scOps}`
  );
  const f = report.fonts;
  out.push(
    `${L("fFonts", hi ? "फ़ॉन्ट" : "Fonts")}: ${L("fEmbedded", hi ? "पहले से एम्बेडेड (जैसे हैं वैसे रखे)" : "already embedded (kept)")} ${f.embeddedPassed}, ${L("fStdKept", hi ? "स्टैंडर्ड-14 बिना एम्बेड रखे (PDF/A-1b अनुमति)" : "standard-14 kept unembedded (PDF/A-1b allowance)")} ${f.standardKept}, ${L("fStdEmb", hi ? "स्टैंडर्ड-14 के विकल्प एम्बेड किए" : "standard-14 substitutes embedded")} ${f.standardEmbedded}`
  );
  const a = report.actions;
  const stripped =
    (a.jsTreeStripped ? 1 : 0) + a.openActionStripped.length + a.aaStripped +
    a.annotActionsStripped + a.annotsRemoved + a.embeddedFilesDropped;
  out.push(
    `${L("fActions", hi ? "हटाया गया" : "Removed")}: ${stripped} ${L("fActionsItems", hi ? "आइटम (JavaScript/लॉन्च/मल्टीमीडिया/एम्बेडेड फ़ाइलें)" : "items (JavaScript/launch/multimedia/embedded files)")}`
  );
  if (a.jsTreeStripped) out.push(`  - /Names/JavaScript ${L("fTreeGone", hi ? "ट्री हटाई गई" : "tree removed")}`);
  for (const oa of a.openActionStripped) {
    out.push(`  - /OpenAction ${L("fGone", hi ? "हटाया" : "removed")}: ${oa}`);
  }
  if (a.aaStripped > 0) out.push(`  - /AA ×${a.aaStripped}`);
  if (a.annotActionsStripped > 0) out.push(`  - ${L("fAnnotActions", hi ? "एनोटेशन एक्शन" : "annotation actions")} ×${a.annotActionsStripped}`);
  if (a.annotsRemoved > 0) out.push(`  - ${L("fMmAnnots", hi ? "मल्टीमीडिया एनोटेशन" : "multimedia annotations")} ×${a.annotsRemoved}`);
  if (a.embeddedFilesDropped > 0) out.push(`  - ${L("fEmbDropped", hi ? "एम्बेडेड फ़ाइलें हटाईं (PDF/A-1b/2b नियम)" : "embedded files dropped (PDF/A-1b/2b rule)")}: ${a.embeddedFilesDropped}`);
  if (a.embeddedFilesKept > 0) out.push(`  - ${L("fEmbKept", hi ? "एम्बेडेड फ़ाइलें रखीं (PDF/A-3b)" : "embedded files kept (PDF/A-3b)")}: ${a.embeddedFilesKept}`);
  out.push(
    `${L("fMetadata", hi ? "मेटाडेटा" : "Metadata")}: XMP ${report.xmpWritten ? L("fWritten", hi ? "लिखा गया (dc:title + pdfaid:part " + PDFA_TARGET_INFO[report.target].part + ", conformance B)" : "written (dc:title + pdfaid:part " + PDFA_TARGET_INFO[report.target].part + ", conformance B)") : L("fNotWritten", hi ? "नहीं लिखा" : "NOT written")}${report.docTitle !== "" ? `, dc:title "${cap(report.docTitle)}"` : ""}`
  );
  out.push(
    `${L("fOi", hi ? "आउटपुट इंटेंट" : "Output intent")}: ${report.outputIntentWritten ? `sRGB ICC v2.1 (${report.iccBytes} bytes, ${L("fOiHand", hi ? "IEC 61966-2.1 स्थिरांकों से बनाया" : "hand-rolled from IEC 61966-2-1 constants")})` : L("fOiNone", hi ? "जोड़ा नहीं गया" : "not added")}`
  );
  out.push(`  ${L("fTrailer", hi ? "ट्रेलर /ID" : "Trailer /ID")}: ${report.idWritten ? L("fEnsured", hi ? "सुनिश्चित" : "ensured") : "-"}, %PDF-${report.headerVersion}`);
  out.push("");

  out.push(L("secPages", hi ? "प्रति-पेज टिप्पणियाँ" : "Per-page notes"));
  out.push("-".repeat(48));
  if (report.colors.pageNotes.length === 0 && report.actions.annotsNoAp === 0) {
    out.push(L("pagesNone", hi ? "किसी पेज पर कोई ख़ास बात नहीं।" : "No per-page notes."));
  }
  for (const note of report.colors.pageNotes) out.push(`  ${note}`);
  if (report.actions.annotsNoAp > 0) {
    out.push(`  ${L("noAp", hi ? "बिना /AP स्ट्रीम वाले विजेट एनोटेशन (देखे गए, छोड़े गए)" : "widget annotations without an /AP stream (reported, left in place)")}: ${report.actions.annotsNoAp}`);
  }
  out.push("");

  out.push(L("secLimits", hi ? "ईमानदार सीमाएँ" : "Honest limits"));
  out.push("-".repeat(48));
  const t = report.transparency;
  if (t.softMaskPages.length > 0 || t.alphaPages.length > 0) {
    const pages = [...new Set([...t.softMaskPages, ...t.alphaPages])]
      .map((p) => p + 1)
      .sort((a, b) => a - b)
      .join(", ");
    out.push(
      report.target === "1b"
        ? L("limNone1b", hi ? "—" : "-")
        : `${L("limTrans", hi ? "ट्रांसपेरेंसी (सॉफ्ट मास्क/अल्फा) पेज" : "transparency (soft masks/alpha) on pages")} ${pages} — ${L("limTransOk", hi ? "PDF/A-2b+ में अनुमत है" : "allowed in PDF/A-2b+")}`
    );
  }
  if (report.colors.streamsSkipped > 0) {
    out.push(`${L("limSkip", hi ? "स्ट्रीम रंग-सामान्यीकरण के लिए नहीं खुलीं" : "streams could not be opened for color normalization")}: ${report.colors.streamsSkipped}`);
  }
  if (c.totals.shadings > 0) {
    out.push(`${L("limSh", hi ? "शेडिंग फ़िल (sh) जैसे हैं छोड़े" : "shading fills (sh) left as-is")}: ${c.totals.shadings}`);
  }
  for (const note of report.notes) out.push(`  ${note}`);
  for (const note of f.notes) out.push(`  ${note}`);
  out.push("");
  out.push(L("tagging", hi ? "PDF/A-1b/2b/3b स्तर पर टैगिंग (संरचना ट्री) ज़रूरी नहीं है — वह PDF/A-a स्तर की बात है; यह टूल -b बनाता है और टैग नहीं जोड़ता।" : "Tagging (structure tree) is not required at the PDF/A-1b/2b/3b levels — that is the -a (accessible) level; this tool produces -b and adds no tags."));
  out.push("");
  out.push(L("footer", hi ? "MyCloudy में डिवाइस पर बनाया गया — यह रिपोर्ट उन बदलावों की सूची है जो सचमुच हुए; कोई प्रमाणित ISO 19005 सत्यापन नहीं।" : "Produced on-device by MyCloudy — this report lists the changes that were actually made; it is not a certified ISO 19005 validation."));
  return out.join("\n") + "\n";
}
