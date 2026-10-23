import { inflateSync } from "fflate";

import type {
  ReportLabels,
  ReportMeta,
  RunOptions,
  CertSummary,
  SignatureCard,
  SignatureReport,
  SignatureStatus,
  SignatureTone,
  SignerAnalysis,
  UnsignedFieldInfo,
} from "./types";

/**
 * Verify PDF signatures (RB6) — PURE model, bun-testable, no DOM, no
 * pdf.js, no pdf-lib. The only ambient dependencies are WebCrypto
 * (crypto.subtle — available in Web Workers, bun and node ≥ 15) and the
 * injected `now` clock, so the smoke can pin determinism.
 *
 * Pipeline:
 *   toLatin(bytes) → walkPdf(s)  → collectSigFields(walk)
 *   per field:  /V dict → /ByteRange + /Contents (hex spans)
 *              → parseCms (minimal DER reader) → certs + signerInfos
 *              → digest over the exact ByteRange bytes (crypto.subtle)
 *              → compare with signedAttrs messageDigest  → intact/tampered
 *              → RSASSA-PKCS1-v1_5 verify over the 0xA0→0x31 re-tagged
 *                signedAttrs DER (or the covered bytes when no attrs)
 *              → coverage: file length vs ByteRange end → modified-after-
 *                signing (incremental-update detection)
 *
 * HONESTY (mirrored in the FAQ + the report footer): no CRL/OCSP, no
 * chain-of-trust, no TSA/timestamp verification, no PAdES LTV. A
 * self-signed certificate is reported as untrusted-but-valid; the
 * verdict "valid" means exactly "cryptographically sound + bytes intact
 * + coverage complete", never "legally binding" or "trusted".
 */

/* ------------------------------------------------------------------ */
/* Sanity caps                                                         */
/* ------------------------------------------------------------------ */

/** Input gate — a PDF larger than this is not a sane verify target. */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_OBJECTS = 200_000;
const MAX_XREF_CHAIN = 64;
const MAX_FIELDS = 500;
const MAX_SIGNERS = 16;
const MAX_CERTS = 32;
const MAX_TREE_DEPTH = 32;
const MAX_TREE_LEAVES = 10_000;
/** Per-container child cap for the DER walker. */
const MAX_DER_CHILDREN = 4_096;

/* ------------------------------------------------------------------ */
/* Errors (worker maps these onto i18n keys)                          */
/* ------------------------------------------------------------------ */

export type VerifyErrorCode = "errNotPdf" | "errTooBig" | "errEncrypted";

/** Typed model error — the worker maps `code` onto an i18n key. */
export class VerifyError extends Error {
  readonly code: VerifyErrorCode;
  constructor(code: VerifyErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "VerifyError";
  }
}

/* ------------------------------------------------------------------ */
/* Byte-faithful latin1 (TextDecoder("latin1") is windows-1252 in the */
/* browser — 0x80–0x9F would round-trip to the wrong bytes)           */
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

/* ------------------------------------------------------------------ */
/* Hex helpers                                                         */
/* ------------------------------------------------------------------ */

export function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i += 1) {
    out += (b[i] < 16 ? "0" : "") + b[i].toString(16);
  }
  return out;
}

/**
 * Strict hex-string decode: every char must be [0-9A-Fa-f] or PDF
 * whitespace, and the digit count must be even. Returns the decoded
 * bytes or an honest error sentence (never throws).
 */
export function decodeHexStrict(
  text: string
): { bytes: Uint8Array | null; error: string | null } {
  let digits = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\0") {
      continue;
    }
    const code = text.charCodeAt(i);
    const isHex =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 70) ||
      (code >= 97 && code <= 102);
    if (!isHex) {
      return {
        bytes: null,
        error: `non-hex character at index ${i} (code 0x${code.toString(16)})`,
      };
    }
    digits += c;
  }
  if (digits.length === 0) return { bytes: new Uint8Array(0), error: null };
  if (digits.length % 2 !== 0) {
    return { bytes: null, error: `odd hex digit count (${digits.length})` };
  }
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  }
  return { bytes: out, error: null };
}

/** Normalizes an ASN.1 INTEGER content for comparison (strips 0x00 pads). */
function normalizeIntBytes(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i += 1;
  return b.subarray(i);
}

/** Constant-time-ish byte equality (fixed walk). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/* ================================================================== */
/* PART 1 — minimal DER/ASN.1 reader (pure TS, no deps)                */
/* ================================================================== */

/** One parsed ASN.1 TLV. Offsets are into the source Uint8Array. */
export interface Tlv {
  /** 0 universal, 1 application, 2 context, 3 private. */
  cls: number;
  constructed: boolean;
  /** The tag NUMBER (after high-tag-number decoding) — NOT the raw byte:
   *  SEQUENCE (0x30) is tag number 0x10, SET (0x31) is 0x11. */
  tag: number;
  /** Offset of the first tag byte. */
  start: number;
  /** Offset of the content. */
  valueStart: number;
  /** Content length in bytes. */
  len: number;
  /** Offset just past the whole TLV. */
  end: number;
}

/**
 * readTlv — parses the TLV at `at`. Definite lengths only (short and all
 * long forms up to 4 length bytes); high-tag-number form supported;
 * truncated or absurd input → null (never throws).
 */
export function readTlv(b: Uint8Array, at: number): Tlv | null {
  const n = b.length;
  if (at < 0 || at >= n) return null;
  const first = b[at];
  const cls = (first >> 6) & 0x03;
  const constructed = (first & 0x20) !== 0;
  let tag = first & 0x1f;
  let i = at + 1;
  if (tag === 0x1f) {
    // High tag number form: base-128, bit 7 = more bytes follow.
    tag = 0;
    let guard = 0;
    for (;;) {
      if (i >= n || guard >= 8) return null;
      const bt = b[i];
      tag = tag * 128 + (bt & 0x7f);
      i += 1;
      guard += 1;
      if (tag > 0x7fffffff) return null;
      if ((bt & 0x80) === 0) break;
    }
  }
  if (i >= n) return null;
  const lenByte = b[i];
  i += 1;
  let len = -1;
  if (lenByte < 0x80) {
    len = lenByte;
  } else {
    const count = lenByte & 0x7f;
    if (count === 0) return null; // indefinite length — not supported
    if (count > 4) return null; // > 4 GB — absurd
    if (i + count > n) return null;
    len = 0;
    for (let k = 0; k < count; k += 1) len = len * 256 + b[i + k];
    i += count;
  }
  if (len < 0 || i + len > n) return null;
  return { cls, constructed, tag, start: at, valueStart: i, len, end: i + len };
}

/** Walks the TLVs packed inside `t`'s content (stops at the first bad one). */
export function tlvChildren(b: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let i = t.valueStart;
  while (i < t.end && out.length < MAX_DER_CHILDREN) {
    const c = readTlv(b, i);
    if (c === null) break;
    out.push(c);
    i = c.end;
  }
  return out;
}

/** Reads the dotted-decimal OID inside a universal OID TLV. */
export function readOid(b: Uint8Array, t: Tlv): string | null {
  if (t.cls !== 0 || t.tag !== 0x06 || t.len < 1) return null;
  const parts: number[] = [];
  let v = 0;
  let first = true;
  let pending = false;
  for (let i = t.valueStart; i < t.end; i += 1) {
    const bt = b[i];
    v = v * 128 + (bt & 0x7f);
    pending = (bt & 0x80) !== 0;
    if (!pending) {
      if (first) {
        if (v < 40) parts.push(0, v);
        else if (v < 80) parts.push(1, v - 40);
        else parts.push(2, v - 80);
        first = false;
      } else {
        parts.push(v);
      }
      v = 0;
    }
  }
  if (first || pending) return null; // empty or truncated
  return parts.join(".");
}

/** Raw INTEGER content bytes (or null when `t` is not an INTEGER). */
export function intBytes(b: Uint8Array, t: Tlv): Uint8Array | null {
  if (t.cls !== 0 || t.tag !== 0x02) return null;
  return b.subarray(t.valueStart, t.end);
}

/** The TLV's own bytes as a standalone DER buffer (copy). */
export function tlvBytes(b: Uint8Array, t: Tlv): Uint8Array {
  return b.slice(t.start, t.end);
}

/** DER value ASCII (for time + OCTET STRING-ish raw reads). */
function asciiOf(b: Uint8Array, t: Tlv): string {
  let out = "";
  for (let i = t.valueStart; i < t.end; i += 1) out += String.fromCharCode(b[i]);
  return out;
}

/* ---- ASN.1 times ------------------------------------------------- */

export interface Asn1Time {
  /** Display "YYYY-MM-DD HH:mm UTC" (null when unparsed). */
  iso: string | null;
  /** Epoch ms (null when the value is nonsense). */
  ms: number | null;
}

const FAIL_TIME: Asn1Time = { iso: null, ms: null };

/** Epoch ms → "YYYY-MM-DD HH:mm UTC". */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  const p = (x: number): string => (x < 10 ? `0${x}` : String(x));
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
  );
}

/**
 * Parses UTCTime (tag 23: YYMMDDHHMM[SS]) and GeneralizedTime
 * (tag 24: YYYYMMDDHH[MM[SS]]), each with optional fractional seconds
 * and a Z / ±HHmm zone. Always UTC-normalized.
 */
export function readAsn1Time(b: Uint8Array, t: Tlv): Asn1Time {
  if (t.cls !== 0 || (t.tag !== 23 && t.tag !== 24) || t.len < 8) return FAIL_TIME;
  const raw = asciiOf(b, t);
  const m = /^(\d+)(?:[.,]\d+)?(Z|[+-]\d{2}(?:\d{2})?)?$/.exec(raw);
  if (m === null || m[1] === undefined) return FAIL_TIME;
  let digits = m[1];
  let year: number;
  if (t.tag === 23) {
    if (digits.length !== 10 && digits.length !== 12) return FAIL_TIME;
    const yy = Number.parseInt(digits.slice(0, 2), 10);
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
    digits = digits.slice(2);
  } else {
    if (digits.length < 12 || digits.length > 14 || digits.length % 2 !== 0) return FAIL_TIME;
    year = Number.parseInt(digits.slice(0, 4), 10);
    digits = digits.slice(4);
  }
  const month = Number.parseInt(digits.slice(0, 2), 10);
  const day = Number.parseInt(digits.slice(2, 4), 10);
  const hour = Number.parseInt(digits.slice(4, 6), 10);
  const minute = digits.length >= 8 ? Number.parseInt(digits.slice(6, 8), 10) : 0;
  const second = digits.length >= 10 ? Number.parseInt(digits.slice(8, 10), 10) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
    return FAIL_TIME;
  }
  let ms = Date.UTC(year, month - 1, day, hour, minute, second === 60 ? 59 : second);
  const zone = m[2];
  if (zone !== undefined && zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const zh = Number.parseInt(zone.slice(1, 3), 10);
    const zm = zone.length >= 5 ? Number.parseInt(zone.slice(3, 5), 10) : 0;
    ms -= sign * (zh * 60 + zm) * 60_000;
  }
  if (!Number.isFinite(ms)) return FAIL_TIME;
  return { iso: formatUtc(ms), ms };
}

/* ---- ASN.1 strings ---------------------------------------------- */

/** PrintableString/UTF8String/IA5String/T61String/VisibleString/BMPString. */
function readAsn1String(b: Uint8Array, t: Tlv): string | null {
  if (t.cls !== 0) return null;
  if (t.tag === 12 || t.tag === 19 || t.tag === 20 || t.tag === 22 || t.tag === 26) {
    return new TextDecoder("utf-8").decode(b.subarray(t.valueStart, t.end));
  }
  if (t.tag === 30) {
    // BMPString: UTF-16BE
    let out = "";
    for (let i = t.valueStart; i + 1 < t.end; i += 2) {
      out += String.fromCharCode((b[i] << 8) | b[i + 1]);
    }
    return out;
  }
  return null;
}

/* ================================================================== */
/* PART 2 — OID tables                                                */
/* ================================================================== */

export const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
export const OID_DATA = "1.2.840.113549.1.7.1";
export const OID_ATTR_CONTENT_TYPE = "1.2.840.113549.1.9.3";
export const OID_ATTR_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
export const OID_ATTR_SIGNING_TIME = "1.2.840.113549.1.9.5";
export const OID_RSA_ENCRYPTION = "1.2.840.113549.1.1.1";
export const OID_SHA1_RSA = "1.2.840.113549.1.1.5";
export const OID_SHA256_RSA = "1.2.840.113549.1.1.11";
export const OID_SHA384_RSA = "1.2.840.113549.1.1.12";
export const OID_SHA512_RSA = "1.2.840.113549.1.1.13";
export const OID_SHA1 = "1.3.14.3.2.26";
export const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
export const OID_SHA384 = "2.16.840.1.101.3.4.2.2";
export const OID_SHA512 = "2.16.840.1.101.3.4.2.3";
export const OID_CN = "2.5.4.3";
export const OID_O = "2.5.4.10";
export const OID_OU = "2.5.4.11";
export const OID_C = "2.5.4.6";
export const OID_EMAIL = "1.2.840.113549.1.9.1";

export interface AlgoInfo {
  /** Display name ("SHA-256"). */
  name: string;
  /** WebCrypto hash name, when this tool can hash it (else null). */
  hash: string | null;
}

const DIGEST_BY_OID: Record<string, AlgoInfo> = {
  [OID_SHA1]: { name: "SHA-1", hash: "SHA-1" },
  [OID_SHA256]: { name: "SHA-256", hash: "SHA-256" },
  [OID_SHA384]: { name: "SHA-384", hash: "SHA-384" },
  [OID_SHA512]: { name: "SHA-512", hash: "SHA-512" },
};

const SIG_ALGO_BY_OID: Record<string, AlgoInfo> = {
  [OID_RSA_ENCRYPTION]: { name: "RSA-PKCS1v1_5", hash: null },
  [OID_SHA1_RSA]: { name: "RSA-PKCS1v1_5", hash: "SHA-1" },
  [OID_SHA256_RSA]: { name: "RSA-PKCS1v1_5", hash: "SHA-256" },
  [OID_SHA384_RSA]: { name: "RSA-PKCS1v1_5", hash: "SHA-384" },
  [OID_SHA512_RSA]: { name: "RSA-PKCS1v1_5", hash: "SHA-512" },
};

export function digestInfoFor(oid: string | null): AlgoInfo | null {
  return oid === null ? null : DIGEST_BY_OID[oid] ?? null;
}

export function sigAlgoInfoFor(oid: string | null): AlgoInfo | null {
  return oid === null ? null : SIG_ALGO_BY_OID[oid] ?? null;
}

/* ================================================================== */
/* PART 3 — X.509 certificate                                          */
/* ================================================================== */

export interface CertParsed {
  serialBytes: Uint8Array;
  serialHex: string;
  /** Issuer Name TLV bytes (standalone DER). */
  issuerDer: Uint8Array;
  subjectDer: Uint8Array;
  issuerCn: string | null;
  subject: {
    cn: string | null;
    o: string | null;
    ou: string | null;
    c: string | null;
    email: string | null;
  };
  notBefore: Asn1Time;
  notAfter: Asn1Time;
  /** SubjectPublicKeyInfo TLV bytes (standalone DER — importKey-ready). */
  spkiDer: Uint8Array | null;
  selfSigned: boolean;
}

/** RDNSequence walk: one map per RDN with its attributes. */
function rdnsOf(b: Uint8Array, nameTlv: Tlv): Map<string, string>[] {
  const out: Map<string, string>[] = [];
  for (const set of tlvChildren(b, nameTlv)) {
    if (set.cls !== 0 || set.tag !== 0x11) continue;
    const attrs = new Map<string, string>();
    for (const atv of tlvChildren(b, set)) {
      if (atv.cls !== 0 || atv.tag !== 0x10) continue;
      const kids = tlvChildren(b, atv);
      if (kids.length < 2) continue;
      const oid = readOid(b, kids[0]);
      if (oid === null) continue;
      for (let i = 1; i < kids.length; i += 1) {
        const v = readAsn1String(b, kids[i]);
        if (v !== null) {
          attrs.set(oid, v);
          break;
        }
      }
    }
    if (attrs.size > 0) out.push(attrs);
  }
  return out;
}

/**
 * parseCertificate — parses one X.509 certificate TLV. Honest scope: the
 * TBS fields this tool needs (serial, issuer, subject, validity, SPKI);
 * extensions are skipped. Returns null when the shape is wrong.
 */
export function parseCertificate(b: Uint8Array, cert: Tlv): CertParsed | null {
  if (cert.cls !== 0 || cert.tag !== 0x10) return null;
  const top = tlvChildren(b, cert);
  if (top.length < 3) return null;
  const tbs = top[0];
  if (tbs.cls !== 0 || tbs.tag !== 0x10) return null;
  const kids = tlvChildren(b, tbs);
  let i = 0;
  if (kids.length > 0 && kids[0].cls === 2 && kids[0].constructed && kids[0].tag === 0) {
    i = 1; // [0] EXPLICIT version
  }
  if (kids.length < i + 6) return null;
  const serial = intBytes(b, kids[i]);
  const issuerTlv = kids[i + 2];
  const validityTlv = kids[i + 3];
  const subjectTlv = kids[i + 4];
  const spkiTlv = kids[i + 5];
  if (
    serial === null ||
    issuerTlv.cls !== 0 || issuerTlv.tag !== 0x10 ||
    subjectTlv.cls !== 0 || subjectTlv.tag !== 0x10 ||
    validityTlv.cls !== 0 || validityTlv.tag !== 0x10 ||
    spkiTlv.cls !== 0 || spkiTlv.tag !== 0x10
  ) {
    return null;
  }
  const validity = tlvChildren(b, validityTlv);
  const notBefore = validity.length >= 1 ? readAsn1Time(b, validity[0]) : FAIL_TIME;
  const notAfter = validity.length >= 2 ? readAsn1Time(b, validity[1]) : FAIL_TIME;

  const issuerRdns = rdnsOf(b, issuerTlv);
  const subjectRdns = rdnsOf(b, subjectTlv);
  const pick = (rdns: Map<string, string>[], oid: string): string | null => {
    for (const rdn of rdns) {
      const v = rdn.get(oid);
      if (v !== undefined) return v;
    }
    return null;
  };
  const issuerDer = tlvBytes(b, issuerTlv);
  const subjectDer = tlvBytes(b, subjectTlv);
  return {
    serialBytes: serial,
    serialHex: bytesToHex(normalizeIntBytes(serial)),
    issuerDer,
    subjectDer,
    issuerCn: pick(issuerRdns, OID_CN),
    subject: {
      cn: pick(subjectRdns, OID_CN),
      o: pick(subjectRdns, OID_O),
      ou: pick(subjectRdns, OID_OU),
      c: pick(subjectRdns, OID_C),
      email: pick(subjectRdns, OID_EMAIL),
    },
    notBefore,
    notAfter,
    spkiDer: tlvBytes(b, spkiTlv),
    selfSigned: bytesEqual(issuerDer, subjectDer),
  };
}

/* ================================================================== */
/* PART 4 — CMS (PKCS#7 SignedData)                                   */
/* ================================================================== */

export interface CmsSignedAttrs {
  /** The full [0] IMPLICIT TLV bytes as they appear in the SignerInfo. */
  rawDer: Uint8Array;
  /** The same bytes re-tagged as SET (0x31) — what the signature covers. */
  retaggedDer: Uint8Array;
  contentTypeOid: string | null;
  messageDigest: Uint8Array | null;
  signingTime: Asn1Time;
  attrCount: number;
}

export interface CmsSigner {
  sidKind: "issuerAndSerial" | "ski" | "none";
  sidIssuerDer: Uint8Array | null;
  sidSerialBytes: Uint8Array | null;
  sidSkiHex: string | null;
  digestOid: string | null;
  signatureOid: string | null;
  signature: Uint8Array | null;
  signedAttrs: CmsSignedAttrs | null;
}

export interface CmsParsed {
  certs: CertParsed[];
  signers: CmsSigner[];
  digestAlgoOids: string[];
  /** True when encapContentInfo carries an [0] eContent (attached CMS). */
  eContentPresent: boolean;
  parseError: string | null;
}

/**
 * parseCms — the honest minimal SignedData reader. Never throws; any
 * structural problem lands in parseError with the technical reason.
 */
export function parseCms(der: Uint8Array): CmsParsed {
  const out: CmsParsed = {
    certs: [],
    signers: [],
    digestAlgoOids: [],
    eContentPresent: false,
    parseError: null,
  };
  const info = readTlv(der, 0);
  if (info === null) {
    out.parseError = "no TLV at offset 0 (empty / not DER)";
    return out;
  }
  if (info.cls !== 0 || info.tag !== 0x10) {
    out.parseError = `root is not a SEQUENCE (class ${info.cls} tag ${info.tag})`;
    return out;
  }
  const infoKids = tlvChildren(der, info);
  if (infoKids.length < 2) {
    out.parseError = "ContentInfo has no content";
    return out;
  }
  const contentType = readOid(der, infoKids[0]);
  if (contentType !== OID_SIGNED_DATA) {
    out.parseError = `contentType is ${contentType ?? "?"}, expected signedData`;
    return out;
  }
  const sdWrap = infoKids[1];
  if (sdWrap.cls !== 2 || sdWrap.tag !== 0 || !sdWrap.constructed) {
    out.parseError = "signedData wrapper is not [0] EXPLICIT";
    return out;
  }
  const sd = readTlv(der, sdWrap.valueStart);
  if (sd === null || sd.cls !== 0 || sd.tag !== 0x10) {
    out.parseError = "signedData is not a SEQUENCE";
    return out;
  }
  const sdKids = tlvChildren(der, sd);
  if (sdKids.length < 4) {
    out.parseError = `signedData has ${sdKids.length} children, need at least 4`;
    return out;
  }
  // 0: version, 1: digestAlgorithms SET, 2: encapContentInfo,
  // then optional [0] certs / [1] crls, then the signerInfos SET.
  const encap = sdKids[2];
  if (encap.cls !== 0 || encap.tag !== 0x10) {
    out.parseError = "encapContentInfo is not a SEQUENCE";
    return out;
  }
  for (const ec of tlvChildren(der, encap)) {
    if (ec.cls === 2 && ec.tag === 0) out.eContentPresent = true;
  }

  const digests = sdKids[1];
  if (digests.cls === 0 && digests.tag === 0x11) {
    for (const alg of tlvChildren(der, digests)) {
      const kids = tlvChildren(der, alg);
      if (kids.length >= 1) {
        const oid = readOid(der, kids[0]);
        if (oid !== null) out.digestAlgoOids.push(oid);
      }
    }
  }

  let k = 3;
  while (k < sdKids.length) {
    const t = sdKids[k];
    if (t.cls === 2 && t.tag === 0 && t.constructed) {
      for (const cert of tlvChildren(der, t)) {
        if (out.certs.length >= MAX_CERTS) break;
        if (cert.cls === 0 && cert.tag === 0x10) {
          const parsed = parseCertificate(der, cert);
          if (parsed !== null) out.certs.push(parsed);
        }
      }
      k += 1;
    } else if (t.cls === 2 && t.tag === 1) {
      k += 1; // crls — skipped (honest: none are checked)
    } else {
      break;
    }
  }
  if (k >= sdKids.length) {
    out.parseError = "no signerInfos SET found";
    return out;
  }
  const signerInfos = sdKids[k];
  if (signerInfos.cls !== 0 || signerInfos.tag !== 0x11) {
    out.parseError = "signerInfos is not a SET";
    return out;
  }
  for (const si of tlvChildren(der, signerInfos)) {
    if (out.signers.length >= MAX_SIGNERS) break;
    if (si.cls !== 0 || si.tag !== 0x10) continue;
    const kids = tlvChildren(der, si);
    if (kids.length < 5) continue;
    const sid = kids[1];
    const signer: CmsSigner = {
      sidKind: "none",
      sidIssuerDer: null,
      sidSerialBytes: null,
      sidSkiHex: null,
      digestOid: null,
      signatureOid: null,
      signature: null,
      signedAttrs: null,
    };
    if (sid.cls === 0 && sid.tag === 0x10) {
      const sidKids = tlvChildren(der, sid);
      const serial = sidKids.length >= 2 ? intBytes(der, sidKids[1]) : null;
      if (sidKids.length >= 2 && sidKids[0].cls === 0 && sidKids[0].tag === 0x10 && serial !== null) {
        signer.sidKind = "issuerAndSerial";
        signer.sidIssuerDer = tlvBytes(der, sidKids[0]);
        signer.sidSerialBytes = serial;
      }
    } else if (sid.cls === 2 && sid.tag === 0 && !sid.constructed) {
      signer.sidKind = "ski";
      signer.sidSkiHex = bytesToHex(der.subarray(sid.valueStart, sid.end));
    }
    const daKids = tlvChildren(der, kids[2]);
    if (daKids.length >= 1) signer.digestOid = readOid(der, daKids[0]);
    let next = 3;
    if (kids.length > next && kids[next].cls === 2 && kids[next].tag === 0 && kids[next].constructed) {
      const attrsTlv = kids[next];
      const raw = tlvBytes(der, attrsTlv);
      const retagged = raw.slice();
      retagged[0] = 0x31; // SET OF — the CMS re-tag rule (RFC 5651 §5.4)
      const parsed: CmsSignedAttrs = {
        rawDer: raw,
        retaggedDer: retagged,
        contentTypeOid: null,
        messageDigest: null,
        signingTime: FAIL_TIME,
        attrCount: 0,
      };
      for (const attr of tlvChildren(der, attrsTlv)) {
        if (attr.cls !== 0 || attr.tag !== 0x10) continue;
        parsed.attrCount += 1;
        const attrKids = tlvChildren(der, attr);
        if (attrKids.length < 2) continue;
        const oid = readOid(der, attrKids[0]);
        const values = tlvChildren(der, attrKids[1]);
        if (oid === OID_ATTR_CONTENT_TYPE) {
          if (values.length >= 1) parsed.contentTypeOid = readOid(der, values[0]);
        } else if (oid === OID_ATTR_MESSAGE_DIGEST) {
          if (values.length >= 1 && values[0].cls === 0 && values[0].tag === 0x04) {
            parsed.messageDigest = der.subarray(values[0].valueStart, values[0].end);
          }
        } else if (oid === OID_ATTR_SIGNING_TIME) {
          if (values.length >= 1) parsed.signingTime = readAsn1Time(der, values[0]);
        }
      }
      signer.signedAttrs = parsed;
      next += 1;
    }
    if (kids.length >= next + 2) {
      const saKids = tlvChildren(der, kids[next]);
      if (saKids.length >= 1) signer.signatureOid = readOid(der, saKids[0]);
      const sig = kids[next + 1];
      if (sig.cls === 0 && sig.tag === 0x04) {
        signer.signature = der.subarray(sig.valueStart, sig.end);
      }
    }
    out.signers.push(signer);
  }
  if (out.signers.length === 0) {
    out.parseError = "no SignerInfo parsed";
  }
  return out;
}

/* ================================================================== */
/* PART 5 — raw PDF walk (xref/trailer + linear object scan)           */
/* ================================================================== */

const WS = " \t\r\n\f\0";

interface PdfNameVal {
  k: "name";
  pos: number;
  end: number;
  name: string;
}
interface PdfStrVal {
  k: "str";
  /** First content char (just past the opening delimiter). */
  pos: number;
  /** Closing delimiter index (content is [pos, end)). */
  end: number;
  hex: boolean;
  /** Raw content chars (escapes NOT resolved for literal strings). */
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
 * names, literal + hex strings with spans, numbers, refs, bool, null).
 * Returns null on junk (the caller recovers to the next plausible key).
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
        if (nx === "\n") { p += 2; continue; } // line continuation
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
    // Hex string: tolerant scan to the matching '>' (hex-ness is validated
    // by the /Contents reader — the parser itself must survive junk).
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
    // Reference first ("N G R"), then a plain number.
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

/** Parses the object at `off` ("N G obj" must start exactly there). */
function parseObjectAt(s: string, off: number): PdfObject | null {
  const head = /^([0-9]{1,9})[ \t\r\n\f\0]+([0-9]{1,3})[ \t\r\n\f\0]+obj/.exec(
    s.slice(off, off + 40)
  );
  if (head === null) return null;
  const num = Number.parseInt(head[1], 10);
  const gen = Number.parseInt(head[2], 10);
  const after = off + head[0].length;
  const parsed = parsePdfValue(s, after);
  const value = parsed === null ? null : parsed.v;
  const end = parsed === null ? after : parsed.end;
  const obj: PdfObject = {
    num,
    gen,
    offset: off,
    value,
    end,
    streamStart: -1,
    streamEnd: -1,
  };
  if (value !== null && value.k === "dict") {
    const p = skipWs(s, end);
    if (s.startsWith("stream", p)) {
      const data = skipEol(s, p + 6);
      obj.streamStart = data;
      let len = -1;
      const lenVal = value.map.get("Length");
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
  }
  return obj;
}

function skipEol(s: string, i: number): number {
  if (s[i] === "\r" && s[i + 1] === "\n") return i + 2;
  if (s[i] === "\r" || s[i] === "\n") return i + 1;
  return i;
}

/* ---- xref chain --------------------------------------------------- */

interface XrefWalk {
  kind: "table" | "stream" | "none";
  /** Healthy enough to trust (chain parsed, sampled offsets valid, root found). */
  ok: boolean;
  reason: string | null;
  rootRef: { num: number; gen: number } | null;
  encrypted: boolean;
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

/** latin1 string span → bytes. */
function latin1BytesOf(s: string, from: number, to: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, to - from));
  for (let i = 0; i < out.length; i += 1) out[i] = s.charCodeAt(from + i) & 0xff;
  return out;
}

/** Parses an xref STREAM object (PDF 1.5+) at `at` ("N G obj" is there). */
function parseXrefStream(
  s: string,
  at: number
): {
  entries: Map<number, { offset: number; gen: number }>;
  rootRef: { num: number; gen: number } | null;
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
      raw = inflateSync(raw);
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
        // Compressed object inside an object stream — no byte offset.
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
  return { entries, rootRef, prev, end: obj.streamEnd };
}

/** Walks the xref chain from the last startxref (newest revision first). */
function walkXref(s: string): { xref: XrefWalk; offsets: Map<number, number> } {
  const xref: XrefWalk = { kind: "none", ok: false, reason: null, rootRef: null, encrypted: false };
  const offsets = new Map<number, number>();
  const sxIdx = s.lastIndexOf("startxref");
  if (sxIdx < 0) {
    xref.reason = "no startxref marker";
    return { xref, offsets };
  }
  // Producers put whitespace (a newline) between the keyword and the
  // offset — pdf-lib, Acrobat, everyone. Skip it before reading digits.
  const digitsAt = skipWs(s, sxIdx + 9);
  const numMatch = /^[0-9]{1,10}/.exec(s.slice(digitsAt, digitsAt + 10));
  if (numMatch === null) {
    xref.reason = "startxref has no offset";
    return { xref, offsets };
  }
  let at = Number.parseInt(numMatch[0], 10);
  if (at <= 0 || at >= s.length) {
    xref.reason = `startxref offset ${at} out of bounds`;
    return { xref, offsets };
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
  return { xref, offsets };
}

/* ---- the whole walk ---------------------------------------------- */

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
 * with /Prev chaining + xref streams, FlateDecode via fflate), and a
 * linear "N G obj" scan (the repair-pdf recovery precedent) whose
 * last-wins object table is the analysis source of truth. `recoveryUsed`
 * is honestly reported whenever the xref chain was unusable.
 */
export function walkPdf(s: string, bytes: Uint8Array): PdfWalk {
  const headerOffset = s.indexOf("%PDF-");
  const { xref, offsets } = walkXref(s);

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
  if (objects.size === 0 && offsets.size > 0) {
    for (const [num, off] of offsets) {
      if (off < 0) continue;
      const obj = parseObjectAt(s, off);
      if (obj !== null && obj.num === num) objects.set(num, obj);
    }
  }

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

/* ---- resolvers ---------------------------------------------------- */

interface WalkResolvers {
  resolve(v: PdfVal | undefined): PdfVal | undefined;
  dict(v: PdfVal | undefined): PdfDictVal | undefined;
  arr(v: PdfVal | undefined): PdfArrVal | undefined;
  name(v: PdfVal | undefined): string | null;
  text(v: PdfVal | undefined): string | null;
  str(v: PdfVal | undefined): PdfStrVal | null;
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
    str: (v) => {
      const r = resolve(v);
      return r !== undefined && r.k === "str" ? r : null;
    },
  };
}

/* ---- page tree ---------------------------------------------------- */

/** Page object numbers in reading order (empty when unreadable). */
function collectPages(walk: PdfWalk): number[] {
  const { dict, arr } = makeResolvers(walk);
  const pages: number[] = [];
  if (walk.catalog === null) return pages;
  const pagesDict = dict(walk.catalog.map.get("Pages"));
  if (pagesDict === undefined) return pages;
  const walkTree = (node: PdfDictVal, depth: number): void => {
    if (depth > MAX_TREE_DEPTH || pages.length >= MAX_TREE_LEAVES) return;
    const kids = arr(node.map.get("Kids"));
    if (kids === undefined) {
      pages.push(-1); // malformed leaf slot (kept for count honesty)
      return;
    }
    for (const kid of kids.items) {
      if (pages.length >= MAX_TREE_LEAVES) break;
      const kidDict = dict(kid);
      if (kidDict === undefined) continue;
      const type = kidDict.map.get("Type");
      const typeName = type !== undefined && type.k === "name" ? type.name : null;
      if (typeName === "Pages") {
        walkTree(kidDict, depth + 1);
      } else if (typeName === "Page" || kidDict.map.has("MediaBox") || !kidDict.map.has("Kids")) {
        pages.push(kid.k === "ref" ? kid.num : -1);
      }
    }
  };
  walkTree(pagesDict, 0);
  return pages;
}

/* ---- /AcroForm → /FT /Sig fields ---------------------------------- */

export interface RawSigField {
  fieldName: string | null;
  /** 1-based widget page (null when unknown). */
  page: number | null;
  rect: number[] | null;
  /** The resolved /V dictionary. */
  vDict: PdfDictVal;
  /** Object number of the field (widget search key; -1 when direct). */
  fieldNum: number;
}

export interface FieldScan {
  signed: RawSigField[];
  unsigned: UnsignedFieldInfo[];
}

/**
 * collectSigFields — walks /AcroForm /Fields (with /Parent-inherited /FT
 * and one widget-kid level) and splits the /FT /Sig fields into signed
 * (/V with /Contents or /ByteRange) and unsigned (never completed).
 */
export function collectSigFields(walk: PdfWalk): FieldScan {
  const { dict, arr, str } = makeResolvers(walk);
  const scan: FieldScan = { signed: [], unsigned: [] };
  if (walk.catalog === null) return scan;
  const acro = dict(walk.catalog.map.get("AcroForm"));
  if (acro === undefined) return scan;
  const fieldsArr = arr(acro.map.get("Fields"));
  if (fieldsArr === undefined) return scan;

  const pages = collectPages(walk);
  const pageIndexByNum = new Map<number, number>();
  pages.forEach((num, i) => {
    if (num >= 0 && !pageIndexByNum.has(num)) pageIndexByNum.set(num, i);
  });

  const fieldPage = (fieldDict: PdfDictVal, fieldNum: number, kidNums: number[]): number | null => {
    const pVal = fieldDict.map.get("P");
    if (pVal !== undefined && pVal.k === "ref") {
      const idx = pageIndexByNum.get(pVal.num);
      if (idx !== undefined) return idx + 1;
    }
    const candidates = [fieldNum, ...kidNums];
    for (const [num, idx] of pageIndexByNum) {
      const pageObj = walk.objects.get(num);
      if (pageObj === undefined || pageObj.value === null || pageObj.value.k !== "dict") continue;
      const annots = arr(pageObj.value.map.get("Annots"));
      if (annots === undefined) continue;
      for (const a of annots.items) {
        if (a.k === "ref" && candidates.includes(a.num)) return idx + 1;
      }
    }
    return null;
  };

  const seen = new Set<number>();
  const visit = (fieldVal: PdfVal | undefined, inheritedFt: string | null, depth: number): void => {
    if (depth > 8 || scan.signed.length + scan.unsigned.length >= MAX_FIELDS) return;
    const fieldDict = dict(fieldVal);
    if (fieldDict === undefined) return;
    let fieldNum = -1;
    if (fieldVal !== undefined && fieldVal.k === "ref") {
      fieldNum = fieldVal.num;
      if (seen.has(fieldNum)) return;
      seen.add(fieldNum);
    }
    const ftVal = fieldDict.map.get("FT");
    const ft = ftVal !== undefined && ftVal.k === "name" ? ftVal.name : inheritedFt;

    const kidsVal = fieldDict.map.get("Kids");
    const kids = arr(kidsVal);
    const kidNums: number[] = [];
    if (kids !== undefined) {
      for (const kid of kids.items) {
        if (kid.k === "ref") kidNums.push(kid.num);
      }
    }

    if (ft === "Sig") {
      // A signature field has no children (PDF 32000-1 §12.7.4.5); its
      // /Kids, if any, are mere widget annotations.
      let rectDict = fieldDict;
      if (!fieldDict.map.has("Rect") && kids !== undefined && kids.items.length > 0) {
        const firstKid = dict(kids.items[0]);
        if (firstKid !== undefined && firstKid.map.has("Rect")) rectDict = firstKid;
      }
      const rectArr = arr(rectDict.map.get("Rect"));
      const rect =
        rectArr !== undefined && rectArr.items.length === 4
          ? rectArr.items.map((it) => (it.k === "num" ? it.num : 0))
          : null;
      const nameVal = str(fieldDict.map.get("T"));
      const fieldName = nameVal !== null ? nameVal.text : null;
      const page = fieldPage(fieldDict, fieldNum, kidNums);
      const vDict = dict(fieldDict.map.get("V"));
      const hasContents =
        vDict !== undefined && (vDict.map.has("Contents") || vDict.map.has("ByteRange"));
      if (vDict !== undefined && hasContents) {
        scan.signed.push({ fieldName, page, rect, vDict, fieldNum });
      } else {
        scan.unsigned.push({ fieldName, page });
      }
      return;
    }

    // Non-Sig (or unknown) node: walk its kids with the inherited /FT.
    if (kids !== undefined) {
      for (const kid of kids.items) {
        const kidDict = dict(kid);
        if (kidDict === undefined) continue;
        visit(kid, ft, depth + 1);
      }
    }
  };

  for (const fieldVal of fieldsArr.items) visit(fieldVal, null, 0);
  return scan;
}

/* ================================================================== */
/* PART 6 — PDF date decode (/M)                                       */
/* ================================================================== */

/** D:YYYYMMDDHHmmSSOHH'mm' → ISO-ish UTC + epoch ms (null when junk). */
export function decodePdfDate(raw: string): { iso: string | null; ms: number | null } {
  let t = raw.trim();
  if (t.startsWith("D:")) t = t.slice(2);
  const m = /^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([+\-Zz])?(\d{2})?'?(\d{2})?'?/.exec(t);
  if (m === null) return { iso: null, ms: null };
  const year = Number.parseInt(m[1], 10);
  const month = m[2] !== undefined ? Number.parseInt(m[2], 10) : 1;
  const day = m[3] !== undefined ? Number.parseInt(m[3], 10) : 1;
  const hour = m[4] !== undefined ? Number.parseInt(m[4], 10) : 0;
  const minute = m[5] !== undefined ? Number.parseInt(m[5], 10) : 0;
  const second = m[6] !== undefined ? Number.parseInt(m[6], 10) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
    return { iso: null, ms: null };
  }
  let ms = Date.UTC(year, month - 1, day, hour, minute, second === 60 ? 59 : second);
  const zone = m[7];
  if (zone !== undefined && zone !== "Z" && zone !== "z" && m[8] !== undefined) {
    const sign = zone === "-" ? -1 : 1;
    const zh = Number.parseInt(m[8], 10);
    const zm = m[9] !== undefined ? Number.parseInt(m[9], 10) : 0;
    ms -= sign * (zh * 60 + zm) * 60_000;
  }
  if (!Number.isFinite(ms)) return { iso: null, ms: null };
  return { iso: formatUtc(ms), ms };
}

/* ================================================================== */
/* PART 7 — tamper detection + crypto verify                          */
/* ================================================================== */

export interface ByteRangeInfo {
  range: [number, number, number, number] | null;
  malformedReason: string | null;
}

/** Reads and sanity-checks /ByteRange (4 integer entries, non-negative). */
export function readByteRange(
  vDict: PdfDictVal,
  arr: (v: PdfVal | undefined) => PdfArrVal | undefined
): ByteRangeInfo {
  const br = arr(vDict.map.get("ByteRange"));
  if (br === undefined) {
    return { range: null, malformedReason: "/ByteRange missing" };
  }
  const nums: number[] = [];
  for (const it of br.items) {
    if (it.k !== "num" || !Number.isInteger(it.num)) {
      return {
        range: null,
        malformedReason: `/ByteRange has a non-integer entry (${br.items.length} entries)`,
      };
    }
    nums.push(it.num);
  }
  if (nums.length !== 4) {
    return { range: null, malformedReason: `/ByteRange has ${nums.length} entries, expected 4` };
  }
  if (nums.some((x) => x < 0)) {
    return { range: null, malformedReason: "/ByteRange entries negative" };
  }
  return { range: [nums[0], nums[1], nums[2], nums[3]], malformedReason: null };
}

/** Concatenates the two covered ranges (excluding the /Contents gap). */
export function coveredBytes(
  bytes: Uint8Array,
  range: [number, number, number, number]
): Uint8Array | null {
  const [a, b, c, d] = range;
  if (a + b > bytes.length || c + d > bytes.length || c < a + b) return null;
  const out = new Uint8Array(b + d);
  out.set(bytes.subarray(a, a + b), 0);
  out.set(bytes.subarray(c, c + d), b);
  return out;
}

async function digestBytes(data: Uint8Array, hashName: string): Promise<Uint8Array | null> {
  try {
    const buf = await crypto.subtle.digest(hashName, data as unknown as ArrayBuffer);
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/**
 * RSASSA-PKCS1-v1_5 verify over `data` with a raw SPKI DER key.
 * Returns null when WebCrypto could not process (unsupported key etc.).
 */
export async function verifyRsaPkcs1(
  spkiDer: Uint8Array,
  hashName: string,
  signature: Uint8Array,
  data: Uint8Array
): Promise<boolean | null> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      spkiDer as unknown as ArrayBuffer,
      { name: "RSASSA-PKCS1-v1_5", hash: hashName },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature as unknown as ArrayBuffer,
      data as unknown as ArrayBuffer
    );
  } catch {
    return null;
  }
}

/* ================================================================== */
/* PART 8 — the analysis (per signature card)                         */
/* ================================================================== */

function certSummaryOf(cert: CertParsed, now: number): CertSummary {
  let validityNow: CertSummary["validityNow"] = null;
  if (cert.notBefore.ms !== null && cert.notAfter.ms !== null) {
    validityNow =
      now < cert.notBefore.ms ? "not-yet-valid" : now > cert.notAfter.ms ? "expired" : "valid";
  }
  return {
    commonName: cert.subject.cn,
    organization: cert.subject.o,
    organizationalUnit: cert.subject.ou,
    country: cert.subject.c,
    email: cert.subject.email,
    serialHex: cert.serialHex.length > 0 ? `0x${cert.serialHex}` : "0x00",
    issuerCommonName: cert.issuerCn,
    notBeforeIso: cert.notBefore.iso,
    notAfterIso: cert.notAfter.iso,
    validityNow,
    selfSigned: cert.selfSigned,
  };
}

/** Matches a SignerInfo sid (issuerAndSerialNumber) against the CMS certs. */
function matchCert(cms: CmsParsed, signer: CmsSigner): { cert: CertParsed | null; sidMatched: boolean | null } {
  if (
    signer.sidKind === "issuerAndSerial" &&
    signer.sidIssuerDer !== null &&
    signer.sidSerialBytes !== null
  ) {
    const wantSerial = normalizeIntBytes(signer.sidSerialBytes);
    for (const cert of cms.certs) {
      if (!bytesEqual(normalizeIntBytes(cert.serialBytes), wantSerial)) continue;
      if (bytesEqual(cert.issuerDer, signer.sidIssuerDer)) {
        return { cert, sidMatched: true };
      }
    }
  }
  // Honest fallback: a lone certificate with no sid match (or a ski sid).
  if (cms.certs.length === 1) {
    return { cert: cms.certs[0], sidMatched: false };
  }
  return { cert: null, sidMatched: signer.sidKind === "none" ? null : false };
}

/** Analyzes one signed field → a SignatureCard (async: WebCrypto). */
async function analyzeSignedField(
  walk: PdfWalk,
  field: RawSigField,
  now: number
): Promise<SignatureCard> {
  const { arr, text, str } = makeResolvers(walk);
  const vDict = field.vDict;
  const card: SignatureCard = {
    index: 0,
    fieldName: field.fieldName,
    status: "valid",
    tone: "green",
    noteKeys: [],
    noteTech: [],
    filter: text(vDict.map.get("Filter")),
    subFilter: text(vDict.map.get("SubFilter")),
    signerName: text(vDict.map.get("Name")),
    pdfMTimeIso: null,
    reason: text(vDict.map.get("Reason")),
    location: text(vDict.map.get("Location")),
    page: field.page,
    rect: field.rect,
    byteRange: null,
    cmsSize: null,
    trailingBytes: null,
    modifiedAfterSigning: null,
    signers: [],
  };
  const mVal = str(vDict.map.get("M"));
  if (mVal !== null) {
    card.pdfMTimeIso = decodePdfDate(mVal.text).iso;
  }

  const fail = (key: string, tech: string): SignatureCard => {
    card.status = "invalid";
    card.tone = "red";
    card.noteKeys.push(key);
    card.noteTech.push(tech);
    return card;
  };

  /* ---- /ByteRange ---- */
  const br = readByteRange(vDict, arr);
  if (br.range === null) {
    return fail("vps.nByteRangeBad", br.malformedReason ?? "?");
  }
  const range = br.range;
  card.byteRange = [...range];
  const covered = coveredBytes(walk.bytes, range);
  if (covered === null) {
    return fail(
      "vps.nRangeBounds",
      `/ByteRange [${range.join(" ")}] exceeds the ${walk.bytes.length}-byte file`
    );
  }
  if (range[0] !== 0) {
    card.noteKeys.push("vps.nFrontGap");
    card.noteTech.push(`first range starts at byte ${range[0]}`);
  }

  /* ---- /Contents (hex → CMS DER) ---- */
  const contentsVal = str(vDict.map.get("Contents"));
  if (contentsVal === null) {
    return fail("vps.nContentsBad", "/Contents is not a string");
  }
  if (!contentsVal.hex) {
    return fail("vps.nContentsBad", "/Contents is a literal string, not a hex string");
  }
  const decoded = decodeHexStrict(contentsVal.text);
  if (decoded.bytes === null || decoded.error !== null) {
    return fail("vps.nContentsBad", `/Contents hex invalid: ${decoded.error ?? "?"}`);
  }
  if (decoded.bytes.length === 0) {
    return fail("vps.nContentsBad", "/Contents is empty");
  }
  card.cmsSize = decoded.bytes.length;

  /* Gap alignment: the /Contents hex must sit inside the excluded gap. */
  const gapStart = contentsVal.pos;
  const gapEnd = contentsVal.end;
  const range1End = range[0] + range[1];
  if (gapStart < range1End || gapEnd > range[2]) {
    card.noteKeys.push("vps.nGapMismatch");
    card.noteTech.push(
      `hex gap [${gapStart}, ${gapEnd}) vs range1 end ${range1End}, range2 start ${range[2]}`
    );
  }

  /* ---- CMS parse ---- */
  const cms = parseCms(decoded.bytes);
  if (cms.parseError !== null) {
    return fail("vps.nCmsBad", cms.parseError);
  }
  if (cms.signers.length === 0) {
    return fail("vps.nNoSigner", "signerInfos SET is empty");
  }
  if (cms.eContentPresent) {
    card.noteKeys.push("vps.nAttached");
    card.noteTech.push("encapContentInfo carries an eContent");
  }

  /* ---- per SignerInfo ---- */
  let primaryCert: CertParsed | null = null;
  let primaryTimeMs: number | null = null;
  let primaryDigestName: string | null = null;
  for (let si = 0; si < cms.signers.length; si += 1) {
    const signer = cms.signers[si];
    const analysis: SignerAnalysis = {
      digestAlgo: null,
      digestHashName: null,
      signatureAlgo: null,
      cryptoVerified: null,
      cryptoNoteKey: null,
      messageDigestHex: null,
      computedDigestHex: null,
      integrity: null,
      signingTimeIso: null,
      contentTypeOid: null,
      cert: null,
      sidMatched: null,
    };
    const digestInfo = digestInfoFor(signer.digestOid);
    const sigInfo = sigAlgoInfoFor(signer.signatureOid);
    if (digestInfo !== null) {
      analysis.digestAlgo = digestInfo.name;
      analysis.digestHashName = digestInfo.hash;
    } else {
      analysis.digestAlgo = signer.digestOid ?? "(unknown OID)";
    }
    analysis.signatureAlgo = sigInfo !== null ? sigInfo.name : (signer.signatureOid ?? "(unknown OID)");

    const { cert, sidMatched } = matchCert(cms, signer);
    analysis.sidMatched = sidMatched;
    if (cert !== null) analysis.cert = certSummaryOf(cert, now);

    /* integrity: recompute the digest over the covered bytes */
    const hashName = digestInfo?.hash ?? sigInfo?.hash ?? null;
    if (hashName !== null && signer.signedAttrs !== null && signer.signedAttrs.messageDigest !== null) {
      const computed = await digestBytes(covered, hashName);
      analysis.messageDigestHex = bytesToHex(signer.signedAttrs.messageDigest);
      analysis.signingTimeIso = signer.signedAttrs.signingTime.iso;
      analysis.contentTypeOid = signer.signedAttrs.contentTypeOid;
      if (computed === null) {
        analysis.integrity = "unknown";
      } else {
        analysis.computedDigestHex = bytesToHex(computed);
        analysis.integrity = bytesEqual(computed, signer.signedAttrs.messageDigest)
          ? "intact"
          : "tampered";
      }
    } else {
      analysis.integrity = "unknown";
      if (signer.signedAttrs === null) {
        card.noteKeys.push("vps.nNoSignedAttrs");
      } else if (signer.signedAttrs.messageDigest === null) {
        card.noteKeys.push("vps.nNoSignedAttrs");
        card.noteTech.push("signedAttrs present but no messageDigest attribute");
      } else {
        card.noteKeys.push("vps.nUnsupportedDigest");
        card.noteTech.push(
          `digest OID ${signer.digestOid ?? "?"} not in the SHA-1/256/384/512 set`
        );
      }
    }

    /* crypto: verify the signature over the re-tagged signedAttrs DER */
    if (cert !== null && cert.spkiDer !== null && signer.signature !== null) {
      const verifyHash = sigInfo !== null && sigInfo.hash !== null ? sigInfo.hash : hashName;
      if (verifyHash === null) {
        analysis.cryptoNoteKey = "vps.nUnsupportedDigest";
        card.noteTech.push(
          `no hash derivable (digest ${signer.digestOid ?? "?"}, signature ${signer.signatureOid ?? "?"})`
        );
      } else {
        const data = signer.signedAttrs !== null ? signer.signedAttrs.retaggedDer : covered;
        const ok = await verifyRsaPkcs1(cert.spkiDer, verifyHash, signer.signature, data);
        analysis.cryptoVerified = ok;
        if (ok === null) analysis.cryptoNoteKey = "vps.nVerifyError";
      }
    } else if (cert === null) {
      analysis.cryptoNoteKey = "vps.nNoSidCert";
    } else if (signer.signature === null) {
      analysis.cryptoNoteKey = "vps.nCmsBad";
      card.noteTech.push("SignerInfo carries no signature OCTET STRING");
    }
    card.signers.push(analysis);
    if (si === 0) {
      primaryCert = cert;
      primaryDigestName = analysis.digestAlgo;
      if (signer.signedAttrs !== null) primaryTimeMs = signer.signedAttrs.signingTime.ms;
    }
  }

  /* ---- notes that depend on the primary signer ---- */
  if (primaryCert !== null) {
    if (primaryCert.notBefore.ms !== null && primaryCert.notAfter.ms !== null) {
      if (card.signers[0].cert !== null) {
        if (card.signers[0].cert.validityNow === "expired") card.noteKeys.push("vps.nExpired");
        if (card.signers[0].cert.validityNow === "not-yet-valid") card.noteKeys.push("vps.nNotYetValid");
      }
      if (
        primaryTimeMs !== null &&
        (primaryTimeMs < primaryCert.notBefore.ms || primaryTimeMs > primaryCert.notAfter.ms)
      ) {
        card.noteKeys.push("vps.nSignTimeOutside");
      }
    }
    if (primaryCert.selfSigned) card.noteKeys.push("vps.nSelfSigned");
  }
  if (primaryDigestName === "SHA-1") card.noteKeys.push("vps.nWeakDigest");
  if (
    card.signers[0].signingTimeIso !== null &&
    card.pdfMTimeIso !== null &&
    card.signers[0].signingTimeIso !== card.pdfMTimeIso
  ) {
    card.noteKeys.push("vps.nTimeMismatch");
    card.noteTech.push(`signedAttrs ${card.signers[0].signingTimeIso} vs /M ${card.pdfMTimeIso}`);
  }

  /* ---- coverage: modified after signing? ---- */
  const coveredEnd = range[2] + range[3];
  const trailing = walk.bytes.length - coveredEnd;
  card.trailingBytes = trailing;
  if (trailing > 0) {
    const tail = walk.bytes.subarray(coveredEnd);
    let allWs = true;
    for (const b of tail) {
      if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x00) {
        allWs = false;
        break;
      }
    }
    card.modifiedAfterSigning = !(allWs && trailing <= 16);
    if (card.modifiedAfterSigning) {
      card.noteKeys.push("vps.nModified");
      card.noteTech.push(`${trailing} bytes follow the covered ranges`);
    }
  } else {
    card.modifiedAfterSigning = false;
  }

  /* ---- verdict ---- */
  const anyTampered = card.signers.some((sg) => sg.integrity === "tampered");
  const anyCryptoFail = card.signers.some((sg) => sg.cryptoVerified === false);
  // cryptoVerified === null (no usable signer certificate, no signature
  // OCTET STRING, unsupported key, WebCrypto error) is NOT "valid": the
  // model's own contract says valid means the signature verifies
  // cryptographically — an unproven signature is amber, never green.
  const anyCryptoUnproven = card.signers.some((sg) => sg.cryptoVerified !== true);
  if (anyTampered || anyCryptoFail) {
    card.status = "invalid";
    card.tone = "red";
  } else if (card.noteKeys.length > 0 || anyCryptoUnproven) {
    card.status = "attention";
    card.tone = "amber";
  } else {
    card.status = "valid";
    card.tone = "green";
  }
  return card;
}

/**
 * analyzeSignatures — the whole verification: walk, collect, analyze.
 * Throws VerifyError for the fatal gates (not a PDF / too big /
 * encrypted); a PDF with no signatures is an EMPTY report, never an
 * error.
 */
export async function analyzeSignatures(
  bytes: Uint8Array,
  now: number = Date.now()
): Promise<SignatureReport> {
  if (bytes.length > MAX_INPUT_BYTES) {
    throw new VerifyError("errTooBig", `${bytes.length} bytes`);
  }
  if (!sniffPdfBytes(bytes)) {
    throw new VerifyError("errNotPdf", "no %PDF- magic");
  }
  const s = toLatin(bytes);
  const walk = walkPdf(s, bytes);
  if (walk.xref.encrypted) {
    throw new VerifyError("errEncrypted", "/Encrypt present in trailer");
  }
  const scan = collectSigFields(walk);
  const signatures: SignatureCard[] = [];
  for (const field of scan.signed) {
    const card = await analyzeSignedField(walk, field, now);
    card.index = signatures.length + 1;
    signatures.push(card);
  }
  return {
    pageCount: collectPages(walk).length,
    signatures,
    unsignedFields: scan.unsigned,
    recoveryUsed: walk.recoveryUsed,
    recoveryReason: walk.xref.reason,
  };
}

/* ================================================================== */
/* PART 9 — the plain-text report (validate-e-invoice pattern)        */
/* ================================================================== */

/** English fallback labels (label-less runs still get a sane report). */
export const REPORT_LABELS_EN: ReportLabels = {
  "vps.title": "PDF signature verification report",
  "vps.file": "File",
  "vps.docLine": "Document",
  "vps.pages": "pages",
  "vps.rFields": "signature fields",
  "vps.xref": "xref",
  "vps.recovery": "Recovery",
  "vps.rSummary": "SUMMARY",
  "vps.rSignature": "SIGNATURE",
  "vps.rUnsigned": "UNSIGNED SIGNATURE FIELDS",
  "vps.rField": "Field",
  "vps.rPage": "Page",
  "vps.rPageUnknown": "page unknown",
  "vps.rVerdict": "Verdict",
  "vps.rSigner": "Signer",
  "vps.rOrg": "Organization",
  "vps.rSerial": "Certificate serial",
  "vps.rIssuer": "Issuer",
  "vps.rValidity": "Certificate validity",
  "vps.rSignTime": "Signing time",
  "vps.rMTime": "PDF /M time",
  "vps.rReason": "Reason",
  "vps.rLocation": "Location",
  "vps.rFormat": "Format",
  "vps.rDigest": "Digest",
  "vps.rCrypto": "Cryptographic verification",
  "vps.rIntegrity": "Document integrity",
  "vps.rModified": "Modified after signing",
  "vps.rTrailing": "trailing bytes",
  "vps.rNotes": "Notes",
  "vps.vValid": "VALID",
  "vps.vAttention": "ATTENTION",
  "vps.vInvalid": "INVALID",
  "vps.cPass": "PASS",
  "vps.cFail": "FAIL",
  "vps.cNotVerified": "NOT VERIFIED",
  "vps.iIntact": "INTACT — computed digest matches messageDigest",
  "vps.iTampered": "TAMPERED — content differs from what was signed",
  "vps.iUnknown": "UNKNOWN — no messageDigest to compare",
  "vps.yYes": "yes",
  "vps.yNo": "no",
  "vps.wValidNow": "valid now",
  "vps.wExpired": "EXPIRED",
  "vps.wNotYet": "NOT YET VALID",
  "vps.wSelfSigned": "self-signed",
  "vps.wUnsigned": "never signed",
  "vps.cValid": "valid",
  "vps.cAttention": "attention",
  "vps.cInvalid": "invalid",
  "vps.cSigned": "signed",
  "vps.cUnsigned": "unsigned",
  "vps.empty": "No signature fields found — this PDF carries no digital signature.",
  "vps.nByteRangeBad": "The /ByteRange entry is missing or malformed — the covered byte ranges cannot be established.",
  "vps.nRangeBounds": "The /ByteRange entries point outside the file.",
  "vps.nContentsBad": "The /Contents entry is not a valid hex string — the CMS signature container cannot be read.",
  "vps.nCmsBad": "The CMS (PKCS#7 SignedData) could not be parsed from /Contents.",
  "vps.nNoSigner": "The CMS contains no SignerInfo — nobody actually signed.",
  "vps.nNoSidCert": "The signer's certificate was not found in the signature's certificate set — the signature could not be cryptographically verified.",
  "vps.nUnsupportedDigest": "The digest algorithm is outside this tool's set (SHA-1/256/384/512) — integrity could not be recomputed.",
  "vps.nModified": "Bytes were added after the signature's covered ranges end — the file was modified after signing.",
  "vps.nSelfSigned": "The certificate is self-signed: cryptographically valid, but not chained to any trusted authority (none was checked).",
  "vps.nExpired": "The certificate's validity window has ended at the time of checking.",
  "vps.nNotYetValid": "The certificate was not yet valid at the time of checking.",
  "vps.nWeakDigest": "SHA-1 digest — processed, but considered weak for new signatures.",
  "vps.nSignTimeOutside": "The claimed signing time lies outside the certificate's validity window.",
  "vps.nTimeMismatch": "The PDF /M time and the signedAttrs signingTime disagree.",
  "vps.nGapMismatch": "The /Contents position does not line up with the /ByteRange gap — unusual producer.",
  "vps.nFrontGap": "The first byte range does not start at 0 — leading bytes are not covered by the signature.",
  "vps.nAttached": "The CMS is not detached — its integrity relationship to the PDF bytes cannot be checked by digest comparison.",
  "vps.nNoSignedAttrs": "No signedAttrs in the SignerInfo — the messageDigest integrity check is unavailable (the signature covers the content directly).",
  "vps.nVerifyError": "WebCrypto could not process the signature (unsupported key type or encoding).",
  "vps.generatedBy": "Generated on-device by MyCloudy — nothing was uploaded.",
  "vps.honestyTitle": "NOT CHECKED (honesty)",
  "vps.honestyBody":
    "No CRL/OCSP revocation check, no chain-of-trust validation, no timestamp (TSA) verification and no PAdES long-term validation were performed — there is no trust store on this device to check against. A self-signed certificate shows as untrusted-but-valid. A verdict of VALID means exactly: the signature verifies cryptographically, the signed byte ranges are intact and the coverage is complete — nothing more.",
};

const L = (labels: ReportLabels, key: string): string =>
  labels[key] ?? REPORT_LABELS_EN[key] ?? key;

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * buildReportText — the honest plain-text verification report.
 * Deterministic (no timestamps — byte-identical for the same input).
 */
export function buildReportText(
  report: SignatureReport,
  meta: ReportMeta,
  labels: ReportLabels
): string {
  const out: string[] = [];
  out.push("=".repeat(64));
  out.push(`MyCloudy — ${L(labels, "vps.title")}`);
  out.push("=".repeat(64));
  out.push(`${L(labels, "vps.file")}: ${meta.fileName} (${humanBytes(meta.bytes)})`);

  const nValid = report.signatures.filter((sg) => sg.status === "valid").length;
  const nAttention = report.signatures.filter((sg) => sg.status === "attention").length;
  const nInvalid = report.signatures.filter((sg) => sg.status === "invalid").length;
  const parts: string[] = [];
  if (report.pageCount !== null && report.pageCount > 0) {
    parts.push(`${report.pageCount} ${L(labels, "vps.pages")}`);
  }
  if (report.signatures.length + report.unsignedFields.length > 0) {
    parts.push(
      `${report.signatures.length + report.unsignedFields.length} ${L(labels, "vps.rFields")}` +
        ` (${report.signatures.length} ${L(labels, "vps.cSigned")}` +
        `, ${report.unsignedFields.length} ${L(labels, "vps.cUnsigned")})`
    );
  }
  if (parts.length > 0) out.push(`${L(labels, "vps.docLine")}: ${parts.join(" · ")}`);
  out.push(
    `${L(labels, "vps.xref")}: ${report.recoveryUsed ? "recovery (linear object scan)" : "ok"}`
  );
  if (report.recoveryUsed && report.recoveryReason !== null) {
    out.push(`${L(labels, "vps.recovery")}: ${report.recoveryReason}`);
  }
  out.push("");

  out.push(`${L(labels, "vps.rSummary")}: ${report.signatures.length}`);
  out.push(
    `  ${nValid} ${L(labels, "vps.cValid")}, ${nAttention} ${L(labels, "vps.cAttention")}, ${nInvalid} ${L(labels, "vps.cInvalid")}`
  );
  out.push("");

  if (report.signatures.length === 0 && report.unsignedFields.length === 0) {
    out.push(L(labels, "vps.empty"));
    out.push("");
  }

  for (const sg of report.signatures) {
    const head =
      `── ${L(labels, "vps.rSignature")} ${sg.index}` +
      `${sg.fieldName !== null ? ` — ${sg.fieldName}` : ""} ` +
      `(${sg.page !== null ? `${L(labels, "vps.rPage")} ${sg.page}` : L(labels, "vps.rPageUnknown")}) `;
    out.push(head + "─".repeat(Math.max(0, 62 - head.length)));
    const vWord =
      sg.status === "valid"
        ? L(labels, "vps.vValid")
        : sg.status === "attention"
          ? L(labels, "vps.vAttention")
          : L(labels, "vps.vInvalid");
    out.push(`${L(labels, "vps.rVerdict")}: ${vWord}`);
    const p = sg.signers[0];
    if (p !== undefined) {
      if (p.cert !== null) {
        if (p.cert.commonName !== null) out.push(`${L(labels, "vps.rSigner")}: ${p.cert.commonName}`);
        if (p.cert.organization !== null) {
          out.push(`${L(labels, "vps.rOrg")}: ${p.cert.organization}`);
        }
        out.push(`${L(labels, "vps.rSerial")}: ${p.cert.serialHex}`);
        if (p.cert.issuerCommonName !== null) {
          out.push(
            `${L(labels, "vps.rIssuer")}: ${p.cert.issuerCommonName}` +
              `${p.cert.selfSigned === true ? ` (${L(labels, "vps.wSelfSigned")})` : ""}`
          );
        }
        if (p.cert.notBeforeIso !== null && p.cert.notAfterIso !== null) {
          const state =
            p.cert.validityNow === "expired"
              ? ` (${L(labels, "vps.wExpired")})`
              : p.cert.validityNow === "not-yet-valid"
                ? ` (${L(labels, "vps.wNotYet")})`
                : ` (${L(labels, "vps.wValidNow")})`;
          out.push(
            `${L(labels, "vps.rValidity")}: ${p.cert.notBeforeIso} → ${p.cert.notAfterIso}${state}`
          );
        }
      }
      if (p.signingTimeIso !== null) {
        out.push(`${L(labels, "vps.rSignTime")}: ${p.signingTimeIso} (signedAttrs)`);
      }
      out.push(`${L(labels, "vps.rDigest")}: ${p.digestAlgo ?? "?"}`);
      out.push(
        `${L(labels, "vps.rCrypto")}: ` +
          `${p.cryptoVerified === true ? L(labels, "vps.cPass") : p.cryptoVerified === false ? L(labels, "vps.cFail") : L(labels, "vps.cNotVerified")}` +
          `${p.signatureAlgo !== null ? ` (${p.signatureAlgo})` : ""}`
      );
      out.push(
        `${L(labels, "vps.rIntegrity")}: ` +
          `${p.integrity === "intact" ? L(labels, "vps.iIntact") : p.integrity === "tampered" ? L(labels, "vps.iTampered") : L(labels, "vps.iUnknown")}`
      );
      if (sg.signers.length > 1) {
        out.push(`  + ${sg.signers.length - 1} more signer(s) in this CMS`);
      }
    }
    if (sg.pdfMTimeIso !== null) out.push(`${L(labels, "vps.rMTime")}: ${sg.pdfMTimeIso}`);
    if (sg.signerName !== null && sg.signerName.length > 0) {
      out.push(`/Name: ${sg.signerName}`);
    }
    if (sg.reason !== null && sg.reason.length > 0) {
      out.push(`${L(labels, "vps.rReason")}: ${sg.reason}`);
    }
    if (sg.location !== null && sg.location.length > 0) {
      out.push(`${L(labels, "vps.rLocation")}: ${sg.location}`);
    }
    if (sg.filter !== null || sg.subFilter !== null) {
      out.push(`${L(labels, "vps.rFormat")}: ${sg.filter ?? "?"} / ${sg.subFilter ?? "?"}`);
    }
    out.push(
      `${L(labels, "vps.rModified")}: ${sg.modifiedAfterSigning === true ? L(labels, "vps.yYes") : L(labels, "vps.yNo")} (${sg.trailingBytes ?? 0} ${L(labels, "vps.rTrailing")})`
    );
    if (sg.byteRange !== null) {
      out.push(`  /ByteRange: [${sg.byteRange.join(" ")}] · /Contents: ${sg.cmsSize ?? 0} B`);
    }
    if (sg.noteKeys.length > 0) {
      out.push(`${L(labels, "vps.rNotes")}:`);
      for (const key of sg.noteKeys) out.push(`  - ${L(labels, key)}`);
      for (const tech of sg.noteTech) out.push(`    (${tech})`);
    }
    out.push("");
  }

  if (report.unsignedFields.length > 0) {
    out.push(L(labels, "vps.rUnsigned"));
    for (const f of report.unsignedFields) {
      out.push(
        `  - ${f.fieldName ?? "(nameless)"} (` +
          `${f.page !== null ? `${L(labels, "vps.rPage")} ${f.page}` : L(labels, "vps.rPageUnknown")}` +
          `) — ${L(labels, "vps.wUnsigned")}`
      );
    }
    out.push("");
  }

  out.push(L(labels, "vps.honestyTitle"));
  out.push(
    L(labels, "vps.honestyBody")
      .match(/.{1,62}(\s|$)/g)
      ?.join("\n") ?? L(labels, "vps.honestyBody")
  );
  out.push("");
  out.push(L(labels, "vps.generatedBy"));
  out.push("");
  return out.join("\n");
}

/* ================================================================== */
/* PART 10 — worker-boundary coercion + naming                        */
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
 * defaults; labels accept any "vps.*" string keys (≤ 240 chars each).
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
      if (/^vps\.[A-Za-z0-9]+$/.test(k) && typeof v === "string") {
        labels[k] = v.slice(0, 240);
      }
    }
  }
  return {
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
