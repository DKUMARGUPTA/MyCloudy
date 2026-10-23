/**
 * Smoke: xml-invoice-to-pdf (RB5-d / RB5-FIN-d) — CII XML → invoice PDF,
 * 100% on-device.
 *
 * House conventions (smoke-publisher-to-pdf / smoke-pdf-to-odt base):
 * relative imports WITHOUT .ts, regenerator-runtime first (pdf.js), plain
 * check() helper, process.exit at the end.
 *
 *  1. XML parser vectors — namespace/prefix tolerance (rsm:/ram:/udt:
 *     prefixed vs fully unprefixed parse identically), BOM, comments, PIs,
 *     DOCTYPE with internal subset, CDATA raw text, entity decoding
 *     (named/hex/dec + unknown kept literal), attribute decoding +
 *     attrValue local-name lookup, and the honest malformed taxonomy
 *     (unclosed, close mismatch, text outside root, two roots).
 *  2. Classification — looksLikeXml sniff vectors, classifyRoot /
 *     classifyXmlError: UBL Invoice + CreditNote → errUbl, other roots →
 *     errNotCii, garbage → errNotXml, broken XML → errMalformed.
 *  3. Font decisions + text hygiene — isWinAnsi/needsNoto/collectDrawnText
 *     (₹ forces Noto, é stays Helvetica, CJK → "?" honesty), sanitizeText
 *     (controls, Devanagari quote-dropping, cap), splitTextRuns.
 *  4. Code maps + formatting — unit codes, type codes, payment means,
 *     currency symbols, Indian vs international grouping, currencyFmt,
 *     formatQty, formatRate, formatCiiDate (102 + invalid + raw).
 *  5. parseCii — the FULL fixture read field-by-field (meta/parties/lines/
 *     taxes/totals/payment, zero issues), the namespace-tolerance
 *     deep-equality oracle, missing-optional-nodes fixtures → exactly the
 *     right issue codes (never a throw), invoiceIsEmpty.
 *  6. Layout planning — wrapText, tableColumns, computeRows pagination +
 *     rowCap, planHeader/planBuyer (title label precedence), outputPdfName,
 *     parseInvoiceLabels tamper vectors.
 *  7. REAL E2E through the worker (self-shimmed globalThis + fetch serving
 *     the self-hosted Noto TTF — the smoke-publisher-to-pdf recipe):
 *     the FULL Devanagari CII (2 line items, 18% tax, prepaid) → pdf.js
 *     reload: page count, invoice number/buyer/items/totals needles,
 *     Indian-grouping figures, FontFile2 + Identity-H embedded,
 *     Producer/Creator MyCloudy, stable-substring Devanagari, margins;
 *     the EN-only EUR run (nothing embedded, SEPA label); the 81-line
 *     truncation run (capped at 80, printed note, Widget 0081 absent);
 *     Letter geometry; rejection drives (no file, garbage, not-xml,
 *     malformed, UBL, not-CII, empty, >10 MB).
 *  8. i18n + config — tool catalog en/hi parity, every referenced xinv.*
 *     key resolves in BOTH catalogs (surface + config + worker + model),
 *     every ParseIssueCode + worker error code has leaves (and the surface
 *     ERROR_TOASTS table covers each worker code), PDF_LABEL_KEYS
 *     cross-checked against the surface source, config/surface/worker
 *     wiring strings.
 *
 * Run: bun scripts/smoke-xml-invoice-to-pdf.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync, writeFileSync } from "node:fs";

import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  MAX_LINES,
  MAX_XML_BYTES,
  attrValue,
  classifyRoot,
  classifyXmlError,
  currencyFmt,
  currencySymbol,
  formatCiiDate,
  formatQty,
  formatRate,
  groupNumber,
  invoiceIsEmpty,
  invoiceNeedsNoto,
  invoiceTypeLabel,
  knownTypeCode,
  looksLikeXml,
  needsNoto,
  outputPdfName,
  parseCii,
  parseInvoiceLabels,
  parseXmlDocument,
  parseXmlText,
  paymentMeansLabel,
  planBuyer,
  planHeader,
  sanitizeText,
  tableColumns,
  unitCodeLabel,
  isWinAnsiText,
  wrapText,
  computeRows,
} from "../tools/xml-invoice-to-pdf/model";
import { splitTextRuns } from "../tools/xml-invoice-to-pdf/render";
import type {
  InvoiceLine,
  XmlElem,
} from "../tools/xml-invoice-to-pdf/types";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "../src/lib/workers/protocol";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(
      `  ✗ FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : ""
    );
  }
}

/** Fixture guard: parse or throw (fixtures must be well-formed). */
function mustParse(xml: string): XmlElem {
  const r = parseXmlDocument(xml);
  if (!r.ok) throw new Error(`fixture failed to parse: ${r.reason}`);
  return r.root;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** pdf.js in-process extraction (smoke-pdf-to-odt recipe). */
interface ItemLike {
  str: string;
  width: number;
  transform: number[];
}

async function pdfjsPages(bytes: Uint8Array): Promise<ItemLike[][]> {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
  const pdf = await task.promise;
  const pages: ItemLike[][] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    try {
      const content = await page.getTextContent();
      pages.push(content.items as unknown as ItemLike[]);
    } finally {
      page.cleanup();
    }
  }
  await pdf.cleanup();
  await task.destroy();
  return pages;
}

function objDump(doc: PDFDocument): string {
  return [...doc.context.enumerateIndirectObjects()]
    .map(([, o]) => o.toString())
    .join("\n");
}

/** Every non-empty drawn item stays inside the text column. */
function checkMargins(
  pages: ItemLike[][],
  pageW: number,
  margin: number,
  label: string
): void {
  const right = pageW - margin;
  for (const page of pages) {
    for (const it of page) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4] ?? 0;
      check(
        `${label}: right margin kept ("${it.str.slice(0, 16)}")`,
        x + it.width <= right + 3,
        `${(x + it.width).toFixed(1)} > ${right.toFixed(1)}`
      );
      check(
        `${label}: left margin kept ("${it.str.slice(0, 16)}")`,
        x >= margin - 3,
        x
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* The CII fixture builder                                             */
/* ------------------------------------------------------------------ */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface ItemSpec {
  lineId: string;
  name: string;
  sku?: string;
  description?: string;
  qty: string;
  unit: string;
  price: string;
  net: string;
  rate: string;
  category: string;
}

interface AddrSpec {
  line1: string;
  city: string;
  postcode: string;
  country: string;
  region?: string;
}

interface CiiSpec {
  prefixes?: boolean;
  number: string;
  typeCode: string;
  issueDate: string;
  dueDate?: string;
  deliveryDate?: string;
  currency: string;
  sellerName: string;
  tradingName?: string;
  sellerTaxId?: string;
  sellerPhone?: string;
  sellerEmail?: string;
  sellerAddr?: AddrSpec;
  buyerName: string;
  buyerAddr?: AddrSpec;
  buyerTaxId?: string;
  buyerReference?: string;
  items: ItemSpec[];
  tax?: { rate: string; category: string; basis: string; amount: string };
  totals: {
    line: string;
    taxBasis?: string;
    tax: string;
    grand: string;
    prepaid?: string;
    due: string;
  };
  payment?: {
    means: string;
    iban?: string;
    accountName?: string;
    bic?: string;
  };
  note?: string;
}

/** A full, realistic rsm:CrossIndustryInvoice document (prefix-tolerant). */
function buildCii(spec: CiiSpec): string {
  const rsm = spec.prefixes === false ? "" : "rsm:";
  const ram = spec.prefixes === false ? "" : "ram:";
  const udt = spec.prefixes === false ? "" : "udt:";
  const ns =
    spec.prefixes === false
      ? ' xmlns="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"'
      : ' xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"' +
        ' xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"' +
        ' xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"';

  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<${rsm}CrossIndustryInvoice${ns}>`);
  out.push(`  <${rsm}ExchangedDocument>`);
  if (spec.number !== "") {
    out.push(`    <${ram}ID>${esc(spec.number)}</${ram}ID>`);
  }
  if (spec.typeCode !== "") {
    out.push(`    <${ram}TypeCode>${spec.typeCode}</${ram}TypeCode>`);
  }
  if (spec.issueDate !== "") {
    out.push(
      `    <${ram}IssueDateTime><${udt}DateTimeString format="102">${spec.issueDate}</${udt}DateTimeString></${ram}IssueDateTime>`
    );
  }
  if (spec.note) {
    out.push(
      `    <${ram}IncludedNote><${ram}Content>${esc(spec.note)}</${ram}Content></${ram}IncludedNote>`
    );
  }
  out.push(`  </${rsm}ExchangedDocument>`);
  out.push(`  <${rsm}SupplyChainTradeTransaction>`);

  for (const it of spec.items) {
    out.push(`    <${rsm}IncludedSupplyChainTradeLineItem>`);
    out.push(
      `      <${ram}AssociatedDocumentLineDocument><${ram}LineID>${it.lineId}</${ram}LineID></${ram}AssociatedDocumentLineDocument>`
    );
    out.push(`      <${ram}SpecifiedTradeProduct>`);
    if (it.sku) {
      out.push(
        `        <${ram}SellerAssignedID>${esc(it.sku)}</${ram}SellerAssignedID>`
      );
    }
    out.push(`        <${ram}Name>${esc(it.name)}</${ram}Name>`);
    if (it.description) {
      out.push(
        `        <${ram}Description>${esc(it.description)}</${ram}Description>`
      );
    }
    out.push(`      </${ram}SpecifiedTradeProduct>`);
    out.push(
      `      <${ram}SpecifiedLineTradeAgreement><${ram}NetPriceProductTradePrice><${ram}ChargeAmount>${it.price}</${ram}ChargeAmount></${ram}NetPriceProductTradePrice></${ram}SpecifiedLineTradeAgreement>`
    );
    out.push(
      `      <${ram}SpecifiedLineTradeDelivery><${ram}BilledQuantity unitCode="${it.unit}">${it.qty}</${ram}BilledQuantity></${ram}SpecifiedLineTradeDelivery>`
    );
    out.push(`      <${ram}SpecifiedLineTradeSettlement>`);
    out.push(
      `        <${ram}ApplicableTradeTax><${ram}RateApplicablePercent>${it.rate}</${ram}RateApplicablePercent><${ram}CategoryCode>${it.category}</${ram}CategoryCode></${ram}ApplicableTradeTax>`
    );
    out.push(
      `        <${ram}SpecifiedTradeSettlementLineMonetarySummation><${ram}LineTotalAmount>${it.net}</${ram}LineTotalAmount></${ram}SpecifiedTradeSettlementLineMonetarySummation>`
    );
    out.push(`      </${ram}SpecifiedLineTradeSettlement>`);
    out.push(`    </${rsm}IncludedSupplyChainTradeLineItem>`);
  }

  out.push(`    <${rsm}ApplicableHeaderTradeAgreement>`);
  if (spec.buyerReference) {
    out.push(
      `      <${ram}BuyerReference>${esc(spec.buyerReference)}</${ram}BuyerReference>`
    );
  }
  out.push(`      <${ram}SellerTradeParty>`);
  out.push(`        <${ram}Name>${esc(spec.sellerName)}</${ram}Name>`);
  if (spec.tradingName || spec.sellerTaxId) {
    out.push(`        <${ram}SpecifiedLegalOrganization>`);
    if (spec.sellerTaxId) out.push(`          <${ram}ID>${spec.sellerTaxId}</${ram}ID>`);
    if (spec.tradingName) {
      out.push(
        `          <${ram}TradingBusinessName>${esc(spec.tradingName)}</${ram}TradingBusinessName>`
      );
    }
    out.push(`        </${ram}SpecifiedLegalOrganization>`);
  }
  if (spec.sellerPhone || spec.sellerEmail) {
    out.push(`        <${ram}DefinedTradeContact>`);
    if (spec.sellerPhone) {
      out.push(
        `          <${ram}TelephoneUniversalCommunication><${ram}CompleteNumber>${esc(spec.sellerPhone)}</${ram}CompleteNumber></${ram}TelephoneUniversalCommunication>`
      );
    }
    if (spec.sellerEmail) {
      out.push(
        `          <${ram}EmailURIUniversalCommunication><${ram}URIID>${esc(spec.sellerEmail)}</${ram}URIID></${ram}EmailURIUniversalCommunication>`
      );
    }
    out.push(`        </${ram}DefinedTradeContact>`);
  }
  if (spec.sellerAddr) {
    const a = spec.sellerAddr;
    out.push(`        <${ram}PostalTradeAddress>`);
    out.push(`          <${ram}LineOne>${esc(a.line1)}</${ram}LineOne>`);
    out.push(`          <${ram}CityName>${esc(a.city)}</${ram}CityName>`);
    out.push(
      `          <${ram}PostcodeCode>${esc(a.postcode)}</${ram}PostcodeCode>`
    );
    out.push(`          <${ram}CountryID>${a.country}</${ram}CountryID>`);
    if (a.region) {
      out.push(
        `          <${ram}CountrySubdivisionName>${esc(a.region)}</${ram}CountrySubdivisionName>`
      );
    }
    out.push(`        </${ram}PostalTradeAddress>`);
  }
  if (spec.sellerTaxId) {
    out.push(
      `        <${ram}SpecifiedTaxRegistration><${ram}ID>${spec.sellerTaxId}</${ram}ID></${ram}SpecifiedTaxRegistration>`
    );
  }
  out.push(`      </${ram}SellerTradeParty>`);
  out.push(`      <${ram}BuyerTradeParty>`);
  out.push(`        <${ram}Name>${esc(spec.buyerName)}</${ram}Name>`);
  if (spec.buyerTaxId) {
    out.push(
      `      <${ram}SpecifiedTaxRegistration><${ram}ID>${spec.buyerTaxId}</${ram}ID></${ram}SpecifiedTaxRegistration>`
    );
  }
  if (spec.buyerAddr) {
    const a = spec.buyerAddr;
    out.push(`        <${ram}PostalTradeAddress>`);
    out.push(`          <${ram}LineOne>${esc(a.line1)}</${ram}LineOne>`);
    out.push(`          <${ram}CityName>${esc(a.city)}</${ram}CityName>`);
    out.push(
      `          <${ram}PostcodeCode>${esc(a.postcode)}</${ram}PostcodeCode>`
    );
    out.push(`          <${ram}CountryID>${a.country}</${ram}CountryID>`);
    out.push(`        </${ram}PostalTradeAddress>`);
  }
  out.push(`      </${ram}BuyerTradeParty>`);
  out.push(`    </${rsm}ApplicableHeaderTradeAgreement>`);

  if (spec.deliveryDate) {
    out.push(`    <${rsm}ApplicableHeaderTradeDelivery>`);
    out.push(
      `      <${ram}ActualDeliverySupplyChainEvent><${ram}OccurrenceDateTime><${udt}DateTimeString format="102">${spec.deliveryDate}</${udt}DateTimeString></${ram}OccurrenceDateTime></${ram}ActualDeliverySupplyChainEvent>`
    );
    out.push(`    </${rsm}ApplicableHeaderTradeDelivery>`);
  }

  out.push(`    <${rsm}ApplicableHeaderTradeSettlement>`);
  out.push(
    `      <${ram}InvoiceCurrencyCode>${spec.currency}</${ram}InvoiceCurrencyCode>`
  );
  if (spec.payment) {
    out.push(`      <${ram}SpecifiedTradeSettlementPaymentMeans>`);
    out.push(`        <${ram}TypeCode>${spec.payment.means}</${ram}TypeCode>`);
    if (spec.payment.iban || spec.payment.accountName) {
      out.push(`        <${ram}PayeePartyCreditorFinancialAccount>`);
      if (spec.payment.iban) {
        out.push(`          <${ram}IBANID>${spec.payment.iban}</${ram}IBANID>`);
      }
      if (spec.payment.accountName) {
        out.push(
          `          <${ram}AccountName>${esc(spec.payment.accountName)}</${ram}AccountName>`
        );
      }
      out.push(`        </${ram}PayeePartyCreditorFinancialAccount>`);
    }
    if (spec.payment.bic) {
      out.push(
        `        <${ram}PayeeSpecifiedCreditorFinancialInstitution><${ram}BICID>${spec.payment.bic}</${ram}BICID></${ram}PayeeSpecifiedCreditorFinancialInstitution>`
      );
    }
    out.push(`      </${ram}SpecifiedTradeSettlementPaymentMeans>`);
  }
  if (spec.tax) {
    out.push(`      <${ram}ApplicableTradeTax>`);
    out.push(
      `        <${ram}CalculatedAmount>${spec.tax.amount}</${ram}CalculatedAmount>`
    );
    out.push(
      `        <${ram}CategoryCode>${spec.tax.category}</${ram}CategoryCode>`
    );
    out.push(
      `        <${ram}BasisAmount>${spec.tax.basis}</${ram}BasisAmount>`
    );
    out.push(
      `        <${ram}RateApplicablePercent>${spec.tax.rate}</${ram}RateApplicablePercent>`
    );
    out.push(`      </${ram}ApplicableTradeTax>`);
  }
  if (spec.dueDate) {
    out.push(
      `      <${ram}SpecifiedTradePaymentTerms><${ram}DueDateDateTime><${udt}DateTimeString format="102">${spec.dueDate}</${udt}DateTimeString></${ram}DueDateDateTime></${ram}SpecifiedTradePaymentTerms>`
    );
  }
  out.push(
    `      <${ram}SpecifiedTradeSettlementHeaderMonetarySummation>`
  );
  const t = spec.totals;
  out.push(
    `        <${ram}LineTotalAmount>${t.line}</${ram}LineTotalAmount>`
  );
  if (t.taxBasis) {
    out.push(
      `        <${ram}TaxBasisTotalAmount>${t.taxBasis}</${ram}TaxBasisTotalAmount>`
    );
  }
  out.push(`        <${ram}TaxTotalAmount>${t.tax}</${ram}TaxTotalAmount>`);
  out.push(
    `        <${ram}GrandTotalAmount>${t.grand}</${ram}GrandTotalAmount>`
  );
  if (t.prepaid) {
    out.push(
      `        <${ram}TotalPrepaidAmount>${t.prepaid}</${ram}TotalPrepaidAmount>`
    );
  }
  out.push(
    `        <${ram}DuePayableAmount>${t.due}</${ram}DuePayableAmount>`
  );
  out.push(
    `      </${ram}SpecifiedTradeSettlementHeaderMonetarySummation>`
  );
  out.push(`    </${rsm}ApplicableHeaderTradeSettlement>`);
  out.push(`  </${rsm}SupplyChainTradeTransaction>`);
  out.push(`</${rsm}CrossIndustryInvoice>`);
  return out.join("\n");
}

/* The FULL fixture — 2 line items, 18% tax, prepaid, Devanagari seller. */
const fullSpec: CiiSpec = {
  prefixes: true,
  number: "RE-2026-0042",
  typeCode: "380",
  issueDate: "20260315",
  dueDate: "20260414",
  deliveryDate: "20260314",
  currency: "INR",
  sellerName: "शर्मा ट्रेडिंग कंपनी",
  tradingName: "Sharma Trading Company",
  sellerTaxId: "27AAAPS1234M1Z5",
  sellerPhone: "+91 98200 12345",
  sellerEmail: "billing@sharmatrading.example",
  sellerAddr: {
    line1: "12 MG Road",
    city: "Pune",
    postcode: "411001",
    country: "IN",
    region: "Maharashtra",
  },
  buyerName: "Gupta Constructions Pvt Ltd",
  buyerAddr: {
    line1: "88 Nehru Place",
    city: "New Delhi",
    postcode: "110019",
    country: "IN",
  },
  buyerReference: "SUPPLIER-77",
  items: [
    {
      lineId: "1",
      name: "Steel bracket",
      sku: "SKU-1001",
      qty: "400",
      unit: "C62",
      price: "250",
      net: "100000",
      rate: "18",
      category: "S",
    },
    {
      lineId: "2",
      name: "Consulting support",
      sku: "SKU-2002",
      description: "On-site engineering hours",
      qty: "160",
      unit: "HUR",
      price: "100",
      net: "16000",
      rate: "18",
      category: "S",
    },
  ],
  tax: { rate: "18", category: "S", basis: "116000", amount: "20880" },
  totals: {
    line: "116000",
    taxBasis: "116000",
    tax: "20880",
    grand: "136880",
    prepaid: "36880",
    due: "100000",
  },
  payment: {
    means: "30",
    iban: "DE44500105175407324931",
    accountName: "Sharma Trading Current Account",
    bic: "COBADEFFXXX",
  },
  note: "Thank you for your business.",
};
const fullXml = buildCii(fullSpec);

/* The same fixture with NO prefixes at all (namespace tolerance oracle). */
const bareXml = buildCii({ ...fullSpec, prefixes: false });

/* EN-only, EUR — the pure-WinAnsi Helvetica path (nothing embedded). */
const enSpec: CiiSpec = {
  number: "INV-EU-2026-7",
  typeCode: "380",
  issueDate: "20260120",
  currency: "EUR",
  sellerName: "Acme Supplies GmbH",
  sellerAddr: {
    line1: "Industriestrasse 14",
    city: "Stuttgart",
    postcode: "70565",
    country: "DE",
  },
  buyerName: "Birch & Beam Ltd",
  buyerAddr: {
    line1: "4 Aldgate Square",
    city: "London",
    postcode: "EC3A 2AB",
    country: "GB",
  },
  items: [
    {
      lineId: "1",
      name: "oak planks",
      qty: "120",
      unit: "C62",
      price: "20",
      net: "2400",
      rate: "7",
      category: "S",
    },
  ],
  tax: { rate: "7", category: "S", basis: "2400", amount: "168" },
  totals: { line: "2400", taxBasis: "2400", tax: "168", grand: "2568", due: "2568" },
  payment: { means: "58" },
};
const enXml = buildCii(enSpec);

/* 81 line items — the honest truncation path. */
const manySpec: CiiSpec = {
  number: "BULK-81",
  typeCode: "380",
  issueDate: "20260601",
  currency: "INR",
  sellerName: "Bulk Widgets India",
  sellerAddr: {
    line1: "Plot 5, MIDC",
    city: "Nashik",
    postcode: "422007",
    country: "IN",
  },
  buyerName: "Retail Chain Pvt Ltd",
  buyerAddr: {
    line1: "7 Market Street",
    city: "Mumbai",
    postcode: "400001",
    country: "IN",
  },
  items: Array.from({ length: 81 }, (_, i) => ({
    lineId: String(i + 1),
    name: `Widget ${String(i + 1).padStart(4, "0")}`,
    qty: "1",
    unit: "C62",
    price: "10",
    net: "10",
    rate: "5",
    category: "AA",
  })),
  tax: { rate: "5", category: "AA", basis: "810", amount: "40.5" },
  totals: { line: "810", taxBasis: "810", tax: "40.5", grand: "850.5", due: "850.5" },
  payment: { means: "30", iban: "IN44123456789012345678" },
};
const manyXml = buildCii(manySpec);

/* The label map the surface ships (read from the tool's own catalog). */
const toolI18n = JSON.parse(
  readFileSync("tools/xml-invoice-to-pdf/i18n.json", "utf8")
) as {
  en: { xinv: Record<string, string> };
  hi: { xinv: Record<string, string> };
};
const PDF_LABEL_KEYS: readonly string[] = [
  "ttl",
  "ttl380",
  "ttl381",
  "ttl382",
  "ttl383",
  "ttl384",
  "docType",
  "no",
  "date",
  "dueDate",
  "deliveryDate",
  "billTo",
  "yourRef",
  "currency",
  "taxId",
  "regNo",
  "colNo",
  "colItem",
  "colQty",
  "colTax",
  "colAmount",
  "sub",
  "charges",
  "allowances",
  "taxBasis",
  "tax",
  "taxTotal",
  "total",
  "paid",
  "due",
  "payment",
  "payRef",
  "iban",
  "account",
  "bic",
  "means",
  "notes",
  "page",
  "noItems",
  "truncA",
  "truncOf",
  "truncC",
];
const enLabels: Record<string, string> = {};
for (const k of PDF_LABEL_KEYS) enLabels[k] = toolI18n.en.xinv[k] ?? "";
const labelsJson = JSON.stringify(enLabels);

/* ================================================================== */
console.log("── 1. XML parser vectors ────────────────────────────────");
/* ================================================================== */
{
  const doc = parseXmlDocument(fullXml);
  check("full fixture parses", doc.ok && doc.root.localName === "CrossIndustryInvoice", doc.ok ? doc.root.localName : doc);

  const bare = parseXmlDocument(bareXml);
  check(
    "unprefixed fixture parses (namespace tolerance)",
    bare.ok && bare.root.localName === "CrossIndustryInvoice"
  );

  const bom = parseXmlDocument("\uFEFF<a/>");
  check("BOM before the root is skipped", bom.ok);

  const ws = parseXmlDocument("   \n\t <a/>");
  check("leading whitespace is skipped", ws.ok);

  const noisy = parseXmlDocument(
    "<!-- server: prod --><?xml-stylesheet href='x'?><!DOCTYPE a [<!ELEMENT a (#PCDATA)>]><a>ok</a>"
  );
  check(
    "comments + PI + DOCTYPE (with subset) are skipped",
    noisy.ok && noisy.root.textContent === "ok",
    noisy.ok ? noisy.root.textContent : noisy
  );

  const cdata = parseXmlDocument("<a><![CDATA[1 < 2 & 3]]></a>");
  check(
    "CDATA keeps raw text (no entity decode inside)",
    cdata.ok && cdata.root.textContent === "1 < 2 & 3"
  );

  const ent = parseXmlDocument("<a>1 &lt; 2 &#2309; &#x915;</a>");
  check(
    "named + dec + hex entities decode",
    ent.ok && ent.root.textContent === "1 < 2 अ क",
    ent.ok ? ent.root.textContent : ent
  );

  const unknown = parseXmlDocument("<a>&nbsp;</a>");
  check(
    "unknown entities stay literal (CDATA covers exotic text)",
    unknown.ok && unknown.root.textContent === "&nbsp;"
  );

  const attrs = parseXmlDocument("<a x='1' y=\"2\"/>");
  check(
    "attributes parse (single + double quoted)",
    attrs.ok && attrs.root.attrs["x"] === "1" && attrs.root.attrs["y"] === "2"
  );

  const dup = parseXmlDocument("<a x='1' x='2'/>");
  check("duplicate attribute: first wins", dup.ok && dup.root.attrs["x"] === "1");

  const prefixedAttr = parseXmlDocument('<q><r p:unitCode="HUR">2</r></q>');
  const rEl = prefixedAttr.ok ? prefixedAttr.root.children[0] ?? null : null;
  check(
    "attrValue resolves prefixed attributes by local name",
    prefixedAttr.ok && attrValue(rEl, "unitCode") === "HUR"
  );
  check("attrValue: miss → empty string", attrValue(rEl, "nope") === "");
  check(
    "attrValue: null element → empty string",
    attrValue(null, "unitCode") === ""
  );

  const selfClose = parseXmlDocument("<a/>");
  check("self-closing root parses", selfClose.ok);

  check("text outside the root → malformed", !parseXmlDocument("<a/> oops").ok);
  check("unclosed element → malformed", !parseXmlDocument("<a><b></a>").ok);
  check("close-tag mismatch → malformed", !parseXmlDocument("<a></b>").ok);
  check("two roots → malformed", !parseXmlDocument("<a/><b/>").ok);
  const emptyRes = parseXmlDocument("");
  check(
    "empty input → not-xml",
    !emptyRes.ok && emptyRes.reason === "not-xml",
    emptyRes
  );
  const textRes = parseXmlDocument("hello world");
  check(
    "plain text → not-xml",
    !textRes.ok && textRes.reason === "not-xml",
    textRes
  );

  // parseXmlText falls back to the same parser when DOMParser is absent
  // (bun) — the tree must be identical.
  const viaText = parseXmlText(fullXml);
  const viaDoc = parseXmlDocument(fullXml);
  check(
    "parseXmlText matches parseXmlDocument (no-DOMParser path)",
    viaText.ok &&
      viaDoc.ok &&
      JSON.stringify(viaText.root) === JSON.stringify(viaDoc.root)
  );
}

/* ================================================================== */
console.log("── 2. classification (sniff + root) ─────────────────────");
/* ================================================================== */
{
  check("looksLikeXml: '<rsm:Cross…' true", looksLikeXml(fullXml));
  check("looksLikeXml: BOM + xml decl true", looksLikeXml("\uFEFF<?xml version=\"1.0\"?><a/>"));
  check("looksLikeXml: leading space + '<a' true", looksLikeXml("   <a/>"));
  check("looksLikeXml: plain text false", !looksLikeXml("just some words"));
  check("looksLikeXml: '<<<' false", !looksLikeXml("<<<broken"));
  check("looksLikeXml: empty false", !looksLikeXml(""));

  const ciiRoot = parseXmlDocument(fullXml);
  check(
    "classifyRoot: CrossIndustryInvoice → null (good to go)",
    ciiRoot.ok && classifyRoot(ciiRoot.root) === null
  );

  const ublInvoiceXml =
    '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><ID>1</ID></Invoice>';
  const ublInvoice = parseXmlDocument(ublInvoiceXml);
  check(
    "classifyRoot: UBL Invoice → honest errUbl",
    ublInvoice.ok && classifyRoot(ublInvoice.root) === "xinv.errUbl"
  );

  const ublCredit = parseXmlDocument(
    '<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"><ID>1</ID></CreditNote>'
  );
  check(
    "classifyRoot: UBL CreditNote → honest errUbl",
    ublCredit.ok && classifyRoot(ublCredit.root) === "xinv.errUbl"
  );

  const htmlRoot = parseXmlDocument("<html><body>x</body></html>");
  check(
    "classifyRoot: other root → errNotCii",
    htmlRoot.ok && classifyRoot(htmlRoot.root) === "xinv.errNotCii"
  );

  check(
    "classifyXmlError: garbage text → errNotXml",
    classifyXmlError("hello world", { ok: false, reason: "not-xml" }) === "xinv.errNotXml"
  );
  check(
    "classifyXmlError: xml-ish but broken → errMalformed",
    classifyXmlError("<rsm:CrossIndustryInvoice><ram:ID>x", {
      ok: false,
      reason: "malformed",
    }) === "xinv.errMalformed"
  );
  check(
    "classifyXmlError: parsed UBL → errUbl",
    ublInvoice.ok && classifyXmlError(ublInvoiceXml, ublInvoice) === "xinv.errUbl"
  );
}

/* ================================================================== */
console.log("── 3. font decisions + text hygiene ──────────────────────");
/* ================================================================== */
{
  check("isWinAnsiText: ASCII + é + € true", isWinAnsiText("a é € — “”"));
  check("isWinAnsiText: Devanagari false", !isWinAnsiText("शर्मा"));
  check("needsNoto: plain ASCII false", !needsNoto("plain ASCII 123"));
  check("needsNoto: ₹ true (rupee rides Noto)", needsNoto("₹ 100"));
  check("needsNoto: Devanagari true", needsNoto("शर्मा ट्रेडिंग कंपनी"));
  check("needsNoto: CJK false (not Noto-covered — honesty)", !needsNoto("日本語"));

  check(
    "sanitizeText strips control chars, keeps \\n/\\t",
    sanitizeText("a\u0000b\u0001c\nd\te") === "abc\nd\te"
  );
  check("sanitizeText: unsupported script → '?'", sanitizeText("日本語") === "???");
  check(
    "sanitizeText drops ASCII quotes in Devanagari strings (pinned lesson)",
    sanitizeText('शर्मा "quoted"') === "शर्मा quoted"
  );
  check(
    "sanitizeText keeps quotes in plain Latin strings",
    sanitizeText('"quoted"') === '"quoted"'
  );
  check(
    "sanitizeText caps at MAX_TEXT with a real ellipsis",
    sanitizeText("x".repeat(400)).length === 300 &&
      sanitizeText("x".repeat(400)).endsWith("…")
  );

  const runs = splitTextRuns("abcशर्माdef");
  check(
    "splitTextRuns splits mixed EN+Deva",
    runs.length === 3 &&
      runs[0]!.text === "abc" && runs[0]!.deva === false &&
      runs[1]!.text === "शर्मा" && runs[1]!.deva === true &&
      runs[2]!.text === "def" && runs[2]!.deva === false,
    runs
  );
  check("splitTextRuns: empty string → no runs", splitTextRuns("").length === 0);
  const rupee = splitTextRuns("₹ 5");
  check(
    "splitTextRuns: ₹ is a Noto run",
    rupee[0]!.text === "₹" && rupee[0]!.deva === true,
    rupee
  );
}

/* ================================================================== */
console.log("── 4. code maps + currency/date formatting ───────────────");
/* ================================================================== */
{
  check("unitCodeLabel: C62 → piece", unitCodeLabel("C62") === "piece");
  check("unitCodeLabel: HUR → hour", unitCodeLabel("HUR") === "hour");
  check("unitCodeLabel: KGM → kg", unitCodeLabel("KGM") === "kg");
  check("unitCodeLabel: MTK → m²", unitCodeLabel("MTK") === "m²");
  check("unitCodeLabel: P1 → %", unitCodeLabel("P1") === "%");
  check("unitCodeLabel: lowercase input tolerated", unitCodeLabel("c62") === "piece");
  check("unitCodeLabel: unknown code kept raw", unitCodeLabel("ZZ1") === "ZZ1");
  check("unitCodeLabel: empty → empty", unitCodeLabel("") === "");

  check("invoiceTypeLabel: 380 → Invoice", invoiceTypeLabel("380") === "Invoice");
  check("invoiceTypeLabel: 381 → Credit note", invoiceTypeLabel("381") === "Credit note");
  check("invoiceTypeLabel: unknown → empty", invoiceTypeLabel("999") === "");
  check("knownTypeCode: 380 true / 999 false", knownTypeCode("380") && !knownTypeCode("999"));

  check("paymentMeansLabel: 30 → Credit transfer", paymentMeansLabel("30") === "Credit transfer");
  check("paymentMeansLabel: 58 → SEPA credit transfer", paymentMeansLabel("58") === "SEPA credit transfer");
  check("paymentMeansLabel: unknown kept raw", paymentMeansLabel("99") === "99");
  check("paymentMeansLabel: empty → empty", paymentMeansLabel("") === "");

  check("currencySymbol: INR → ₹", currencySymbol("INR") === "₹");
  check("currencySymbol: USD → $", currencySymbol("USD") === "$");
  check("currencySymbol: EUR → €", currencySymbol("EUR") === "€");
  check("currencySymbol: case-insensitive", currencySymbol("inr") === "₹");
  check("currencySymbol: unknown kept raw", currencySymbol("XYZ") === "XYZ");

  check("groupNumber: Indian grouping", groupNumber(123456.78, "in") === "1,23,456.78");
  check("groupNumber: international grouping", groupNumber(1234567.89, "int") === "1,234,567.89");
  check("groupNumber: negative + small", groupNumber(-2, "in") === "-2.00");
  check("groupNumber: halves survive float drift", groupNumber(0.29, "int") === "0.29");

  check("currencyFmt: null → empty", currencyFmt(null, "INR") === "");
  check("currencyFmt: INR lakh grouping", currencyFmt(136880, "INR") === "₹\u00a01,36,880.00");
  check("currencyFmt: EUR international grouping", currencyFmt(2568, "EUR") === "€\u00a02,568.00");
  check("currencyFmt: negative carries the sign", currencyFmt(-5, "USD") === "-$\u00a05.00");
  check("currencyFmt: unknown code shows itself", currencyFmt(98, "AUD") === "A$\u00a098.00");

  check("formatQty: integer + unit label", formatQty(2, "C62") === "2 piece");
  check("formatQty: trailing zeros trimmed", formatQty(2.5, "KGM") === "2.5 kg");
  check("formatQty: 2.50 → 2.5", formatQty(2.5, "ZZZ") === "2.5 ZZZ");
  check("formatQty: null → empty", formatQty(null, "C62") === "");
  check("formatQty: no unit → bare number", formatQty(3, "") === "3");

  check("formatRate: 18 → 18%", formatRate(18) === "18%");
  check("formatRate: 4.5 → 4.5%", formatRate(4.5) === "4.5%");
  check("formatRate: 0 → 0%", formatRate(0) === "0%");
  check("formatRate: null → empty", formatRate(null) === "");

  check("formatCiiDate: 102 → human", formatCiiDate("20260315") === "15 Mar 2026");
  check("formatCiiDate: invalid month stays raw", formatCiiDate("20261301") === "20261301");
  check("formatCiiDate: non-102 format stays raw", formatCiiDate("20260315", "101") === "20260315");
  check("formatCiiDate: non-digit input stays raw", formatCiiDate("2026-03-15") === "2026-03-15");
}

/* ================================================================== */
console.log("── 5. parseCii (fields, namespace oracle, issues) ────────");
/* ================================================================== */
{
  const parsed = parseXmlDocument(fullXml);
  if (!parsed.ok) throw new Error("full fixture failed to parse");
  const inv = parseCii(parsed.root);

  check("meta: number", inv.meta.number === "RE-2026-0042");
  check("meta: typeCode", inv.meta.typeCode === "380");
  check("meta: issueDate human-formatted", inv.meta.issueDate === "15 Mar 2026");
  check("meta: dueDate from payment terms", inv.meta.dueDate === "14 Apr 2026");
  check("meta: deliveryDate", inv.meta.deliveryDate === "14 Mar 2026");
  check("meta: currency uppercased", inv.meta.currency === "INR");
  check("meta: buyerReference", inv.meta.buyerReference === "SUPPLIER-77");
  check("meta: IncludedNote captured", JSON.stringify(inv.meta.notes) === '["Thank you for your business."]');

  check("seller: Devanagari name intact", inv.seller.name === "शर्मा ट्रेडिंग कंपनी");
  check("seller: trading business name", inv.seller.tradingName === "Sharma Trading Company");
  check("seller: legal org id", inv.seller.id === "27AAAPS1234M1Z5");
  check("seller: tax registrations", JSON.stringify(inv.seller.taxIds) === '["27AAAPS1234M1Z5"]');
  check("seller: contact phone", inv.seller.phone === "+91 98200 12345");
  check("seller: contact email", inv.seller.email === "billing@sharmatrading.example");
  check("seller: address fields", inv.seller.address.line1 === "12 MG Road" && inv.seller.address.city === "Pune" && inv.seller.address.country === "IN" && inv.seller.address.subdivision === "Maharashtra");
  check("buyer: name", inv.buyer.name === "Gupta Constructions Pvt Ltd");
  check("buyer: address fields", inv.buyer.address.line1 === "88 Nehru Place" && inv.buyer.address.city === "New Delhi");

  check("lines: count", inv.lines.length === 2);
  const l1 = inv.lines[0]!;
  check(
    "line 1: all fields",
    l1.lineId === "1" &&
      l1.name === "Steel bracket" &&
      l1.sellerAssignedId === "SKU-1001" &&
      l1.quantity === 400 &&
      l1.unitCode === "C62" &&
      l1.unitPrice === 250 &&
      l1.netAmount === 100000 &&
      l1.taxRate === 18 &&
      l1.taxCategory === "S"
  );
  const l2 = inv.lines[1]!;
  check(
    "line 2: description + fields",
    l2.name === "Consulting support" &&
      l2.description === "On-site engineering hours" &&
      l2.quantity === 160 &&
      l2.unitCode === "HUR" &&
      l2.netAmount === 16000
  );

  check(
    "taxes: breakdown",
    inv.taxes.length === 1 &&
      inv.taxes[0]!.rate === 18 &&
      inv.taxes[0]!.category === "S" &&
      inv.taxes[0]!.basis === 116000 &&
      inv.taxes[0]!.amount === 20880
  );
  check(
    "totals: every monetary field",
    inv.totals.lineTotal === 116000 &&
      inv.totals.taxBasisTotal === 116000 &&
      inv.totals.taxTotal === 20880 &&
      inv.totals.grandTotal === 136880 &&
      inv.totals.prepaid === 36880 &&
      inv.totals.duePayable === 100000
  );
  check(
    "payment: means + account + bic",
    inv.payment.meansCode === "30" &&
      inv.payment.iban === "DE44500105175407324931" &&
      inv.payment.accountName === "Sharma Trading Current Account" &&
      inv.payment.bic === "COBADEFFXXX"
  );
  check("issues: the full fixture has NONE", JSON.stringify(inv.issues) === "[]");
  check("truncation: false for 2 lines", inv.truncated === false && inv.totalLineCount === 2);

  // ---- namespace tolerance oracle: bare fixture parses IDENTICALLY ----
  const bareParsed = parseXmlDocument(bareXml);
  if (!bareParsed.ok) throw new Error("bare fixture failed to parse");
  const bareInv = parseCii(bareParsed.root);
  const shape = (i: typeof inv): unknown => ({
    meta: i.meta,
    seller: i.seller,
    buyer: i.buyer,
    lines: i.lines,
    taxes: i.taxes,
    totals: i.totals,
    payment: i.payment,
    issues: i.issues,
    truncated: i.truncated,
    totalLineCount: i.totalLineCount,
  });
  check(
    "namespace oracle: prefixed + unprefixed parse identically",
    JSON.stringify(shape(inv)) === JSON.stringify(shape(bareInv))
  );

  // ---- missing optional nodes → issues, never a throw -----------------
  const missing = buildCii({
    ...fullSpec,
    buyerAddr: undefined,
    payment: undefined,
    sellerAddr: undefined,
    note: undefined,
  });
  const missParsed = parseXmlDocument(missing);
  check("missing-optionals fixture parses", missParsed.ok);
  if (missParsed.ok) {
    const mInv = parseCii(missParsed.root);
    const codes = mInv.issues.map((i) => i.code).sort();
    check(
      "missing nodes → exactly the right issue codes (no throw)",
      JSON.stringify(codes) ===
        JSON.stringify(["missBuyerAddr", "missPayment", "missSellerAddr"].sort()),
      codes
    );
  }

  // a line without LineTotalAmount → missLineAmount, still rendered
  const noAmount = buildCii({
    ...fullSpec,
    items: [
      { ...fullSpec.items[0]!, net: "", lineId: "1" },
      fullSpec.items[1]!,
    ],
  });
  const naParsed = parseXmlDocument(noAmount);
  if (naParsed.ok) {
    const naInv = parseCii(naParsed.root);
    check(
      "line without net amount → missLineAmount issue, netAmount null",
      naInv.issues.some((i) => i.code === "missLineAmount") &&
        naInv.lines[0]!.netAmount === null
    );
  }

  // empty CII document → invoiceIsEmpty (worker errors honestly)
  const emptyDoc = parseXmlDocument(
    '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"></rsm:CrossIndustryInvoice>'
  );
  check("empty CII root parses", emptyDoc.ok);
  if (emptyDoc.ok) {
    const emptyInv = parseCii(emptyDoc.root);
    check("invoiceIsEmpty: true for the bare document", invoiceIsEmpty(emptyInv) === true);
    check(
      "invoiceIsEmpty: every core field reported missing",
      [
        "missNumber",
        "missDate",
        "missType",
        "missCurrency",
        "missSellerName",
        "missSellerAddr",
        "missBuyerName",
        "missBuyerAddr",
        "missLines",
        "missTax",
        "missTotals",
        "missPayment",
      ].every((code) => emptyInv.issues.some((i) => i.code === code))
    );
  }
  check("invoiceIsEmpty: false for the full fixture", invoiceIsEmpty(inv) === false);

  // font decisions through the real model
  check(
    "invoiceNeedsNoto: Devanagari seller → true",
    invoiceNeedsNoto(inv, enLabels) === true
  );
  const enInv = parseCii(mustParse(enXml));
  check(
    "invoiceNeedsNoto: EN-only + EN labels → false",
    invoiceNeedsNoto(enInv, enLabels) === false
  );
  check(
    "invoiceNeedsNoto: Hindi labels alone flip the decision",
    invoiceNeedsNoto(enInv, { ...enLabels, ttl: "इनवॉइस" }) === true
  );
}

/* ================================================================== */
console.log("── 6. layout planning + run-options vectors ──────────────");
/* ================================================================== */
{
  const stubMeasure = (text: string, size: number): number =>
    text.length * size * 0.5;

  check(
    "wrapText: wraps at the measured width",
    JSON.stringify(wrapText("aa bb cc", 22.5, 9, stubMeasure)) ===
      JSON.stringify(["aa bb", "cc"])
  );
  check(
    "wrapText: explicit newlines respected",
    JSON.stringify(wrapText("aa\nbb", 500, 9, stubMeasure)) ===
      JSON.stringify(["aa", "bb"])
  );
  check(
    "wrapText: an over-long word overflows on its own line",
    JSON.stringify(wrapText("aaaaaaaaaa", 10, 9, stubMeasure)) ===
      JSON.stringify(["aaaaaaaaaa"])
  );
  check(
    "wrapText: maxLines cap",
    wrapText("a b c d e f g h", 9, 9, stubMeasure, 2).length === 2
  );

  const withTax = tableColumns(515, true);
  check(
    "tableColumns: tax shown → flex item column",
    withTax.showTax === true &&
      withTax.no === 24 &&
      withTax.qty === 64 &&
      withTax.tax === 40 &&
      withTax.amount === 80 &&
      withTax.item === 307
  );
  const noTax = tableColumns(515, false);
  check(
    "tableColumns: no tax → wider item, zero tax",
    noTax.showTax === false && noTax.tax === 0 && noTax.item === 347
  );

  const mkLine = (name: string): InvoiceLine => ({
    lineId: "1",
    name,
    description: "",
    sellerAssignedId: "",
    quantity: 1,
    unitCode: "C62",
    netAmount: 10,
    unitPrice: 10,
    taxRate: 18,
    taxCategory: "S",
  });
  const lines = Array.from({ length: 5 }, (_, i) => mkLine(`Item ${i + 1}`));
  const plan = computeRows(lines, {
    contentW: 515,
    measure: stubMeasure,
    currency: "INR",
    firstAvail: 45,
    contAvail: 100,
    rowCap: MAX_LINES,
  });
  check(
    "computeRows: page break when firstAvail runs out",
    plan.pages.length === 2 &&
      (plan.pages[0]?.length ?? 0) === 2 &&
      (plan.pages[1]?.length ?? 0) === 3,
    plan.pages.map((p) => p.length)
  );
  check("computeRows: shown/total honest", plan.shown === 5 && plan.total === 5 && plan.truncated === false);

  const manyLines = Array.from({ length: 85 }, (_, i) => mkLine(`Widget ${i}`));
  const capped = computeRows(manyLines, {
    contentW: 515,
    measure: stubMeasure,
    currency: "INR",
    firstAvail: 600,
    contAvail: 600,
    rowCap: MAX_LINES,
  });
  check(
    "computeRows: rowCap truncates honestly",
    capped.shown === 80 && capped.total === 85 && capped.truncated === true
  );

  const noTaxLines = [mkLine("x")];
  noTaxLines[0] = { ...noTaxLines[0]!, taxRate: null };
  const noTaxPlan = computeRows(noTaxLines, {
    contentW: 515,
    measure: stubMeasure,
    currency: "EUR",
    firstAvail: 600,
    contAvail: 600,
    rowCap: MAX_LINES,
  });
  check(
    "computeRows: no line tax → tax column dropped",
    noTaxPlan.cols.showTax === false
  );

  // ---- planHeader / planBuyer ----------------------------------------
  const fullInv = parseCii(mustParse(fullXml));
  const header = planHeader(fullInv, {}, 515, stubMeasure);
  check(
    "planHeader: typeCode 380 with no labels → INVOICE",
    header.title === "INVOICE",
    header.title
  );
  check(
    "planHeader: left column starts with the seller name",
    header.left[0]?.text === "शर्मा ट्रेडिंग कंपनी" && header.left[0]?.bold === true
  );
  check(
    "planHeader: right column = No. + date + due date + currency (known type omitted)",
    JSON.stringify(header.right.map((r) => r.label.trim())) ===
      JSON.stringify(["No.:", "Date:", "Due date:", "Currency:"])
  );
  const labeled = planHeader(fullInv, { ttl380: "TAX INVOICE" }, 515, stubMeasure);
  check("planHeader: label map wins over the default title", labeled.title === "TAX INVOICE");

  const credit = buildCii({ ...fullSpec, typeCode: "381", prefixes: false });
  const creditInv = parseCii(mustParse(credit));
  check(
    "planHeader: credit note title",
    planHeader(creditInv, {}, 515, stubMeasure).title === "CREDIT NOTE"
  );

  const buyer = planBuyer(fullInv, enLabels, 515, stubMeasure);
  check(
    "planBuyer: label + bold name",
    buyer.left[0]?.text === "Bill to" && buyer.left[1]?.text === "Gupta Constructions Pvt Ltd"
  );
  check(
    "planBuyer: your-reference rides the right column",
    buyer.right[0]?.label === "Your reference: " && buyer.right[0]?.value === "SUPPLIER-77"
  );

  // ---- outputPdfName + parseInvoiceLabels ----------------------------
  check(
    "outputPdfName: invoice number token",
    outputPdfName("RE-2026-0042", "document") === "invoice-RE-2026-0042.pdf"
  );
  check(
    "outputPdfName: path-unsafe chars sanitized",
    outputPdfName("RE/2026:Q1*42", "doc") === "invoice-RE-2026-Q1-42.pdf"
  );
  check(
    "outputPdfName: Devanagari fileWord kept",
    outputPdfName("", "दस्तावेज़") === "invoice-दस्तावेज़.pdf"
  );
  check(
    "outputPdfName: blank → hard fallback",
    outputPdfName("", "") === "invoice-document.pdf" &&
      outputPdfName("  ", " ") === "invoice-document.pdf"
  );

  check(
    "parseInvoiceLabels: the surface's own map round-trips",
    JSON.stringify(parseInvoiceLabels(labelsJson)) === JSON.stringify(enLabels)
  );
  check("parseInvoiceLabels: garbage JSON → {}", JSON.stringify(parseInvoiceLabels("{oops")) === "{}");
  check("parseInvoiceLabels: array JSON → {}", JSON.stringify(parseInvoiceLabels("[1,2]")) === "{}");
  check(
    "parseInvoiceLabels: non-string values dropped",
    JSON.stringify(parseInvoiceLabels('{"ok":"yes","bad":1}')) === '{"ok":"yes"}'
  );
  check(
    "parseInvoiceLabels: over-long keys dropped (24 char cap)",
    JSON.stringify(parseInvoiceLabels('{"' + "k".repeat(25) + '":"v"}')) === "{}"
  );
  check(
    "parseInvoiceLabels: values sanitized (control stripped)",
    parseInvoiceLabels('{"k":"a\\u0000b"}').k === "ab"
  );

  check("caps: MAX_LINES 80 / MAX_XML_BYTES 10 MB", MAX_LINES === 80 && MAX_XML_BYTES === 10 * 1024 * 1024);
}

/* ================================================================== */
console.log("── 7. REAL E2E through the worker (self-shimmed) ─────────");
/* ================================================================== */
{
  const notoBytes = new Uint8Array(
    readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
  );

  const workerGlobal = globalThis as unknown as {
    postMessage: (msg: unknown) => void;
    onmessage: ((event: { data: WorkerRunRequest }) => void) | null;
    location: { href: string };
  };
  const messages: WorkerResponse[] = [];
  workerGlobal.postMessage = (msg: unknown): void => {
    messages.push(msg as WorkerResponse);
  };
  workerGlobal.location = { href: "http://localhost/" };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
  // the worker fetches the self-hosted Noto TTF from this origin — serve
  // the local file so the exact loadStampFonts path runs headless
  globalThis.fetch = (async (): Promise<Response> =>
    new Response(notoBytes)) as typeof fetch;
  await import("../tools/xml-invoice-to-pdf/worker");
  check("worker: module loaded, onmessage registered", typeof workerGlobal.onmessage === "function");

  const drive = async (
    runId: number,
    options: Record<string, unknown>,
    files: File[]
  ): Promise<WorkerResponse> => {
    const before = messages.length;
    workerGlobal.onmessage!({
      data: {
        type: "run",
        runId,
        toolId: "xml-invoice-to-pdf",
        options,
        files,
      } as WorkerRunRequest,
    });
    const done = await (async (): Promise<boolean> => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (
          messages
            .slice(before)
            .some((m) => m.runId === runId && (m.type === "result" || m.type === "error"))
        ) {
          return true;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return false;
    })();
    if (!done) throw new Error(`worker run ${runId} did not finish`);
    return messages
      .slice(before)
      .find((m) => m.runId === runId && (m.type === "result" || m.type === "error"))!;
  };

  /* ---------- 7a. the FULL Devanagari fixture ---------------------- */
  const fullFile = new File([fullXml], "re-2026-0042.xml", {
    type: "application/xml",
  });
  const fullRes = await drive(101, { pageSize: "a4", labels: labelsJson, fileWord: "document" }, [fullFile]);
  check("worker full: result", fullRes.type === "result", fullRes);
  if (fullRes.type === "result") {
    const out = fullRes.outputs[0]!;
    const detail = fullRes.detail as
      | {
          pages?: number;
          lines?: number;
          totalLines?: number;
          truncated?: boolean;
          fontPath?: string;
          issueKeys?: string[];
        }
      | undefined;
    check("worker full: output name", out.name === "invoice-RE-2026-0042.pdf", out.name);
    check("worker full: pdf mime", out.mime === "application/pdf");
    const outBytes = new Uint8Array(await out.blob.arrayBuffer());
    check("worker full: %PDF magic", outBytes[0] === 0x25 && outBytes[1] === 0x50);

    // updateMetadata:false — pdf-lib's load() otherwise STAMPS its own
    // producer over the file's (the smoke-epub-to-pdf recipe).
    const reloaded = await PDFDocument.load(outBytes, { updateMetadata: false });
    check("worker full: 1 page", reloaded.getPageCount() === 1, reloaded.getPageCount());
    check("worker full: detail.pages matches", detail?.pages === 1);
    check(
      "worker full: detail lines/totalLines/fontPath/issues",
      detail?.lines === 2 &&
        detail?.totalLines === 2 &&
        detail?.fontPath === "devanagari" &&
        JSON.stringify(detail?.issueKeys) === "[]",
      detail
    );
    const dump = objDump(reloaded);
    check("worker full: Noto FontFile2 embedded (fetch shim served the TTF)", dump.includes("FontFile2"));
    check("worker full: Identity-H CID encoding", dump.includes("/Identity-H"));
    check("worker full: producer MyCloudy", reloaded.getProducer() === "MyCloudy", reloaded.getProducer());
    check("worker full: creator MyCloudy", reloaded.getCreator() === "MyCloudy", reloaded.getCreator());
    check("worker full: title carries the invoice number", reloaded.getTitle() === "Invoice RE-2026-0042", reloaded.getTitle());
    check("worker full: author is the seller", reloaded.getAuthor() === "शर्मा ट्रेडिंग कंपनी", reloaded.getAuthor());

    const pages = await pdfjsPages(outBytes);
    const flat = pages.map((p) => p.map((i) => i.str).join(" ")).join("\n");
    const has = (needle: string): boolean => flat.includes(needle);

    check("worker full: invoice number", has("RE-2026-0042"));
    check("worker full: INVOICE title", has("INVOICE"));
    check("worker full: buyer name", has("Gupta Constructions Pvt Ltd"));
    check("worker full: Bill to label", has("Bill to"));
    check("worker full: Latin trading name next to Devanagari seller", has("Sharma Trading Company"));
    check("worker full: item names", has("Steel bracket") && has("Consulting support"));
    check("worker full: item description as subline", has("On-site engineering hours"));
    check("worker full: quantities with unit labels", has("400 piece") && has("160 hour"));
    check("worker full: dates human-formatted", has("15 Mar 2026") && has("14 Apr 2026"));
    check("worker full: Indian-grouping subtotal", has("1,16,000.00"));
    check("worker full: per-rate tax row", has("Tax 18% (S)") && has("20,880.00"));
    check("worker full: grand total Indian grouping", has("1,36,880.00"));
    check("worker full: prepaid row", has("36,880.00"));
    check("worker full: amount due", has("1,00,000.00"));
    check("worker full: payment means label", has("Credit transfer"));
    check("worker full: account name", has("Sharma Trading Current Account"));
    check("worker full: IncludedNote as footer text", has("Thank you for your business."));
    check("worker full: page footer", has("Page 1 / 1"));
    // Devanagari round-trip honesty (probe-deva / RB4-FIX-PUB precedent):
    // pdf.js extracts fontkit-shaped Devanagari in VISUAL order — assert
    // stable substrings (no reph, no pre-base matra) + real Deva items.
    check("worker full: Devanagari seller via stable substring", has("कंपनी"));
    check(
      "worker full: Devanagari items extracted at all (visual order)",
      pages.flat().some((i) => /[\u0900-\u097F]/.test(i.str))
    );
    checkMargins(pages, 595.28, 40, "worker full");
    writeFileSync("download/qa-xinv-full.pdf", outBytes);

    const pcts = messages
      .filter((m) => m.type === "progress" && m.runId === 101)
      .map((m) => (m as { pct: number }).pct);
    check(
      "worker full: progress pcts 20/35/45/60/85 posted",
      [20, 35, 45, 60, 85].every((p) => pcts.includes(p)),
      pcts
    );
  }

  /* ---------- 7b. EN-only EUR run (nothing embedded) ----------------- */
  const enFile = new File([enXml], "inv-eu-2026-7.xml", { type: "application/xml" });
  const enRes = await drive(102, { pageSize: "a4", labels: labelsJson, fileWord: "document" }, [enFile]);
  check("worker EN: result", enRes.type === "result", enRes);
  if (enRes.type === "result") {
    const out = enRes.outputs[0]!;
    check("worker EN: output name", out.name === "invoice-INV-EU-2026-7.pdf", out.name);
    const detail = enRes.detail as { fontPath?: string; lines?: number } | undefined;
    check("worker EN: fontPath standard (nothing embedded)", detail?.fontPath === "standard", detail);
    const outBytes = new Uint8Array(await out.blob.arrayBuffer());
    const reloaded = await PDFDocument.load(outBytes, { updateMetadata: false });
    check("worker EN: no FontFile2 (base-14 Helvetica path)", !objDump(reloaded).includes("FontFile2"));
    check("worker EN: 1 page", reloaded.getPageCount() === 1);
    check("worker EN: detail lines 1", detail?.lines === 1);
    const pages = await pdfjsPages(outBytes);
    const flat = pages.map((p) => p.map((i) => i.str).join(" ")).join("\n");
    const has = (needle: string): boolean => flat.includes(needle);
    check("worker EN: seller", has("Acme Supplies GmbH"));
    check("worker EN: buyer with decoded ampersand", has("Birch & Beam Ltd"));
    check("worker EN: item + quantity", has("oak planks") && has("120 piece"));
    check("worker EN: international grouping", has("2,400.00") && has("2,568.00"));
    check("worker EN: SEPA means label", has("SEPA credit transfer"));
    check("worker EN: issue date", has("20 Jan 2026"));
    check(
      "worker EN: strictly no Devanagari anywhere",
      !/[\u0900-\u097F]/.test(flat)
    );
    checkMargins(pages, 595.28, 40, "worker EN");
  }

  /* ---------- 7c. Letter geometry ------------------------------------ */
  const letterFile = new File([enXml], "inv-eu-2026-7.xml", { type: "application/xml" });
  const letterRes = await drive(103, { pageSize: "letter", labels: labelsJson, fileWord: "document" }, [letterFile]);
  check("worker Letter: result", letterRes.type === "result", letterRes);
  if (letterRes.type === "result") {
    const outBytes = new Uint8Array(await letterRes.outputs[0]!.blob.arrayBuffer());
    const reloaded = await PDFDocument.load(outBytes);
    const size = reloaded.getPage(reloaded.getPageCount() - 1).getSize();
    check(
      "worker Letter: 612 × 792 page",
      Math.round(size.width) === 612 && Math.round(size.height) === 792,
      { w: size.width, h: size.height }
    );
  }

  /* ---------- 7d. the 81-line truncation run ------------------------- */
  const manyFile = new File([manyXml], "bulk-81.xml", { type: "application/xml" });
  const manyRes = await drive(104, { pageSize: "a4", labels: labelsJson, fileWord: "document" }, [manyFile]);
  check("worker trunc: result", manyRes.type === "result", manyRes);
  if (manyRes.type === "result") {
    const detail = manyRes.detail as
      | {
          pages?: number;
          lines?: number;
          totalLines?: number;
          truncated?: boolean;
          issueKeys?: string[];
        }
      | undefined;
    check(
      "worker trunc: capped at 80 of 81, flagged",
      detail?.lines === 80 && detail?.totalLines === 81 && detail?.truncated === true,
      detail
    );
    check(
      "worker trunc: issueKeys = exactly [xinv.lineCap]",
      JSON.stringify(detail?.issueKeys) === '["xinv.lineCap"]',
      detail?.issueKeys
    );
    const outBytes = new Uint8Array(await manyRes.outputs[0]!.blob.arrayBuffer());
    const reloaded = await PDFDocument.load(outBytes);
    const pageCount = reloaded.getPageCount();
    check(
      "worker trunc: multi-page (80 rows cannot fit one page)",
      pageCount >= 3 && pageCount <= 6 && detail?.pages === pageCount,
      { pageCount, detail: detail?.pages }
    );
    const pages = await pdfjsPages(outBytes);
    const flat = pages.map((p) => p.map((i) => i.str).join(" ")).join("\n");
    check("worker trunc: printed truncation note", flat.includes("Showing 80 of 81 line items — the rest were omitted."), flat.slice(-300));
    check("worker trunc: first item present", flat.includes("Widget 0001"));
    check("worker trunc: the 80th item present", flat.includes("Widget 0080"));
    check("worker trunc: the 81st item ABSENT (honest omission)", !flat.includes("Widget 0081"));
    check(
      "worker trunc: page footers numbered on every page",
      pages.every((_, i) => flat.includes(`Page ${i + 1} / ${pageCount}`))
    );
    const tablePages = pages.filter((p) =>
      p.some((i) => i.str.includes("Widget 00"))
    );
    check(
      "worker trunc: repeated table header on every table page",
      tablePages.length >= 3 &&
        tablePages.every((p) => p.map((i) => i.str).join(" ").includes("Item"))
    );
  }

  /* ---------- 7e. rejection drives (honest taxonomy) ----------------- */
  const noFileRes = await drive(201, {}, []);
  check("worker reject: no file → xinv.errNoFile", noFileRes.type === "error" && noFileRes.code === "xinv.errNoFile", noFileRes);

  const garbageRes = await drive(202, {}, [new File(["hello world not xml"], "garbage.xml")]);
  check("worker reject: garbage → xinv.errNotXml", garbageRes.type === "error" && garbageRes.code === "xinv.errNotXml", garbageRes);

  const angleRes = await drive(203, {}, [new File(["<<< not really xml"], "angle.xml")]);
  check("worker reject: '<<' → xinv.errNotXml", angleRes.type === "error" && angleRes.code === "xinv.errNotXml", angleRes);

  const malformedRes = await drive(204, {}, [new File(["<rsm:CrossIndustryInvoice><ram:ID>x</ram:ID>"], "broken.xml")]);
  check("worker reject: truncated XML → xinv.errMalformed", malformedRes.type === "error" && malformedRes.code === "xinv.errMalformed", malformedRes);

  const ublRes = await drive(205, {}, [new File([
    '<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><ID>1</ID></Invoice>'
  ], "ubl-invoice.xml")]);
  check("worker reject: UBL Invoice → honest xinv.errUbl", ublRes.type === "error" && ublRes.code === "xinv.errUbl", ublRes);

  const ublCreditRes = await drive(206, {}, [new File([
    '<?xml version="1.0"?><CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"><ID>1</ID></CreditNote>'
  ], "ubl-credit.xml")]);
  check("worker reject: UBL CreditNote → honest xinv.errUbl", ublCreditRes.type === "error" && ublCreditRes.code === "xinv.errUbl", ublCreditRes);

  const notCiiRes = await drive(207, {}, [new File(["<html><body>not an invoice</body></html>"], "page.xml")]);
  check("worker reject: other XML root → xinv.errNotCii", notCiiRes.type === "error" && notCiiRes.code === "xinv.errNotCii", notCiiRes);

  const emptyRes = await drive(208, {}, [new File([
    '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"></rsm:CrossIndustryInvoice>'
  ], "empty.xml")]);
  check("worker reject: valid CII, no data → xinv.errEmpty", emptyRes.type === "error" && emptyRes.code === "xinv.errEmpty", emptyRes);

  const bigRes = await drive(209, {}, [new File([new Uint8Array(MAX_XML_BYTES + 1)], "huge.xml")]);
  check("worker reject: > 10 MB → xinv.errTooLarge", bigRes.type === "error" && bigRes.code === "xinv.errTooLarge", bigRes);

  // progress stages are always the honest trio
  const stages = new Set(
    messages
      .filter((m) => m.type === "progress")
      .map((m) => (m as { stage: string }).stage)
  );
  check(
    "worker: progress stages from the honest trio",
    [...stages].every((s) => s === "reading" || s === "processing" || s === "saving"),
    [...stages]
  );
}

/* ================================================================== */
console.log("── 8. i18n + config + wiring strings ─────────────────────");
/* ================================================================== */
{
  const enKeys = Object.keys(toolI18n.en.xinv).sort();
  const hiKeys = Object.keys(toolI18n.hi.xinv).sort();
  check(
    "i18n: tool catalog en/hi key parity",
    JSON.stringify(enKeys) === JSON.stringify(hiKeys),
    { en: enKeys.length, hi: hiKeys.length }
  );
  check("i18n: the xinv namespace is substantial", enKeys.length >= 90, enKeys.length);
  check(
    "i18n: every PDF label key resolves in BOTH catalogs",
    PDF_LABEL_KEYS.every((k) => toolI18n.en.xinv[k] && toolI18n.hi.xinv[k])
  );

  // every ParseIssueCode the model can emit has a leaf (worker maps
  // issue.code → "xinv." + code, surface renders t(`xinv.${code}`))
  const issueCodes = [
    "missNumber",
    "missDate",
    "missType",
    "missCurrency",
    "missSellerName",
    "missSellerAddr",
    "missBuyerName",
    "missBuyerAddr",
    "missLines",
    "missLineAmount",
    "missTax",
    "missTotals",
    "missPayment",
    "lineCap",
  ];
  check(
    "i18n: every ParseIssueCode leaf exists in en + hi",
    issueCodes.every((c) => c in toolI18n.en.xinv && c in toolI18n.hi.xinv)
  );

  // every xinv.* literal referenced in the tool sources resolves
  const sources = [
    "tools/xml-invoice-to-pdf/surface.tsx",
    "tools/xml-invoice-to-pdf/config.ts",
    "tools/xml-invoice-to-pdf/worker.ts",
    "tools/xml-invoice-to-pdf/model.ts",
  ]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const referenced = new Set<string>();
  for (const m of sources.matchAll(/xinv\.[A-Za-z0-9]+/g)) referenced.add(m[0]);
  const missingRef = [...referenced].filter(
    (key) => !(key.slice(5) in toolI18n.en.xinv && key.slice(5) in toolI18n.hi.xinv)
  );
  check(
    "i18n: every referenced xinv.* key resolves in both catalogs",
    referenced.size >= 40 && missingRef.length === 0,
    { missingRef, referenced: referenced.size }
  );

  // the surface's ERROR_TOASTS table must cover every worker error code
  const workerCodes = [
    "xinv.errNoFile",
    "xinv.errTooLarge",
    "xinv.errNotXml",
    "xinv.errMalformed",
    "xinv.errUbl",
    "xinv.errNotCii",
    "xinv.errEmpty",
  ];
  const surfaceSrc = readFileSync("tools/xml-invoice-to-pdf/surface.tsx", "utf8");
  check(
    "surface: ERROR_TOASTS covers every worker error code",
    workerCodes.every((code) => surfaceSrc.includes(`"${code}"`))
  );

  // shared catalog keys the surface falls back to (read-only check)
  const catEn = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as {
    tool: Record<string, string>;
  };
  const catHi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as {
    tool: Record<string, string>;
  };
  check(
    "i18n: shared tool.errorTitle/errorGeneric exist (surface fallback)",
    "errorTitle" in catEn.tool && "errorGeneric" in catEn.tool &&
      "errorTitle" in catHi.tool && "errorGeneric" in catHi.tool
  );

  // the label list the surface ships must equal the smoke's list
  const labelBlock =
    /PDF_LABEL_KEYS: readonly string\[\] = \[([^\]]*)\]/.exec(surfaceSrc)?.[1] ?? "";
  const surfaceLabelKeys = [...labelBlock.matchAll(/"([A-Za-z0-9]+)"/g)].map(
    (m) => m[1]
  );
  check(
    "surface: PDF_LABEL_KEYS matches the smoke's list",
    JSON.stringify(surfaceLabelKeys) === JSON.stringify(PDF_LABEL_KEYS),
    surfaceLabelKeys
  );

  // ---- config.ts ------------------------------------------------------
  const configSrc = readFileSync("tools/xml-invoice-to-pdf/config.ts", "utf8");
  check("config: toolId", configSrc.includes('toolId: "xml-invoice-to-pdf"'));
  check("config: spawns ./worker.ts", configSrc.includes("./worker.ts"));
  check("config: outputKind pdf", configSrc.includes('outputKind: "pdf"'));
  check("config: one file at a time", configSrc.includes("maxFiles: 1") && configSrc.includes("minFiles: 0"));
  check("config: landing surface", configSrc.includes("landingSurface: true"));
  check("config: howKeys are xinv.*", configSrc.includes('"xinv.how1"') && configSrc.includes('"xinv.how3"'));
  check("config: chain view-pdf + compress-pdf", configSrc.includes('"view-pdf"') && configSrc.includes('"compress-pdf"'));
  check("config: pageSize option declared", configSrc.includes('id: "pageSize"'));

  // ---- surface.tsx ---------------------------------------------------
  check("surface: spawns ./worker.ts", surfaceSrc.includes('new URL("./worker.ts", import.meta.url)'));
  check("surface: posts toolId", surfaceSrc.includes('toolId: "xml-invoice-to-pdf"'));
  check("surface: sniffs the XML shape itself", surfaceSrc.includes("looksLikeXml"));
  check("surface: gates the CTA on a bad file", surfaceSrc.includes('"xinv.ctaBadFile"'));
  check("surface: file input accepts .xml", surfaceSrc.includes('accept=".xml'));
  check("surface: setRunBlocked gating used", surfaceSrc.includes("setRunBlocked"));
  check("surface: pre-render parse report uses the model parser", surfaceSrc.includes("parseCii"));

  // ---- worker.ts + render.ts ------------------------------------------
  const workerSrc = readFileSync("tools/xml-invoice-to-pdf/worker.ts", "utf8");
  check("worker: reads the labels option", workerSrc.includes("request.options.labels"));
  check("worker: reads the pageSize option", workerSrc.includes("request.options.pageSize"));
  check("worker: reads the fileWord option", workerSrc.includes("request.options.fileWord"));
  check("worker: honest empty-CII error", workerSrc.includes("xinv.errEmpty"));
  const renderSrc = readFileSync("tools/xml-invoice-to-pdf/render.ts", "utf8");
  check("render: Producer MyCloudy", renderSrc.includes('setProducer("MyCloudy")'));
  check("render: repeated table header on continuation pages", renderSrc.includes("drawTableHeader(c, plan.cols)"));
}

console.log(
  `\nxml-invoice-to-pdf smoke: ${pass} passed, ${fail} failed` +
  (fail ? `\n  ${failures.join("\n  ")}` : "")
);
process.exit(fail === 0 ? 0 : 1);
