/** Text helpers for the own ZIP engine (fflate-compatible surface). */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 encode a string. */
export function strToU8(s: string): Uint8Array {
  return encoder.encode(s);
}

/** UTF-8 decode bytes (unused by the engine today; exported for parity). */
export function strFromU8(b: Uint8Array): string {
  return decoder.decode(b);
}
