/**
 * CII XML builder for the Factur-X Minimum profile (Task b6-c) —
 * PURE, zero pdf-lib / pdf.js imports. Runs identically in the tool
 * workers and under bun in the smokes.
 *
 * The emitted shape is the CrossIndustryInvoice document the Factur-X
 * 1.0 "minimum" profile mandates (urn:factur-x.eu:1p0:minimum — the
 * same basic EN 16931 dataset ZUGFeRD 2.x uses): one header ID, the
 * 380 commercial-invoice type code, an ISO 102 date, seller + buyer
 * names, an optional seller VAT/GST registration, the currency code
 * and the four monetary summation totals.
 *
 * MONEY = INTEGER CENTS everywhere (the create-invoice paise-int
 * lesson): amounts are formatted by string surgery from cents, never
 * through binary floats. Dates convert ISO "2024-01-15" → the udt 102
 * form "20240115". Every text value is XML-escaped.
 */

/** The invoice facts the CII Minimum profile can carry. */
export interface InvoiceFacts {
  /** Invoice number ("INV-001"). Mandatory in the tool pipeline. */
  id: string;
  /** Issue date, ISO "2024-01-15". Mandatory in the tool pipeline. */
  issueDate: string;
  /** ISO-4217 code ("EUR"). Mandatory in the tool pipeline. */
  currency: string;
  /** Seller / supplier name. Mandatory in the tool pipeline. */
  sellerName: string;
  /** Seller VAT id ("DE123456789") or GSTIN — null omits the block. */
  sellerVatId: string | null;
  /** Buyer name. Mandatory in the tool pipeline. */
  buyerName: string;
  /** Buyer reference — null omits the element. */
  buyerReference: string | null;
  /** Net / tax-basis total in cents. */
  taxBasis: number;
  /** Tax total in cents. */
  taxTotal: number;
  /** Grand total in cents. Mandatory in the tool pipeline. */
  grandTotal: number;
  /** Due payable amount in cents. */
  duePayable: number;
}

/** The guideline id the Minimum profile carries. */
export const FACTURX_MINIMUM_GUIDELINE = "urn:factur-x.eu:1p0:minimum";

/** The embedded file name the Factur-X spec mandates. */
export const FACTURX_XML_NAME = "factur-x.xml";

/** XML-escapes a text value (& first, then < > " '). */
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Integer cents → the decimal string CII wants ("123.45"). Pure
 * string surgery: sign, integer part, padded 2-digit fraction — a
 * binary float never touches the money.
 */
export function centsToDecimal(cents: number): string {
  if (!Number.isFinite(cents) || !Number.isInteger(cents)) {
    throw new Error("cii: non-integer cents");
  }
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const units = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${units}.${frac < 10 ? `0${frac}` : `${frac}`}`;
}

/** ISO "2024-01-15" → the udt DateTimeString 102 form "20240115". */
export function isoToUdt102(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (match === null) {
    throw new Error(`cii: bad issue date ${JSON.stringify(iso)}`);
  }
  const [, y, m, d] = match;
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`cii: bad issue date ${JSON.stringify(iso)}`);
  }
  return `${y}${m}${d}`;
}

/**
 * Builds the exact CrossIndustryInvoice XML (the Minimum-profile
 * shape pinned in the tool spec). Optional facts (sellerVatId,
 * buyerReference) omit their elements; everything else always ships.
 */
export function buildCiiXml(f: InvoiceFacts): string {
  const esc = escapeXmlText;
  const cur = f.currency;
  const vatBlock =
    f.sellerVatId !== null && f.sellerVatId.length > 0
      ? `\n        <ram:SpecifiedLegalRegistration><ram:ID schemeID="VA">${esc(
          f.sellerVatId
        )}</ram:ID></ram:SpecifiedLegalRegistration>`
      : "";
  const buyerRefBlock =
    f.buyerReference !== null && f.buyerReference.length > 0
      ? `\n      <ram:BuyerReference>${esc(f.buyerReference)}</ram:BuyerReference>`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntityDataType:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>${FACTURX_MINIMUM_GUIDELINE}</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${esc(f.id)}</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">${isoToUdt102(
      f.issueDate
    )}</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:ApplicableHeaderTradeAgreement>${buyerRefBlock}
      <ram:SellerTradeParty>
        <ram:Name>${esc(f.sellerName)}</ram:Name>${vatBlock}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>${esc(f.buyerName)}</ram:Name>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${esc(cur)}</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:TaxBasisTotalAmount currencyID="${esc(
          cur
        )}">${centsToDecimal(f.taxBasis)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${esc(
          cur
        )}">${centsToDecimal(f.taxTotal)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount currencyID="${esc(
          cur
        )}">${centsToDecimal(f.grandTotal)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount currencyID="${esc(
          cur
        )}">${centsToDecimal(f.duePayable)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;
}

/** One-line money helper for summaries ("EUR 119.00"). */
export function money(cents: number, currency: string): string {
  return `${currency} ${centsToDecimal(cents)}`;
}

/**
 * A short human summary of the facts (one line) — the string the
 * not-enough-data error and the smoke report carry.
 */
export function factsSummary(f: InvoiceFacts): string {
  const vat =
    f.sellerVatId !== null && f.sellerVatId.length > 0
      ? ` (VAT ${f.sellerVatId})`
      : "";
  return `${f.id} · ${f.issueDate} · ${f.sellerName}${vat} → ${f.buyerName} · ${money(
    f.grandTotal,
    f.currency
  )}`;
}
