/**
 * pki-common/asn1 — minimal DER (ASN.1) parser + encoder.
 *
 * Pure TypeScript, zero dependencies, runs identically in bun (smoke),
 * web workers and the browser. Scope: exactly what PKCS#12 parsing,
 * X.509 reading and CMS building/verifying need — TLV walk, OIDs,
 * integers, strings, times, bit/octet strings and context tags.
 */

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

export interface DerNode {
  /** Full tag byte (class + constructed + number). */
  tag: number;
  tagNumber: number;
  constructed: boolean;
  /** Content bytes only (header excluded). */
  value: Uint8Array;
  /** Offset of the tag byte inside the source buffer. */
  start: number;
  /** Offset just past the end of this TLV. */
  end: number;
}

function readDerLength(
  buf: Uint8Array,
  pos: number
): { length: number; headerEnd: number } {
  if (pos >= buf.length) throw new Error("asn1: truncated length");
  const first = buf[pos];
  if (first < 0x80) return { length: first, headerEnd: pos + 1 };
  const numBytes = first & 0x7f;
  if (numBytes === 0 || numBytes > 4 || pos + 1 + numBytes > buf.length) {
    throw new Error("asn1: unsupported length form");
  }
  let length = 0;
  for (let i = 0; i < numBytes; i++) {
    length = length * 256 + buf[pos + 1 + i];
  }
  return { length, headerEnd: pos + 1 + numBytes };
}

/** Parse ONE top-level TLV starting at `pos` (default 0). */
export function parseDerAt(buf: Uint8Array, pos = 0): DerNode {
  if (pos + 2 > buf.length) throw new Error("asn1: truncated TLV");
  const tag = buf[pos];
  const constructed = (tag & 0x20) !== 0;
  const tagNumber = tag & 0x1f;
  if (tagNumber === 0x1f) throw new Error("asn1: multi-byte tags unsupported");
  const { length, headerEnd } = readDerLength(buf, pos + 1);
  if (headerEnd + length > buf.length) {
    throw new Error("asn1: TLV overruns buffer");
  }
  return {
    tag,
    tagNumber,
    constructed,
    value: buf.subarray(headerEnd, headerEnd + length),
    start: pos,
    end: headerEnd + length,
  };
}

/** Parse the single TLV filling the buffer (strict: nothing trailing). */
export function parseDer(buf: Uint8Array): DerNode {
  const node = parseDerAt(buf, 0);
  if (node.end !== buf.length) {
    throw new Error("asn1: trailing bytes after top-level TLV");
  }
  return node;
}

/** Parse the children of a constructed node (SEQUENCE/SET/context). */
export function parseChildren(node: DerNode): DerNode[] {
  if (!node.constructed) throw new Error("asn1: node is not constructed");
  const out: DerNode[] = [];
  let pos = 0;
  const buf = node.value;
  while (pos < buf.length) {
    const child = parseDerAt(buf, pos);
    out.push(child);
    pos = child.end;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Readers                                                             */
/* ------------------------------------------------------------------ */

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  T61_STRING: 0x14,
  IA5_STRING: 0x16,
  UTCTIME: 0x17,
  GENERALIZEDTIME: 0x18,
  BMP_STRING: 0x1e,
  SEQUENCE: 0x30,
  SET: 0x31,
  CTX_0: 0xa0,
  CTX_0_PRIM: 0x80,
  CTX_1: 0xa1,
  CTX_1_PRIM: 0x81,
  CTX_2_PRIM: 0x82,
  CTX_3: 0xa3,
  CTX_3_PRIM: 0x83,
} as const;

/** Unsigned big-endian integer → bigint (positive ints only here). */
export function readBigInt(node: DerNode): bigint {
  if (node.tag !== TAG.INTEGER) throw new Error("asn1: not an INTEGER");
  let v = BigInt(0);
  for (const b of node.value) v = (v << BigInt(8)) | BigInt(b);
  return v;
}

/** Integer as bytes (keeps leading zeros exactly as stored). */
export function readIntBytes(node: DerNode): Uint8Array {
  if (node.tag !== TAG.INTEGER) throw new Error("asn1: not an INTEGER");
  return node.value;
}

export function readOid(node: DerNode): string {
  if (node.tag !== TAG.OID) throw new Error("asn1: not an OID");
  const b = node.value;
  if (b.length === 0) throw new Error("asn1: empty OID");
  const parts: string[] = [];
  const first = b[0];
  if (first < 40) parts.push("0", String(first));
  else if (first < 80) parts.push("1", String(first - 40));
  else parts.push("2", String(first - 80));
  let acc = 0;
  for (let i = 1; i < b.length; i++) {
    acc = (acc << 7) | (b[i] & 0x7f);
    if ((b[i] & 0x80) === 0) {
      parts.push(String(acc));
      acc = 0;
    }
  }
  return parts.join(".");
}

export function readOctets(node: DerNode): Uint8Array {
  if (node.tag !== TAG.OCTET_STRING) throw new Error("asn1: not an OCTET STRING");
  return node.value;
}

export function readBitString(node: DerNode): Uint8Array {
  if (node.tag !== TAG.BIT_STRING) throw new Error("asn1: not a BIT STRING");
  if (node.value.length === 0) throw new Error("asn1: empty BIT STRING");
  const unused = node.value[0];
  if (unused !== 0) throw new Error("asn1: partial bytes unsupported");
  return node.value.subarray(1);
}

export function readBool(node: DerNode): boolean {
  return node.value.length > 0 && node.value[0] !== 0;
}

const TEXT_TAGS = new Set<number>([
  TAG.UTF8_STRING,
  TAG.PRINTABLE_STRING,
  TAG.T61_STRING,
  TAG.IA5_STRING,
  TAG.BMP_STRING,
]);

const decoder = new TextDecoder();
const decoderUtf16 = new TextDecoder("utf-16be");

export function readString(node: DerNode): string {
  if (!TEXT_TAGS.has(node.tag)) {
    throw new Error(`asn1: not a string tag (0x${node.tag.toString(16)})`);
  }
  if (node.tag === TAG.BMP_STRING) return decoderUtf16.decode(node.value);
  if (node.tag === TAG.T61_STRING) {
    let out = "";
    for (const b of node.value) out += String.fromCharCode(b);
    return out;
  }
  return decoder.decode(node.value);
}

/** UTCTime (YYMMDDHHMMSSZ) / GeneralizedTime (YYYYMMDDHHMMSSZ) → Date. */
export function readTime(node: DerNode): Date {
  const s = String.fromCharCode(...node.value);
  const m = /^(\d{2}|\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s);
  if (!m) throw new Error(`asn1: bad time value ${s}`);
  let year = Number(m[1]);
  if (m[1].length === 2) year += year >= 50 ? 1900 : 2000;
  return new Date(
    Date.UTC(
      year,
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] ?? "0")
    )
  );
}

/* ------------------------------------------------------------------ */
/* Encoder                                                             */
/* ------------------------------------------------------------------ */

function encodeLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return [0x80 | bytes.length, ...bytes];
}

/** Build one TLV from a tag and content parts. */
export function tlv(tag: number, ...content: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of content) len += c.length;
  const header = [tag, ...encodeLength(len)];
  const out = new Uint8Array(header.length + len);
  out.set(header);
  let pos = header.length;
  for (const c of content) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

export function u8(...bytes: (number | number[] | Uint8Array)[]): Uint8Array {
  let len = 0;
  for (const b of bytes) len += typeof b === "number" ? 1 : b.length;
  const out = new Uint8Array(len);
  let pos = 0;
  for (const b of bytes) {
    if (typeof b === "number") {
      out[pos++] = b & 0xff;
    } else {
      out.set(b, pos);
      pos += b.length;
    }
  }
  return out;
}

export function derSeq(...content: Uint8Array[]): Uint8Array {
  return tlv(TAG.SEQUENCE, ...content);
}
export function derSet(...content: Uint8Array[]): Uint8Array {
  return tlv(TAG.SET, ...content);
}
export function derCtx(constructedTag: number, ...content: Uint8Array[]): Uint8Array {
  return tlv(constructedTag, ...content);
}
export const derNull = (): Uint8Array => u8(0x05, 0x00);

export function derOctets(b: Uint8Array): Uint8Array {
  return tlv(TAG.OCTET_STRING, b);
}

export function derBitString(b: Uint8Array): Uint8Array {
  return tlv(TAG.BIT_STRING, u8(0x00, b));
}

/** Minimal integer encoding (positive only — CMS serial numbers). */
export function derInt(v: bigint | number): Uint8Array {
  let n = typeof v === "bigint" ? v : BigInt(Math.trunc(v));
  if (n < BigInt(0)) throw new Error("asn1: negative INTEGER unsupported");
  const bytes: number[] = [];
  do {
    bytes.unshift(Number(n & BigInt(0xff)));
    n >>= BigInt(8);
  } while (n > BigInt(0));
  if (bytes[0] > 0x7f) bytes.unshift(0x00);
  return tlv(TAG.INTEGER, u8(bytes));
}

/** INTEGER from arbitrary magnitude bytes (adds 0x00 pad when high bit set). */
export function derIntBytes(b: Uint8Array): Uint8Array {
  let v = b;
  while (v.length > 1 && v[0] === 0) v = v.subarray(1);
  const pad = v.length > 0 && v[0] > 0x7f ? [0x00] : [];
  return tlv(TAG.INTEGER, u8(pad, v));
}

export function derOid(dot: string): Uint8Array {
  const parts = dot.split(".").map((p) => Number(p));
  if (parts.length < 2) throw new Error("asn1: OID needs 2 arcs minimum");
  const body: number[] = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const stack: number[] = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    body.push(...stack);
  }
  return tlv(TAG.OID, u8(body));
}

export function derUtf8(s: string): Uint8Array {
  return tlv(TAG.UTF8_STRING, new TextEncoder().encode(s));
}

/** UTCTime for dates 1950-2049 (Adobe expects UTCTime in signingTime). */
export function derUtctime(d: Date): Uint8Array {
  const p2 = (n: number) => String(n).padStart(2, "0");
  const s = `${p2(d.getUTCFullYear() % 100)}${p2(d.getUTCMonth() + 1)}${p2(
    d.getUTCDate()
  )}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
  return tlv(TAG.UTCTIME, u8(Array.from(s, (c) => c.charCodeAt(0))));
}

/** WebCrypto ECDSA signatures are raw r||s — CMS needs DER SEQUENCE{r,s}. */
export function ecRawToDer(raw: Uint8Array): Uint8Array {
  if (raw.length % 2 !== 0) throw new Error("ecdsa: odd raw signature");
  const half = raw.length / 2;
  let r = raw.subarray(0, half);
  let s = raw.subarray(half);
  while (r.length > 1 && r[0] === 0) r = r.subarray(1);
  while (s.length > 1 && s[0] === 0) s = s.subarray(1);
  return tlv(TAG.SEQUENCE, derIntBytes(r), derIntBytes(s));
}

/** DER SEQUENCE{r,s} → raw r||s padded to `byteLen` bytes each (verify side). */
export function ecDerToRaw(der: Uint8Array, byteLen: number): Uint8Array {
  const node = parseDer(der);
  const kids = parseChildren(node);
  if (kids.length !== 2) throw new Error("ecdsa: bad DER signature");
  let r = kids[0].value;
  let s = kids[1].value;
  // DER pads positive integers with a leading 0x00 when the high bit is
  // set — strip it before right-aligning into the fixed-width fields.
  while (r.length > byteLen && r[0] === 0) r = r.subarray(1);
  while (s.length > byteLen && s[0] === 0) s = s.subarray(1);
  if (r.length > byteLen || s.length > byteLen) {
    throw new Error("ecdsa: integer wider than the field");
  }
  const out = new Uint8Array(byteLen * 2);
  out.set(r, byteLen - r.length);
  out.set(s, byteLen + (byteLen - s.length));
  return out;
}

/** Concatenate byte arrays. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* WebCrypto plumbing                                                  */
/* ------------------------------------------------------------------ */

/** Digest helper that works in bun, workers and browsers. */
export async function sha(
  algo: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512",
  data: Uint8Array
): Promise<Uint8Array> {
  const h = await crypto.subtle.digest(algo, data as BufferSource);
  return new Uint8Array(h);
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const v of b) s += v.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex: odd length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
