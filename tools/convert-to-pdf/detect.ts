/**
 * Universal converter type detection (PRD §7.8) — PURE, bun-testable.
 *
 * Reads the first ≤ 512 bytes of a file and decides what it is. Magic
 * bytes ALWAYS win over the file name (a PNG renamed "evil.docx" is a
 * PNG); the name is only consulted for ZIP containers (DOCX/XLSX/PPTX/
 * ODT/EPUB), whose central directory would need a real unzipper to tell
 * apart. Zero imports, zero side effects.
 */

export type SniffKind =
  | "pdf"
  | "jpg"
  | "png"
  | "webp"
  | "heic"
  | "gif"
  | "bmp"
  | "tiff"
  | "svg"
  | "txt"
  | "html"
  | "docx"
  | "xlsx"
  | "pptx"
  | "office"
  | "epub"
  | "unknown";

export interface SniffResult {
  kind: SniffKind;
  /** i18n key of the human label ("conv.kindJpg" …) — lives in the shared
   *  `conv` section of tools/convert-to-pdf/i18n.json. */
  labelKey: string;
}

const LABEL_KEYS: Record<SniffKind, string> = {
  pdf: "conv.kindPdf",
  jpg: "conv.kindJpg",
  png: "conv.kindPng",
  webp: "conv.kindWebp",
  heic: "conv.kindHeic",
  gif: "conv.kindGif",
  bmp: "conv.kindBmp",
  tiff: "conv.kindTiff",
  svg: "conv.kindSvg",
  txt: "conv.kindTxt",
  html: "conv.kindHtml",
  docx: "conv.kindDocx",
  xlsx: "conv.kindXlsx",
  pptx: "conv.kindPptx",
  office: "conv.kindOffice",
  epub: "conv.kindEpub",
  unknown: "conv.kindUnknown",
};

/** ZIP-container kinds by file extension (magic alone cannot tell them
 *  apart without a full unzip — the extension is a hint, not the truth). */
const ZIP_EXT_KINDS: Record<string, SniffKind> = {
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  odt: "office",
  ods: "office",
  odp: "office",
  odg: "office",
  epub: "epub",
};

/** HEIF/HEIC ftyp brands (the container is ISO-BMFF "ftyp" at offset 4). */
const HEIC_BRANDS = [
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevm",
  "hevx",
  "mif1",
  "msf1",
];

function startsWith(
  bytes: Uint8Array,
  signature: number[],
  offset = 0
): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  const end = Math.min(bytes.length, offset + length);
  for (let i = offset; i < end; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** True when the head decodes as mostly text: no NUL bytes and ≥ 92% of
 *  bytes are printable ASCII, tab/newline, or UTF-8 lead/continuation
 *  bytes (Devanagari text files must pass too). */
function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  let texty = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte === 0) return false;
    if (
      byte === 9 ||
      byte === 10 ||
      byte === 13 ||
      (byte >= 32 && byte <= 126) ||
      byte >= 128
    ) {
      texty += 1;
    }
  }
  return texty / bytes.length >= 0.92;
}

/**
 * Classify a file from its head bytes + name. Order matters:
 *   1. binary magic bytes (PDF, raster images, TIFF, BMP …)
 *   2. ZIP container + extension hint (DOCX/XLSX/PPTX/ODT/EPUB …)
 *   3. text sniffing — SVG and HTML first, plain text as the fallback
 *   4. honest "unknown"
 */
export function sniffKind(bytes: Uint8Array, name: string): SniffResult {
  const kind = sniffKindValue(bytes, name);
  return { kind, labelKey: LABEL_KEYS[kind] };
}

function sniffKindValue(bytes: Uint8Array, name: string): SniffKind {
  if (bytes.length < 4) {
    return "unknown";
  }

  /* ---- 1. binary magic bytes ---- */
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF-
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg"; // JPEG
  if (
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return "png";
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "gif"; // GIF8
  if (startsWith(bytes, [0x42, 0x4d])) return "bmp"; // BM
  if (
    startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || // II*\0 (little endian)
    startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]) // MM\0* (big endian)
  ) {
    return "tiff";
  }
  // RIFF....WEBP
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "webp";
  }
  // ISO-BMFF: ....ftyp<brand>
  if (
    startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4) &&
    HEIC_BRANDS.includes(asciiAt(bytes, 8, 4))
  ) {
    return "heic";
  }

  /* ---- 2. ZIP containers (extension hint) ---- */
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || // PK\x03\x04
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) // empty ZIP end-only
  ) {
    const zipKind = ZIP_EXT_KINDS[extensionOf(name)];
    return zipKind ?? "unknown";
  }

  /* ---- 3. text families ---- */
  if (looksLikeText(bytes)) {
    const head = new TextDecoder("utf-8", { fatal: false })
      .decode(bytes)
      .replace(/^\uFEFF/, "")
      .trimStart();
    const lower = head.slice(0, 256).toLowerCase();
    const isSvg =
      lower.startsWith("<svg") ||
      (lower.startsWith("<?xml") && head.toLowerCase().includes("<svg"));
    if (isSvg) return "svg";
    const isHtml =
      lower.startsWith("<!doctype html") || lower.startsWith("<html");
    if (isHtml) return "html";
    return "txt";
  }

  /* ---- 4. honest fallback ---- */
  return "unknown";
}
