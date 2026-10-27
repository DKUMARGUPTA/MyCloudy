/**
 * DocoPDF own ZIP/DEFLATE engine — DEFLATE compressor (RFC 1951).
 * Self-written: hash-chain LZ77 match finder (32 KiB window, greedy with
 * one-step lazy evaluation like zlib) + dynamic-Huffman block emission
 * with provably Kraft-complete length-limited code construction.
 * No external packages.
 */

// --- Static tables ----------------------------------------------------------

const LENGTH_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
  67, 83, 99, 115, 131, 163, 195, 227, 258,
]);
const LENGTH_EXTRA = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5,
  5, 5, 5, 0,
]);
const DIST_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
  769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]);
const DIST_EXTRA = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
  11, 11, 12, 12, 13, 13,
]);
const CLEN_ORDER = new Uint8Array([
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
]);

// Match finder tuning (level 1..9 → chain depth; level 0 = stored).
const LEVEL_CHAIN = [0, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
const WINDOW = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;

// ---------------------------------------------------------------------------
// Bit writer (LSB-first data bits; Huffman codes written MSB-first).
// ---------------------------------------------------------------------------

class BitWriter {
  private buf: Uint8Array;
  private len = 0;
  private bitBuf = 0;
  private bitCnt = 0;

  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(Math.max(64, capacity));
  }

  private ensure(): void {
    if (this.len + 8 <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + 8) cap *= 2;
    const bigger = new Uint8Array(cap);
    bigger.set(this.buf.subarray(0, this.len));
    this.buf = bigger;
  }

  /** Write n bits (n <= 24), value LSB-first. */
  bits(value: number, n: number): void {
    this.bitBuf |= (value << this.bitCnt) >>> 0;
    this.bitCnt += n;
    while (this.bitCnt >= 8) {
      this.ensure();
      this.buf[this.len++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }

  /** Write a Huffman code (given MSB-first, reversed into the stream). */
  code(code: number, len: number): void {
    let rev = 0;
    for (let i = 0; i < len; i++) {
      rev = (rev << 1) | (code & 1);
      code >>>= 1;
    }
    this.bits(rev, len);
  }

  /** Pad to a byte boundary with zero bits. */
  alignByte(): void {
    if (this.bitCnt > 0) {
      this.bits(0, 8 - this.bitCnt);
    }
  }

  /** Append raw bytes (byte boundary only). */
  bytes(data: Uint8Array): void {
    if (this.bitCnt !== 0) throw new Error("deflate: bytes write misaligned");
    const need = this.len + data.length;
    if (this.buf.length < need) {
      let cap = this.buf.length;
      while (cap < need) cap *= 2;
      const bigger = new Uint8Array(cap);
      bigger.set(this.buf.subarray(0, this.len));
      this.buf = bigger;
    }
    this.buf.set(data, this.len);
    this.len += data.length;
  }

  /** Final bytes (pads to a byte boundary first). */
  finish(): Uint8Array {
    this.alignByte();
    return this.buf.subarray(0, this.len);
  }
}

// ---------------------------------------------------------------------------
// Canonical code construction + length-limited Huffman with EXACT Kraft
// completeness (required by strict inflaters such as zlib).
// ---------------------------------------------------------------------------

/** Canonical codes from lengths (RFC 1951 §3.2.2). codes[sym] is MSB-first. */
export function canonicalCodes(lengths: Uint8Array): Uint16Array {
  const MAX = 15;
  const blCount = new Uint16Array(MAX + 1);
  for (let i = 0; i < lengths.length; i++) blCount[lengths[i]]++;
  blCount[0] = 0;
  const nextCode = new Uint16Array(MAX + 2);
  let code = 0;
  for (let bits = 1; bits <= MAX; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Uint16Array(lengths.length);
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym];
    if (len !== 0) codes[sym] = nextCode[len]++;
  }
  return codes;
}

/** Kraft sum scaled by 2^maxBits: Σ 2^(max-len). Must equal 2^max to be complete. */
function kraftSum(lengths: Uint8Array, max: number): number {
  let sum = 0;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i];
    if (len > 0) sum += 1 << (max - len);
  }
  return sum;
}

interface HNode {
  w: number;
  sym: number;
  left: HNode | null;
  right: HNode | null;
}

/**
 * Length-limited Huffman lengths. Guarantees, for n >= 2 used symbols:
 * every length in [1, maxBits] and Σ 2^(maxBits-len) == 2^maxBits
 * (a complete, never-oversubscribed code). Caller guarantees n >= 2.
 */
export function buildLengths(
  freqs: Uint32Array,
  maxBits: number
): Uint8Array {
  const n = freqs.length;
  const lengths = new Uint8Array(n);
  const used: number[] = [];
  for (let i = 0; i < n; i++) if (freqs[i] > 0) used.push(i);
  if (used.length === 0) return lengths;
  if (used.length === 1) {
    lengths[used[0]] = 1;
    return lengths;
  }

  // --- Unbounded Huffman depths via two-queue merge ------------------------
  const leaves: HNode[] = used
    .map((sym) => ({ w: freqs[sym], sym, left: null, right: null }))
    .sort((a, b) => a.w - b.w || a.sym - b.sym);
  const q1: HNode[] = [...leaves];
  const q2: HNode[] = [];
  const takeMin = (): HNode => {
    if (q2.length === 0) return q1.shift() as HNode;
    if (q1.length === 0) return q2.shift() as HNode;
    return q2[0].w <= q1[0].w
      ? (q2.shift() as HNode)
      : (q1.shift() as HNode);
  };
  while (q1.length + q2.length > 1) {
    const a = takeMin();
    const b = takeMin();
    q2.push({ w: a.w + b.w, sym: -1, left: a, right: b });
  }
  const root = (q1[0] ?? q2[0]) as HNode;
  const stack: Array<{ node: HNode; depth: number }> = [
    { node: root, depth: 0 },
  ];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: HNode; depth: number };
    if (node.sym >= 0) {
      lengths[node.sym] = Math.min(Math.max(1, depth), maxBits);
    } else {
      stack.push({ node: node.left as HNode, depth: depth + 1 });
      stack.push({ node: node.right as HNode, depth: depth + 1 });
    }
  }

  // --- Balance to EXACT completeness ---------------------------------------
  // Scale: contribution(len) = 2^(max-len). Full = 2^max.
  const FULL = 1 << maxBits;
  const contribution = (len: number): number => 1 << (maxBits - len);

  let kraft = kraftSum(lengths, maxBits);

  // Oversubscribed: lengthen leaves until we fit. Prefer lengthening the
  // deepest leaf whose reduction fits the excess (avoids overshoot); if none
  // fits, take the deepest movable leaf anyway (small overshoot possible).
  let guard = 0;
  while (kraft > FULL && guard++ < 1 << 16) {
    let pick = -1;
    let pickLen = -1;
    for (const sym of used) {
      const len = lengths[sym];
      if (len < maxBits) {
        const reduction = contribution(len) >> 1;
        if (reduction <= kraft - FULL && len >= pickLen) {
          pick = sym;
          pickLen = len;
        }
      }
    }
    if (pick < 0) {
      // No fitting reduction — take the deepest movable leaf (overshoot).
      for (const sym of used) {
        const len = lengths[sym];
        if (len < maxBits && len >= pickLen) {
          pick = sym;
          pickLen = len;
        }
      }
    }
    if (pick < 0) break; // all at max already (cannot be oversubscribed then)
    kraft -= contribution(lengths[pick]) >> 1;
    lengths[pick]++;
  }

  // Incomplete: shorten leaves until exactly full. Shortening len→len-1
  // gains contribution(len). Choose the longest leaf whose gain fits the
  // deficit (ties → rarest symbol). Because every gain is a power of two
  // and the deficit parity always admits a fitting gain, this terminates.
  guard = 0;
  while (kraft < FULL && guard++ < 1 << 16) {
    const deficit = FULL - kraft;
    let pick = -1;
    let pickLen = -1;
    let pickFreq = Infinity;
    for (const sym of used) {
      const len = lengths[sym];
      if (len > 1 && contribution(len) <= deficit) {
        if (
          len > pickLen ||
          (len === pickLen && freqs[sym] < pickFreq)
        ) {
          pick = sym;
          pickLen = len;
          pickFreq = freqs[sym];
        }
      }
    }
    if (pick < 0) break; // cannot fill further (should not happen for n>=2)
    kraft += contribution(lengths[pick]);
    lengths[pick]--;
  }

  return lengths;
}

// ---------------------------------------------------------------------------
// LZ77 hash-chain match finder.
// ---------------------------------------------------------------------------

interface Token {
  /** 0..255 literal, 256 EOB, 257..285 length code. */
  sym: number;
  /** Extra bits value for length codes. */
  extra: number;
  /** Distance code or -1 for literals/EOB. */
  distSym: number;
  distExtra: number;
}

function lz77(
  data: Uint8Array,
  chainLimit: number
): { tokens: Token[]; litFreq: Uint32Array; distFreq: Uint32Array } {
  const tokens: Token[] = [];
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(data.length).fill(-1);

  const hash = (i: number): number =>
    ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH_SIZE - 1);

  const findMatch = (i: number): { len: number; dist: number } => {
    let bestLen = MIN_MATCH - 1;
    let bestDist = 0;
    let chain = chainLimit;
    let cand = head[hash(i)];
    const limit = i > WINDOW ? i - WINDOW : 0;
    while (cand >= limit && cand >= 0 && chain-- > 0) {
      if (data[cand + bestLen] === data[i + bestLen]) {
        let len = 0;
        const max = Math.min(MAX_MATCH, data.length - i);
        while (len < max && data[cand + len] === data[i + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = i - cand;
          if (len >= MAX_MATCH) break;
        }
      }
      cand = prev[cand];
    }
    return bestLen >= MIN_MATCH
      ? { len: bestLen, dist: bestDist }
      : { len: 0, dist: 0 };
  };

  const pushMatch = (len: number, dist: number): void => {
    let li = 0;
    while (li + 1 < LENGTH_BASE.length && LENGTH_BASE[li + 1] <= len) li++;
    if (len === 258) li = LENGTH_BASE.length - 1;
    let di = 0;
    while (di + 1 < DIST_BASE.length && DIST_BASE[di + 1] <= dist) di++;
    const sym = 257 + li;
    litFreq[sym]++;
    distFreq[di]++;
    tokens.push({
      sym,
      extra: len - LENGTH_BASE[li],
      distSym: di,
      distExtra: dist - DIST_BASE[di],
    });
  };

  const insert = (i: number): void => {
    if (i + MIN_MATCH > data.length) return;
    const h = hash(i);
    // Idempotent: positions can be probed twice (lazy match + match skip);
    // a second insert would self-link prev[i] = i and burn the chain walk.
    if (head[h] === i) return;
    prev[i] = head[h];
    head[h] = i;
  };

  let i = 0;
  while (i < data.length) {
    if (i + MIN_MATCH <= data.length) {
      // Chain holds only positions < i (search BEFORE insert — a self-
      // candidate would produce a bogus distance-0 "match").
      const m1 = findMatch(i);
      if (m1.len >= MIN_MATCH) {
        // Lazy evaluation: might the next position hold a better match?
        if (i + 1 + MIN_MATCH <= data.length && m1.len < MAX_MATCH) {
          insert(i);
          const m2 = findMatch(i + 1);
          if (m2.len > m1.len) {
            litFreq[data[i]]++;
            tokens.push({ sym: data[i], extra: 0, distSym: -1, distExtra: 0 });
            i++;
            continue;
          }
        }
        pushMatch(m1.len, m1.dist);
        // Insert every covered position so later matches can find them.
        for (let k = i; k < i + m1.len; k++) insert(k);
        i += m1.len;
        continue;
      }
      insert(i);
    }
    litFreq[data[i]]++;
    tokens.push({ sym: data[i], extra: 0, distSym: -1, distExtra: 0 });
    i++;
  }
  litFreq[256]++; // EOB always emitted.
  return { tokens, litFreq, distFreq };
}

// ---------------------------------------------------------------------------
// Public compressor.
// ---------------------------------------------------------------------------

/** Emit stored blocks (level 0 / fallback when deflate cannot win). */
function storedDeflate(data: Uint8Array): Uint8Array {
  const bw = new BitWriter(data.length + 1024);
  if (data.length === 0) {
    bw.bits(1, 1); // BFINAL
    bw.bits(0, 2); // BTYPE stored
    bw.alignByte();
    bw.bytes(new Uint8Array([0, 0, 0xff, 0xff]));
    return bw.finish();
  }
  let pos = 0;
  while (pos < data.length) {
    const chunk = Math.min(65535, data.length - pos);
    const final = pos + chunk >= data.length ? 1 : 0;
    bw.bits(final, 1);
    bw.bits(0, 2);
    bw.alignByte();
    const nlen = ~chunk & 0xffff;
    bw.bytes(
      new Uint8Array([
        chunk & 0xff,
        (chunk >> 8) & 0xff,
        nlen & 0xff,
        (nlen >> 8) & 0xff,
      ])
    );
    bw.bytes(data.subarray(pos, pos + chunk));
    pos += chunk;
  }
  return bw.finish();
}

/**
 * Raw DEFLATE compress. Level 0 emits stored blocks; 1-9 emit one dynamic
 * Huffman block (our tools compress one-shot buffers).
 */
export function deflate(data: Uint8Array, level = 6): Uint8Array {
  if (data.length === 0 || level === 0) return storedDeflate(data);
  const chain = LEVEL_CHAIN[level] ?? 128;
  const { tokens, litFreq, distFreq } = lz77(data, chain);

  // Literal tree: ensure EOB and at least 2 leaves.
  litFreq[256] = Math.max(litFreq[256], 1);
  let litUsed = 0;
  for (let i = 0; i < 288; i++) if (litFreq[i] > 0) litUsed++;
  if (litUsed < 2) litFreq[0] = Math.max(litFreq[0], 1);

  // Distance tree: always emit a COMPLETE code (two leaves minimum —
  // zlib-compatible strictness; a lone length-1 code is incomplete).
  let distUsed = 0;
  for (let i = 0; i < 30; i++) if (distFreq[i] > 0) distUsed++;
  if (distUsed === 0) {
    distFreq[0] = 1;
    distFreq[1] = 1;
  } else if (distUsed === 1) {
    const only = distFreq.findIndex((f) => f > 0);
    if (only !== 0) distFreq[0] = 1;
    else distFreq[1] = 1;
  }

  const litLens = buildLengths(litFreq, 15);
  const distLens = buildLengths(distFreq, 15);

  // HLIT/HDIST trim FIRST: the wire carries exactly hlit+hdist lengths.
  let hlit = 288;
  while (hlit > 257 && litLens[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLens[hdist - 1] === 0) hdist--;

  // --- Serialize the merged code-length sequence with RLE 16/17/18. ------
  const flat: number[] = [];
  for (let i = 0; i < hlit; i++) flat.push(litLens[i]);
  for (let i = 0; i < hdist; i++) flat.push(distLens[i]);
  const clenSyms: number[] = [];
  const clenExtraBits: number[] = [];
  const clenExtraVal: number[] = [];
  {
    let p = 0;
    while (p < flat.length) {
      const v = flat[p];
      let run = 1;
      while (p + run < flat.length && flat[p + run] === v) run++;
      if (v === 0) {
        let left = run;
        while (left >= 11) {
          const n = Math.min(left, 138);
          clenSyms.push(18);
          clenExtraBits.push(7);
          clenExtraVal.push(n - 11);
          left -= n;
        }
        while (left >= 3) {
          const n = Math.min(left, 10);
          clenSyms.push(17);
          clenExtraBits.push(3);
          clenExtraVal.push(n - 3);
          left -= n;
        }
        while (left > 0) {
          clenSyms.push(0);
          clenExtraBits.push(0);
          clenExtraVal.push(0);
          left--;
        }
      } else {
        clenSyms.push(v);
        clenExtraBits.push(0);
        clenExtraVal.push(0);
        let left = run - 1;
        while (left >= 3) {
          const n = Math.min(left, 6);
          clenSyms.push(16);
          clenExtraBits.push(2);
          clenExtraVal.push(n - 3);
          left -= n;
        }
        while (left > 0) {
          clenSyms.push(v);
          clenExtraBits.push(0);
          clenExtraVal.push(0);
          left--;
        }
      }
      p += run;
    }
  }

  // Code-length tree (max 7 bits); pad to >= 2 leaves.
  const clenFreq = new Uint32Array(19);
  for (const s of clenSyms) clenFreq[s]++;
  let clenUsed = 0;
  for (let i = 0; i < 19; i++) if (clenFreq[i] > 0) clenUsed++;
  if (clenUsed < 2) clenFreq[0] = Math.max(clenFreq[0], 1);
  const clenLens = buildLengths(clenFreq, 7);

  let hclen = 19;
  while (hclen > 4 && clenLens[CLEN_ORDER[hclen - 1]] === 0) hclen--;

  const litCodes = canonicalCodes(litLens);
  const distCodes = canonicalCodes(distLens);
  const clenCodes = canonicalCodes(clenLens);

  const bw = new BitWriter(Math.max(1 << 12, data.length >> 1));
  bw.bits(1, 1); // BFINAL
  bw.bits(2, 2); // BTYPE dynamic
  bw.bits(hlit - 257, 5);
  bw.bits(hdist - 1, 5);
  bw.bits(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) {
    bw.bits(clenLens[CLEN_ORDER[i]], 3);
  }
  for (let k = 0; k < clenSyms.length; k++) {
    const sym = clenSyms[k];
    bw.code(clenCodes[sym], clenLens[sym]);
    if (clenExtraBits[k] > 0) {
      bw.bits(clenExtraVal[k], clenExtraBits[k]);
    }
  }
  for (const t of tokens) {
    bw.code(litCodes[t.sym], litLens[t.sym]);
    if (t.sym > 256) {
      const li = t.sym - 257;
      if (LENGTH_EXTRA[li] > 0) bw.bits(t.extra, LENGTH_EXTRA[li]);
      bw.code(distCodes[t.distSym], distLens[t.distSym]);
      if (DIST_EXTRA[t.distSym] > 0) {
        bw.bits(t.distExtra, DIST_EXTRA[t.distSym]);
      }
    }
  }
  bw.code(litCodes[256], litLens[256]);
  const out = bw.finish();

  // If compression cannot beat stored blocks, fall back honestly.
  if (out.length >= data.length + Math.ceil(data.length / 65535) * 5 + 6) {
    return storedDeflate(data);
  }
  return out;
}

/** Test hooks (never used by the app itself). */
export const _internal = { canonicalCodes, buildLengths, kraftCheck: kraftSum };
