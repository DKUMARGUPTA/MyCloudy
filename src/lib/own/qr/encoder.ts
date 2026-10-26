/**
 * DocoPDF own QR encoder — core matrix builder (ISO/IEC 18004).
 * Self-written: byte-mode payloads, versions 1-40, EC levels L/M/Q/H,
 * Reed-Solomon over GF(256) (poly 0x11D), block interleave, zigzag
 * placement, 8 masks with standard N1-N4 penalty selection, BCH format
 * and version info. No external packages.
 */

export type EccLevel = "L" | "M" | "Q" | "H";

/** The QR matrix: size × size, 1 = dark. Matches the `qrcode` package shape. */
export interface BitMatrix {
  size: number;
  data: Uint8Array;
  /** Mask actually applied (0-7) — needed by tests and format-bit checks. */
  mask: number;
  version: number;
}

// ---------------------------------------------------------------------------
// GF(256) arithmetic (QR polynomial 0x11D).
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let e = 0; e < 255; e++) {
    EXP[e] = x;
    LOG[x] = e;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let e = 255; e < 512; e++) EXP[e] = EXP[e - 255];
})();

function gmul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Generator polynomial for `degree` error-correction codewords. */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let k = 0; k < poly.length; k++) {
      next[k] ^= gmul(poly[k], EXP[i]);
      next[k + 1] ^= poly[k];
    }
    poly = next;
  }
  // poly is in descending powers; return ascending for the division loop.
  return poly.reverse();
}

/** Reed-Solomon remainder of `data` for `degree` ECC codewords. */
function rsRemainder(data: Uint8Array, degree: number): Uint8Array {
  const gen = rsGenerator(degree);
  // Append zeros then polynomial-divide (synthetic long division).
  const work = new Uint8Array(data.length + degree);
  work.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = work[i];
    if (factor === 0) continue;
    for (let k = 0; k < gen.length; k++) {
      work[i + k] ^= gmul(gen[k], factor);
    }
  }
  return work.slice(data.length);
}

// ---------------------------------------------------------------------------
// Capacity + block tables (per version × EC level).
// ---------------------------------------------------------------------------

const ECC_CODEWORDS: Record<EccLevel, Uint8Array> = {
  // per version 1..40: total EC codewords per block basis (Thonky table)
  L: new Uint8Array([7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]),
  M: new Uint8Array([10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28]),
  Q: new Uint8Array([13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 18, 18, 20, 24, 18, 22, 22, 26, 24, 24, 24, 28, 24, 28, 28, 28, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]),
  H: new Uint8Array([17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 26, 26, 24, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28]),
};

/** EC blocks per version/level: [group1Blocks, group1Data, group2Blocks, group2Data]. */
const EC_BLOCKS: Record<EccLevel, Array<[number, number, number, number]>> = {
  // Derived from the ISO/IEC 18004 block tables (blocks-count + EC codewords
  // per version/level → group split; verified entry-by-entry).
  L: [
    [1, 19, 0, 0],
    [1, 34, 0, 0],
    [1, 55, 0, 0],
    [1, 80, 0, 0],
    [1, 108, 0, 0],
    [2, 68, 0, 0],
    [2, 78, 0, 0],
    [2, 97, 0, 0],
    [2, 116, 0, 0],
    [2, 68, 2, 69],
    [4, 81, 0, 0],
    [2, 92, 2, 93],
    [4, 107, 0, 0],
    [3, 115, 1, 116],
    [5, 87, 1, 88],
    [5, 98, 1, 99],
    [1, 107, 5, 108],
    [5, 120, 1, 121],
    [3, 113, 4, 114],
    [3, 107, 5, 108],
    [4, 116, 4, 117],
    [2, 111, 7, 112],
    [4, 121, 5, 122],
    [6, 117, 4, 118],
    [8, 106, 4, 107],
    [10, 114, 2, 115],
    [8, 122, 4, 123],
    [3, 117, 10, 118],
    [7, 116, 7, 117],
    [5, 115, 10, 116],
    [13, 115, 3, 116],
    [17, 115, 0, 0],
    [17, 115, 1, 116],
    [13, 115, 6, 116],
    [12, 121, 7, 122],
    [6, 121, 14, 122],
    [17, 122, 4, 123],
    [4, 122, 18, 123],
    [20, 117, 4, 118],
    [19, 118, 6, 119],
  ],
  M: [
    [1, 16, 0, 0],
    [1, 28, 0, 0],
    [1, 44, 0, 0],
    [2, 32, 0, 0],
    [2, 43, 0, 0],
    [4, 27, 0, 0],
    [4, 31, 0, 0],
    [2, 38, 2, 39],
    [3, 36, 2, 37],
    [4, 43, 1, 44],
    [1, 50, 4, 51],
    [6, 36, 2, 37],
    [8, 37, 1, 38],
    [4, 40, 5, 41],
    [5, 41, 5, 42],
    [7, 45, 3, 46],
    [10, 46, 1, 47],
    [9, 43, 4, 44],
    [3, 44, 11, 45],
    [3, 41, 13, 42],
    [17, 42, 0, 0],
    [17, 46, 0, 0],
    [4, 47, 14, 48],
    [6, 45, 14, 46],
    [8, 47, 13, 48],
    [19, 46, 4, 47],
    [22, 45, 3, 46],
    [3, 45, 23, 46],
    [21, 45, 7, 46],
    [19, 47, 10, 48],
    [2, 46, 29, 47],
    [10, 46, 23, 47],
    [14, 46, 21, 47],
    [14, 46, 23, 47],
    [12, 47, 26, 48],
    [6, 47, 34, 48],
    [29, 46, 14, 47],
    [13, 46, 32, 47],
    [40, 47, 7, 48],
    [18, 47, 31, 48],
  ],
  Q: [
    [1, 13, 0, 0],
    [1, 22, 0, 0],
    [2, 17, 0, 0],
    [2, 24, 0, 0],
    [2, 15, 2, 16],
    [4, 19, 0, 0],
    [2, 14, 4, 15],
    [4, 18, 2, 19],
    [4, 16, 4, 17],
    [6, 19, 2, 20],
    [4, 22, 4, 23],
    [4, 20, 6, 21],
    [8, 20, 4, 21],
    [11, 16, 5, 17],
    [5, 24, 7, 25],
    [15, 19, 2, 20],
    [1, 22, 15, 23],
    [17, 22, 1, 23],
    [17, 21, 4, 22],
    [15, 24, 5, 25],
    [17, 22, 6, 23],
    [7, 24, 16, 25],
    [11, 24, 14, 25],
    [11, 24, 16, 25],
    [7, 24, 22, 25],
    [28, 22, 6, 23],
    [8, 23, 26, 24],
    [4, 24, 31, 25],
    [1, 23, 37, 24],
    [15, 24, 25, 25],
    [42, 24, 1, 25],
    [10, 24, 35, 25],
    [29, 24, 19, 25],
    [44, 24, 7, 25],
    [39, 24, 14, 25],
    [46, 24, 10, 25],
    [49, 24, 10, 25],
    [48, 24, 14, 25],
    [43, 24, 22, 25],
    [34, 24, 34, 25],
  ],
  H: [
    [1, 9, 0, 0],
    [1, 16, 0, 0],
    [2, 13, 0, 0],
    [4, 9, 0, 0],
    [2, 11, 2, 12],
    [4, 15, 0, 0],
    [4, 13, 1, 14],
    [4, 14, 2, 15],
    [4, 12, 4, 13],
    [6, 15, 2, 16],
    [3, 12, 8, 13],
    [7, 14, 4, 15],
    [12, 11, 4, 12],
    [11, 12, 5, 13],
    [11, 12, 7, 13],
    [3, 15, 13, 16],
    [2, 14, 17, 15],
    [2, 14, 19, 15],
    [9, 13, 16, 14],
    [15, 15, 10, 16],
    [19, 16, 6, 17],
    [34, 13, 0, 0],
    [16, 15, 14, 16],
    [30, 16, 2, 17],
    [22, 15, 13, 16],
    [33, 16, 4, 17],
    [12, 15, 28, 16],
    [11, 15, 31, 16],
    [19, 15, 26, 16],
    [23, 15, 25, 16],
    [23, 15, 28, 16],
    [19, 15, 35, 16],
    [11, 15, 46, 16],
    [59, 16, 1, 17],
    [22, 15, 41, 16],
    [2, 15, 64, 16],
    [24, 15, 46, 16],
    [42, 15, 32, 16],
    [10, 15, 67, 16],
    [20, 15, 61, 16],
  ],
};

/** Alignment pattern center coordinates per version (2..40). */
function alignmentCenters(version: number): number[] {
  if (version === 1) return [];
  const table: Record<number, number[]> = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62],
    14: [6, 26, 46, 66], 15: [6, 26, 48, 70], 16: [6, 26, 50, 74],
    17: [6, 30, 54, 78], 18: [6, 30, 56, 82], 19: [6, 30, 58, 86],
    20: [6, 34, 62, 90], 21: [6, 28, 50, 72, 94], 22: [6, 26, 50, 74, 98],
    23: [6, 30, 54, 78, 102], 24: [6, 28, 54, 80, 106],
    25: [6, 32, 58, 84, 110], 26: [6, 30, 58, 86, 114],
    27: [6, 34, 62, 90, 118], 28: [6, 26, 50, 74, 98, 122],
    29: [6, 30, 54, 78, 102, 126], 30: [6, 26, 52, 78, 104, 130],
    31: [6, 30, 56, 82, 108, 134], 32: [6, 34, 60, 86, 112, 138],
    33: [6, 30, 58, 86, 114, 142], 34: [6, 34, 62, 94, 126, 146],
    35: [6, 30, 54, 78, 102, 126, 150], 36: [6, 24, 50, 76, 102, 128, 154],
    37: [6, 28, 54, 80, 106, 132, 158], 38: [6, 32, 58, 84, 110, 136, 162],
    39: [6, 26, 54, 82, 110, 138, 166], 40: [6, 30, 58, 86, 114, 142, 170],
  };
  return table[version];
}

/** Data codewords available at (version, level). */
function dataCodewords(version: number, level: EccLevel): number {
  const [g1b, g1d, g2b, g2d] = EC_BLOCKS[level][version - 1];
  return g1b * g1d + g2b * g2d;
}

/** Total codewords (data + EC) at (version, level). */
function totalCodewords(version: number): number {
  // Total modules → remainder bits are separate; total codewords table:
  const TOTAL = [
    26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655,
    733, 815, 901, 991, 1085, 1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921,
    2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
  ];
  return TOTAL[version - 1];
}

// ---------------------------------------------------------------------------
// Data encoding (byte mode only — every DocoPDF payload is bytes).
// ---------------------------------------------------------------------------

function encodeBytes(bytes: Uint8Array, version: number, level: EccLevel): Uint8Array {
  const dc = dataCodewords(version, level);
  const countBits = version <= 9 ? 8 : 16;
  const bits: number[] = [];
  const push = (val: number, n: number): void => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, countBits);
  for (const b of bytes) push(b, 8);
  // Terminator up to 4 bits.
  const capacityBits = dc * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  // Pad to byte boundary.
  while (bits.length % 8 !== 0) bits.push(0);
  const out = new Uint8Array(dc);
  for (let i = 0; i < bits.length / 8; i++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | bits[i * 8 + k];
    out[i] = v;
  }
  // Pad bytes alternating 0xEC 0x11.
  let padToggle = 0xec;
  for (let i = bits.length / 8; i < dc; i++) {
    out[i] = padToggle;
    padToggle = padToggle === 0xec ? 0x11 : 0xec;
  }
  return out;
}

/** Build the final codeword stream (interleaved data + RS). */
function buildCodewords(data: Uint8Array, version: number, level: EccLevel): Uint8Array {
  const [g1b, g1d, g2b, g2d] = EC_BLOCKS[level][version - 1];
  const blocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  const eccLen = ECC_CODEWORDS[level][version - 1];
  let off = 0;
  for (let i = 0; i < g1b; i++) {
    const chunk = data.subarray(off, off + g1d);
    off += g1d;
    blocks.push(chunk);
    eccBlocks.push(rsRemainder(chunk, eccLen));
  }
  for (let i = 0; i < g2b; i++) {
    const chunk = data.subarray(off, off + g2d);
    off += g2d;
    blocks.push(chunk);
    eccBlocks.push(rsRemainder(chunk, eccLen));
  }
  const total = totalCodewords(version);
  const out = new Uint8Array(total);
  let p = 0;
  const maxData = Math.max(g1d, g2b > 0 ? g2d : 0);
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.length) out[p++] = b[i];
  }
  for (let i = 0; i < eccLen; i++) {
    for (const e of eccBlocks) out[p++] = e[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matrix construction.
// ---------------------------------------------------------------------------

/** Position of the highest set bit (−1 for 0). */
function bchDigit(x: number): number {
  let d = -1;
  while (x > 0) {
    x >>>= 1;
    d++;
  }
  return d;
}

/** Polynomial long division: remainder of `data`·x^r mod gen. */
function bchRemainder(data: number, r: number, gen: number): number {
  const genDigit = bchDigit(gen);
  let d = data << r;
  while (bchDigit(d) - genDigit >= 0) {
    d ^= gen << (bchDigit(d) - genDigit);
  }
  return d;
}

const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);
const G18 =
  (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1;

function bchFormat(level: EccLevel, mask: number): number {
  const levelBits = level === "L" ? 1 : level === "M" ? 0 : level === "Q" ? 3 : 2;
  const data = (levelBits << 3) | mask;
  const rem = bchRemainder(data, 10, G15);
  return ((data << 10) | rem) ^ G15_MASK;
}

function bchVersion(version: number): number {
  const rem = bchRemainder(version, 12, G18);
  return (version << 12) | rem;
}

const MASK_FNS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function placeFunctionPatterns(matrix: Uint8Array, size: number, version: number): Uint8Array {
  const reserved = new Uint8Array(size * size); // 1 = reserved (no data)
  const set = (r: number, c: number, v: number): void => {
    matrix[r * size + c] = v;
    reserved[r * size + c] = 1;
  };

  // Finder patterns + separators (three corners).
  const drawFinder = (top: number, left: number): void => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inRing =
          (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
          (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        set(r, c, inRing || inCore ? 1 : 0);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    set(6, i, v);
    set(i, 6, v);
  }

  // Alignment patterns (skip the three finder corners).
  const centers = alignmentCenters(version);
  for (const cr of centers) {
    for (const cc of centers) {
      const nearFinder =
        (cr <= 8 && cc <= 8) ||
        (cr <= 8 && cc >= size - 9) ||
        (cr >= size - 9 && cc <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          set(cr + dr, cc + dc, ring !== 1 ? 1 : 0);
        }
      }
    }
  }

  // Reserve format info areas (filled later) + dark module.
  // Top-left L: row 8 cols 0..8 + col 8 rows 0..8.
  for (let i = 0; i <= 8; i++) {
    reserved[8 * size + i] = 1;
    reserved[i * size + 8] = 1;
  }
  // Top-right strip: row 8 cols size-8..size-1.
  // Bottom-left strip: col 8 rows size-8..size-1 (INCLUDING the dark
  // module at (size-8, 8) — marking one cell repeatedly was the bug that
  // left the strip writable and bit-shifted the whole tail).
  for (let i = size - 8; i < size; i++) {
    reserved[8 * size + i] = 1;
    reserved[i * size + 8] = 1;
  }
  // Dark module.
  set(size - 8, 8, 1);

  // Version info areas (v >= 7).
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let k = 0; k < 3; k++) {
        reserved[i * size + (size - 11 + k)] = 1;
        reserved[(size - 11 + k) * size + i] = 1;
      }
    }
  }
  return reserved;
}

function placeData(
  matrix: Uint8Array,
  reserved: Uint8Array,
  size: number,
  codewords: Uint8Array
): void {
  const bitAt = (i: number): number => {
    if (i < codewords.length * 8) {
      return (codewords[i >> 3] >>> (7 - (i & 7))) & 1;
    }
    return 0; // remainder bits after the last codeword are 0
  };

  let bitIndex = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    // Column 6 is the vertical timing column — skip it by treating the
    // pair as [5, 4] (the loop then continues at 3).
    if (col === 6) col = 5;
    for (let i = 0; i < size; i++) {
      const r = upward ? size - 1 - i : i;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (c < 0) continue;
        const idx = r * size + c;
        if (reserved[idx]) continue;
        matrix[idx] = bitAt(bitIndex++);
      }
    }
    upward = !upward;
  }
}

function applyMask(matrix: Uint8Array, reserved: Uint8Array, size: number, mask: number): void {
  const fn = MASK_FNS[mask];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const idx = r * size + c;
      if (reserved[idx]) continue;
      if (fn(r, c)) matrix[idx] ^= 1;
    }
  }
}

function drawFormat(matrix: Uint8Array, size: number, level: EccLevel, mask: number): void {
  const bits = bchFormat(level, mask);
  const put = (r: number, c: number, i: number): void => {
    matrix[r * size + c] = (bits >>> i) & 1;
  };
  // Vertical strip (column 8): bits 0-5 top, skip timing, bits 6-7, then
  // bits 8-14 in the bottom-left strip.
  for (let i = 0; i < 6; i++) put(i, 8, i);
  put(7, 8, 6);
  put(8, 8, 7);
  for (let i = 8; i < 15; i++) put(size - 15 + i, 8, i);
  // Horizontal strip (row 8): bits 0-7 right-to-left on the right side,
  // bit 8 at column 7, bits 9-14 down to column 0.
  for (let i = 0; i < 8; i++) put(8, size - 1 - i, i);
  put(8, 7, 8);
  for (let i = 9; i < 15; i++) put(8, 14 - i, i);
}

function drawVersion(matrix: Uint8Array, size: number, version: number): void {
  if (version < 7) return;
  const bits = bchVersion(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >>> i) & 1;
    const a = Math.floor(i / 3);
    const b = size - 11 + (i % 3);
    matrix[a * size + b] = bit;
    matrix[b * size + a] = bit;
  }
}

/** Penalty score (lower = better) per ISO 18004 Annex. */
function penalty(matrix: Uint8Array, size: number): number {
  let score = 0;
  // N1: runs ≥5 same color in row/col.
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      let run = 1;
      let prev = -1;
      for (let j = 0; j < size; j++) {
        const v = axis === 0 ? matrix[i * size + j] : matrix[j * size + i];
        if (v === prev) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score++;
        } else {
          run = 1;
          prev = v;
        }
      }
    }
  }
  // N2: 2×2 blocks same color.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const a = matrix[r * size + c];
      if (
        a === matrix[r * size + c + 1] &&
        a === matrix[(r + 1) * size + c] &&
        a === matrix[(r + 1) * size + c + 1]
      ) {
        score += 3;
      }
    }
  }
  // N3: finder-like 1:1:3:1:1 with 4 light on either side — exact
  // sliding 11-bit window match (0x5D0 = pattern+4 light, 0x05D = 4
  // light+pattern), matching the reference implementations.
  for (let i = 0; i < size; i++) {
    let bitsCol = 0;
    let bitsRow = 0;
    for (let j = 0; j < size; j++) {
      bitsCol = ((bitsCol << 1) & 0x7ff) | matrix[i * size + j];
      if (j >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) score += 40;
      bitsRow = ((bitsRow << 1) & 0x7ff) | matrix[j * size + i];
      if (j >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) score += 40;
    }
  }
  // N4: dark ratio deviation from 50% in 5% steps (ceil-based k).
  let dark = 0;
  for (let i = 0; i < matrix.length; i++) dark += matrix[i];
  const k = Math.abs(Math.ceil((dark * 100) / (size * size) / 5) - 10);
  score += k * 10;
  return score;
}

/**
 * Encode a payload into a QR matrix (auto version, byte mode).
 * `forcedMask` exists for tests; production passes undefined.
 */
export function createMatrix(
  payload: string | Uint8Array,
  level: EccLevel = "M",
  forcedMask?: number
): BitMatrix {
  const bytes =
    payload instanceof Uint8Array
      ? payload
      : new TextEncoder().encode(payload);
  if (bytes.length === 0) throw new Error("qr: empty payload");

  // Pick the smallest version that fits.
  let version = 0;
  for (let v = 1; v <= 40; v++) {
    const dc = dataCodewords(v, level);
    const countBits = v <= 9 ? 8 : 16;
    const needBits = 4 + countBits + bytes.length * 8;
    if (needBits <= dc * 8) {
      // Also confirm next-version count-bits case when v==9→10 boundary:
      version = v;
      break;
    }
  }
  if (version === 0) {
    throw new Error(
      `qr: payload too large for level ${level} (${bytes.length} bytes)`
    );
  }

  const data = encodeBytes(bytes, version, level);
  const codewords = buildCodewords(data, version, level);
  const size = version * 4 + 17;

  const base = new Uint8Array(size * size);
  const reserved = placeFunctionPatterns(base, size, version);
  placeData(base, reserved, size, codewords);

  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestMat: Uint8Array | null = null;
  const first = forcedMask ?? 0;
  const last = forcedMask ?? 7;
  for (let m = first; m <= last; m++) {
    const candidate = Uint8Array.from(base);
    applyMask(candidate, reserved, size, m);
    drawFormat(candidate, size, level, m);
    drawVersion(candidate, size, version);
    const p = penalty(candidate, size);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMask = m;
      bestMat = candidate;
    }
  }
  return { size, data: bestMat as Uint8Array, mask: bestMask, version };
}
