/**
 * OCR → invoice chaining (R5-c) — pure text heuristics only.
 *
 * After the OCR tool recognizes a scanned invoice, this module tries to
 * read the LABELLED fields a human would look for: the invoice number,
 * the invoice/due dates, the seller, the currency of the totals, the
 * item rows and the totals block. Honest by construction:
 *
 *  - a field is only ever set when a confident LABEL match (or the
 *    documented numeric-tail shape for item rows) was found on a line;
 *    everything else stays `undefined` — nothing is fabricated, guessed
 *    or defaulted;
 *  - the invoice number NEVER comes from a bare number — a label
 *    ("Invoice No", "इनवॉइस नं.", "Invoice #", …) is required;
 *  - totals are read only from labelled lines ("Total", "Subtotal",
 *    "CGST", "कुल योग", …) with the value on the SAME line — a number
 *    standing on its own is never a total;
 *  - when nothing label-matches at all (prose, a letter, garbage OCR)
 *    the whole extraction returns `null` — the caller shows the honest
 *    "no invoice fields found" state instead of an empty draft;
 *  - the vendor name falls back to a documented heuristic (the first
 *    non-blank line that is neither a title, a label line nor a number
 *    fragment), and that heuristic alone NEVER makes a text count as
 *    an invoice — only real label evidence does.
 *
 * The module is a PURE function of strings: no DOM, no storage, no
 * network, no clock. It is shared by the ocr-pdf result hand-off
 * (button), the create-invoice prefill hydration (through the
 * localStorage round-trip codec below) and the smoke script — so every
 * regex here is unit-testable outside the browser.
 */

import type { RunDetail } from "@/lib/workers/protocol";

/* ------------------------------------------------------------------ */
/* Contract types                                                      */
/* ------------------------------------------------------------------ */

/** One recognized item row (description + qty + rate, all required). */
export interface OcrInvoiceItem {
  /** Description text before the numbers (trimmed). */
  d: string;
  /** Quantity (decimal string, thousands separators stripped). */
  q: string;
  /** Rate / unit price (decimal string, thousands separators stripped). */
  r: string;
  /** Per-row GST % ("18") when the row itself carried one. */
  g?: string;
}

/** Labelled totals actually found on the page (verbatim numeric strings). */
export interface OcrInvoiceTotals {
  subtotal?: string;
  tax?: string;
  cgst?: string;
  sgst?: string;
  grand?: string;
}

/** The prefilled fields the create-invoice editor hydrates from. */
export interface OcrInvoiceDraft {
  invoiceNumber?: string;
  /** ISO yyyy-mm-dd. */
  date?: string;
  /** ISO yyyy-mm-dd. */
  dueDate?: string;
  /** Seller / "from" line (labelled match, or the first-line heuristic). */
  vendor?: string;
  currency?: "INR" | "USD" | "EUR" | "GBP";
  totals: OcrInvoiceTotals;
  /** Any GST-labelled total (GST/CGST/SGST/IGST/कर) was found. */
  gstFound: boolean;
  items: OcrInvoiceItem[];
  /** More than 50 item rows were found — the rest were dropped. */
  itemsCapped: boolean;
}

/**
 * The ocr worker's result detail carries the recognized page texts so
 * the result view can offer the invoice hand-off. Declared here — not
 * in the shared protocol — because only this tool's chaining needs it;
 * a local extension keeps RunDetail untouched on both sides of the
 * worker boundary while staying type-safe (structural subtype).
 */
export interface OcrRunDetail extends RunDetail {
  /** Recognized text per processed page (native pages included). */
  pageTexts?: string[];
}

/** localStorage key the ocr surface writes and create-invoice consumes. */
export const OCR_PREFILL_KEY = "dp_inv_ocr";

/** Hard cap on item rows carried into the editor (honest truncation). */
export const MAX_OCR_ITEMS = 50;

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                 */
/* ------------------------------------------------------------------ */

/** Devanagari digits → Latin (Hindi OCR emits them for numbers). */
const DEV_DIGITS = "०१२३४५६७८९";
function latinDigits(s: string): string {
  let out = "";
  for (const ch of s) {
    const i = DEV_DIGITS.indexOf(ch);
    out += i >= 0 ? String(i) : ch;
  }
  return out;
}

/** A bare numeric fragment. */
const NUM_RE = /\d[\d,]*(?:\.\d+)?/;

/**
 * Normalize a recognized number token into the editor's plain decimal
 * string form: strips ₹/$/€/£ symbols, a leading "Rs."/"Rs" and an
 * Indian "/-" tail, then drops thousands separators. Returns null when
 * the token is not a clean non-negative number — negative amounts are
 * deliberately unsupported (invoice item rows and totals are never
 * negative; credit notes are out of scope).
 */
function normNumber(raw: string): string | null {
  const s = latinDigits(raw)
    .replace(/[₹$€£]/g, "")
    .replace(/\brs\.?\b/gi, "")
    .replace(/\/-$/, "")
    .trim();
  if (!/^\d[\d,]*(?:\.\d+)?$/.test(s)) return null;
  return s.replace(/,/g, "");
}

/** Token → finite non-negative number (null on garbage) — cross-checks only. */
function numValue(s: string): number | null {
  const n = Number.parseFloat(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** ISO date sanity: a real calendar day (no 2026-02-30, sane year). */
function isoOK(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || y < 1990 || y > 2100) return false;
  const days = [
    31,
    (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ];
  return d <= days[mo - 1];
}

/** dd/mm/yyyy-ish → ISO. Day-first (Indian documents); swapped only when the month slot cannot be a month. */
function isoFromDMY(d: number, m: number, y: number): string | null {
  if (y < 1990 || y > 2100) return null;
  let day = d;
  let month = m;
  if (month > 12 && day <= 12) {
    // the "month" slot cannot be a month but the "day" slot can — the
    // separator order was month-first (US style); swap once.
    const t = day;
    day = month;
    month = t;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isoOK(iso) ? iso : null;
}

const EN_MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** Hindi month names (common transliteration variants included). */
const HI_MONTHS: readonly [RegExp, number][] = [
  [/^जनवरी$/, 1],
  [/^फ़?रवरी$/, 2],
  [/^मार्च$/, 3],
  [/^अप्रैल$/, 4],
  [/^मई$/, 5],
  [/^जून$/, 6],
  [/^जुलै$/, 7],
  [/^अगस्त$/, 8],
  [/^सितं?बर$/, 9],
  [/^अक्टू?बर$/, 10],
  [/^नवं?बर$/, 11],
  [/^दिसं?बर$/, 12],
];

/** Parse a date value string into ISO yyyy-mm-dd (null when not a date). */
function parseDateValue(raw: string): string | null {
  const s = latinDigits(raw.trim())
    .replace(/(\d)(st|nd|rd|th)\b/gi, "$1")
    .trim();
  // yyyy-mm-dd
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    return isoOK(iso) ? iso : null;
  }
  // dd/mm/yyyy · dd-mm-yyyy · dd.mm.yyyy
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(s);
  if (m) return isoFromDMY(Number(m[1]), Number(m[2]), Number(m[3]));
  // dd Mon yyyy — English or Hindi month, optional "." between, 3-letter ok
  m = /^(\d{1,2})[.\s]+([^\s\d]+)[.\s]+(\d{4})$/.exec(s);
  if (m) {
    const word = m[2].toLowerCase().replace(/[।.]$/u, "");
    let month = 0;
    for (let i = 0; i < EN_MONTHS.length; i += 1) {
      if (
        word === EN_MONTHS[i] ||
        (word.length >= 3 && EN_MONTHS[i].startsWith(word))
      ) {
        month = i + 1;
        break;
      }
    }
    if (month === 0) {
      for (const [re, mo] of HI_MONTHS) {
        if (re.test(word)) {
          month = mo;
          break;
        }
      }
    }
    if (month > 0) return isoFromDMY(Number(m[1]), month, Number(m[3]));
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Label tables (all case-insensitive; hi ones only used in hi locale) */
/* ------------------------------------------------------------------ */

interface LabelRe {
  re: RegExp;
  hi: boolean;
}

/**
 * Invoice-number labels. The captured value must additionally contain a
 * digit and look like an id token (letters/digits/slash/dash) — a bare
 * word after "Invoice" (e.g. the sheet title "TAX INVOICE") never
 * matches, and a bare number without a label never does either.
 */
const INVOICE_NO_RES: readonly LabelRe[] = [
  {
    re: /^(?:tax\s+)?(?:invoice|inv|bill|receipt)\s*(?:no\.?|nos?\.?|number|#|id)\s*[:#\-.]?\s*([A-Za-z0-9][A-Za-z0-9\/\-]*)$/i,
    hi: false,
  },
  {
    re: /^(?:invoice|inv|bill|receipt)\s*#\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\/\-]*)$/i,
    hi: false,
  },
  { re: /^#\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\/\-]*)$/i, hi: false },
  {
    re: /^इनवॉइस\s*(?:नं\.?|नंबर|संख्या|क्रमांक)\s*[:\-.\s]*([A-Za-z0-9][A-Za-z0-9\/\-]*)$/,
    hi: true,
  },
  {
    re: /^(?:बिल|रसीद)\s*(?:नं\.?|नंबर|संख्या)\s*[:\-.\s]*([A-Za-z0-9][A-Za-z0-9\/\-]*)$/,
    hi: true,
  },
];

/** Invoice-date labels. */
const DATE_LABEL_RES: readonly LabelRe[] = [
  { re: /^(?:invoice|bill)\s*date\s*[:\-]?\s*(.+)$/i, hi: false },
  { re: /^(?:dated|date\s+of\s+issue|issue\s+date)\s*[:\-]?\s*(.+)$/i, hi: false },
  { re: /^date\s*[:\-]\s*(.+)$/i, hi: false },
  { re: /^दिनांक\s*[:\-.\s]*(.+)$/, hi: true },
  { re: /^तारीख\s*[:\-.\s]*(.+)$/, hi: true },
  { re: /^(?:इनवॉइस|बिल)\s*(?:दिनांक|तारीख)\s*[:\-.\s]*(.+)$/, hi: true },
];

/**
 * Due-date labels. A lone "Due" is deliberately NOT a date label — on
 * real invoices it labels money ("Balance due"), and every candidate
 * here still has to parse as a real date before it counts.
 */
const DUE_LABEL_RES: readonly LabelRe[] = [
  { re: /^(?:due|payment|payable|net)\s*date\s*[:\-]?\s*(.+)$/i, hi: false },
  { re: /^(?:payment\s+due|amount\s+due|balance\s+due)\s*(?:date|on)\s*[:\-]?\s*(.+)$/i, hi: false },
  { re: /^due\s+on\s*[:\-]?\s*(.+)$/i, hi: false },
  { re: /^देय\s*(?:तिथि|दिनांक)\s*[:\-.\s]*(.+)$/, hi: true },
  { re: /^भुगतान\s*(?:तिथि|दिनांक)\s*[:\-.\s]*(.+)$/, hi: true },
];

/**
 * Vendor/seller labels. "From"/"Seller" style labels take the rest of
 * the line — or, when the label stands alone, the next non-blank line.
 * "Bill to" is deliberately absent: it names the CUSTOMER, not the
 * seller. Hindi विक्रेता needs no colon; the English one-word labels
 * do (otherwise prose like "from the beginning" would match).
 */
const VENDOR_LABEL_RES: readonly LabelRe[] = [
  {
    re: /^(?:from|seller|vendor|sold\s+by|billed\s+by|billed\s+from)\s*[:\-]\s*(.+)$/i,
    hi: false,
  },
  {
    re: /^(?:from|seller|vendor|sold\s+by|billed\s+by|billed\s+from)\s*[:\-]?\s*$/i,
    hi: false,
  },
  { re: /^विक्रेता\s*(?:नाम)?\s*[:\-]?\s*(.*)$/, hi: true },
  { re: /^बिल-?कर्ता\s*[:\-]?\s*(.*)$/, hi: true },
];

/** Totals labels: slot + whether the label proves GST context. */
interface TotalLabel {
  re: RegExp;
  slot: keyof OcrInvoiceTotals;
  gst: boolean;
  hi: boolean;
}
const TOTAL_LABELS: readonly TotalLabel[] = [
  { re: /^(?:grand\s+)?total(?:\s+amount)?$/i, slot: "grand", gst: false, hi: false },
  { re: /^(?:total|amount)\s+(?:due|payable)$/i, slot: "grand", gst: false, hi: false },
  { re: /^balance\s+due$/i, slot: "grand", gst: false, hi: false },
  { re: /^net\s+(?:payable|amount)$/i, slot: "grand", gst: false, hi: false },
  { re: /^sub[\s-]?total$/i, slot: "subtotal", gst: false, hi: false },
  { re: /^taxable\s+(?:value|amount)$/i, slot: "subtotal", gst: false, hi: false },
  { re: /^(?:igst|integrated\s+tax)$/i, slot: "tax", gst: true, hi: false },
  { re: /^cgst$/i, slot: "cgst", gst: true, hi: false },
  { re: /^sgst$/i, slot: "sgst", gst: true, hi: false },
  { re: /^(?:gst|tax)(?:\s+amount)?$/i, slot: "tax", gst: true, hi: false },
  { re: /^कुल\s*(?:योग|राशि)?$/u, slot: "grand", gst: false, hi: true },
  { re: /^देय\s*राशि$/u, slot: "grand", gst: false, hi: true },
  { re: /^उप[\s-]?योग$/u, slot: "subtotal", gst: false, hi: true },
  { re: /^(?:जीएसटी|टैक्स)$/u, slot: "tax", gst: true, hi: true },
  { re: /^सीजीएसटी$/u, slot: "cgst", gst: true, hi: true },
  { re: /^एसजीएसटी$/u, slot: "sgst", gst: true, hi: true },
];

/** Sheet-title lines the vendor heuristic and item parser must skip. */
const TITLE_RE = /^(?:tax\s+)?(?:invoice|bill|receipt|proforma|quotation)\b/i;
const TITLE_HI_RE = /^(?:तैक्स\s*)?इनवॉइस$|^(?:टैक्स\s*)?बिल$|^रसीद$|^कर\s*बिल$/u;

/* ------------------------------------------------------------------ */
/* Item-row parsing                                                    */
/* ------------------------------------------------------------------ */

/**
 * Parse one non-label line as an item row.
 *
 * Supported shapes (a numeric tail after the description):
 *   "Widget Pro 2 × 599.00"        — qty × rate
 *   "Widget Pro 2 x 599"           — same with a plain x
 *   "Widget Pro 599.00 x2"         — rate × qty (rate first, small int after)
 *   "Widget Pro 2 599.00"          — bare qty + rate (rate must look like money)
 *   "Widget Pro 2 599.00 1198.00"  — qty + rate + amount (cross-checked:
 *                                     |qty×rate − amount| ≤ 0.5%, else refused)
 * An optional trailing "18%" (or "GST 18%") is kept as the row's tax
 * rate. Rows carrying a negative amount are rejected outright.
 */
function parseItemLine(line: string): OcrInvoiceItem | null {
  // Negative guard: a minus glued to a number ("Return fee -250.00").
  // Hyphenated ids are safe — the dash there never follows a space/start.
  if (/(^|\s)[-(]\s?\d/.test(line)) return null;
  let s = line.trim();
  if (!s) return null;
  let gst: string | undefined;
  const pct = /(?:gst\s*)?(\d+(?:\.\d+)?)\s*%\s*$/i.exec(s);
  if (pct) {
    gst = pct[1];
    s = s
      .replace(/(?:gst\s*)?\d+(?:\.\d+)?\s*%\s*$/i, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  const N = String.raw`\d[\d,]*(?:\.\d+)?`;
  // "A × B" — either order; see normXRow for the tie-break
  let m = new RegExp(`^(.+?)\\s+(${N})\\s*[×xX]\\s*(${N})$`, "u").exec(s);
  if (m) {
    const row = normXRow(m[1], m[2], m[3]);
    if (row) return withGst(row, gst);
  }
  // three numeric tails: qty rate amount (cross-checked)
  m = new RegExp(`^(.+?)\\s+(${N})\\s+(${N})\\s+(${N})$`, "u").exec(s);
  if (m) {
    const q = normNumber(m[2]);
    const r = normNumber(m[3]);
    const a = normNumber(m[4]);
    if (q !== null && r !== null && a !== null) {
      const qv = numValue(q);
      const rv = numValue(r);
      const av = numValue(a);
      if (
        qv !== null && rv !== null && av !== null && qv > 0 && rv > 0 &&
        Math.abs(qv * rv - av) <= Math.max(0.02, av * 0.005)
      ) {
        return withGst({ d: m[1].trim(), q, r }, gst);
      }
    }
    return null; // numbers that do not add up are NOT an item — honest refuse
  }
  // two numeric tails: qty + rate (the rate must look like money)
  m = new RegExp(`^(.+?)\\s+(${N})\\s+(${N})$`, "u").exec(s);
  if (m) {
    const q = normNumber(m[2]);
    const r = normNumber(m[3]);
    const qv = q !== null ? numValue(q) : null;
    const rv = r !== null ? numValue(r) : null;
    if (
      q !== null && r !== null && qv !== null && rv !== null &&
      qv > 0 && qv <= 9999 && rv > 0 &&
      (/\./.test(r) || rv <= 9999)
    ) {
      return withGst({ d: m[1].trim(), q, r }, gst);
    }
  }
  return null;
}

/**
 * "A × B" tie-break: when A carries decimals and B is a small integer,
 * the row is rate-first ("250.00 x2"); otherwise qty-first ("2 × 250").
 * Neither side being a sane quantity (< 10000, plain) refuses the row.
 */
function normXRow(desc: string, a: string, b: string): OcrInvoiceItem | null {
  const na = normNumber(a);
  const nb = normNumber(b);
  if (na === null || nb === null) return null;
  const va = numValue(na);
  const vb = numValue(nb);
  if (va === null || vb === null || va <= 0 || vb <= 0) return null;
  if (/\./.test(na) && /^\d{1,4}$/.test(nb)) return { d: desc.trim(), q: nb, r: na };
  if (!/^\d{1,4}$/.test(na)) return null;
  return { d: desc.trim(), q: na, r: nb };
}

function withGst(item: OcrInvoiceItem, gst: string | undefined): OcrInvoiceItem {
  return gst === undefined ? item : { ...item, g: gst };
}

/* ------------------------------------------------------------------ */
/* Totals-line matching                                                */
/* ------------------------------------------------------------------ */

interface TotalHit {
  slot: keyof OcrInvoiceTotals;
  value: string | null;
  gst: boolean;
}

/** Label text + trailing number for one totals label (or null). */
function totalLineParts(
  line: string,
  labelRe: RegExp
): { label: string; num?: string } | null {
  // Strip currency decoration between label and number, then split.
  const s = latinDigits(line)
    .replace(/[₹$€£]/g, " ")
    .replace(/\brs\b\.?/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const m = /^(.+?)[\s:–—]*((?:\d[\d,]*(?:\.\d+)?)(?:\s*\/-)?)$/.exec(s);
  if (!m) return null;
  const label = m[1].replace(/[\s:–—-]+$/, "").trim();
  if (!label || !labelRe.test(label)) return null;
  return { label, num: m[2].replace(/\s*\/-$/, "") };
}

/** Match "Label [₹] number" against the totals label table (locale-aware). */
function matchTotalLine(line: string, isHi: boolean): TotalHit | null {
  for (const tl of TOTAL_LABELS) {
    if (tl.hi && !isHi) continue;
    const parts = totalLineParts(line, tl.re);
    if (!parts) continue;
    const value = parts.num !== undefined ? normNumber(parts.num) : null;
    return { slot: tl.slot, value, gst: tl.gst };
  }
  return null;
}

/** Does this line carry any known label prefix (no/dates/vendor/totals)? */
function looksLikeLabelLine(line: string, isHi: boolean): boolean {
  const tables = [INVOICE_NO_RES, DATE_LABEL_RES, DUE_LABEL_RES, VENDOR_LABEL_RES];
  for (const table of tables) {
    for (const lr of table) {
      if (lr.hi && !isHi) continue;
      if (lr.re.exec(line)) return true;
    }
  }
  for (const tl of TOTAL_LABELS) {
    if (tl.hi && !isHi) continue;
    if (totalLineParts(line, tl.re)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* The extractor                                                       */
/* ------------------------------------------------------------------ */

/**
 * Extract an invoice draft from recognized page texts.
 *
 * @param pages recognized text per page (order preserved)
 * @param locale "en" accepts English labels; "hi" accepts Hindi AND
 *   English labels (real-world हिंदी invoices mix both)
 * @returns only the fields actually found, or null when nothing
 *   label-matched (prose/garbage — honestly not an invoice)
 */
export function extractInvoiceDraft(
  pages: string[],
  locale: "en" | "hi"
): OcrInvoiceDraft | null {
  const lines: string[] = [];
  for (const page of pages) {
    for (const raw of String(page ?? "").split(/\r?\n/)) {
      const t = raw.trim();
      if (t) lines.push(t);
    }
  }
  const isHi = locale === "hi";

  let labelHits = 0;
  let invoiceNumber: string | undefined;
  let date: string | undefined;
  let dueDate: string | undefined;
  let vendor: string | undefined;
  let vendorNextLine = false;
  const totals: OcrInvoiceTotals = {};
  let gstFound = false;
  let currency: OcrInvoiceDraft["currency"];
  const items: OcrInvoiceItem[] = [];
  let itemsCapped = false;

  for (const line of lines) {
    let consumed = false;

    // --- invoice number (label required, never a bare number) ---
    if (invoiceNumber === undefined) {
      for (const lr of INVOICE_NO_RES) {
        if (lr.hi && !isHi) continue;
        const m = lr.re.exec(line);
        if (m && /\d/.test(m[1])) {
          invoiceNumber = m[1];
          labelHits += 1;
          consumed = true;
          break;
        }
      }
    }

    // --- dates (value must parse as a real calendar date) ---
    if (date === undefined) {
      for (const lr of DATE_LABEL_RES) {
        if (lr.hi && !isHi) continue;
        const m = lr.re.exec(line);
        if (m) {
          const iso = parseDateValue(m[1]);
          if (iso) {
            date = iso;
            labelHits += 1;
            consumed = true;
            break;
          }
        }
      }
    }
    if (dueDate === undefined) {
      for (const lr of DUE_LABEL_RES) {
        if (lr.hi && !isHi) continue;
        const m = lr.re.exec(line);
        if (m) {
          const iso = parseDateValue(m[1]);
          if (iso) {
            dueDate = iso;
            labelHits += 1;
            consumed = true;
            break;
          }
        }
      }
    }

    // --- vendor (labelled) / pending value on the next line ---
    if (vendor === undefined) {
      if (vendorNextLine) {
        const name = line.replace(/^[•\-\s]+/, "").trim();
        if (name && name.length <= 80 && !looksLikeLabelLine(name, isHi)) {
          vendor = name;
          labelHits += 1;
        }
        vendorNextLine = false;
        consumed = true;
      } else {
        for (const lr of VENDOR_LABEL_RES) {
          if (lr.hi && !isHi) continue;
          const m = lr.re.exec(line);
          if (m) {
            const rest = (m[1] ?? "").trim();
            if (rest) {
              vendor = rest.slice(0, 80);
              labelHits += 1;
            } else {
              vendorNextLine = true; // "Seller:" alone — value follows
            }
            consumed = true;
            break;
          }
        }
      }
    }

    // --- totals (labelled lines only, last match wins) ---
    const hit = matchTotalLine(line, isHi);
    if (hit) {
      if (hit.value !== null) {
        totals[hit.slot] = hit.value;
        labelHits += 1;
        if (hit.gst) gstFound = true;
      }
      consumed = true;
    }

    // --- item rows: only plain, unlabelled, untitle'd lines ---
    if (
      !consumed &&
      !looksLikeLabelLine(line, isHi) &&
      !TITLE_RE.test(line) &&
      !(isHi && TITLE_HI_RE.test(line))
    ) {
      const item = parseItemLine(line);
      if (item && item.d.length >= 2) {
        if (items.length < MAX_OCR_ITEMS) {
          items.push(item);
        } else {
          itemsCapped = true; // honest truncation at the cap
        }
      }
    }
  }

  // --- currency: only from the labelled totals lines ---
  if (currency === undefined) {
    for (const line of lines) {
      if (!matchTotalLine(line, isHi)) continue;
      const c = currencyOfLine(line);
      if (c) {
        currency = c;
        break;
      }
    }
  }

  // Nothing label-matched — prose/garbage, honestly not an invoice.
  if (labelHits === 0) return null;

  // Vendor heuristic (documented, honest): the first non-blank line
  // that is neither a sheet title, a label line nor a number-led
  // fragment. Runs only when other label evidence exists.
  if (vendor === undefined) {
    for (const line of lines) {
      if (TITLE_RE.test(line) || (isHi && TITLE_HI_RE.test(line))) continue;
      if (looksLikeLabelLine(line, isHi)) continue;
      if (NUM_RE.test(line)) continue;
      const name = line.replace(/^[•\-\s]+/, "").trim();
      if (name.length >= 2 && name.length <= 60) {
        vendor = name;
        break;
      }
    }
  }

  return {
    ...(invoiceNumber !== undefined ? { invoiceNumber } : {}),
    ...(date !== undefined ? { date } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(vendor !== undefined ? { vendor } : {}),
    ...(currency !== undefined ? { currency } : {}),
    totals,
    gstFound,
    items,
    itemsCapped,
  };
}

/** Currency symbol/word on a totals line (₹/INR/Rs → INR, $/USD, €/EUR, £/GBP). */
function currencyOfLine(line: string): OcrInvoiceDraft["currency"] | undefined {
  if (/₹|\bINR\b|\bRs\.?\b/i.test(line)) return "INR";
  if (/\$|\bUSD\b/i.test(line)) return "USD";
  if (/€|\bEUR\b/i.test(line)) return "EUR";
  if (/£|\bGBP\b/i.test(line)) return "GBP";
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Prefill key codec (localStorage round-trip, pure string <-> string) */
/* ------------------------------------------------------------------ */

const CURRENCIES = ["INR", "USD", "EUR", "GBP"] as const;

function capStr(v: unknown, max: number): string | undefined {
  const s = typeof v === "string" ? v.trim().slice(0, max) : "";
  return s || undefined;
}

/**
 * Serialize a draft for the prefill key: {fields, savedAt}. `now` is a
 * parameter so the codec stays a pure function of its inputs.
 */
export function serializeOcrPrefill(draft: OcrInvoiceDraft, now = 0): string {
  return JSON.stringify({ fields: draft, savedAt: now });
}

/**
 * Parse the prefill payload back into a validated draft (null on corrupt
 * input). Every field is capped/coerced exactly like the editor state —
 * a tampered or stale key can never inject a wrong type or huge strings.
 */
export function parseOcrPrefill(raw: string | null): OcrInvoiceDraft | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  if (typeof o.fields !== "object" || o.fields === null) return null;
  const d = o.fields as Record<string, unknown>;
  const tr = (typeof d.totals === "object" && d.totals !== null ? d.totals : {}) as Record<
    string,
    unknown
  >;
  // Sparse construction — a field the payload did not carry is ABSENT,
  // exactly like extractInvoiceDraft's result ("in" checks stay honest).
  const draft: OcrInvoiceDraft = {
    ...(capStr(d.invoiceNumber, 32) !== undefined
      ? { invoiceNumber: capStr(d.invoiceNumber, 32) }
      : {}),
    ...(isoOK(String(d.date ?? "")) ? { date: String(d.date) } : {}),
    ...(isoOK(String(d.dueDate ?? "")) ? { dueDate: String(d.dueDate) } : {}),
    ...(capStr(d.vendor, 200) !== undefined
      ? { vendor: capStr(d.vendor, 200) }
      : {}),
    ...(typeof d.currency === "string" &&
    (CURRENCIES as readonly string[]).includes(d.currency)
      ? { currency: d.currency as OcrInvoiceDraft["currency"] }
      : {}),
    totals: {
      ...(capStr(tr.subtotal, 32) !== undefined
        ? { subtotal: capStr(tr.subtotal, 32) }
        : {}),
      ...(capStr(tr.tax, 32) !== undefined ? { tax: capStr(tr.tax, 32) } : {}),
      ...(capStr(tr.cgst, 32) !== undefined ? { cgst: capStr(tr.cgst, 32) } : {}),
      ...(capStr(tr.sgst, 32) !== undefined ? { sgst: capStr(tr.sgst, 32) } : {}),
      ...(capStr(tr.grand, 32) !== undefined ? { grand: capStr(tr.grand, 32) } : {}),
    },
    gstFound: d.gstFound === true,
    items: [],
    itemsCapped: d.itemsCapped === true,
  };
  if (Array.isArray(d.items)) {
    for (const it of d.items.slice(0, MAX_OCR_ITEMS)) {
      if (typeof it !== "object" || it === null) continue;
      const rec = it as Record<string, unknown>;
      const desc = capStr(rec.d, 2000);
      const q = capStr(rec.q, 32);
      const r = capStr(rec.r, 32);
      const g = capStr(rec.g, 8);
      if (!desc || !q || !r) continue;
      draft.items.push(g !== undefined ? { d: desc, q, r, g } : { d: desc, q, r });
    }
  }
  if (
    draft.invoiceNumber === undefined &&
    draft.date === undefined &&
    draft.dueDate === undefined &&
    draft.vendor === undefined &&
    draft.currency === undefined &&
    draft.items.length === 0 &&
    Object.values(draft.totals).every((v) => v === undefined)
  ) {
    return null; // nothing usable inside — treat as absent
  }
  return draft;
}

/* ------------------------------------------------------------------ */
/* Worker-detail reader (validated read for the UI side)               */
/* ------------------------------------------------------------------ */

/**
 * Read the ocr worker's `pageTexts` out of a run detail (the field is
 * unknown to the shared protocol): returns them only when the value is
 * a real array of bounded strings — anything else is honestly undefined.
 */
export function readOcrPageTexts(detail: unknown): string[] | undefined {
  const o = (typeof detail === "object" && detail !== null ? detail : {}) as Record<
    string,
    unknown
  >;
  const v = o.pageTexts;
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const p of v.slice(0, 200)) {
    if (typeof p !== "string") return undefined;
    out.push(p.length > 20_000 ? p.slice(0, 20_000) : p);
  }
  return out;
}
