/**
 * Attachment MIME sniffing (P3-d) — PURE, dependency-free. Magic-byte
 * detection first (the file's REAL type, whatever the extension
 * claims), extension map as the fallback, application/octet-stream
 * as the honest default.
 *
 * The result lands in the EmbeddedFile stream's /Subtype — the key
 * PDF readers use to pick the right handler for an extracted file.
 */

/** ASCII lowercase byte helper. */
function eq(b: Uint8Array, offset: number, s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    if (b[offset + i] !== s.charCodeAt(i)) return false;
  }
  return true;
}

/** Sniffs the MIME type from magic bytes; null when unrecognized. */
function sniffMagic(b: Uint8Array): string | null {
  if (b.length >= 5 && eq(b, 0, "%PDF-")) return "application/pdf";
  if (b.length >= 8 && eq(b, 0, "\x89PNG\r\n\x1a\n")) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (b.length >= 6 && (eq(b, 0, "GIF87a") || eq(b, 0, "GIF89a"))) {
    return "image/gif";
  }
  if (b.length >= 12 && eq(b, 0, "RIFF") && eq(b, 8, "WEBP")) {
    return "image/webp";
  }
  if (b.length >= 2 && eq(b, 0, "BM")) return "image/bmp";
  if (b.length >= 12 && eq(b, 0, "RIFF") && eq(b, 8, "AVI ")) return "video/x-msvideo";
  if (b.length >= 12 && eq(b, 0, "RIFF") && eq(b, 8, "WAVE")) return "audio/wav";
  if (b.length >= 12 && eq(b, 4, "ftyp")) {
    if (eq(b, 8, "avif") || eq(b, 8, "avis")) return "image/avif";
    if (eq(b, 8, "heic") || eq(b, 8, "heix") || eq(b, 8, "hevc") || eq(b, 8, "heim")) {
      return "image/heic";
    }
    return "video/mp4";
  }
  if (b.length >= 10 && (eq(b, 0, "ID3") || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0))) {
    return "audio/mpeg";
  }
  if (b.length >= 4 && eq(b, 0, "OggS")) return "application/ogg";
  if (b.length >= 4 && eq(b, 0, "fLaC")) return "audio/flac";
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return "application/gzip";
  if (b.length >= 4 && eq(b, 0, "PK\x03\x04")) return sniffZip(b);
  if (b.length >= 4 && eq(b, 0, "Rar!")) return "application/vnd.rar";
  if (b.length >= 4 && eq(b, 0, "7z\xbc\xaf")) return "application/x-7z-compressed";

  // Text-ish: skip a UTF BOM / leading whitespace, then classify.
  const text = leadingAscii(b, 512);
  if (text !== null) {
    const t = text.trimStart();
    if (t.startsWith("<?xml")) return sniffXml(b);
    if (t.startsWith("{") || t.startsWith("[")) return "application/json";
    if (/^<!doctype html/i.test(t) || /^<html[\s>]/i.test(t)) return "text/html";
    if (t.startsWith("%!PS")) return "application/postscript";
    return "text/plain";
  }
  return null;
}

/** Reads leading printable ASCII (null when the head is binary). */
function leadingAscii(b: Uint8Array, limit: number): string | null {
  let start = 0;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) start = 3;
  else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return null; // UTF-16LE — treat below
  let printable = 0;
  let sawNul = false;
  for (let i = start; i < Math.min(b.length, limit); i += 1) {
    const c = b[i]!;
    if (c === 0) {
      sawNul = true;
      break;
    }
    if (c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c <= 0x7e)) {
      printable += 1;
    } else {
      return null; // high/control byte — binary
    }
  }
  if (sawNul && printable === 0) return null;
  if (printable === 0) return null;
  let out = "";
  for (let i = start; i < Math.min(b.length, limit); i += 1) {
    out += String.fromCharCode(b[i]!);
  }
  return out;
}

/** XML root-element sniffing (SVG vs generic XML). */
function sniffXml(b: Uint8Array): string {
  // Look past the <?xml ...?> declaration for the root element.
  const limit = Math.min(b.length, 2048);
  let i = 0;
  let s = "";
  for (; i < limit; i += 1) s += String.fromCharCode(b[i]!);
  const root = /<([a-zA-Z:.-]+)/.exec(s.slice(s.indexOf("?>") + 2));
  if (root !== null && root[1]!.toLowerCase() === "svg") return "image/svg+xml";
  return "application/xml";
}

/** ZIP-container sniffing: OOXML / ODF / EPUB / CBZ / plain zip. */
function sniffZip(b: Uint8Array): string {
  const limit = Math.min(b.length, 4096);
  let s = "";
  for (let i = 0; i < limit; i += 1) s += String.fromCharCode(b[i]!);
  // OOXML parts live in distinct subfolders.
  if (s.includes("word/")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (s.includes("xl/")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (s.includes("ppt/")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  // ODF + EPUB declare themselves in a stored "mimetype" entry first.
  const mime = /mimetype([a-zA-Z0-9+.-]+\/[a-zA-Z0-9+.-]+)/.exec(s);
  if (mime !== null) {
    if (mime[1] === "application/epub+zip") return "application/epub+zip";
    if (mime[1].startsWith("application/vnd.oasis.opendocument")) return mime[1];
  }
  if (s.includes(".cbz") || s.includes("ComicInfo")) return "application/vnd.comicbook+zip";
  return "application/zip";
}

/** Common extension → MIME (the honest fallback when bytes say nothing). */
const EXT_MAP: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/vnd.microsoft.icon",
  tiff: "image/tiff",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  zip: "application/zip",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  gz: "application/gzip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  eml: "message/rfc822",
  rtf: "application/rtf",
};

/**
 * The attachment MIME: magic bytes first, extension second, honest
 * octet-stream default. `sample` only needs the file's head — callers
 * may pass the full bytes (they already hold them).
 */
export function sniffAttachmentMime(name: string, sample: Uint8Array): string {
  const magic = sniffMagic(sample);
  if (magic !== null) return magic;
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) {
    const ext = name.slice(dot + 1).toLowerCase();
    const mapped = EXT_MAP[ext];
    if (mapped !== undefined) return mapped;
  }
  return "application/octet-stream";
}
