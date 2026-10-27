import {
  type InvoiceFacts,
} from "./cii-build";
import { pageLines, type RawTextItem } from "../pdf-to-markdown/md-build";

/**
 * PDF → invoice-facts extraction core (Task b6-c) — PURE heuristics
 * plus a pdf.js-injected reader. The same heuristics power BOTH tools
 * (create-electronic-invoice and pdf-to-e-invoice); the worker passes
 * the self-hosted pdf.js (fake-worker mode), the smoke passes the npm
 * legacy build — the code below runs identically in both.
 *
 * STRATEGY (every heuristic is a documented regex; all return null on
 * no-match — MyCloudy never guesses a value it did not see):
 *
 *   invoice number — the label regex
 *     /(?:invoice|inv|bill|rechnungs?)(?:\s*(?:no|nr|number|nummer|#))?[\s:#.]*([A-Z0-9][A-Z0-9/-]{2,20})/i
 *     scanned near the top (page 1's top third first, then page 1,
 *     then the remaining pages). The capture must contain a digit, so
 *     "Bill To:" / "Invoice Date:" never yield a fake number. The
 *     separator class accepts "No." / "Nr." / "Rechnungsnr." periods
 *     and the German compound "Rechnungs…" forms (b6-c2 fix: the
 *     period-separated labels never matched before).
 *
 *   issue date — /(?:date|dated|datum)\D{0,12}(<date>)/ with the ISO
 *     form tried BEFORE the d-m-y form (alternation order prevents the
 *     "24-01-15" partial match inside "2024-01-15"); dd-mm-yyyy vs
 *     mm-dd-yyyy is resolved by the >12 components (a first component
 *     > 12 means day-first, a second component > 12 means month-first;
 *     ambiguous dates default to European day-first). Lines mentioning
 *     "due" / "valid until" / "fällig" are skipped (that is the due
 *     date, not the issue date). 2-digit years become 20yy.
 *
 *   currency — symbol scan first (€ → EUR, ₹ → INR, £ → GBP, $ → USD),
 *     else an ISO code (USD|EUR|INR|GBP) on a totals-ish line, else
 *     the code anywhere, else EUR with an "assumed" note.
 *
 *   VAT id — GSTIN (15-char Indian pattern) or EU-shaped
 *     /[A-Z]{2}[A-Z0-9]{2,13}/ tokens that contain a digit, on lines
 *     labelled vat / tax id / USt / MwSt / GST. Plain words like
 *     "INVOICE" never qualify (no digit).
 *
 *   seller / buyer — STRATEGY A (labels): a line starting
 *     from|seller|supplier|rechnungsteller vs
 *     bill to|sold to|invoice to|buyer|rechnungsempfänger|to — the
 *     text after the colon is the name, or the next non-empty line
 *     when the label stands alone. STRATEGY B (fallback, documented):
 *     the first non-empty non-title line is the seller, the first
 *     non-empty line after the first blank gap is the buyer.
 *
 *   totals — the RIGHTMOST money token on a line matching
 *     /(?:grand|total due|amount due|balance due|gesamtbetrag|gesamt|payable)/i
 *     is the grand total (word-ish match, so "Subtotal" never
 *     qualifies) — EXCEPT amount-due keyword lines, which only backfill
 *     the grand total when no explicit grand line was seen (b6-c2 fix:
 *     a partially-paid invoice's "Amount Due" used to clobber its
 *     "Grand Total"); a documented fallback also accepts a line whose
 *     whole label part is just "Total"/"Summe" — the most common
 *     invoice shape. Date-shaped tokens ("Payable by: 20.07.2024")
 *     are stripped before the money scan so a year never poses as an
 *     amount. taxBasis is the same rule over
 *     /(?:subtotal|net amount|taxable|zwischensumma|netto)/i; tax =
 *     grand − taxBasis when both were seen; duePayable takes the
 *     amount-due line when present, else defaults to the grand total.
 *     European decimals ("1.234,56" and "1234.56" and "1,234.56") are
 *     parsed to INTEGER CENTS by string surgery — never binary floats.
 *
 * The LAST matching line wins for totals (the totals block sits at the
 * bottom of invoices). ALL misses are null; the report says what was
 * found, what was missing and what was assumed.
 *
 * iOS-safe (worklog IOS-COMPAT): no matchAll/replaceAll, no regex
 * lookbehind, no Object.hasOwn / structuredClone.
 */

/** Invoice pages read before heuristics stop (header + totals live here). */
export const MAX_EXTRACT_PAGES = 4;

/** A structural slice of pdf.js — enough for getDocument().promise. */
export interface EInvPdfjsLike {
  getDocument(
    params: Record<string, unknown>
  ): { promise: Promise<EInvDocLike>; destroy?: () => Promise<void> };
}

/** Structural slice of pdf.js's document. */
export interface EInvDocLike {
  numPages: number;
  getPage(pageNumber: number): Promise<EInvPageLike>;
  cleanup(): void;
  /** Destroys the document instance + its transport (the pinned rule). */
  destroy(): Promise<void>;
}

/** Structural slice of pdf.js's page — enough for text extraction. */
export interface EInvPageLike {
  getTextContent(): Promise<{ items: unknown[] }>;
  cleanup(): void;
}

/* ------------------------------------------------------------------ */
/* Money parsing — integer cents, string surgery only                  */
/* ------------------------------------------------------------------ */

/** Separator characters that may appear INSIDE a money token. */
const MONEY_SEP_CHARS = new Set([".", ",", "\u00a0"]);

/** True when the character is a plain ASCII digit. */
function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

/**
 * Scans one line for money-shaped tokens: a digit, then digits and
 * single separators (each separator must be followed by a digit to
 * continue the token). "Grand Total: 1.234,56 €" → ["1.234,56"];
 * "15/01/2024" → ["15", "01", "2024"] (slashes break tokens — the
 * rightmost rule on totals lines then picks the amount, not the date).
 */
export function scanMoneyTokens(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (!isDigit(line[i])) {
      i += 1;
      continue;
    }
    const start = i;
    let lastDigit = i;
    let j = i + 1;
    while (j < line.length) {
      const c = line[j];
      if (isDigit(c)) {
        lastDigit = j;
        j += 1;
        continue;
      }
      if (MONEY_SEP_CHARS.has(c)) {
        // A separator continues the token only when a digit follows it.
        let k = j;
        while (k < line.length && MONEY_SEP_CHARS.has(line[k])) k += 1;
        if (k < line.length && isDigit(line[k])) {
          j = k;
          continue;
        }
      }
      break;
    }
    const token = line.slice(start, lastDigit + 1);
    if (token.length <= 20) tokens.push(token);
    i = lastDigit + 1;
  }
  return tokens;
}

/**
 * Parses one money token to INTEGER CENTS. String surgery only:
 *
 *   - both separators present → the LAST one is the decimal separator
 *     (European "1.234,56" and US "1,234.56" both resolve);
 *   - one separator → decimal when exactly 1-2 digits follow it
 *     ("119,00", "119.5"), grouping otherwise (European "1.234" →
 *     1234 units; "1,234,567" → grouping too);
 *   - more than 2 fraction digits round half-up at digit 3;
 *   - returns null when the token is not a money shape.
 */
export function parseMoneyCents(token: string): number | null {
  const clean = token.replace(/\u00a0/g, "");
  if (clean.length === 0 || clean.length > 20) return null;
  if (!isDigit(clean[0])) return null;
  for (const ch of clean) {
    if (!isDigit(ch) && ch !== "." && ch !== ",") return null;
  }
  const lastDot = clean.lastIndexOf(".");
  const lastComma = clean.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) {
    // Both separators: the last one is decimal, the other groups.
    const decimalSep = Math.max(lastDot, lastComma);
    const groupSep = decimalSep === lastDot ? "," : ".";
    const groupRemoved = clean.split(groupSep).join("");
    return intCharsToCents(groupRemoved, clean[decimalSep]);
  }
  const sepAt = lastDot !== -1 ? lastDot : lastComma;
  if (sepAt === -1) {
    return intCharsToCents(clean, "");
  }
  const sep = clean[sepAt] as string;
  const after = clean.length - sepAt - 1;
  // One separator followed by 1-2 digits → decimal; everything else
  // (3+ digits, or multiple separators) → grouping.
  const isMultiple = clean.split(sep).length - 1 > 1;
  if (after <= 2 && !isMultiple) {
    return intCharsToCents(clean, sep);
  }
  return intCharsToCents(clean.split(sep).join(""), "");
}

/**
 * Splits on the decimal separator ("" when none) and computes
 * units*100 + fracCents with integer math; >2 fraction digits round
 * half-up from the third digit. Null when malformed or > 15 unit digits.
 */
function intCharsToCents(text: string, decimalSep: string): number | null {
  let units = text;
  let frac = "00";
  if (decimalSep !== "") {
    const at = text.indexOf(decimalSep);
    if (at === -1) return null;
    units = text.slice(0, at);
    frac = text.slice(at + 1);
  }
  if (units.length === 0) units = "0";
  if (units.length > 15) return null;
  if (!/^\d+$/.test(units)) return null;
  let fracCents: number;
  if (frac.length === 0) {
    fracCents = 0;
  } else if (!/^\d+$/.test(frac)) {
    return null;
  } else if (frac.length <= 2) {
    fracCents = Number(frac) * (frac.length === 1 ? 10 : 1);
  } else {
    // Round half-up at the third fraction digit (integer math).
    const head = Number(frac.slice(0, 2));
    const tail = Number(frac[2]);
    fracCents = head + (tail >= 5 ? 1 : 0);
    if (fracCents >= 100) return null; // nonsense like ",999" — not money
  }
  // Safe integer accumulation (≤ 15 unit digits stays under 2^53).
  let unitsValue = 0;
  for (const ch of units) {
    unitsValue = unitsValue * 10 + (ch.charCodeAt(0) - 48);
  }
  return unitsValue * 100 + fracCents;
}

/**
 * The RIGHTMOST money token of a line parsed to cents (the spec's
 * totals rule), or null when no token parses.
 */
export function rightmostMoney(line: string): number | null {
  const tokens = scanMoneyTokens(line);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const cents = parseMoneyCents(tokens[i] as string);
    if (cents !== null) return cents;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Field heuristics (pure — string[][] = per-page line arrays)         */
/* ------------------------------------------------------------------ */

/** Invoice-number label regex (top-of-document scan). The German
 * compound ("Rechnungsnr.", "Rechnungsnummer") and the period after
 * "No."/"Nr." are part of the label — [\s:#.]* bridges them. */
const INVOICE_NO_RE =
  /(?:invoice|inv|bill|rechnungs?)(?:\s*(?:no|nr|number|nummer|#))?[\s:#.]*([A-Z0-9][A-Z0-9/-]{2,20})(?![A-Z0-9/-])/i;

/** A date-shaped token (dd.mm.yyyy, dd/mm/yy, yyyy-mm-dd) — stripped
 * from totals lines before the money scan so a year is never an amount. */
const DATE_TOKEN_RE = /\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/g;

/** Labeled date regex — ISO first (alternation order matters), then d-m-y. */
const DATE_LABELED_RE =
  /\b(?:date|dated|datum)\D{0,12}?(\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})(?!\d)/i;

/** ISO date fallback when no label matched (scanned anywhere). */
const DATE_ISO_FALLBACK_RE = /(?:^|\D)(\d{4}-\d{2}-\d{2})(?!\d)/;

/** Due-date markers — lines carrying these never yield the issue date. */
const DATE_SKIP_LINE_RE = /due|valid\s+until|f(?:ä|ae)llig|payable\s+by/i;

/** Totals-ish line marker for the currency-code scan. */
const TOTALS_LINE_RE =
  /total|amount|due|balance|payable|summe|gesamt|subtotal|netto/i;

/** Grand-total keywords (word-ish: "Subtotal" must NOT match). */
const GRAND_TOTAL_RE =
  /(?:^|[^a-z])(?:grand|total\s+due|amount\s+due|balance\s+due|gesamtbetrag|gesamt|payable)/i;

/** Net / tax-basis keywords. */
const TAX_BASIS_RE =
  /(?:^|[^a-z])(?:subtotal|net\s+amount|taxable|zwischensumme|netto)/i;

/** Amount-due keywords (drives duePayable when it differs from grand). */
const AMOUNT_DUE_RE =
  /(?:^|[^a-z])(?:total\s+due|amount\s+due|balance\s+due|payable)/i;

/** Bare "Total: 119,00" line — the label part must be only Total/Summe. */
const BARE_TOTAL_RE = /^\s*(?:total|summe)\s*[:\-]?\s*$/i;

/** VAT/GST label words. */
const VAT_LABEL_RE =
  /\b(?:vat|tax\s*id|tax\s*no|ust(?:\s*(?:id|nr))?|mwst|gst|gstin)\b/i;

/** Indian GSTIN (15 chars: 2 digits, 5 letters, 4 digits, letter, Z, alnum). */
const GSTIN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b/;

/** EU VAT-shaped token (post-filtered to digit-carrying tokens). */
const EU_VAT_RE = /\b([A-Z]{2}[A-Z0-9]{2,13})\b/;

/** Seller label line (Strategy A — colon, whitespace or EOL must follow). */
const SELLER_LABEL_RE =
  /^\s*[>(*\-]*(?:from|seller|supplier|rechnungsteller|verk(?:ä|ae)ufer)(?:\s*:|\s+|$)\s*(.*)$/i;

/**
 * Buyer label line (Strategy A — longer alternatives before "to";
 * a colon, whitespace or EOL must follow, so "Total:" never yields a
 * buyer named "tal: …").
 */
const BUYER_LABEL_RE =
  /^\s*[>(*\-]*(?:bill\s*to|sold\s*to|invoice\s*to|buyer|rechnungsempf(?:ä|ae)nger|to)(?:\s*:|\s+|$)\s*(.*)$/i;

/** Pure invoice-title lines never serve as the fallback seller name. */
const TITLE_LINE_RE =
  /^\s*(?:(?:tax|proforma|final|commercial|export)\s+)*(?:invoice|rechnung|bill|receipt|statement|estimate|quotation)(?:\s+(?:invoice|note|memo))?\s*#?\s*\d*\s*$/i;

/** Currency symbols → ISO codes, in scan priority order. */
const CURRENCY_SYMBOLS: { probe: string; code: string }[] = [
  { probe: "€", code: "EUR" },
  { probe: "₹", code: "INR" },
  { probe: "£", code: "GBP" },
  { probe: "$", code: "USD" },
];

/** ISO currency codes accepted near totals / anywhere. */
const CURRENCY_CODE_RE = /\b(USD|EUR|INR|GBP)\b/;

/** A name candidate needs at least two letters and no inner colon. */
function isNameLike(text: string): boolean {
  const letters = text.replace(/[^A-Za-zÀ-ɏ\u0900-\u097F]/g, "");
  return (
    letters.length >= 2 && text.length <= 80 && text.indexOf(":") === -1
  );
}

/** All non-empty lines flattened, in reading order. */
function flatLines(pages: string[][]): string[] {
  const out: string[] = [];
  for (const lines of pages) {
    for (const line of lines) {
      if (line.trim().length > 0) out.push(line);
    }
  }
  return out;
}

/**
 * Invoice number — page 1 top third first, then page 1, then the rest.
 * The capture must carry a digit (kills "Bill To:" / "Invoice Date:").
 */
export function findInvoiceNumber(pages: string[][]): string | null {
  const page1 = pages.length > 0 ? pages[0] : [];
  const topThird = page1.slice(0, Math.max(1, Math.ceil(page1.length / 3)));
  const scanOrders = [topThird, page1, flatLines(pages.slice(1))];
  for (const lines of scanOrders) {
    for (const line of lines) {
      const match = INVOICE_NO_RE.exec(line);
      if (match === null) continue;
      const candidate = match[1] ?? "";
      if (candidate.length >= 3 && /\d/.test(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/** Parses d/m/y components with the >12 disambiguation rule. */
function resolveDate(
  a: number,
  b: number,
  year: number
): { iso: string; dayFirst: boolean } | null {
  let day = a;
  let month = b;
  let dayFirst = true;
  if (a > 12 && b <= 12) {
    day = a;
    month = b; // explicit day-first
  } else if (b > 12 && a <= 12) {
    day = b;
    month = a; // explicit month-first
    dayFirst = false;
  } // else: ambiguous → European day-first default
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const y = year < 100 ? 2000 + year : year;
  return {
    iso: `${y}-${month < 10 ? `0${month}` : `${month}`}-${
      day < 10 ? `0${day}` : `${day}`
    }`,
    dayFirst,
  };
}

/**
 * Issue date — labeled dates first (due-date lines skipped), then the
 * ISO fallback anywhere. 2-digit years become 20yy.
 */
export function findIssueDate(pages: string[][]): string | null {
  const all = flatLines(pages);
  for (const line of all) {
    if (DATE_SKIP_LINE_RE.test(line)) continue;
    const match = DATE_LABELED_RE.exec(line);
    if (match === null) continue;
    const raw = match[1] ?? "";
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (iso !== null) {
      return raw; // ISO passes through (already YYYY-MM-DD)
    }
    const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(raw);
    if (dmy !== null) {
      const resolved = resolveDate(
        Number(dmy[1]),
        Number(dmy[2]),
        Number(dmy[3])
      );
      if (resolved !== null) return resolved.iso;
    }
  }
  for (const line of all) {
    const iso = DATE_ISO_FALLBACK_RE.exec(line);
    if (iso !== null) return iso[1] ?? null;
  }
  return null;
}

/**
 * Currency — symbol scan (full text, first hit wins), else ISO code on
 * totals-ish lines, else ISO code anywhere, else EUR (assumed).
 */
export function findCurrency(
  pages: string[][]
): { code: string; assumed: boolean; source: string } {
  const all = flatLines(pages);
  for (const line of all) {
    for (const sym of CURRENCY_SYMBOLS) {
      if (line.indexOf(sym.probe) !== -1) {
        return { code: sym.code, assumed: false, source: "symbol" };
      }
    }
  }
  const totalsLines = all.filter((line) => TOTALS_LINE_RE.test(line));
  for (const line of totalsLines) {
    const code = CURRENCY_CODE_RE.exec(line);
    if (code !== null) {
      return { code: code[1] as string, assumed: false, source: "code near totals" };
    }
  }
  for (const line of all) {
    const code = CURRENCY_CODE_RE.exec(line);
    if (code !== null) {
      return { code: code[1] as string, assumed: false, source: "code" };
    }
  }
  return { code: "EUR", assumed: true, source: "default" };
}

/**
 * Seller VAT id / GSTIN — GSTIN first, then EU-shaped digit-carrying
 * tokens, on VAT-labelled lines only.
 */
export function findVatId(pages: string[][]): string | null {
  const all = flatLines(pages);
  for (const line of all) {
    if (!VAT_LABEL_RE.test(line)) continue;
    const gstin = GSTIN_RE.exec(line);
    if (gstin !== null) return gstin[1] ?? null;
    const eu = EU_VAT_RE.exec(line);
    if (eu !== null && /\d/.test(eu[1] ?? "")) return eu[1] ?? null;
  }
  // Second pass without the label requirement for the GSTIN shape —
  // Indian invoices print the GSTIN header prominently.
  for (const line of all) {
    const gstin = GSTIN_RE.exec(line);
    if (gstin !== null) return gstin[1] ?? null;
  }
  return null;
}

/**
 * Seller name — Strategy A (label line), else the fallback (first
 * non-empty non-title line). Returns null when nothing name-like.
 */
export function findSeller(pages: string[][]): string | null {
  const all = flatLines(pages);
  for (let i = 0; i < all.length; i += 1) {
    const line = all[i] as string;
    const match = SELLER_LABEL_RE.exec(line);
    if (match === null) continue;
    const rest = (match[1] ?? "").trim();
    if (isNameLike(rest)) return rest;
    // Label alone — the next non-empty line carries the name.
    for (let j = i + 1; j < Math.min(all.length, i + 4); j += 1) {
      const next = (all[j] as string).trim();
      if (isNameLike(next)) return next;
      if (next.length > 0) break;
    }
  }
  for (const line of all) {
    const trimmed = line.trim().replace(/^[>(*\-]+\s*/, "");
    if (trimmed.length === 0 || TITLE_LINE_RE.test(trimmed)) continue;
    if (isNameLike(trimmed)) return trimmed;
  }
  return null;
}

/**
 * Buyer name — Strategy A (label line), else the fallback (first
 * non-empty line after the first blank gap near the top).
 */
export function findBuyer(pages: string[][]): string | null {
  const all = flatLines(pages);
  for (let i = 0; i < all.length; i += 1) {
    const line = all[i] as string;
    const match = BUYER_LABEL_RE.exec(line);
    if (match === null) continue;
    const rest = (match[1] ?? "").trim();
    if (isNameLike(rest)) return rest;
    for (let j = i + 1; j < Math.min(all.length, i + 4); j += 1) {
      const next = (all[j] as string).trim();
      if (isNameLike(next)) return next;
      if (next.length > 0) break;
    }
  }
  // Fallback: seller = first non-empty line; buyer = first non-empty
  // line after the first blank gap that follows it.
  const rawLines = pages.length > 0 ? pages[0] : [];
  let sawSeller = false;
  let pastGap = false;
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (sawSeller) pastGap = true;
      continue;
    }
    if (!sawSeller) {
      sawSeller = true; // the fallback seller (or a title line above it)
      continue;
    }
    if (pastGap && isNameLike(trimmed) && !TITLE_LINE_RE.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

/** The totals triple the heuristics can see (null when unseen). */
export interface TotalsFacts {
  grand: number | null;
  taxBasis: number | null;
  due: number | null;
}

/**
 * Totals — LAST matching line wins (totals live at the bottom).
 * grand: the spec keyword lines, then the bare "Total:"/“Summe:”
 * fallback, then (only when nothing else was seen) an amount-due line —
 * a partially-paid invoice's "Amount Due" must never clobber the
 * explicit "Grand Total" (the b6-c2 fix). taxBasis: the net keywords;
 * due: the amount-due lines. Date-shaped tokens are stripped first
 * ("Payable by: 20.07.2024" carries no amount).
 */
export function findTotals(pages: string[][]): TotalsFacts {
  const all = flatLines(pages);
  let grand: number | null = null;
  let grandFallback: number | null = null;
  let grandFromDue: number | null = null;
  let basis: number | null = null;
  let due: number | null = null;
  for (const rawLine of all) {
    const line = rawLine.replace(DATE_TOKEN_RE, " ");
    if (GRAND_TOTAL_RE.test(line)) {
      const cents = rightmostMoney(line);
      if (cents !== null) {
        if (AMOUNT_DUE_RE.test(line)) {
          grandFromDue = cents;
        } else {
          grand = cents;
        }
      }
    }
    if (BARE_TOTAL_RE.test(stripTrailingMoney(line))) {
      const cents = rightmostMoney(line);
      if (cents !== null) grandFallback = cents;
    }
    if (TAX_BASIS_RE.test(line)) {
      const cents = rightmostMoney(line);
      if (cents !== null) basis = cents;
    }
    if (AMOUNT_DUE_RE.test(line)) {
      const cents = rightmostMoney(line);
      if (cents !== null) due = cents;
    }
  }
  if (grand === null) grand = grandFallback;
  if (grand === null) grand = grandFromDue;
  // Sanity: a basis above the grand total is nonsense — discard it.
  if (grand !== null && basis !== null && basis > grand) basis = null;
  return { grand, taxBasis: basis, due };
}

/**
 * Removes the trailing money token plus currency crumbs (code or
 * symbol) from a line — the bare-"Total:" fallback then checks that
 * the residue is exactly the word Total/Summe.
 */
function stripTrailingMoney(line: string): string {
  const tokens = scanMoneyTokens(line);
  if (tokens.length === 0) return line;
  const last = tokens[tokens.length - 1] as string;
  const at = line.lastIndexOf(last);
  if (at === -1) return line;
  return line
    .slice(0, at)
    .replace(/[\s\u00a0]*(?:EUR|USD|INR|GBP|[€£₹$])?\s*$/i, "");
}

/* ------------------------------------------------------------------ */
/* Composition                                                         */
/* ------------------------------------------------------------------ */

/** What the extraction saw — the honest found/assumed report. */
export interface ExtractionReport {
  /** Full facts, or null when a mandatory field is missing. */
  facts: InvoiceFacts | null;
  /** Field labels that were found (for the error detail). */
  found: string[];
  /** Mandatory field labels that are missing. */
  missing: string[];
  /** Assumptions / degradations, human-readable. */
  notes: string[];
  /** The source document's page count (the run detail's pages). */
  pageCount: number;
}

/** Assembles the heuristics into facts + the honest report. */
export function composeInvoiceFacts(
  pages: string[][],
  pageCount = pages.length
): ExtractionReport {
  const found: string[] = [];
  const notes: string[] = [];
  const id = findInvoiceNumber(pages);
  if (id !== null) found.push("invoice number");
  const issueDate = findIssueDate(pages);
  if (issueDate !== null) found.push("issue date");
  const currencyHit = findCurrency(pages);
  if (!currencyHit.assumed) {
    found.push(`currency (${currencyHit.code}, by ${currencyHit.source})`);
  } else {
    notes.push(`currency assumed EUR — no symbol or code found`);
  }
  const sellerName = findSeller(pages);
  if (sellerName !== null) found.push("seller name");
  const buyerName = findBuyer(pages);
  if (buyerName !== null) found.push("buyer name");
  const sellerVatId = findVatId(pages);
  if (sellerVatId !== null) found.push("seller tax id");
  const totals = findTotals(pages);
  if (totals.grand !== null) found.push("grand total");
  if (totals.taxBasis !== null) found.push("net total");

  const missing: string[] = [];
  if (id === null) missing.push("invoice number");
  if (issueDate === null) missing.push("issue date");
  if (sellerName === null) missing.push("seller name");
  if (buyerName === null) missing.push("buyer name");
  if (totals.grand === null) missing.push("grand total");

  let facts: InvoiceFacts | null = null;
  if (id !== null && issueDate !== null && sellerName !== null &&
      buyerName !== null && totals.grand !== null) {
    let taxBasis = totals.taxBasis;
    let taxTotal: number;
    if (taxBasis !== null) {
      taxTotal = totals.grand - taxBasis;
    } else {
      taxBasis = totals.grand;
      taxTotal = 0;
      notes.push(
        "tax split not found — net total set to the grand total, tax 0"
      );
    }
    if (totals.due !== null && totals.due !== totals.grand) {
      found.push("amount due");
    }
    facts = {
      id,
      issueDate,
      currency: currencyHit.code,
      sellerName,
      sellerVatId,
      buyerName,
      buyerReference: null,
      taxBasis,
      taxTotal,
      grandTotal: totals.grand,
      duePayable: totals.due ?? totals.grand,
    };
  }
  return { facts, found, missing, notes, pageCount };
}

/**
 * PDF bytes → the extraction report. The pdf.js module is INJECTED
 * (the worker passes the self-hosted fake-worker build with its DOM
 * shim + cMaps; the smoke passes the npm legacy build) and destroyed
 * before returning — the pinned copies+destroy rule.
 */
export async function extractInvoiceFactsReported(
  pdfjs: EInvPdfjsLike,
  bytes: Uint8Array,
  params?: Record<string, unknown>
): Promise<ExtractionReport> {
  const task = pdfjs.getDocument({
    ...(params ?? {}),
    // slice(): pdf.js transfers (detaches) the buffer it is handed.
    data: bytes.slice(),
  });
  let doc: EInvDocLike;
  try {
    doc = await task.promise;
  } catch (error) {
    try {
      await task.destroy?.();
    } catch {
      /* best effort */
    }
    throw error;
  }
  try {
    const pageCount = Math.min(doc.numPages, MAX_EXTRACT_PAGES);
    const pages: string[][] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items as RawTextItem[];
      page.cleanup();
      // pageLines: the pdf-to-word recipe — baseline grouping, x-sort,
      // quarter-font gap spaces.
      pages.push(pageLines(items).map((line) => line.text));
    }
    return composeInvoiceFacts(pages, doc.numPages);
  } finally {
    doc.cleanup();
    await doc.destroy();
  }
}

/**
 * PDF bytes → invoice facts, or null when a mandatory field is
 * missing (the binding tool-spec signature — a thin wrapper around
 * extractInvoiceFactsReported).
 */
export async function extractInvoiceFacts(
  pdfjs: EInvPdfjsLike,
  bytes: Uint8Array,
  params?: Record<string, unknown>
): Promise<InvoiceFacts | null> {
  const report = await extractInvoiceFactsReported(pdfjs, bytes, params);
  return report.facts;
}
