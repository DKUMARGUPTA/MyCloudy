/**
 * e-invoice parsing + validation (P9 batch 5) — pure functions over
 * XML text (via the minixml walker), shared by xml-invoice-to-pdf and
 * validate-e-invoice. Maps CII (Factur-X/ZUGFeRD) and UBL 2.1
 * invoices onto the existing create-invoice InvoiceState so the SAME
 * PDF engine renders them.
 *
 * Coverage is the EN 16931 core subset (the same subset buildCiiXml
 * writes) — honest in every FAQ. All lookups are SCOPED: the invoice
 * number comes from ExchangedDocument/ID, never the guideline ID.
 */

import {
  type InvoiceState,
} from "../create-invoice/model";
import { emptyInvoice } from "./blank";
import { allScopes, scopeOf, xmlDialect, xmlTag, xmlTags } from "./minixml";

export interface ParseResult {
  state: InvoiceState;
  dialect: "cii" | "ubl" | "other";
  /** Human-readable gaps ("no seller GSTIN found") — surfaces show them. */
  notes: string[];
}

/** yyyy-mm-dd from yyyymmdd or ISO or dd.mm.yyyy. */
function isoDate(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const m = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const e = raw.match(/(\d{2})[.\/](\d{2})[.\/](\d{4})/);
  if (e) return `${e[3]}-${e[2]}-${e[1]}`;
  return "";
}

/** "123.45" → paise integer (12345); "1,234.50" handled too. */
function paise(raw: string): number {
  const n = parseFloat(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** ---- CII ---- */
function fromCii(xml: string): { state: InvoiceState; notes: string[] } {
  const s = emptyInvoice();
  const notes: string[] = [];

  const doc = scopeOf(xml, "ExchangedDocument");
  s.no = xmlTag(doc, "ID") || "IMPORTED";
  s.date = isoDate(xmlTag(doc, "DateTimeString"));

  const terms = scopeOf(xml, "SpecifiedTradePaymentTerms");
  s.due = isoDate(xmlTag(terms, "DateTimeString"));

  const agreement = scopeOf(xml, "ApplicableHeaderTradeAgreement");
  const seller = scopeOf(agreement, "SellerTradeParty");
  const buyer = scopeOf(agreement, "BuyerTradeParty");
  s.biz.name = xmlTag(seller, "Name");
  s.biz.gstin = xmlTag(seller, "ID").replace(/^[A-Z]{2}:/, "");
  s.biz.addr = [xmlTag(seller, "LineOne"), xmlTag(seller, "LineTwo")]
    .filter(Boolean)
    .join("\n");
  s.biz.email = xmlTag(seller, "URIID");
  s.cli.name = xmlTag(buyer, "Name");
  s.cli.gstin = xmlTag(buyer, "ID").replace(/^[A-Z]{2}:/, "");
  s.cli.addr = [xmlTag(buyer, "LineOne"), xmlTag(buyer, "LineTwo")]
    .filter(Boolean)
    .join("\n");

  s.cur = (xmlTag(xml, "InvoiceCurrencyCode") || "INR") as InvoiceState["cur"];

  // Line items — fully scoped per item.
  const lineScopes = allScopes(xml, "IncludedSupplyChainTradeLineItem");
  for (const line of lineScopes.slice(0, 60)) {
    s.items.push({
      d: xmlTag(line, "Name") || "Item",
      h: xmlTag(line, "GlobalID").replace(/^[A-Z]{2}:/, ""),
      q: xmlTag(line, "BilledQuantity") || "1",
      r: xmlTag(line, "ChargeAmount"),
      g: xmlTag(line, "RateApplicablePercent") || "18",
    });
  }
  if (s.items.length === 0) notes.push("no line items found");

  // A sensible single tax rate for the std family recompute.
  const rates = xmlTags(xml, "RateApplicablePercent", undefined, 50)
    .map((r) => parseFloat(r))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (rates.length > 0) s.tr = String(Math.max(...rates));

  if (!s.biz.name) notes.push("no seller name found");
  if (!s.cli.name) notes.push("no buyer name found");
  return { state: s, notes };
}

/** ---- UBL 2.1 ---- */
function fromUbl(xml: string): { state: InvoiceState; notes: string[] } {
  const s = emptyInvoice();
  const notes: string[] = [];

  // The invoice-level ID/IssueDate appear before any line.
  s.no = xmlTag(xml, "ID") || "IMPORTED";
  s.date = isoDate(xmlTag(xml, "IssueDate"));
  s.due = isoDate(xmlTag(xml, "DueDate"));

  const supplier = scopeOf(xml, "AccountingSupplierParty");
  const customer = scopeOf(xml, "AccountingCustomerParty");
  s.biz.name = xmlTag(supplier, "Name");
  s.cli.name = xmlTag(customer, "Name");
  s.biz.gstin = xmlTag(supplier, "CompanyID").replace(/^[A-Z]{2}:/, "");
  s.cli.gstin = xmlTag(customer, "CompanyID").replace(/^[A-Z]{2}:/, "");
  s.biz.addr = xmlTag(supplier, "Line");
  s.cli.addr = xmlTag(customer, "Line");

  s.cur = (xmlTag(xml, "DocumentCurrencyCode") || "INR") as InvoiceState["cur"];

  const lines = allScopes(xml, "InvoiceLine");
  for (const line of lines.slice(0, 60)) {
    s.items.push({
      d: xmlTag(line, "Name") || "Item",
      h: "",
      q: xmlTag(line, "InvoicedQuantity") || "1",
      r: xmlTag(line, "PriceAmount"),
      g: xmlTag(line, "Percent") || "18",
    });
  }
  if (s.items.length === 0) notes.push("no line items found");
  if (!s.biz.name) notes.push("no seller name found");
  if (!s.cli.name) notes.push("no buyer name found");
  return { state: s, notes };
}

/** Parses CII or UBL XML into an InvoiceState (+ notes). */
export function parseInvoiceXml(xml: string): ParseResult {
  const dialect = xmlDialect(xml);
  if (dialect === "ubl") {
    const { state, notes } = fromUbl(xml);
    return { state, dialect, notes };
  }
  const { state, notes } = fromCii(xml);
  return { state, dialect: dialect === "other" ? "other" : "cii", notes };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface EInvoiceCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  note: string;
}

export interface EInvoiceVerdict {
  checks: EInvoiceCheck[];
  failed: number;
  warnings: number;
}

/** EN 16931 core-subset rule checks over an e-invoice XML. */
export function validateEInvoiceXml(xml: string): EInvoiceVerdict {
  const checks: EInvoiceCheck[] = [];
  let failed = 0;
  let warnings = 0;
  const add = (name: string, status: EInvoiceCheck["status"], note: string) => {
    checks.push({ name, status, note });
    if (status === "fail") failed += 1;
    if (status === "warn") warnings += 1;
  };

  const dialect = xmlDialect(xml);
  if (dialect === "other") {
    return {
      checks: [
        {
          name: "XML dialect",
          status: "fail",
          note: "root element is neither CrossIndustryInvoice (CII) nor Invoice (UBL) — this is not an e-invoice XML",
        },
      ],
      failed: 1,
      warnings: 0,
    };
  }
  add(
    "XML dialect",
    "pass",
    dialect === "cii"
      ? "CrossIndustryInvoice (CII — Factur-X / ZUGFeRD / XRechnung family)"
      : "UBL 2.1 Invoice"
  );

  const guideline = xmlTag(xml, "GuidelineSpecifiedDocumentContextParameter") ||
    (xml.includes("SpecificationID") ? xmlTag(xml, "SpecificationID") : "");
  if (guideline) {
    add("Guideline / profile", "pass", guideline);
  } else {
    add("Guideline / profile", "warn", "no guideline ID — some portals require it (Factur-X: urn:…:en16931…)");
  }

  /* Invoice number + dates — scoped per dialect. */
  let id = "";
  let issued = "";
  let seller = "";
  let buyer = "";
  let cur = "";
  let lineTotalsRaw: string[] = [];
  let grand = 0;
  let basis = 0;
  let tax = 0;

  if (dialect === "cii") {
    const doc = scopeOf(xml, "ExchangedDocument");
    id = xmlTag(doc, "ID");
    issued = isoDate(xmlTag(doc, "DateTimeString"));
    const agreement = scopeOf(xml, "ApplicableHeaderTradeAgreement");
    const sellerScope = scopeOf(agreement, "SellerTradeParty");
    const buyerScope = scopeOf(agreement, "BuyerTradeParty");
    seller = xmlTag(sellerScope, "Name");
    buyer = xmlTag(buyerScope, "Name");
    cur = xmlTag(xml, "InvoiceCurrencyCode");
    const summation = scopeOf(xml, "SpecifiedTradeSettlementHeaderMonetarySummation");
    // Line-level LineTotalAmounts + the header's own (last) one.
    const allLineTotals = xmlTags(xml, "LineTotalAmount", undefined, 200);
    const headerLine = xmlTag(summation, "LineTotalAmount");
    lineTotalsRaw =
      headerLine !== "" && allLineTotals[allLineTotals.length - 1] === headerLine
        ? allLineTotals.slice(0, -1)
        : allLineTotals;
    grand = paise(xmlTag(summation, "GrandTotalAmount"));
    basis = paise(xmlTag(summation, "TaxBasisTotalAmount"));
    tax = paise(xmlTag(summation, "TaxTotalAmount"));
  } else {
    id = xmlTag(xml, "ID");
    issued = isoDate(xmlTag(xml, "IssueDate"));
    const supplier = scopeOf(xml, "AccountingSupplierParty");
    const customer = scopeOf(xml, "AccountingCustomerParty");
    seller = xmlTag(supplier, "Name");
    buyer = xmlTag(customer, "Name");
    cur = xmlTag(xml, "DocumentCurrencyCode");
    lineTotalsRaw = xmlTags(xml, "LineExtensionAmount", undefined, 200);
    const totals = scopeOf(xml, "LegalMonetaryTotal");
    grand = paise(xmlTag(totals, "TaxInclusiveAmount"));
    basis = paise(xmlTag(totals, "TaxExclusiveAmount"));
    const taxTotals = xmlTags(xml, "TaxAmount", undefined, 4);
    tax = taxTotals.length > 0 ? paise(taxTotals[0]) : 0;
  }

  add(
    "Invoice number (BT-1)",
    id ? "pass" : "fail",
    id ? id : "missing — every e-invoice needs one"
  );
  add(
    "Issue date (BT-2)",
    issued ? "pass" : "fail",
    issued ? issued : "missing"
  );
  add("Seller name (BT-27)", seller ? "pass" : "fail", seller || "missing");
  add("Buyer name (BT-44)", buyer ? "pass" : "fail", buyer || "missing");
  add("Currency (BT-5)", cur ? "pass" : "fail", cur || "missing");

  if (lineTotalsRaw.length === 0) {
    add("Line items (BG-25)", "fail", "none found");
  } else {
    add("Line items (BG-25)", "pass", `${lineTotalsRaw.length} line item(s)`);
  }

  if (grand > 0 && basis > 0) {
    // BT-170 rounding — invoices that round the grand total declare it.
    const rounding = paise(
      xmlTag(xml, "RoundingAmount") ||
        (dialect === "ubl" ? xmlTag(scopeOf(xml, "LegalMonetaryTotal"), "PayableRoundingAmount") : "")
    );
    const expected = basis + tax + rounding;
    const ok = Math.abs(expected - grand) <= 2;
    add(
      "Totals add up (BT-102 + BT-110 = BT-112)",
      ok ? "pass" : "fail",
      `${(basis / 100).toFixed(2)} + ${(tax / 100).toFixed(2)}${rounding !== 0 ? ` + rounding ${(rounding / 100).toFixed(2)}` : ""} vs declared ${(grand / 100).toFixed(2)}`
    );
  } else if (grand === 0) {
    add("Grand total (BT-112)", "fail", "missing");
  }

  const sumLines = lineTotalsRaw.reduce((acc, t) => acc + paise(t), 0);
  if (lineTotalsRaw.length > 0) {
    // UBL has a declared header line-extension sum (BT-106) to compare.
    const headerLine = dialect === "ubl" ? paise(xmlTag(scopeOf(xml, "LegalMonetaryTotal"), "LineExtensionAmount")) : 0;
    const expected = headerLine > 0 ? headerLine : sumLines;
    const ok = Math.abs(sumLines - expected) <= 2;
    add(
      "Line sum = line-total sum (BT-131)",
      ok ? "pass" : "warn",
      `${(sumLines / 100).toFixed(2)} vs header ${(expected / 100).toFixed(2)}`
    );
  }

  return { checks, failed, warnings };
}
