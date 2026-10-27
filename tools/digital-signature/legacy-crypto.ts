/**
 * Legacy PKCS#12 crypto — hand-rolled, zero deps (PRD §7.6 Security:
 * `digital-signature`, Mode D).
 *
 * Modern .p12/.pfx files (OpenSSL 3.x, Java 9+, Windows 10+) encrypt
 * with PBES2 (PBKDF2 + AES-CBC), which WebCrypto handles natively. But
 * the files users actually own were exported years ago with PBES1:
 *
 *   1.2.840.113549.1.12.1.3  pbeWithSHAAnd3-KeyTripleDES-CBC  (OpenSSL
 *                            -legacy keys, Windows exports, Java 8 —
 *                            the common case for Indian CA-issued .pfx
 *                            files from eMudhra / Capricorn era tooling)
 *   1.2.840.113549.1.12.1.5  pbeWithSHAAnd128BitRC2-CBC
 *   1.2.840.113549.1.12.1.6  pbeWithSHAAnd40BitRC2-CBC (OpenSSL -legacy
 *                            certificates bag)
 *
 * WebCrypto will never grow DES/RC2, so this module implements the three
 * pieces needed to open those files on-device:
 *
 *   - the PKCS#12 key-derivation function (RFC 7292 appendix B.2) — the
 *     same KDF produces the MAC key (ID 3), the encryption key (ID 1)
 *     and the IV (ID 2);
 *   - DES + 3DES-EDE (FIPS 46-3, byte-exact against `openssl enc`);
 *   - RC2 (RFC 2268, byte-exact against `openssl enc -rc2-*-cbc` and
 *     the RFC's own published vectors).
 *
 * Everything is decrypt-only where possible; 3DES needs both directions
 * (EDE decrypt = D(K1, E(K2, D(K3, C)))). The smoke suite pins all of
 * this against openssl-generated vectors, so a wrong S-box nibble or
 * PI-table byte cannot survive.
 */

/* ----------------------------------------------------------------- PKCS#12 KDF */

const KDF_HASH_BYTES: Record<string, number> = {
  "SHA-1": 20,
  "SHA-256": 32,
  "SHA-384": 48,
  "SHA-512": 64,
};
const KDF_BLOCK_BYTES: Record<string, number> = {
  "SHA-1": 64,
  "SHA-256": 64,
  "SHA-384": 128,
  "SHA-512": 128,
};

async function hashOf(algo: string, data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest(
    algo,
    data.slice().buffer as ArrayBuffer
  );
  return new Uint8Array(buf);
}

/** Password as UTF-16BE + 0x0000 terminator (RFC 7292 "BMPString"). */
function bmpPassword(password: string): Uint8Array {
  const out = new Uint8Array(password.length * 2 + 2);
  for (let i = 0; i < password.length; i += 1) {
    const code = password.charCodeAt(i);
    out[i * 2] = (code >> 8) & 0xff;
    out[i * 2 + 1] = code & 0xff;
  }
  return out;
}

/**
 * RFC 7292 B.2 PKCS#12 key derivation. `id` selects the purpose:
 * 1 = encryption key, 2 = IV, 3 = MAC key (same KDF, different ID byte).
 */
export async function pkcs12Kdf(
  hashAlgorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512",
  outputBytes: number,
  password: string,
  salt: Uint8Array,
  iterations: number,
  id: number
): Promise<Uint8Array> {
  const u = KDF_HASH_BYTES[hashAlgorithm];
  const v = KDF_BLOCK_BYTES[hashAlgorithm];
  if (iterations < 1) iterations = 1;

  const D = new Uint8Array(v).fill(id);
  const pass = bmpPassword(password);

  // S = salt padded to a multiple of v by repetition.
  const S =
    salt.length === 0
      ? new Uint8Array(0)
      : new Uint8Array(v * Math.ceil(salt.length / v));
  for (let i = 0; i < S.length; i += 1) S[i] = salt[i % salt.length];

  // P = BMP password padded to a multiple of v by repetition.
  const P = new Uint8Array(v * Math.ceil(pass.length / v));
  for (let i = 0; i < P.length; i += 1) P[i] = pass[i % pass.length];

  let I = new Uint8Array(S.length + P.length);
  I.set(S, 0);
  I.set(P, S.length);

  const c = Math.ceil(outputBytes / u);
  const blocks: Uint8Array[] = [];
  const work = new Uint8Array(D.length + I.length);

  for (let round = 0; round < c; round += 1) {
    work.set(D, 0);
    work.set(I, D.length);
    let A = await hashOf(hashAlgorithm, work);
    for (let iter = 1; iter < iterations; iter += 1) {
      A = await hashOf(hashAlgorithm, A);
    }
    blocks.push(A);

    // B = A cycled up to v bytes.
    const B = new Uint8Array(v);
    for (let i = 0; i < v; i += 1) B[i] = A[i % u];

    // RFC 7292 B.2 step 3c: each v-byte block I_j is modified by ADDING
    // B (+1 in the low byte, carry propagating) — a big-endian integer
    // addition, not a plain XOR; this is what openssl/BouncyCastle
    // implement and the multi-block (3DES, 24-byte) derivations depend
    // on (verified byte-exact against `openssl kdf PKCS12KDF`).
    const k = Math.ceil(S.length / v) + Math.ceil(P.length / v);
    const nextI = new Uint8Array(k * v);
    for (let j = 0; j < k; j += 1) {
      const chunk = I.subarray(j * v, (j + 1) * v);
      let carry = 1;
      for (let l = v - 1; l >= 0; l -= 1) {
        const sum = carry + B[l] + (chunk[l] ?? 0);
        nextI[j * v + l] = sum & 0xff;
        carry = sum >> 8;
      }
    }
    I = nextI.subarray(0, I.length);
  }

  const out = new Uint8Array(outputBytes);
  let filled = 0;
  for (const block of blocks) {
    const take = Math.min(block.length, out.length - filled);
    out.set(block.subarray(0, take), filled);
    filled += take;
    if (filled >= out.length) break;
  }
  return out;
}

/* ---------------------------------------------------------------------- DES */

/* FIPS 46-3 tables (1-based bit positions, MSB first). */
const DES_IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46,
  38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17,
  9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55,
  47, 39, 31, 23, 15, 7,
];
const DES_FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14,
  54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60,
  28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41,
  9, 49, 17, 57, 25,
];
const DES_E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15,
  16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28,
  29, 28, 29, 30, 31, 32, 1,
];
const DES_P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14,
  32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];
const DES_PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35,
  27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46,
  38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];
const DES_PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27,
  20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56,
  34, 53, 46, 42, 50, 36, 29, 32,
];
const DES_SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const DES_SBOX: readonly number[][] = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2,
    13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7,
    3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2,
    8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6,
    9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4,
    6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12,
    5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15,
    0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14,
    5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7,
    13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5,
    6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12,
    9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10,
    1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9,
    1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8,
    0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3,
    7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13,
    15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
  ],
];

/** 1-based bit read, MSB first (the DES tables' numbering). */
function bitAt(bytes: Uint8Array, pos1: number): number {
  const zero = pos1 - 1;
  return (bytes[zero >> 3] >>> (7 - (zero & 7))) & 1;
}

function setBit(bytes: Uint8Array, pos1: number, value: number): void {
  const zero = pos1 - 1;
  const mask = 1 << (7 - (zero & 7));
  if (value === 1) bytes[zero >> 3] |= mask;
  else bytes[zero >> 3] &= ~mask & 0xff;
}

/** General 1-based permutation (in.length bits -> table.length bits). */
function permute(
  table: readonly number[],
  input: Uint8Array,
  inputBits: number
): Uint8Array {
  const out = new Uint8Array((table.length + 7) >> 3);
  for (let i = 0; i < table.length; i += 1) {
    const src = table[i];
    if (src >= 1 && src <= inputBits && bitAt(input, src) === 1) {
      setBit(out, i + 1, 1);
    }
  }
  return out;
}

/* --------------------------------------------------------- DES key schedule */

/** Read `count` bits starting at 1-based bit `from1` as a non-negative int. */
function bitsToNumber(bytes: Uint8Array, from1: number, count: number): number {
  let v = 0;
  for (let i = 0; i < count; i += 1) {
    v = (v << 1) | bitAt(bytes, from1 + i);
  }
  return v >>> 0;
}

function desSubkeys(key8: Uint8Array): Uint8Array[] {
  const permuted = permute(DES_PC1, key8, 64); // 56 bits in 7 bytes
  let C = bitsToNumber(permuted, 1, 28);
  let D = bitsToNumber(permuted, 29, 28);
  const subkeys: Uint8Array[] = [];
  for (let round = 0; round < 16; round += 1) {
    const s = DES_SHIFTS[round];
    C = ((C << s) | (C >>> (28 - s))) & 0x0fffffff;
    D = ((D << s) | (D >>> (28 - s))) & 0x0fffffff;
    const cd = new Uint8Array(7);
    for (let i = 0; i < 28; i += 1) {
      if ((C >>> (27 - i)) & 1) cd[i >> 3] |= 1 << (7 - (i & 7));
    }
    for (let i = 0; i < 28; i += 1) {
      const idx = 28 + i;
      if ((D >>> (27 - i)) & 1) cd[idx >> 3] |= 1 << (7 - (idx & 7));
    }
    subkeys.push(permute(DES_PC2, cd, 56));
  }
  return subkeys;
}

/* ------------------------------------------------------------ DES function */

function desF(r: Uint8Array, subkey: Uint8Array): Uint8Array {
  const expanded = permute(DES_E, r, 32); // 48 bits in 6 bytes
  const xored = new Uint8Array(6);
  for (let i = 0; i < 6; i += 1) xored[i] = expanded[i] ^ subkey[i];

  const sOut = new Uint8Array(4);
  for (let box = 0; box < 8; box += 1) {
    // 6 bits for this box, MSB first, starting at bit box*6+1 of xored.
    const base = box * 6;
    const b1 = bitAt(xored, base + 1);
    const b2 = bitAt(xored, base + 2);
    const b3 = bitAt(xored, base + 3);
    const b4 = bitAt(xored, base + 4);
    const b5 = bitAt(xored, base + 5);
    const b6 = bitAt(xored, base + 6);
    const row = (b1 << 1) | b6;
    const col = (b2 << 3) | (b3 << 2) | (b4 << 1) | b5;
    const nib = DES_SBOX[box][row * 16 + col] & 0x0f;
    if ((box & 1) === 0) sOut[box >> 1] |= nib << 4;
    else sOut[box >> 1] |= nib;
  }
  return permute(DES_P, sOut, 32);
}

function desBlock(
  block8: Uint8Array,
  subkeys: Uint8Array[],
  reverse: boolean
): Uint8Array {
  // Initial permutation, then L/R halves of its output.
  const ipOut = permute(DES_IP, block8, 64);
  let L = new Uint8Array(ipOut.subarray(0, 4));
  let R = new Uint8Array(ipOut.subarray(4, 8));
  for (let round = 0; round < 16; round += 1) {
    const key = reverse ? subkeys[15 - round] : subkeys[round];
    const f = desF(R, key);
    const nextL = R;
    const nextR = new Uint8Array(4);
    for (let i = 0; i < 4; i += 1) nextR[i] = L[i] ^ f[i];
    L = nextL;
    R = nextR;
  }
  // Pre-output swaps halves: R then L.
  const pre = new Uint8Array(8);
  pre.set(R, 0);
  pre.set(L, 4);
  return permute(DES_FP, pre, 64);
}

/** Single DES block encrypt (8-byte key). */
export function desEncryptBlock(
  block8: Uint8Array,
  key8: Uint8Array
): Uint8Array {
  return desBlock(block8, desSubkeys(key8), false);
}

/** Single DES block decrypt (8-byte key). */
export function desDecryptBlock(
  block8: Uint8Array,
  key8: Uint8Array
): Uint8Array {
  return desBlock(block8, desSubkeys(key8), true);
}

/* -------------------------------------------------------------- 3DES + CBC */

function xorInto(target: Uint8Array, other: Uint8Array): void {
  for (let i = 0; i < target.length; i += 1) target[i] ^= other[i];
}

/**
 * 3DES-EDE CBC decrypt. Key is 24 bytes (K1|K2|K3); a 16-byte key (2-key
 * EDE, K3 = K1) is also accepted because pbeWithSHAAnd2-KeyTripleDES-CBC
 * exists in the wild.
 */
export function tripleDesCbcDecrypt(
  data: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array
): Uint8Array {
  const k1 = key.subarray(0, 8);
  const k2 = key.subarray(8, 16);
  const k3 = key.length >= 24 ? key.subarray(16, 24) : k1;
  const sub1 = desSubkeys(k1);
  const sub2 = desSubkeys(k2);
  const sub3 = desSubkeys(k3);
  const out = new Uint8Array(data.length);
  let prev = new Uint8Array(iv);
  for (let off = 0; off < data.length; off += 8) {
    const block = new Uint8Array(data.subarray(off, off + 8));
    // EDE decrypt: D(K1, E(K2, D(K3, C)))
    const d3 = desBlock(block, sub3, true);
    const e2 = desBlock(d3, sub2, false);
    const plain = desBlock(e2, sub1, true);
    xorInto(plain, prev);
    out.set(plain, off);
    prev = block;
  }
  return out;
}

/* ---------------------------------------------------------------------- RC2 */

const RC2_PI_TABLE = [
  0xd9, 0x78, 0xf9, 0xc4, 0x19, 0xdd, 0xb5, 0xed, 0x28, 0xe9, 0xfd, 0x79, 0x4a,
  0xa0, 0xd8, 0x9d, 0xc6, 0x7e, 0x37, 0x83, 0x2b, 0x76, 0x53, 0x8e, 0x62, 0x4c,
  0x64, 0x88, 0x44, 0x8b, 0xfb, 0xa2, 0x17, 0x9a, 0x59, 0xf5, 0x87, 0xb3, 0x4f,
  0x13, 0x61, 0x45, 0x6d, 0x8d, 0x09, 0x81, 0x7d, 0x32, 0xbd, 0x8f, 0x40, 0xeb,
  0x86, 0xb7, 0x7b, 0x0b, 0xf0, 0x95, 0x21, 0x22, 0x5c, 0x6b, 0x4e, 0x82, 0x54,
  0xd6, 0x65, 0x93, 0xce, 0x60, 0xb2, 0x1c, 0x73, 0x56, 0xc0, 0x14, 0xa7, 0x8c,
  0xf1, 0xdc, 0x12, 0x75, 0xca, 0x1f, 0x3b, 0xbe, 0xe4, 0xd1, 0x42, 0x3d, 0xd4,
  0x30, 0xa3, 0x3c, 0xb6, 0x26, 0x6f, 0xbf, 0x0e, 0xda, 0x46, 0x69, 0x07, 0x57,
  0x27, 0xf2, 0x1d, 0x9b, 0xbc, 0x94, 0x43, 0x03, 0xf8, 0x11, 0xc7, 0xf6, 0x90,
  0xef, 0x3e, 0xe7, 0x06, 0xc3, 0xd5, 0x2f, 0xc8, 0x66, 0x1e, 0xd7, 0x08, 0xe8,
  0xea, 0xde, 0x80, 0x52, 0xee, 0xf7, 0x84, 0xaa, 0x72, 0xac, 0x35, 0x4d, 0x6a,
  0x2a, 0x96, 0x1a, 0xd2, 0x71, 0x5a, 0x15, 0x49, 0x74, 0x4b, 0x9f, 0xd0, 0x5e,
  0x04, 0x18, 0xa4, 0xec, 0xc2, 0xe0, 0x41, 0x6e, 0x0f, 0x51, 0xcb, 0xcc, 0x24,
  0x91, 0xaf, 0x50, 0xa1, 0xf4, 0x70, 0x39, 0x99, 0x7c, 0x3a, 0x85, 0x23, 0xb8,
  0xb4, 0x7a, 0xfc, 0x02, 0x36, 0x5b, 0x25, 0x55, 0x97, 0x31, 0x2d, 0x5d, 0xfa,
  0x98, 0xe3, 0x8a, 0x92, 0xae, 0x05, 0xdf, 0x29, 0x10, 0x67, 0x6c, 0xba, 0xc9,
  0xd3, 0x00, 0xe6, 0xcf, 0xe1, 0x9e, 0xa8, 0x2c, 0x63, 0x16, 0x01, 0x3f, 0x58,
  0xe2, 0x89, 0xa9, 0x0d, 0x38, 0x34, 0x1b, 0xab, 0x33, 0xff, 0xb0, 0xbb, 0x48,
  0x0c, 0x5f, 0xb9, 0xb1, 0xcd, 0x2e, 0xc5, 0xf3, 0xdb, 0x47, 0xe5, 0xa5, 0x9c,
  0x77, 0x0a, 0xa6, 0x20, 0x68, 0xfe, 0x7f, 0xc1, 0xad,
];

/** RFC 2268 key expansion — returns the 64 expanded key WORDS. */
export function rc2ExpandKey(
  keyBytes: Uint8Array,
  effectiveBits: number
): Uint16Array {
  const t = keyBytes.length;
  if (t < 1 || t > 128) throw new Error("RC2 key length out of range");
  const L = new Uint8Array(128);
  L.set(keyBytes.subarray(0, Math.min(t, 128)));

  const t8 = (effectiveBits + 7) >> 3;
  const tm =
    effectiveBits % 8 === 0
      ? 0xff
      : (0xff >> (8 - (effectiveBits % 8))) & 0xff;

  for (let i = t; i < 128; i += 1) {
    L[i] = RC2_PI_TABLE[(L[i - 1] + L[i - t]) & 0xff];
  }
  L[128 - t8] = RC2_PI_TABLE[L[128 - t8] & tm];
  for (let i = 127 - t8; i >= 0; i -= 1) {
    L[i] = RC2_PI_TABLE[L[i + 1] ^ L[i + t8]];
  }

  const K = new Uint16Array(64);
  for (let i = 0; i < 64; i += 1) {
    K[i] = L[2 * i] + 256 * L[2 * i + 1];
  }
  return K;
}

const RC2_S = [1, 2, 3, 5];

function rol16(x: number, n: number): number {
  return ((x << n) | (x >>> (16 - n))) & 0xffff;
}
function ror16(x: number, n: number): number {
  return ((x >>> n) | (x << (16 - n))) & 0xffff;
}

/** RC2 single-block decrypt (RFC 2268 §4.5). */
export function rc2DecryptBlock(
  block8: Uint8Array,
  K: Uint16Array
): Uint8Array {
  const r: number[] = [
    block8[0] + 256 * block8[1],
    block8[2] + 256 * block8[3],
    block8[4] + 256 * block8[5],
    block8[6] + 256 * block8[7],
  ];
  const idx = (i: number): number => ((i % 4) + 4) % 4;
  let j = 63;

  const rMix = (i: number): void => {
    r[idx(i)] = ror16(r[idx(i)], RC2_S[idx(i)]);
    r[idx(i)] =
      (r[idx(i)] -
        K[j] -
        (r[idx(i - 1)] & r[idx(i - 2)]) -
        (~r[idx(i - 1)] & r[idx(i - 3)])) &
      0xffff;
    j -= 1;
  };
  const rMash = (i: number): void => {
    r[idx(i)] = (r[idx(i)] - K[r[idx(i - 1)] & 63]) & 0xffff;
  };

  // 5 r-mixing, 1 r-mashing, 6 r-mixing, 1 r-mashing, 5 r-mixing.
  for (let round = 0; round < 5; round += 1) {
    for (let i = 3; i >= 0; i -= 1) rMix(i);
  }
  for (let i = 3; i >= 0; i -= 1) rMash(i);
  for (let round = 0; round < 6; round += 1) {
    for (let i = 3; i >= 0; i -= 1) rMix(i);
  }
  for (let i = 3; i >= 0; i -= 1) rMash(i);
  for (let round = 0; round < 5; round += 1) {
    for (let i = 3; i >= 0; i -= 1) rMix(i);
  }

  const out = new Uint8Array(8);
  for (let i = 0; i < 4; i += 1) {
    out[2 * i] = r[i] & 0xff;
    out[2 * i + 1] = (r[i] >> 8) & 0xff;
  }
  return out;
}

/** RC2 single-block encrypt (needed only for 3DES-style cross checks). */
export function rc2EncryptBlock(
  block8: Uint8Array,
  K: Uint16Array
): Uint8Array {
  const r: number[] = [
    block8[0] + 256 * block8[1],
    block8[2] + 256 * block8[3],
    block8[4] + 256 * block8[5],
    block8[6] + 256 * block8[7],
  ];
  const idx = (i: number): number => ((i % 4) + 4) % 4;
  let j = 0;

  const mix = (i: number): void => {
    r[idx(i)] =
      (r[idx(i)] +
        K[j] +
        (r[idx(i - 1)] & r[idx(i - 2)]) +
        (~r[idx(i - 1)] & r[idx(i - 3)])) &
      0xffff;
    j += 1;
    r[idx(i)] = rol16(r[idx(i)], RC2_S[idx(i)]);
  };
  const mash = (i: number): void => {
    r[idx(i)] = (r[idx(i)] + K[r[idx(i - 1)] & 63]) & 0xffff;
  };

  for (let round = 0; round < 5; round += 1) {
    for (let i = 0; i < 4; i += 1) mix(i);
  }
  for (let i = 0; i < 4; i += 1) mash(i);
  for (let round = 0; round < 6; round += 1) {
    for (let i = 0; i < 4; i += 1) mix(i);
  }
  for (let i = 0; i < 4; i += 1) mash(i);
  for (let round = 0; round < 5; round += 1) {
    for (let i = 0; i < 4; i += 1) mix(i);
  }

  const out = new Uint8Array(8);
  for (let i = 0; i < 4; i += 1) {
    out[2 * i] = r[i] & 0xff;
    out[2 * i + 1] = (r[i] >> 8) & 0xff;
  }
  return out;
}

/**
 * RC2-CBC decrypt. `keyBytes` length is the nominal key size (5 / 8 / 16
 * bytes) and `effectiveBits` the strength the OID promises (40 / 64 / 128).
 */
export function rc2CbcDecrypt(
  data: Uint8Array,
  keyBytes: Uint8Array,
  effectiveBits: number,
  iv: Uint8Array
): Uint8Array {
  const K = rc2ExpandKey(keyBytes, effectiveBits);
  const out = new Uint8Array(data.length);
  let prev = new Uint8Array(iv);
  for (let off = 0; off < data.length; off += 8) {
    const block = new Uint8Array(data.subarray(off, off + 8));
    const plain = rc2DecryptBlock(block, K);
    xorInto(plain, prev);
    out.set(plain, off);
    prev = block;
  }
  return out;
}

/* ------------------------------------------------------- PBES1 decryption */

/** The four PBES1 schemes this tool can decrypt. */
export type Pbe1Kind = "3des" | "3des2" | "rc2-128" | "rc2-40";

const PBE1_KINDS: Record<string, Pbe1Kind> = {
  "1.2.840.113549.1.12.1.3": "3des",
  "1.2.840.113549.1.12.1.4": "3des2",
  "1.2.840.113549.1.12.1.5": "rc2-128",
  "1.2.840.113549.1.12.1.6": "rc2-40",
};

/** PBE1 scheme lookup — returns null for unknown OIDs. */
export function pbe1KindOf(oid: string): Pbe1Kind | null {
  return Object.prototype.hasOwnProperty.call(PBE1_KINDS, oid)
    ? PBE1_KINDS[oid]
    : null;
}


/** Strip PKCS#7 padding (block size 8). Throws when padding is invalid. */
function stripPkcs7Pad(plain: Uint8Array, kind: "key" | "data"): Uint8Array {
  if (plain.length === 0 || plain.length % 8 !== 0) {
    throw new Error(kind === "key" ? "dsign.errorCertDecrypt" : "dsign.errorP12Decrypt");
  }
  const pad = plain[plain.length - 1];
  if (pad < 1 || pad > 8) {
    throw new Error(kind === "key" ? "dsign.errorCertDecrypt" : "dsign.errorP12Decrypt");
  }
  for (let i = plain.length - pad; i < plain.length; i += 1) {
    if (plain[i] !== pad) {
      throw new Error(kind === "key" ? "dsign.errorCertDecrypt" : "dsign.errorP12Decrypt");
    }
  }
  return plain.subarray(0, plain.length - pad);
}

/**
 * Decrypt a PBES1 (PKCS#12 v1) block: SHA-1 KDF, 3DES or RC2 in CBC mode.
 * `params` carries the DER-decoded { salt, iterations }.
 */
export async function decryptPbes1(
  kind: Pbe1Kind,
  password: string,
  salt: Uint8Array,
  iterations: number,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  const isDes = kind === "3des" || kind === "3des2";
  const keyLen = isDes ? (kind === "3des" ? 24 : 16) : kind === "rc2-128" ? 16 : 5;
  const effectiveBits = kind === "rc2-128" ? 128 : kind === "rc2-40" ? 40 : 0;

  const key = await pkcs12Kdf("SHA-1", keyLen, password, salt, iterations, 1);
  const iv = await pkcs12Kdf("SHA-1", 8, password, salt, iterations, 2);

  const plain = isDes
    ? tripleDesCbcDecrypt(ciphertext, key, iv)
    : rc2CbcDecrypt(ciphertext, key, effectiveBits, iv);
  return stripPkcs7Pad(plain, "data");
}
