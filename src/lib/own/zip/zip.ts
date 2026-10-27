/**
 * DocoPDF own ZIP/DEFLATE engine — ZIP archive container (writer + reader).
 * Self-written APPNOTE.TXT implementation:
 * - Writer: local headers + central directory + EOCD; STORE and DEFLATE
 *   methods; UTF-8 names (flag bit 11); DOS timestamps; nested Zippable
 *   directories flattened with "/".
 * - Reader: EOCD scan (zip64 aware), central directory entries (zip64
 *   extra field sizes), data descriptors honored, directories skipped.
 * No external packages.
 */

import { deflate } from "./deflate";
import { inflate } from "./inflate";
import { crc32 } from "./crc32";

/** fflate-compatible entry type: bytes, [bytes, {level}], or nested dir. */
export interface Zippable {
  [path: string]: Uint8Array | [Uint8Array, { level?: number }] | Zippable;
}
export type Unzipped = Record<string, Uint8Array>;

/** Flatten a Zippable into path → bytes (level per entry). */
function flatten(
  obj: Zippable,
  prefix = "",
  out: Array<{ path: string; data: Uint8Array; level: number }> = []
): Array<{ path: string; data: Uint8Array; level: number }> {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const path = prefix ? `${prefix}/${key}` : key;
    if (value instanceof Uint8Array) {
      out.push({ path, data: value, level: 6 });
    } else if (Array.isArray(value)) {
      out.push({
        path,
        data: value[0],
        level: value[1]?.level ?? 6,
      });
    } else {
      flatten(value, path, out);
    }
  }
  return out;
}

/** DOS date/time from a Date (local time), clamped to the DOS epoch. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Create a ZIP archive (level 0 stores entries; 1-9 deflates). */
export function zipSync(
  files: Zippable,
  opts: { level?: number } = {}
): Uint8Array {
  const level = opts.level ?? 6;
  const entries = flatten(files);
  const { time, date } = dosDateTime(new Date());

  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const enc = new TextEncoder();
  for (const entry of entries) {
    const name = enc.encode(entry.path);
    const data = entry.data;
    // Per-ENTRY level (tuple overrides) beats the archive-level default.
    const entryLevel = entry.level ?? level;
    const useDeflate = entryLevel > 0 && data.length > 0;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate
      ? deflate(data, Math.min(9, Math.max(1, entryLevel)))
      : data;
    // If deflate failed to shrink a small entry, store it instead.
    const finalPayload = useDeflate && payload.length >= data.length ? data : payload;
    const finalMethod = useDeflate && payload.length >= data.length ? 0 : method;
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length + finalPayload.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header sig
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 name
    lv.setUint16(8, finalMethod, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, finalPayload.length, true); // csize
    lv.setUint32(22, data.length, true); // usize
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra len
    local.set(name, 30);
    local.set(finalPayload, 30 + name.length);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central dir sig
    cv.setUint16(4, 0x031e, true); // version made by: UNIX, ZIP 3.0
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true); // flags
    cv.setUint16(10, finalMethod, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, finalPayload.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true);
    cd.set(name, 46);

    chunks.push(local);
    central.push(cd);
    offset += local.length;
  }

  const centralBytes = central.map((c) => c);
  const centralSize = centralBytes.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true); // disk
  ev.setUint16(6, 0, true); // cd disk
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true); // comment len

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of [...chunks, ...centralBytes, eocd]) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

// --- Reader -----------------------------------------------------------------

function u16(d: Uint8Array, p: number): number {
  return d[p] | (d[p + 1] << 8);
}
function u32(d: Uint8Array, p: number): number {
  return ((d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0);
}
function u64(d: Uint8Array, p: number): number {
  // JS numbers hold ZIP64 sizes exactly up to 2^53 — plenty for our tools.
  const lo = u32(d, p);
  const hi = u32(d, p + 4);
  return hi * 4294967296 + lo;
}

interface CdEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
}

/** Read a ZIP archive into path → bytes. Throws on malformed containers. */
export function unzipSync(data: Uint8Array): Unzipped {
  // --- Locate EOCD (scan backwards over an optional comment). ------------
  let eocd = -1;
  const scanStart = Math.max(0, data.length - 65557);
  for (let i = data.length - 22; i >= scanStart; i--) {
    if (u32(data, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: end of central directory not found");

  let count = u16(data, eocd + 10);
  let cdOffset = u32(data, eocd + 16);
  let cdSize = u32(data, eocd + 12);

  // --- ZIP64? (cdOffset == 0xFFFFFFFF or count == 0xFFFF) -----------------
  if (cdOffset === 0xffffffff || count === 0xffff) {
    // ZIP64 locator sits right before the EOCD.
    if (eocd >= 20 && u32(data, eocd - 20) === 0x07064b50) {
      const z64Offset = u64(data, eocd - 20 + 8);
      if (u32(data, z64Offset) === 0x06064b50) {
        const total = u64(data, z64Offset + 32);
        count = total > 0xffff ? 0xffff : total;
        cdSize = u32(data, z64Offset + 40) === 0xffffffff
          ? u64(data, z64Offset + 40)
          : u32(data, z64Offset + 40);
        cdOffset = u64(data, z64Offset + 48);
      }
    }
  }

  // --- Parse central directory --------------------------------------------
  const entries: CdEntry[] = [];
  const dec = new TextDecoder();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (u32(data, p) !== 0x02014b50) {
      throw new Error("zip: bad central directory entry");
    }
    const method = u16(data, p + 10);
    const flags = u16(data, p + 8);
    const crc = u32(data, p + 16);
    let csize = u32(data, p + 20);
    let usize = u32(data, p + 24);
    const nameLen = u16(data, p + 28);
    const extraLen = u16(data, p + 30);
    const commentLen = u16(data, p + 32);
    let offset = u32(data, p + 42);
    const nameBytes = data.subarray(p + 46, p + 46 + nameLen);
    const name = dec.decode(nameBytes);

    // ZIP64 extra field (id 0x0001): sizes/offset may live here.
    let ep = p + 46 + nameLen;
    const extraEnd = ep + extraLen;
    while (ep + 4 <= extraEnd) {
      const id = u16(data, ep);
      const sz = u16(data, ep + 2);
      if (id === 0x0001) {
        let q = ep + 4;
        const end = ep + 4 + sz;
        if (usize === 0xffffffff && q + 8 <= end) {
          usize = u64(data, q);
          q += 8;
        }
        if (csize === 0xffffffff && q + 8 <= end) {
          csize = u64(data, q);
          q += 8;
        }
        if (offset === 0xffffffff && q + 8 <= end) {
          offset = u64(data, q);
          q += 8;
        }
      }
      ep += 4 + sz;
    }

    if (!name.endsWith("/")) {
      entries.push({ name, method, flags, crc, csize, usize, offset });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  void cdSize;

  // --- Extract each entry ---------------------------------------------------
  const out: Unzipped = {};
  for (const e of entries) {
    if (u32(data, e.offset) !== 0x04034b50) {
      throw new Error(`zip: bad local header for ${e.name}`);
    }
    const lNameLen = u16(data, e.offset + 26);
    const lExtraLen = u16(data, e.offset + 28);
    const dataStart = e.offset + 30 + lNameLen + lExtraLen;
    const payload = data.subarray(dataStart, dataStart + e.csize);
    let bytes: Uint8Array;
    if (e.method === 0) {
      bytes = payload.subarray(0, e.usize);
    } else if (e.method === 8) {
      bytes = inflate(payload).bytes;
      if (bytes.length !== e.usize) {
        throw new Error(`zip: size mismatch for ${e.name}`);
      }
    } else {
      throw new Error(`zip: unsupported method ${e.method} for ${e.name}`);
    }
    if (e.crc !== 0 && crc32(bytes) !== e.crc) {
      throw new Error(`zip: CRC mismatch for ${e.name}`);
    }
    out[e.name] = bytes;
  }
  return out;
}

/** Decode a UTF-8 string to bytes (fflate-compatible helper). */
export { strToU8 } from "./text";
