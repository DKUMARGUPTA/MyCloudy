/**
 * DocoPDF own ZIP/DEFLATE engine — INFLATE (RFC 1951 decompressor).
 * Self-written canonical-Huffman implementation ("puff"-style decoding),
 * handles stored / fixed / dynamic blocks. No external packages.
 */

/** LSB-first bit reader over a Uint8Array. */
class BitReader {
  private pos = 0;
  private bitBuf = 0;
  private bitCnt = 0;

  constructor(private readonly data: Uint8Array) {}

  /** Read n bits (n <= 24) LSB-first. */
  bits(n: number): number {
    while (this.bitCnt < n) {
      if (this.pos >= this.data.length) {
        throw new Error("inflate: unexpected end of stream");
      }
      this.bitBuf |= this.data[this.pos++] << this.bitCnt;
      this.bitCnt += 8;
    }
    const val = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCnt -= n;
    return val;
  }

  /** Align to the next byte boundary (discards partial bits). */
  alignByte(): void {
    this.bitBuf = 0;
    this.bitCnt = 0;
  }

  /** Bytes consumed so far. */
  bytePos(): number {
    return this.pos;
  }

  /** Raw byte at the current aligned position (stored blocks). */
  readByte(): number {
    if (this.pos >= this.data.length) {
      throw new Error("inflate: unexpected end of stream");
    }
    return this.data[this.pos++];
  }

  /** Read a little-endian 16-bit value at an aligned position. */
  readUint16LE(): number {
    return this.readByte() | (this.readByte() << 8);
  }
}

/** Canonical Huffman decoding table (counts + sorted symbols). */
class Huffman {
  private readonly counts: Uint16Array;
  private readonly symbols: Uint16Array;

  constructor(lengths: Uint8Array) {
    const MAX_BITS = 15;
    this.counts = new Uint16Array(MAX_BITS + 1);
    for (let i = 0; i < lengths.length; i++) {
      this.counts[lengths[i]]++;
    }
    const offs = new Uint16Array(MAX_BITS + 2);
    for (let len = 1; len <= MAX_BITS; len++) {
      offs[len + 1] = offs[len] + this.counts[len];
    }
    this.symbols = new Uint16Array(offs[MAX_BITS + 1]);
    // Fill cursor for each length group starts at ITS OWN group start
    // (offs[len] = Σ counts[1..len-1]); using offs[len+1] would shift every
    // symbol one group forward (the bug the 100-byte corpus caught).
    const next = new Uint16Array(MAX_BITS + 2);
    for (let len = 1; len <= MAX_BITS; len++) {
      next[len] = offs[len];
    }
    for (let sym = 0; sym < lengths.length; sym++) {
      const len = lengths[sym];
      if (len !== 0) {
        this.symbols[next[len]++] = sym;
      }
    }
  }

  /** Decode one symbol; bits arrive MSB-first (canonical Huffman order). */
  decode(br: BitReader): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= br.bits(1);
      const count = this.counts[len];
      if (code - first < count) {
        return this.symbols[index + (code - first)];
      }
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error("inflate: invalid Huffman code");
  }
}

// --- Static tables from RFC 1951 §3.2.5 / §3.2.6 ---------------------------

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

function fixedLitLengths(): Uint8Array {
  const lengths = new Uint8Array(288);
  for (let i = 0; i <= 143; i++) lengths[i] = 8;
  for (let i = 144; i <= 255; i++) lengths[i] = 9;
  for (let i = 256; i <= 279; i++) lengths[i] = 7;
  for (let i = 280; i <= 287; i++) lengths[i] = 8;
  return lengths;
}

function fixedDistLengths(): Uint8Array {
  return new Uint8Array(30).fill(5);
}

/**
 * Raw DEFLATE decompress. Returns the decompressed bytes and the number of
 * input bytes consumed (useful for zlib/zip layers that have trailing data).
 */
export function inflate(
  data: Uint8Array
): { bytes: Uint8Array; consumed: number } {
  const br = new BitReader(data);
  // Output buffer: power-of-two doubling.
  let buf = new Uint8Array(1 << 16);
  let outLen = 0;

  const ensure = (need: number): void => {
    if (buf.length >= need) return;
    let cap = buf.length;
    while (cap < need) cap *= 2;
    const bigger = new Uint8Array(cap);
    bigger.set(buf.subarray(0, outLen));
    buf = bigger;
  };

  for (;;) {
    const final = br.bits(1);
    const type = br.bits(2);
    if (type === 0) {
      // Stored block: discard remaining bits in the current byte.
      br.alignByte();
      const len = br.readUint16LE();
      const nlen = br.readUint16LE();
      if ((len ^ 0xffff) !== nlen) {
        throw new Error("inflate: stored block LEN/NLEN mismatch");
      }
      ensure(outLen + len);
      for (let i = 0; i < len; i++) {
        buf[outLen++] = br.readByte();
      }
    } else if (type === 1 || type === 2) {
      let lit: Huffman;
      let dist: Huffman;
      if (type === 1) {
        lit = new Huffman(fixedLitLengths());
        dist = new Huffman(fixedDistLengths());
      } else {
        const hlit = br.bits(5) + 257;
        const hdist = br.bits(5) + 1;
        const hclen = br.bits(4) + 4;
        const clenLens = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) {
          clenLens[CLEN_ORDER[i]] = br.bits(3);
        }
        const clenTree = new Huffman(clenLens);
        const lengths = new Uint8Array(hlit + hdist);
        let i = 0;
        while (i < hlit + hdist) {
          const sym = clenTree.decode(br);
          if (sym < 16) {
            lengths[i++] = sym;
          } else if (sym === 16) {
            if (i === 0) {
              throw new Error("inflate: repeat with no previous length");
            }
            const prev = lengths[i - 1];
            const rep = 3 + br.bits(2);
            for (let r = 0; r < rep && i < hlit + hdist; r++) {
              lengths[i++] = prev;
            }
          } else if (sym === 17) {
            i += 3 + br.bits(3);
          } else {
            i += 11 + br.bits(7);
          }
        }
        if (i > hlit + hdist) {
          throw new Error("inflate: code length repeat overflow");
        }
        lit = new Huffman(lengths.subarray(0, hlit));
        dist = new Huffman(lengths.subarray(hlit, hlit + hdist));
      }
      for (;;) {
        const sym = lit.decode(br);
        if (sym < 256) {
          ensure(outLen + 1);
          buf[outLen++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          const li = sym - 257;
          if (li >= LENGTH_BASE.length) {
            throw new Error("inflate: invalid length symbol");
          }
          const length =
            LENGTH_BASE[li] + (LENGTH_EXTRA[li] ? br.bits(LENGTH_EXTRA[li]) : 0);
          const dsym = dist.decode(br);
          if (dsym >= DIST_BASE.length) {
            throw new Error("inflate: invalid distance symbol");
          }
          const distance =
            DIST_BASE[dsym] + (DIST_EXTRA[dsym] ? br.bits(DIST_EXTRA[dsym]) : 0);
          if (distance > outLen) {
            throw new Error("inflate: distance too far back");
          }
          ensure(outLen + length);
          let from = outLen - distance;
          // Byte-at-a-time copy handles overlapping runs correctly.
          for (let i = 0; i < length; i++) {
            buf[outLen++] = buf[from++];
          }
        }
      }
    } else {
      throw new Error("inflate: invalid block type 3");
    }
    if (final === 1) break;
  }

  return { bytes: buf.subarray(0, outLen), consumed: br.bytePos() };
}
