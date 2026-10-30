/**
 * DocoPDF own PDF micro-engine — security crypto primitives (P6-w-b).
 *
 * Everything the standard security handler needs, pure TypeScript, zero
 * external dependencies (worker-safe, no DOM, no network):
 *   - MD5 (ISO 32000-1 Algorithm 2/3 family + AESV2 object keys)
 *   - RC4 (ARCFour — V1/V2 legacy handlers, R2-R4 U/O derivation)
 *   - AES-128 / AES-256 (CBC, full-block; AESV2 crypt filter + V5 file keys)
 *   - SHA-256 / SHA-384 / SHA-512 (Algorithm 2.B selects by length)
 *   - the R6 hash chain (ISO 32000-2 Algorithm 2.B) + R5 plain SHA-256
 *   - R6 password encoding (UTF-8, ≤ 127 bytes)
 *
 * Provenance: MD5/RC4/AES ported from the pdf.js implementation shipped in
 * @cantoo/pdf-lib (Apache-2.0 via MIT fork) at byte-parity; SHA-256/512
 * ported from our own verified tools/digital-signature/sha.ts (OpenSSL-
 * fixture-verified, RB6 probe) with SHA-384 added (same core, different
 * IV, 48-byte digest). Every algorithm is exercised against @cantoo in
 * scripts/smoke-lock.ts — reload of our encrypted output through their
 * full password-validation path is the oracle.
 */

/* ------------------------------------------------------------------ */
/* Random                                                              */
/* ------------------------------------------------------------------ */

/** n random bytes — WebCrypto when present (worker + bun + node ≥19). */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const g = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto;
  if (typeof g?.getRandomValues === "function") {
    g.getRandomValues(out);
  } else {
    for (let i = 0; i < n; i += 1) out[i] = Math.floor(256 * Math.random());
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* MD5 (pdf.js via @cantoo — Algorithm 2/3 + object keys)              */
/* ------------------------------------------------------------------ */

const MD5_R = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
  15, 21,
]);

const MD5_K = new Int32Array([
  -680876936, -389564586, 606105819, -1044525330, -176418897, 1200080426,
  -1473231341, -45705983, 1770035416, -1958414417, -42063, -1990404162,
  1804603682, -40341101, -1502002290, 1236535329, -165796510, -1069501632,
  643717713, -373897302, -701558691, 38016083, -660478335, -405537848,
  568446438, -1019803690, -187363961, 1163531501, -1444681467, -51403784,
  1735328473, -1926607734, -378558, -2022574463, 1839030562, -35309556,
  -1530992060, 1272893353, -155497632, -1094730640, 681279174, -358537222,
  -722521979, 76029189, -640364487, -421815835, 530742520, -995338651,
  -198630844, 1126891415, -1416354905, -57434055, 1700485571, -1894986606,
  -1051523, -2054922799, 1873313359, -30611744, -1560198380, 1309151649,
  -145523070, -1120210379, 718787259, -343485551,
]);

/** MD5 of the whole buffer (the security handler never needs offsets). */
export function md5(data: Uint8Array): Uint8Array {
  const length = data.length;
  let h0 = 1732584193,
    h1 = -271733879,
    h2 = -1732584194,
    h3 = 271733878;
  const paddedLength = (length + 72) & ~63; // data + 9 extra bytes
  const padded = new Uint8Array(paddedLength);
  let i, j;
  for (i = 0; i < length; ++i) padded[i] = data[i]!;
  padded[i++] = 0x80;
  const n = paddedLength - 8;
  while (i < n) padded[i++] = 0;
  padded[i++] = (length << 3) & 0xff;
  padded[i++] = (length >> 5) & 0xff;
  padded[i++] = (length >> 13) & 0xff;
  padded[i++] = (length >> 21) & 0xff;
  padded[i++] = (length >>> 29) & 0xff;
  padded[i++] = 0;
  padded[i++] = 0;
  padded[i++] = 0;
  const w = new Int32Array(16);
  for (i = 0; i < paddedLength; ) {
    for (j = 0; j < 16; ++j, i += 4) {
      w[j] = padded[i]! | (padded[i + 1]! << 8) | (padded[i + 2]! << 16) | (padded[i + 3]! << 24);
    }
    let a = h0, b = h1, c = h2, d = h3, f, g;
    for (j = 0; j < 64; ++j) {
      if (j < 16) {
        f = (b & c) | (~b & d);
        g = j;
      } else if (j < 32) {
        f = (d & b) | (~d & c);
        g = (5 * j + 1) & 15;
      } else if (j < 48) {
        f = b ^ c ^ d;
        g = (3 * j + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * j) & 15;
      }
      const tmp = d,
        rotateArg = (a + f + MD5_K[j]! + w[g]!) | 0,
        rotate = MD5_R[j]!;
      d = c;
      c = b;
      b = (b + ((rotateArg << rotate) | (rotateArg >>> (32 - rotate)))) | 0;
      a = tmp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
  }
  // prettier-ignore
  return new Uint8Array([
    h0 & 0xFF, (h0 >> 8) & 0xFF, (h0 >> 16) & 0xFF, (h0 >>> 24) & 0xFF,
    h1 & 0xFF, (h1 >> 8) & 0xFF, (h1 >> 16) & 0xFF, (h1 >>> 24) & 0xFF,
    h2 & 0xFF, (h2 >> 8) & 0xFF, (h2 >> 16) & 0xFF, (h2 >>> 24) & 0xFF,
    h3 & 0xFF, (h3 >> 8) & 0xFF, (h3 >> 16) & 0xFF, (h3 >>> 24) & 0xFF
  ]);
}

/* ------------------------------------------------------------------ */
/* RC4 (pdf.js ARCFourCipher)                                          */
/* ------------------------------------------------------------------ */

/** One-shot RC4 (encrypt == decrypt). */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  let a = 0;
  let b = 0;
  for (let i = 0; i < 256; ++i) s[i] = i;
  for (let i = 0, j = 0; i < 256; ++i) {
    const tmp = s[i]!;
    j = (j + tmp + key[i % key.length]!) & 0xff;
    s[i] = s[j]!;
    s[j] = tmp;
  }
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; ++i) {
    a = (a + 1) & 0xff;
    const tmp = s[a]!;
    b = (b + tmp) & 0xff;
    const tmp2 = s[b]!;
    s[a] = tmp2;
    s[b] = tmp;
    out[i] = data[i]! ^ s[(tmp + tmp2) & 0xff]!;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* SHA-256 / SHA-384 / SHA-512 (our sha.ts port + SHA-384)             */
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

/* ── SHA-512/384 (hi/lo pair 64-bit arithmetic — our sha.ts port) ── */

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

class Sha512Base {
  protected h: U64[];
  protected buf = new Uint8Array(128);
  protected bufLen = 0;
  protected len = 0;

  constructor(h: U64[]) {
    this.h = h;
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

  protected compress(buf: Uint8Array): void {
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

  /** SHA-512 pads with a 128-BIT length field (bytes 120–127 = low 64). */
  protected finish(outWords: number): Uint8Array {
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
    const out = new Uint8Array(outWords * 8);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < outWords; i += 1) {
      ov.setUint32(i * 8, this.h[i]!.h);
      ov.setUint32(i * 8 + 4, this.h[i]!.l);
    }
    return out;
  }

  digest(): Uint8Array {
    return this.finish(8);
  }
}

class Sha512 extends Sha512Base {
  constructor() {
    super([
      u64(0x6a09e667, 0xf3bcc908), u64(0xbb67ae85, 0x84caa73b),
      u64(0x3c6ef372, 0xfe94f82b), u64(0xa54ff53a, 0x5f1d36f1),
      u64(0x510e527f, 0xade682d1), u64(0x9b05688c, 0x2b3e6c1f),
      u64(0x1f83d9ab, 0xfb41bd6b), u64(0x5be0cd19, 0x137e2179),
    ]);
  }
}

/** SHA-384 = SHA-512 core, different IV, first 6 words (48 bytes). */
class Sha384 extends Sha512Base {
  constructor() {
    super([
      u64(0xcbbb9d5d, 0xc1059ed8), u64(0x629a292a, 0x367cd507),
      u64(0x9159015a, 0x3070dd17), u64(0x152fecd8, 0xf70e5939),
      u64(0x67332667, 0xffc00b31), u64(0x8eb44a87, 0x68581511),
      u64(0xdb0c2e0d, 0x64f98fa7), u64(0x47b5481d, 0xbefa4fa4),
    ]);
  }

  digest(): Uint8Array {
    return this.finish(6);
  }
}

export function sha256(data: Uint8Array): Uint8Array {
  return new Sha256().update(data).digest();
}

export function sha384(data: Uint8Array): Uint8Array {
  return new Sha384().update(data).digest();
}

export function sha512(data: Uint8Array): Uint8Array {
  return new Sha512().update(data).digest();
}

/* ------------------------------------------------------------------ */
/* AES-128 / AES-256 (pdf.js via @cantoo port)                         */
/* ------------------------------------------------------------------ */

const AES_S = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b,
  0xfe, 0xd7, 0xab, 0x76, 0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0,
  0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0, 0xb7, 0xfd, 0x93, 0x26,
  0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2,
  0xeb, 0x27, 0xb2, 0x75, 0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0,
  0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84, 0x53, 0xd1, 0x00, 0xed,
  0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f,
  0x50, 0x3c, 0x9f, 0xa8, 0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5,
  0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2, 0xcd, 0x0c, 0x13, 0xec,
  0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14,
  0xde, 0x5e, 0x0b, 0xdb, 0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c,
  0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79, 0xe7, 0xc8, 0x37, 0x6d,
  0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f,
  0x4b, 0xbd, 0x8b, 0x8a, 0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e,
  0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e, 0xe1, 0xf8, 0x98, 0x11,
  0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f,
  0xb0, 0x54, 0xbb, 0x16,
]);

const AES_INV_S = new Uint8Array([
  0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38, 0xbf, 0x40, 0xa3, 0x9e,
  0x81, 0xf3, 0xd7, 0xfb, 0x7c, 0xe3, 0x39, 0x82, 0x9b, 0x2f, 0xff, 0x87,
  0x34, 0x8e, 0x43, 0x44, 0xc4, 0xde, 0xe9, 0xcb, 0x54, 0x7b, 0x94, 0x32,
  0xa6, 0xc2, 0x23, 0x3d, 0xee, 0x4c, 0x95, 0x0b, 0x42, 0xfa, 0xc3, 0x4e,
  0x08, 0x2e, 0xa1, 0x66, 0x28, 0xd9, 0x24, 0xb2, 0x76, 0x5b, 0xa2, 0x49,
  0x6d, 0x8b, 0xd1, 0x25, 0x72, 0xf8, 0xf6, 0x64, 0x86, 0x68, 0x98, 0x16,
  0xd4, 0xa4, 0x5c, 0xcc, 0x5d, 0x65, 0xb6, 0x92, 0x6c, 0x70, 0x48, 0x50,
  0xfd, 0xed, 0xb9, 0xda, 0x5e, 0x15, 0x46, 0x57, 0xa7, 0x8d, 0x9d, 0x84,
  0x90, 0xd8, 0xab, 0x00, 0x8c, 0xbc, 0xd3, 0x0a, 0xf7, 0xe4, 0x58, 0x05,
  0xb8, 0xb3, 0x45, 0x06, 0xd0, 0x2c, 0x1e, 0x8f, 0xca, 0x3f, 0x0f, 0x02,
  0xc1, 0xaf, 0xbd, 0x03, 0x01, 0x13, 0x8a, 0x6b, 0x3a, 0x91, 0x11, 0x41,
  0x4f, 0x67, 0xdc, 0xea, 0x97, 0xf2, 0xcf, 0xce, 0xf0, 0xb4, 0xe6, 0x73,
  0x96, 0xac, 0x74, 0x22, 0xe7, 0xad, 0x35, 0x85, 0xe2, 0xf9, 0x37, 0xe8,
  0x1c, 0x75, 0xdf, 0x6e, 0x47, 0xf1, 0x1a, 0x71, 0x1d, 0x29, 0xc5, 0x89,
  0x6f, 0xb7, 0x62, 0x0e, 0xaa, 0x18, 0xbe, 0x1b, 0xfc, 0x56, 0x3e, 0x4b,
  0xc6, 0xd2, 0x79, 0x20, 0x9a, 0xdb, 0xc0, 0xfe, 0x78, 0xcd, 0x5a, 0xf4,
  0x1f, 0xdd, 0xa8, 0x33, 0x88, 0x07, 0xc7, 0x31, 0xb1, 0x12, 0x10, 0x59,
  0x27, 0x80, 0xec, 0x5f, 0x60, 0x51, 0x7f, 0xa9, 0x19, 0xb5, 0x4a, 0x0d,
  0x2d, 0xe5, 0x7a, 0x9f, 0x93, 0xc9, 0x9c, 0xef, 0xa0, 0xe0, 0x3b, 0x4d,
  0xae, 0x2a, 0xf5, 0xb0, 0xc8, 0xeb, 0xbb, 0x3c, 0x83, 0x53, 0x99, 0x61,
  0x17, 0x2b, 0x04, 0x7e, 0xba, 0x77, 0xd6, 0x26, 0xe1, 0x69, 0x14, 0x63,
  0x55, 0x21, 0x0c, 0x7d,
]);

const AES_INV_MIX = new Uint32Array([
  0x00000000, 0x0e090d0b, 0x1c121a16, 0x121b171d, 0x3824342c, 0x362d3927,
  0x24362e3a, 0x2a3f2331, 0x70486858, 0x7e416553, 0x6c5a724e, 0x62537f45,
  0x486c5c74, 0x4665517f, 0x547e4662, 0x5a774b69, 0xe090d0b0, 0xee99ddbb,
  0xfc82caa6, 0xf28bc7ad, 0xd8b4e49c, 0xd6bde997, 0xc4a6fe8a, 0xcaaff381,
  0x90d8b8e8, 0x9ed1b5e3, 0x8ccaa2fe, 0x82c3aff5, 0xa8fc8cc4, 0xa6f581cf,
  0xb4ee96d2, 0xbae79bd9, 0xdb3bbb7b, 0xd532b670, 0xc729a16d, 0xc920ac66,
  0xe31f8f57, 0xed16825c, 0xff0d9541, 0xf104984a, 0xab73d323, 0xa57ade28,
  0xb761c935, 0xb968c43e, 0x9357e70f, 0x9d5eea04, 0x8f45fd19, 0x814cf012,
  0x3bab6bcb, 0x35a266c0, 0x27b971dd, 0x29b07cd6, 0x038f5fe7, 0x0d8652ec,
  0x1f9d45f1, 0x119448fa, 0x4be30393, 0x45ea0e98, 0x57f11985, 0x59f8148e,
  0x73c737bf, 0x7dce3ab4, 0x6fd52da9, 0x61dc20a2, 0xad766df6, 0xa37f60fd,
  0xb16477e0, 0xbf6d7aeb, 0x955259da, 0x9b5b54d1, 0x894043cc, 0x87494ec7,
  0xdd3e05ae, 0xd33708a5, 0xc12c1fb8, 0xcf2512b3, 0xe51a3182, 0xeb133c89,
  0xf9082b94, 0xf701269f, 0x4de6bd46, 0x43efb04d, 0x51f4a750, 0x5ffdaa5b,
  0x75c2896a, 0x7bcb8461, 0x69d0937c, 0x67d99e77, 0x3daed51e, 0x33a7d815,
  0x21bccf08, 0x2fb5c203, 0x058ae132, 0x0b83ec39, 0x1998fb24, 0x1791f62f,
  0x764dd68d, 0x7844db86, 0x6a5fcc9b, 0x6456c190, 0x4e69e2a1, 0x4060efaa,
  0x527bf8b7, 0x5c72f5bc, 0x0605bed5, 0x080cb3de, 0x1a17a4c3, 0x141ea9c8,
  0x3e218af9, 0x302887f2, 0x223390ef, 0x2c3a9de4, 0x96dd063d, 0x98d40b36,
  0x8acf1c2b, 0x84c61120, 0xaef93211, 0xa0f03f1a, 0xb2eb2807, 0xbce2250c,
  0xe6956e65, 0xe89c636e, 0xfa877473, 0xf48e7978, 0xdeb15a49, 0xd0b85742,
  0xc2a3405f, 0xccaa4d54, 0x41ecdaf7, 0x4fe5d7fc, 0x5dfec0e1, 0x53f7cdea,
  0x79c8eedb, 0x77c1e3d0, 0x65daf4cd, 0x6bd3f9c6, 0x31a4b2af, 0x3fadbfa4,
  0x2db6a8b9, 0x23bfa5b2, 0x09808683, 0x07898b88, 0x15929c95, 0x1b9b919e,
  0xa17c0a47, 0xaf75074c, 0xbd6e1051, 0xb3671d5a, 0x99583e6b, 0x97513360,
  0x854a247d, 0x8b432976, 0xd134621f, 0xdf3d6f14, 0xcd267809, 0xc32f7502,
  0xe9105633, 0xe7195b38, 0xf5024c25, 0xfb0b412e, 0x9ad7618c, 0x94de6c87,
  0x86c57b9a, 0x88cc7691, 0xa2f355a0, 0xacfa58ab, 0xbee14fb6, 0xb0e842bd,
  0xea9f09d4, 0xe49604df, 0xf68d13c2, 0xf8841ec9, 0xd2bb3df8, 0xdcb230f3,
  0xcea927ee, 0xc0a02ae5, 0x7a47b13c, 0x744ebc37, 0x6655ab2a, 0x685ca621,
  0x42638510, 0x4c6a881b, 0x5e719f06, 0x5078920d, 0x0a0fd964, 0x0406d46f,
  0x161dc372, 0x1814ce79, 0x322bed48, 0x3c22e043, 0x2e39f75e, 0x2030fa55,
  0xec9ab701, 0xe293ba0a, 0xf088ad17, 0xfe81a01c, 0xd4be832d, 0xdab78e26,
  0xc8ac993b, 0xc6a59430, 0x9cd2df59, 0x92dbd252, 0x80c0c54f, 0x8ec9c844,
  0xa4f6eb75, 0xaaffe67e, 0xb8e4f163, 0xb6edfc68, 0x0c0a67b1, 0x02036aba,
  0x10187da7, 0x1e1170ac, 0x342e539d, 0x3a275e96, 0x283c498b, 0x26354480,
  0x7c420fe9, 0x724b02e2, 0x605015ff, 0x6e5918f4, 0x44663bc5, 0x4a6f36ce,
  0x587421d3, 0x567d2cd8, 0x37a10c7a, 0x39a80171, 0x2bb3166c, 0x25ba1b67,
  0x0f853856, 0x018c355d, 0x13972240, 0x1d9e2f4b, 0x47e96422, 0x49e06929,
  0x5bfb7e34, 0x55f2733f, 0x7fcd500e, 0x71c45d05, 0x63df4a18, 0x6dd64713,
  0xd731dcca, 0xd938d1c1, 0xcb23c6dc, 0xc52acbd7, 0xef15e8e6, 0xe11ce5ed,
  0xf307f2f0, 0xfd0efffb, 0xa779b492, 0xa970b999, 0xbb6bae84, 0xb562a38f,
  0x9f5d80be, 0x91548db5, 0x834f9aa8, 0x8d4697a3,
]);

const AES_RCON = new Uint8Array([
  0x8d, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c,
  0xd8, 0xab, 0x4d, 0x9a, 0x2f, 0x5e, 0xbc, 0x63, 0xc6, 0x97, 0x35, 0x6a,
  0xd4, 0xb3, 0x7d, 0xfa, 0xef, 0xc5, 0x91, 0x39, 0x72, 0xe4, 0xd3, 0xbd,
  0x61, 0xc2, 0x9f, 0x25, 0x4a, 0x94, 0x33, 0x66, 0xcc, 0x83, 0x1d, 0x3a,
  0x74, 0xe8, 0xcb, 0x8d, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80,
  0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d, 0x9a, 0x2f, 0x5e, 0xbc, 0x63, 0xc6,
  0x97, 0x35, 0x6a, 0xd4, 0xb3, 0x7d, 0xfa, 0xef, 0xc5, 0x91, 0x39, 0x72,
  0xe4, 0xd3, 0xbd, 0x61, 0xc2, 0x9f, 0x25, 0x4a, 0x94, 0x33, 0x66, 0xcc,
  0x83, 0x1d, 0x3a, 0x74, 0xe8, 0xcb, 0x8d, 0x01, 0x02, 0x04, 0x08, 0x10,
  0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d, 0x9a, 0x2f, 0x5e,
  0xbc, 0x63, 0xc6, 0x97, 0x35, 0x6a, 0xd4, 0xb3, 0x7d, 0xfa, 0xef, 0xc5,
  0x91, 0x39, 0x72, 0xe4, 0xd3, 0xbd, 0x61, 0xc2, 0x9f, 0x25, 0x4a, 0x94,
  0x33, 0x66, 0xcc, 0x83, 0x1d, 0x3a, 0x74, 0xe8, 0xcb, 0x8d, 0x01, 0x02,
  0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d,
  0x9a, 0x2f, 0x5e, 0xbc, 0x63, 0xc6, 0x97, 0x35, 0x6a, 0xd4, 0xb3, 0x7d,
  0xfa, 0xef, 0xc5, 0x91, 0x39, 0x72, 0xe4, 0xd3, 0xbd, 0x61, 0xc2, 0x9f,
  0x25, 0x4a, 0x94, 0x33, 0x66, 0xcc, 0x83, 0x1d, 0x3a, 0x74, 0xe8, 0xcb,
  0x8d,
]);

class Aes {
  private readonly s = AES_S;
  /** BYTE OFFSET of the final round key in the expanded key (160/224 —
   * NOT the expanded size; the final AddRoundKey reads [offset, +16)). */
  private readonly finalRoundKeyOffset: number;
  private readonly rounds: number; // 10 / 14
  private readonly expandedKey: Uint8Array;

  constructor(cipherKey: Uint8Array) {
    if (cipherKey.length === 16) {
      this.rounds = 10;
      this.finalRoundKeyOffset = 160;
      this.expandedKey = this.expandKey128(cipherKey);
    } else if (cipherKey.length === 32) {
      this.rounds = 14;
      this.finalRoundKeyOffset = 224;
      this.expandedKey = this.expandKey256(cipherKey);
    } else {
      throw new Error("AES key must be 128 or 256 bits");
    }
  }

  private expandKey128(cipherKey: Uint8Array): Uint8Array {
    const b = 176;
    const s = this.s;
    const rcon = AES_RCON;
    const result = new Uint8Array(b);
    result.set(cipherKey);
    for (let j = 16, i = 1; j < b; ++i) {
      // RotWord
      let t1 = result[j - 3]!;
      let t2 = result[j - 2]!;
      let t3 = result[j - 1]!;
      let t4 = result[j - 4]!;
      // SubWord
      t1 = s[t1]!;
      t2 = s[t2]!;
      t3 = s[t3]!;
      t4 = s[t4]!;
      // Rcon
      t1 ^= rcon[i]!;
      for (let n = 0; n < 4; ++n) {
        result[j] = t1 ^= result[j - 16]!;
        j++;
        result[j] = t2 ^= result[j - 16]!;
        j++;
        result[j] = t3 ^= result[j - 16]!;
        j++;
        result[j] = t4 ^= result[j - 16]!;
        j++;
      }
    }
    return result;
  }

  private expandKey256(cipherKey: Uint8Array): Uint8Array {
    const b = 240;
    const s = this.s;
    const result = new Uint8Array(b);
    result.set(cipherKey);
    let r = 1;
    let t1 = 0, t2 = 0, t3 = 0, t4 = 0;
    for (let j = 32, i = 1; j < b; ++i) {
      if (j % 32 === 16) {
        t1 = s[t1]!;
        t2 = s[t2]!;
        t3 = s[t3]!;
        t4 = s[t4]!;
      } else if (j % 32 === 0) {
        // RotWord
        t1 = result[j - 3]!;
        t2 = result[j - 2]!;
        t3 = result[j - 1]!;
        t4 = result[j - 4]!;
        // SubWord
        t1 = s[t1]!;
        t2 = s[t2]!;
        t3 = s[t3]!;
        t4 = s[t4]!;
        // Rcon
        t1 ^= r;
        if ((r <<= 1) >= 256) {
          r = (r ^ 0x1b) & 0xff;
        }
      }
      for (let n = 0; n < 4; ++n) {
        result[j] = t1 ^= result[j - 32]!;
        j++;
        result[j] = t2 ^= result[j - 32]!;
        j++;
        result[j] = t3 ^= result[j - 32]!;
        j++;
        result[j] = t4 ^= result[j - 32]!;
        j++;
      }
    }
    return result;
  }

  /** Raw AES block encryption (16 bytes in, 16 out). */
  encryptBlock(input: Uint8Array): Uint8Array {
    const s = this.s;
    let t, u, v;
    const state = new Uint8Array(16);
    state.set(input);
    for (let j = 0; j < 16; ++j) state[j] ^= this.expandedKey[j]!;
    for (let i = 1; i < this.rounds; i++) {
      // SubBytes
      for (let j = 0; j < 16; ++j) state[j] = s[state[j]!]!;
      // ShiftRows
      v = state[1]!;
      state[1] = state[5]!;
      state[5] = state[9]!;
      state[9] = state[13]!;
      state[13] = v;
      v = state[2]!;
      u = state[6]!;
      state[2] = state[10]!;
      state[6] = state[14]!;
      state[10] = v;
      state[14] = u;
      v = state[3]!;
      u = state[7]!;
      t = state[11]!;
      state[3] = state[15]!;
      state[7] = v;
      state[11] = u;
      state[15] = t;
      // MixColumns (xtime table inline)
      for (let j = 0; j < 16; j += 4) {
        const s0 = state[j]!;
        const s1 = state[j + 1]!;
        const s2 = state[j + 2]!;
        const s3 = state[j + 3]!;
        t = s0 ^ s1 ^ s2 ^ s3;
        state[j] ^= t ^ xtime(s0 ^ s1);
        state[j + 1] ^= t ^ xtime(s1 ^ s2);
        state[j + 2] ^= t ^ xtime(s2 ^ s3);
        state[j + 3] ^= t ^ xtime(s3 ^ s0);
      }
      // AddRoundKey
      for (let j = 0, k = i * 16; j < 16; ++j, ++k) {
        state[j] ^= this.expandedKey[k]!;
      }
    }
    // SubBytes
    for (let j = 0; j < 16; ++j) state[j] = s[state[j]!]!;
    // ShiftRows
    v = state[1]!;
    state[1] = state[5]!;
    state[5] = state[9]!;
    state[9] = state[13]!;
    state[13] = v;
    v = state[2]!;
    u = state[6]!;
    state[2] = state[10]!;
    state[6] = state[14]!;
    state[10] = v;
    state[14] = u;
    v = state[3]!;
    u = state[7]!;
    t = state[11]!;
    state[3] = state[15]!;
    state[7] = v;
    state[11] = u;
    state[15] = t;
    // AddRoundKey (final round — offset into the expanded key)
    for (let j = 0, k = this.finalRoundKeyOffset; j < 16; ++j, ++k) {
      state[j] ^= this.expandedKey[k]!;
    }
    return state;
  }

  /** Raw AES block decryption (16 bytes in, 16 out). */
  decryptBlock(input: Uint8Array): Uint8Array {
    let t, u, v;
    const state = new Uint8Array(16);
    state.set(input);
    // AddRoundKey (final round — offset into the expanded key)
    for (let j = 0, k = this.finalRoundKeyOffset; j < 16; ++j, ++k) {
      state[j] ^= this.expandedKey[k]!;
    }
    for (let i = this.rounds - 1; i >= 1; --i) {
      // InvShiftRows
      t = state[13]!;
      state[13] = state[9]!;
      state[9] = state[5]!;
      state[5] = state[1]!;
      state[1] = t;
      t = state[14]!;
      u = state[10]!;
      state[14] = state[6]!;
      state[10] = state[2]!;
      state[6] = t;
      state[2] = u;
      t = state[15]!;
      u = state[11]!;
      v = state[7]!;
      state[15] = state[3]!;
      state[11] = t;
      state[7] = u;
      state[3] = v;
      // InvSubBytes
      for (let j = 0; j < 16; ++j) state[j] = AES_INV_S[state[j]!]!;
      // AddRoundKey
      for (let j = 0, k = i * 16; j < 16; ++j, ++k) {
        state[j] ^= this.expandedKey[k]!;
      }
      // InvMixColumns
      for (let j = 0; j < 16; j += 4) {
        const s0 = AES_INV_MIX[state[j]!]!;
        const s1 = AES_INV_MIX[state[j + 1]!]!;
        const s2 = AES_INV_MIX[state[j + 2]!]!;
        const s3 = AES_INV_MIX[state[j + 3]!]!;
        t = s0 ^ (s1 >>> 8) ^ (s1 << 24) ^ (s2 >>> 16) ^ (s2 << 16) ^ (s3 >>> 24) ^ (s3 << 8);
        state[j] = (t >>> 24) & 0xff;
        state[j + 1] = (t >> 16) & 0xff;
        state[j + 2] = (t >> 8) & 0xff;
        state[j + 3] = t & 0xff;
      }
    }
    // InvShiftRows
    t = state[13]!;
    state[13] = state[9]!;
    state[9] = state[5]!;
    state[5] = state[1]!;
    state[1] = t;
    t = state[14]!;
    u = state[10]!;
    state[14] = state[6]!;
    state[10] = state[2]!;
    state[6] = t;
    state[2] = u;
    t = state[15]!;
    u = state[11]!;
    v = state[7]!;
    state[15] = state[3]!;
    state[11] = t;
    state[7] = u;
    state[3] = v;
    for (let j = 0; j < 16; ++j) {
      // InvSubBytes + AddRoundKey
      state[j] = AES_INV_S[state[j]!]! ^ this.expandedKey[j]!;
    }
    return state;
  }
}

/** GF(2^8) doubling for MixColumns. */
function xtime(a: number): number {
  return a < 128 ? (a << 1) & 0xff : ((a << 1) ^ 0x1b) & 0xff;
}

/**
 * AES-CBC encryption over full 16-byte blocks only (any trailing partial
 * block is DISCARDED — @cantoo semantics: the caller pre-pads). Returns
 * exactly floor(data.length / 16) blocks.
 */
export function aesCbcEncryptBlocks(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array
): Uint8Array {
  const aes = new Aes(key);
  const blocks = Math.floor(data.length / 16);
  const out = new Uint8Array(blocks * 16);
  let prev = iv;
  for (let b = 0; b < blocks; b += 1) {
    const block = new Uint8Array(16);
    for (let j = 0; j < 16; j += 1) block[j] = data[b * 16 + j]! ^ prev[j]!;
    const ct = aes.encryptBlock(block);
    out.set(ct, b * 16);
    prev = ct;
  }
  return out;
}

/** AES-CBC decryption (data length must be a multiple of 16). */
export function aesCbcDecryptBlocks(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array
): Uint8Array {
  const aes = new Aes(key);
  const blocks = data.length / 16;
  if (!Number.isInteger(blocks)) {
    throw new Error("AES-CBC ciphertext is not block-aligned");
  }
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let b = 0; b < blocks; b += 1) {
    const ct = data.subarray(b * 16, b * 16 + 16);
    const pt = aes.decryptBlock(ct);
    for (let j = 0; j < 16; j += 1) out[b * 16 + j] = pt[j]! ^ prev[j]!;
    prev = ct;
  }
  return out;
}

/** PKCS#7 pad to the next 16-byte boundary (a full block when aligned). */
export function pkcs7Pad(data: Uint8Array): Uint8Array {
  const padding = 16 - (data.length % 16);
  const padded = new Uint8Array(data.length + padding);
  padded.set(data);
  padded.fill(padding, data.length);
  return padded;
}

/** Strip valid PKCS#7 padding; returns data unchanged when invalid. */
export function pkcs7Strip(data: Uint8Array): Uint8Array {
  if (data.length === 0 || data.length % 16 !== 0) return data;
  const n = data[data.length - 1]!;
  if (n < 1 || n > 16 || n > data.length) return data;
  for (let i = data.length - n; i < data.length; i += 1) {
    if (data[i]! !== n) return data; // invalid — keep raw
  }
  return data.subarray(0, data.length - n);
}

/** PDF security string/stream encryption: random IV + pkcs7 + CBC. */
export function aesEncryptWithIv(key: Uint8Array, data: Uint8Array): Uint8Array {
  const iv = randomBytes(16);
  return concat(iv, aesCbcEncryptBlocks(key, iv, pkcs7Pad(data)));
}

/** PDF security string/stream decryption: IV-prefixed + pkcs7 strip.
 *  Tolerates trailing partial blocks (pdf.js streaming semantics: the
 *  incomplete tail stays buffered and is dropped — some writers emit
 *  unaligned stream tails). */
export function aesDecryptWithIv(
  key: Uint8Array,
  data: Uint8Array,
  stripPad = true
): Uint8Array {
  if (data.length <= 16) return new Uint8Array(0); // IV only (or less)
  const iv = data.subarray(0, 16);
  const body = data.subarray(16);
  const blocks = Math.floor(body.length / 16);
  if (blocks === 0) return new Uint8Array(0);
  const pt = aesCbcDecryptBlocks(key, iv, body.subarray(0, blocks * 16));
  return stripPad ? pkcs7Strip(pt) : pt;
}

/** AES-CBC with an EXPLICIT IV and no padding handling (UE/OE/Perms). */
export function aesCbcEncryptNoPad(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array
): Uint8Array {
  return aesCbcEncryptBlocks(key, iv, data);
}

export function aesCbcDecryptNoPad(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array
): Uint8Array {
  return aesCbcDecryptBlocks(key, iv, data);
}

/* ------------------------------------------------------------------ */
/* R6 password encoding + Algorithm 2.B                                */
/* ------------------------------------------------------------------ */

/**
 * ISO 32000-2 §7.6.4.3.3: SASLprep/UTF-8, truncated to 127 bytes.
 * TextEncoder equals the `unescape(encodeURIComponent(s))` idiom.
 */
export function r6PasswordBytes(password: string): Uint8Array {
  const encoded = new TextEncoder().encode(password);
  return encoded.subarray(0, Math.min(127, encoded.length));
}

/**
 * ISO 32000-2 Algorithm 2.B (the R6 hash chain). Port of pdf.js's
 * calculatePDF20Hash (via @cantoo) — AES-128-CBC keyed from the running
 * hash, next-hash selection by the first-block byte sum mod 3, loop until
 * 64 rounds AND the chain's last output byte ≤ i - 32.
 */
export function pdf20Hash(
  password: Uint8Array,
  input: Uint8Array,
  userBytes: Uint8Array
): Uint8Array {
  let k = sha256(input).subarray(0, 32);
  let e: Uint8Array = new Uint8Array([0]);
  let i = 0;
  while (i < 64 || e[e.length - 1]! > i - 32) {
    const combinedLength = password.length + k.length + userBytes.length;
    const combinedArray = new Uint8Array(combinedLength);
    combinedArray.set(password, 0);
    combinedArray.set(k, password.length);
    combinedArray.set(userBytes, password.length + k.length);

    const k1 = new Uint8Array(combinedLength * 64);
    for (let j = 0, pos = 0; j < 64; j++, pos += combinedLength) {
      k1.set(combinedArray, pos);
    }
    e = aesCbcEncryptBlocks(k.subarray(0, 16), k.subarray(16, 32), k1);
    const remainder = e.slice(0, 16).reduce((a, b) => a + b, 0) % 3;
    k =
      remainder === 0
        ? sha256(e)
        : remainder === 1
          ? sha384(e)
          : sha512(e);
    i++;
  }
  return k.subarray(0, 32);
}

export { concat as concatBytes, bytesEqual };
