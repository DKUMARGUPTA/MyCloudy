/**
 * DocoPDF own ZIP/DEFLATE engine — Adler-32 (RFC 1950 §8.2).
 * Self-written; no external packages.
 */

/** One-shot Adler-32. */
export function adler32(data: Uint8Array, start = 0, end = data.length): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  // Process in chunks so `a` can never overflow 32 bits (5552 is the
  // classic NMAX bound for 16-bit accumulators; keeps math in safe ints).
  let i = start;
  while (i < end) {
    const chunkEnd = Math.min(i + 5552, end);
    for (; i < chunkEnd; i++) {
      a += data[i];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}
