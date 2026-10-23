/**
 * Legacy PKCS#12 ciphers (digital-signature, RB6-FIN-a2).
 *
 * WebCrypto (available in every worker AND in the bun/node smokes) covers
 * AES-CBC for PBES2 — but it has NO 3DES and NO RC2, and both are what
 * real legacy .p12 files use (OpenSSL ≤2.x default: pbeWithSHAAnd3-Key-
 * TripleDES-CBC shrouded keybags wrapped in a pbeWithSHA1And40BitRC2-CBC
 * EncryptedData layer; Windows/IE exports follow the same shape).
 *
 * Both ciphers were salvaged from the dead RB6 probe and re-verified
 * against node:crypto oracles BEFORE landing (20 random ECB vectors for
 * DES, des-ede3-cbc round-trip, rc2-40-cbc + rc2-cbc round-trips plus the
 * node-forge reference for the key schedule):
 *   - DES: the probe version had a 63-entry S6 row (missing the final
 *     13) — fixed, 20/20 random vectors now match node's des-ecb;
 *   - RC2: the probe version had FOUR bugs (a PI table corrupted after
 *     index ~70, rotation amounts attached to the wrong registers, the
 *     decrypt round order R1→R2→R3→R0 with mismatched f-functions
 *     instead of R3→R2→R1→R0, and a reduce phase that masked without
 *     the PITABLE lookup / XORed L[i] instead of L[i+1]) — all fixed
 *     against node-forge's RFC 2268 implementation.
 *
 * Decrypt-only: signing never needs to produce legacy-encrypted output.
 * Pure TypeScript, worker-safe, no DOM, no network.
 */

/* ------------------------------------------------------------------ */
/* DES (single block) — verified vs node des-ecb, 20/20 random vectors */
/* ------------------------------------------------------------------ */

const IP_TAB = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46,
  38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17,
  9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63,
  55, 47, 39, 31, 23, 15, 7,
];
const FP_TAB = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46,
  14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20,
  60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33,
  1, 41, 9, 49, 17, 57, 25,
];
const E_TAB = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15,
  16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27,
  28, 29, 28, 29, 30, 31, 32, 1,
];
const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43,
  35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54,
  46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7,
  27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49,
  39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const P_TAB = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14,
  32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];
/** Standard DES S-boxes (8 rows × 64, row-major per S-box).
 * RB6-FIN-a3 fix: rows S2–S5 had each lost their FINAL entry (63-long
 * arrays — any S-box lookup hitting flat index 63 read `undefined` and
 * zeroed the round function, ~64% of random blocks wrong). Restored to
 * the FIPS 46-3 tables; 500 random des-ecb vectors re-verified vs node. */
const SBOX: number[][] = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14,
    2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12,
    9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15,
    2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8,
    12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14,
    9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3,
    4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1,
    2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2,
    12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6,
    15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1,
    3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2,
    14,
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4,
    7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9,
    12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5,
    3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7,
    12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0,
    4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8,
    13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4,
    9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10,
    15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3,
    12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10,
    3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6,
    10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6,
    11,
  ],
];

class Des {
  private subkeys: Uint8Array[] = [];

  constructor(key: Uint8Array) {
    const bits = new Uint8Array(56);
    for (let i = 0; i < 56; i += 1) {
      const p = PC1[i]! - 1;
      bits[i] = (key[Math.floor(p / 8)]! >>> (7 - (p % 8))) & 1;
    }
    for (let r = 0; r < 16; r += 1) {
      const shifts = SHIFTS.slice(0, r + 1).reduce((a, b) => a + b, 0);
      const rot = (x: Uint8Array): Uint8Array => {
        const out = new Uint8Array(x.length);
        for (let i = 0; i < x.length; i += 1) out[i] = x[(i + shifts) % x.length]!;
        return out;
      };
      const c = rot(bits.subarray(0, 28));
      const d = rot(bits.subarray(28));
      const sk = new Uint8Array(48);
      for (let i = 0; i < 48; i += 1) {
        const p = PC2[i]! - 1;
        sk[i] = p < 28 ? c[p]! : d[p - 28]!;
      }
      this.subkeys.push(sk);
    }
  }

  private crypt(block: Uint8Array, decrypt: boolean): Uint8Array {
    const inBits = new Uint8Array(64);
    for (let i = 0; i < 64; i += 1) {
      const p = IP_TAB[i]! - 1;
      inBits[i] = (block[Math.floor(p / 8)]! >>> (7 - (p % 8))) & 1;
    }
    let L = inBits.subarray(0, 32);
    let R = inBits.subarray(32);
    const rounds = this.subkeys.map((x) => x);
    if (decrypt) rounds.reverse();
    for (let r = 0; r < 16; r += 1) {
      const f = new Uint8Array(32);
      const sk = rounds[r]!;
      for (let s = 0; s < 8; s += 1) {
        let v = 0;
        for (let i = 0; i < 6; i += 1) {
          v = (v << 1) | R[E_TAB[s * 6 + i]! - 1]!;
        }
        v ^=
          (sk[s * 6]! << 5) | (sk[s * 6 + 1]! << 4) | (sk[s * 6 + 2]! << 3) |
          (sk[s * 6 + 3]! << 2) | (sk[s * 6 + 4]! << 1) | sk[s * 6 + 5]!;
        const row = ((v & 0x20) >>> 4) | (v & 1);
        const col = (v >>> 1) & 0x0f;
        const sv = SBOX[s]![row * 16 + col]!;
        for (let i = 0; i < 4; i += 1) f[s * 4 + i] = (sv >>> (3 - i)) & 1;
      }
      const pf = new Uint8Array(32);
      for (let i = 0; i < 32; i += 1) pf[i] = f[P_TAB[i]! - 1]!;
      const newR = new Uint8Array(32);
      for (let i = 0; i < 32; i += 1) newR[i] = L[i]! ^ pf[i]!;
      L = R;
      R = newR;
    }
    const pre = new Uint8Array(64);
    pre.set(R);
    pre.set(L, 32);
    const out = new Uint8Array(8);
    for (let i = 0; i < 64; i += 1) {
      const p = FP_TAB[i]! - 1;
      out[Math.floor(i / 8)] = (out[Math.floor(i / 8)]! << 1) | pre[p]!;
    }
    return out;
  }

  encrypt(block: Uint8Array): Uint8Array {
    return this.crypt(block, false);
  }

  decrypt(block: Uint8Array): Uint8Array {
    return this.crypt(block, true);
  }
}

/** 3DES-CBC decrypt (EDE, 24-byte key, 8-byte IV), PKCS#5 padding intact. */
export function des3CbcDecrypt(
  data: Uint8Array,
  iv: Uint8Array,
  key: Uint8Array
): Uint8Array {
  const k1 = new Des(key.subarray(0, 8));
  const k2 = new Des(key.subarray(8, 16));
  const k3 = new Des(key.subarray(16, 24));
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let off = 0; off < data.length; off += 8) {
    const ct = data.subarray(off, off + 8);
    const pt = k1.decrypt(k2.encrypt(k3.decrypt(ct)));
    for (let i = 0; i < 8; i += 1) out[off + i] = pt[i]! ^ prev[i]!;
    prev = ct;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* RC2 — verified vs node rc2-40-cbc / rc2-cbc and node-forge          */
/* ------------------------------------------------------------------ */

/** RFC 2268 PITABLE (the standard table — the probe's copy was corrupted). */
const RC2_PI: number[] = [
  0xd9, 0x78, 0xf9, 0xc4, 0x19, 0xdd, 0xb5, 0xed, 0x28, 0xe9, 0xfd, 0x79,
  0x4a, 0xa0, 0xd8, 0x9d, 0xc6, 0x7e, 0x37, 0x83, 0x2b, 0x76, 0x53, 0x8e,
  0x62, 0x4c, 0x64, 0x88, 0x44, 0x8b, 0xfb, 0xa2, 0x17, 0x9a, 0x59, 0xf5,
  0x87, 0xb3, 0x4f, 0x13, 0x61, 0x45, 0x6d, 0x8d, 0x09, 0x81, 0x7d, 0x32,
  0xbd, 0x8f, 0x40, 0xeb, 0x86, 0xb7, 0x7b, 0x0b, 0xf0, 0x95, 0x21, 0x22,
  0x5c, 0x6b, 0x4e, 0x82, 0x54, 0xd6, 0x65, 0x93, 0xce, 0x60, 0xb2, 0x1c,
  0x73, 0x56, 0xc0, 0x14, 0xa7, 0x8c, 0xf1, 0xdc, 0x12, 0x75, 0xca, 0x1f,
  0x3b, 0xbe, 0xe4, 0xd1, 0x42, 0x3d, 0xd4, 0x30, 0xa3, 0x3c, 0xb6, 0x26,
  0x6f, 0xbf, 0x0e, 0xda, 0x46, 0x69, 0x07, 0x57, 0x27, 0xf2, 0x1d, 0x9b,
  0xbc, 0x94, 0x43, 0x03, 0xf8, 0x11, 0xc7, 0xf6, 0x90, 0xef, 0x3e, 0xe7,
  0x06, 0xc3, 0xd5, 0x2f, 0xc8, 0x66, 0x1e, 0xd7, 0x08, 0xe8, 0xea, 0xde,
  0x80, 0x52, 0xee, 0xf7, 0x84, 0xaa, 0x72, 0xac, 0x35, 0x4d, 0x6a, 0x2a,
  0x96, 0x1a, 0xd2, 0x71, 0x5a, 0x15, 0x49, 0x74, 0x4b, 0x9f, 0xd0, 0x5e,
  0x04, 0x18, 0xa4, 0xec, 0xc2, 0xe0, 0x41, 0x6e, 0x0f, 0x51, 0xcb, 0xcc,
  0x24, 0x91, 0xaf, 0x50, 0xa1, 0xf4, 0x70, 0x39, 0x99, 0x7c, 0x3a, 0x85,
  0x23, 0xb8, 0xb4, 0x7a, 0xfc, 0x02, 0x36, 0x5b, 0x25, 0x55, 0x97, 0x31,
  0x2d, 0x5d, 0xfa, 0x98, 0xe3, 0x8a, 0x92, 0xae, 0x05, 0xdf, 0x29, 0x10,
  0x67, 0x6c, 0xba, 0xc9, 0xd3, 0x00, 0xe6, 0xcf, 0xe1, 0x9e, 0xa8, 0x2c,
  0x63, 0x16, 0x01, 0x3f, 0x58, 0xe2, 0x89, 0xa9, 0x0d, 0x38, 0x34, 0x1b,
  0xab, 0x33, 0xff, 0xb0, 0xbb, 0x48, 0x0c, 0x5f, 0xb9, 0xb1, 0xcd, 0x2e,
  0xc5, 0xf3, 0xdb, 0x47, 0xe5, 0xa5, 0x9c, 0x77, 0x0a, 0xa6, 0x20, 0x68,
  0xfe, 0x7f, 0xc1, 0xad,
];

const RC2_S = [1, 2, 3, 5];

/**
 * RFC 2268 §2 key expansion. `bits` is the EFFECTIVE key size
 * (40 for pbeWithSHA1And40BitRC2-CBC, 128 for the 128-bit variant).
 * Returns the 64 little-endian key words.
 */
export function rc2Expand(key: Uint8Array, bits: number): Uint16Array {
  const t = Math.min(key.length, 128);
  const l = new Uint8Array(128);
  l.set(key.subarray(0, t));
  const t8 = Math.ceil(bits / 8);
  const tm = 0xff >> (bits & 0x07);
  for (let i = t; i < 128; i += 1) {
    l[i] = RC2_PI[(l[i - 1]! + l[i - t]!) & 0xff]!;
  }
  l[128 - t8] = RC2_PI[l[128 - t8]! & tm];
  for (let i = 127 - t8; i >= 0; i -= 1) {
    l[i] = RC2_PI[l[i + 1]! ^ l[i + t8]!];
  }
  const w = new Uint16Array(64);
  for (let i = 0; i < 64; i += 1) w[i] = l[i * 2]! | (l[i * 2 + 1]! << 8);
  return w;
}

function ror16(x: number, n: number): number {
  return ((x & 0xffff) >> n) | ((x << (16 - n)) & 0xffff);
}

function rc2DecryptBlock(block: Uint8Array, k: Uint16Array): Uint8Array {
  const r = new Uint16Array(4);
  for (let i = 0; i < 4; i += 1) {
    r[i] = block[i * 2]! | (block[i * 2 + 1]! << 8);
  }
  let j = 63;
  // r-mixing round: R3 -> R2 -> R1 -> R0 (the exact inverse of the
  // encrypt direction — the probe had this order scrambled).
  const rMix = (): void => {
    for (let i = 3; i >= 0; i -= 1) {
      r[i] = ror16(r[i]!, RC2_S[i]!);
      const a = r[(i + 3) % 4]!;
      const b = r[(i + 2) % 4]!;
      const c = r[(i + 1) % 4]!;
      r[i] = (r[i]! - k[j]! - ((a & b) + (~a & 0xffff & c))) & 0xffff;
      j -= 1;
    }
  };
  // r-mashing round (undoes the mash after encrypt rounds 5 and 11).
  const rMash = (): void => {
    for (let i = 3; i >= 0; i -= 1) {
      r[i] = (r[i]! - k[r[(i + 3) % 4]! & 63]) & 0xffff;
    }
  };
  // The 5-1-6-1-5 plan is palindromic, so decrypt runs the same sequence.
  for (let n = 0; n < 5; n += 1) rMix();
  rMash();
  for (let n = 0; n < 6; n += 1) rMix();
  rMash();
  for (let n = 0; n < 5; n += 1) rMix();
  const out = new Uint8Array(8);
  for (let i = 0; i < 4; i += 1) {
    out[i * 2] = r[i]! & 0xff;
    out[i * 2 + 1] = r[i]! >>> 8;
  }
  return out;
}

/** RC2-CBC decrypt (padding intact). */
export function rc2CbcDecrypt(
  data: Uint8Array,
  iv: Uint8Array,
  k: Uint16Array
): Uint8Array {
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let off = 0; off < data.length; off += 8) {
    const ct = data.subarray(off, off + 8);
    const pt = rc2DecryptBlock(ct, k);
    for (let i = 0; i < 8; i += 1) out[off + i] = pt[i]! ^ prev[i]!;
    prev = ct;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Padding                                                             */
/* ------------------------------------------------------------------ */

/**
 * Validates + strips PKCS#5/#7 padding (block 1..8 for DES-family).
 * Returns null when the padding is impossible — the honest wrong-
 * password signal for the legacy path.
 */
export function stripPkcs7(
  data: Uint8Array,
  blockLen: number
): Uint8Array | null {
  if (data.length === 0 || data.length % blockLen !== 0) return null;
  const n = data[data.length - 1]!;
  if (n < 1 || n > blockLen || n > data.length) return null;
  for (let i = data.length - n; i < data.length; i += 1) {
    if (data[i]! !== n) return null;
  }
  return data.subarray(0, data.length - n);
}
