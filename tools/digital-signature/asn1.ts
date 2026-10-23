/**
 * Minimal ASN.1 DER reader + writer (digital-signature, RB6-FIN-a).
 *
 * Scope is exactly what PKCS#12 parsing, X.509 summaries and CMS building
 * need: definite-length BER/DER TLVs, OIDs, integers, times and context
 * tags. No indefinite lengths, no BER weirdness — every real .p12/.cer
 * from OpenSSL/Windows/browsers is definite-length DER (anything else is
 * honestly rejected as corrupt).
 *
 * The WRITER half is intentionally complete enough that the smoke script
 * reuses it to build its own self-signed certificate and PKCS#12 packs —
 * the same primitives both pack and parse.
 */

export interface DerTlv {
  /** Full identifier byte (e.g. 0x30 for SEQUENCE). */
  tag: number;
  /** Content bytes (view into the parsed buffer). */
  value: Uint8Array;
  /** Offset of the tag byte inside the parsed buffer. */
  start: number;
  /** Offset just past the value inside the parsed buffer. */
  end: number;
}

export class DerParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerParseError";
  }
}

function readLength(bytes: Uint8Array, offset: number): { len: number; next: number } {
  const first = bytes[offset];
  if (first === undefined) throw new DerParseError("der: truncated length");
  if (first < 0x80) return { len: first, next: offset + 1 };
  const count = first & 0x7f;
  if (count === 0 || count > 4) {
    throw new DerParseError("der: unsupported length form");
  }
  let len = 0;
  for (let i = 0; i < count; i += 1) {
    const b = bytes[offset + 1 + i];
    if (b === undefined) throw new DerParseError("der: truncated long length");
    len = len * 256 + b;
  }
  return { len, next: offset + 1 + count };
}

/** Reads one TLV at `offset`; throws when malformed. */
export function readTlv(bytes: Uint8Array, offset = 0): DerTlv {
  const tag = bytes[offset];
  if (tag === undefined) throw new DerParseError("der: truncated tag");
  const { len, next } = readLength(bytes, offset + 1);
  const end = next + len;
  if (end > bytes.length) throw new DerParseError("der: value overruns buffer");
  return { tag, value: bytes.subarray(next, end), start: offset, end };
}

/** Reads exactly one TLV and requires the buffer to end there. */
export function readSingle(bytes: Uint8Array): DerTlv {
  const tlv = readTlv(bytes, 0);
  if (tlv.end !== bytes.length) throw new DerParseError("der: trailing bytes");
  return tlv;
}

/** Reads a constructed TLV's children. */
export function readChildren(tlv: DerTlv): DerTlv[] {
  const out: DerTlv[] = [];
  let offset = 0;
  const buf = tlv.value;
  while (offset < buf.length) {
    const child = readTlv(buf, offset);
    out.push(child);
    offset = child.end;
  }
  return out;
}

/** Parses a whole buffer as one SEQUENCE, returning its children. */
export function seqChildren(bytes: Uint8Array, offset = 0): DerTlv[] {
  const tlv = readTlv(bytes, offset);
  if (tlv.tag !== 0x30) throw new DerParseError("der: expected SEQUENCE");
  return readChildren(tlv);
}

/** Non-negative INTEGER content bytes (leading sign byte kept honest). */
export function intBytes(tlv: DerTlv): Uint8Array {
  if (tlv.tag !== 0x02) throw new DerParseError("der: expected INTEGER");
  return tlv.value;
}

/** INTEGER as a JS number (safe for serials up to 2^53, iterations, versions). */
export function intValue(tlv: DerTlv): number {
  const b = intBytes(tlv);
  let v = 0;
  for (const byte of b) v = v * 256 + byte;
  return v;
}

/** OID content bytes → dotted string. */
export function oidText(tlv: DerTlv): string {
  if (tlv.tag !== 0x06) throw new DerParseError("der: expected OBJECT IDENTIFIER");
  const b = tlv.value;
  if (b.length === 0) throw new DerParseError("der: empty OID");
  const parts: string[] = [];
  const first = b[0]!;
  parts.push(String(Math.floor(first / 40)), String(first % 40));
  let acc = 0;
  for (let i = 1; i < b.length; i += 1) {
    const byte = b[i]!;
    acc = (acc << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(String(acc));
      acc = 0;
    }
  }
  return parts.join(".");
}

/** OCTET STRING content. */
export function octets(tlv: DerTlv): Uint8Array {
  if (tlv.tag !== 0x04) throw new DerParseError("der: expected OCTET STRING");
  return tlv.value;
}

/** BIT STRING content with the unused-bits prefix stripped. */
export function bitString(tlv: DerTlv): Uint8Array {
  if (tlv.tag !== 0x03) throw new DerParseError("der: expected BIT STRING");
  if (tlv.value.length === 0) throw new DerParseError("der: empty BIT STRING");
  const unused = tlv.value[0]!;
  if (unused !== 0) throw new DerParseError("der: unsupported BIT STRING padding");
  return tlv.value.subarray(1);
}

/** Decodes any of the DirectoryString encodings real certificates use. */
export function directoryString(tlv: DerTlv): string {
  switch (tlv.tag) {
    case 0x0c: // UTF8String
      return new TextDecoder("utf-8").decode(tlv.value);
    case 0x13: // PrintableString
    case 0x16: // IA5String
    case 0x14: // TeletexString (treated as Latin-1 — the pragmatic norm)
    case 0x19: // NumericString
      return ascii(tlv.value);
    case 0x1e: // BMPString (UTF-16BE)
      return new TextDecoder("utf-16be").decode(tlv.value);
    default:
      throw new DerParseError(`der: unsupported string tag 0x${tlv.tag.toString(16)}`);
  }
}

/** UTCTime (0x17) / GeneralizedTime (0x18) → Date (UTC, minute precision). */
export function asn1Time(tlv: DerTlv): Date {
  let text: string;
  if (tlv.tag === 0x17) {
    text = ascii(tlv.value);
    if (text.length === 11) text = `${text.slice(0, 10)}Z`;
  } else if (tlv.tag === 0x18) {
    text = ascii(tlv.value);
  } else {
    throw new DerParseError("der: expected Time");
  }
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(text);
  if (!m) throw new DerParseError(`der: malformed time ${text}`);
  const secs = m[6] === undefined ? 0 : Number(m[6]);
  const yy = Number(m[1]);
  const year = tlv.tag === 0x17 ? (yy < 50 ? 2000 + yy : 1900 + yy) : Number(m[1]);
  return new Date(
    Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), secs)
  );
}

export function ascii(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/* ------------------------------------------------------------------ */
/* DER writer                                                          */
/* ------------------------------------------------------------------ */

export function derHeader(tag: number, len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([tag, len]);
  const be: number[] = [];
  let v = len;
  while (v > 0) {
    be.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return new Uint8Array([tag, 0x80 | be.length, ...be]);
}

export function derTlv(tag: number, content: Uint8Array): Uint8Array {
  const head = derHeader(tag, content.length);
  const out = new Uint8Array(head.length + content.length);
  out.set(head, 0);
  out.set(content, head.length);
  return out;
}

export function derSeq(...parts: Uint8Array[]): Uint8Array {
  return derTlv(0x30, concat(parts));
}

export function derSet(...parts: Uint8Array[]): Uint8Array {
  return derTlv(0x31, concat(parts));
}

/** Context tag (0x80 | n), constructed when the content is TLVs. */
export function derCtx(n: number, content: Uint8Array, constructed = true): Uint8Array {
  return derTlv(0x80 | n | (constructed ? 0x20 : 0), content);
}

export function derIntFromBytes(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0 && (bytes[start + 1]! & 0x80) === 0) {
    start += 1;
  }
  let b = bytes.subarray(start);
  if (b.length === 0 || (b[0]! & 0x80) !== 0) {
    b = new Uint8Array([0, ...b]);
  }
  return derTlv(0x02, b);
}

export function derInt(n: number): Uint8Array {
  if (n < 0) throw new Error("der: negative INTEGER unsupported");
  const be: number[] = [];
  let v = n;
  do {
    be.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return derIntFromBytes(new Uint8Array(be));
}

export function derOid(dotted: string): Uint8Array {
  const arcs = dotted.split(".").map((s) => Number(s));
  if (arcs.length < 2 || !Number.isInteger(arcs[0]) || !Number.isInteger(arcs[1])) {
    throw new Error(`der: bad OID ${dotted}`);
  }
  const body: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (let i = 2; i < arcs.length; i += 1) {
    let v = arcs[i]!;
    if (!Number.isInteger(v) || v < 0) throw new Error("der: bad OID arc");
    const stack: number[] = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    body.push(...stack);
  }
  return derTlv(0x06, new Uint8Array(body));
}

export function derOctets(bytes: Uint8Array): Uint8Array {
  return derTlv(0x04, bytes);
}

export function derNull(): Uint8Array {
  return new Uint8Array([0x05, 0x00]);
}

/** UTCTime for years < 2050 (else GeneralizedTime), Zulu, second precision. */
export function derTime(date: Date): Uint8Array {
  const y = date.getUTCFullYear();
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const rest = `${p2(date.getUTCMonth() + 1)}${p2(date.getUTCDate())}` +
    `${p2(date.getUTCHours())}${p2(date.getUTCMinutes())}${p2(date.getUTCSeconds())}Z`;
  return y < 2050
    ? derTlv(0x17, new TextEncoder().encode(`${p2(y % 100)}${rest}`))
    : derTlv(0x18, new TextEncoder().encode(`${y}${rest}`));
}

export function derBitString(bytes: Uint8Array): Uint8Array {
  return derTlv(0x03, new Uint8Array([0, ...bytes]));
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function hexOf(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function bytesOfHex(hex: string): Uint8Array {
  const clean = hex.length % 2 === 1 ? `${hex}0` : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}
