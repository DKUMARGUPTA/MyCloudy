import {
  CONFORMANCE_LEVELS,
  DEFAULT_LEVEL,
  type CiiShape,
  type ConformanceLevel,
  type SampleInvoiceForm,
} from "./types";

/**
 * create-electronic-invoice model (RB5-b) — PURE, no DOM, no pdf-lib,
 * bun-testable (scripts/smoke-create-electronic-invoice.ts).
 *
 * Three jobs:
 *  1. buildXmpPacket — the Factur-X XMP block (fx:DocumentType etc.) the
 *     worker writes into the catalog /Metadata stream.
 *  2. validateCiiShape — a light, DOM-free structural sniff of the supplied
 *     CII XML (root + context + settlement + invoice id + currency + line
 *     count). This is NOT a semantic EN 16931 validation — that is the
 *     validate-e-invoice tool's job. We only refuse XML that is not a
 *     rsm:CrossIndustryInvoice at all (embedding it as factur-x.xml would
 *     produce a file Factur-X readers reject).
 *  3. sampleXmlFromForm — generates a real, well-formed, namespace-correct
 *     CII document (EN 16931 shape) from the small sample form so users can
 *     test the embed flow without having XML at hand.
 *
 * Plus classifyError for the worker's error mapping.
 */

/* ------------------------------------------------------------------ */
/* Conformance level                                                   */
/* ------------------------------------------------------------------ */

/** Normalizes anything to a legal level; unknown → EN 16931. */
export function normalizeLevel(value: unknown): ConformanceLevel {
  const s = typeof value === "string" ? value.trim() : "";
  for (const level of CONFORMANCE_LEVELS) {
    if (s === level) return level;
  }
  return DEFAULT_LEVEL;
}

/* ------------------------------------------------------------------ */
/* 1. XMP packet                                                       */
/* ------------------------------------------------------------------ */

/** The official Factur-X / ZUGFeRD 2.x XMP namespace. */
export const FX_NAMESPACE =
  "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#";

/** XML-escapes text content + attribute values. */
function xmlEscape(text: string): string {
  return text
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;")
    .split("'")
    .join("&apos;");
}

/**
 * The minimal-but-well-formed Factur-X XMP packet: one rdf:Description
 * carrying dc:format, pdf:Producer, xmp:CreatorTool and the four fx:
 * properties Factur-X/ZUGFeRD readers (mustangproject & friends) parse:
 * DocumentType, DocumentFileName, Version, ConformanceLevel.
 */
export function buildXmpPacket(
  level: unknown,
  producer: string
): string {
  const conformance = normalizeLevel(level);
  const safeProducer = xmlEscape(producer.slice(0, 120));
  return (
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">\n` +
    `  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n` +
    `    <rdf:Description rdf:about="" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:pdf="http://ns.adobe.com/pdf/1.3/" ` +
    `xmlns:xmp="http://ns.adobe.com/xap/1.0/" ` +
    `xmlns:fx="${FX_NAMESPACE}">\n` +
    `      <dc:format>application/pdf</dc:format>\n` +
    `      <pdf:Producer>${safeProducer}</pdf:Producer>\n` +
    `      <xmp:CreatorTool>${safeProducer}</xmp:CreatorTool>\n` +
    `      <fx:DocumentType>INVOICE</fx:DocumentType>\n` +
    `      <fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>\n` +
    `      <fx:Version>1.0</fx:Version>\n` +
    `      <fx:ConformanceLevel>${xmlEscape(conformance)}</fx:ConformanceLevel>\n` +
    `    </rdf:Description>\n` +
    `  </rdf:RDF>\n` +
    `</x:xmpmeta>\n` +
    `<?xpacket end="w"?>\n`
  );
}

/* ------------------------------------------------------------------ */
/* 2. CII structural sniff (DOM-free string parse)                    */
/* ------------------------------------------------------------------ */

/** Strips a UTF-8 BOM if present. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Does `<tag …>` or `<tag>` (or self-closing) occur in the text? */
function hasElement(text: string, tag: string): boolean {
  const needle = `<${tag}`;
  let at = text.indexOf(needle);
  while (at !== -1) {
    const after = text.charAt(at + needle.length);
    if (after === "" || after === ">" || after === "/" || after === " " ||
      after === "\t" || after === "\n" || after === "\r") {
      return true;
    }
    at = text.indexOf(needle, at + 1);
  }
  return false;
}

/**
 * First text content of `<tag …>…</tag>` searched FROM `from`
 * ("" when absent). No regex with capture over huge bodies — plain
 * indexOf slicing (XML text values here are tiny).
 */
function elementTextFrom(text: string, tag: string, from: number): string {
  const open = text.indexOf(`<${tag}`, from);
  if (open === -1) return "";
  const openEnd = text.indexOf(">", open);
  if (openEnd === -1) return "";
  if (text.charAt(openEnd - 1) === "/") return ""; // self-closing <tag/>
  const inner = text.slice(openEnd + 1);
  const close = inner.indexOf(`</${tag}>`);
  if (close === -1) return "";
  const body = inner.slice(0, close);
  // our targets carry direct text — stop at the first child element
  const child = body.indexOf("<");
  const direct = child === -1 ? body : body.slice(0, child);
  return direct.trim();
}

/**
 * Light structural sniff of a CII document. Honest scope: this checks the
 * root + the two header groups every rsm:CrossIndustryInvoice carries and
 * reads three facts for the report — nothing more. Semantic validation
 * (EN 16931 schematron, value ranges, math) belongs to validate-e-invoice.
 */
export function validateCiiShape(xmlText: string): CiiShape {
  const text = stripBom(typeof xmlText === "string" ? xmlText : "");
  const rootOk = hasElement(text, "rsm:CrossIndustryInvoice");
  const contextOk = hasElement(text, "rsm:ExchangedDocumentContext");
  const settlementOk = hasElement(text, "ram:ApplicableHeaderTradeSettlement");

  // Invoice id: the ram:ID inside rsm:ExchangedDocument — anchored at the
  // element itself (a plain indexOf would hit <rsm:ExchangedDocumentContext
  // FIRST, whose ram:ID is the guideline URN — the smoke caught exactly
  // that collision).
  let invoiceId = "";
  const docNeedle = "<rsm:ExchangedDocument";
  let docAt = -1;
  let scan = text.indexOf(docNeedle);
  while (scan !== -1) {
    const after = text.charAt(scan + docNeedle.length);
    if (after === "" || after === ">" || after === "/" || after === " " ||
      after === "\t" || after === "\n" || after === "\r") {
      docAt = scan;
      break;
    }
    scan = text.indexOf(docNeedle, scan + 1);
  }
  if (docAt !== -1) {
    invoiceId = elementTextFrom(text, "ram:ID", docAt);
  }

  // Currency: the one InvoiceCurrencyCode occurrence.
  const currency = elementTextFrom(text, "ram:InvoiceCurrencyCode", 0);

  // Line items: count open tags only (close tags carry the same string).
  let lineCount = 0;
  const lineNeedle = "<ram:IncludedSupplyChainTradeLineItem";
  let at = text.indexOf(lineNeedle);
  while (at !== -1) {
    const after = text.charAt(at + lineNeedle.length);
    if (after === "" || after === ">" || after === "/" || after === " " ||
      after === "\t" || after === "\n" || after === "\r") {
      lineCount += 1;
    }
    at = text.indexOf(lineNeedle, at + 1);
  }

  return {
    ok: rootOk && contextOk && settlementOk,
    rootOk,
    contextOk,
    settlementOk,
    invoiceId,
    currency,
    lineCount,
  };
}

/* ------------------------------------------------------------------ */
/* 3. Sample CII generator (EN 16931 shape)                            */
/* ------------------------------------------------------------------ */

const CURRENCIES = ["EUR", "INR", "USD", "GBP"] as const;

/** 2-decimal money formatting with dot separator (CII decimal). */
export function fmtMoney(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

/** 0-3 decimal quantity formatting (no exponent, dot separator). */
export function fmtQty(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function coerceText(value: unknown, fallback: string, max: number): string {
  const s = typeof value === "string" ? value.trim() : "";
  return (s === "" ? fallback : s).slice(0, max);
}

function coerceDate102(value: unknown): string {
  const digits = (typeof value === "string" ? value : "")
    .split("")
    .filter((c) => c >= "0" && c <= "9")
    .join("");
  return digits.length === 8 ? digits : "20260101";
}

/**
 * Builds a REAL, well-formed, namespace-correct rsm:CrossIndustryInvoice
 * (EN 16931 guideline) from the small sample form: ExchangedDocument with
 * ID + TypeCode 380 + IssueDateTime(102), per-line items with
 * LineID/Product/NetPrice/BilledQuantity/LineTotal, the header trade
 * agreement (Seller/Buyer names), delivery, settlement with
 * InvoiceCurrencyCode, ApplicableTradeTax and the full monetary summation
 * (LineTotal → TaxBasis → TaxTotal → GrandTotal → DuePayable).
 *
 * All money is derived from the inputs — the totals always add up.
 */
export function sampleXmlFromForm(form: SampleInvoiceForm): string {
  const seller = coerceText(form.seller, "Sample Seller", 120);
  const buyer = coerceText(form.buyer, "Sample Buyer", 120);
  const number = coerceText(form.number, "SAMPLE-1", 60);
  const date102 = coerceDate102(form.date);
  const currencyRaw = typeof form.currency === "string"
    ? form.currency.trim().toUpperCase()
    : "";
  const currency = (CURRENCIES as readonly string[]).includes(currencyRaw)
    ? currencyRaw
    : "EUR";

  const taxRateRaw = typeof form.taxRate === "number" ? form.taxRate : 18;
  const taxRate = Number.isFinite(taxRateRaw)
    ? Math.min(Math.max(Math.round(taxRateRaw * 100) / 100, 0), 100)
    : 18;
  // 0% is zero-rated in EN 16931 terms (Z), otherwise standard rated (S).
  const categoryCode = taxRate === 0 ? "Z" : "S";

  const itemsRaw = Array.isArray(form.items) ? form.items.slice(0, 3) : [];
  const items = itemsRaw.map((item) => ({
    name: coerceText(item?.name, "Item", 120),
    qty:
      typeof item?.qty === "number" && Number.isFinite(item.qty) && item.qty > 0
        ? Math.min(item.qty, 1_000_000)
        : 1,
    unitPrice:
      typeof item?.unitPrice === "number" && Number.isFinite(item.unitPrice) && item.unitPrice > 0
        ? item.unitPrice
        : 0,
  }));
  if (items.length === 0) {
    items.push({ name: "Item", qty: 1, unitPrice: 0 });
  }

  const lines = items.map((item, index) => {
    const lineTotal = Math.round(item.qty * item.unitPrice * 100) / 100;
    return {
      index: index + 1,
      name: item.name,
      qty: item.qty,
      unitPrice: item.unitPrice,
      lineTotal,
    };
  });

  const lineTotalAmount =
    Math.round(lines.reduce((sum, l) => sum + l.lineTotal, 0) * 100) / 100;
  const taxBasisTotalAmount = lineTotalAmount;
  const calculatedTax =
    Math.round((taxBasisTotalAmount * taxRate) / 100 * 100) / 100;
  const grandTotalAmount = taxBasisTotalAmount + calculatedTax;

  const esc = xmlEscape;
  const lineXml = lines
    .map(
      (l) =>
        `    <ram:IncludedSupplyChainTradeLineItem>\n` +
        `      <ram:AssociatedDocumentLineDocument>\n` +
        `        <ram:LineID>${l.index}</ram:LineID>\n` +
        `      </ram:AssociatedDocumentLineDocument>\n` +
        `      <ram:SpecifiedTradeProduct>\n` +
        `        <ram:Name>${esc(l.name)}</ram:Name>\n` +
        `      </ram:SpecifiedTradeProduct>\n` +
        `      <ram:SpecifiedLineTradeAgreement>\n` +
        `        <ram:NetPriceProductTradePrice>\n` +
        `          <ram:ChargeAmount>${fmtMoney(l.unitPrice)}</ram:ChargeAmount>\n` +
        `        </ram:NetPriceProductTradePrice>\n` +
        `      </ram:SpecifiedLineTradeAgreement>\n` +
        `      <ram:SpecifiedLineTradeDelivery>\n` +
        `        <ram:BilledQuantity unitCode="C62">${fmtQty(l.qty)}</ram:BilledQuantity>\n` +
        `      </ram:SpecifiedLineTradeDelivery>\n` +
        `      <ram:SpecifiedLineTradeSettlement>\n` +
        `        <ram:ApplicableTradeTax>\n` +
        `          <ram:TypeCode>VAT</ram:TypeCode>\n` +
        `          <ram:CategoryCode>${categoryCode}</ram:CategoryCode>\n` +
        `          <ram:RateApplicablePercent>${fmtMoney(taxRate)}</ram:RateApplicablePercent>\n` +
        `        </ram:ApplicableTradeTax>\n` +
        `        <ram:SpecifiedTradeSettlementLineMonetarySummation>\n` +
        `          <ram:LineTotalAmount>${fmtMoney(l.lineTotal)}</ram:LineTotalAmount>\n` +
        `        </ram:SpecifiedTradeSettlementLineMonetarySummation>\n` +
        `      </ram:SpecifiedLineTradeSettlement>\n` +
        `    </ram:IncludedSupplyChainTradeLineItem>`
    )
    .join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rsm:CrossIndustryInvoice ` +
    `xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" ` +
    `xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100" ` +
    `xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" ` +
    `xmlns:xs="http://www.w3.org/2001/XMLSchema" ` +
    `xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">\n` +
    `  <rsm:ExchangedDocumentContext>\n` +
    `    <ram:GuidelineSpecifiedDocumentContextParameter>\n` +
    `      <ram:ID>urn:cen.eu:en16931:2017</ram:ID>\n` +
    `    </ram:GuidelineSpecifiedDocumentContextParameter>\n` +
    `  </rsm:ExchangedDocumentContext>\n` +
    `  <rsm:ExchangedDocument>\n` +
    `    <ram:ID>${esc(number)}</ram:ID>\n` +
    `    <ram:TypeCode>380</ram:TypeCode>\n` +
    `    <ram:IssueDateTime>\n` +
    `      <udt:DateTimeString format="102">${date102}</udt:DateTimeString>\n` +
    `    </ram:IssueDateTime>\n` +
    `  </rsm:ExchangedDocument>\n` +
    `  <rsm:SupplyChainTradeTransaction>\n` +
    `${lineXml}\n` +
    `    <ram:ApplicableHeaderTradeAgreement>\n` +
    `      <ram:SellerTradeParty>\n` +
    `        <ram:Name>${esc(seller)}</ram:Name>\n` +
    `      </ram:SellerTradeParty>\n` +
    `      <ram:BuyerTradeParty>\n` +
    `        <ram:Name>${esc(buyer)}</ram:Name>\n` +
    `      </ram:BuyerTradeParty>\n` +
    `    </ram:ApplicableHeaderTradeAgreement>\n` +
    `    <ram:ApplicableHeaderTradeDelivery/>\n` +
    `    <ram:ApplicableHeaderTradeSettlement>\n` +
    `      <ram:InvoiceCurrencyCode>${currency}</ram:InvoiceCurrencyCode>\n` +
    `      <ram:ApplicableTradeTax>\n` +
    `        <ram:TypeCode>VAT</ram:TypeCode>\n` +
    `        <ram:CategoryCode>${categoryCode}</ram:CategoryCode>\n` +
    `        <ram:BasisAmount>${fmtMoney(taxBasisTotalAmount)}</ram:BasisAmount>\n` +
    `        <ram:CalculatedAmount>${fmtMoney(calculatedTax)}</ram:CalculatedAmount>\n` +
    `        <ram:RateApplicablePercent>${fmtMoney(taxRate)}</ram:RateApplicablePercent>\n` +
    `      </ram:ApplicableTradeTax>\n` +
    `      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>\n` +
    `        <ram:LineTotalAmount>${fmtMoney(lineTotalAmount)}</ram:LineTotalAmount>\n` +
    `        <ram:TaxBasisTotalAmount>${fmtMoney(taxBasisTotalAmount)}</ram:TaxBasisTotalAmount>\n` +
    `        <ram:TaxTotalAmount currencyID="${currency}">${fmtMoney(calculatedTax)}</ram:TaxTotalAmount>\n` +
    `        <ram:GrandTotalAmount>${fmtMoney(grandTotalAmount)}</ram:GrandTotalAmount>\n` +
    `        <ram:DuePayableAmount>${fmtMoney(grandTotalAmount)}</ram:DuePayableAmount>\n` +
    `      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>\n` +
    `    </ram:ApplicableHeaderTradeSettlement>\n` +
    `  </rsm:SupplyChainTradeTransaction>\n` +
    `</rsm:CrossIndustryInvoice>\n`
  );
}

/* ------------------------------------------------------------------ */
/* Error classification (worker + smoke share the exact mapping)       */
/* ------------------------------------------------------------------ */

/** Maps a load/run failure to the honest i18n error code. */
export function classifyCeiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/password|encrypt/i.test(message)) return "tool.errorEncrypted";
  return "tool.errorCorrupt";
}
