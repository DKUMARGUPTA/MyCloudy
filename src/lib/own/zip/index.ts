/**
 * DocoPDF own ZIP/DEFLATE engine — public API.
 *
 * A complete, self-written, zero-dependency replacement for the fflate
 * surface this app uses: zipSync / unzipSync / zlibSync / unzlibSync /
 * inflateSync / decompressSync / strToU8 + the Zippable/Unzipped types.
 * See crc32.ts, adler32.ts, deflate.ts, inflate.ts, zlib.ts, zip.ts.
 */

export { Crc32, crc32 } from "./crc32";
export { adler32 } from "./adler32";
export { deflate } from "./deflate";
export { inflate } from "./inflate";
export {
  zlibSync,
  unzlibSync,
  decompressSync,
  gunzipSync,
} from "./zlib";
export { zipSync, unzipSync, type Zippable, type Unzipped } from "./zip";
export { strToU8 } from "./text";
export { _internal } from "./deflate";

import { inflate } from "./inflate";

/** Raw DEFLATE decompress returning just the bytes (fflate name). */
export function inflateSync(data: Uint8Array): Uint8Array {
  return inflate(data).bytes;
}
