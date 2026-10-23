/**
 * JPEG EXIF orientation reader (FIX-1d).
 *
 * The image tools embed ORIGINAL JPEG bytes on their fast path (zero
 * quality loss), but browsers report DECODED (EXIF-oriented) dimensions
 * from createImageBitmap / <img>. Any photo with an orientation tag ≠ 1
 * (i.e. most portrait phone photos) therefore renders sideways and
 * distorted unless the rotation is baked in first. This sniff lets the
 * fast path stay byte-exact for the ~95% of JPEGs that carry no rotation,
 * and routes the rest through the decode-and-re-encode path.
 *
 * Read-only, allocation-free: walks the SOI → APPn marker chain, finds
 * the first APP1 "Exif\0\0" segment, parses the TIFF header (either
 * endianness) + IFD0 and reads tag 0x0112 (Orientation). STRICT
 * bounds-checking throughout — any doubt (missing/truncated/oversized
 * structures, weird value types) returns 1 ("upright, unknown"), the
 * safe default that keeps the original-bytes fast path.
 */

/** Orientation values 5-8 are the 90°-rotated (axis-swapping) ones. */
export function exifOrientationSwapsAxes(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

export function readJpegOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength;
  // SOI — not a JPEG → nothing to say.
  if (end < 4 || view.getUint16(0) !== 0xffd8) return 1;

  let pos = 2;
  while (pos + 4 <= end) {
    if (view.getUint8(pos) !== 0xff) return 1; // lost the marker chain
    let marker = view.getUint8(pos + 1);
    if (marker === 0xff) {
      pos += 1; // fill byte between segments
      continue;
    }
    // Standalone markers (TEM, RSTn) carry no length payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    // Image data or EOI reached without an EXIF APP1 → orientation
    // unknown (SOS = scan data, C0-CF = SOF frames).
    if (
      marker === 0xd9 ||
      marker === 0xda ||
      (marker >= 0xc0 && marker <= 0xcf)
    ) {
      return 1;
    }
    const segLen = view.getUint16(pos + 2);
    if (segLen < 2 || pos + 2 + segLen > end) return 1; // truncated segment
    const segEnd = pos + 2 + segLen;
    if (marker === 0xe1 && segEnd - (pos + 4) >= 6) {
      const payload = pos + 4; // first byte after the length field
      if (
        bytes[payload] === 0x45 && // E
        bytes[payload + 1] === 0x78 && // x
        bytes[payload + 2] === 0x69 && // i
        bytes[payload + 3] === 0x66 && // f
        bytes[payload + 4] === 0x00 &&
        bytes[payload + 5] === 0x00
      ) {
        return readTiffOrientation(view, payload + 6, segEnd);
      }
    }
    pos = segEnd;
  }
  return 1;
}

/** TIFF header + IFD0 → tag 0x0112. `from` is the "II"/"MM" byte. */
function readTiffOrientation(view: DataView, from: number, end: number): number {
  if (from + 8 > end) return 1;
  const little = view.getUint16(from) === 0x4949; // "II"
  if (!little && view.getUint16(from) !== 0x4d4d) return 1; // "MM"
  if (view.getUint16(from + 2, little) !== 42) return 1; // TIFF magic
  const ifdOffset = view.getUint32(from + 4, little);
  if (ifdOffset < 8 || from + ifdOffset + 2 > end) return 1;
  const entryCount = view.getUint16(from + ifdOffset, little);
  const first = from + ifdOffset + 2;
  // Entries are 12 bytes; stop as soon as one would cross the segment.
  for (let i = 0; i < entryCount; i += 1) {
    const entry = first + i * 12;
    if (entry + 12 > end) return 1;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    const type = view.getUint16(entry + 2, little);
    const count = view.getUint32(entry + 4, little);
    if (type !== 3 || count !== 1) return 1; // must be a single SHORT
    const value = view.getUint16(entry + 8, little);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}
