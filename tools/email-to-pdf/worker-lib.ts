/**
 * PURE EML / MIME parser (P3-c, R57) — RFC 5322 message → structured email.
 *
 * Own implementation from the published specs (RFC 5322 Internet Message
 * Format, RFC 2045/2046/2047 MIME). ZERO third-party code — bentopdf is
 * AGPL, this file is a clean-room spec implementation.
 *
 * What it handles (all byte-level, charset-correct):
 *   - header block: folded (continuation) lines, `Key: value` split
 *   - RFC 2047 encoded words in headers (=?utf-8?B?…?= / ?Q?…?=), with
 *     the adjacent-word no-space rule
 *   - MIME bodies: Content-Type params (charset / boundary / name),
 *     Content-Transfer-Encoding 7bit/8bit/binary (identity),
 *     quoted-printable (soft breaks, =XX) and base64 (whitespace-tolerant)
 *   - multipart recursion: mixed / alternative (text/plain preferred —
 *     honest text fidelity over HTML approximation) / related / report /
 *     signed (first part) — any multipart/* is walked structurally
 *   - nested message/rfc822 parts listed as attachments
 *   - attachments: Content-Disposition filename, Content-Type name and
 *     RFC 2231 filename* (charset''percent-decoded); size = DECODED bytes
 *   - charsets: utf-8 family, us-ascii, iso-8859-1/windows-1252, utf-16le
 *
 * Honest refusal: EmlParseError("not-email") when the file has no
 * recognizable message headers — never a guessed render.
 *
 * Smoke: scripts/smoke-p3c-imports.ts (fixtures authored in-code).
 */

/* ─── types ──────────────────────────────────────────────────────────────── */

export interface EmailAttachment {
  filename: string;
  /** Decoded byte length. */
  size: number;
  mime: string;
}

export interface EmailDoc {
  subject: string;
  from: string;
  to: string;
  cc: string;
  /** Raw Date header value (rendered as-is — zero timezone ambiguity). */
  date: string;
  body: string;
  /** True when the only body available was text/html (approximated). */
  bodyWasHtml: boolean;
  attachments: EmailAttachment[];
}

export class EmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmlParseError";
  }
}

/* ─── byte helpers ───────────────────────────────────────────────────────── */

const DECODER_UTF8 = new TextDecoder("utf-8");

function findBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i + needle.length <= hay.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Split a MIME entity into its header text and body bytes. */
function splitEntity(
  bytes: Uint8Array,
): { headerText: string; body: Uint8Array } {
  // try CRLFCRLF, LFLF, CRCR — first match wins
  const marks: number[][] = [
    [0x0d, 0x0a, 0x0d, 0x0a],
    [0x0a, 0x0a],
    [0x0d, 0x0d],
  ];
  let cut = -1;
  let headerLen = 0;
  for (const mark of marks) {
    cut = findBytes(bytes, Uint8Array.from(mark), 0);
    if (cut >= 0) {
      headerLen = mark.length;
      break;
    }
  }
  if (cut < 0) {
    return { headerText: DECODER_UTF8.decode(bytes), body: new Uint8Array(0) };
  }
  const headerText = DECODER_UTF8.decode(bytes.subarray(0, cut));
  const body = bytes.subarray(cut + headerLen);
  return { headerText, body };
}

/* ─── headers ────────────────────────────────────────────────────────────── */

export interface HeaderPair {
  key: string;
  value: string;
}

/** Unfold + parse a header block; values still RFC 2047-encoded. */
export function parseHeaderBlock(text: string): HeaderPair[] {
  const out: HeaderPair[] = [];
  let current: HeaderPair | null = null;
  for (const line of text.split("\n")) {
    const clean = line.replace(/\r$/, "");
    if (clean === "") continue;
    if ((clean.startsWith(" ") || clean.startsWith("\t")) && current) {
      current.value += ` ${clean.trim()}`;
      continue;
    }
    const colon = clean.indexOf(":");
    if (colon <= 0) continue; // not a header line (e.g. "From " mbox line)
    current = {
      key: clean.slice(0, colon).trim().toLowerCase(),
      value: clean.slice(colon + 1).trim(),
    };
    out.push(current);
  }
  return out;
}

function headerValue(headers: HeaderPair[], key: string): string {
  const hit = headers.find((h) => h.key === key);
  return hit ? hit.value : "";
}

/* ─── RFC 2047 encoded words ─────────────────────────────────────────────── */

const CHARSET_ALIASES: Record<string, string> = {
  "utf-8": "utf-8",
  utf8: "utf-8",
  "us-ascii": "utf-8",
  ascii: "utf-8",
  "iso-8859-1": "windows-1252",
  latin1: "windows-1252",
  "windows-1252": "windows-1252",
  cp1252: "windows-1252",
  "utf-16le": "utf-16le",
  "utf-16": "utf-16le",
};

function decodeCharset(bytes: Uint8Array, charset: string): string {
  const label = CHARSET_ALIASES[charset.toLowerCase().trim()];
  if (!label) {
    // Unknown charset — utf-8 with replacement is the honest fallback.
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return DECODER_UTF8.decode(bytes);
  }
}

function decodeBase64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** RFC 2047 Q encoding: `_` = space, `=XX` hex; anything else literal. */
function decodeQWord(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === "_") {
      out += " ";
    } else if (c === "=" && i + 2 < text.length + 1 && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      out += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out += c;
    }
  }
  return out;
}

/** Decode all encoded words in a header value (adjacent words join). */
export function decodeRfc2047(value: string): string {
  if (!value.includes("=?")) return value;
  // adjacent encoded words: whitespace BETWEEN them is ignored
  let text = value.replace(/\?=\s+=\?/g, "?==?");
  for (;;) {
    const m = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/.exec(text);
    if (!m) break;
    let piece: string;
    if (m[2]!.toLowerCase() === "b") {
      piece = decodeCharset(decodeBase64ToBytes(m[3]!), m[1]!);
    } else {
      piece = decodeCharset(asciiBytes(decodeQWord(m[3]!)), m[1]!);
    }
    text = text.slice(0, m.index) + piece + text.slice(m.index + m[0].length);
  }
  return text;
}

/* ─── transfer encodings (byte level) ────────────────────────────────────── */

export function decodeQuotedPrintable(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  const isHex = (b: number): boolean =>
    (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i]!;
    if (b === 0x3d) {
      // soft break: =\r\n or =\n (also tolerate =\r)
      if (bytes[i + 1] === 0x0d && bytes[i + 2] === 0x0a) {
        i += 2;
        continue;
      }
      if (bytes[i + 1] === 0x0a || bytes[i + 1] === 0x0d) {
        i += 1;
        continue;
      }
      if (isHex(bytes[i + 1] ?? -1) && isHex(bytes[i + 2] ?? -1)) {
        const hex = String.fromCharCode(bytes[i + 1]!, bytes[i + 2]!);
        out[n++] = parseInt(hex, 16);
        i += 2;
        continue;
      }
      // broken encoder — literal '='
      out[n++] = b;
    } else {
      out[n++] = b;
    }
  }
  return out.subarray(0, n);
}

/* ─── content-type parsing ───────────────────────────────────────────────── */

export interface ParsedContentType {
  mime: string;
  params: Record<string, string>;
}

export function parseContentType(value: string): ParsedContentType {
  const semi = value.indexOf(";");
  if (semi < 0) return { mime: value.trim().toLowerCase(), params: {} };
  const mime = value.slice(0, semi).trim().toLowerCase();
  const params: Record<string, string> = {};
  const rest = value.slice(semi + 1);
  // split on ';' not inside quoted strings
  const parts: string[] = [];
  let depth = false;
  let cur = "";
  for (const ch of rest) {
    if (ch === '"') depth = !depth;
    if (ch === ";" && !depth) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1);
    }
    params[key] = val;
  }
  return { mime, params };
}

/* ─── filename extraction (CD filename / CT name / RFC 2231) ─────────────── */

export function attachmentFilename(
  disposition: string,
  ctParams: Record<string, string>,
): string {
  // filename* (RFC 2231 ext-value): charset'lang'percent-encoded
  const star =
    paramValue(disposition, "filename*") || ctParams["name*"] || "";
  if (star) {
    const m = /^([^']*)'[^']*'(.*)$/.exec(star);
    if (m) {
      const charset = m[1]!;
      const encoded = m[2]!;
      const bytes = new Uint8Array(encoded.length);
      let n = 0;
      for (let i = 0; i < encoded.length; ) {
        if (
          encoded[i] === "%" &&
          /^[0-9a-fA-F]{2}$/.test(encoded.slice(i + 1, i + 3))
        ) {
          bytes[n++] = parseInt(encoded.slice(i + 1, i + 3), 16);
          i += 3;
        } else {
          bytes[n++] = encoded.charCodeAt(i) & 0xff;
          i += 1;
        }
      }
      return decodeCharset(bytes.subarray(0, n), charset || "utf-8");
    }
  }
  return paramValue(disposition, "filename") || ctParams["name"] || "";
}

/** Value of `key=` in a Content-Disposition header value. */
function paramValue(disposition: string, key: string): string {
  if (!disposition) return "";
  const lower = disposition.toLowerCase();
  const needle = `${key.toLowerCase()}=`;
  const idx = lower.indexOf(needle);
  if (idx < 0) return "";
  let val = disposition.slice(idx + needle.length).trim();
  if (val.startsWith('"')) {
    const end = val.indexOf('"', 1);
    if (end > 0) val = val.slice(1, end);
  } else {
    const semi = val.indexOf(";");
    if (semi >= 0) val = val.slice(0, semi);
  }
  return val.trim();
}

/* ─── MIME walk ──────────────────────────────────────────────────────────── */

interface MimePart {
  headers: HeaderPair[];
  body: Uint8Array;
}

function splitMultipart(body: Uint8Array, boundary: string): MimePart[] {
  const parts: MimePart[] = [];
  const dashBoundary = asciiBytes(`--${boundary}`);
  let pos = findBytes(body, dashBoundary, 0);
  if (pos < 0) return parts;
  for (;;) {
    // pos at "--boundary"; check terminator or transport padding + CRLF
    let after = pos + dashBoundary.length;
    // terminal "--"?
    if (body[after] === 0x2d && body[after + 1] === 0x2d) break;
    // skip to end of line
    while (after < body.length && body[after] !== 0x0a) after += 1;
    if (after < body.length) after += 1; // consume LF
    const next = findBytes(body, dashBoundary, after);
    const end = next < 0 ? body.length : next;
    // part bytes: [after, end) minus the trailing CRLF before the boundary
    let stop = end;
    if (stop > after && body[stop - 1] === 0x0a) stop -= 1;
    if (stop > after && body[stop - 1] === 0x0d) stop -= 1;
    const chunk = body.subarray(after, Math.max(stop, after));
    const entity = splitEntity(chunk);
    parts.push({ headers: parseHeaderBlock(entity.headerText), body: entity.body });
    if (next < 0) break;
    pos = next;
  }
  return parts;
}

interface WalkedPart {
  mime: string;
  charset: string;
  cte: string;
  disposition: string;
  filename: string;
  decoded: Uint8Array;
}

function walkPart(part: MimePart, out: WalkedPart[]): void {
  const ct = parseContentType(headerValue(part.headers, "content-type") || "text/plain; charset=us-ascii");
  const cte = (headerValue(part.headers, "content-transfer-encoding") || "7bit").toLowerCase();
  const disposition = headerValue(part.headers, "content-disposition");

  if (ct.mime.startsWith("multipart/")) {
    const boundary = ct.params["boundary"] ?? "";
    if (boundary) {
      for (const child of splitMultipart(part.body, boundary)) {
        walkPart(child, out);
      }
      return;
    }
    // boundary-less multipart: fall through, treat as opaque
  }

  let decoded: Uint8Array;
  if (cte === "base64") {
    decoded = decodeBase64ToBytes(DECODER_UTF8.decode(part.body));
  } else if (cte === "quoted-printable") {
    decoded = decodeQuotedPrintable(part.body);
  } else {
    // 7bit / 8bit / binary / unknown → identity
    decoded = part.body;
  }

  out.push({
    mime: ct.mime,
    charset: ct.params["charset"] || "utf-8",
    cte,
    disposition,
    filename: attachmentFilename(disposition, ct.params),
    decoded,
  });
}

/* ─── HTML → plain text (fallback body) ──────────────────────────────────── */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "'",
  rsquo: "'",
  ldquo: "\u201c",
  rdquo: "\u201d",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  euro: "€",
  pound: "£",
  // common accented Latin-1 letters (email HTML favours entities over UTF-8)
  aacute: "á",
  agrave: "à",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  ccedil: "ç",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  euml: "ë",
  iacute: "í",
  igrave: "ì",
  icirc: "î",
  iuml: "ï",
  ntilde: "ñ",
  oacute: "ó",
  ograve: "ò",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  uacute: "ú",
  ugrave: "ù",
  uuml: "ü",
  yacute: "ý",
  szlig: "ß",
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isFinite(cp) ? safeFromCp(cp) : whole;
    }
    if (body.startsWith("#")) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? safeFromCp(cp) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

function safeFromCp(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "\uFFFD";
  }
}

export function htmlToPlainText(html: string): string {
  let text = html;
  // kill non-rendered blocks
  text = text.replace(/<script[\s\S]*?<\/script\s*>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style\s*>/gi, "");
  text = text.replace(/<head[\s\S]*?<\/head\s*>/gi, "");
  // line-ish tags
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|tr|blockquote|h[1-6])\s*>/gi, "\n\n");
  text = text.replace(/<\/(td|th)\s*>/gi, "\t");
  text = text.replace(/<li[^>]*>/gi, "• ");
  text = text.replace(/<\/li\s*>/gi, "\n");
  // strip remaining tags
  text = text.replace(/<[^>]+>/g, "");
  text = decodeHtmlEntities(text);
  // normalize
  text = text.replace(/\r\n?/g, "\n");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/* ─── the parser ─────────────────────────────────────────────────────────── */

export function parseEml(bytes: Uint8Array): EmailDoc {
  const { headerText, body } = splitEntity(bytes);
  const headers = parseHeaderBlock(headerText);

  const looksEmail = ["from", "date", "message-id", "received", "subject", "to", "mime-version", "return-path", "delivered-to"].some(
    (key) => headerValue(headers, key) !== "",
  );
  if (headers.length === 0 || !looksEmail) {
    throw new EmlParseError("no recognizable email headers");
  }

  const walked: WalkedPart[] = [];
  walkPart({ headers, body }, walked);

  // Body pick: LAST text/plain without an attachment disposition; else
  // text/html (approximated); else empty. message/rfc822 never a body.
  let bodyText = "";
  let bodyWasHtml = false;
  for (const part of walked) {
    const isAttachment =
      part.disposition.toLowerCase().startsWith("attachment") ||
      (part.filename !== "" && !part.mime.startsWith("text/"));
    if (isAttachment) continue;
    if (part.mime === "text/plain") {
      const candidate = decodeCharset(part.decoded, part.charset);
      if (candidate.trim() !== "") {
        bodyText = candidate;
        bodyWasHtml = false;
      }
    }
  }
  if (bodyText === "") {
    for (const part of walked) {
      if (part.mime === "text/html" && !part.disposition.toLowerCase().startsWith("attachment")) {
        const candidate = htmlToPlainText(decodeCharset(part.decoded, part.charset));
        if (candidate.trim() !== "") {
          bodyText = candidate;
          bodyWasHtml = true;
        }
      }
    }
  }

  // Attachments: every named part (or explicit disposition), in walk order.
  const attachments: EmailAttachment[] = [];
  for (const part of walked) {
    const isAttachment =
      part.disposition.toLowerCase().startsWith("attachment") ||
      (part.filename !== "" && !part.mime.startsWith("text/"));
    if (!isAttachment) continue;
    if (part.filename === "" && part.mime === "message/rfc822") {
      attachments.push({ filename: "message.eml", size: part.decoded.byteLength, mime: part.mime });
      continue;
    }
    if (part.filename === "") continue; // unnamed junk — skip honestly
    attachments.push({
      filename: part.filename,
      size: part.decoded.byteLength,
      mime: part.mime,
    });
  }

  return {
    subject: decodeRfc2047(headerValue(headers, "subject")),
    from: decodeRfc2047(headerValue(headers, "from")),
    to: decodeRfc2047(headerValue(headers, "to")),
    cc: decodeRfc2047(headerValue(headers, "cc")),
    date: headerValue(headers, "date"),
    body: bodyText,
    bodyWasHtml,
    attachments,
  };
}
