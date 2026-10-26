/**
 * DocoPDF own ZIP/DEFLATE engine — CRC-32 (IEEE 802.3, reflected 0xEDB88320).
 * Self-written table-based implementation; no external packages.
 */

const CRC_TABLE = new Uint32Array(256);

(() => {
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    CRC_TABLE[n] = c >>> 0;
  }
})();

/** Incremental CRC-32 state (starts at 0). */
export class Crc32 {
  private state = 0xffffffff;

  update(data: Uint8Array, start = 0, end = data.length): void {
    let c = this.state;
    for (let i = start; i < end; i++) {
      c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    }
    this.state = c;
  }

  /** Final digest (without resetting). */
  digest(): number {
    return (this.state ^ 0xffffffff) >>> 0;
  }

  reset(): void {
    this.state = 0xffffffff;
  }
}

/** One-shot CRC-32. */
export function crc32(data: Uint8Array): number {
  const crc = new Crc32();
  crc.update(data);
  return crc.digest();
}
