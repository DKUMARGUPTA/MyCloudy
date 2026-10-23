/**
 * Digital signature — model (RB6-FIN-a4). Pure, bun-testable orchestration
 * for certificate-based PAdES (adbe.pkcs7.detached) signing, 100% on-device:
 *
 *  - parseSignRun: full defensive coercion at the worker boundary
 *    (parseRequestRun precedent — tampered payloads never crash the run);
 *  - the sign mechanics: a deterministic /Contents hex gap sized by a
 *    DRY-RUN CMS build (same cert, same key, same signingTime, a dummy
 *    32-byte digest — every length-bearing input is identical, so the real
 *    CMS always fits), a fixed-width zero-padded 10-digit /ByteRange the
 *    byte surgeon patches in place (nothing after it can shift), the
 *    SHA-256 digest over the covered ranges (pure two-part update — the
 *    sha.ts core), then the CMS hex splice;
 *  - the WinAnsi-vs-Noto rule (xml-invoice-to-pdf recipe) for the visible
 *    block text, and the display-space geometry (request-signature
 *    recipe) so the block lands where the user expects it even on
 *    /Rotate 90/180/270 pages with MediaBox origins.
 *
 * No pdf-lib here — the byte surgery operates on SAVED bytes, so the
 * smoke drives it directly. Nothing in this file touches the network;
 * the key, the certificate and the document never leave the device
 * (mode D).
 */

import { buildDetachedSignedData } from "./cms";
import { P12Error, parsePkcs12, type X509Summary } from "./pkcs12";
import { PureHash } from "./sha";

export { P12Error, parsePkcs12 };
export type { X509Summary };

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

/** Visible signature block size in DISPLAY points (the Acrobat norm). */
export const BLOCK_W_PT = 200;
export const BLOCK_H_PT = 64;
/** Distance from the displayed page edges to the block. */
export const BLOCK_MARGIN_PT = 40;

export type BlockPosition = "bl" | "br" | "tl" | "tr";
export const BLOCK_POSITIONS: BlockPosition[] = ["bl", "br", "tl", "tr"];

/** Field-length caps (chars). */
export const MAX_REASON_CHARS = 120;
export const MAX_LOCATION_CHARS = 80;
export const MAX_PASSWORD_CHARS = 256;

/**
 * Honest input cap: the signed output is re-serialized flat (no object
 * streams) and the byte surgeon walks the whole buffer — past this the
 * worker starts trading memory for honesty. PDFs this big are rare.
 */
export const MAX_PDF_BYTES = 256 * 1024 * 1024;

/** Every /ByteRange entry is written as exactly 10 decimal digits
 *  (zero-padded), so patching values in place can never shift a byte. */
export const BYTERANGE_DIGITS = 10;
const BYTERANGE_SENTINEL = 1111111111;

/* ------------------------------------------------------------------ */
/* Error taxonomy (i18n keys, surfaced as toasts by the shell)           */
/* ------------------------------------------------------------------ */

export class SignError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = "SignError";
    this.code = code;
  }
}

/** The p12 side reuses pkcs12.ts's P12_CODES; these are the app layer's. */
export const DS_CODES = {
  noP12: "ds.errNoP12File",
  emptyFile: "ds.errEmptyFile",
  tooLarge: "ds.errTooLarge",
  signFailed: "ds.errSignFailed",
  alreadySigned: "ds.errAlreadySigned",
} as const;

/**
 * True when the input already carries a real digital signature (a PPKLite
 * /Sig with a CMS in /Contents). Re-signing such a file requires a TRUE
 * incremental update — a full pdf-lib re-save shifts every byte offset and
 * silently invalidates the existing signature's /ByteRange (Acrobat refuses
 * the same operation for the same reason). We reject honestly instead.
 */
export function hasExistingSignature(bytes: Uint8Array): boolean {
  const latin = latin1Of(bytes);
  return /\/SubFilter\s*\/adbe\.pkcs7/i.test(latin) ||
    (/\/Filter\s*\/Adobe\.PPKLite/i.test(latin) && /\/ByteRange/.test(latin));
}

/* ------------------------------------------------------------------ */
/* The WinAnsi-vs-Noto rule (xml-invoice-to-pdf recipe)                  */
/* ------------------------------------------------------------------ */

/** CP1252's 0x80-0x9F punctuation block (typed literally). */
const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

export function isWinAnsiChar(code: number): boolean {
  if (code >= 0x20 && code <= 0x7e) return true;
  if (code >= 0xa0 && code <= 0xff) return true;
  return WINANSI_EXTRA.has(code);
}

/** True when a code point needs the embedded Devanagari face (or ₹). */
export function needsNotoChar(code: number): boolean {
  return (
    (code >= 0x0900 && code <= 0x097f) ||
    code === 0x20b9 ||
    code === 0x200c ||
    code === 0x200d
  );
}

export function needsNoto(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (!isWinAnsiChar(c) && needsNotoChar(c)) return true;
  }
  return false;
}

/**
 * Keeps what the chosen font set can encode: WinAnsi always survives,
 * Devanagari only when the Noto face is embedded, everything else
 * honestly becomes "?" (we embed no CJK/Arabic face — a silent drop
 * would be a lie).
 */
export function sanitizeText(s: string, allowNoto: boolean): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n" || ch === "\t" || ch === " ") {
      out += ch;
    } else if (isWinAnsiChar(code)) {
      out += ch;
    } else if (allowNoto && needsNotoChar(code)) {
      out += ch;
    } else {
      out += "?";
    }
  }
  return out;
}

export interface TextRun {
  text: string;
  /** true → must be drawn with the Devanagari face. */
  deva: boolean;
}

/** Splits a string into WinAnsi / Devanagari runs (mixed EN+हिंदी in one
 *  line renders with both faces — the create-invoice precedent). */
export function splitTextRuns(s: string): TextRun[] {
  const runs: TextRun[] = [];
  let cur = "";
  let curDeva = false;
  let started = false;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const deva = !isWinAnsiChar(code) && needsNotoChar(code);
    if (!started) {
      cur = ch;
      curDeva = deva;
      started = true;
    } else if (deva === curDeva) {
      cur += ch;
    } else {
      runs.push({ text: cur, deva: curDeva });
      cur = ch;
      curDeva = deva;
    }
  }
  if (started) runs.push({ text: cur, deva: curDeva });
  return runs;
}

/* ------------------------------------------------------------------ */
/* Display-space geometry (request-signature recipe)                    */
/* ------------------------------------------------------------------ */

export function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** Display-space page size (rotation applied) — fill-out-pdf precedent. */
export function displaySize(
  rotation: number,
  userW: number,
  userH: number
): { w: number; h: number } {
  return rotation === 90 || rotation === 270
    ? { w: userH, h: userW }
    : { w: userW, h: userH };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Maps a box the user SAW on the rendered page (display points, y down,
 * top-left origin) back to PDF user space (points, y up) on the
 * un-rotated page. `ox`/`oy` shift by the MediaBox origin — pdf.js
 * viewports anchor display (0,0) at the box origin.
 */
export function displayRectToUser(
  rect: { left: number; top: number; w: number; h: number },
  rotation: number,
  userW: number,
  userH: number,
  ox = 0,
  oy = 0
): Rect {
  const { left, top } = rect;
  const w = rect.w;
  const h = rect.h;
  let out: Rect;
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      out = { x: top, y: left, w: h, h: w };
      break;
    case 180:
      out = { x: userW - left - w, y: top, w, h };
      break;
    case 270:
      out = { x: userW - top - h, y: userH - left - w, w: h, h: w };
      break;
    default:
      out = { x: left, y: userH - top - h, w, h };
  }
  return { x: out.x + ox, y: out.y + oy, w: out.w, h: out.h };
}

/**
 * The block's display-space rect for a corner position: the block size
 * clamped to the page, nudged inside the margins.
 */
export function positionToDisplayRect(
  position: BlockPosition,
  dispW: number,
  dispH: number
): { left: number; top: number; w: number; h: number } {
  const w = clamp(BLOCK_W_PT, 24, Math.max(24, dispW));
  const h = clamp(BLOCK_H_PT, 14, Math.max(14, dispH));
  const margin = Math.min(BLOCK_MARGIN_PT, (dispW - w) / 2, (dispH - h) / 2);
  const safe = Math.max(0, margin);
  const left = position.includes("l") ? safe : dispW - w - safe;
  const top = position.startsWith("t") ? safe : dispH - h - safe;
  return { left, top, w, h };
}

/* ------------------------------------------------------------------ */
/* Dates                                                                */
/* ------------------------------------------------------------------ */

const p2 = (n: number): string => String(n).padStart(2, "0");

/** Human-readable UTC stamp for the visible block (locale-neutral). */
export function formatSignDate(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${p2(date.getUTCMonth() + 1)}-${p2(date.getUTCDate())} ` +
    `${p2(date.getUTCHours())}:${p2(date.getUTCMinutes())}:${p2(date.getUTCSeconds())} UTC`
  );
}

/** PDF date string (D:YYYYMMDDHHmmSSZ, UTC, second precision). */
export function pdfDateString(date: Date): string {
  return (
    `D:${date.getUTCFullYear()}${p2(date.getUTCMonth() + 1)}${p2(date.getUTCDate())}` +
    `${p2(date.getUTCHours())}${p2(date.getUTCMinutes())}${p2(date.getUTCSeconds())}Z`
  );
}

/* ------------------------------------------------------------------ */
/* Run payload parsing (worker boundary)                                */
/* ------------------------------------------------------------------ */

/** The block label keys the worker reads (surface-rendered via t()). */
export const SIGN_KEYS = [
  "blockSignedBy",
  "blockDateLabel",
  "blockReasonLabel",
  "blockLocationLabel",
] as const;

export type SignKey = (typeof SIGN_KEYS)[number];

export const SIGN_LABELS_EN: Record<SignKey, string> = {
  blockSignedBy: "Digitally signed by",
  blockDateLabel: "Date:",
  blockReasonLabel: "Reason:",
  blockLocationLabel: "Location:",
};

/** The complete parsed run payload the worker consumes. */
export interface SignRun {
  locale: "en" | "hi";
  reason: string;
  location: string;
  /** 0-based page index (clamped). */
  page: number;
  position: BlockPosition;
  visible: boolean;
  /** Localized block labels (ds.* keys, surface-rendered via t()). */
  labels: Record<string, string>;
}

export type ParsedSignRun =
  | { ok: true; run: SignRun }
  | { ok: false; code: string };

function coerceStr(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const cleaned = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  return cleaned.slice(0, max);
}

function coercePosition(v: unknown): BlockPosition {
  return typeof v === "string" && (BLOCK_POSITIONS as string[]).includes(v)
    ? (v as BlockPosition)
    : "br";
}

/**
 * Parses + fully coerces the `options.sign` payload. Tampered payloads
 * degrade to honest defaults (visible block, bottom-right, page 1);
 * a pageCount of 0 is the caller's corrupt-file signal, not ours.
 */
export function parseSignRun(raw: unknown, pageCount: number): ParsedSignRun {
  let parsed: unknown;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
  } else {
    parsed = raw;
  }
  const o =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};

  const labels: Record<string, string> = {};
  if (typeof o.labels === "object" && o.labels !== null) {
    for (const [k, v] of Object.entries(o.labels as Record<string, unknown>)) {
      // Key cap: real block-label keys are short (ds.* ≤ 20 chars —
      // SIGN_KEYS); the {1,57} quantifier drops junk keys a tampered
      // payload may carry (parseRequestRun precedent).
      if (/^ds\.[A-Za-z0-9]{1,57}$/.test(k) && typeof v === "string") {
        labels[k] = v.slice(0, 240);
      }
    }
  }

  const last = Math.max(0, pageCount - 1);
  const page = Math.round(Number(o.page));
  const safePage = Number.isFinite(page)
    ? clamp(Math.trunc(page), 0, last)
    : 0;

  return {
    ok: true,
    run: {
      locale: o.locale === "hi" ? "hi" : "en",
      reason: coerceStr(o.reason, MAX_REASON_CHARS).trim(),
      location: coerceStr(o.location, MAX_LOCATION_CHARS).trim(),
      page: safePage,
      position: coercePosition(o.position),
      visible: typeof o.visible === "boolean" ? o.visible : true,
      labels,
    },
  };
}

/** Localized block label with the EN fallback (labelOf recipe). */
export function labelOf(run: SignRun, key: SignKey): string {
  const hit = run.labels[`ds.${key}`];
  return typeof hit === "string" && hit.length > 0 ? hit : SIGN_LABELS_EN[key];
}

/* ------------------------------------------------------------------ */
/* Names                                                                */
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

/** The signed output's download name (localized suffix). */
export function signedFileName(name: string, locale: "en" | "hi"): string {
  const suffix = locale === "hi" ? "हस्ताक्षरित" : "signed";
  return `${outputBaseName(name, locale)}-${suffix}.pdf`;
}

/**
 * The /T name for the signature field, made unique against the
 * document's EXISTING field names (Acrobat addresses fields by name —
 * a collision would break signing).
 */
export function sigFieldName(existing: ReadonlySet<string>): string {
  const base = "Signature1";
  if (!existing.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}_${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `Signature1_${Date.now()}`;
}

/* ------------------------------------------------------------------ */
/* The byte surgeon — /Contents gap + /ByteRange patch + CMS splice      */
/* ------------------------------------------------------------------ */

/** A byte-level search for `<` + hexLen '0' chars + `>` (the placeholder).
 *  Returns the offset of '<' or null; `unique=false` when the pattern
 *  occurs more than once (a second signature's fluke — refuse). */
export function findContentsGap(
  bytes: Uint8Array,
  hexLen: number
): { start: number; unique: boolean } | null {
  for (let i = 0; i + hexLen + 1 < bytes.length; i += 1) {
    if (bytes[i] !== 0x3c) continue; // '<'
    let ok = true;
    for (let k = 1; k <= hexLen; k += 1) {
      if (bytes[i + k] !== 0x30) {
        ok = false;
        break;
      }
    }
    if (!ok || bytes[i + hexLen + 1] !== 0x3e) continue; // '>'
    let unique = true;
    for (let j = i + 1; j + hexLen + 1 < bytes.length; j += 1) {
      if (bytes[j] !== 0x3c) continue;
      let dup = true;
      for (let k = 1; k <= hexLen; k += 1) {
        if (bytes[j + k] !== 0x30) {
          dup = false;
          break;
        }
      }
      if (dup && bytes[j + hexLen + 1] === 0x3e) {
        unique = false;
        break;
      }
    }
    return { start: i, unique };
  }
  return null;
}

export type ByteRange = [number, number, number, number];

/**
 * [0, B, C, D] where B is the offset of the Contents '<' and C sits just
 * past '>' (both delimiters inside the gap — the Adobe convention; C+D
 * covers the whole tail). Null when a value needs more than 10 digits.
 */
export function byteRangeValues(
  gapStart: number,
  gapHexLen: number,
  fileLen: number
): ByteRange | null {
  const B = gapStart;
  const C = gapStart + gapHexLen + 2;
  const D = fileLen - C;
  if (D < 0) return null;
  const max = 10 ** BYTERANGE_DIGITS - 1;
  if (B > max || C > max || D > max) return null;
  return [0, B, C, D];
}

function latin1Of(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return out;
}

/**
 * Locates OUR sentinel /ByteRange (the last one before the Contents gap,
 * same dict) and rewrites its four numbers in place, zero-padded to 10
 * digits. Returns the values written, or null on any structural surprise
 * (no array in reach, wrong digit count — never happens on our own save).
 */
export function patchByteRangeDigits(
  bytes: Uint8Array,
  gapIdx: number,
  gapHexLen: number
): ByteRange | null {
  const values = byteRangeValues(gapIdx, gapHexLen, bytes.length);
  if (values === null) return null;
  // A small latin1 window right before the gap holds the whole sig dict.
  const winStart = Math.max(0, gapIdx - 640);
  const win = latin1Of(bytes.subarray(winStart, gapIdx));
  let rel = -1;
  let searchFrom = 0;
  for (;;) {
    const hit = win.indexOf("/ByteRange", searchFrom);
    if (hit < 0) break;
    const arrAt = win.indexOf("[", hit);
    if (arrAt >= 0 && arrAt - hit <= 12) rel = hit;
    searchFrom = hit + 1;
  }
  if (rel < 0) return null;
  const arrStart = win.indexOf("[", rel);
  const arrEnd = win.indexOf("]", arrStart);
  if (arrStart < 0 || arrEnd < 0 || arrEnd - arrStart > 128) return null;
  const runs = win.slice(arrStart, arrEnd).match(/\d+/g);
  if (runs === null || runs.length !== 4) return null;
  const padded = values.map((v) => String(v).padStart(BYTERANGE_DIGITS, "0"));
  let cursor = arrStart;
  for (let i = 0; i < 4; i += 1) {
    const at = win.indexOf(runs[i]!, cursor);
    if (at < 0) return null;
    const abs = winStart + at;
    for (let k = 0; k < runs[i]!.length; k += 1) {
      bytes[abs + k] = padded[i]!.charCodeAt(k);
    }
    cursor = at + runs[i]!.length;
  }
  return values;
}

/**
 * SHA-256 over the two covered ranges — a two-part update on views, so
 * the covered bytes are never copied (the sha.ts core; node:crypto's
 * createHash is the smoke's independent oracle).
 */
export function coveredDigest(
  bytes: Uint8Array,
  range: ByteRange
): Uint8Array {
  const [a, b, c, d] = range;
  return new PureHash("sha256")
    .update(bytes.subarray(a, a + b))
    .update(bytes.subarray(c, c + d))
    .digest();
}

/** Writes the CMS hex (uppercase, PDF-conventional) into the gap. */
export function spliceContentsHex(
  bytes: Uint8Array,
  gapIdx: number,
  der: Uint8Array
): void {
  let hex = "";
  for (const b of der) hex += b.toString(16).padStart(2, "0");
  const upper = hex.toUpperCase();
  for (let i = 0; i < upper.length; i += 1) {
    bytes[gapIdx + 1 + i] = upper.charCodeAt(i);
  }
}

/* ------------------------------------------------------------------ */
/* CMS orchestration                                                    */
/* ------------------------------------------------------------------ */

export interface SignCredentials {
  pkcs8: Uint8Array;
  certDer: Uint8Array;
}

/**
 * Dry-run CMS length: same cert, same key, same signingTime, a dummy
 * 32-byte digest. Every length-bearing DER input is identical to the
 * real build (the digest is always 32 bytes, the RSA signature always
 * modulus-size), so the returned length is exactly the gap the PDF must
 * reserve (probe-pinned).
 */
export async function estimateCmsLength(
  creds: SignCredentials,
  signingTime: Date
): Promise<number> {
  const dry = await buildDetachedSignedData({
    pkcs8: creds.pkcs8,
    certDer: creds.certDer,
    digest: new Uint8Array(32),
    signingTime,
  });
  return dry.der.length;
}

export interface FinalizeInput extends SignCredentials {
  /** Signing time shared by the CMS signingTime and the /M string. */
  signingTime: Date;
  /** The reserved /Contents hex length (2 × the dry-run CMS length). */
  placeholderHexLen: number;
}

export interface SignedPdfResult {
  bytes: Uint8Array;
  byteRange: ByteRange;
  cmsLength: number;
  digest: Uint8Array;
}

/**
 * The byte-level post-process on SAVED (object-stream-free) bytes:
 * locate the placeholder gap → patch the /ByteRange digits in place
 * (fixed width, nothing shifts) → SHA-256 over the covered ranges →
 * build the real CMS (length-asserted against the dry run) → splice
 * the hex into the gap. Throws SignError with an i18n code on any
 * surprise — the run never emits a half-signed file.
 */
export async function finalizeSignedPdf(
  bytes: Uint8Array,
  input: FinalizeInput
): Promise<SignedPdfResult> {
  const gap = findContentsGap(bytes, input.placeholderHexLen);
  if (gap === null) {
    throw new SignError(DS_CODES.signFailed, "contents gap not found");
  }
  if (!gap.unique) {
    throw new SignError(DS_CODES.signFailed, "contents gap not unique");
  }
  const range = patchByteRangeDigits(bytes, gap.start, input.placeholderHexLen);
  if (range === null) {
    throw new SignError(DS_CODES.signFailed, "byterange patch failed");
  }
  const digest = coveredDigest(bytes, range);
  let cms;
  try {
    cms = await buildDetachedSignedData({
      pkcs8: input.pkcs8,
      certDer: input.certDer,
      digest,
      signingTime: input.signingTime,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SignError(DS_CODES.signFailed, message.slice(0, 200));
  }
  if (cms.der.length * 2 !== input.placeholderHexLen) {
    throw new SignError(
      DS_CODES.signFailed,
      `cms size drift ${cms.der.length} vs ${input.placeholderHexLen / 2}`
    );
  }
  spliceContentsHex(bytes, gap.start, cms.der);
  return { bytes, byteRange: range, cmsLength: cms.der.length, digest };
}
