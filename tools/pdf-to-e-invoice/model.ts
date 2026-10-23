import type {
  Confidence,
  FieldHit,
  InvoiceLineItem,
  InvoiceSummary,
  PdfToEInvoiceRunOptions,
  TaxHit,
} from "./types";
import { FIELD_LABELS } from "./types";

/**
 * PDF → e-invoice model (RB5-c) — 100% PURE TypeScript: no DOM, no
 * pdf.js, no pdf-lib, no storage. Everything here runs inside the tool
 * worker (and headless in the smoke).
 *
 * Two honest paths:
 *
 *  A. summarizeCii — an already-parsed CII (Factur-X / ZUGFeRD /
 *     CrossIndustryInvoice) element tree is mapped onto invoice
 *     fields. Namespace-tolerant: producers use rsm:/ram:/udt:
 *     prefixes, no prefixes at all, or custom prefixes — every
 *     lookup matches on the LOCAL name only. Web Workers have no
 *     DOMParser, so the model carries its own tiny XML subset parser
 *     (parseXml) that covers exactly what CII files use: elements,
 *     attributes, text, self-closing tags, comments, declarations,
 *     DOCTYPE and CDATA, with entity decoding.
 *
 *  B. sniffInvoice — plain text LINES (the worker groups pdf.js text
 *     items with the pdf-to-markdown lessons: a whitespace-only item
 *     is EXACTLY ONE space; y-proximity half a font height; a real
 *     horizontal gap becomes a space) are run through conservative
 *     field sniffers: invoice number, dates (many formats), GSTIN
 *     (format + the official mod-36 checksum — deterministic), VAT id
 *     (labelled only, no fishing), currency (symbol → ISO map),
 *     totals (LAST match wins + largest-number sanity), tax lines and
 *     greedy line items. Every hit carries its confidence and the
 *     exact source snippet; everything not found lands in
 *     missingKeys — NOTHING is fabricated. Layout sniffing is
 *     best-effort by nature and the UI says so.
 */

/* ------------------------------------------------------------------ */
/* Honesty caps (the pdf-to-markdown spirit)                          */
/* ------------------------------------------------------------------ */

/** Pages Path B reads at most (attachments are document-level). */
export const MAX_PAGES = 20;
/** Characters of extracted text Path B looks at. */
export const MAX_CHARS = 120_000;
/** Lines kept per document (sniffers scan these). */
export const MAX_LINES = 4000;
/** Line items extracted at most. */
export const MAX_LINE_ITEMS = 40;
/** Source snippets are capped for display. */
export const SNIPPET_MAX = 160;
/** The XML parser refuses absurd inputs. */
export const XML_MAX_BYTES = 2_000_000;

/* ------------------------------------------------------------------ */
/* Text lines (the worker's extraction shape)                          */
/* ------------------------------------------------------------------ */

/** One raw pdf.js text item — deliberately loose so the same coercion
 * runs at the worker boundary and in headless tests. */
export interface PdfTextItemInput {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
}

/** One extracted layout line with its provenance. */
export interface TextLine {
  text: string;
  /** 1-based PDF page. */
  page: number;
  /** 0-based line index on that page. */
  index: number;
}

/** A sniffed value with its evidence. */
export interface SniffHit {
  value: string;
  snippet: string;
  span?: { page: number; line: number };
  confidence: Confidence;
}

const LINE_Y_TOL = 0.5;
const SPACE_GAP = 0.25;

function sanitizeRunText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 28 && code <= 32)) {
      out += " ";
    } else if (code < 32 || (code >= 127 && code <= 159)) {
      continue; // control noise — dropped
    } else {
      out += ch;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

interface Piece {
  text: string;
  x: number;
  y: number;
  w: number;
  size: number;
}

/**
 * Groups one document's pdf.js items into visual text lines (pure —
 * the worker feeds real extraction, the smoke synthetic items). The
 * pinned pdf-to-word lesson lives here too: a whitespace-only item
 * becomes EXACTLY ONE space, never two glued.
 */
export function linesFromItems(pages: readonly PdfTextItemInput[][]): TextLine[] {
  const out: TextLine[] = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const pieces: Piece[] = [];
    for (const item of pages[pageIndex] ?? []) {
      if (typeof item !== "object" || item === null) continue;
      const strRaw = typeof item.str === "string" ? item.str : "";
      if (strRaw.length === 0) continue;
      const transform = item.transform;
      if (!Array.isArray(transform) || transform.length < 6) continue;
      const x = Number(transform[4]);
      const y = Number(transform[5]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const size = Math.hypot(Number(transform[1]) || 0, Number(transform[3]) || 0);
      const w = Number(item.width) || 0;
      const text = sanitizeRunText(strRaw);
      // Raw leading/trailing whitespace is restored as a single space
      // each; a whitespace-only item is exactly ONE space.
      const glued =
        text.length > 0
          ? (/^\s/.test(strRaw) ? " " : "") +
            text +
            (/\s$/.test(strRaw) ? " " : "")
          : " ";
      pieces.push({ text: glued, x, y, w, size: size > 0 ? size : 10 });
    }
    if (pieces.length === 0) continue;

    const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);
    const groups: Piece[][] = [];
    let current: Piece[] = [sorted[0] as Piece];
    let groupY = (sorted[0] as Piece).y;
    let groupTol = Math.max(1.5, (sorted[0] as Piece).size * LINE_Y_TOL);
    for (let i = 1; i < sorted.length; i += 1) {
      const piece = sorted[i] as Piece;
      if (Math.abs(piece.y - groupY) <= groupTol) {
        current.push(piece);
      } else {
        groups.push(current);
        current = [piece];
        groupY = piece.y;
        groupTol = Math.max(1.5, piece.size * LINE_Y_TOL);
      }
    }
    groups.push(current);

    let index = 0;
    for (const group of groups) {
      const ordered = [...group].sort((a, b) => a.x - b.x);
      const size = ordered[0]?.size ?? 10;
      let text = "";
      let endX: number | null = null;
      for (const piece of ordered) {
        if (
          endX !== null &&
          text.length > 0 &&
          !text.endsWith(" ") &&
          piece.x - endX > size * SPACE_GAP
        ) {
          text += " "; // pdf.js items carry no spaces — a real gap becomes one
        }
        text += piece.text;
        endX = Math.max(endX ?? 0, piece.x + piece.w);
      }
      const line = text.replace(/\s+/g, " ").trim();
      if (line.length === 0) continue;
      out.push({ text: line, page: pageIndex + 1, index });
      index += 1;
      if (out.length >= MAX_LINES) return out;
    }
  }
  return out;
}

/** Clips a source line to the display cap. */
function clipSnippet(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > SNIPPET_MAX ? `${t.slice(0, SNIPPET_MAX - 1)}…` : t;
}

/* ------------------------------------------------------------------ */
/* Confidence                                                          */
/* ------------------------------------------------------------------ */

/**
 * Grades a matched snippet. "strong" needs a real separator in the
 * evidence (a #: . label join); "labeled" is a named pattern;
 * "loose" is bare free text — that never upgrades past low.
 */
export function confidenceOf(
  snippet: string,
  pattern: "strong" | "labeled" | "loose"
): Confidence {
  if (pattern === "loose") return "low";
  const hasSep = /[:#]|\bno\.?\b|\bnum\b|नं\.?/i.test(snippet);
  if (pattern === "strong") return hasSep ? "high" : "medium";
  return hasSep ? "medium" : "low";
}

/* ------------------------------------------------------------------ */
/* GSTIN — format + the official mod-36 checksum                        */
/* ------------------------------------------------------------------ */

const AL36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** 15 chars: 2-digit state code, 10-char PAN, entity code, "Z", checksum. */
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** The check character for the first 14 chars (null when non-base-36). */
export function gstinChecksum(first14: string): string | null {
  if (first14.length !== 14) return null;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const v = AL36.indexOf(first14[i] ?? "");
    if (v < 0) return null;
    const weighted = v * (i % 2 === 1 ? 2 : 1);
    sum += Math.floor(weighted / 36) + (weighted % 36);
  }
  return AL36[(36 - (sum % 36)) % 36] ?? null;
}

/** Full GSTIN validation: format vectors + the deterministic checksum. */
export function gstinValidate(g: string): {
  ok: boolean;
  reason: "ok" | "length" | "format" | "checksum";
} {
  if (g.length !== 15) return { ok: false, reason: "length" };
  if (!GSTIN_RE.test(g)) return { ok: false, reason: "format" };
  const check = gstinChecksum(g.slice(0, 14));
  if (check === null || check !== g[14]) {
    return { ok: false, reason: "checksum" };
  }
  return { ok: true, reason: "ok" };
}

/** GSTIN-shaped token in text (format-level; the caller validates). */
const GSTIN_TOKEN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/g;

export interface GstinSniff {
  seller: SniffHit | null;
  buyer: SniffHit | null;
}

/**
 * Finds GSTINs in order and assigns the first to the seller, a second
 * DISTINCT one to the buyer — the common Indian invoice layout puts
 * the issuer's GSTIN first. A checksum-passing GSTIN is "high"
 * confidence (the checksum is deterministic); a format-valid but
 * checksum-failing one is still reported (that is what the document
 * says) at "low".
 */
export function gstinSniff(lines: readonly TextLine[]): GstinSniff {
  const hits: SniffHit[] = [];
  for (const line of lines) {
    GSTIN_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = GSTIN_TOKEN_RE.exec(line.text)) !== null) {
      const token = m[1] as string;
      hits.push({
        value: token,
        snippet: clipSnippet(line.text),
        span: { page: line.page, line: line.index },
        confidence: gstinValidate(token).ok ? "high" : "low",
      });
      if (hits.length >= 4) break;
    }
    if (hits.length >= 4) break;
  }
  if (hits.length === 0) return { seller: null, buyer: null };
  const second = hits.find((h, i) => i > 0 && h.value !== (hits[0] as SniffHit).value);
  return { seller: hits[0] as SniffHit, buyer: second ?? null };
}

/* ------------------------------------------------------------------ */
/* VAT id (EU) — labelled only, no fishing                             */
/* ------------------------------------------------------------------ */

const VAT_LABEL_RE = /\b(?:vat|ust\.?|uid|mwst|btw|tva|iva|alv|pdv)\b/i;
const VAT_VALUE_RE = /\b([A-Z]{2}[A-Z0-9 +.\-]{5,14})\b/g;

export function vatSniff(lines: readonly TextLine[]): SniffHit | null {
  for (const line of lines) {
    if (!VAT_LABEL_RE.test(line.text)) continue;
    VAT_VALUE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = VAT_VALUE_RE.exec(line.text)) !== null) {
      const token = (m[1] as string).trim();
      // Country code + 8-12 identifier chars — the rough EU shape.
      if (/^[A-Z]{2}[A-Z0-9]{8,12}$/.test(token.replace(/[\s.\-]/g, ""))) {
        return {
          value: token,
          snippet: clipSnippet(line.text),
          span: { page: line.page, line: line.index },
          confidence: confidenceOf(line.text, "labeled"),
        };
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Currency — symbol → ISO map                                          */
/* ------------------------------------------------------------------ */

/** Explicit ISO codes we accept in text (a wider map would start
 * guessing; these cover the house's languages + the task's set). */
const ISO_CODES: readonly string[] = [
  "INR", "USD", "EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "SGD", "AED",
  "CNY", "SEK", "DKK", "NOK", "PLN", "NZD",
];

/** Symbol → ISO (₹→INR, €→EUR, $→USD, £→GBP, ¥→JPY). */
const SYMBOL_MAP: readonly { re: RegExp; code: string }[] = [
  { re: /\u20B9/, code: "INR" }, // ₹
  { re: /\u20AC/, code: "EUR" }, // €
  { re: /\u00A3/, code: "GBP" }, // £
  { re: /\u00A5/, code: "JPY" }, // ¥
  { re: /\$/, code: "USD" },
];

export function currencySniff(lines: readonly TextLine[]): SniffHit | null {
  // 1. An explicit ISO code near money context wins (high).
  for (const line of lines) {
    if (!/\d/.test(line.text)) continue;
    for (const code of ISO_CODES) {
      const re = new RegExp(
        `\\b${code}\\b[\\s\\S]{0,12}\\d|\\d[\\s\\S]{0,12}\\b${code}\\b`
      );
      if (re.test(line.text)) {
        return {
          value: code,
          snippet: clipSnippet(line.text),
          span: { page: line.page, line: line.index },
          confidence: "high",
        };
      }
    }
  }
  // 2. A currency symbol attached to numbers (medium).
  for (const line of lines) {
    if (!/\d/.test(line.text)) continue;
    for (const entry of SYMBOL_MAP) {
      if (entry.re.test(line.text)) {
        return {
          value: entry.code,
          snippet: clipSnippet(line.text),
          span: { page: line.page, line: line.index },
          confidence: "medium",
        };
      }
    }
  }
  // 3. The ambiguous "Rs." spelling (low — several currencies use it).
  for (const line of lines) {
    if (/\bRs\.?\s*\d/.test(line.text)) {
      return {
        value: "INR",
        snippet: clipSnippet(line.text),
        span: { page: line.page, line: line.index },
        confidence: "low",
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Dates — many formats, ISO-normalized                                 */
/* ------------------------------------------------------------------ */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

interface DateMatch {
  iso: string;
  raw: string;
}

function isoOf(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2099) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * All dates in a text, ISO-normalized, in order of appearance per
 * format family: YYYY-MM-DD · DD/MM/YYYY · DD-MM-YYYY · DD.MM.YYYY ·
 * DD-MMM-YYYY · DD MMM YYYY (and full month names) · MMM DD, YYYY.
 */
export function findDates(text: string): DateMatch[] {
  const found: DateMatch[] = [];
  const push = (raw: string, iso: string | null): void => {
    if (iso === null) return;
    if (!found.some((f) => f.raw === raw)) found.push({ raw, iso });
  };

  let m: RegExpExecArray | null;

  const ymd = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = ymd.exec(text)) !== null) {
    push(m[0], isoOf(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  const dmy = /\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\b/g;
  while ((m = dmy.exec(text)) !== null) {
    push(m[0], isoOf(Number(m[3]), Number(m[2]), Number(m[1])));
  }
  const dmmy = /\b(\d{1,2})[\s.\-]+([A-Za-z]{3,9})[\s.\-]+(\d{4})\b/g;
  while ((m = dmmy.exec(text)) !== null) {
    push(m[0], isoOf(Number(m[3]), MONTHS[(m[2] as string).toLowerCase()] ?? 0, Number(m[1])));
  }
  const mdy = /\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/g;
  while ((m = mdy.exec(text)) !== null) {
    push(m[0], isoOf(Number(m[3]), MONTHS[(m[1] as string).toLowerCase()] ?? 0, Number(m[2])));
  }
  return found;
}

const ISSUE_LABEL_RE =
  /\b(?:invoice\s*date|date(?:\s*of\s*issue)?|dated|issue\s*date)\b|दिनांक|तारीख़?|जारी\s*तिथि/i;
const DUE_LABEL_RE =
  /\b(?:due\s*date|payment\s*due|due\s*on|pay\s*by)\b|देय\s*तिथि|भुगतान\s*तिथि/i;

export interface DateSniff {
  issue: SniffHit | null;
  due: SniffHit | null;
}

/**
 * Issue date (first labelled, else the FIRST date in the document —
 * invoices print the issue date first) and due date (labelled only).
 * "Due date" lines never feed the issue field (label priority: due
 * wins when both words sit on one line).
 */
export function dateSniff(lines: readonly TextLine[]): DateSniff {
  let issue: SniffHit | null = null;
  let due: SniffHit | null = null;
  let firstAny: SniffHit | null = null;
  for (const line of lines) {
    const dates = findDates(line.text);
    if (dates.length === 0) continue;
    const span = { page: line.page, line: line.index };
    const snippet = clipSnippet(line.text);
    const hit: SniffHit = {
      value: (dates[0] as DateMatch).iso,
      snippet,
      span,
      confidence: confidenceOf(line.text, "labeled"),
    };
    if (firstAny === null) firstAny = hit;
    const isDue = DUE_LABEL_RE.test(line.text);
    if (due === null && isDue) {
      due = { ...hit, confidence: "medium" };
      continue;
    }
    if (issue === null && ISSUE_LABEL_RE.test(line.text)) {
      issue = { ...hit, confidence: "medium" };
    }
    if (issue !== null && due !== null) break;
  }
  if (issue === null) {
    // A bare date anywhere stays low — it may be a due date, a
    // delivery date, anything. Reported, never overclaimed.
    issue = firstAny === null ? null : { ...firstAny, confidence: "low" };
  }
  return { issue, due };
}

/* ------------------------------------------------------------------ */
/* Invoice number                                                       */
/* ------------------------------------------------------------------ */

/** Label words that may follow "Invoice" but are NOT the number. */
const INVNO_STOP_RE =
  /^(?:date|dated|no|number|num|id|amount|total|to|from|for|type|types|period|terms|details?|title|address|phone|email)$/i;

/** Labelled number (English + the Hindi invoice words). */
const INVNO_LABEL_RE =
  /\b(?:tax\s+)?(?:invoice|bill|inv)\s*(?:no\.?|number|num|id|#)?\s*[:\-–]?\s*([A-Z0-9][A-Z0-9/\-]{1,24})/i;
const INVNO_LABEL_HI_RE =
  /(?:इनवॉइस|बिल)\s*(?:नंबर|नं\.?|संख्या|सं\.?|आई\.?डी\.?)\s*[:\-–]?\s*([A-Z0-9][A-Z0-9/\-]{1,24})/i;
/** Bare "Invoice #X" (the task's canonical shape). */
const INVNO_HASH_RE = /invoice\s*#?\s*[:-]?\s*([A-Z0-9][A-Z0-9/\-]{1,24})/i;

function acceptInvNo(value: string): boolean {
  if (INVNO_STOP_RE.test(value)) return false;
  if (findDates(value).length > 0) return false; // a date, not a number
  return true;
}

export function invoiceNumberSniff(lines: readonly TextLine[]): SniffHit | null {
  // Pass 1: a labelled number (strongest layout evidence).
  for (const line of lines) {
    for (const re of [INVNO_LABEL_RE, INVNO_LABEL_HI_RE]) {
      const m = re.exec(line.text);
      if (m === null) continue;
      const value = (m[1] as string).replace(/[.\-–]$/, "");
      if (!acceptInvNo(value)) continue;
      return {
        value,
        snippet: clipSnippet(line.text),
        span: { page: line.page, line: line.index },
        confidence: confidenceOf(line.text, "strong"),
      };
    }
  }
  // Pass 2: "Invoice INV-2026-042" (label word present, hash optional).
  for (const line of lines) {
    const m = INVNO_HASH_RE.exec(line.text);
    if (m === null) continue;
    const value = (m[1] as string).replace(/[.\-–]$/, "");
    if (!acceptInvNo(value)) continue;
    return {
      value,
      snippet: clipSnippet(line.text),
      span: { page: line.page, line: line.index },
      confidence: confidenceOf(line.text, "labeled"),
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Amounts + totals                                                     */
/* ------------------------------------------------------------------ */

const MONEY_CORE = String.raw`(?:\d{1,3}(?:,\d{2,3})*|\d+)(?:\.\d{1,2})?`;
/** An amount, optionally behind a currency mark. */
const MONEY_RE = new RegExp(
  `(?:\u20B9|\u20AC|\u00A3|\u00A5|\\$|Rs\\.?|INR|USD|EUR|GBP|JPY)?\\s*(${MONEY_CORE})`,
  "g"
);

function parseAmount(raw: string): number {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : Number.NaN;
}

/** All amounts in a text (leftmost→rightmost). */
export function amountsIn(text: string): string[] {
  const out: string[] = [];
  MONEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MONEY_RE.exec(text)) !== null) {
    out.push(m[1] as string);
  }
  return out;
}

/** The rightmost amount in a text, or null (the printed total). */
function trailingAmount(text: string): string | null {
  const list = amountsIn(text);
  return list.length > 0 ? (list[list.length - 1] as string) : null;
}

const SUBTOTAL_RE =
  /\b(?:sub\s*-?\s*total|line\s*total|net\s*total|taxable\s*(?:value|amount)|कर\s*योग्य\s*मूल्य|उप\s*योग|उपयोग)\b/i;
const GRAND_RE =
  /\b(?:grand\s*total|total\s*due|amount\s*due|balance\s*due|total\s*amount|invoice\s*total|final\s*total|total)\b|कुल\s*(?:मूल्य|राशि|देय|योग)?|देय\s*राशि/i;
/** Count/adjustment lines that must never feed a total field. */
const TOTAL_NOISE_RE =
  /\b(?:qty|quantity|items?|pcs|pieces|units?|nos\.?|discount|round(?:ing)?\s*off|shipping|freight)\b/i;

export interface TotalsSniff {
  lineTotal: SniffHit | null;
  grandTotal: SniffHit | null;
}

/**
 * Totals: subtotal-class and grand-total-class lines are scanned
 * separately. Within a class the LAST match wins (repeat headers and
 * page summaries overwrite), with a largest-number sanity check —
 * when the winner is SMALLER than an earlier candidate the
 * confidence drops to low (contradictory layout: verify!).
 */
export function totalsSniff(lines: readonly TextLine[]): TotalsSniff {
  const pick = (re: RegExp): SniffHit | null => {
    let last: SniffHit | null = null;
    let max = Number.NaN;
    for (const line of lines) {
      if (!re.test(line.text)) continue;
      if (TOTAL_NOISE_RE.test(line.text)) continue;
      const amount = trailingAmount(line.text);
      if (amount === null) continue;
      const value = parseAmount(amount);
      if (!Number.isFinite(value)) continue;
      const contradiction =
        last !== null && Number.isFinite(max) && value < max;
      last = {
        value: amount,
        snippet: clipSnippet(line.text),
        span: { page: line.page, line: line.index },
        confidence: contradiction ? "low" : "medium",
      };
      if (!Number.isFinite(max) || value > max) max = value;
    }
    return last;
  };

  const lineTotal = pick(SUBTOTAL_RE);
  const grandTotal = pick(GRAND_RE);
  // A grand total smaller than the found subtotal is suspect — flag it.
  if (
    grandTotal !== null &&
    lineTotal !== null &&
    parseAmount(grandTotal.value) < parseAmount(lineTotal.value)
  ) {
    grandTotal.confidence = "low";
  }
  return { lineTotal, grandTotal };
}

/* ------------------------------------------------------------------ */
/* Tax lines (Path B)                                                   */
/* ------------------------------------------------------------------ */

/** CGST/SGST/IGST/UTGST/GST/VAT + % (+ amount if printed). */
const TAX_LINE_RE =
  /\b(cgst|sgst|igst|utgst|gst|vat)\b[^%\d]{0,24}(\d{1,2}(?:\.\d{1,2})?)\s*%/i;

export function taxLinesSniff(lines: readonly TextLine[]): TaxHit[] {
  const out: TaxHit[] = [];
  for (const line of lines) {
    const m = TAX_LINE_RE.exec(line.text);
    if (m === null) continue;
    const rest = line.text.slice(m.index + m[0].length);
    const amounts = amountsIn(rest);
    const amount = amounts.length > 0 ? (amounts[0] as string) : "";
    out.push({
      type: (m[1] as string).toUpperCase(),
      rate: m[2] as string,
      amount,
      sourceSnippet: clipSnippet(line.text),
    });
    if (out.length >= 8) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Line items (greedy, capped, honest)                                  */
/* ------------------------------------------------------------------ */

const ITEM_BLOCKER_RE =
  /\b(?:invoice|bill\s+to|ship\s+to|from|seller|buyer|subtotal|total|amount\s*due|balance|tax|gst|cgst|sgst|igst|utgst|vat|place\s*of\s*supply|pan|gstin|hsn|sac|description|qty|quantity|rate|price|amount|date|due|terms|thanks|thank\s*you|signature|page)\b/i;
const ITEM_BLOCKER_HI =
  /इनवॉइस|बिल|कुल|देय|कर|विवरण|मात्रा|दर|मूल्य|राशि|दिनांक|तिथि|धन्यवाद|हस्ताक्षर/;
/** Strips ONE trailing money token (needs whitespace or start before it). */
const TRAILING_MONEY_RE =
  /(?:^|\s)(?:\u20B9|\u20AC|\u00A3|\u00A5|\$|Rs\.?|INR|USD|EUR|GBP|JPY)?\s*[\d,]+(?:\.\d{1,2})?\s*$/;

/**
 * Greedy line items: a line that is NOT header/total/label noise and
 * carries ≥2 amounts (a qty/price/amount shape). Descriptions are the
 * non-numeric prefix, capped; every field is best-effort.
 */
export function lineItemsSniff(lines: readonly TextLine[]): InvoiceLineItem[] {
  const items: InvoiceLineItem[] = [];
  for (const line of lines) {
    if (line.text.length < 4) continue;
    if (ITEM_BLOCKER_RE.test(line.text) || ITEM_BLOCKER_HI.test(line.text)) continue;
    if (/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/.test(line.text)) continue; // dates
    const amounts = amountsIn(line.text);
    if (amounts.length < 2) continue; // one bare number is not a row
    let description = line.text;
    for (;;) {
      const next = description.replace(TRAILING_MONEY_RE, "");
      if (next === description) break;
      description = next;
    }
    description = description.replace(/\s+/g, " ").trim();
    if (description.replace(/[^A-Za-z\u0900-\u097F]/g, "").length < 2) continue;
    const clean = (s: string): string => s.replace(/,/g, "");
    const amount = amounts[amounts.length - 1] as string;
    const qty = amounts.length >= 3 ? (amounts[0] as string) : "";
    const unitPrice = amounts.length >= 3 ? (amounts[1] as string) : (amounts[0] as string);
    items.push({
      description: description.slice(0, 60),
      qty: clean(qty),
      unitPrice: clean(unitPrice),
      amount: clean(amount),
    });
    if (items.length >= MAX_LINE_ITEMS) break;
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* Path B orchestrator                                                  */
/* ------------------------------------------------------------------ */

function hit(key: string, s: SniffHit): FieldHit {
  return {
    key,
    label: FIELD_LABELS[key] ?? key,
    value: s.value,
    confidence: s.confidence,
    sourceSnippet: s.snippet,
    span: s.span,
  };
}

/**
 * Runs every sniffer over the extracted lines and assembles the
 * best-effort summary. `missingKeys` carries the searched-but-not-
 * found fields — the UI shows them as "not found", never invented.
 */
export function sniffInvoice(
  lines: readonly TextLine[],
  pagesRead: number,
  truncated: boolean
): InvoiceSummary {
  const fields: FieldHit[] = [];
  const missingKeys: string[] = [];
  const push = (key: string, s: SniffHit | null): void => {
    if (s !== null) fields.push(hit(key, s));
    else missingKeys.push(key);
  };

  push("invoiceNumber", invoiceNumberSniff(lines));
  const dates = dateSniff(lines);
  push("issueDate", dates.issue);
  push("dueDate", dates.due);
  const gstins = gstinSniff(lines);
  const vat = vatSniff(lines);
  push("sellerTaxId", gstins.seller ?? vat);
  push("buyerTaxId", gstins.buyer);
  push("currency", currencySniff(lines));
  const totals = totalsSniff(lines);
  push("lineTotal", totals.lineTotal);
  push("taxBasisTotal", null); // layout sniffing has no separate basis
  push("grandTotal", totals.grandTotal);
  push("sellerName", null); // names need structure — honest miss
  push("buyerName", null);
  const items = lineItemsSniff(lines);
  push(
    "lineCount",
    items.length > 0
      ? {
          value: String(items.length),
          snippet: clipSnippet(items.map((i) => i.description).join(" | ")),
          confidence: "low",
        }
      : null
  );

  return {
    path: "B",
    fields,
    missingKeys: missingKeys.filter((k, i) => missingKeys.indexOf(k) === i),
    taxes: taxLinesSniff(lines),
    lineItems: items,
    pagesRead,
    truncated: truncated || undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Tiny XML subset parser (namespace-tolerant CII reader)               */
/* ------------------------------------------------------------------ */

export interface XmlElement {
  /** Raw tag name with its prefix ("ram:ID"). */
  name: string;
  /** Local name (prefix stripped) — all matching happens on this. */
  local: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Direct text, entities decoded. */
  text: string;
}

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_m, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10))
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Local part of a possibly-prefixed name ("ram:ID" → "ID"). */
export function localName(name: string): string {
  const i = name.indexOf(":");
  return i >= 0 ? name.slice(i + 1) : name;
}

/**
 * Parses the XML subset CII files use: elements, attributes, text,
 * self-closing tags, the declaration, comments, DOCTYPE and CDATA,
 * with entity decoding. Returns the first top-level element, or null
 * for anything it cannot honestly parse (the worker then reports the
 * attachment without a fabricated summary).
 */
export function parseXml(source: string): XmlElement | null {
  if (source.length === 0 || source.length > XML_MAX_BYTES) return null;
  let i = 0;
  const ws = (from: number): number => {
    let j = from;
    while (j < source.length && /\s/.test(source[j] as string)) j += 1;
    return j;
  };

  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;

  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) {
      // Text before the tag — belongs to the innermost open element.
      const top = stack[stack.length - 1];
      if (top) top.text += decodeEntities(source.slice(i, lt));
      i = lt;
    }
    const next = source[i + 1];
    if (next === "?") {
      const end = source.indexOf("?>", i);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    if (next === "!") {
      if (source.startsWith("<!--", i)) {
        const end = source.indexOf("-->", i);
        if (end < 0) return null;
        i = end + 3;
        continue;
      }
      if (source.startsWith("<![CDATA[", i)) {
        const end = source.indexOf("]]>", i);
        if (end < 0) return null;
        const top = stack[stack.length - 1];
        if (top) top.text += source.slice(i + 9, end);
        i = end + 3;
        continue;
      }
      const end = source.indexOf(">", i);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    if (next === "/") {
      const end = source.indexOf(">", i);
      if (end < 0) return null;
      const closeName = source.slice(i + 2, end).trim();
      // Tolerant close: pop to the matching open (producers are
      // sloppy); an unmatched close is ignored.
      for (let d = stack.length - 1; d >= 0; d -= 1) {
        if ((stack[d] as XmlElement).name === closeName) {
          stack.length = d;
          break;
        }
      }
      i = end + 1;
      continue;
    }
    // Open tag: name, then attributes until > or />.
    let j = i + 1;
    while (j < source.length && !/[\s/>]/.test(source[j] as string) && j - i < 200) {
      j += 1;
    }
    const name = source.slice(i + 1, j);
    if (name.length === 0) return null;
    const attrs: Record<string, string> = {};
    let selfClose = false;
    let ok = true;
    for (;;) {
      j = ws(j);
      const ch = source[j];
      if (ch === undefined) return null;
      if (ch === ">") {
        j += 1;
        break;
      }
      if (ch === "/" && source[j + 1] === ">") {
        selfClose = true;
        j += 2;
        break;
      }
      let k = j;
      while (k < source.length && !/[\s=/>]/.test(source[k] as string)) k += 1;
      if (k === j) {
        ok = false;
        break;
      }
      const attrName = source.slice(j, k);
      j = ws(k);
      if (source[j] === "=") {
        j = ws(j + 1);
        const quote = source[j];
        if (quote !== '"' && quote !== "'") return null;
        const endQ = source.indexOf(quote, j + 1);
        if (endQ < 0) return null;
        attrs[attrName] = decodeEntities(source.slice(j + 1, endQ));
        j = endQ + 1;
      } else {
        attrs[attrName] = "";
      }
    }
    if (!ok) return null;
    const el: XmlElement = { name, local: localName(name), attrs, children: [], text: "" };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (root === null) root = el;
    if (!selfClose) {
      stack.push(el);
      if (stack.length > 200) return null; // absurd nesting
    }
    i = j;
  }
  return root;
}

/* ---- element accessors (localName matching) ---- */

/** First descendant (DFS) with the local name. */
export function findEl(root: XmlElement | null, local: string): XmlElement | null {
  if (root === null) return null;
  if (root.local === local) return root;
  for (const child of root.children) {
    const found = findEl(child, local);
    if (found !== null) return found;
  }
  return null;
}

/** All descendants (DFS order) with the local name. */
export function findAll(root: XmlElement | null, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (el: XmlElement | null): void => {
    if (el === null) return;
    if (el.local === local) out.push(el);
    for (const child of el.children) walk(child);
  };
  walk(root);
  return out;
}

/** Direct child with the local name. */
export function childEl(parent: XmlElement | null, local: string): XmlElement | null {
  if (parent === null) return null;
  for (const child of parent.children) {
    if (child.local === local) return child;
  }
  return null;
}

/** Attribute by local name (format, currencyID, schemeID…). */
export function attrOf(el: XmlElement | null, local: string): string {
  if (el === null) return "";
  for (const key of Object.keys(el.attrs)) {
    if (localName(key) === local) return el.attrs[key] ?? "";
  }
  return "";
}

/** The element's own text, whitespace-collapsed. */
export function textOf(el: XmlElement | null): string {
  if (el === null) return "";
  return el.text.replace(/\s+/g, " ").trim();
}

/** The evidence snippet for a Path A field: the raw element. */
function xmlSnippet(el: XmlElement | null): string {
  if (el === null) return "";
  return clipSnippet(`<${el.name}>${textOf(el)}</${el.name}>`);
}

/** Element accessor the summarizer takes (overridable in tests). */
export type GetEl = (root: XmlElement | null, local: string) => XmlElement | null;

/* ------------------------------------------------------------------ */
/* Path A — CII summarizer                                              */
/* ------------------------------------------------------------------ */

/** ISO 8601 "format 102" (CCYYMMDD) → YYYY-MM-DD; others pass raw. */
export function decodeCiiDate(raw: string, format: string): string {
  if (format === "102" && /^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  if (format === "610" && /^\d{6}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}`;
  }
  return raw;
}

/**
 * Maps a parsed CrossIndustryInvoice tree onto the summary. Matching
 * is namespace-tolerant (local names only), so rsm:/ram:/udt:,
 * default-namespace and custom-prefix files all read the same. Every
 * field cites its element; absent elements land in missingKeys.
 */
export function summarizeCii(
  doc: XmlElement | null,
  getEl: GetEl = findEl
): InvoiceSummary {
  const fields: FieldHit[] = [];
  const missingKeys: string[] = [];
  const push = (key: string, el: XmlElement | null, valueOverride?: string): void => {
    const value = valueOverride ?? textOf(el);
    if (el !== null && value.length > 0) {
      fields.push({
        key,
        label: FIELD_LABELS[key] ?? key,
        value,
        confidence: "high", // the structured source itself
        sourceSnippet: xmlSnippet(el),
      });
    } else {
      missingKeys.push(key);
    }
  };

  const ciiRecognized = doc !== null && doc.local === "CrossIndustryInvoice";

  const exchanged = getEl(doc, "ExchangedDocument");
  push("invoiceNumber", childEl(exchanged, "ID"));
  const issueDateTime = childEl(exchanged, "IssueDateTime");
  const dateTimeString = childEl(issueDateTime, "DateTimeString");
  push(
    "issueDate",
    dateTimeString,
    dateTimeString === null
      ? undefined
      : decodeCiiDate(textOf(dateTimeString), attrOf(dateTimeString, "format"))
  );

  const settlement = getEl(doc, "ApplicableHeaderTradeSettlement");
  // Due date: SpecifiedTradePaymentTerms/DueDateDateTime (format 102 like
  // the issue date). Absent → missingKeys, same honesty as Path B.
  const dueDateTimeString = childEl(
    childEl(getEl(settlement, "SpecifiedTradePaymentTerms"), "DueDateDateTime"),
    "DateTimeString"
  );
  push(
    "dueDate",
    dueDateTimeString,
    dueDateTimeString === null
      ? undefined
      : decodeCiiDate(textOf(dueDateTimeString), attrOf(dueDateTimeString, "format"))
  );

  push("currency", childEl(settlement, "InvoiceCurrencyCode"));

  const agreement = getEl(doc, "ApplicableHeaderTradeAgreement");
  const seller = childEl(agreement, "SellerTradeParty");
  const buyer = childEl(agreement, "BuyerTradeParty");
  push("sellerName", childEl(seller, "Name"));
  push("buyerName", childEl(buyer, "Name"));
  push("sellerTaxId", childEl(getEl(seller, "SpecifiedTaxRegistration"), "ID"));
  push("buyerTaxId", childEl(getEl(buyer, "SpecifiedTaxRegistration"), "ID"));

  // Line items.
  const lineItems: InvoiceLineItem[] = [];
  for (const line of findAll(doc, "IncludedSupplyChainTradeLineItem")) {
    const lineId = childEl(getEl(line, "AssociatedDocumentLineDocument"), "LineID");
    const product = getEl(line, "SpecifiedTradeProduct");
    const description =
      textOf(childEl(product, "Name")) ||
      (lineId !== null ? `Line ${textOf(lineId)}` : "");
    const netPrice = getEl(
      getEl(line, "SpecifiedLineTradeAgreement"),
      "NetPriceProductTradePrice"
    );
    // BilledQuantity lives in SpecifiedLineTradeDelivery (CII D16B), not
    // under the net price — the smoke's spec-correct fixture pinned this.
    const delivery = getEl(line, "SpecifiedLineTradeDelivery");
    const lineSum = getEl(
      getEl(line, "SpecifiedLineTradeSettlement"),
      "SpecifiedTradeSettlementLineMonetarySummation"
    );
    lineItems.push({
      description: description.slice(0, 60),
      qty: textOf(childEl(delivery, "BilledQuantity")),
      unitPrice: textOf(childEl(netPrice, "ChargeAmount")),
      amount: textOf(childEl(lineSum, "LineTotalAmount")),
    });
    if (lineItems.length >= MAX_LINE_ITEMS) break;
  }
  if (lineItems.length > 0) {
    fields.push({
      key: "lineCount",
      label: FIELD_LABELS.lineCount ?? "",
      value: String(lineItems.length),
      confidence: "high",
      sourceSnippet: clipSnippet(
        lineItems.map((i) => `<LineTotalAmount>${i.amount}</LineTotalAmount>`).join(" ")
      ),
    });
  } else {
    missingKeys.push("lineCount");
  }

  // Monetary summation.
  const sums = getEl(settlement, "SpecifiedTradeSettlementHeaderMonetarySummation");
  push("lineTotal", childEl(sums, "LineTotalAmount"));
  push("taxBasisTotal", childEl(sums, "TaxBasisTotalAmount"));
  push("grandTotal", childEl(sums, "GrandTotalAmount"));

  // Taxes: every ApplicableTradeTax under the settlement.
  const taxes: TaxHit[] = [];
  for (const tax of findAll(settlement, "ApplicableTradeTax")) {
    const rate = textOf(childEl(tax, "RateApplicablePercent"));
    const amount = textOf(childEl(tax, "CalculatedAmount"));
    const type = textOf(childEl(tax, "TypeCode"));
    if (rate.length === 0 && amount.length === 0) continue;
    taxes.push({
      type: type.length > 0 ? type : "TAX",
      rate,
      amount,
      sourceSnippet: clipSnippet(
        `<${tax.name}> type=${type} rate=${rate} amount=${amount} `
      ),
    });
    if (taxes.length >= 8) break;
  }

  return {
    path: "A",
    ciiRecognized,
    fields,
    missingKeys: missingKeys.filter((k, i) => missingKeys.indexOf(k) === i),
    taxes,
    lineItems,
    pagesRead: 0,
  };
}

/* ------------------------------------------------------------------ */
/* The JSON download body (Path B, and useful for Path A exports)       */
/* ------------------------------------------------------------------ */

export interface JsonMeta {
  sourceName?: string;
  notice?: string;
}

/** Machine-readable summary: keys + values + confidence + evidence. */
export function buildInvoiceJson(
  summary: InvoiceSummary,
  meta: JsonMeta = {}
): string {
  const fields: Record<string, unknown> = {};
  for (const field of summary.fields) {
    fields[field.key] = {
      value: field.value,
      confidence: field.confidence,
      source: field.sourceSnippet,
    };
  }
  const body = {
    extractedBy: "MyCloudy pdf-to-e-invoice (on-device)",
    extractionPath:
      summary.path === "A"
        ? "embedded-xml"
        : "layout-sniff (best-effort — verify before use)",
    source: meta.sourceName ?? "",
    ...(summary.path === "A"
      ? {
          attachment: summary.attachmentName ?? "",
          foundVia: summary.foundVia ?? "",
          ciiRecognized: summary.ciiRecognized === true,
        }
      : {
          pagesRead: summary.pagesRead,
          truncated: summary.truncated === true,
        }),
    fields,
    notFound: summary.missingKeys,
    taxes: summary.taxes,
    lineItems: summary.lineItems,
    notice:
      meta.notice ??
      (summary.path === "A"
        ? "Fields extracted from the embedded Factur-X/ZUGFeRD CII XML. The XML file itself is the authoritative e-invoice payload."
        : "Fields sniffed from the PDF's visual layout. Every value carries its source snippet and confidence — verify before use. For real e-invoicing, use a PDF with an embedded Factur-X/ZUGFeRD XML."),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/* ------------------------------------------------------------------ */
/* Worker-boundary coercion                                             */
/* ------------------------------------------------------------------ */

/** Options the surface syncs (repair-pdf pattern: options.run JSON). */
export function parseRunOptions(
  raw: Record<string, unknown>
): PdfToEInvoiceRunOptions {
  const str = (v: unknown, max: number): string =>
    typeof v === "string"
      ? v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max)
      : "";
  const pages = Number(raw.maxPages);
  return {
    locale: raw.locale === "hi" ? "hi" : "en",
    fileWord: str(raw.fileWord, 40) || "invoice",
    maxPages:
      Number.isFinite(pages) && pages >= 1 && pages <= MAX_PAGES
        ? Math.floor(pages)
        : MAX_PAGES,
  };
}

/** "My Invoice.pdf" → "My Invoice" (path-unsafe chars out, Devanagari
 * survives); a nameless file falls back to the localized word. */
export function outputBaseName(
  fileName: string,
  locale: "en" | "hi",
  fileWord: string
): string {
  const base = fileName
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim();
  if (base.length > 0) return base.slice(0, 120);
  return fileWord || (locale === "hi" ? "इनवॉइस" : "invoice");
}

/**
 * Attachment names are file names — strip the path and the unsafe
 * characters, keep the .xml tail, fall back to the standard name.
 */
export function sanitizeAttachmentName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[^A-Za-z0-9._\- ]/g, "")
    .trim()
    .slice(0, 80);
  if (cleaned.length === 0) return "factur-x.xml";
  return /\.xml$/i.test(cleaned) ? cleaned : `${cleaned}.xml`;
}

/* ------------------------------------------------------------------ */
/* Attachment picking (pure)                                            */
/* ------------------------------------------------------------------ */

/** The attachment shape the picking works on (pdf.js or /AF walk). */
export interface RawAttachmentLike {
  name: string;
  bytes: Uint8Array;
}

/** True when the BYTES look like an XML document (BOM/space tolerant). */
export function looksLikeXml(bytes: Uint8Array): boolean {
  let i = 0;
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    i = 3; // UTF-8 BOM
  }
  while (
    i < bytes.length &&
    (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)
  ) {
    i += 1;
  }
  if (i + 4 >= bytes.length) return false;
  const head = String.fromCharCode(
    bytes[i] ?? 0,
    bytes[i + 1] ?? 0,
    bytes[i + 2] ?? 0,
    bytes[i + 3] ?? 0,
    bytes[i + 4] ?? 0
  );
  return head.startsWith("<?xml") || head.startsWith("<");
}

/**
 * Picks THE e-invoice XML among attachments: the standard
 * Factur-X/ZUGFeRD names first, then any *.xml, then any attachment
 * whose bytes look like XML. Nothing else is ever picked.
 */
export function pickXmlAttachment(
  candidates: readonly RawAttachmentLike[]
): RawAttachmentLike | null {
  const isXmlName = (name: string): boolean => /\.xml$/i.test(name);
  const rank = (name: string): number => {
    const lower = name.toLowerCase();
    if (/factur[-_]?x/.test(lower)) return 0;
    if (/zugferd/.test(lower)) return 1;
    if (/xrechnung/.test(lower)) return 2;
    if (isXmlName(name)) return 3;
    return 4; // content-sniffed XML only
  };
  let best: { item: RawAttachmentLike; rank: number } | null = null;
  for (const candidate of candidates) {
    const xmlish = isXmlName(candidate.name) || looksLikeXml(candidate.bytes);
    if (!xmlish) continue;
    const r = rank(candidate.name);
    if (best === null || r < best.rank) best = { item: candidate, rank: r };
  }
  return best === null ? null : best.item;
}

/* ------------------------------------------------------------------ */
/* Error taxonomy                                                       */
/* ------------------------------------------------------------------ */

/**
 * pdf.js failure → honest i18n code. Password-protected files ask
 * for a password; unreadable structure is corrupt — and nothing else
 * is ever claimed.
 */
export function classifyError(message: string): string {
  if (/password/i.test(message)) return "tool.errorEncrypted";
  return "tool.errorCorrupt";
}
