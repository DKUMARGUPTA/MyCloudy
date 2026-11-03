/**
 * CII / Factur-X EN 16931 XML builder (P12-EINVOICE).
 *
 * Emits a CrossIndustryInvoice (rsm/ram/udt D16B bindings, the XML the
 * Factur-X 1.0 / ZUGFeRD 2.x hybrid format embeds) from the shared form
 * model. Element ORDER follows the canonical Factur-X samples so strict
 * consumers (mustang, the fnfe validators) accept it.
 *
 * Round-trip guarantee: the XML is built so that `parseEInvoice` (the
 * xinv engine — the SAME reader the validate tool uses) recovers every
 * value exactly; the workers re-parse their own output and refuse to
 * emit anything the reader disagrees with (P11 self-verify pattern).
 */

import type { EInvFormState } from "./model";
import { computeForm, type EInvComputed } from "./model";

export const FACTURX_GUIDELINE_EN16931 = "urn:cen.eu:en16931:2017";
export const FACTURX_NS = {
  rsm: "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100",
  qdt: "urn:un:unece:uncefact:data:standard:QualifiedDataType:100",
  ram: "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100",
  udt: "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100",
};

/** Known guideline URNs → the profile name they advertise. */
export const GUIDELINE_PROFILES: Record<string, string> = {
  "urn:cen.eu:en16931:2017": "EN 16931",
  "urn:factur-x.eu:1p0:minimum": "MINIMUM",
  "urn:factur-x.eu:1p0:basicwl": "BASIC WL",
  "urn:factur-x.eu:1p0:basic": "BASIC",
  "urn:factur-x.eu:1p0:en16931": "EN 16931",
  "urn:factur-x.eu:1p0:extended": "EXTENDED",
  "urn:zugferd.de:2p0:minimum": "MINIMUM",
  "urn:zugferd.de:2p0:basicwl": "BASIC WL",
  "urn:zugferd.de:2p0:basic": "BASIC",
  "urn:zugferd.de:2p0:en16931": "EN 16931",
  "urn:zugferd.de:2p0:extended": "EXTENDED",
};

/** XMP fx:ConformanceLevel values → the guideline URN that must match. */
export const LEVEL_TO_GUIDELINE: Record<string, string> = {
  MINIMUM: "urn:factur-x.eu:1p0:minimum",
  "BASIC WL": "urn:factur-x.eu:1p0:basicwl",
  BASIC: "urn:factur-x.eu:1p0:basic",
  "EN 16931": "urn:cen.eu:en16931:2017",
  EXTENDED: "urn:factur-x.eu:1p0:extended",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** "2", "2.5" — minimal exact decimal for quantities. */
function qtyStr(n: number): string {
  return String(n);
}

/** Money with the invoice's decimals ("200.00"; JPY → "200"). */
function money(minorUnits: number, decimals: number): string {
  const v = minorUnits / 10 ** decimals;
  return v.toFixed(decimals);
}

/** Price keeps up to 4 decimals when needed, else 2 (BT-146 allows 4). */
function priceStr(n: number, decimals: number): string {
  const s = n.toFixed(4);
  const trimmed = s.replace(/0+$/, "").replace(/\.$/, "");
  const base = n.toFixed(decimals === 0 ? 2 : decimals);
  return trimmed.length > base.length ? trimmed : base;
}

function date102(iso: string): string {
  return iso.replace(/-/g, "");
}

function ratePercent(rate: number): string {
  return `${rate.toFixed(2)}`;
}

function partyXml(
  tag: string,
  p: EInvFormState["seller"],
  needsAddress: boolean
): string {
  const parts: string[] = [`<ram:${tag}>`];
  if (p.name.trim() !== "") parts.push(`<ram:Name>${esc(p.name.trim())}</ram:Name>`);
  if (p.email.trim() !== "") {
    parts.push(
      "<ram:DefinedTradeContact>",
      "<ram:EmailURIUniversalCommunication>",
      `<ram:URIID schemeID="EM">${esc(p.email.trim())}</ram:URIID>`,
      "</ram:EmailURIUniversalCommunication>",
      "</ram:DefinedTradeContact>"
    );
  }
  if (
    needsAddress ||
    p.street.trim() !== "" ||
    p.city.trim() !== "" ||
    p.postcode.trim() !== ""
  ) {
    parts.push("<ram:PostalTradeAddress>");
    if (p.postcode.trim() !== "") {
      parts.push(`<ram:PostcodeCode>${esc(p.postcode.trim())}</ram:PostcodeCode>`);
    }
    if (p.street.trim() !== "") {
      parts.push(`<ram:LineOne>${esc(p.street.trim())}</ram:LineOne>`);
    }
    if (p.street2.trim() !== "") {
      parts.push(`<ram:LineTwo>${esc(p.street2.trim())}</ram:LineTwo>`);
    }
    if (p.city.trim() !== "") {
      parts.push(`<ram:CityName>${esc(p.city.trim())}</ram:CityName>`);
    }
    if (p.country.trim() !== "") {
      parts.push(`<ram:CountryID>${esc(p.country.trim().toUpperCase())}</ram:CountryID>`);
    }
    parts.push("</ram:PostalTradeAddress>");
  }
  if (p.taxId.trim() !== "") {
    parts.push(
      "<ram:SpecifiedTaxRegistration>",
      `<ram:ID schemeID="${p.taxScheme === "VA" ? "VA" : "IN"}">${esc(p.taxId.trim())}</ram:ID>`,
      "</ram:SpecifiedTaxRegistration>"
    );
  }
  parts.push(`</ram:${tag}>`);
  return parts.join("");
}

/**
 * Build the complete CII XML (UTF-8). `computed` may be passed to keep the
 * builder pure; otherwise it is derived from the form.
 */
export function buildCiiInvoice(
  form: EInvFormState,
  computedIn?: EInvComputed
): string {
  const c = computedIn ?? computeForm(form);
  const dec = c.decimals;
  const cur = form.currency;
  const indent = "    ";

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<rsm:CrossIndustryInvoice xmlns:rsm="${FACTURX_NS.rsm}" xmlns:qdt="${FACTURX_NS.qdt}" xmlns:ram="${FACTURX_NS.ram}" xmlns:udt="${FACTURX_NS.udt}">`
  );

  // ---- ExchangedDocumentContext (the profile declaration).
  lines.push(
    `${indent}<rsm:ExchangedDocumentContext>`,
    `${indent}  <ram:GuidelineSpecifiedDocumentContextParameter>`,
    `${indent}    <ram:ID>${FACTURX_GUIDELINE_EN16931}</ram:ID>`,
    `${indent}  </ram:GuidelineSpecifiedDocumentContextParameter>`,
    `${indent}</rsm:ExchangedDocumentContext>`
  );

  // ---- ExchangedDocument.
  lines.push(`${indent}<rsm:ExchangedDocument>`);
  lines.push(`${indent}  <ram:ID>${esc(form.number.trim())}</ram:ID>`);
  lines.push(`${indent}  <ram:TypeCode>${form.type}</ram:TypeCode>`);
  lines.push(
    `${indent}  <ram:IssueDateTime>`,
    `${indent}    <udt:DateTimeString format="102">${date102(form.issue)}</udt:DateTimeString>`,
    `${indent}  </ram:IssueDateTime>`
  );
  if (form.notes.trim() !== "") {
    lines.push(
      `${indent}  <ram:IncludedNote>`,
      `${indent}    <ram:Content>${esc(form.notes.trim())}</ram:Content>`,
      `${indent}  </ram:IncludedNote>`
    );
  }
  lines.push(`${indent}</rsm:ExchangedDocument>`);

  // ---- SupplyChainTradeTransaction.
  lines.push(`${indent}<rsm:SupplyChainTradeTransaction>`);

  // Lines (canonical order: line doc → product → agreement → delivery → settlement).
  for (const l of c.lines) {
    lines.push(`${indent}  <ram:IncludedSupplyChainTradeLineItem>`);
    lines.push(
      `${indent}    <ram:AssociatedDocumentLineDocument>`,
      `${indent}      <ram:LineID>${l.index + 1}</ram:LineID>`,
      `${indent}    </ram:AssociatedDocumentLineDocument>`
    );
    lines.push(
      `${indent}    <ram:SpecifiedTradeProduct>`,
      `${indent}      <ram:Name>${esc(l.desc)}</ram:Name>`,
      `${indent}    </ram:SpecifiedTradeProduct>`
    );
    lines.push(
      `${indent}    <ram:SpecifiedLineTradeAgreement>`,
      `${indent}      <ram:NetPriceProductTradePrice>`,
      `${indent}        <ram:ChargeAmount>${priceStr(l.price, dec)}</ram:ChargeAmount>`,
      `${indent}      </ram:NetPriceProductTradePrice>`,
      `${indent}    </ram:SpecifiedLineTradeAgreement>`
    );
    lines.push(
      `${indent}    <ram:SpecifiedLineTradeDelivery>`,
      `${indent}      <ram:BilledQuantity unitCode="${l.unit}">${qtyStr(l.qty)}</ram:BilledQuantity>`,
      `${indent}    </ram:SpecifiedLineTradeDelivery>`
    );
    lines.push(
      `${indent}    <ram:SpecifiedLineTradeSettlement>`,
      `${indent}      <ram:ApplicableTradeTax>`,
      `${indent}        <ram:TypeCode>VAT</ram:TypeCode>`,
      `${indent}        <ram:CategoryCode>${l.rate > 0 ? "S" : "Z"}</ram:CategoryCode>`,
      `${indent}        <ram:RateApplicablePercent>${ratePercent(l.rate)}</ram:RateApplicablePercent>`,
      `${indent}      </ram:ApplicableTradeTax>`,
      `${indent}      <ram:SpecifiedTradeSettlementLineMonetarySummation>`,
      `${indent}        <ram:LineTotalAmount>${money(l.net, dec)}</ram:LineTotalAmount>`,
      `${indent}      </ram:SpecifiedTradeSettlementLineMonetarySummation>`,
      `${indent}    </ram:SpecifiedLineTradeSettlement>`,
      `${indent}  </ram:IncludedSupplyChainTradeLineItem>`
    );
  }

  // Header agreement (parties).
  lines.push(`${indent}  <ram:ApplicableHeaderTradeAgreement>`);
  lines.push(`${indent}    ${partyXml("SellerTradeParty", form.seller, false)}`);
  lines.push(`${indent}    ${partyXml("BuyerTradeParty", form.buyer, false)}`);
  lines.push(`${indent}  </ram:ApplicableHeaderTradeAgreement>`);

  // Header delivery (mandatory, may be empty).
  lines.push(`${indent}  <ram:ApplicableHeaderTradeDelivery/>`);

  // Header settlement.
  lines.push(`${indent}  <ram:ApplicableHeaderTradeSettlement>`);
  lines.push(`${indent}    <ram:InvoiceCurrencyCode>${esc(cur)}</ram:InvoiceCurrencyCode>`);

  if (form.iban !== "" || form.upi !== "") {
    lines.push(`${indent}    <ram:SpecifiedTradeSettlementPaymentMeans>`);
    lines.push(
      `${indent}      <ram:TypeCode>${form.iban !== "" ? "58" : "30"}</ram:TypeCode>`
    );
    lines.push(`${indent}      <ram:PayeePartyCreditorFinancialAccount>`);
    if (form.iban !== "") {
      lines.push(`${indent}        <ram:IBANID>${esc(form.iban)}</ram:IBANID>`);
      if (form.accountName.trim() !== "") {
        lines.push(
          `${indent}        <ram:AccountName>${esc(form.accountName.trim())}</ram:AccountName>`
        );
      }
    } else if (form.upi !== "") {
      lines.push(
        `${indent}        <ram:ProprietaryID>${esc(form.upi.trim())}</ram:ProprietaryID>`
      );
    }
    lines.push(`${indent}      </ram:PayeePartyCreditorFinancialAccount>`);
    lines.push(`${indent}    </ram:SpecifiedTradeSettlementPaymentMeans>`);
  }

  // VAT breakdown per rate.
  for (const t of c.taxes) {
    lines.push(
      `${indent}    <ram:ApplicableTradeTax>`,
      `${indent}      <ram:CalculatedAmount>${money(t.tax, dec)}</ram:CalculatedAmount>`,
      `${indent}      <ram:TypeCode>VAT</ram:TypeCode>`,
      `${indent}      <ram:BasisAmount>${money(t.basis, dec)}</ram:BasisAmount>`,
      `${indent}      <ram:CategoryCode>${t.rate > 0 ? "S" : "Z"}</ram:CategoryCode>`,
      `${indent}      <ram:RateApplicablePercent>${ratePercent(t.rate)}</ram:RateApplicablePercent>`,
      `${indent}    </ram:ApplicableTradeTax>`
    );
  }

  if (form.due !== "") {
    lines.push(
      `${indent}    <ram:SpecifiedTradePaymentTerms>`,
      `${indent}      <ram:DueDateDateTime>`,
      `${indent}        <udt:DateTimeString format="102">${date102(form.due)}</udt:DateTimeString>`,
      `${indent}      </ram:DueDateDateTime>`,
      `${indent}    </ram:SpecifiedTradePaymentTerms>`
    );
  }

  lines.push(`${indent}    <ram:SpecifiedTradeSettlementHeaderMonetarySummation>`);
  lines.push(
    `${indent}      <ram:LineTotalAmount>${money(c.lineTotal, dec)}</ram:LineTotalAmount>`
  );
  lines.push(
    `${indent}      <ram:TaxBasisTotalAmount>${money(c.lineTotal, dec)}</ram:TaxBasisTotalAmount>`
  );
  lines.push(
    `${indent}      <ram:TaxTotalAmount currencyID="${esc(cur)}">${money(c.taxTotal, dec)}</ram:TaxTotalAmount>`
  );
  lines.push(
    `${indent}      <ram:GrandTotalAmount>${money(c.grand, dec)}</ram:GrandTotalAmount>`
  );
  lines.push(
    `${indent}      <ram:DuePayableAmount>${money(c.grand, dec)}</ram:DuePayableAmount>`
  );
  lines.push(
    `${indent}    </ram:SpecifiedTradeSettlementHeaderMonetarySummation>`
  );
  lines.push(`${indent}  </ram:ApplicableHeaderTradeSettlement>`);

  lines.push(`${indent}</rsm:SupplyChainTradeTransaction>`);
  lines.push("</rsm:CrossIndustryInvoice>");
  return `${lines.join("\n")}\n`;
}

/** The byte form the workers embed (UTF-8). */
export function ciiBytes(form: EInvFormState, computedIn?: EInvComputed): Uint8Array {
  return new TextEncoder().encode(buildCiiInvoice(form, computedIn));
}
