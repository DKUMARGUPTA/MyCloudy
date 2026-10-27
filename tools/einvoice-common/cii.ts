import { scanXmlTags, unescapeXml } from "../word-to-pdf/docx-parse";

/**
 * SHARED e-invoice XML parsing (Task b6-b) — PURE, bun-testable, no DOM,
 * no worker APIs. Used by xml-invoice-to-pdf (render) and
 * validate-e-invoice (rules); one brain, two tools.
 *
 * Two dialects, auto-detected by the ROOT element (namespace tolerant —
 * prefix, Clark-notation {ns}name and default-namespace forms all work):
 *
 *   CII  — UN/CEFACT Cross Industry Invoice (Factur-X / ZUGFeRD / XRechnung
 *          CII): root <rsm:CrossIndustryInvoice>; rsm/ram/udt prefixes are
 *          the convention but NOTHING here depends on the exact prefixes —
 *          every path matches LOCAL names, the odt-parse discipline.
 *   UBL  — OASIS UBL 2.1 Invoice: root <Invoice> with cac/cbc components.
 *
 * MONEY RULE (the pinned paise-ints lesson): every amount parses to INTEGER
 * CENTS (×100) via string arithmetic — no binary float ever touches a
 * comparison. "1.234,56" (European), "1,234.56" and "1234.56" (Factur-X)
 * all land on 123456. Quantities are plain floats (they are not money).
 *
 * The scanners never throw on stray tags (the shared repair-tolerant
 * scanXmlTags); they DO throw EinvoicParseError when the file is not the
 * dialect at all, or when not a single invoice field could be read — the
 * honest "this is not an e-invoice" refusal, mapped 1:1 to
 * xmlInvo.errorNotInvoice / rule-2 FAIL by the callers.
 *
 * VAT IDs: real CII carries them under SpecifiedTaxRegistration (schemeID
 * "VA"); the SpecifiedLegalRegistration variant is accepted identically —
 * both scan, either satisfies.
 *
 * iOS-safe (worklog IOS-COMPAT): no matchAll/replaceAll, no regex
 * lookbehind, no Object.hasOwn / structuredClone — split/join and plain
 * exec/test only.
 */

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Why an e-invoice XML could not be parsed. */
export type EinvoiceParseFailure =
  | "not-invoice" // no invoice root at all (parseInvoiceXml dispatch)
  | "not-cii" // parseCii called on a non-CII document
  | "not-ubl" // parseUbl called on a non-UBL document
  | "no-invoice-data"; // the right root, but zero readable fields

export class EinvoicParseError extends Error {
  readonly failure: EinvoiceParseFailure;

  constructor(failure: EinvoiceParseFailure) {
    super(failure);
    this.name = "EinvoiceParseError";
    this.failure = failure;
  }
}

/* ------------------------------------------------------------------ */
/* The model                                                           */
/* ------------------------------------------------------------------ */

export interface EinvoiceParty {
  name: string | null;
  vatId: string | null;
}

export interface EinvoiceTotals {
  /** Integer cents (×100). */
  taxBasis: number | null;
  taxTotal: number | null;
  grandTotal: number | null;
  duePayable: number | null;
}

export interface EinvoiceLine {
  name: string;
  qty: number;
  /** Integer cents (×100); UBL lines carry no unit price in this model. */
  unitNet: number | null;
  lineTotal: number | null;
}

export interface Einvoice {
  dialect: "CII" | "UBL";
  /** CII: the GuidelineSpecifiedDocumentContextParameter ID; UBL: cbc:ProfileID. */
  profileId: string | null;
  id: string | null;
  /** CII ExchangedDocument/TypeCode or UBL cbc:InvoiceTypeCode. */
  typeCode: number | null;
  /** ISO yyyy-mm-dd (normalized + calendar-checked), or null. */
  issueDate: string | null;
  currency: string | null;
  buyerReference: string | null;
  seller: EinvoiceParty;
  buyer: EinvoiceParty;
  orderRef: string | null;
  totals: EinvoiceTotals;
  lines: EinvoiceLine[];
  raw: {
    /** CII guideline URN; UBL cbc:CustomizationID (the XRechnung URN lives there). */
    guidelineId: string | null;
  };
}

/* ------------------------------------------------------------------ */
/* Money + quantities (string arithmetic — never floats)               */
/* ------------------------------------------------------------------ */

/** Rounds a decimal-digit fraction string (separator already stripped) to cents. */
function fractionToCents(frac: string): number {
  const digits = frac.length === 0 ? "0" : frac;
  const head = digits.length >= 2 ? digits.slice(0, 2) : digits;
  let cents = Number(head.padEnd(2, "0"));
  if (digits.length > 2) {
    const third = Number(digits[2]);
    if (Number.isFinite(third) && third >= 5) cents += 1; // round half up
  }
  return cents;
}

/**
 * "1234.56" | "1.234,56" | "1,234.56" | "1234,56" | "12.345.678,90" →
 * integer cents. European convention: when BOTH separators appear the LAST
 * one is the decimal mark and the other is a thousands separator (stripped);
 * a lone "." is the Factur-X decimal mark; a lone "," is a decimal comma.
 * Returns null for anything that is not a plain decimal number.
 */
export function parseMoneyToCents(raw: string): number | null {
  let s = raw.replace(/\u00a0/g, " ").replace(/[\s']/g, "");
  if (s.length === 0) return null;
  let sign = 1;
  if (s[0] === "+" || s[0] === "-") {
    if (s[0] === "-") sign = -1;
    s = s.slice(1);
  }
  if (s.length === 0 || !/^[0-9.,]+$/.test(s)) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let decimalSep = "";
  if (lastDot !== -1 && lastComma !== -1) {
    decimalSep = lastDot > lastComma ? "." : ",";
  } else if (lastDot !== -1) {
    decimalSep = ".";
  } else if (lastComma !== -1) {
    decimalSep = ",";
  }
  let intPart = s;
  let fracPart = "";
  if (decimalSep !== "") {
    const cut = s.lastIndexOf(decimalSep);
    intPart = s.slice(0, cut);
    fracPart = s.slice(cut + 1);
  }
  // the non-decimal separator (and any repeats) is a thousands mark
  const thousands = decimalSep === "." ? "," : ".";
  intPart = intPart.split(thousands).join("");
  if (!/^[0-9]*$/.test(intPart) || !/^[0-9]*$/.test(fracPart)) return null;
  const digits = intPart.length === 0 ? "0" : intPart.replace(/^0+(?=\d)/, "");
  if (digits.length > 15) return null; // out of safe-integer range
  const cents = Number(digits) * 100 + fractionToCents(fracPart);
  if (!Number.isSafeInteger(cents)) return null;
  return sign * cents;
}

/** 123456 → "1,234.56" (en-US grouping, two decimals, "-" for debt). */
export function formatCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const groups = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${groups}.${String(frac).padStart(2, "0")}`;
}

/** 123456 + "EUR" → "EUR 1,234.56" (no currency → the bare amount). */
export function formatMoneyCents(
  cents: number,
  currency: string | null
): string {
  const body = formatCents(cents);
  return currency !== null && currency.length > 0 ? `${currency} ${body}` : body;
}

/** Quantity parse with the same separator rule as money → float, or null. */
export function parseQuantity(raw: string): number | null {
  let s = raw.replace(/\u00a0/g, " ").replace(/[\s']/g, "");
  if (s.length === 0) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let decimalSep = "";
  if (lastDot !== -1 && lastComma !== -1) {
    decimalSep = lastDot > lastComma ? "." : ",";
  } else if (lastDot !== -1) {
    decimalSep = ".";
  } else if (lastComma !== -1) {
    decimalSep = ",";
  }
  let intPart = s;
  let fracPart = "";
  if (decimalSep !== "") {
    const cut = s.lastIndexOf(decimalSep);
    intPart = s.slice(0, cut);
    fracPart = s.slice(cut + 1);
  }
  const thousands = decimalSep === "." ? "," : ".";
  intPart = intPart.split(thousands).join("");
  if (!/^[0-9]*$/.test(intPart) || !/^[0-9]*$/.test(fracPart)) return null;
  const n = Number(`${intPart.length === 0 ? "0" : intPart}.${fracPart}`);
  return Number.isFinite(n) ? n : null;
}

/** Quantity display: plain, trailing zeros trimmed ("2.500" → "2.5"). */
export function formatQty(qty: number): string {
  if (!Number.isFinite(qty)) return "0";
  let s = qty.toFixed(3);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/** True when y/m/d is a real Gregorian calendar date (1583-9999). */
export function isRealCalendarDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return false;
  }
  if (y < 1583 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= (days[m - 1] as number);
}

/**
 * CII date: format "102" (UN/CEFACT YYYYMMDD) → "yyyy-mm-dd", validated
 * against the real calendar. An already-ISO value is accepted too (some
 * producers); anything else → null.
 */
export function normalizeCiiDate(raw: string, format?: string): string | null {
  const s = raw.trim();
  if (
    s.length === 8 &&
    /^[0-9]{8}$/.test(s) &&
    (format === undefined || format === "102")
  ) {
    const y = Number(s.slice(0, 4));
    const m = Number(s.slice(4, 6));
    const d = Number(s.slice(6, 8));
    if (isRealCalendarDate(y, m, d)) {
      return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    }
    return null;
  }
  const iso = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(s);
  if (iso !== null) {
    if (isRealCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))) {
      return s;
    }
    return null;
  }
  return null;
}

/** UBL cbc:IssueDate: strict ISO yyyy-mm-dd + real calendar check. */
export function normalizeUblDate(raw: string): string | null {
  const s = raw.trim();
  const iso = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(s);
  if (iso === null) return null;
  if (!isRealCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))) {
    return null;
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Dialect detection (root element scan)                               */
/* ------------------------------------------------------------------ */

/** Local name of an element token: "rsm:Root" / "{ns}Root" / "Root" → "Root". */
export function elementLocalName(token: string): string {
  let name = token;
  const brace = name.indexOf("}");
  if (name[0] === "{" && brace !== -1) name = name.slice(brace + 1);
  const colon = name.indexOf(":");
  if (colon !== -1) name = name.slice(colon + 1);
  return name;
}

/**
 * Root-element dialect scan: skips whitespace, BOM, the XML declaration,
 * comments and DOCTYPE; reads the first real element name.
 * "CrossIndustryInvoice" → "CII", "Invoice" → "UBL", anything else → null.
 */
export function detectInvoiceDialect(xml: string): "CII" | "UBL" | null {
  let i = 0;
  const s = xml;
  if (s.charCodeAt(0) === 0xfeff) i = 1;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (i >= s.length) return null;
    if (s.startsWith("<?", i)) {
      const end = s.indexOf("?>", i);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    if (s.startsWith("<!--", i)) {
      const end = s.indexOf("-->", i);
      if (end === -1) return null;
      i = end + 3;
      continue;
    }
    if (s.startsWith("<!", i)) {
      const end = s.indexOf(">", i);
      if (end === -1) return null;
      i = end + 1;
      continue;
    }
    if (s[i] !== "<") return null;
    const nameMatch = /^<([A-Za-z_:][\w.:-]*)/.exec(s.slice(i));
    if (nameMatch === null) return null;
    const local = elementLocalName(nameMatch[1] as string);
    if (local === "CrossIndustryInvoice") return "CII";
    if (local === "Invoice") return "UBL";
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* The shared path-scanner engine                                      */
/* ------------------------------------------------------------------ */

/** One open element on the scan stack: local name, attrs, joined text. */
interface OpenElement {
  ln: string;
  attrs: Record<string, string>;
  text: string;
}

/** Attribute lookup by LOCAL name (prefix-agnostic, the odt-parse rule). */
function attr(attrs: Record<string, string>, local: string): string | undefined {
  const direct = attrs[local];
  if (direct !== undefined) return direct;
  for (const key of Object.keys(attrs)) {
    if (key.slice(key.indexOf(":") + 1) === local) return attrs[key];
  }
  return undefined;
}

/** First safe integer in a trimmed string, or null. */
function toInt(raw: string): number | null {
  const s = raw.trim();
  if (!/^-?[0-9]+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** Records a scalar field once (first occurrence wins — the honest read). */
function setOnce(seen: { sawAny: boolean }, current: string | null, value: string): string | null {
  const trimmed = value.trim();
  if (current === null && trimmed.length > 0) {
    seen.sawAny = true;
    return trimmed;
  }
  return current;
}

/* ------------------------------------------------------------------ */
/* CII parse                                                           */
/* ------------------------------------------------------------------ */

interface CiiLineAcc {
  name: string | null;
  qty: number | null;
  unitNet: number | null;
  lineTotal: number | null;
}

/**
 * Parses a UN/CEFACT Cross Industry Invoice (Factur-X / ZUGFeRD /
 * XRechnung CII) document. Throws EinvoicParseError("not-cii") when the
 * root is not CrossIndustryInvoice and ("no-invoice-data") when not one
 * field could be read.
 */
export function parseCii(xml: string): Einvoice {
  if (detectInvoiceDialect(xml) !== "CII") {
    throw new EinvoicParseError("not-cii");
  }
  const invoice: Einvoice = {
    dialect: "CII",
    profileId: null,
    id: null,
    typeCode: null,
    issueDate: null,
    currency: null,
    buyerReference: null,
    seller: { name: null, vatId: null },
    buyer: { name: null, vatId: null },
    orderRef: null,
    totals: { taxBasis: null, taxTotal: null, grandTotal: null, duePayable: null },
    lines: [],
    raw: { guidelineId: null },
  };
  const seen = { sawAny: false };
  const stack: OpenElement[] = [];
  let lineDepth = 0;
  let line: CiiLineAcc | null = null;

  const finishLine = (): void => {
    if (line === null) return;
    invoice.lines.push({
      name: line.name ?? "",
      qty: line.qty ?? 0,
      unitNet: line.unitNet,
      lineTotal: line.lineTotal,
    });
    line = null;
  };

  const collect = (el: OpenElement, parents: string[]): void => {
    const value = el.text.trim();
    if (line !== null) {
      // ---- inside a line item: unique local names, parent-constrained ----
      const p0 = parents[parents.length - 1];
      if (el.ln === "Name" && p0 === "SpecifiedTradeProduct") {
        if (line.name === null && value.length > 0) {
          line.name = value;
          seen.sawAny = true;
        }
        return;
      }
      if (el.ln === "ChargeAmount" && p0 === "NetPriceProductTradePrice") {
        const cents = parseMoneyToCents(value);
        if (cents !== null && line.unitNet === null) {
          line.unitNet = cents;
          seen.sawAny = true;
        }
        return;
      }
      if (el.ln === "InvoicedQuantity" || el.ln === "BilledQuantity") {
        // The task spec's SpecifiedLineTradeSettlement placement AND the
        // standard's SpecifiedLineTradeDelivery both scan (parent-free).
        const q = parseQuantity(value);
        if (q !== null && line.qty === null) {
          line.qty = q;
          seen.sawAny = true;
        }
        return;
      }
      if (el.ln === "LineTotalAmount") {
        const cents = parseMoneyToCents(value);
        if (cents !== null && line.lineTotal === null) {
          line.lineTotal = cents;
          seen.sawAny = true;
        }
        return;
      }
      return; // nothing else inside a line item is collected
    }

    const p0 = parents[parents.length - 1];
    const p1 = parents[parents.length - 2];

    if (el.ln === "ID") {
      if (
        p0 === "GuidelineSpecifiedDocumentContextParameter" &&
        p1 === "ExchangedDocumentContext"
      ) {
        invoice.profileId = setOnce(seen, invoice.profileId, value);
        invoice.raw.guidelineId = invoice.raw.guidelineId ?? invoice.profileId;
        return;
      }
      if (p0 === "ExchangedDocument") {
        invoice.id = setOnce(seen, invoice.id, value);
        return;
      }
      if (
        (p0 === "SpecifiedLegalRegistration" || p0 === "SpecifiedTaxRegistration") &&
        (p1 === "SellerTradeParty" || p1 === "BuyerTradeParty")
      ) {
        // schemeID="VA" marks the VAT number (real CII: TaxRegistration;
        // the LegalRegistration variant is accepted identically).
        const scheme = (attr(el.attrs, "schemeID") ?? "").trim().toUpperCase();
        if (scheme === "VA" && value.length > 0) {
          const party =
            p1 === "SellerTradeParty" ? invoice.seller : invoice.buyer;
          if (party.vatId === null) {
            party.vatId = value;
            seen.sawAny = true;
          }
        }
        return;
      }
      return;
    }
    if (el.ln === "TypeCode" && p0 === "ExchangedDocument") {
      if (invoice.typeCode === null) {
        const n = toInt(value);
        if (n !== null) {
          invoice.typeCode = n;
          seen.sawAny = true;
        }
      }
      return;
    }
    if (
      el.ln === "DateTimeString" &&
      p0 === "IssueDateTime" &&
      p1 === "ExchangedDocument"
    ) {
      if (invoice.issueDate === null) {
        const normalized = normalizeCiiDate(value, attr(el.attrs, "format"));
        if (normalized !== null) {
          invoice.issueDate = normalized;
          seen.sawAny = true;
        } else if (value.length > 0) {
          // Present but unparseable — still proof this is invoice data
          // (the renderer omits the date; the validator FAILs rule 5).
          seen.sawAny = true;
        }
      }
      return;
    }
    if (el.ln === "BuyerReference" && p0 === "ApplicableHeaderTradeAgreement") {
      invoice.buyerReference = setOnce(seen, invoice.buyerReference, value);
      return;
    }
    if (
      el.ln === "Name" &&
      (p0 === "SellerTradeParty" || p0 === "BuyerTradeParty")
    ) {
      const party = p0 === "SellerTradeParty" ? invoice.seller : invoice.buyer;
      party.name = setOnce(seen, party.name, value);
      return;
    }
    if (
      el.ln === "IssuerAssignedID" &&
      p0 === "BuyerOrderReferencedDocument" &&
      p1 === "ApplicableHeaderTradeAgreement"
    ) {
      invoice.orderRef = setOnce(seen, invoice.orderRef, value);
      return;
    }
    if (el.ln === "InvoiceCurrencyCode" && p0 === "ApplicableHeaderTradeSettlement") {
      invoice.currency = setOnce(seen, invoice.currency, value);
      return;
    }
    if (
      el.ln === "TaxBasisTotalAmount" ||
      el.ln === "TaxTotalAmount" ||
      el.ln === "GrandTotalAmount" ||
      el.ln === "DuePayableAmount"
    ) {
      if (
        p0 === "SpecifiedTradeSettlementHeaderMonetarySummation" &&
        p1 === "ApplicableHeaderTradeSettlement"
      ) {
        const cents = parseMoneyToCents(value);
        if (cents !== null) {
          const totals = invoice.totals;
          if (el.ln === "TaxBasisTotalAmount" && totals.taxBasis === null) {
            totals.taxBasis = cents;
          } else if (el.ln === "TaxTotalAmount" && totals.taxTotal === null) {
            totals.taxTotal = cents;
          } else if (el.ln === "GrandTotalAmount" && totals.grandTotal === null) {
            totals.grandTotal = cents;
          } else if (el.ln === "DuePayableAmount" && totals.duePayable === null) {
            totals.duePayable = cents;
          } else {
            return;
          }
          seen.sawAny = true;
        } else if (value.length > 0) {
          seen.sawAny = true; // present but unparseable — still invoice data
        }
      }
      return;
    }
  };

  scanXmlTags(
    xml,
    (tag) => {
      const ln = elementLocalName(tag.name);
      if (tag.closing) {
        const top = stack.pop();
        if (top === undefined || top.ln !== ln) {
          if (top !== undefined) stack.push(top); // stray close — restore
          return;
        }
        if (ln === "IncludedSupplyChainTradeLineItem") {
          lineDepth -= 1;
          if (lineDepth === 0) finishLine();
          return;
        }
        collect(top, stack.map((e) => e.ln));
        return;
      }
      if (ln === "IncludedSupplyChainTradeLineItem") {
        lineDepth += 1;
        if (lineDepth === 1) {
          line = { name: null, qty: null, unitNet: null, lineTotal: null };
          seen.sawAny = true;
        }
      }
      stack.push({ ln, attrs: tag.attrs, text: "" });
      if (tag.selfClosing) {
        // An instant open+close: run the close path right away so the
        // stack never carries stale entries (the odt-parse discipline).
        const top = stack.pop();
        if (top !== undefined) {
          if (ln === "IncludedSupplyChainTradeLineItem") {
            lineDepth -= 1;
            if (lineDepth === 0) finishLine();
          } else {
            collect(top, stack.map((e) => e.ln));
          }
        }
      }
    },
    (text, raw) => {
      const top = stack[stack.length - 1];
      if (top === undefined) return;
      top.text += raw ? text : unescapeXml(text);
    }
  );
  // Flush anything left open by a truncated/malformed tail.
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === undefined) break;
    if (top.ln === "IncludedSupplyChainTradeLineItem") {
      lineDepth -= 1;
      if (lineDepth === 0) finishLine();
      continue;
    }
    collect(top, stack.map((e) => e.ln));
  }

  if (!seen.sawAny) {
    throw new EinvoicParseError("no-invoice-data");
  }
  return invoice;
}

/* ------------------------------------------------------------------ */
/* UBL parse                                                           */
/* ------------------------------------------------------------------ */

interface UblLineAcc {
  itemName: string | null;
  description: string | null;
  qty: number | null;
  lineTotal: number | null;
}

/**
 * Parses an OASIS UBL 2.1 Invoice document. Throws EinvoicParseError
 * ("not-ubl" / "no-invoice-data") with the same honesty rules as parseCii.
 */
export function parseUbl(xml: string): Einvoice {
  if (detectInvoiceDialect(xml) !== "UBL") {
    throw new EinvoicParseError("not-ubl");
  }
  const invoice: Einvoice = {
    dialect: "UBL",
    profileId: null,
    id: null,
    typeCode: null,
    issueDate: null,
    currency: null,
    buyerReference: null,
    seller: { name: null, vatId: null },
    buyer: { name: null, vatId: null },
    orderRef: null,
    totals: { taxBasis: null, taxTotal: null, grandTotal: null, duePayable: null },
    lines: [],
    raw: { guidelineId: null },
  };
  const seen = { sawAny: false };
  const stack: OpenElement[] = [];
  let lineDepth = 0;
  let line: UblLineAcc | null = null;

  const finishLine = (): void => {
    if (line === null) return;
    invoice.lines.push({
      // The product name wins; a free-text Description stands in when the
      // item carries none (both are valid UBL line names for a rendition).
      name: line.itemName ?? line.description ?? "",
      qty: line.qty ?? 0,
      unitNet: null,
      lineTotal: line.lineTotal,
    });
    line = null;
  };

  const collect = (el: OpenElement, parents: string[]): void => {
    const value = el.text.trim();
    if (line !== null) {
      const p0 = parents[parents.length - 1];
      if (el.ln === "Name" && p0 === "Item") {
        if (line.itemName === null && value.length > 0) {
          line.itemName = value;
          seen.sawAny = true;
        }
        return;
      }
      if (el.ln === "Description" && p0 === "InvoiceLine") {
        if (line.description === null && value.length > 0) {
          line.description = value;
          seen.sawAny = true;
        }
        return;
      }
      if (el.ln === "InvoicedQuantity" && p0 === "InvoiceLine") {
        const q = parseQuantity(value);
        if (q !== null && line.qty === null) {
          line.qty = q;
          seen.sawAny = true;
        }
        return;
      }
      if (el.ln === "LineExtensionAmount" && p0 === "InvoiceLine") {
        const cents = parseMoneyToCents(value);
        if (cents !== null && line.lineTotal === null) {
          line.lineTotal = cents;
          seen.sawAny = true;
        }
        return;
      }
      return;
    }

    const p0 = parents[parents.length - 1];
    const p1 = parents[parents.length - 2];
    const p2 = parents[parents.length - 3];

    if (el.ln === "ID") {
      if (parents.length === 1 && p0 === "Invoice") {
        invoice.id = setOnce(seen, invoice.id, value);
        return;
      }
      if (p0 === "OrderReference" && p1 === "Invoice") {
        invoice.orderRef = setOnce(seen, invoice.orderRef, value);
        return;
      }
      return;
    }
    if (el.ln === "ProfileID" && p0 === "Invoice") {
      invoice.profileId = setOnce(seen, invoice.profileId, value);
      return;
    }
    if (el.ln === "CustomizationID" && p0 === "Invoice") {
      if (invoice.raw.guidelineId === null && value.length > 0) {
        invoice.raw.guidelineId = value;
        seen.sawAny = true;
      }
      return;
    }
    if (el.ln === "InvoiceTypeCode" && p0 === "Invoice") {
      if (invoice.typeCode === null) {
        const n = toInt(value);
        if (n !== null) {
          invoice.typeCode = n;
          seen.sawAny = true;
        }
      }
      return;
    }
    if (el.ln === "IssueDate" && p0 === "Invoice") {
      if (invoice.issueDate === null) {
        const normalized = normalizeUblDate(value);
        if (normalized !== null) {
          invoice.issueDate = normalized;
          seen.sawAny = true;
        } else if (value.length > 0) {
          seen.sawAny = true; // present but invalid — rule 5 FAILs it
        }
      }
      return;
    }
    if (el.ln === "DocumentCurrencyCode" && p0 === "Invoice") {
      invoice.currency = setOnce(seen, invoice.currency, value);
      return;
    }
    if (el.ln === "BuyerReference" && p0 === "Invoice") {
      invoice.buyerReference = setOnce(seen, invoice.buyerReference, value);
      return;
    }
    if (
      el.ln === "Name" &&
      p0 === "PartyName" &&
      p1 === "Party" &&
      (p2 === "AccountingSupplierParty" || p2 === "AccountingCustomerParty")
    ) {
      const party =
        p2 === "AccountingSupplierParty" ? invoice.seller : invoice.buyer;
      party.name = setOnce(seen, party.name, value);
      return;
    }
    if (
      el.ln === "CompanyID" &&
      p0 === "PartyTaxScheme" &&
      p1 === "Party" &&
      (p2 === "AccountingSupplierParty" || p2 === "AccountingCustomerParty")
    ) {
      const party =
        p2 === "AccountingSupplierParty" ? invoice.seller : invoice.buyer;
      if (party.vatId === null && value.length > 0) {
        party.vatId = value;
        seen.sawAny = true;
      }
      return;
    }
    if (el.ln === "TaxAmount" && p0 === "TaxTotal" && p1 === "Invoice") {
      const cents = parseMoneyToCents(value);
      if (cents !== null && invoice.totals.taxTotal === null) {
        invoice.totals.taxTotal = cents;
        seen.sawAny = true;
      }
      return;
    }
    if (
      el.ln === "TaxExclusiveAmount" ||
      el.ln === "TaxInclusiveAmount" ||
      el.ln === "PayableAmount"
    ) {
      if (p0 === "LegalMonetaryTotal" && p1 === "Invoice") {
        const cents = parseMoneyToCents(value);
        if (cents !== null) {
          const totals = invoice.totals;
          if (el.ln === "TaxExclusiveAmount" && totals.taxBasis === null) {
            totals.taxBasis = cents;
          } else if (el.ln === "TaxInclusiveAmount" && totals.grandTotal === null) {
            totals.grandTotal = cents;
          } else if (el.ln === "PayableAmount" && totals.duePayable === null) {
            totals.duePayable = cents;
          } else {
            return;
          }
          seen.sawAny = true;
        } else if (value.length > 0) {
          seen.sawAny = true;
        }
      }
      return;
    }
  };

  scanXmlTags(
    xml,
    (tag) => {
      const ln = elementLocalName(tag.name);
      if (tag.closing) {
        const top = stack.pop();
        if (top === undefined || top.ln !== ln) {
          if (top !== undefined) stack.push(top); // stray close — restore
          return;
        }
        if (ln === "InvoiceLine") {
          lineDepth -= 1;
          if (lineDepth === 0) finishLine();
          return;
        }
        collect(top, stack.map((e) => e.ln));
        return;
      }
      if (ln === "InvoiceLine") {
        lineDepth += 1;
        if (lineDepth === 1) {
          line = { itemName: null, description: null, qty: null, lineTotal: null };
          seen.sawAny = true;
        }
      }
      stack.push({ ln, attrs: tag.attrs, text: "" });
      if (tag.selfClosing) {
        const top = stack.pop();
        if (top !== undefined) {
          if (ln === "InvoiceLine") {
            lineDepth -= 1;
            if (lineDepth === 0) finishLine();
          } else {
            collect(top, stack.map((e) => e.ln));
          }
        }
      }
    },
    (text, raw) => {
      const top = stack[stack.length - 1];
      if (top === undefined) return;
      top.text += raw ? text : unescapeXml(text);
    }
  );
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === undefined) break;
    if (top.ln === "InvoiceLine") {
      lineDepth -= 1;
      if (lineDepth === 0) finishLine();
      continue;
    }
    collect(top, stack.map((e) => e.ln));
  }

  if (!seen.sawAny) {
    throw new EinvoicParseError("no-invoice-data");
  }
  return invoice;
}

/* ------------------------------------------------------------------ */
/* The dispatcher                                                      */
/* ------------------------------------------------------------------ */

/**
 * Detects the dialect and parses with the right scanner. Throws
 * EinvoicParseError("not-invoice") when the root is neither
 * CrossIndustryInvoice nor Invoice (the callers map it to their honest
 * refusals: xmlInvo.errorNotInvoice / validation rule 2 FAIL).
 */
export function parseInvoiceXml(xml: string): Einvoice {
  const dialect = detectInvoiceDialect(xml);
  if (dialect === "CII") return parseCii(xml);
  if (dialect === "UBL") return parseUbl(xml);
  throw new EinvoicParseError("not-invoice");
}
