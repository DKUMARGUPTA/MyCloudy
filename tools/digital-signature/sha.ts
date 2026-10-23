/**
 * Pure-JS SHA-1 / SHA-256 / SHA-512 + HMAC + the PKCS#12 KDF
 * (digital-signature, RB6-FIN-a).
 *
 * WebCrypto covers every hash this tool needs in browsers and workers —
 * this file exists for two places subtle CANNOT go:
 *   1. the PKCS#12 KDF itself (BMP-bead password derivation — no WebCrypto
 *      API exposes it, so every real .p12 parse goes through here);
 *   2. the honest pure-JS fallback when crypto.subtle is missing entirely
 *      (PBKDF2 + digests + HMAC all run on these classes).
 *
 * SHA-1/SHA-256 + HMAC + the PKCS#12 KDF were salvaged from the RB6 probe
 * (verified against OpenSSL fixtures); SHA-512 is new (hi/lo 32-bit pair
 * arithmetic) so PBKDF2-HMAC-SHA512 key bags work on the fallback path too.
 * Nothing here touches the network or the DOM — worker-safe by design.
 */

/* ------------------------------------------------------------------ */
/* SHA-1 / SHA-256 (32-bit family)                                    */
/* ------------------------------------------------------------------ */

abstract class Sha32Base {
  protected h: number[] = [];
  protected buf = new Uint8Array(64);
  protected bufLen = 0;
  protected len = 0;

  update(data: Uint8Array): this {
    this.len += data.length;
    let off = 0;
    if (this.bufLen > 0) {
      const take = Math.min(data.length, 64 - this.bufLen);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      off = take;
      if (this.bufLen === 64) {
        this.compress(this.buf);
        this.bufLen = 0;
      }
    }
    const whole = Math.floor((data.length - off) / 64);
    for (let i = 0; i < whole; i += 1) {
      this.compress(data.subarray(off + i * 64, off + (i + 1) * 64));
    }
    const rest = data.length - off - whole * 64;
    if (rest > 0) {
      this.buf.set(data.subarray(data.length - rest), 0);
      this.bufLen = rest;
    }
    return this;
  }

  protected abstract compress(buf: Uint8Array): void;
  abstract digest(): Uint8Array;
}

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

class Sha256 extends Sha32Base {
  constructor() {
    super();
    this.h = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f,
      0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
  }

  private rotr(x: number, n: number): number {
    return ((x >>> n) | (x << (32 - n))) >>> 0;
  }

  protected compress(buf: Uint8Array): void {
    const w = new Int32Array(64);
    const dv = new DataView(buf.buffer, buf.byteOffset, 64);
    for (let i = 0; i < 16; i += 1) w[i] = dv.getUint32(i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        this.rotr(w[i - 15]!, 7) ^ this.rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 =
        this.rotr(w[i - 2]!, 17) ^ this.rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = this.h[0]!, b = this.h[1]!, c = this.h[2]!, d = this.h[3]!;
    let e = this.h[4]!, f = this.h[5]!, g = this.h[6]!, h = this.h[7]!;
    for (let i = 0; i < 64; i += 1) {
      const S1 = this.rotr(e, 6) ^ this.rotr(e, 11) ^ this.rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i]! + w[i]!) | 0;
      const S0 = this.rotr(a, 2) ^ this.rotr(a, 13) ^ this.rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e;
      e = (d + t1) | 0;
      d = c; c = b; b = a;
      a = (t1 + t2) | 0;
    }
    this.h[0] = (this.h[0]! + a) | 0;
    this.h[1] = (this.h[1]! + b) | 0;
    this.h[2] = (this.h[2]! + c) | 0;
    this.h[3] = (this.h[3]! + d) | 0;
    this.h[4] = (this.h[4]! + e) | 0;
    this.h[5] = (this.h[5]! + f) | 0;
    this.h[6] = (this.h[6]! + g) | 0;
    this.h[7] = (this.h[7]! + h) | 0;
  }

  digest(): Uint8Array {
    const bitLen = this.len * 8;
    this.buf[this.bufLen] = 0x80;
    this.bufLen += 1;
    if (this.bufLen > 56) {
      this.buf.fill(0, this.bufLen);
      this.compress(this.buf);
      this.bufLen = 0;
    }
    this.buf.fill(0, this.bufLen);
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset);
    dv.setUint32(56, Math.floor(bitLen / 2 ** 32));
    dv.setUint32(60, bitLen >>> 0);
    this.compress(this.buf);
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    this.h.forEach((v, i) => ov.setUint32(i * 4, v));
    return out;
  }
}

class Sha1 extends Sha32Base {
  constructor() {
    super();
    this.h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  }

  private rotl(x: number, n: number): number {
    return ((x << n) | (x >>> (32 - n))) >>> 0;
  }

  protected compress(buf: Uint8Array): void {
    const w = new Int32Array(80);
    const dv = new DataView(buf.buffer, buf.byteOffset, 64);
    for (let i = 0; i < 16; i += 1) w[i] = dv.getUint32(i * 4);
    for (let i = 16; i < 80; i += 1) {
      w[i] = this.rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1) | 0;
    }
    let a = this.h[0]!, b = this.h[1]!, c = this.h[2]!, d = this.h[3]!, e = this.h[4]!;
    for (let i = 0; i < 80; i += 1) {
      let f: number, k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (this.rotl(a, 5) + f + e + k + w[i]!) >>> 0;
      e = d; d = c; c = this.rotl(b, 30); b = a; a = t;
    }
    this.h[0] = (this.h[0]! + a) | 0;
    this.h[1] = (this.h[1]! + b) | 0;
    this.h[2] = (this.h[2]! + c) | 0;
    this.h[3] = (this.h[3]! + d) | 0;
    this.h[4] = (this.h[4]! + e) | 0;
  }

  digest(): Uint8Array {
    const bitLen = this.len * 8;
    this.buf[this.bufLen] = 0x80;
    this.bufLen += 1;
    if (this.bufLen > 56) {
      this.buf.fill(0, this.bufLen);
      this.compress(this.buf);
      this.bufLen = 0;
    }
    this.buf.fill(0, this.bufLen);
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset);
    dv.setUint32(56, Math.floor(bitLen / 2 ** 32));
    dv.setUint32(60, bitLen >>> 0);
    this.compress(this.buf);
    const out = new Uint8Array(20);
    const ov = new DataView(out.buffer);
    this.h.forEach((v, i) => ov.setUint32(i * 4, v));
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* SHA-512 (64-bit family, hi/lo pairs)                               */
/* ------------------------------------------------------------------ */

interface U64 {
  h: number;
  l: number;
}

const u64 = (h: number, l: number): U64 => ({ h: h >>> 0, l: l >>> 0 });

function add64(a: U64, b: U64): U64 {
  const l = (a.l >>> 0) + (b.l >>> 0);
  return u64(a.h + b.h + Math.floor(l / 0x100000000), l % 0x100000000);
}

function xor64(a: U64, b: U64): U64 {
  return u64(a.h ^ b.h, a.l ^ b.l);
}

function rotr64(x: U64, n: number): U64 {
  if (n === 0) return x;
  if (n < 32) {
    return u64(
      ((x.h >>> n) | (x.l << (32 - n))) >>> 0,
      ((x.l >>> n) | (x.h << (32 - n))) >>> 0
    );
  }
  // 32 <= n < 64: BOTH halves mix — (x >>> n) | (x << (64 - n)). The RB6-a
  // probe caught the old branch swapping the halves and dropping the cross
  // terms (SHA-512's 41/61 rotations were silently wrong).
  return u64(
    ((x.l >>> (n - 32)) | (x.h << (64 - n))) >>> 0,
    ((x.l << (64 - n)) | (x.h >>> (n - 32))) >>> 0
  );
}

function shr64(x: U64, n: number): U64 {
  if (n < 32) {
    return u64(x.h >>> n, ((x.l >>> n) | (x.h << (32 - n))) >>> 0);
  }
  if (n === 32) return u64(0, x.h >>> 0);
  return u64(0, x.h >>> (n - 32));
}

/** SHA-512 constants K[t] = frac(cbrt(prime_t)) as 64-bit hex pairs. */
const K512: [number, number][] = [
  [0x428a2f98, 0xd728ae22], [0x71374491, 0x23ef65cd], [0xb5c0fbcf, 0xec4d3b2f],
  [0xe9b5dba5, 0x8189dbbc], [0x3956c25b, 0xf348b538], [0x59f111f1, 0xb605d019],
  [0x923f82a4, 0xaf194f9b], [0xab1c5ed5, 0xda6d8118], [0xd807aa98, 0xa3030242],
  [0x12835b01, 0x45706fbe], [0x243185be, 0x4ee4b28c], [0x550c7dc3, 0xd5ffb4e2],
  [0x72be5d74, 0xf27b896f], [0x80deb1fe, 0x3b1696b1], [0x9bdc06a7, 0x25c71235],
  [0xc19bf174, 0xcf692694], [0xe49b69c1, 0x9ef14ad2], [0xefbe4786, 0x384f25e3],
  [0x0fc19dc6, 0x8b8cd5b5], [0x240ca1cc, 0x77ac9c65], [0x2de92c6f, 0x592b0275],
  [0x4a7484aa, 0x6ea6e483], [0x5cb0a9dc, 0xbd41fbd4], [0x76f988da, 0x831153b5],
  [0x983e5152, 0xee66dfab], [0xa831c66d, 0x2db43210], [0xb00327c8, 0x98fb213f],
  [0xbf597fc7, 0xbeef0ee4], [0xc6e00bf3, 0x3da88fc2], [0xd5a79147, 0x930aa725],
  [0x06ca6351, 0xe003826f], [0x14292967, 0x0a0e6e70], [0x27b70a85, 0x46d22ffc],
  [0x2e1b2138, 0x5c26c926], [0x4d2c6dfc, 0x5ac42aed], [0x53380d13, 0x9d95b3df],
  [0x650a7354, 0x8baf63de], [0x766a0abb, 0x3c77b2a8], [0x81c2c92e, 0x47edaee6],
  [0x92722c85, 0x1482353b], [0xa2bfe8a1, 0x4cf10364], [0xa81a664b, 0xbc423001],
  [0xc24b8b70, 0xd0f89791], [0xc76c51a3, 0x0654be30], [0xd192e819, 0xd6ef5218],
  [0xd6990624, 0x5565a910], [0xf40e3585, 0x5771202a], [0x106aa070, 0x32bbd1b8],
  [0x19a4c116, 0xb8d2d0c8], [0x1e376c08, 0x5141ab53], [0x2748774c, 0xdf8eeb99],
  [0x34b0bcb5, 0xe19b48a8], [0x391c0cb3, 0xc5c95a63], [0x4ed8aa4a, 0xe3418acb],
  [0x5b9cca4f, 0x7763e373], [0x682e6ff3, 0xd6b2b8a3], [0x748f82ee, 0x5defb2fc],
  [0x78a5636f, 0x43172f60], [0x84c87814, 0xa1f0ab72], [0x8cc70208, 0x1a6439ec],
  [0x90befffa, 0x23631e28], [0xa4506ceb, 0xde82bde9], [0xbef9a3f7, 0xb2c67915],
  [0xc67178f2, 0xe372532b], [0xca273ece, 0xea26619c], [0xd186b8c7, 0x21c0c207],
  [0xeada7dd6, 0xcde0eb1e], [0xf57d4f7f, 0xee6ed178], [0x06f067aa, 0x72176fba],
  [0x0a637dc5, 0xa2c898a6], [0x113f9804, 0xbef90dae], [0x1b710b35, 0x131c471b],
  [0x28db77f5, 0x23047d84], [0x32caab7b, 0x40c72493], [0x3c9ebe0a, 0x15c9bebc],
  [0x431d67c4, 0x9c100d4c], [0x4cc5d4be, 0xcb3e42b6], [0x597f299c, 0xfc657e2a],
  [0x5fcb6fab, 0x3ad6faec], [0x6c44198c, 0x4a475817],
];

class Sha512 {
  private h: U64[];
  private buf = new Uint8Array(128);
  private bufLen = 0;
  private len = 0;

  constructor() {
    this.h = [
      u64(0x6a09e667, 0xf3bcc908), u64(0xbb67ae85, 0x84caa73b),
      u64(0x3c6ef372, 0xfe94f82b), u64(0xa54ff53a, 0x5f1d36f1),
      u64(0x510e527f, 0xade682d1), u64(0x9b05688c, 0x2b3e6c1f),
      u64(0x1f83d9ab, 0xfb41bd6b), u64(0x5be0cd19, 0x137e2179),
    ];
  }

  update(data: Uint8Array): this {
    this.len += data.length;
    let off = 0;
    if (this.bufLen > 0) {
      const take = Math.min(data.length, 128 - this.bufLen);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      off = take;
      if (this.bufLen === 128) {
        this.compress(this.buf);
        this.bufLen = 0;
      }
    }
    const whole = Math.floor((data.length - off) / 128);
    for (let i = 0; i < whole; i += 1) {
      this.compress(data.subarray(off + i * 128, off + (i + 1) * 128));
    }
    const rest = data.length - off - whole * 128;
    if (rest > 0) {
      this.buf.set(data.subarray(data.length - rest), 0);
      this.bufLen = rest;
    }
    return this;
  }

  private compress(buf: Uint8Array): void {
    const w: U64[] = [];
    const dv = new DataView(buf.buffer, buf.byteOffset, 128);
    for (let i = 0; i < 16; i += 1) {
      w.push(u64(dv.getUint32(i * 8), dv.getUint32(i * 8 + 4)));
    }
    for (let i = 16; i < 80; i += 1) {
      const s0 = xor64(
        xor64(rotr64(w[i - 15]!, 1), rotr64(w[i - 15]!, 8)),
        shr64(w[i - 15]!, 7)
      );
      const s1 = xor64(
        xor64(rotr64(w[i - 2]!, 19), rotr64(w[i - 2]!, 61)),
        shr64(w[i - 2]!, 6)
      );
      w.push(add64(add64(add64(w[i - 16]!, s0), w[i - 7]!), s1));
    }
    let a = this.h[0]!, b = this.h[1]!, c = this.h[2]!, d = this.h[3]!;
    let e = this.h[4]!, f = this.h[5]!, g = this.h[6]!, h = this.h[7]!;
    for (let i = 0; i < 80; i += 1) {
      const S1 = xor64(
        xor64(rotr64(e, 14), rotr64(e, 18)),
        rotr64(e, 41)
      );
      const ch = u64((e.h & f.h) ^ (~e.h & g.h), (e.l & f.l) ^ (~e.l & g.l));
      const t1 = add64(
        add64(add64(add64(h, S1), ch), u64(...K512[i]!)),
        w[i]!
      );
      const S0 = xor64(
        xor64(rotr64(a, 28), rotr64(a, 34)),
        rotr64(a, 39)
      );
      const maj = u64(
        (a.h & b.h) ^ (a.h & c.h) ^ (b.h & c.h),
        (a.l & b.l) ^ (a.l & c.l) ^ (b.l & c.l)
      );
      const t2 = add64(S0, maj);
      h = g; g = f; f = e;
      e = add64(d, t1);
      d = c; c = b; b = a;
      a = add64(t1, t2);
    }
    this.h[0] = add64(this.h[0]!, a);
    this.h[1] = add64(this.h[1]!, b);
    this.h[2] = add64(this.h[2]!, c);
    this.h[3] = add64(this.h[3]!, d);
    this.h[4] = add64(this.h[4]!, e);
    this.h[5] = add64(this.h[5]!, f);
    this.h[6] = add64(this.h[6]!, g);
    this.h[7] = add64(this.h[7]!, h);
  }

  digest(): Uint8Array {
    // FIPS 180-4: SHA-512 pads with a 128-BIT length field — the low 64
    // bits sit at bytes 120–127 (bytes 112–119 are the zero high half;
    // the RB6-a3 probe caught the old code writing the 64-bit length at
    // 112–119 — every non-empty message hashed wrong while "" passed).
    const bitLenHi = Math.floor((this.len * 8) / 2 ** 32);
    const bitLenLo = (this.len * 8) >>> 0;
    this.buf[this.bufLen] = 0x80;
    this.bufLen += 1;
    if (this.bufLen > 112) {
      this.buf.fill(0, this.bufLen);
      this.compress(this.buf);
      this.bufLen = 0;
    }
    this.buf.fill(0, this.bufLen);
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset);
    dv.setUint32(112, 0);
    dv.setUint32(116, 0);
    dv.setUint32(120, bitLenHi);
    dv.setUint32(124, bitLenLo);
    this.compress(this.buf);
    const out = new Uint8Array(64);
    const ov = new DataView(out.buffer);
    this.h.forEach((word, i) => {
      ov.setUint32(i * 8, word.h);
      ov.setUint32(i * 8 + 4, word.l);
    });
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Digest facade + HMAC + PKCS#12 KDF                                  */
/* ------------------------------------------------------------------ */

export type ShaName = "sha1" | "sha256" | "sha512";

export const SHA_SIZES: Record<ShaName, number> = {
  sha1: 20,
  sha256: 32,
  sha512: 64,
};

export class PureHash {
  private impl: Sha1 | Sha256 | Sha512;

  constructor(algo: ShaName) {
    this.impl = algo === "sha1" ? new Sha1() : algo === "sha256" ? new Sha256() : new Sha512();
  }

  update(data: Uint8Array): this {
    this.impl.update(data);
    return this;
  }

  digest(): Uint8Array {
    return this.impl.digest();
  }
}

export function pureDigest(algo: ShaName, data: Uint8Array): Uint8Array {
  return new PureHash(algo).update(data).digest();
}

export function pureHmac(algo: ShaName, key: Uint8Array, data: Uint8Array): Uint8Array {
  const blockLen = algo === "sha512" ? 128 : 64;
  const k = new Uint8Array(blockLen);
  if (key.length > blockLen) {
    k.set(pureDigest(algo, key));
  } else {
    k.set(key);
  }
  const inner = new Uint8Array(blockLen);
  const outer = new Uint8Array(blockLen);
  for (let i = 0; i < blockLen; i += 1) {
    inner[i] = k[i]! ^ 0x36;
    outer[i] = k[i]! ^ 0x5c;
  }
  const first = pureDigest(algo, concatU8(inner, data));
  return pureDigest(algo, concatU8(outer, first));
}

function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * PKCS#12 password → UTF-16BE BMP string with the double-NUL terminator
 * (RFC 7292 §B.1). Empty passwords keep the terminator (spec: "an empty
 * password ... must be represented as two zero octets").
 */
export function bmpPassword(password: string): Uint8Array {
  const out: number[] = [];
  for (const ch of password) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0xffff) {
      out.push(cp >> 8, cp & 0xff);
    } else {
      const v = cp - 0x10000;
      out.push(
        0xd8 + (v >> 18),
        (v >> 10) & 0xff,
        0xdc + ((v >> 8) & 0x3),
        v & 0xff
      );
    }
  }
  out.push(0, 0);
  return new Uint8Array(out);
}

/**
 * PKCS#12 KDF (RFC 7292 appendix B) — the "B" key derivation with the
 * password/salt diversity padding. `id` selects the derived byte's role:
 * 1 = key material, 2 = IV, 3 = MAC key.
 */
export function pkcs12Kdf(
  algo: ShaName,
  password: string,
  salt: Uint8Array,
  id: number,
  iterations: number,
  n: number
): Uint8Array {
  const u = SHA_SIZES[algo];
  const v = algo === "sha512" ? 128 : 64;
  const D = new Uint8Array(v).fill(id);
  const pw = bmpPassword(password);
  const pad = (src: Uint8Array): Uint8Array => {
    if (src.length === 0) return new Uint8Array(0);
    const len = Math.ceil(src.length / v) * v;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) out[i] = src[i % src.length]!;
    return out;
  };
  const S = pad(salt);
  const P = pad(pw);
  const I = new Uint8Array(S.length + P.length);
  I.set(S, 0);
  I.set(P, S.length);
  const out = new Uint8Array(n);
  const r = Math.ceil(n / u);
  for (let i = 0; i < r; i += 1) {
    const A = new PureHash(algo).update(D).update(I);
    let Ai = A.digest();
    for (let j = 1; j < iterations; j += 1) {
      Ai = pureDigest(algo, Ai);
    }
    const take = Math.min(u, n - i * u);
    out.set(Ai.subarray(0, take), i * u);
    if (i < r - 1) {
      // B = Ai repeated to v bytes (RFC 7292 §B.2 step 7).
      const B = new Uint8Array(v);
      for (let k = 0; k < v; k += 1) B[k] = Ai[k % u]!;
      // Step 8: every v-byte block of I is independently set to
      // (Ij + B + 1) mod 2^v — the +1 seed is the original PKCS#12
      // v1.0 quirk (node-forge's reference spells it as an 0x1ff
      // carry seed; verified against a fresh OpenSSL -legacy pack).
      // The carry never crosses block boundaries.
      for (let block = 0; block + v <= I.length; block += v) {
        let carry = 1;
        for (let k = v - 1; k >= 0; k -= 1) {
          const t = I[block + k]! + B[k]! + carry;
          I[block + k] = t & 0xff;
          carry = t >> 8;
        }
      }
    }
  }
  return out;
}

/** PBKDF2 (RFC 8018) on the pure hashes — the no-subtle fallback. */
export function purePbkdf2(
  algo: ShaName,
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  n: number
): Uint8Array {
  const hLen = SHA_SIZES[algo];
  const blocks = Math.ceil(n / hLen);
  const out = new Uint8Array(blocks * hLen);
  for (let i = 1; i <= blocks; i += 1) {
    const ibytes = new Uint8Array(4);
    new DataView(ibytes.buffer).setUint32(0, i);
    let u = pureHmac(algo, password, concatU8(salt, ibytes));
    const t = u.slice();
    for (let j = 1; j < iterations; j += 1) {
      u = pureHmac(algo, password, u);
      for (let k = 0; k < t.length; k += 1) t[k]! ^= u[k]!;
    }
    out.set(t, (i - 1) * hLen);
  }
  return out.subarray(0, n);
}
