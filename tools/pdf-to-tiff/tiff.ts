/**
 * Baseline TIFF encoder (P9 batch 1 — pdf-to-tiff).
 *
 * Writes an uncompressed, little-endian ("II"), baseline TIFF with one
 * IFD per page chained via the next-IFD offset — i.e. a REAL multi-page
 * TIFF, the format's headline feature for archives and fax software.
 *
 * Pixel data is 24-bit RGB (PhotometricInterpretation = 2), one strip per
 * page (RowsPerStrip = height, Compression = 1 "none"). No LZW/PackBits:
 * every reader on earth opens uncompressed TIFF, and honesty beats a
 * marginally smaller file that a fax machine might refuse.
 *
 * Pure typed-array code — no DOM, so the smoke test runs it in Node/Bun.
 */

export interface TiffPageInput {
  width: number;
  height: number;
  /** RGBA pixels, length = width × height × 4, row-major from the top. */
  rgba: Uint8ClampedArray;
}

/* TIFF field types (subset we use). */
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

/* Tag ids in ASCENDING order — the TIFF spec requires sorted IFDs. */
const TAG_NEWSUBFILETYPE = 254;
const TAG_IMAGEWIDTH = 256;
const TAG_IMAGELENGTH = 257;
const TAG_BITSPERSAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_PHOTOMETRIC = 262;
const TAG_STRIPOFFSETS = 273;
const TAG_SAMPLESPERPIXEL = 277;
const TAG_ROWSPERSTRIP = 278;
const TAG_STRIPBYTECOUNTS = 279;
const TAG_XRESOLUTION = 282;
const TAG_YRESOLUTION = 283;
const TAG_RESOLUTIONUNIT = 296;

/** 13 entries per IFD (see the TAG list written below). */
const ENTRY_COUNT = 13;
/** 2 (count) + entries × 12 + 4 (next IFD offset). */
const IFD_SIZE = 2 + ENTRY_COUNT * 12 + 4;
/** External values per page: BitsPerSample (6 → padded 8) + XRes (8) + YRes (8). */
const EXT_SIZE = 24;

interface Writer {
  /** DataView + length; offsets are absolute positions in the file. */
  view: DataView;
  bytes: Uint8Array;
}

function writeEntry(
  w: Writer,
  at: number,
  tag: number,
  type: number,
  count: number,
  value: number
): void {
  w.view.setUint16(at, tag, true);
  w.view.setUint16(at + 2, type, true);
  w.view.setUint32(at + 4, count, true);
  if (type === TYPE_SHORT) {
    w.view.setUint16(at + 8, value, true);
    w.view.setUint16(at + 10, 0, true);
  } else {
    w.view.setUint32(at + 8, value, true);
  }
}

function writeEntryOffset(
  w: Writer,
  at: number,
  tag: number,
  type: number,
  count: number,
  offset: number
): void {
  w.view.setUint16(at, tag, true);
  w.view.setUint16(at + 2, type, true);
  w.view.setUint32(at + 4, count, true);
  w.view.setUint32(at + 8, offset, true);
}

/**
 * Encodes pages into one multi-page TIFF. `dpi` lands in XResolution /
 * YResolution so viewers report the true print size.
 */
export function encodeTiff(
  pages: TiffPageInput[],
  dpi: number
): Uint8Array<ArrayBuffer> {
  if (pages.length === 0) throw new Error("tiff: no pages");

  // Pass 1 — sizes and offsets. Layout per page: IFD | external values |
  // pixel data (padded to 4). Offsets are exact because every block's
  // size is known up front.
  const pixels: Uint8Array[] = [];
  const ifdOffsets: number[] = [];
  const extOffsets: number[] = [];
  const pixelOffsets: number[] = [];

  let cursor = 8; // file header
  for (const page of pages) {
    const { width, height } = page;
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      page.rgba.length < width * height * 4
    ) {
      throw new Error("tiff: bad page geometry");
    }
    // RGBA → RGB strip (also validates pixel count against the buffer).
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, s = 0, d = 0; i < width * height; i += 1, s += 4, d += 3) {
      const a = page.rgba[s + 3];
      // Compose onto white so semi-transparent PDF paints stay legible
      // (TIFF has no alpha in baseline 24-bit RGB).
      const alpha = a / 255;
      rgb[d] = Math.round(page.rgba[s] * alpha + 255 * (1 - alpha));
      rgb[d + 1] = Math.round(page.rgba[s + 1] * alpha + 255 * (1 - alpha));
      rgb[d + 2] = Math.round(page.rgba[s + 2] * alpha + 255 * (1 - alpha));
    }
    pixels.push(rgb);

    ifdOffsets.push(cursor);
    cursor += IFD_SIZE;
    extOffsets.push(cursor);
    cursor += EXT_SIZE;
    pixelOffsets.push(cursor);
    const padded = rgb.length + ((4 - (rgb.length % 4)) % 4);
    cursor += padded;
  }

  const bytes = new Uint8Array(cursor);
  const w: Writer = { view: new DataView(bytes.buffer), bytes };

  /* Header: "II" (little-endian), magic 42, offset of IFD 0. */
  bytes[0] = 0x49;
  bytes[1] = 0x49;
  w.view.setUint16(2, 42, true);
  w.view.setUint32(4, 8, true);

  for (let p = 0; p < pages.length; p += 1) {
    const { width, height } = pages[p];
    const rgb = pixels[p];
    const ifd = ifdOffsets[p];
    const ext = extOffsets[p];
    const pixel = pixelOffsets[p];

    /* ---- external value blocks ---- */
    // BitsPerSample: 8, 8, 8 (SHORT × 3 = 6 bytes, region padded to 8).
    w.view.setUint16(ext, 8, true);
    w.view.setUint16(ext + 2, 8, true);
    w.view.setUint16(ext + 4, 8, true);
    // XResolution: dpi / 1 (RATIONAL).
    w.view.setUint32(ext + 8, Math.round(dpi), true);
    w.view.setUint32(ext + 12, 1, true);
    // YResolution: dpi / 1.
    w.view.setUint32(ext + 16, Math.round(dpi), true);
    w.view.setUint32(ext + 20, 1, true);

    /* ---- IFD (entries in ascending tag order) ---- */
    w.view.setUint16(ifd, ENTRY_COUNT, true);
    let at = ifd + 2;
    writeEntry(w, at, TAG_NEWSUBFILETYPE, TYPE_LONG, 1, p === 0 ? 0 : 2);
    at += 12;
    writeEntry(w, at, TAG_IMAGEWIDTH, TYPE_LONG, 1, width);
    at += 12;
    writeEntry(w, at, TAG_IMAGELENGTH, TYPE_LONG, 1, height);
    at += 12;
    writeEntryOffset(w, at, TAG_BITSPERSAMPLE, TYPE_SHORT, 3, ext);
    at += 12;
    writeEntry(w, at, TAG_COMPRESSION, TYPE_SHORT, 1, 1); // none
    at += 12;
    writeEntry(w, at, TAG_PHOTOMETRIC, TYPE_SHORT, 1, 2); // RGB
    at += 12;
    writeEntry(w, at, TAG_STRIPOFFSETS, TYPE_LONG, 1, pixel);
    at += 12;
    writeEntry(w, at, TAG_SAMPLESPERPIXEL, TYPE_SHORT, 1, 3);
    at += 12;
    writeEntry(w, at, TAG_ROWSPERSTRIP, TYPE_LONG, 1, height);
    at += 12;
    writeEntry(w, at, TAG_STRIPBYTECOUNTS, TYPE_LONG, 1, rgb.length);
    at += 12;
    writeEntryOffset(w, at, TAG_XRESOLUTION, TYPE_RATIONAL, 1, ext + 8);
    at += 12;
    writeEntryOffset(w, at, TAG_YRESOLUTION, TYPE_RATIONAL, 1, ext + 16);
    at += 12;
    writeEntry(w, at, TAG_RESOLUTIONUNIT, TYPE_SHORT, 1, 2); // inch

    /* next IFD offset (0 on the last page) */
    w.view.setUint32(ifd + 2 + ENTRY_COUNT * 12, p + 1 < pages.length ? ifdOffsets[p + 1] : 0, true);

    /* ---- pixel strip ---- */
    bytes.set(rgb, pixel);
  }

  return bytes;
}
