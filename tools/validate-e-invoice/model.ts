import type {
  Check,
  CiiFields,
  CiiLine,
  CiiTaxEntry,
  InputKind,
  ReportLabels,
  RunOptions,
  TotalsTriple,
  ValidationReport,
  Verdict,
  XmlElement,
} from "./types";

/**
 * Validate e-invoice model (RB5-e) — PURE, bun-testable, no DOM, no pdf.js.
 *
 * Everything here is deterministic for a given input: a small
 * namespace-tolerant XML tree parser (the "parsed-DOM abstraction" — see
 * the honest note below), the CII extraction takeCii(doc) → the flat
 * field map, the semantic check layer runChecks(fields), and the plain-text
 * report builder. The worker only does I/O (sniff, extract, decode).
 *
 * HONEST NOTE on the XML parsing: DOMParser does not exist in this
 * project's Web Worker targets (Safari lags) nor in bun, so the parser
 * below is self-contained and shared VERBATIM between the worker and the
 * smoke — preview, run and tests can never disagree about extraction.
 * It is tolerant (unknown namespaces, comments, CDATA, entities, slight
 * malformation) but it is NOT a validating XML parser: namespace URIs are
 * ignored (localName matching only), DTDs are skipped without resolution,
 * and duplicate elements keep every occurrence in document order.
 *
 * Scope honesty (mirrored in the FAQ + report footer): the checks are
 * structural + EN 16931-flavored semantic checks, NOT a full XSD schema
 * validation, NOT signature verification, NOT business-rule completeness
 * beyond the checks listed in runChecks.
 */

/* ------------------------------------------------------------------ */
/* Sanity caps                                                         */
/* ------------------------------------------------------------------ */

const MAX_NODES = 200_000;
const MAX_DEPTH = 200;
/** Input size gate — an e-invoice XML larger than this is not sane. */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/** Totals cross-check tolerance (decimal artifacts). */
export const TOLERANCE = 0.01;
/** The same tolerance with a hair of float-noise headroom at ==0.01. */
const TOL = TOLERANCE + 1e-9;

/* ------------------------------------------------------------------ */
/* XML parser (namespace-tolerant tree, iOS-safe: no lookbehind)        */
/* ------------------------------------------------------------------ */

/** localName of "rsm:CrossIndustryInvoice" → "CrossIndustryInvoice". */
function localName(raw: string): string {
  const colon = raw.indexOf(":");
  return colon < 0 ? raw : raw.slice(colon + 1);
}

/** Decodes the five XML entities + numeric refs; unknown ones stay. */
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9._-]*);/g, (whole, body: string) => {
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return '"';
    if (body === "apos") return "'";
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/** Skips a <! … > declaration (quote + internal-subset aware). */
function skipDeclaration(s: string, from: number): number {
  let i = from + 2; // past "<!"
  let quote = "";
  let depth = 0;
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth = Math.max(0, depth - 1);
    } else if (ch === ">" && depth === 0) {
      return i + 1;
    }
    i += 1;
  }
  return s.length;
}

/** Attribute parser for the inside of a tag: name(="value") pairs. */
function parseAttrs(body: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(body)) !== null) {
    attrs[localName(m[1])] = decodeEntities(m[2] ?? m[3] ?? "");
  }
  return attrs;
}

/**
 * parseXml — builds the XmlElement tree. Returns the FIRST element ever
 * seen (the root, per XML) or null when the input has no element at all.
 * Tolerant rules: mismatched close tags pop to the nearest matching open,
 * unknown constructs (PIs, comments, DOCTYPE, CDATA markers) are skipped,
 * truncated tails are kept as far as they parsed.
 */
export function parseXml(input: string): XmlElement | null {
  let s = input;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // BOM
  const n = s.length;
  let i = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let nodes = 0;

  const appendText = (t: string): void => {
    if (t.length === 0) return;
    const top = stack[stack.length - 1];
    if (top) top.text += t;
  };

  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      appendText(decodeEntities(s.slice(i)));
      break;
    }
    if (lt > i) appendText(decodeEntities(s.slice(i, lt)));
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (s.startsWith("<![CDATA[", lt)) {
      const end = s.indexOf("]]>", lt + 9);
      appendText(end < 0 ? s.slice(lt + 9) : s.slice(lt + 9, end));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (s.startsWith("<?", lt)) {
      const end = s.indexOf("?>", lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (s.startsWith("<!", lt)) {
      i = skipDeclaration(s, lt);
      continue;
    }
    if (s.startsWith("</", lt)) {
      const end = s.indexOf(">", lt + 2);
      const closeName = localName(
        s.slice(lt + 2, end < 0 ? n : end).replace(/[\s/]+$/, "")
      );
      i = end < 0 ? n : end + 1;
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k].name === closeName) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    // ---- open tag: scan to the ">" that ends it, honouring quotes ----
    let j = lt + 1;
    let quote = "";
    while (j < n) {
      const ch = s[j];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      j += 1;
    }
    if (j >= n) break; // truncated inside the tag
    const inner = s.slice(lt + 1, j);
    const selfClose = inner.endsWith("/");
    const body = selfClose ? inner.slice(0, -1) : inner;
    const nameMatch = /^[^\s/>]+/.exec(body);
    if (nameMatch === null) {
      i = j + 1;
      continue; // not a real tag after all
    }
    const el: XmlElement = {
      name: localName(nameMatch[0]),
      attrs: parseAttrs(body.slice(nameMatch[0].length)),
      children: [],
      text: "",
    };
    nodes += 1;
    if (nodes > MAX_NODES) break;
    if (root === null) root = el;
    const top = stack[stack.length - 1];
    if (top) top.children.push(el);
    if (stack.length < MAX_DEPTH) {
      stack.push(el);
      if (selfClose) stack.pop();
    } else if (selfClose) {
      /* depth-capped: node stays as a child but never opens */
    }
    i = j + 1;
  }
  return root;
}

/* ---- tiny tree helpers (localName based) ---- */

function child(parent: XmlElement | null, name: string): XmlElement | null {
  if (parent === null) return null;
  for (const c of parent.children) {
    if (c.name === name) return c;
  }
  return null;
}

function childrenNamed(
  parent: XmlElement | null,
  name: string
): XmlElement[] {
  if (parent === null) return [];
  return parent.children.filter((c) => c.name === name);
}

/** First descendant (pre-order) matching the exact localName. */
function findDescendant(
  parent: XmlElement | null,
  name: string
): XmlElement | null {
  if (parent === null) return null;
  for (const c of parent.children) {
    if (c.name === name) return c;
    const hit = findDescendant(c, name);
    if (hit !== null) return hit;
  }
  return null;
}

/** Text of the child (trimmed); null when the child is missing. */
function textOf(parent: XmlElement | null, name: string): string | null {
  const c = child(parent, name);
  return c === null ? null : c.text.trim();
}

/** Text of the named child, searched as a direct child OR via a wrapper. */
function textOfPath(
  parent: XmlElement | null,
  path: readonly string[]
): string | null {
  let cur: XmlElement | null = parent;
  for (const part of path) {
    const next: XmlElement | null = child(cur, part);
    if (next === null) return null;
    cur = next;
  }
  return cur === null ? null : cur.text.trim();
}

/* ------------------------------------------------------------------ */
/* Input sniff (shared by surface + worker — same code, no disagreement)*/
/* ------------------------------------------------------------------ */

/**
 * Magic-byte sniff: "%PDF-" anywhere in the first 1024 bytes → pdf; an
 * element open ("<?xml" prolog, "<rsm:…" — any "<" + name start) after a
 * BOM/whitespace → xml; a UTF-16 BOM followed by "<" → xml too (the
 * worker's decodeXmlText understands UTF-16, so the sniff must let those
 * files through instead of rejecting them as "not XML"); anything else
 * → unknown. Garbage is judged honestly by the worker's error taxonomy,
 * never guessed here.
 */
export function sniffInput(bytes: Uint8Array): InputKind {
  // BOM + leading whitespace skip.
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3;
  }
  // UTF-16LE/BE BOM + "<" — a UTF-16 XML document ("<" is 3C 00 / 00 3C).
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x3c && bytes[3] === 0x00) ||
      (bytes[0] === 0xfe && bytes[1] === 0xff && bytes[2] === 0x00 && bytes[3] === 0x3c))
  ) {
    return "xml";
  }
  while (
    start < bytes.length &&
    (bytes[start] === 0x20 || bytes[start] === 0x09 || bytes[start] === 0x0a || bytes[start] === 0x0d)
  ) {
    start += 1;
  }
  if (start < bytes.length && bytes[start] === 0x3c /* < */) {
    const next = start + 1 < bytes.length ? bytes[start + 1] : 0;
    if (next === 0x3f /* ? */ || next === 0x21 /* ! */) {
      // "<?xml …" or "<!DOCTYPE …" — still an XML document start.
      return "xml";
    }
    if ((next >= 0x41 && next <= 0x5a) || (next >= 0x61 && next <= 0x7a) || next === 0x5f) {
      return "xml"; // "<rsm…" / "<Invoice…" / "<foo…"
    }
  }
  const head = bytes.subarray(0, Math.min(bytes.length, 1024));
  for (let k = 0; k + 4 < head.length; k += 1) {
    if (
      head[k] === 0x25 /* % */ &&
      head[k + 1] === 0x50 /* P */ &&
      head[k + 2] === 0x44 /* D */ &&
      head[k + 3] === 0x46 /* F */ &&
      head[k + 4] === 0x2d /* - */
    ) {
      return "pdf";
    }
  }
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* Parsers used by the check layer (pure, honest, strict)               */
/* ------------------------------------------------------------------ */

/**
 * dec — the strict CII decimal parser. CII amounts are xsd:decimal with
 * a DOT decimal separator, so "18,00" and "1 000,00" are honestly
 * REJECTED (comma/space/grouping is UBL/print formatting, not CII).
 * Accepts optional sign, "18", "18.5", ".5", "18."; rejects exponents,
 * NaN/Infinity, empty, and anything with a second dot.
 */
export function dec(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const v = Number.parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

/** 2-decimal display string (the report + totals table format). */
export function fmt2(v: number): string {
  return v.toFixed(2);
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function validYMD(y: number, m: number, d: number): boolean {
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const max = m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m - 1];
  return d <= max;
}

export interface DateCheck {
  ok: boolean;
  /** "102" = the CII canonical YYYYMMDD; "iso" = accepted extended ISO. */
  form: "102" | "iso" | "none";
}

/**
 * dateOk — accepts the CII canonical format 102 (YYYYMMDD, real calendar
 * dates only: 20230229 fails, 20240229 passes) and honest ISO forms
 * (YYYY-MM-DD, optionally with a T time part). Everything else —
 * "15/01/2024", "2024-1-5", "20241301", "2024011" — is rejected.
 */
export function dateOk(raw: string | null | undefined): DateCheck {
  if (typeof raw !== "string") return { ok: false, form: "none" };
  const s = raw.trim();
  const basic = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (basic !== null) {
    const ok = validYMD(
      Number.parseInt(basic[1], 10),
      Number.parseInt(basic[2], 10),
      Number.parseInt(basic[3], 10)
    );
    return { ok, form: "102" };
  }
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(
      s
    );
  if (iso !== null) {
    const ok = validYMD(
      Number.parseInt(iso[1], 10),
      Number.parseInt(iso[2], 10),
      Number.parseInt(iso[3], 10)
    );
    return { ok, form: "iso" };
  }
  return { ok: false, form: "none" };
}

/**
 * The common-currency whitelist (~35 codes we can honestly vouch for).
 * A 3-uppercase-letter code OUTSIDE this set is only a WARNING — it may
 * be a rarer valid ISO 4217 code we don't list, and we don't ship the
 * full ISO table to check.
 */
export const CURRENCIES: ReadonlySet<string> = new Set([
  "AED", "AUD", "BDT", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK",
  "EGP", "EUR", "GBP", "HKD", "HRK", "HUF", "IDR", "ILS", "INR", "JPY",
  "KES", "KRW", "LKR", "MAD", "MXN", "MYR", "NGN", "NOK", "NPR", "NZD",
  "PHP", "PKR", "PLN", "RON", "RSD", "RUB", "SAR", "SEK", "SGD", "THB",
  "TRY", "UAH", "USD", "VND", "ZAR",
]);

/** The UNTDID 5305 category codes the check layer knows + their labels. */
export const TAX_CATEGORIES: Readonly<Record<string, string>> = {
  S: "standard rate",
  Z: "zero-rated",
  E: "exempt",
  AE: "reverse charge (VAT reverse charge)",
  K: "intra-community supply",
  G: "export outside the EU",
  O: "not subject to VAT",
};

/** UNTDID 1001 document type codes the check layer recognizes. */
export const TYPE_CODES: Readonly<Record<string, string>> = {
  "380": "commercial invoice",
  "381": "credit note",
  "383": "debit note",
  "384": "corrected invoice",
  "385": "corrected credit note",
  "386": "prepayment invoice",
  "388": "self-billed debit note",
  "389": "self-billed invoice",
  "261": "self-billed credit note",
  "262": "self-billed debit note",
};

/* ------------------------------------------------------------------ */
/* takeCii — the extraction (parsed tree → flat field map)             */
/* ------------------------------------------------------------------ */

/** Header monetary summation: the child whose localName ends MonetarySummation. */
function headerSums(tx: XmlElement | null): XmlElement | null {
  if (tx === null) return null;
  for (const c of tx.children) {
    if (c.name.endsWith("MonetarySummation")) return c;
  }
  return null;
}

/** A line's own summation: first descendant ending MonetarySummation. */
function lineSums(line: XmlElement): XmlElement | null {
  return findDescendantWhere(line, (el) => el.name.endsWith("MonetarySummation"));
}

function findDescendantWhere(
  parent: XmlElement,
  pred: (el: XmlElement) => boolean
): XmlElement | null {
  for (const c of parent.children) {
    if (pred(c)) return c;
    const hit = findDescendantWhere(c, pred);
    if (hit !== null) return hit;
  }
  return null;
}

/** The line's product node (CII 16B+ or the older D16B spelling). */
function productOf(line: XmlElement): XmlElement | null {
  let p = child(line, "SpecifiedTradeProduct");
  if (p === null) p = child(line, "SpecifiedSupplyChainTradeProduct");
  if (p === null) {
    p = findDescendantWhere(line, (el) => el.name.endsWith("TradeProduct"));
  }
  return p;
}

export function takeCii(doc: XmlElement | null): CiiFields {
  const fields: CiiFields = {
    root: doc === null ? null : doc.name,
    hasContext: false,
    guideline: null,
    invoiceId: null,
    issueDate: null,
    typeCode: null,
    seller: null,
    buyer: null,
    buyerReference: null,
    sellerHasAddress: false,
    buyerHasAddress: false,
    currency: null,
    lines: [],
    lineTotal: null,
    taxBasis: null,
    taxes: [],
    grandTotal: null,
    prepaid: null,
    due: null,
  };
  if (doc === null) return fields;

  const ctx = child(doc, "ExchangedDocumentContext");
  fields.hasContext = ctx !== null;
  fields.guideline = textOfPath(ctx, [
    "GuidelineSpecifiedDocumentContextParameter",
    "ID",
  ]);

  const docEl = child(doc, "ExchangedDocument");
  fields.invoiceId = textOf(docEl, "ID");
  fields.issueDate =
    textOfPath(docEl, ["IssueDateTime", "DateTimeString"]) ??
    textOf(docEl, "IssueDateTime");
  fields.typeCode = textOf(docEl, "TypeCode");

  const tx = child(doc, "SupplyChainTradeTransaction");
  const agreement =
    child(tx, "ApplicableHeaderTradeAgreement") ??
    child(tx, "ApplicableSupplyChainTradeAgreement");
  const sellerParty = child(agreement, "SellerTradeParty");
  const buyerParty = child(agreement, "BuyerTradeParty");
  fields.seller = textOf(sellerParty, "Name");
  fields.buyer = textOf(buyerParty, "Name");
  fields.buyerReference = textOf(agreement, "BuyerReference");
  fields.sellerHasAddress = child(sellerParty, "PostalTradeAddress") !== null;
  fields.buyerHasAddress = child(buyerParty, "PostalTradeAddress") !== null;

  const settlement =
    child(tx, "ApplicableHeaderTradeSettlement") ??
    child(tx, "ApplicableSupplyChainTradeSettlement");
  fields.currency = textOf(settlement, "InvoiceCurrencyCode");

  const lines: CiiLine[] = [];
  for (const line of childrenNamed(tx, "IncludedSupplyChainTradeLineItem")) {
    const product = productOf(line);
    const sums = lineSums(line);
    lines.push({
      name: textOf(product, "Name"),
      net: textOf(sums, "LineTotalAmount"),
    });
  }
  fields.lines = lines;

  const taxes: CiiTaxEntry[] = [];
  for (const tax of childrenNamed(settlement, "ApplicableTradeTax")) {
    taxes.push({
      rate: textOf(tax, "RateApplicablePercent"),
      category: textOf(tax, "CategoryCode"),
      amount: textOf(tax, "CalculatedAmount"),
    });
  }
  fields.taxes = taxes;

  const sums = headerSums(settlement);
  fields.lineTotal = textOf(sums, "LineTotalAmount");
  fields.taxBasis = textOf(sums, "TaxBasisTotalAmount");
  fields.grandTotal = textOf(sums, "GrandTotalAmount");
  fields.prepaid = textOf(sums, "TotalPrepaidAmount");
  fields.due = textOf(sums, "DuePayableAmount");
  return fields;
}

/* ------------------------------------------------------------------ */
/* Completeness (Factur-X profile heuristic)                            */
/* ------------------------------------------------------------------ */

export type Completeness = "insufficient" | "MINIMUM" | "BASIC" | "EN 16931";

/**
 * completenessOf — the honest heuristic the Factur-X conformance
 * cross-check uses (INFORMATIONAL, never a verdict): lines + totals but
 * no addresses/tax → MINIMUM; + seller & buyer postal address + a tax
 * breakdown → BASIC; + BuyerReference → EN 16931. This mirrors the
 * profile ladder in spirit; it is NOT the official profile rule set.
 */
export function completenessOf(f: CiiFields): Completeness {
  const hasLines = f.lines.length > 0;
  const hasTotals = dec(f.taxBasis) !== null && dec(f.grandTotal) !== null;
  if (!hasLines || !hasTotals) return "insufficient";
  if (f.sellerHasAddress && f.buyerHasAddress && f.taxes.length > 0) {
    return (f.buyerReference ?? "").trim().length > 0 ? "EN 16931" : "BASIC";
  }
  return "MINIMUM";
}

/** Maps an XMP ConformanceLevel string to the comparable ladder. */
export function normalizeClaim(
  claim: string
): "MINIMUM" | "BASIC" | "EN 16931" | "EXTENDED" | null {
  const c = claim.trim().toUpperCase();
  if (c === "MINIMUM") return "MINIMUM";
  if (c === "BASIC" || c === "BASIC WL") return "BASIC";
  if (c === "EN 16931" || c === "EN16931") return "EN 16931";
  if (
    c === "EXTENDED" ||
    c === "XRECHNUNG" ||
    c === "XRECHNUNG EXTENDED" ||
    c === "COMFORT"
  ) {
    return "EXTENDED";
  }
  return null;
}

const CLAIM_RANK: Readonly<Record<Exclude<ReturnType<typeof normalizeClaim>, null>, number>> = {
  MINIMUM: 0,
  BASIC: 1,
  "EN 16931": 2,
  EXTENDED: 3,
};

/* ------------------------------------------------------------------ */
/* runChecks — the semantic check layer (pure, over CiiFields)          */
/* ------------------------------------------------------------------ */

export interface CheckOptions {
  /** XMP /ConformanceLevel claim (PDF mode); null/undefined → XML mode. */
  xmpClaim?: string | null;
}

export interface ValidationResult {
  checks: Check[];
  verdict: Verdict;
  totals: TotalsTriple;
}

/** any fail → FAIL; any warn → PASS WITH WARNINGS; else PASS. */
export function verdictOf(checks: readonly Check[]): Verdict {
  let sawWarn = false;
  for (const c of checks) {
    if (c.status === "fail") return "fail";
    if (c.status === "warn") sawWarn = true;
  }
  return sawWarn ? "warnings" : "pass";
}

/**
 * runChecks — every EN 16931-flavored semantic check, in display order.
 * Each Check's label/note are FULL i18n keys; expected/actual carry the
 * technical specifics (raw values, computed numbers, element names).
 */
export function runChecks(
  f: CiiFields,
  opts: CheckOptions = {}
): ValidationResult {
  const checks: Check[] = [];
  const push = (c: Check): void => {
    checks.push(c);
  };

  /* ---- 1. root ---- */
  if (f.root === "CrossIndustryInvoice") {
    push({ id: "root", label: "vei.kRoot", status: "pass" });
  } else if (f.root === "Invoice") {
    push({
      id: "root",
      label: "vei.kRoot",
      status: "warn",
      expected: "CrossIndustryInvoice",
      actual: f.root,
      note: "vei.nUbl",
    });
  } else {
    push({
      id: "root",
      label: "vei.kRoot",
      status: "fail",
      expected: "CrossIndustryInvoice",
      actual: f.root ?? "",
    });
  }

  /* ---- 2. document context ---- */
  if (!f.hasContext) {
    push({
      id: "context",
      label: "vei.kContext",
      status: "fail",
      expected: "ExchangedDocumentContext",
      actual: "",
    });
  } else if ((f.guideline ?? "").length > 0) {
    push({
      id: "context",
      label: "vei.kContext",
      status: "pass",
      actual: f.guideline ?? "",
    });
  } else {
    push({
      id: "context",
      label: "vei.kContext",
      status: "warn",
      actual: "",
      note: "vei.nNoGuideline",
    });
  }

  /* ---- 3. invoice number ---- */
  const id = (f.invoiceId ?? "").trim();
  if (id.length === 0) {
    push({
      id: "docId",
      label: "vei.kDocId",
      status: "fail",
      expected: "ExchangedDocument/ID",
      actual: "",
    });
  } else if (/\s/.test(id)) {
    push({
      id: "docId",
      label: "vei.kDocId",
      status: "warn",
      actual: JSON.stringify(id),
      note: "vei.nIdSpace",
    });
  } else {
    push({ id: "docId", label: "vei.kDocId", status: "pass", actual: id });
  }

  /* ---- 4. issue date ---- */
  const date = dateOk(f.issueDate);
  if (!date.ok) {
    push({
      id: "docDate",
      label: "vei.kDate",
      status: "fail",
      expected: "YYYYMMDD (format 102) or ISO date",
      actual: (f.issueDate ?? "").trim(),
    });
  } else if (date.form === "iso") {
    push({
      id: "docDate",
      label: "vei.kDate",
      status: "warn",
      actual: (f.issueDate ?? "").trim(),
      note: "vei.nDateIso",
    });
  } else {
    push({
      id: "docDate",
      label: "vei.kDate",
      status: "pass",
      actual: (f.issueDate ?? "").trim(),
    });
  }

  /* ---- 5. type code ---- */
  const tc = (f.typeCode ?? "").trim();
  const tcKnown = TYPE_CODES[tc];
  if (tc.length === 0) {
    push({
      id: "typeCode",
      label: "vei.kType",
      status: "fail",
      expected: "380 / 381 / 384 …",
      actual: "",
    });
  } else if (tcKnown !== undefined) {
    push({
      id: "typeCode",
      label: "vei.kType",
      status: "pass",
      actual: `${tc} — ${tcKnown}`,
    });
  } else if (/^\d+$/.test(tc)) {
    push({
      id: "typeCode",
      label: "vei.kType",
      status: "warn",
      actual: tc,
      note: "vei.nTypeUnknown",
    });
  } else {
    push({
      id: "typeCode",
      label: "vei.kType",
      status: "fail",
      actual: tc,
    });
  }

  /* ---- 6/7. seller + buyer names (soft: warn when empty) ---- */
  const seller = (f.seller ?? "").trim();
  push({
    id: "seller",
    label: "vei.kSeller",
    status: seller.length > 0 ? "pass" : "warn",
    actual: seller.length > 0 ? seller : "",
    ...(seller.length > 0 ? {} : { note: "vei.nSellerMissing" }),
  });
  const buyer = (f.buyer ?? "").trim();
  push({
    id: "buyer",
    label: "vei.kBuyer",
    status: buyer.length > 0 ? "pass" : "warn",
    actual: buyer.length > 0 ? buyer : "",
    ...(buyer.length > 0 ? {} : { note: "vei.nBuyerMissing" }),
  });

  /* ---- 8. line items ---- */
  const lineNets = f.lines.map((l) => dec(l.net));
  if (f.lines.length === 0) {
    push({
      id: "lines",
      label: "vei.kLines",
      status: "fail",
      expected: "≥ 1 IncludedSupplyChainTradeLineItem",
      actual: "0",
    });
  } else {
    const badNet: number[] = [];
    for (let i = 0; i < f.lines.length; i += 1) {
      if (lineNets[i] === null) badNet.push(i + 1);
    }
    if (badNet.length > 0) {
      push({
        id: "lines",
        label: "vei.kLines",
        status: "fail",
        actual: `line ${badNet.join(", line ")}`,
        note: "vei.nLineNetBad",
      });
    } else {
      const nameless = f.lines
        .map((l, i) => ((l.name ?? "").trim().length === 0 ? i + 1 : 0))
        .filter((i) => i > 0);
      if (nameless.length > 0) {
        push({
          id: "lines",
          label: "vei.kLines",
          status: "warn",
          actual: `line ${nameless.join(", line ")}`,
          note: "vei.nNameless",
        });
      } else {
        push({
          id: "lines",
          label: "vei.kLines",
          status: "pass",
          actual: String(f.lines.length),
        });
      }
    }
  }

  /* ---- totals used by checks 9-11 + the reconciliation table ---- */
  const sumLines = lineNets.reduce<number>((a, v) => a + (v ?? 0), 0);
  const parseableNets = lineNets.filter((v) => v !== null).length;
  const taxBasis = dec(f.taxBasis);
  const grand = dec(f.grandTotal);
  const prepaid = dec(f.prepaid);
  const due = dec(f.due);
  const taxSum = f.taxes.reduce<number>(
    (a, t) => a + (dec(t.amount) ?? 0),
    0
  );

  /* ---- 9. Σ line nets == TaxBasisTotalAmount ---- */
  if (taxBasis === null) {
    const lineTotal = dec(f.lineTotal);
    if (lineTotal !== null && Math.abs(sumLines - lineTotal) <= TOL) {
      push({
        id: "sumLines",
        label: "vei.kSum",
        status: "warn",
        expected: fmt2(sumLines),
        actual: fmt2(lineTotal),
        note: "vei.nSumViaLt",
      });
    } else {
      push({
        id: "sumLines",
        label: "vei.kSum",
        status: "fail",
        expected: "TaxBasisTotalAmount",
        actual: "",
      });
    }
  } else if (Math.abs(sumLines - taxBasis) <= TOL) {
    push({
      id: "sumLines",
      label: "vei.kSum",
      status: "pass",
      expected: fmt2(taxBasis),
      actual: fmt2(sumLines),
      ...(parseableNets === 0
        ? { note: "vei.nNoParseableNets" }
        : {}),
    });
  } else {
    push({
      id: "sumLines",
      label: "vei.kSum",
      status: "fail",
      expected: fmt2(taxBasis),
      actual: fmt2(sumLines),
    });
  }

  /* ---- 10. GrandTotal == TaxBasis + Σ tax ---- */
  if (grand === null || taxBasis === null) {
    push({
      id: "grand",
      label: "vei.kGrand",
      status: "fail",
      expected: "GrandTotalAmount",
      actual: grand === null ? "" : fmt2(grand),
      ...(taxBasis === null ? { note: "vei.nBasisMissing" } : {}),
    });
  } else {
    const expected = taxBasis + taxSum;
    if (Math.abs(grand - expected) <= TOL) {
      push({
        id: "grand",
        label: "vei.kGrand",
        status: f.taxes.length === 0 ? "warn" : "pass",
        expected: fmt2(expected),
        actual: fmt2(grand),
        ...(f.taxes.length === 0 ? { note: "vei.nNoTaxEntries" } : {}),
      });
    } else {
      push({
        id: "grand",
        label: "vei.kGrand",
        status: "fail",
        expected: fmt2(expected),
        actual: fmt2(grand),
      });
    }
  }

  /* ---- 11. Due == Grand − Prepaid (when DuePayable present) ---- */
  if (due === null) {
    push({
      id: "due",
      label: "vei.kDue",
      status: "warn",
      note: "vei.nDueMissing",
    });
  } else if (grand === null) {
    push({
      id: "due",
      label: "vei.kDue",
      status: "fail",
      expected: "GrandTotalAmount",
      actual: fmt2(due),
    });
  } else {
    const expected = grand - (prepaid ?? 0);
    if (Math.abs(due - expected) <= TOL) {
      push({
        id: "due",
        label: "vei.kDue",
        status: "pass",
        expected: fmt2(expected),
        actual: fmt2(due),
      });
    } else {
      push({
        id: "due",
        label: "vei.kDue",
        status: "fail",
        expected: fmt2(expected),
        actual: fmt2(due),
      });
    }
  }

  /* ---- 12. ApplicableTradeTax sanity ---- */
  if (f.taxes.length === 0) {
    push({
      id: "taxes",
      label: "vei.kTaxes",
      status: "fail",
      expected: "≥ 1 ApplicableTradeTax",
      actual: "0",
    });
  } else {
    const problems: string[] = [];
    for (let i = 0; i < f.taxes.length; i += 1) {
      const t = f.taxes[i];
      const parts: string[] = [];
      const cat = (t.category ?? "").trim();
      if (TAX_CATEGORIES[cat] === undefined) {
        parts.push(`category ${cat.length === 0 ? "(missing)" : cat}`);
      }
      if (dec(t.rate) === null) {
        parts.push(`rate ${t.rate === null || t.rate.trim() === "" ? "(missing)" : t.rate.trim()}`);
      }
      if (dec(t.amount) === null) {
        parts.push("amount not a dot-decimal");
      }
      if (parts.length > 0) problems.push(`tax ${i + 1} (${parts.join(", ")})`);
    }
    if (problems.length > 0) {
      push({
        id: "taxes",
        label: "vei.kTaxes",
        status: "warn",
        actual: problems.join("; "),
        note: "vei.nTaxBad",
      });
    } else {
      push({
        id: "taxes",
        label: "vei.kTaxes",
        status: "pass",
        actual: f.taxes
          .map((t) => `${(t.category ?? "").trim()} @ ${(t.rate ?? "").trim()}%`)
          .join("; "),
      });
    }
  }

  /* ---- 13. currency ---- */
  const cur = (f.currency ?? "").trim();
  if (cur.length === 0) {
    push({
      id: "currency",
      label: "vei.kCurrency",
      status: "fail",
      expected: "ISO 4217 (EUR, INR, USD …)",
      actual: "",
    });
  } else if (/^[A-Z]{3}$/.test(cur)) {
    push({
      id: "currency",
      label: "vei.kCurrency",
      status: CURRENCIES.has(cur) ? "pass" : "warn",
      actual: cur,
      ...(CURRENCIES.has(cur) ? {} : { note: "vei.nCurrencyRare" }),
    });
  } else {
    push({
      id: "currency",
      label: "vei.kCurrency",
      status: "fail",
      actual: cur,
    });
  }

  /* ---- 14. Factur-X conformance cross-check (PDF mode, informational) ---- */
  if (typeof opts.xmpClaim === "string" && opts.xmpClaim.trim().length > 0) {
    const claim = normalizeClaim(opts.xmpClaim);
    const actual = completenessOf(f);
    if (claim === null) {
      push({
        id: "conformance",
        label: "vei.kConf",
        status: "warn",
        actual: opts.xmpClaim.trim(),
        note: "vei.nConfUnknown",
      });
    } else if (actual === "insufficient") {
      push({
        id: "conformance",
        label: "vei.kConf",
        status: "warn",
        expected: opts.xmpClaim.trim(),
        actual: "insufficient",
        note: "vei.nConfInsufficient",
      });
    } else if (CLAIM_RANK[claim] > CLAIM_RANK[actual]) {
      push({
        id: "conformance",
        label: "vei.kConf",
        status: "warn",
        expected: `${opts.xmpClaim.trim()} (XMP)`,
        actual: `${actual} (XML)`,
        note: "vei.nConfMismatch",
      });
    } else {
      push({
        id: "conformance",
        label: "vei.kConf",
        status: "pass",
        expected: `${opts.xmpClaim.trim()} (XMP)`,
        actual: `${actual} (XML)`,
        note: "vei.nConfLower",
      });
    }
  }

  return {
    checks,
    verdict: verdictOf(checks),
    totals: {
      lineSum: parseableNets === 0 ? "" : fmt2(sumLines),
      lineTotal: (f.lineTotal ?? "").trim(),
      taxBasis: (f.taxBasis ?? "").trim(),
      taxSum: fmt2(taxSum),
      taxBasisPlusTax: taxBasis === null ? "" : fmt2(taxBasis + taxSum),
      grandTotal: (f.grandTotal ?? "").trim(),
      prepaid: f.prepaid === null ? null : (f.prepaid ?? "").trim(),
      grandMinusPrepaid: grand === null ? "" : fmt2(grand - (prepaid ?? 0)),
      due: f.due === null ? null : (f.due ?? "").trim(),
      currency: f.currency === null ? null : (f.currency ?? "").trim(),
    },
  };
}

/* ------------------------------------------------------------------ */
/* The .txt report (honest summary — no JSON fabrication)              */
/* ------------------------------------------------------------------ */

/** Report metadata the worker knows and the builder prints. */
export interface ReportMeta {
  fileName: string;
  bytes: number;
  mode: InputKind;
  /** Embedded attachment name (PDF mode). */
  attachmentName: string | null;
  /** XMP /ConformanceLevel claim (PDF mode, when parseable). */
  xmpClaim: string | null;
}

/**
 * English fallback labels (label-less runs still get a sane report; the
 * surface normally passes the resolved UI strings — create-invoice
 * precedent). Full i18n keys → English text.
 */
export const REPORT_LABELS_EN: ReportLabels = {
  "vei.title": "e-invoice validation report",
  "vei.file": "File",
  "vei.input": "Input",
  "vei.inputXml": "CII XML (direct)",
  "vei.inputPdf": "PDF — embedded XML extracted",
  "vei.xmp": "XMP conformance claim",
  "vei.vPass": "PASS",
  "vei.vWarn": "PASS WITH WARNINGS",
  "vei.vFail": "FAIL",
  "vei.cPassed": "passed",
  "vei.cWarned": "warnings",
  "vei.cFailed": "failed",
  "vei.checks": "CHECKS",
  "vei.expected": "expected",
  "vei.actual": "actual",
  "vei.note": "note",
  "vei.totals": "TOTALS RECONCILIATION",
  "vei.missing": "(missing)",
  "vei.generatedBy": "Generated on-device by MyCloudy — nothing was uploaded.",
  "vei.honestyTitle": "NOT CHECKED (honesty)",
  "vei.honestyBody":
    "This is a structural + EN 16931-flavored semantic check, not a full XSD schema validation, not a signature/e-seal verification, and not a complete business-rule validation. The checks above are the whole scope.",
  "vei.kRoot": "Root element is CrossIndustryInvoice (CII)",
  "vei.kContext": "ExchangedDocumentContext with guideline",
  "vei.kDocId": "Invoice number (ExchangedDocument/ID)",
  "vei.kDate": "Issue date (format 102 or ISO)",
  "vei.kType": "Document type code",
  "vei.kSeller": "Seller name",
  "vei.kBuyer": "Buyer name",
  "vei.kLines": "Line items (name + net amount)",
  "vei.kSum": "Sum of line nets == TaxBasisTotalAmount",
  "vei.kGrand": "GrandTotal == TaxBasis + Sum of tax amounts",
  "vei.kDue": "DuePayable == GrandTotal - TotalPrepaid",
  "vei.kTaxes": "ApplicableTradeTax (rate + category)",
  "vei.kCurrency": "Invoice currency (ISO 4217)",
  "vei.kConf": "Factur-X conformance claim vs contents (informational)",
  "vei.nUbl":
    "This looks like a UBL invoice (root <Invoice>), not CII — the CII checks will mostly fail.",
  "vei.nNoGuideline":
    "ExchangedDocumentContext is present but carries no GuidelineSpecifiedDocumentContextParameter/ID.",
  "vei.nIdSpace": "The invoice number contains whitespace.",
  "vei.nDateIso":
    "Extended ISO form accepted; CII canonically uses format 102 (YYYYMMDD).",
  "vei.nTypeUnknown":
    "Numeric code present, but not in the common UNTDID 1001 set this tool knows.",
  "vei.nSellerMissing": "SellerTradeParty/Name is empty.",
  "vei.nBuyerMissing": "BuyerTradeParty/Name is empty.",
  "vei.nNameless": "Some line items have no SpecifiedTradeProduct/Name.",
  "vei.nLineNetBad":
    "Some line net amounts are missing or not dot-decimal numbers.",
  "vei.nSumViaLt":
    "TaxBasisTotalAmount is missing; verified against the header LineTotalAmount instead.",
  "vei.nNoParseableNets":
    "No line net amount parsed — the sum above could not really be verified.",
  "vei.nBasisMissing": "GrandTotal could not be cross-checked without TaxBasisTotalAmount.",
  "vei.nNoTaxEntries":
    "No ApplicableTradeTax entries exist — grand total was verified against an empty tax sum.",
  "vei.nDueMissing":
    "DuePayableAmount is not present — the final payable amount is not stated.",
  "vei.nTaxBad": "Some ApplicableTradeTax entries have unknown categories or unparseable rates/amounts.",
  "vei.nCurrencyRare":
    "Three-letter code outside the common whitelist — it may be a rarer valid ISO 4217 code.",
  "vei.nConfMismatch":
    "The PDF's XMP claims a higher profile than the XML's contents show (informational, not a verdict).",
  "vei.nConfInsufficient":
    "The XML lacks even MINIMUM completeness (lines + totals), so the claim could not be assessed.",
  "vei.nConfUnknown":
    "Unrecognized XMP ConformanceLevel value (informational, not a verdict).",
  "vei.nConfLower":
    "The claim is at or below what the XML contains — consistent (informational, not a verdict).",
};

const L = (labels: ReportLabels, key: string): string =>
  labels[key] ?? REPORT_LABELS_EN[key] ?? key;

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * buildReportText — the honest plain-text validation report. Deterministic
 * (no timestamps — byte-identical for the same input), plain ASCII box
 * drawing, and the not-checked footer always present.
 */
export function buildReportText(
  report: ValidationReport,
  meta: ReportMeta,
  labels: ReportLabels
): string {
  const out: string[] = [];

  out.push("=".repeat(64));
  out.push(`MyCloudy — ${L(labels, "vei.title")}`);
  out.push("=".repeat(64));
  out.push(`${L(labels, "vei.file")}: ${meta.fileName} (${humanBytes(meta.bytes)})`);
  out.push(
    `${L(labels, "vei.input")}: ${
      meta.mode === "pdf"
        ? `${L(labels, "vei.inputPdf")} — ${meta.attachmentName ?? "(?)"}`
        : L(labels, "vei.inputXml")
    }`
  );
  if (meta.xmpClaim !== null && meta.xmpClaim.trim().length > 0) {
    out.push(`${L(labels, "vei.xmp")}: ${meta.xmpClaim.trim()}`);
  }
  out.push("");

  const vWord =
    report.verdict === "pass"
      ? L(labels, "vei.vPass")
      : report.verdict === "warnings"
        ? L(labels, "vei.vWarn")
        : L(labels, "vei.vFail");
  const nPass = report.checks.filter((c) => c.status === "pass").length;
  const nWarn = report.checks.filter((c) => c.status === "warn").length;
  const nFail = report.checks.filter((c) => c.status === "fail").length;
  out.push(`VERDICT: ${vWord}`);
  out.push(
    `  ${nPass} ${L(labels, "vei.cPassed")}, ${nWarn} ${L(labels, "vei.cWarned")}, ${nFail} ${L(labels, "vei.cFailed")}`
  );
  out.push("");

  out.push(L(labels, "vei.checks"));
  for (const c of report.checks) {
    const mark = c.status === "pass" ? "[PASS]" : c.status === "warn" ? "[WARN]" : "[FAIL]";
    out.push(
      `${mark} ${L(labels, c.label)}${c.actual && c.actual.length > 0 ? ` — ${c.actual}` : ""}`
    );
    if (c.expected !== undefined && c.expected.length > 0) {
      out.push(`       ${L(labels, "vei.expected")}: ${c.expected}`);
    }
    if (c.note !== undefined) {
      out.push(`       ${L(labels, "vei.note")}: ${L(labels, c.note)}`);
    }
  }
  out.push("");

  const t = report.totals;
  if (t !== null) {
    const pad = (s: string): string =>
      s.length > 0 ? s : L(labels, "vei.missing");
    out.push(L(labels, "vei.totals"));
    out.push(`  ${pad(t.lineSum)}   = sum of line net amounts`);
    out.push(`  ${pad(t.lineTotal)}   LineTotalAmount (the file's own sum)`);
    out.push(`  ${pad(t.taxBasis)}   TaxBasisTotalAmount`);
    out.push(`  ${pad(t.taxSum)}   = sum of ApplicableTradeTax amounts`);
    out.push(`  ${pad(t.taxBasisPlusTax)}   = tax basis + tax`);
    out.push(`  ${pad(t.grandTotal)}   GrandTotalAmount`);
    out.push(`  ${pad(t.prepaid ?? "")}   TotalPrepaidAmount`);
    out.push(`  ${pad(t.grandMinusPrepaid)}   = grand total - prepaid`);
    out.push(`  ${pad(t.due ?? "")}   DuePayableAmount`);
    if (t.currency !== null) {
      out.push(`  currency: ${t.currency}`);
    }
    out.push("");
  }

  out.push(L(labels, "vei.honestyTitle"));
  out.push(
    L(labels, "vei.honestyBody")
      .match(/.{1,62}(\s|$)/g)
      ?.join("\n") ?? L(labels, "vei.honestyBody")
  );
  out.push("");
  out.push(L(labels, "vei.generatedBy"));
  out.push("");
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* Worker-boundary coercion + naming                                   */
/* ------------------------------------------------------------------ */

function sanitizeFileWord(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) out += ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * parseRun — the options.run payload. Garbage JSON degrades to defaults;
 * labels accept any "vei.*" string keys (≤ 240 chars each), so the surface
 * can pass its resolved t() strings through.
 */
export function parseRun(raw: string): RunOptions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const o =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  const labels: ReportLabels = {};
  if (typeof o.labels === "object" && o.labels !== null) {
    for (const [k, v] of Object.entries(o.labels as Record<string, unknown>)) {
      if (/^vei\.[A-Za-z0-9]+$/.test(k) && typeof v === "string") {
        labels[k] = v.slice(0, 240);
      }
    }
  }
  return {
    locale: o.locale === "hi" ? "hi" : "en",
    fileWord: sanitizeFileWord(typeof o.fileWord === "string" ? o.fileWord : ""),
    labels,
  };
}

/** Download base name: strips .pdf/.xml, sanitizes, localized fallback. */
export function outputBaseName(
  name: string,
  locale: "en" | "hi",
  fileWord = ""
): string {
  const base = name
    .replace(/\.(pdf|xml)$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim();
  if (base.length > 0) return base.slice(0, 120);
  const word = fileWord.trim() || (locale === "hi" ? "दस्तावेज़" : "document");
  return word.slice(0, 60);
}
