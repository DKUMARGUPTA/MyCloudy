/**
 * Generate QR code engine (PRD §7.7 / §8.7) — 100% PURE, no platform APIs.
 *
 * Owns everything that can be decided without the DOM:
 * payload builders for the eight QR kinds (URL, text, WiFi, UPI, vCard,
 * email, phone, WhatsApp), their validators, color + contrast math, the
 * style clamps and the batch-CSV row parser (reusing the create-card
 * RFC-4180 parser — the one pure cross-tool import). The renderer (the
 * `qrcode` package) and the DOM live in the surface; bun smoke tests
 * (scripts/smoke-qr.ts) run against THIS file.
 *
 * Nothing here touches storage, the network or the DOM.
 */

import {
  MAX_CSV_ROWS,
  parseCsv,
  CsvError,
} from "../create-card/model";

/* ------------------------------------------------------------------ */
/* Kinds + shared types                                                */
/* ------------------------------------------------------------------ */

export const QR_KINDS = [
  "url",
  "text",
  "wifi",
  "upi",
  "vcard",
  "email",
  "phone",
  "whatsapp",
] as const;

export type QrKind = (typeof QR_KINDS)[number];

/** Error-correction levels (ISO/IEC 18004) — % is the recoverable damage. */
export const EC_LEVELS = ["L", "M", "Q", "H"] as const;
export type EcLevel = (typeof EC_LEVELS)[number];

export const EC_INFO: Record<EcLevel, { recover: string }> = {
  L: { recover: "≈7%" },
  M: { recover: "≈15%" },
  Q: { recover: "≈25%" },
  H: { recover: "≈30%" },
};

export const WIFI_ENCRYPTIONS = ["WPA", "WEP", "nopass"] as const;
export type WifiEncryption = (typeof WIFI_ENCRYPTIONS)[number];

export interface WifiInput {
  ssid: string;
  password: string;
  encryption: WifiEncryption;
  hidden: boolean;
}

export interface UpiInput {
  /** Payee address, e.g. name@bank. */
  pa: string;
  /** Payee name. */
  pn: string;
  /** Amount in rupees (optional, 2 decimals max). */
  am: string;
  /** Transaction note. */
  tn: string;
}

export interface VcardInput {
  first: string;
  last: string;
  org: string;
  phone: string;
  email: string;
  url: string;
  address: string;
  note: string;
}

export interface EmailInput {
  address: string;
  subject: string;
  body: string;
}

export interface WhatsappInput {
  phone: string;
  message: string;
}

/* ------------------------------------------------------------------ */
/* Style clamps                                                        */
/* ------------------------------------------------------------------ */

export const QR_SIZES = [256, 512, 1024] as const;
export type QrSize = (typeof QR_SIZES)[number];
export const DEFAULT_SIZE: QrSize = 512;

export const MIN_MARGIN = 1;
export const MAX_MARGIN = 8;
export const DEFAULT_MARGIN = 4;

export function clampMargin(margin: number): number {
  if (!Number.isFinite(margin)) return DEFAULT_MARGIN;
  return Math.min(MAX_MARGIN, Math.max(MIN_MARGIN, Math.round(margin)));
}

export function isEcLevel(value: string): value is EcLevel {
  return (EC_LEVELS as readonly string[]).includes(value);
}

/** With a center logo the code loses modules — H is forced by the surface. */
export function ecFor(hasLogo: boolean, chosen: EcLevel): EcLevel {
  if (!hasLogo) return chosen;
  return "H";
}

/* ------------------------------------------------------------------ */
/* Payload builders                                                    */
/* ------------------------------------------------------------------ */

/**
 * Normalizes a user-typed URL: trims, and prepends https:// when the
 * scheme is missing ("example.com/path" → "https://example.com/path").
 * Returns null when the result still has spaces or no host.
 */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let candidate = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname || /\s/.test(candidate)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Free text — non-empty, capped at a QR-realistic 1500 characters. */
export const MAX_TEXT_LENGTH = 1500;

export function buildTextPayload(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT_LENGTH) return null;
  return trimmed;
}

/**
 * WIFI:... payload per the widely-implemented MECARD-style convention.
 * Backslash, semicolon, comma, quote and colon are backslash-escaped in
 * both SSID and password. `nopass` drops the P: field entirely.
 */
export function buildWifiPayload(input: WifiInput): string | null {
  const ssid = input.ssid.trim();
  if (ssid.length === 0) return null;
  const esc = (value: string): string =>
    value.replace(/([\\;,":])/g, "\\$1");
  const parts: string[] = [];
  if (input.encryption !== "nopass") {
    if (input.password.length === 0) return null;
    parts.push(`T:${input.encryption}`);
    parts.push(`P:${esc(input.password)}`);
  }
  parts.push(`S:${esc(ssid)}`);
  if (input.hidden) parts.push("H:true");
  return `WIFI:${parts.join(";")};;`;
}

/** UPI VPA — loose but honest: word chars/dots/hyphens @ letters. */
const UPI_PA_RE = /^[\w.\-]{2,}@[a-zA-Z]{2,}$/;

/** Amount: positive number with at most 2 decimals. */
export function isValidUpiAmount(raw: string): boolean {
  if (raw.trim().length === 0) return true; // optional
  return /^\d{1,7}(\.\d{1,2})?$/.test(raw.trim());
}

export function isValidUpiPa(raw: string): boolean {
  return UPI_PA_RE.test(raw.trim());
}

/**
 * upi://pay?pa=…&pn=…&am=…&cu=INR&tn=… — the standard deep link every UPI
 * app in India registers. Amount and note are optional; currency is fixed
 * to INR by the spec.
 */
export function buildUpiPayload(input: UpiInput): string | null {
  const pa = input.pa.trim();
  if (!UPI_PA_RE.test(pa)) return null;
  const params = new URLSearchParams();
  params.set("pa", pa);
  const pn = input.pn.trim();
  if (pn.length > 0) params.set("pn", pn);
  const am = input.am.trim();
  if (am.length > 0) {
    if (!isValidUpiAmount(am)) return null;
    params.set("am", am);
    params.set("cu", "INR");
  }
  const tn = input.tn.trim();
  if (tn.length > 0) params.set("tn", tn);
  return `upi://pay?${params.toString()}`;
}

/** vCard 3.0 — at least a first or last name required. */
export function buildVcardPayload(input: VcardInput): string | null {
  const first = input.first.trim();
  const last = input.last.trim();
  if (first.length === 0 && last.length === 0) return null;
  const fn = [first, last].filter((part) => part.length > 0).join(" ");
  const lines: string[] = ["BEGIN:VCARD", "VERSION:3.0", `N:${last};${first};;;`, `FN:${fn}`];
  const org = input.org.trim();
  if (org.length > 0) lines.push(`ORG:${org}`);
  const phone = cleanPhone(input.phone);
  if (phone !== null) lines.push(`TEL;TYPE=CELL:${phone}`);
  const email = input.email.trim();
  if (isPlausibleEmail(email)) lines.push(`EMAIL:${email}`);
  const url = input.url.trim();
  if (url.length > 0) lines.push(`URL:${url}`);
  const address = input.address.trim();
  if (address.length > 0) lines.push(`ADR;TYPE=HOME:;;${address};;;;`);
  const note = input.note.trim();
  if (note.length > 0) lines.push(`NOTE:${note.replace(/\r?\n/g, "\\n")}`);
  lines.push("END:VCARD");
  return lines.join("\n");
}

/** mailto:…?subject=…&body=… */
export function buildEmailPayload(input: EmailInput): string | null {
  const address = input.address.trim();
  if (!isPlausibleEmail(address)) return null;
  const params = new URLSearchParams();
  const subject = input.subject.trim();
  const body = input.body;
  if (subject.length > 0) params.set("subject", subject);
  if (body.trim().length > 0) params.set("body", body);
  const query = params.toString();
  return `mailto:${address}${query.length > 0 ? `?${query}` : ""}`;
}

/** tel:+digits — at least 7 digits survive the cleanup. */
export function cleanPhone(raw: string): string | null {
  const plus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return `${plus ? "+" : ""}${digits}`;
}

export function buildPhonePayload(raw: string): string | null {
  const phone = cleanPhone(raw);
  return phone === null ? null : `tel:${phone}`;
}

/** wa.me link: digits WITH country code, optional pre-filled message. */
export function buildWhatsappPayload(input: WhatsappInput): string | null {
  const digits = input.phone.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  const params = new URLSearchParams();
  const message = input.message.trim();
  if (message.length > 0) params.set("text", message);
  const query = params.toString();
  return `https://wa.me/${digits}${query.length > 0 ? `?${query}` : ""}`;
}

/* ------------------------------------------------------------------ */
/* Email sanity (no RFC 5321 heroics — honest, practical)              */
/* ------------------------------------------------------------------ */

export function isPlausibleEmail(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0 || value.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

/* ------------------------------------------------------------------ */
/* Colors + contrast                                                   */
/* ------------------------------------------------------------------ */

/** #rgb / #rrggbb → #rrggbb, else null. Case-insensitive. */
export function normalizeQrColor(raw: string): string | null {
  const value = raw.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    const [r, g, b] = [value[1], value[2], value[3]].map((c) => c + c);
    return `#${r}${g}${b}`.toLowerCase();
  }
  return null;
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio 1..21 — scanners need ≈3+ to read reliably. */
export function contrastRatio(fg: string, bg: string): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export const MIN_SCAN_CONTRAST = 3;

/* ------------------------------------------------------------------ */
/* File names                                                          */
/* ------------------------------------------------------------------ */

export function qrFileName(kind: QrKind, extension: "png" | "svg" | "pdf"): string {
  return `qr-${kind}.${extension}`;
}

/* ------------------------------------------------------------------ */
/* Batch mode: one QR per CSV row                                       */
/* ------------------------------------------------------------------ */

/** One parsed CSV data row: content (col 1) + optional label (col 2). */
export interface QrCsvRow {
  /** QR content / URL — first column, trimmed, 1..MAX_TEXT_LENGTH chars. */
  content: string;
  /** Optional file-name label — second column, trimmed. */
  label: string;
}

export interface QrCsvParse {
  rows: QrCsvRow[];
  /** Rows dropped honestly: blank first column or over MAX_TEXT_LENGTH. */
  skipped: number;
}

/**
 * Parse a CSV into QR rows — reuses the create-card RFC-4180 parser
 * (quoted fields, CRLF/LF/CR, BOM, 2 MB cap, unterminated-quote error)
 * but treats EVERY record as data: this format has no header row.
 * Throws the create-card CsvError (card.errorCsv* i18n keys — the
 * cross-namespace reuse pattern) for a broken quote, >200 rows or an
 * oversized file.
 */
export function parseQrCsv(text: string): QrCsvParse {
  const { columns, rows } = parseCsv(text);
  const records = [columns, ...rows];
  if (records.length > MAX_CSV_ROWS) {
    throw new CsvError("card.errorCsvRows");
  }
  const out: QrCsvRow[] = [];
  let skipped = 0;
  for (const record of records) {
    const content = (record[0] ?? "").trim();
    if (content === "" || content.length > MAX_TEXT_LENGTH) {
      skipped += 1;
      continue;
    }
    out.push({ content, label: (record[1] ?? "").trim() });
  }
  return { rows: out, skipped };
}

/** Strip characters a file name cannot carry (keeps spaces readable). */
const FILE_NAME_STRIP = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * ZIP entry base name for one CSV row: the label when present (cleaned,
 * capped at 100 chars), else the row number — "qr-1", "qr-2", … Name
 * collisions are resolved by the shared ZIP bundler (-2, -3, …).
 */
export function qrCsvBaseName(label: string, index: number): string {
  const clean = label.replace(FILE_NAME_STRIP, "").replace(/\s+/g, " ").trim();
  return clean !== "" ? clean.slice(0, 100) : `qr-${index + 1}`;
}
