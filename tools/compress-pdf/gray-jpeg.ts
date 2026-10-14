/**
 * Baseline sequential grayscale JPEG encoder (ITU-T T.81), pure TypeScript.
 *
 * Browsers can only produce 3-component YCbCr JPEGs from a canvas, so a
 * grayscale re-encode saves little. This encoder writes a TRUE 1-component
 * JPEG (single luma plane, no chroma) — roughly a third smaller than the
 * equivalent colour encode, and valid /DeviceGray DCTDecode data that every
 * PDF viewer decodes.
 *
 * Scope is deliberately minimal: 8-bit precision, one component, no
 * chroma, no restart markers, standard Annex K quantization + Huffman
 * tables. No progressive, no arithmetic coding, no EXIF — PDFs don't
 * need any of that.
 */

/* ------------------------------------------------------------------ */
/* Standard tables                                                     */
/* ------------------------------------------------------------------ */

/** Zigzag index → natural (row-major) index, ITU-T T.81 Figure A.6. */
const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
]);

/** Annex K luminance quantization base table (natural order). */
const BASE_QUANT = new Uint8Array([
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]);

/** Annex K.3 DC luminance Huffman BITS (code counts for lengths 1..16). */
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** Annex K.3 AC luminance Huffman BITS. */
const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125];
const AC_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
  0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
  0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
  0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
  0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
  0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
  0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

/** cos((2x+1)uπ/16) for x,u in 0..7 — the separable DCT kernel. */
const COS = (() => {
  const table = new Float32Array(64);
  for (let x = 0; x < 8; x += 1) {
    for (let u = 0; u < 8; u += 1) {
      table[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    }
  }
  return table;
})();

/** Normalization factor C(u)C(v)/4 with C(0)=1/√2. */
const NORM = (() => {
  const table = new Float32Array(64);
  const c = (i: number) => (i === 0 ? Math.SQRT1_2 : 1);
  for (let v = 0; v < 8; v += 1) {
    for (let u = 0; u < 8; u += 1) {
      table[v * 8 + u] = (c(u) * c(v)) / 4;
    }
  }
  return table;
})();

/* ------------------------------------------------------------------ */
/* Huffman code construction (canonical, per T.81 §C.2)                */
/* ------------------------------------------------------------------ */

interface HuffTable {
  codes: Int32Array; // symbol → code
  lengths: Int8Array; // symbol → code length
}

function buildHuffman(bits: number[], values: number[]): HuffTable {
  const codes = new Int32Array(256).fill(-1);
  const lengths = new Int8Array(256);
  let code = 0;
  let pos = 0;
  for (let len = 1; len <= 16; len += 1) {
    for (let i = 0; i < bits[len - 1]; i += 1) {
      const symbol = values[pos];
      pos += 1;
      codes[symbol] = code;
      lengths[symbol] = len;
      code += 1;
    }
    code <<= 1;
  }
  return { codes, lengths };
}

const DC = buildHuffman(DC_BITS, DC_VALUES);
const AC = buildHuffman(AC_BITS, AC_VALUES);

/* ------------------------------------------------------------------ */
/* Bit writer with 0xFF byte stuffing                                  */
/* ------------------------------------------------------------------ */

class BitWriter {
  private buffer = new Uint8Array(1 << 16);
  private size = 0;
  private current = 0;
  private used = 0;

  /** Appends `count` bits of `value` (MSB first). */
  write(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i -= 1) {
      this.current = (this.current << 1) | ((value >> i) & 1);
      this.used += 1;
      if (this.used === 8) {
        this.push(this.current);
        if (this.current === 0xff) this.push(0x00); // byte stuffing
        this.current = 0;
        this.used = 0;
      }
    }
  }

  private push(byte: number): void {
    if (this.size === this.buffer.length) {
      const grown = new Uint8Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer[this.size] = byte;
    this.size += 1;
  }

  /** Flushes the partial byte with 1-padding and returns the bytes. */
  finish(): Uint8Array {
    if (this.used > 0) this.write(0x7f, 7 - (this.used - 1)); // pad with 1s
    return this.buffer.subarray(0, this.size);
  }
}

/* ------------------------------------------------------------------ */
/* Quantization (libjpeg quality mapping)                              */
/* ------------------------------------------------------------------ */

/** libjpeg's quality→table scaling so our % matches the canvas encoder. */
function quantTable(quality: number): Uint8Array {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  const table = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) {
    const value = Math.round((BASE_QUANT[i] * scale + 50) / 100);
    table[i] = Math.min(255, Math.max(1, value));
  }
  return table;
}

/* ------------------------------------------------------------------ */
/* Block DCT (separable, float) + quantization                         */
/* ------------------------------------------------------------------ */

const rowBuf = new Float32Array(64);
const dctBuf = new Float32Array(64);

/** Forward DCT-II of one 8×8 sample block, quantized in place → `out`. */
function dctQuantize(samples: Float32Array, quant: Uint8Array, out: Int16Array): void {
  // Pass 1 — rows: g[y][u] = Σ_x s[y][x]·cos((2x+1)uπ/16)
  for (let y = 0; y < 8; y += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let x = 0; x < 8; x += 1) sum += samples[y * 8 + x] * COS[x * 8 + u];
      rowBuf[y * 8 + u] = sum;
    }
  }
  // Pass 2 — columns: F[u][v] = NORM·Σ_y g[y][u]·cos((2y+1)vπ/16)
  for (let v = 0; v < 8; v += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let y = 0; y < 8; y += 1) sum += rowBuf[y * 8 + u] * COS[y * 8 + v];
      dctBuf[v * 8 + u] = sum * NORM[v * 8 + u];
    }
  }
  for (let i = 0; i < 64; i += 1) {
    out[i] = Math.round(dctBuf[i] / quant[i]);
  }
}

/* ------------------------------------------------------------------ */
/* Entropy coding                                                      */
/* ------------------------------------------------------------------ */

/** Category = bits needed for |v| (0 → 0). */
function bitSize(v: number): number {
  let size = 0;
  let abs = Math.abs(v);
  while (abs > 0) {
    size += 1;
    abs >>= 1;
  }
  return size;
}

/**
 * Emits one quantized block through `sink` — either counting symbols
 * (stats pass) or writing bits (encode pass). Returns the new DC predictor.
 * `symbol < 0` means "raw bits, no Huffman code" (the DC/AC extra bits).
 */
function emitBlock(
  coefficients: Int16Array,
  prevDc: number,
  sink: (table: "dc" | "ac", symbol: number, extra: number, extraBits: number) => void
): number {
  const dc = coefficients[0];
  const diff = dc - prevDc;
  const dcSize = bitSize(diff);
  sink("dc", dcSize, 0, 0);
  if (dcSize > 0) {
    // Negative values are encoded as diff - 1 in one's-complement form.
    const bits = diff < 0 ? diff + (1 << dcSize) - 1 : diff;
    sink("dc", -1, bits, dcSize); // -1 = raw bits, no Huffman code
  }

  let run = 0;
  for (let i = 1; i < 64; i += 1) {
    const value = coefficients[ZIGZAG[i]];
    if (value === 0) {
      run += 1;
      continue;
    }
    while (run > 15) {
      sink("ac", 0xf0, 0, 0); // ZRL
      run -= 16;
    }
    const size = bitSize(value);
    const symbol = (run << 4) | size;
    const bits = value < 0 ? value + (1 << size) - 1 : value;
    sink("ac", symbol, bits, size);
    run = 0;
  }
  if (run > 0) {
    sink("ac", 0x00, 0, 0); // EOB
  }
  return dc;
}

/* ------------------------------------------------------------------ */
/* Optimal Huffman tables (two-pass, libjpeg-style)                    */
/* ------------------------------------------------------------------ */

/**
 * Builds an optimal Huffman table from symbol frequencies (pass 1).
 * A dummy symbol (index 256) absorbs the all-ones code so no real symbol
 * can ever be confused with the 1-bit stream padding (T.81 §C.2 NOTE).
 * Returns null when any code would exceed 16 bits — callers fall back to
 * the standard Annex K tables (only possible for degenerate inputs).
 */
function optimalTable(freqIn: Uint32Array): (HuffTable & { bits: number[]; values: number[] }) | null {
  const freq = new Uint32Array(257);
  freq.set(freqIn.subarray(0, 256));
  freq[256] = 1; // the dummy

  // Huffman via repeated smallest-pair merge (n ≤ 257 — O(n²) is nothing).
  interface Node {
    weight: number;
    symbol: number; // ≥ 0 for leaves, -1 for internal
    left: number;
    right: number;
  }
  const nodes: Node[] = [];
  const alive: number[] = [];
  for (let i = 0; i < 257; i += 1) {
    if (freq[i] > 0) {
      nodes.push({ weight: freq[i], symbol: i, left: -1, right: -1 });
      alive.push(nodes.length - 1);
    }
  }
  if (alive.length < 2) return null;
  while (alive.length > 1) {
    // find two smallest
    let a = 0;
    for (let k = 1; k < alive.length; k += 1) {
      if (nodes[alive[k]].weight < nodes[alive[a]].weight) a = k;
    }
    const left = alive.splice(a, 1)[0];
    let b = 0;
    for (let k = 1; k < alive.length; k += 1) {
      if (nodes[alive[k]].weight < nodes[alive[b]].weight) b = k;
    }
    const right = alive.splice(b, 1)[0];
    nodes.push({
      weight: nodes[left].weight + nodes[right].weight,
      symbol: -1,
      left,
      right,
    });
    alive.push(nodes.length - 1);
  }

  // Depth of every leaf.
  const depth = new Int32Array(257);
  const stack: [number, number][] = [[alive[0], 0]];
  let maxDepth = 0;
  while (stack.length > 0) {
    const [index, d] = stack.pop()!;
    const node = nodes[index];
    if (node.symbol >= 0) {
      depth[node.symbol] = Math.max(1, d);
      maxDepth = Math.max(maxDepth, Math.max(1, d));
    } else {
      stack.push([node.left, d + 1], [node.right, d + 1]);
    }
  }
  if (maxDepth > 16) return null;

  // Canonical BITS + VALUES over the REAL symbols only (0..255). The dummy
  // (symbol 256, depth ≥ 1 always since freq 1) held the all-ones slot; by
  // leaving it out of the table the all-ones code stays unassigned, so no
  // real symbol can be confused with the 1-bit stream padding (T.81 §C.2).
  const realBits = new Array<number>(16).fill(0);
  const realValues: number[] = [];
  for (let len = 1; len <= 16; len += 1) {
    for (let symbol = 0; symbol < 256; symbol += 1) {
      if (depth[symbol] === len) {
        realBits[len - 1] += 1;
        realValues.push(symbol);
      }
    }
  }
  return { ...buildHuffman(realBits, realValues), bits: realBits, values: realValues };
}

/* ------------------------------------------------------------------ */
/* Marker writing                                                      */
/* ------------------------------------------------------------------ */

function u16(out: number[], value: number): void {
  out.push((value >> 8) & 0xff, value & 0xff);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** RGBA (4 bytes/px) → Rec.601 luma plane (1 byte/px), same math as the engine's grayscaleImageData. */
export function rgbaToGrayPlane(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    // 0.299/0.587/0.114 ×1000, +500 for round-to-nearest.
    gray[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114 + 500) / 1000 | 0;
  }
  return gray;
}

/**
 * Encodes an 8-bit luma plane as a baseline grayscale JPEG with
 * per-image optimal Huffman tables (two passes over the blocks).
 * `quality` is the libjpeg-style 1..100 percentage.
 */
export function encodeGrayJpeg(
  gray: Uint8Array,
  width: number,
  height: number,
  quality: number
): Uint8Array {
  if (width <= 0 || height <= 0 || gray.length < width * height) {
    throw new Error("gray plane smaller than width×height");
  }
  const quant = quantTable(quality);

  const samples = new Float32Array(64);
  const coefficients = new Int16Array(64);

  /** DCT+quantize one block — pure, so both passes see identical data. */
  const quantizeBlock = (by: number, bx: number) => {
    for (let y = 0; y < 8; y += 1) {
      const sy = Math.min(by + y, height - 1);
      for (let x = 0; x < 8; x += 1) {
        const sx = Math.min(bx + x, width - 1);
        samples[y * 8 + x] = gray[sy * width + sx] - 128; // level shift
      }
    }
    dctQuantize(samples, quant, coefficients);
  };

  // Pass 1 — symbol frequencies for the optimal tables.
  const freqDc = new Uint32Array(256);
  const freqAc = new Uint32Array(256);
  {
    let prevDc = 0;
    for (let by = 0; by < height; by += 8) {
      for (let bx = 0; bx < width; bx += 8) {
        quantizeBlock(by, bx);
        prevDc = emitBlock(coefficients, prevDc, (table, symbol) => {
          if (symbol >= 0) {
            if (table === "dc") freqDc[symbol] += 1;
            else freqAc[symbol] += 1;
          }
        });
      }
    }
  }

  const optDc = optimalTable(freqDc);
  const optAc = optimalTable(freqAc);
  const dcBits = optDc?.bits ?? DC_BITS;
  const dcValues = optDc?.values ?? DC_VALUES;
  const acBits = optAc?.bits ?? AC_BITS;
  const acValues = optAc?.values ?? AC_VALUES;

  // Pass 2 — encode with the chosen tables.
  const writer = new BitWriter();
  const dcTable = buildHuffman(dcBits, dcValues);
  const acTable = buildHuffman(acBits, acValues);
  {
    let prevDc = 0;
    for (let by = 0; by < height; by += 8) {
      for (let bx = 0; bx < width; bx += 8) {
        quantizeBlock(by, bx);
        prevDc = emitBlock(coefficients, prevDc, (table, symbol, extra, extraBits) => {
          if (symbol < 0) {
            writer.write(extra, extraBits);
            return;
          }
          const t = table === "dc" ? dcTable : acTable;
          writer.write(t.codes[symbol], t.lengths[symbol]);
          if (extraBits > 0) writer.write(extra, extraBits);
        });
      }
    }
  }
  const entropy = writer.finish();

  // Marker stream.
  const out: number[] = [];
  const push = (...bytes: number[]) => out.push(...bytes);

  push(0xff, 0xd8); // SOI

  // DQT — quantization table in zigzag order.
  push(0xff, 0xdb);
  u16(out, 67);
  push(0x00);
  for (let i = 0; i < 64; i += 1) push(quant[ZIGZAG[i]]);

  // SOF0 — baseline, 1 component, no subsampling.
  push(0xff, 0xc0);
  u16(out, 11);
  push(8);
  u16(out, height);
  u16(out, width);
  push(1, 0x01, 0x11, 0x00);

  // DHT — the (optimal or standard) DC then AC tables.
  push(0xff, 0xc4);
  u16(out, 2 + 1 + 16 + dcValues.length);
  push(0x00, ...dcBits);
  push(...dcValues);
  push(0xff, 0xc4);
  u16(out, 2 + 1 + 16 + acValues.length);
  push(0x10, ...acBits);
  push(...acValues);

  // SOS — one scan, whole image.
  push(0xff, 0xda);
  u16(out, 8);
  push(1, 0x01, 0x00, 0, 63, 0x00);

  const head = new Uint8Array(out);
  const result = new Uint8Array(head.length + entropy.length + 2);
  result.set(head, 0);
  result.set(entropy, head.length);
  result[result.length - 2] = 0xff;
  result[result.length - 1] = 0xd9; // EOI
  return result;
}
