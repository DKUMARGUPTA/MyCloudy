/**
 * DocoPDF own 1D barcode engine — encoders (100% PURE, no platform APIs).
 *
 * Six retail-grade symbologies implemented from the ISO/spec tables:
 *   code128 — full ASCII, auto Code B/C submode switching, mod-103 check
 *   ean13   — 13 digits (12 + check), L/G/R digit encodings, parity structure
 *   ean8    — 8 digits (7 + check)
 *   upca    — 12 digits (11 + check)
 *   code39  — 43 chars + * start/stop, 3-of-9 wide elements (N/W table)
 *   itf     — Interleaved 2 of 5, digit pairs, 2.5:1 wide ratio (GS1)
 *
 * Encoding tables were cross-verified against TWO independent sources before
 * landing: the algorithmic structure from the Wikipedia symbology articles
 * (two-of-five bar weights 1,2,4,7,0 + column groups for Code 39; parity
 * tables for EAN) and the battle-tested tables in the JsBarcode reference
 * package (verified digit-by-digit — see scripts/smoke-barcode.ts oracle).
 *
 * Output is format-neutral geometry: an alternating list of element widths
 * in MODULE units ([bar, space, bar, …]) plus the recommended quiet zone.
 * Renderers (SVG / PNG / PDF) live in render.ts and the tool surface.
 *
 * Nothing here touches storage, the network or the DOM.
 */

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export const BARCODE_FORMATS = [
  "code128",
  "ean13",
  "ean8",
  "upca",
  "code39",
  "itf",
] as const;

export type BarcodeFormat = (typeof BARCODE_FORMATS)[number];

export interface BarcodeTextAnchor {
  /** Anchor x in module units, relative to the first bar of the code. */
  x: number;
  text: string;
  align: "left" | "center" | "right";
}

export interface BarcodeEncodeOk {
  ok: true;
  format: BarcodeFormat;
  /** Alternating element widths in module units (bar, space, bar, …). */
  elements: number[];
  /** Total code width in module units (sum of elements). */
  total: number;
  /** Recommended quiet zone per side, module units. */
  quiet: number;
  /** Human-readable text to print under the code. */
  humanText: string;
  /** Anchored text layout (EAN/UPC style); empty for centered-text formats. */
  textAnchors: BarcodeTextAnchor[];
  /** True when we appended the check digit (input was one digit short). */
  addedCheckDigit: boolean;
}

export type BarcodeEncodeErr =
  | { ok: false; code: "empty" }
  | { ok: false; code: "charset" }
  | { ok: false; code: "length"; max: number }
  | { ok: false; code: "checkDigit"; expected: string; got: string }
  | { ok: false; code: "oddDigits" };

export type BarcodeEncodeResult = BarcodeEncodeOk | BarcodeEncodeErr;

/** Honest input limits (typical scanner decode capability, not engine). */
export const BARCODE_LIMITS: Record<BarcodeFormat, number> = {
  code128: 48,
  ean13: 13,
  ean8: 8,
  upca: 12,
  code39: 32,
  itf: 40,
};

/* ------------------------------------------------------------------ */
/* Code 128                                                            */
/* ------------------------------------------------------------------ */

/**
 * Code 128 symbol patterns — the standard 107-entry table (values 0-106),
 * each number encoding the module bits directly (1 = bar, 0 = space).
 * Entries 0-102 are 11-module data symbols; 103/104/105 are START A/B/C;
 * 106 is the 13-module STOP (2-3-3-1-1-1-2). Sanity: entry 0 decodes to
 * the textbook "212222", START B to "211214", STOP to "2331112".
 */
const CODE128_BITS = [
  11011001100, 11001101100, 11001100110, 10010011000, 10010001100,
  10001001100, 10011001000, 10011000100, 10001100100, 11001001000,
  11001000100, 11000100100, 10110011100, 10011011100, 10011001110,
  10111001100, 10011101100, 10011100110, 11001110010, 11001011100,
  11001001110, 11011100100, 11001110100, 11101101110, 11101001100,
  11100101100, 11100100110, 11101100100, 11100110100, 11100110010,
  11011011000, 11011000110, 11000110110, 10100011000, 10001011000,
  10001000110, 10110001000, 10001101000, 10001100010, 11010001000,
  11000101000, 11000100010, 10110111000, 10110001110, 10001101110,
  10111011000, 10111000110, 10001110110, 11101110110, 11010001110,
  11000101110, 11011101000, 11011100010, 11011101110, 11101011000,
  11101000110, 11100010110, 11101101000, 11101100010, 11100011010,
  11101111010, 11001000010, 11110001010, 10100110000, 10100001100,
  10010110000, 10010000110, 10000101100, 10000100110, 10110010000,
  10110000100, 10011010000, 10011000010, 10000110100, 10000110010,
  11000010010, 11001010000, 11110111010, 11000010100, 10001111010,
  10100111100, 10010111100, 10010011110, 10111100100, 10011110100,
  10011110010, 11110100100, 11110010100, 11110010010, 11011011110,
  11011110110, 11110110110, 10101111000, 10100011110, 10001011110,
  10111101000, 10111100010, 11110101000, 11110100010, 10111011110,
  10111101110, 11101011110, 11110101110, 11010000100, 11010010000,
  11010011100, 1100011101011,
] as const;

const CODE128_PATTERNS: number[][] = CODE128_BITS.map((bits) =>
  // The table numbers ARE the module bits spelled out in decimal digits
  // (1 = bar, 0 = space) — JsBarcode reads them with plain toString().
  String(bits)
    .match(/(1+|0+)/g)!
    .map((run) => run.length)
);

const CODE128_START_B = 104;
const CODE128_START_C = 105;
const CODE128_STOP = 106;
const CODE128_CODE_B = 100; // switch to set B
const CODE128_CODE_C = 99; // switch to set C

/** Plan Code B / C segments (auto submode switching). */
function planCode128(input: string): { set: "B" | "C"; value: number }[] {
  const out: { set: "B" | "C"; value: number }[] = [];
  const isDigit = (c: string): boolean => c >= "0" && c <= "9";
  let i = 0;
  while (i < input.length) {
    // Digit run starting at i.
    let runEnd = i;
    while (runEnd < input.length && isDigit(input[runEnd])) runEnd += 1;
    const runLen = runEnd - i;
    // Code C pays off for runs of >= 4, or any digit run that reaches the
    // end of the input (>= 2 digits: one pair beats two B symbols).
    const useC = runLen >= 4 || (runLen === input.length - i && runLen >= 2);
    if (!useC) {
      out.push({ set: "B", value: input.charCodeAt(i) - 32 });
      i += 1;
      continue;
    }
    // Odd run: the first digit goes through B so the C pairs stay honest
    // (we never prepend a phantom 0 that scanners would read back).
    let p = i;
    if (runLen % 2 === 1) {
      out.push({ set: "B", value: input.charCodeAt(i) - 32 });
      p = i + 1;
    }
    for (; p + 1 <= runEnd - 1; p += 2) {
      out.push({ set: "C", value: Number(input.slice(p, p + 2)) });
    }
    i = runEnd;
  }
  return out;
}

function encodeCode128(input: string): BarcodeEncodeResult {
  // Code B covers printable ASCII 32-126. Control chars and DEL are
  // rejected honestly (Code A is not offered).
  for (const ch of input) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) return { ok: false, code: "charset" };
  }
  const plan = planCode128(input);
  const startSet: "B" | "C" = plan[0]?.set === "C" ? "C" : "B";
  const symbols: number[] = [];
  let current: "B" | "C" = startSet;
  for (const item of plan) {
    if (item.set !== current) {
      symbols.push(item.set === "C" ? CODE128_CODE_C : CODE128_CODE_B);
      current = item.set;
    }
    symbols.push(item.value);
  }
  const startValue = startSet === "C" ? CODE128_START_C : CODE128_START_B;
  // Checksum: start + Σ(symbol × position), position from 1.
  let sum = startValue;
  symbols.forEach((value, idx) => {
    sum += value * (idx + 1);
  });
  const check = sum % 103;

  const elements: number[] = [
    ...CODE128_PATTERNS[startValue],
    ...symbols.flatMap((v) => CODE128_PATTERNS[v]),
    ...CODE128_PATTERNS[check],
    ...CODE128_PATTERNS[CODE128_STOP],
  ];
  const total = elements.reduce((a, b) => a + b, 0);
  return {
    ok: true,
    format: "code128",
    elements,
    total,
    quiet: 10,
    humanText: input,
    textAnchors: [],
    addedCheckDigit: false,
  };
}

/* ------------------------------------------------------------------ */
/* EAN-13 / EAN-8 / UPC-A                                              */
/* ------------------------------------------------------------------ */

const EAN_L = [
  "0001101", "0011001", "0010011", "0111101", "0100011",
  "0110001", "0101111", "0111011", "0110111", "0001011",
] as const;
const EAN_G = [
  "0100111", "0110011", "0011011", "0100001", "0011101",
  "0111001", "0000101", "0010001", "0001001", "0010111",
] as const;
const EAN_R = [
  "1110010", "1100110", "1101100", "1000010", "1011100",
  "1001110", "1010000", "1000100", "1001000", "1110100",
] as const;

/** Parity structure per leading digit (which of digits 2-7 use G). */
const EAN13_STRUCTURE = [
  "LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG",
  "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL",
] as const;

const EAN_GUARD = [1, 1, 1]; // "101"
const EAN_MIDDLE = [1, 1, 1, 1, 1]; // "01010"

function bitsToElements(bits: string): number[] {
  return bits.match(/(1+|0+)/g)!.map((run) => run.length);
}

function ean13Check(digits12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += Number(digits12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

function encodeEan13(raw: string): BarcodeEncodeResult {
  const digits = raw.replace(/\s+/g, "");
  let added = false;
  let data = digits;
  if (digits.length === 12) {
    data = digits + String(ean13Check(digits));
    added = true;
  }
  if (!/^\d{13}$/.test(data)) {
    return { ok: false, code: "length", max: 13 };
  }
  const expected = String(ean13Check(data.slice(0, 12)));
  if (data[12] !== expected) {
    return { ok: false, code: "checkDigit", expected, got: data[12] };
  }
  const structure = EAN13_STRUCTURE[Number(data[0])];
  const elements: number[] = [...EAN_GUARD];
  for (let i = 1; i <= 6; i += 1) {
    const d = Number(data[i]);
    elements.push(
      ...bitsToElements(structure[i - 1] === "L" ? EAN_L[d] : EAN_G[d])
    );
  }
  elements.push(...EAN_MIDDLE);
  for (let i = 7; i <= 12; i += 1) {
    elements.push(...bitsToElements(EAN_R[Number(data[i])]));
  }
  elements.push(...EAN_GUARD);
  const total = elements.reduce((a, b) => a + b, 0);
  return {
    ok: true,
    format: "ean13",
    elements,
    total, // 95 modules
    quiet: 11,
    humanText: data,
    // Classic EAN layout: leading digit outside the guard, 6+6 under halves.
    textAnchors: [
      { x: -2, text: data[0], align: "right" },
      { x: 3 + 21, text: data.slice(1, 7), align: "center" },
      { x: 50 + 21, text: data.slice(7), align: "center" },
    ],
    addedCheckDigit: added,
  };
}

function ean8Check(digits7: string): number {
  let sum = 0;
  for (let i = 0; i < 7; i += 1) {
    sum += Number(digits7[i]) * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

function encodeEan8(raw: string): BarcodeEncodeResult {
  const digits = raw.replace(/\s+/g, "");
  let added = false;
  let data = digits;
  if (digits.length === 7) {
    data = digits + String(ean8Check(digits));
    added = true;
  }
  if (!/^\d{8}$/.test(data)) {
    return { ok: false, code: "length", max: 8 };
  }
  const expected = String(ean8Check(data.slice(0, 7)));
  if (data[7] !== expected) {
    return { ok: false, code: "checkDigit", expected, got: data[7] };
  }
  const elements: number[] = [...EAN_GUARD];
  for (let i = 0; i < 4; i += 1) {
    elements.push(...bitsToElements(EAN_L[Number(data[i])]));
  }
  elements.push(...EAN_MIDDLE);
  for (let i = 4; i < 8; i += 1) {
    elements.push(...bitsToElements(EAN_R[Number(data[i])]));
  }
  elements.push(...EAN_GUARD);
  const total = elements.reduce((a, b) => a + b, 0);
  return {
    ok: true,
    format: "ean8",
    elements,
    total, // 67 modules
    quiet: 7,
    humanText: data,
    textAnchors: [
      { x: 3 + 14, text: data.slice(0, 4), align: "center" },
      { x: 36 + 14, text: data.slice(4), align: "center" },
    ],
    addedCheckDigit: added,
  };
}

function upcaCheck(digits11: string): number {
  let sum = 0;
  for (let i = 0; i < 11; i += 1) {
    sum += Number(digits11[i]) * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

function encodeUpca(raw: string): BarcodeEncodeResult {
  const digits = raw.replace(/\s+/g, "");
  let added = false;
  let data = digits;
  if (digits.length === 11) {
    data = digits + String(upcaCheck(digits));
    added = true;
  }
  if (!/^\d{12}$/.test(data)) {
    return { ok: false, code: "length", max: 12 };
  }
  const expected = String(upcaCheck(data.slice(0, 11)));
  if (data[11] !== expected) {
    return { ok: false, code: "checkDigit", expected, got: data[11] };
  }
  const elements: number[] = [...EAN_GUARD];
  for (let i = 0; i < 6; i += 1) {
    elements.push(...bitsToElements(EAN_L[Number(data[i])]));
  }
  elements.push(...EAN_MIDDLE);
  for (let i = 6; i < 12; i += 1) {
    elements.push(...bitsToElements(EAN_R[Number(data[i])]));
  }
  elements.push(...EAN_GUARD);
  const total = elements.reduce((a, b) => a + b, 0);
  return {
    ok: true,
    format: "upca",
    elements,
    total, // 95 modules
    quiet: 9,
    humanText: data,
    textAnchors: [
      { x: -3, text: data[0], align: "right" },
      { x: 3 + 17.5, text: data.slice(1, 6), align: "center" },
      { x: 50 + 17.5, text: data.slice(6, 11), align: "center" },
      { x: total + 3, text: data[11], align: "left" },
    ],
    addedCheckDigit: added,
  };
}

/* ------------------------------------------------------------------ */
/* Code 39                                                             */
/* ------------------------------------------------------------------ */

/**
 * Code 39 element table (N = narrow, W = wide) for the 43-character set
 * plus the * start/stop, in checksum-value order (0-9, A-Z, -, ., space,
 * $, /, +, %, *). Nine elements per char: bar, space, bar, …, bar —
 * exactly three wide. Verified against the two-of-five derivation
 * (bar weights 1,2,4,7,0 + column groups) and the reference package.
 */
const CODE39_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%*";
const CODE39_PATTERNS = [
  "NNNWWNWNN", "WNNWNNNNW", "NNWWNNNNW", "WNWWNNNNN", "NNNWWNNNW",
  "WNNWWNNNN", "NNWWWNNNN", "NNNWNNWNW", "WNNWNNWNN", "NNWWNNWNN",
  "WNNNNWNNW", "NNWNNWNNW", "WNWNNWNNN", "NNNNWWNNW", "WNNNWWNNN",
  "NNWNWWNNN", "NNNNNWWNW", "WNNNNWWNN", "NNWNNWWNN", "NNNNWWWNN",
  "WNNNNNNWW", "NNWNNNNWW", "WNWNNNNWN", "NNNNWNNWW", "WNNNWNNWN",
  "NNWNWNNWN", "NNNNNNWWW", "WNNNNNWWN", "NNWNNNWWN", "NNNNWNWWN",
  "WWNNNNNNW", "NWWNNNNNW", "WWWNNNNNN", "NWNNWNNNW", "WWNNWNNNN",
  "NWWNWNNNN", "NWNNNNWNW", "WWNNNNWNN", "NWWNNNWNN", "NWNWNWNNN",
  "NWNWNNNWN", "NWNNNWNWN", "NNNWNWNWN", "NWNNWNWNN",
] as const;

const CODE39_WIDE = 3; // 3:1 wide-to-narrow (spec range 2.25-3.0)
const CODE39_GAP = 1; // narrow inter-character space

function encodeCode39(raw: string): BarcodeEncodeResult {
  const input = raw.toUpperCase();
  for (const ch of input) {
    if (ch === "*" || !CODE39_CHARS.includes(ch)) {
      return { ok: false, code: "charset" };
    }
  }
  const chars = `*${input}*`.split("");
  const elements: number[] = [];
  chars.forEach((ch, idx) => {
    if (idx > 0) elements.push(CODE39_GAP);
    for (const el of CODE39_PATTERNS[CODE39_CHARS.indexOf(ch)]) {
      elements.push(el === "W" ? CODE39_WIDE : 1);
    }
  });
  const total = elements.reduce((a, b) => a + b, 0);
  return {
    ok: true,
    format: "code39",
    elements,
    total,
    quiet: 10,
    humanText: input,
    textAnchors: [],
    addedCheckDigit: false,
  };
}

/* ------------------------------------------------------------------ */
/* ITF (Interleaved 2 of 5)                                            */
/* ------------------------------------------------------------------ */

const ITF_DIGITS = [
  "00110", "10001", "01001", "11000", "00101",
  "10100", "01100", "00011", "10010", "01010",
] as const;
const ITF_NARROW = 2;
const ITF_WIDE = 5; // 2.5:1 (GS1 ITF-14 default)
const ITF_START = [ITF_NARROW, ITF_NARROW, ITF_NARROW, ITF_NARROW]; // 1010
const ITF_END = [ITF_WIDE, ITF_NARROW, ITF_NARROW]; // 11101

function encodeItf(raw: string): BarcodeEncodeResult {
  const digits = raw.replace(/\s+/g, "");
  if (!/^\d+$/.test(digits)) return { ok: false, code: "charset" };
  if (digits.length % 2 === 1) return { ok: false, code: "oddDigits" };
  const elements: number[] = [...ITF_START];
  for (let p = 0; p < digits.length; p += 2) {
    const a = ITF_DIGITS[Number(digits[p])];
    const b = ITF_DIGITS[Number(digits[p + 1])];
    for (let i = 0; i < 5; i += 1) {
      elements.push(a[i] === "1" ? ITF_WIDE : ITF_NARROW); // bar
      elements.push(b[i] === "1" ? ITF_WIDE : ITF_NARROW); // space
    }
  }
  elements.push(...ITF_END);
  const total = elements.reduce((a, b) => a + b, 0);
  return {
    ok: true,
    format: "itf",
    elements,
    total,
    quiet: 20, // 10 narrow units
    humanText: digits,
    textAnchors: [],
    addedCheckDigit: false,
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function encodeBarcode(
  format: BarcodeFormat,
  input: string
): BarcodeEncodeResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, code: "empty" };
  if (trimmed.length > BARCODE_LIMITS[format]) {
    return { ok: false, code: "length", max: BARCODE_LIMITS[format] };
  }
  switch (format) {
    case "code128":
      return encodeCode128(trimmed);
    case "ean13":
      return encodeEan13(trimmed);
    case "ean8":
      return encodeEan8(trimmed);
    case "upca":
      return encodeUpca(trimmed);
    case "code39":
      return encodeCode39(trimmed);
    case "itf":
      return encodeItf(trimmed);
  }
}

export function isBarcodeFormat(value: string): value is BarcodeFormat {
  return (BARCODE_FORMATS as readonly string[]).includes(value);
}

/** Formats with fixed digit-only input (numeric keypad UX). */
export const DIGIT_ONLY_FORMATS: readonly BarcodeFormat[] = [
  "ean13",
  "ean8",
  "upca",
  "itf",
];
