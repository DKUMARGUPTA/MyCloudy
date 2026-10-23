/**
 * Smoke: validate-e-invoice (RB5-e / RB5-FIN-e) — the honest CII checker,
 * 100% on-device. House conventions (repair-pdf + pdf-to-markdown + publisher
 * patterns): PURE model vectors first, REAL in-script fixtures after, the
 * worker driven through a self-shimmed globalThis (postMessage/location/
 * self + fetch-free), and — for the PDF mode — a Bun module plugin that
 * maps the worker-lib's "/pdfjs/*" URL imports onto public/pdfjs so the
 * REAL pdf.js attachment-extraction path runs headless in bun. Relative
 * imports without .ts, process.exit at the end.
 *
 * Sections:
 *  1. dec() — the strict dot-decimal parser
 *  2. dateOk() — format 102 + ISO calendar honesty
 *  3. sniffInput() — magic bytes (PDF / XML / unknown)
 *  4. normalizeClaim + completenessOf (the conformance heuristic)
 *  5. verdictOf — the aggregation matrix
 *  6. runChecks — every check with pass/warn/fail vectors
 *  7. totals cross-checks — the ±0.01 tolerance matrix (0.009/0.01/0.011)
 *  8. takeCii — the in-script VALID CII sample (prefixed + default-ns +
 *     odd prefixes, namespace-tolerant localName matching)
 *  9. extraction mutations — exactly the matching check responds, with
 *     exact actual/expected strings
 * 10. parseXml tolerance — comments/CDATA/entities/DOCTYPE/PIs/truncation
 * 11. report text + REPORT_LABELS_EN + parseRun + outputBaseName
 * 12. worker helpers — pickXmlAttachment / decodeXmlText / conformanceFromXmp
 * 13. REAL E2E XML mode (self-shimmed worker): valid CII → verdict PASS +
 *     the full check list; Hindi labels; honest not-xml / unparseable
 * 14. REAL E2E PDF mode (pdf-lib attach + the worker's pdf.js path):
 *     factur-x extraction, name priority + fallback, XMP conformance
 *     cross-check (consistent + mismatch), no-attachment honesty
 * 15. REAL E2E rejections — encrypted / %PDF- garbage / binary noise /
 *     plain text / 20 MB+ gate
 * 16. config + i18n sanity — en/hi leaf parity, referenced keys resolve
 *
 * Run: bun scripts/smoke-validate-e-invoice.ts   (exit code = failures)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PDFDocument, PDFName, PDFRawStream, StandardFonts } from "pdf-lib";
import { PDFDocument as CantooPDF } from "@cantoo/pdf-lib";

import {
  buildReportText,
  CURRENCIES,
  dateOk,
  dec,
  MAX_INPUT_BYTES,
  normalizeClaim,
  outputBaseName,
  parseRun,
  parseXml,
  REPORT_LABELS_EN,
  runChecks,
  sniffInput,
  takeCii,
  TAX_CATEGORIES,
  TYPE_CODES,
  verdictOf,
  type ValidationResult,
} from "../tools/validate-e-invoice/model";
import type {
  Check,
  CiiFields,
  ReportLabels,
} from "../tools/validate-e-invoice/types";
import type {
  WorkerResponse,
  WorkerRunRequest,
} from "../src/lib/workers/protocol";
import {
  conformanceFromXmp,
  decodeXmlText,
  pickXmlAttachment,
} from "../tools/validate-e-invoice/worker";

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

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** ASCII-safe UTF-16 encode with BOM (little or big endian). */
function toUtf16(s: string, le: boolean): Uint8Array {
  const out = new Uint8Array(s.length * 2 + 2);
  out[0] = le ? 0xff : 0xfe;
  out[1] = le ? 0xfe : 0xff;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = le ? c & 0xff : (c >> 8) & 0xff;
    out[3 + i * 2] = le ? (c >> 8) & 0xff : c & 0xff;
  }
  return out;
}

/** One check row by id (undefined when absent — itself an assertion). */
function oneOf(res: ValidationResult, id: string): Check | undefined {
  return res.checks.find((c) => c.id === id);
}

function statusOf(res: ValidationResult, id: string): string | undefined {
  return oneOf(res, id)?.status;
}

/** ids of every check that is not a plain pass (for the exactly-vectors). */
function nonPassIds(res: ValidationResult): string[] {
  return res.checks.filter((c) => c.status !== "pass").map((c) => c.id);
}

/** parse + extract + check a CII string (the model pipeline, XML mode). */
function runOnXml(xml: string, xmpClaim: string | null = null): ValidationResult {
  return runChecks(takeCiiOf(xml), xmpClaim === null ? {} : { xmpClaim });
}

function takeCiiOf(xml: string): CiiFields {
  const doc = parseXml(xml);
  if (doc === null) throw new Error("fixture did not parse");
  return takeCii(doc);
}

/* ------------------------------------------------------------------ */
/* the in-script VALID CII sample (Factur-X EN 16931 flavoured)         */
/* ------------------------------------------------------------------ */

interface CiiLineOpt {
  name: string | null;
  net: string | null;
}

interface CiiBuild {
  /** namespace prefixes: root / aggregate / unqualified ("" = default ns). */
  pR: string;
  pA: string;
  pU: string;
  guideline: string | null;
  id: string | null;
  date: string | null;
  typeCode: string | null;
  seller: string | null;
  buyer: string | null;
  buyerReference: string | null;
  sellerAddress: boolean;
  buyerAddress: boolean;
  currency: string | null;
  lines: CiiLineOpt[];
  lineTotal: string | null;
  taxBasis: string | null;
  taxes: { rate: string | null; category: string | null; amount: string | null }[];
  grandTotal: string | null;
  prepaid: string | null;
  due: string | null;
}

/** The all-green base: Σlines 2500 = basis, grand 2975 = 2500+475, due 2475. */
function baseCii(over: Partial<CiiBuild> = {}): CiiBuild {
  return {
    pR: "rsm",
    pA: "ram",
    pU: "udt",
    guideline: "urn:cen.eu:en16931:2017",
    id: "INV-2026-042",
    date: "20260215",
    typeCode: "380",
    seller: "Acme &amp; Sons GmbH",
    buyer: "Globex Corporation",
    buyerReference: "PO-2026-77",
    sellerAddress: true,
    buyerAddress: true,
    currency: "EUR",
    lines: [
      { name: "Consulting hours", net: "1000.00" },
      { name: "Server hosting", net: "1500.00" },
    ],
    lineTotal: "2500.00",
    taxBasis: "2500.00",
    taxes: [{ rate: "19", category: "S", amount: "475.00" }],
    grandTotal: "2975.00",
    prepaid: "500.00",
    due: "2475.00",
    ...over,
  };
}

function buildCii(o: Partial<CiiBuild> = {}): string {
  const b = baseCii(o);
  const t = (ns: string, name: string): string =>
    ns === "" ? name : `${ns}:${name}`;
  const { pR: R, pA: A, pU: U } = b;
  const rootNs =
    R === ""
      ? ` xmlns="${"urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"}"`
      : ` xmlns:${R}="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"`;
  const aggNs = ` xmlns:${A}="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"`;
  const unqNs = ` xmlns:${U}="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"`;

  const ctx =
    b.guideline === null
      ? `  <${t(R, "ExchangedDocumentContext")}/>\n`
      : `  <${t(R, "ExchangedDocumentContext")}>\n` +
        `    <${t(A, "GuidelineSpecifiedDocumentContextParameter")}>\n` +
        `      <${t(A, "ID")}>${b.guideline}</${t(A, "ID")}>\n` +
        `    </${t(A, "GuidelineSpecifiedDocumentContextParameter")}>\n` +
        `  </${t(R, "ExchangedDocumentContext")}>\n`;

  const idEl =
    b.id === null ? "" : `    <${t(A, "ID")}>${b.id}</${t(A, "ID")}>\n`;
  const dateEl =
    b.date === null
      ? ""
      : `    <${t(A, "IssueDateTime")}>\n` +
        `      <${t(U, "DateTimeString")} format="102">${b.date}</${t(U, "DateTimeString")}>\n` +
        `    </${t(A, "IssueDateTime")}>\n`;
  const tcEl =
    b.typeCode === null
      ? ""
      : `    <${t(A, "TypeCode")}>${b.typeCode}</${t(A, "TypeCode")}>\n`;

  const lines = b.lines
    .map(
      (l) =>
        `    <${t(A, "IncludedSupplyChainTradeLineItem")}>\n` +
        `      <${t(A, "SpecifiedTradeProduct")}>\n` +
        (l.name === null ? "" : `        <${t(A, "Name")}>${l.name}</${t(A, "Name")}>\n`) +
        `      </${t(A, "SpecifiedTradeProduct")}>\n` +
        `      <${t(A, "SpecifiedLineTradeSettlement")}>\n` +
        `        <${t(A, "SpecifiedTradeSettlementLineMonetarySummation")}>\n` +
        (l.net === null
          ? ""
          : `          <${t(A, "LineTotalAmount")}>${l.net}</${t(A, "LineTotalAmount")}>\n`) +
        `        </${t(A, "SpecifiedTradeSettlementLineMonetarySummation")}>\n` +
        `      </${t(A, "SpecifiedLineTradeSettlement")}>\n` +
        `    </${t(A, "IncludedSupplyChainTradeLineItem")}>\n`
    )
    .join("");

  const seller = `      <${t(A, "SellerTradeParty")}>\n` +
    (b.seller === null
      ? ""
      : `        <${t(A, "Name")}>${b.seller}</${t(A, "Name")}>\n`) +
    (b.sellerAddress
      ? `        <${t(A, "PostalTradeAddress")}><${t(A, "CityName")}>Berlin</${t(A, "CityName")}></${t(A, "PostalTradeAddress")}>\n`
      : "") +
    `      </${t(A, "SellerTradeParty")}>\n`;
  const buyer = `      <${t(A, "BuyerTradeParty")}>\n` +
    (b.buyer === null
      ? ""
      : `        <${t(A, "Name")}>${b.buyer}</${t(A, "Name")}>\n`) +
    (b.buyerAddress
      ? `        <${t(A, "PostalTradeAddress")}><${t(A, "CityName")}>Mumbai</${t(A, "CityName")}></${t(A, "PostalTradeAddress")}>\n`
      : "") +
    `      </${t(A, "BuyerTradeParty")}>\n`;
  const agreement =
    `    <${t(A, "ApplicableHeaderTradeAgreement")}>\n` +
    (b.buyerReference === null
      ? ""
      : `      <${t(A, "BuyerReference")}>${b.buyerReference}</${t(A, "BuyerReference")}>\n`) +
    seller +
    buyer +
    `    </${t(A, "ApplicableHeaderTradeAgreement")}>\n`;

  const taxes = b.taxes
    .map(
      (x) =>
        `      <${t(A, "ApplicableTradeTax")}>\n` +
        (x.rate === null
          ? ""
          : `        <${t(A, "RateApplicablePercent")}>${x.rate}</${t(A, "RateApplicablePercent")}>\n`) +
        (x.category === null
          ? ""
          : `        <${t(A, "CategoryCode")}>${x.category}</${t(A, "CategoryCode")}>\n`) +
        (x.amount === null
          ? ""
          : `        <${t(A, "CalculatedAmount")}>${x.amount}</${t(A, "CalculatedAmount")}>\n`) +
        `      </${t(A, "ApplicableTradeTax")}>\n`
    )
    .join("");

  const summ = (k: string, v: string | null): string =>
    v === null ? "" : `        <${t(A, k)}>${v}</${t(A, k)}>\n`;
  const settlement =
    `    <${t(A, "ApplicableHeaderTradeSettlement")}>\n` +
    (b.currency === null
      ? ""
      : `      <${t(A, "InvoiceCurrencyCode")}>${b.currency}</${t(A, "InvoiceCurrencyCode")}>\n`) +
    taxes +
    `      <${t(A, "SpecifiedTradeSettlementHeaderMonetarySummation")}>\n` +
    summ("LineTotalAmount", b.lineTotal) +
    summ("TaxBasisTotalAmount", b.taxBasis) +
    summ("GrandTotalAmount", b.grandTotal) +
    summ("TotalPrepaidAmount", b.prepaid) +
    summ("DuePayableAmount", b.due) +
    `      </${t(A, "SpecifiedTradeSettlementHeaderMonetarySummation")}>\n` +
    `    </${t(A, "ApplicableHeaderTradeSettlement")}>\n`;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<${t(R, "CrossIndustryInvoice")}${rootNs}${aggNs}${unqNs}>\n` +
    ctx +
    `  <${t(R, "ExchangedDocument")}>\n` +
    idEl +
    dateEl +
    tcEl +
    `  </${t(R, "ExchangedDocument")}>\n` +
    `  <${t(R, "SupplyChainTradeTransaction")}>\n` +
    agreement +
    settlement +
    lines +
    `  </${t(R, "SupplyChainTradeTransaction")}>\n` +
    `</${t(R, "CrossIndustryInvoice")}>\n`
  );
}

/** Synthetic CiiFields for the pure check-layer vectors. */
function mkFields(over: Partial<CiiFields> = {}): CiiFields {
  return {
    root: "CrossIndustryInvoice",
    hasContext: true,
    guideline: "urn:cen.eu:en16931:2017",
    invoiceId: "INV-1",
    issueDate: "20260215",
    typeCode: "380",
    seller: "Seller GmbH",
    buyer: "Buyer AG",
    buyerReference: "PO-1",
    sellerHasAddress: true,
    buyerHasAddress: true,
    currency: "EUR",
    lines: [
      { name: "A", net: "100.00" },
      { name: "B", net: "100.00" },
    ],
    lineTotal: "200.00",
    taxBasis: "200.00",
    taxes: [{ rate: "10", category: "S", amount: "20.00" }],
    grandTotal: "220.00",
    prepaid: "20.00",
    due: "200.00",
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  /* ================================================================== */
  console.log("── 1. dec() — the strict dot-decimal parser ─────────────");
  /* ================================================================== */
  {
    check("plain integer", dec("18") === 18);
    check("dot decimal", dec("18.5") === 18.5);
    check("leading dot", dec(".5") === 0.5);
    check("trailing dot", dec("18.") === 18);
    check("plus sign", dec("+7") === 7);
    check("minus sign", dec("-3.25") === -3.25);
    check("surrounding whitespace trimmed", dec("  12.75  ") === 12.75);
    check("comma (CII is dot-decimal) REJECTED", dec("18,00") === null);
    check("grouping space REJECTED", dec("1 000,00") === null);
    check("exponent REJECTED", dec("1e3") === null);
    check("NaN REJECTED", dec("NaN") === null);
    check("Infinity REJECTED", dec("Infinity") === null);
    check("empty REJECTED", dec("") === null);
    check("whitespace-only REJECTED", dec("   ") === null);
    check("two dots REJECTED", dec("12.3.4") === null);
    check("letters REJECTED", dec("abc") === null);
    check("null REJECTED", dec(null) === null);
    check("undefined REJECTED", dec(undefined) === null);
    check("null inside JSON payload REJECTED", dec(String(null)) === null);
  }

  /* ================================================================== */
  console.log("── 2. dateOk() — format 102 + ISO calendar honesty ────────");
  /* ================================================================== */
  {
    check("20260215 → ok, form 102", dateOk("20260215").ok && dateOk("20260215").form === "102");
    check("20240229 leap → ok", dateOk("20240229").ok);
    check("20230229 not a leap year → rejected", !dateOk("20230229").ok);
    check("20240230 impossible day → rejected", !dateOk("20240230").ok);
    check("20241301 month 13 → rejected", !dateOk("20241301").ok);
    check("20240001 month 0 → rejected", !dateOk("20240001").ok);
    check("2024011 seven digits → rejected", !dateOk("2024011").ok);
    check("ISO date → ok, form iso", dateOk("2024-02-29").ok && dateOk("2024-02-29").form === "iso");
    check("ISO + time + Z → ok", dateOk("2024-02-15T10:30:00Z").ok);
    check("ISO + offset → ok", dateOk("2024-02-15T10:30:00+05:30").ok);
    check("ISO bad calendar → rejected", !dateOk("2023-02-29").ok);
    check("slash format rejected", !dateOk("15/01/2024").ok);
    check("loose ISO rejected", !dateOk("2024-1-5").ok);
    check("null rejected", !dateOk(null).ok);
    check("empty rejected", !dateOk("").ok);
  }

  /* ================================================================== */
  console.log("── 3. sniffInput() — magic bytes ─────────────────────────");
  /* ================================================================== */
  {
    check("%PDF- header → pdf", sniffInput(latin1("%PDF-1.7\nrest")) === "pdf");
    check(
      "junk before %PDF- (inside 1024) → still pdf",
      sniffInput(latin1("x".repeat(200) + "%PDF-1.4\nbody")) === "pdf"
    );
    check("<?xml prolog → xml", sniffInput(latin1('<?xml version="1.0"?>\n<a/>')) === "xml");
    check("<rsm element → xml", sniffInput(latin1("<rsm:CrossIndustryInvoice/>")) === "xml");
    check("<!DOCTYPE → xml", sniffInput(latin1("<!DOCTYPE a><a/>")) === "xml");
    check("BOM + <?xml → xml", sniffInput(new Uint8Array([0xef, 0xbb, 0xbf, ...latin1("<?xml")])) === "xml");
    check("leading whitespace + <?xml → xml", sniffInput(latin1("\n  <?xml")) === "xml");
    check("plain text → unknown", sniffInput(latin1("hello plain text")) === "unknown");
    check("binary noise → unknown", sniffInput(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2])) === "unknown");
    check("<<< is not an element start → unknown", sniffInput(latin1("<<<>>>")) === "unknown");
    check("empty → unknown", sniffInput(new Uint8Array(0)) === "unknown");
    check("lone % → unknown", sniffInput(latin1("%")) === "unknown");
    check("UTF-16LE BOM + < → xml", sniffInput(toUtf16("<a/>", true)) === "xml");
    check("UTF-16BE BOM + < → xml", sniffInput(toUtf16("<a/>", false)) === "xml");
    check("UTF-16LE BOM + non-< → unknown", sniffInput(toUtf16("hello", true)) === "unknown");
    check("lone UTF-16 BOM → unknown", sniffInput(new Uint8Array([0xff, 0xfe])) === "unknown");
  }

  /* ================================================================== */
  console.log("── 4. normalizeClaim + completenessOf ────────────────────");
  /* ================================================================== */
  {
    check("claim minimum", normalizeClaim("minimum") === "MINIMUM");
    check("claim BASIC WL → BASIC", normalizeClaim("BASIC WL") === "BASIC");
    check("claim EN 16931", normalizeClaim("EN 16931") === "EN 16931");
    check("claim EN16931 (no space)", normalizeClaim("EN16931") === "EN 16931");
    check("claim XRECHNUNG → EXTENDED", normalizeClaim("XRECHNUNG") === "EXTENDED");
    check("claim EXTENDED", normalizeClaim("EXTENDED") === "EXTENDED");
    check("claim COMFORT → EXTENDED", normalizeClaim("COMFORT") === "EXTENDED");
    check("unknown claim → null", normalizeClaim("GIBBERISH") === null);
    check("empty claim → null", normalizeClaim("") === null);
    check(
      "case-insensitive claim",
      normalizeClaim("en 16931") === "EN 16931"
    );

    // completenessOf — import via the model (dynamic to keep the top clean).
    const { completenessOf } = await import("../tools/validate-e-invoice/model");
    check("full sample → EN 16931", completenessOf(mkFields()) === "EN 16931");
    check(
      "no BuyerReference → BASIC",
      completenessOf(mkFields({ buyerReference: null })) === "BASIC"
    );
    check(
      "no addresses → MINIMUM",
      completenessOf(mkFields({ sellerHasAddress: false, buyerHasAddress: false })) === "MINIMUM"
    );
    check(
      "no lines → insufficient",
      completenessOf(mkFields({ lines: [] })) === "insufficient"
    );
    check(
      "no totals → insufficient",
      completenessOf(mkFields({ taxBasis: null, grandTotal: null })) === "insufficient"
    );
    check(
      "no taxes → drops to MINIMUM",
      completenessOf(mkFields({ taxes: [] })) === "MINIMUM"
    );
  }

  /* ================================================================== */
  console.log("── 5. verdictOf — the aggregation matrix ─────────────────");
  /* ================================================================== */
  {
    check("no checks → pass", verdictOf([]) === "pass");
    check("all pass → pass", verdictOf([{ id: "a", label: "x", status: "pass" }]) === "pass");
    check("warn only → warnings", verdictOf([{ id: "a", label: "x", status: "warn" }]) === "warnings");
    check("fail only → fail", verdictOf([{ id: "a", label: "x", status: "fail" }]) === "fail");
    check(
      "fail + warn → fail (any fail wins)",
      verdictOf([
        { id: "a", label: "x", status: "warn" },
        { id: "b", label: "y", status: "fail" },
      ]) === "fail"
    );
    check(
      "fail FIRST in the list still wins",
      verdictOf([
        { id: "a", label: "x", status: "fail" },
        { id: "b", label: "y", status: "warn" },
        { id: "c", label: "z", status: "pass" },
      ]) === "fail"
    );
  }

  /* ================================================================== */
  console.log("── 6. runChecks — every check, pass/warn/fail ────────────");
  /* ================================================================== */
  {
    const base = runChecks(mkFields());
    check("base fields: all 13 checks pass", base.checks.every((c) => c.status === "pass") && base.checks.length === 13, base.checks.map((c) => `${c.id}:${c.status}`));
    check("base verdict pass", base.verdict === "pass");

    /* root */
    check("root pass (no actual needed)", statusOf(runChecks(mkFields({ root: "CrossIndustryInvoice" })), "root") === "pass");
    const ubl = oneOf(runChecks(mkFields({ root: "Invoice" })), "root");
    check("UBL root → warn + nUbl", ubl?.status === "warn" && ubl?.note === "vei.nUbl" && ubl?.actual === "Invoice" && ubl?.expected === "CrossIndustryInvoice", ubl);
    const badRoot = oneOf(runChecks(mkFields({ root: "html" })), "root");
    check("wrong root → fail, exact strings", badRoot?.status === "fail" && badRoot?.expected === "CrossIndustryInvoice" && badRoot?.actual === "html", badRoot);
    const nullRoot = oneOf(runChecks(mkFields({ root: null })), "root");
    check("null root → fail, empty actual", nullRoot?.status === "fail" && nullRoot?.actual === "", nullRoot);

    /* context */
    const noCtx = oneOf(runChecks(mkFields({ hasContext: false })), "context");
    check("missing context → fail, exact strings", noCtx?.status === "fail" && noCtx?.expected === "ExchangedDocumentContext" && noCtx?.actual === "", noCtx);
    const ctxNoGl = oneOf(runChecks(mkFields({ guideline: null })), "context");
    check("context without guideline → warn nNoGuideline", ctxNoGl?.status === "warn" && ctxNoGl?.note === "vei.nNoGuideline", ctxNoGl);
    const ctxGl = oneOf(runChecks(mkFields({ guideline: "urn:custom" })), "context");
    check("context with guideline → pass + actual", ctxGl?.status === "pass" && ctxGl?.actual === "urn:custom", ctxGl);

    /* invoice number */
    check("docId pass", oneOf(runChecks(mkFields({ invoiceId: "INV-42" })), "docId")?.actual === "INV-42");
    const idSpace = oneOf(runChecks(mkFields({ invoiceId: "INV 42" })), "docId");
    check("whitespace in id → warn nIdSpace", idSpace?.status === "warn" && idSpace?.note === "vei.nIdSpace" && idSpace?.actual === JSON.stringify("INV 42"), idSpace);
    const idEmpty = oneOf(runChecks(mkFields({ invoiceId: null })), "docId");
    check("missing id → fail, exact strings", idEmpty?.status === "fail" && idEmpty?.expected === "ExchangedDocument/ID" && idEmpty?.actual === "", idEmpty);
    check("empty-string id → fail too", statusOf(runChecks(mkFields({ invoiceId: "   " })), "docId") === "fail");

    /* issue date */
    check("102 date → pass", statusOf(runChecks(mkFields({ issueDate: "20260215" })), "docDate") === "pass");
    const isoDate = oneOf(runChecks(mkFields({ issueDate: "2026-02-15" })), "docDate");
    check("ISO date → warn nDateIso", isoDate?.status === "warn" && isoDate?.note === "vei.nDateIso" && isoDate?.actual === "2026-02-15", isoDate);
    const badDate = oneOf(runChecks(mkFields({ issueDate: "15/01/2024" })), "docDate");
    check("bad date → fail, exact strings", badDate?.status === "fail" && badDate?.expected === "YYYYMMDD (format 102) or ISO date" && badDate?.actual === "15/01/2024", badDate);
    const noDate = oneOf(runChecks(mkFields({ issueDate: null })), "docDate");
    check("missing date → fail, empty actual", noDate?.status === "fail" && noDate?.actual === "", noDate);

    /* type code */
    const tc380 = oneOf(runChecks(mkFields({ typeCode: "380" })), "typeCode");
    check("380 → pass with label", tc380?.status === "pass" && tc380?.actual === "380 — commercial invoice", tc380);
    const tc381 = oneOf(runChecks(mkFields({ typeCode: "381" })), "typeCode");
    check("381 → credit note label", tc381?.status === "pass" && tc381?.actual === "381 — credit note", tc381);
    const tc999 = oneOf(runChecks(mkFields({ typeCode: "999" })), "typeCode");
    check("unknown numeric code → warn nTypeUnknown", tc999?.status === "warn" && tc999?.note === "vei.nTypeUnknown" && tc999?.actual === "999", tc999);
    const tcBad = oneOf(runChecks(mkFields({ typeCode: "X80" })), "typeCode");
    check("non-numeric code → fail", tcBad?.status === "fail" && tcBad?.actual === "X80", tcBad);
    const tcNone = oneOf(runChecks(mkFields({ typeCode: null })), "typeCode");
    check("missing code → fail, exact strings", tcNone?.status === "fail" && tcNone?.expected === "380 / 381 / 384 …" && tcNone?.actual === "", tcNone);
    check("TYPE_CODES whitelist sanity", TYPE_CODES["384"] === "corrected invoice" && TYPE_CODES["261"] === "self-billed credit note");

    /* seller + buyer */
    check("seller present → pass", statusOf(runChecks(mkFields({ seller: "Seller AG" })), "seller") === "pass");
    const noSeller = oneOf(runChecks(mkFields({ seller: "" })), "seller");
    check("empty seller → warn nSellerMissing", noSeller?.status === "warn" && noSeller?.note === "vei.nSellerMissing", noSeller);
    check("buyer present → pass", statusOf(runChecks(mkFields({ buyer: "Buyer AG" })), "buyer") === "pass");
    const noBuyer = oneOf(runChecks(mkFields({ buyer: "" })), "buyer");
    check("empty buyer → warn nBuyerMissing", noBuyer?.status === "warn" && noBuyer?.note === "vei.nBuyerMissing", noBuyer);

    /* lines */
    const noLines = oneOf(runChecks(mkFields({ lines: [] })), "lines");
    check("no lines → fail, exact strings", noLines?.status === "fail" && noLines?.expected === "≥ 1 IncludedSupplyChainTradeLineItem" && noLines?.actual === "0", noLines);
    const badNet = oneOf(runChecks(mkFields({ lines: [{ name: "A", net: "abc" }] })), "lines");
    check("unparseable line net → fail nLineNetBad", badNet?.status === "fail" && badNet?.note === "vei.nLineNetBad" && badNet?.actual === "line 1", badNet);
    const nameless = oneOf(runChecks(mkFields({ lines: [{ name: null, net: "10.00" }] })), "lines");
    check("nameless line → warn nNameless", nameless?.status === "warn" && nameless?.note === "vei.nNameless" && nameless?.actual === "line 1", nameless);
    const mixed = oneOf(runChecks(mkFields({ lines: [{ name: "A", net: "10.00" }, { name: "B", net: "x" }, { name: "C", net: "5.00" }] })), "lines");
    check("bad net in the middle listed by index", mixed?.status === "fail" && mixed?.actual === "line 2", mixed);
    check("good lines → pass with count", oneOf(runChecks(mkFields()), "lines")?.actual === "2");

    /* taxes */
    const noTaxes = oneOf(runChecks(mkFields({ taxes: [] })), "taxes");
    check("no tax entries → fail, exact strings", noTaxes?.status === "fail" && noTaxes?.expected === "≥ 1 ApplicableTradeTax" && noTaxes?.actual === "0", noTaxes);
    const badTax = oneOf(runChecks(mkFields({ taxes: [{ rate: "abc", category: "X", amount: "1,00" }] })), "taxes");
    check(
      "bad tax → warn with all three problems listed",
      badTax?.status === "warn" &&
        badTax?.note === "vei.nTaxBad" &&
        badTax?.actual === "tax 1 (category X, rate abc, amount not a dot-decimal)",
      badTax
    );
    const missingCat = oneOf(runChecks(mkFields({ taxes: [{ rate: "0", category: "", amount: "0.00" }] })), "taxes");
    check("missing category shown as (missing)", missingCat?.status === "warn" && missingCat?.actual === "tax 1 (category (missing))", missingCat);
    const goodTaxes = oneOf(runChecks(mkFields({ taxes: [{ rate: "19", category: "S", amount: "475.00" }, { rate: "0", category: "Z", amount: "0.00" }] })), "taxes");
    check("good taxes → pass with S @ 19%; Z @ 0%", goodTaxes?.status === "pass" && goodTaxes?.actual === "S @ 19%; Z @ 0%", goodTaxes);
    check("TAX_CATEGORIES labels", TAX_CATEGORIES.S === "standard rate" && TAX_CATEGORIES.AE === "reverse charge (VAT reverse charge)" && TAX_CATEGORIES.O === "not subject to VAT");

    /* currency */
    check("EUR → pass", oneOf(runChecks(mkFields({ currency: "EUR" })), "currency")?.actual === "EUR");
    check("INR whitelisted", CURRENCIES.has("INR") && CURRENCIES.has("USD"));
    const rare = oneOf(runChecks(mkFields({ currency: "XYZ" })), "currency");
    check("rare 3-letter → warn nCurrencyRare", rare?.status === "warn" && rare?.note === "vei.nCurrencyRare" && rare?.actual === "XYZ", rare);
    const lower = oneOf(runChecks(mkFields({ currency: "inr" })), "currency");
    check("lowercase → fail", lower?.status === "fail" && lower?.actual === "inr", lower);
    const none = oneOf(runChecks(mkFields({ currency: null })), "currency");
    check("missing currency → fail, exact strings", none?.status === "fail" && none?.expected === "ISO 4217 (EUR, INR, USD …)" && none?.actual === "", none);

    /* conformance cross-check (informational — never changes a verdict) */
    const confPass = oneOf(runChecks(mkFields(), { xmpClaim: "BASIC" }), "conformance");
    check("claim BASIC + EN 16931 contents → pass nConfLower", confPass?.status === "pass" && confPass?.note === "vei.nConfLower" && confPass?.expected === "BASIC (XMP)" && confPass?.actual === "EN 16931 (XML)", confPass);
    const confEq = oneOf(runChecks(mkFields(), { xmpClaim: "EN 16931" }), "conformance");
    check("claim == contents → pass", confEq?.status === "pass", confEq);
    const confMismatch = oneOf(runChecks(mkFields({ buyerReference: null }), { xmpClaim: "EN 16931" }), "conformance");
    check("claim above contents → warn nConfMismatch, exact strings", confMismatch?.status === "warn" && confMismatch?.note === "vei.nConfMismatch" && confMismatch?.expected === "EN 16931 (XMP)" && confMismatch?.actual === "BASIC (XML)", confMismatch);
    const confInsufficient = oneOf(runChecks(mkFields({ lines: [], taxBasis: null, grandTotal: null }), { xmpClaim: "BASIC" }), "conformance");
    check("insufficient contents → warn nConfInsufficient", confInsufficient?.status === "warn" && confInsufficient?.note === "vei.nConfInsufficient" && confInsufficient?.actual === "insufficient", confInsufficient);
    const confUnknown = oneOf(runChecks(mkFields(), { xmpClaim: "ULTRA" }), "conformance");
    check("unknown claim → warn nConfUnknown", confUnknown?.status === "warn" && confUnknown?.note === "vei.nConfUnknown" && confUnknown?.actual === "ULTRA", confUnknown);
    check("no claim → no conformance check at all", oneOf(runChecks(mkFields()), "conformance") === undefined && runChecks(mkFields()).checks.length === 13);
    check(
      "conformance warn never fails the verdict",
      runChecks(mkFields({ buyerReference: null }), { xmpClaim: "EN 16931" }).verdict === "warnings"
    );
  }

  /* ================================================================== */
  console.log("── 7. totals cross-checks — the ±0.01 tolerance matrix ──");
  /* ================================================================== */
  {
    /* Σ lines == TaxBasisTotalAmount */
    check("Σlines vs basis: exact → pass", statusOf(runChecks(mkFields()), "sumLines") === "pass");
    check(
      "Σlines vs basis: 0.009 off → pass",
      statusOf(runChecks(mkFields({ taxBasis: "200.009" })), "sumLines") === "pass"
    );
    check(
      "Σlines vs basis: exactly 0.01 off → pass (documented headroom)",
      statusOf(runChecks(mkFields({ taxBasis: "200.01" })), "sumLines") === "pass"
    );
    const sumFail = oneOf(runChecks(mkFields({ taxBasis: "200.011" })), "sumLines");
    check(
      "Σlines vs basis: 0.011 off → fail with exact numbers",
      sumFail?.status === "fail" && sumFail?.expected === "200.01" && sumFail?.actual === "200.00",
      sumFail
    );
    const sumNull = oneOf(runChecks(mkFields({ taxBasis: null, lineTotal: null })), "sumLines");
    check("missing basis (no LineTotal either) → fail, exact strings", sumNull?.status === "fail" && sumNull?.expected === "TaxBasisTotalAmount" && sumNull?.actual === "", sumNull);
    const viaLt = oneOf(runChecks(mkFields({ taxBasis: null, lineTotal: "200.00" })), "sumLines");
    check("missing basis + matching LineTotal → warn nSumViaLt", viaLt?.status === "warn" && viaLt?.note === "vei.nSumViaLt" && viaLt?.expected === "200.00" && viaLt?.actual === "200.00", viaLt);
    const noParseable = oneOf(runChecks(mkFields({ lines: [{ name: "A", net: null }], taxBasis: "0.00" })), "sumLines");
    check("no parseable nets → pass carries nNoParseableNets", noParseable?.status === "pass" && noParseable?.note === "vei.nNoParseableNets", noParseable);

    /* GrandTotal == TaxBasis + Σ taxes */
    const gBase = { taxBasis: "100.00", taxes: [{ rate: "18", category: "S", amount: "18.00" }] };
    check("grand: exact → pass", statusOf(runChecks(mkFields({ ...gBase, grandTotal: "118.00" })), "grand") === "pass");
    check("grand: 0.009 off → pass", statusOf(runChecks(mkFields({ ...gBase, grandTotal: "118.009" })), "grand") === "pass");
    check("grand: 0.01 off → pass (headroom)", statusOf(runChecks(mkFields({ ...gBase, grandTotal: "118.01" })), "grand") === "pass");
    const gFail = oneOf(runChecks(mkFields({ ...gBase, grandTotal: "118.011" })), "grand");
    check("grand: 0.011 off → fail with exact numbers", gFail?.status === "fail" && gFail?.expected === "118.00" && gFail?.actual === "118.01", gFail);
    const gNoBasis = oneOf(runChecks(mkFields({ taxBasis: null })), "grand");
    check("grand without basis → fail nBasisMissing", gNoBasis?.status === "fail" && gNoBasis?.note === "vei.nBasisMissing", gNoBasis);
    const gNoTax = oneOf(runChecks(mkFields({ taxes: [], grandTotal: "200.00" })), "grand");
    check("grand vs empty tax sum → warn nNoTaxEntries", gNoTax?.status === "warn" && gNoTax?.note === "vei.nNoTaxEntries" && gNoTax?.expected === "200.00", gNoTax);

    /* DuePayable == GrandTotal − TotalPrepaid */
    const dBase = { grandTotal: "118.00", prepaid: "18.00" };
    check("due: exact → pass", statusOf(runChecks(mkFields({ ...dBase, due: "100.00" })), "due") === "pass");
    check("due: 0.009 off → pass", statusOf(runChecks(mkFields({ ...dBase, due: "100.009" })), "due") === "pass");
    check("due: 0.01 off → pass (headroom)", statusOf(runChecks(mkFields({ ...dBase, due: "100.01" })), "due") === "pass");
    const dFail = oneOf(runChecks(mkFields({ ...dBase, due: "100.011" })), "due");
    check("due: 0.011 off → fail with exact numbers", dFail?.status === "fail" && dFail?.expected === "100.00" && dFail?.actual === "100.01", dFail);
    const dMissing = oneOf(runChecks(mkFields({ due: null })), "due");
    check("missing DuePayable → warn nDueMissing", dMissing?.status === "warn" && dMissing?.note === "vei.nDueMissing", dMissing);
    const dNoGrand = oneOf(runChecks(mkFields({ grandTotal: null, due: "100.00" })), "due");
    check("due without grand → fail, exact strings", dNoGrand?.status === "fail" && dNoGrand?.expected === "GrandTotalAmount" && dNoGrand?.actual === "100.00", dNoGrand);
    check(
      "no prepaid → due must equal grand",
      statusOf(runChecks(mkFields({ prepaid: null, due: "220.00" })), "due") === "pass"
    );

    /* the reconciliation table itself (computed once, display-ready) */
    const base = runChecks(mkFields());
    check(
      "totals triple computed for the table",
      base.totals.lineSum === "200.00" &&
        base.totals.lineTotal === "200.00" &&
        base.totals.taxBasis === "200.00" &&
        base.totals.taxSum === "20.00" &&
        base.totals.taxBasisPlusTax === "220.00" &&
        base.totals.grandTotal === "220.00" &&
        base.totals.prepaid === "20.00" &&
        base.totals.grandMinusPrepaid === "200.00" &&
        base.totals.due === "200.00" &&
        base.totals.currency === "EUR",
      base.totals
    );
    const noNets = runChecks(mkFields({ lines: [{ name: "A", net: null }] }));
    check("no parseable nets → lineSum blank + taxSum still computed", noNets.totals.lineSum === "" && noNets.totals.taxSum === "20.00", noNets.totals);
  }

  /* ================================================================== */
  console.log("── 8. takeCii — the VALID sample, three namespace spellings ");
  /* ================================================================== */
  {
    const xml = buildCii();
    check(
      "fixture is the canonical prefixed spelling",
      xml.startsWith("<?xml") && xml.includes("<rsm:CrossIndustryInvoice"),
      xml.slice(0, 80)
    );

    const f = takeCiiOf(xml);
    check("root localName", f.root === "CrossIndustryInvoice", f.root);
    check("hasContext", f.hasContext === true);
    check("guideline", f.guideline === "urn:cen.eu:en16931:2017", f.guideline);
    check("invoiceId", f.invoiceId === "INV-2026-042", f.invoiceId);
    check("issueDate (format 102)", f.issueDate === "20260215", f.issueDate);
    check("typeCode", f.typeCode === "380", f.typeCode);
    check("seller with entity decoded", f.seller === "Acme & Sons GmbH", f.seller);
    check("buyer", f.buyer === "Globex Corporation", f.buyer);
    check("buyerReference", f.buyerReference === "PO-2026-77", f.buyerReference);
    check("sellerHasAddress", f.sellerHasAddress === true);
    check("buyerHasAddress", f.buyerHasAddress === true);
    check("currency", f.currency === "EUR", f.currency);
    check(
      "lines: names + nets in order",
      f.lines.length === 2 &&
        f.lines[0]?.name === "Consulting hours" && f.lines[0]?.net === "1000.00" &&
        f.lines[1]?.name === "Server hosting" && f.lines[1]?.net === "1500.00",
      f.lines
    );
    check("header lineTotal", f.lineTotal === "2500.00", f.lineTotal);
    check("taxBasis", f.taxBasis === "2500.00", f.taxBasis);
    check(
      "taxes: rate + category + amount",
      f.taxes.length === 1 && f.taxes[0]?.rate === "19" && f.taxes[0]?.category === "S" && f.taxes[0]?.amount === "475.00",
      f.taxes
    );
    check("grandTotal", f.grandTotal === "2975.00", f.grandTotal);
    check("prepaid", f.prepaid === "500.00", f.prepaid);
    check("due", f.due === "2475.00", f.due);

    /* the full pipeline on the sample: every check passes */
    const res = runOnXml(xml);
    check(
      "runChecks on the valid sample: 13/13 pass",
      res.checks.length === 13 && res.checks.every((c) => c.status === "pass") && res.verdict === "pass",
      res.checks.map((c) => `${c.id}:${c.status}`)
    );

    /* default namespace on the root (children prefixed) */
    const defNs = buildCii({ pR: "" });
    const fd = takeCiiOf(defNs);
    check(
      "default-ns root extracts identically",
      fd.root === "CrossIndustryInvoice" && fd.invoiceId === "INV-2026-042" && fd.buyer === "Globex Corporation" && fd.due === "2475.00",
      [fd.root, fd.invoiceId, fd.buyer, fd.due]
    );
    check("default-ns pipeline passes too", runOnXml(defNs).verdict === "pass");

    /* completely odd prefixes */
    const odd = buildCii({ pR: "zz", pA: "qq", pU: "t7" });
    const fo = takeCiiOf(odd);
    check(
      "odd prefixes extract identically (localName matching)",
      fo.root === "CrossIndustryInvoice" && fo.guideline === "urn:cen.eu:en16931:2017" && fo.currency === "EUR" && fo.taxes[0]?.amount === "475.00",
      [fo.root, fo.guideline, fo.currency, fo.taxes[0]?.amount]
    );
    check("odd-prefix pipeline passes too", runOnXml(odd).verdict === "pass");

    /* older D16B spellings the extractor tolerates */
    const legacy = `<?xml version="1.0"?>
<CrossIndustryInvoice>
  <ExchangedDocumentContext><GuidelineSpecifiedDocumentContextParameter><ID>urn:old</ID></GuidelineSpecifiedDocumentContextParameter></ExchangedDocumentContext>
  <ExchangedDocument><ID>OLD-1</ID><IssueDateTime><DateTimeString>20240101</DateTimeString></IssueDateTime><TypeCode>380</TypeCode></ExchangedDocument>
  <SupplyChainTradeTransaction>
    <ApplicableSupplyChainTradeAgreement>
      <SellerTradeParty><Name>Old Seller</Name></SellerTradeParty>
      <BuyerTradeParty><Name>Old Buyer</Name></BuyerTradeParty>
    </ApplicableSupplyChainTradeAgreement>
    <ApplicableSupplyChainTradeSettlement>
      <InvoiceCurrencyCode>USD</InvoiceCurrencyCode>
      <ApplicableTradeTax><CalculatedAmount>0.00</CalculatedAmount><CategoryCode>Z</CategoryCode><RateApplicablePercent>0</RateApplicablePercent></ApplicableTradeTax>
      <SpecifiedTradeSettlementHeaderMonetarySummation><LineTotalAmount>50.00</LineTotalAmount><TaxBasisTotalAmount>50.00</TaxBasisTotalAmount><GrandTotalAmount>50.00</GrandTotalAmount><DuePayableAmount>50.00</DuePayableAmount></SpecifiedTradeSettlementHeaderMonetarySummation>
    </ApplicableSupplyChainTradeSettlement>
    <IncludedSupplyChainTradeLineItem>
      <SpecifiedSupplyChainTradeProduct><Name>Legacy widget</Name></SpecifiedSupplyChainTradeProduct>
      <SpecifiedTradeSettlementLineMonetarySummation><LineTotalAmount>50.00</LineTotalAmount></SpecifiedTradeSettlementLineMonetarySummation>
    </IncludedSupplyChainTradeLineItem>
  </SupplyChainTradeTransaction>
</CrossIndustryInvoice>`;
    const fl = takeCiiOf(legacy);
    check(
      "D16B spellings (ApplicableSupplyChain*, SpecifiedSupplyChainTradeProduct) extract",
      fl.seller === "Old Seller" && fl.buyer === "Old Buyer" && fl.lines[0]?.name === "Legacy widget" && fl.lines[0]?.net === "50.00" && fl.currency === "USD" && fl.guideline === "urn:old",
      [fl.seller, fl.buyer, fl.lines[0]?.name, fl.lines[0]?.net, fl.currency]
    );
    check("D16B pipeline passes", runOnXml(legacy).verdict === "pass", runOnXml(legacy).checks.filter((c) => c.status !== "pass").map((c) => c.id));

    /* direct text on IssueDateTime (no DateTimeString wrapper) */
    const directDate = `<?xml version="1.0"?>
<CrossIndustryInvoice>
  <ExchangedDocument><ID>D-1</ID><IssueDateTime>20240102</IssueDateTime></ExchangedDocument>
</CrossIndustryInvoice>`;
    check("direct IssueDateTime text picked up", takeCiiOf(directDate).issueDate === "20240102", takeCiiOf(directDate).issueDate);
  }

  /* ================================================================== */
  console.log("── 9. extraction mutations — exactly the matching check ──");
  /* ================================================================== */
  {
    const base = runOnXml(buildCii());
    check("base: nothing non-pass", nonPassIds(base).length === 0, nonPassIds(base));

    /* (1) drop the invoice ID */
    const m1 = runOnXml(buildCii({ id: null }));
    const c1 = oneOf(m1, "docId");
    check(
      "drop ID → exactly docId fails, exact strings",
      nonPassIds(m1).join(",") === "docId" &&
        c1?.status === "fail" && c1?.expected === "ExchangedDocument/ID" && c1?.actual === "",
      { nonPass: nonPassIds(m1), c1 }
    );

    /* (2) bad date */
    const m2 = runOnXml(buildCii({ date: "15/01/2024" }));
    const c2 = oneOf(m2, "docDate");
    check(
      "bad date → exactly docDate fails, exact strings",
      nonPassIds(m2).join(",") === "docDate" &&
        c2?.status === "fail" && c2?.expected === "YYYYMMDD (format 102) or ISO date" && c2?.actual === "15/01/2024",
      { nonPass: nonPassIds(m2), c2 }
    );

    /* (3) wrong GrandTotal (due kept consistent so ONLY grand is off) */
    const m3 = runOnXml(buildCii({ grandTotal: "3100.00", due: "2600.00" }));
    const c3 = oneOf(m3, "grand");
    check(
      "wrong GrandTotal → exactly grand fails, expected computed sum vs file",
      nonPassIds(m3).join(",") === "grand" &&
        c3?.status === "fail" && c3?.expected === "2975.00" && c3?.actual === "3100.00",
      { nonPass: nonPassIds(m3), c3 }
    );

    /* (4) empty buyer */
    const m4 = runOnXml(buildCii({ buyer: "" }));
    const c4 = oneOf(m4, "buyer");
    check(
      "empty buyer → exactly buyer warns, verdict warnings",
      nonPassIds(m4).join(",") === "buyer" &&
        c4?.status === "warn" && c4?.note === "vei.nBuyerMissing" && m4.verdict === "warnings",
      { nonPass: nonPassIds(m4), c4 }
    );

    /* (5) bad currency code */
    const m5 = runOnXml(buildCii({ currency: "inr" }));
    const c5 = oneOf(m5, "currency");
    check(
      "bad currency → exactly currency fails, exact strings",
      nonPassIds(m5).join(",") === "currency" &&
        c5?.status === "fail" && c5?.actual === "inr" && m5.verdict === "fail",
      { nonPass: nonPassIds(m5), c5 }
    );

    /* (6) missing lines (sumLines necessarily falls with it) */
    const m6 = runOnXml(buildCii({ lines: [] }));
    const c6 = oneOf(m6, "lines");
    const s6 = oneOf(m6, "sumLines");
    check(
      "missing lines → lines fails with exact strings",
      c6?.status === "fail" && c6?.expected === "≥ 1 IncludedSupplyChainTradeLineItem" && c6?.actual === "0",
      c6
    );
    check(
      "missing lines → Σ 0 vs 2500 also fails, exact numbers",
      s6?.status === "fail" && s6?.expected === "2500.00" && s6?.actual === "0.00" && nonPassIds(m6).join(",") === "lines,sumLines",
      { nonPass: nonPassIds(m6), s6 }
    );
  }

  /* ================================================================== */
  console.log("── 10. parseXml tolerance ────────────────────────────────");
  /* ================================================================== */
  {
    check("plain text → no element", parseXml("just text") === null);
    check("comment only → no element", parseXml("<!-- only a comment -->") === null);
    const commented = parseXml("<a><!-- hidden --></a>");
    check("comment skipped", commented?.name === "a" && commented.children.length === 0, commented);
    const cdata = parseXml("<a><b><![CDATA[raw & <text>]]></b></a>");
    check("CDATA text kept raw", cdata?.children[0]?.text === "raw & <text>", cdata?.children[0]?.text);
    const ents = parseXml("<a><b>A &amp; B &#8364; &#x20AC; &unknown;</b></a>");
    check("entities decoded, unknown kept", ents?.children[0]?.text === "A & B € € &unknown;", ents?.children[0]?.text);
    const dt = parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a x="1"/>');
    check("DOCTYPE with internal subset skipped, attrs parsed", dt?.name === "a" && dt?.attrs.x === "1", dt);
    const pi = parseXml('<?xml-stylesheet href="x"?><a/>');
    check("PI skipped", pi?.name === "a");
    const mismatch = parseXml("<a><b>text</a>");
    check("mismatched close pops to the matching open", mismatch?.children[0]?.name === "b" && mismatch?.children[0]?.text === "text");
    const trunc = parseXml("<a><b>partial");
    check("truncated tail kept as far as parsed", trunc?.children[0]?.text === "partial");
    const self = parseXml("<a><b/></a>");
    check("self-closing child", self?.children[0]?.name === "b" && (self?.children[0]?.children.length ?? 1) === 0);
    const prefAttr = parseXml('<zz:a xmlns:zz="u" qq:qty="7"/>');
    check("prefixed attribute matched by localName", prefAttr?.attrs.qty === "7", prefAttr?.attrs);
    const bom = parseXml("\uFEFF<a/>");
    check("BOM stripped", bom?.name === "a");
    const nested = parseXml("<x:a><y:b></y:b></x:a>");
    check("prefixed closes match localName", nested?.children[0]?.name === "b");
    const deep = parseXml("<a>" + "<b>".repeat(60) + "core" + "</b>".repeat(60) + "</a>");
    check("60-deep nesting parses", deep?.name === "a");
    const textNodes = parseXml("<a>one<b/>two</a>");
    check("direct text concatenated", textNodes?.text === "onetwo", textNodes?.text);
  }

  /* ================================================================== */
  console.log("── 11. report text + parseRun + outputBaseName ───────────");
  /* ================================================================== */
  {
    const res = runOnXml(buildCii());
    const meta = {
      fileName: "sample-invoice.xml",
      bytes: 1234,
      mode: "xml" as const,
      attachmentName: null,
      xmpClaim: null,
    };
    const text = buildReportText(
      { verdict: res.verdict, checks: res.checks, totals: res.totals },
      meta,
      {}
    );
    check("title header", text.startsWith("=".repeat(64) + "\nMyCloudy — e-invoice validation report"));
    check("file line", text.includes("File: sample-invoice.xml (1.2 KB)"));
    check("input line xml mode", text.includes("Input: CII XML (direct)"));
    check("verdict line", text.includes("VERDICT: PASS"));
    check("counts line", text.includes("13 passed, 0 warnings, 0 failed"));
    check("check row with mark", text.includes("[PASS] Root element is CrossIndustryInvoice (CII)"));
    check("totals table", text.includes("TOTALS RECONCILIATION") && text.includes("2500.00   TaxBasisTotalAmount") && text.includes("2975.00   GrandTotalAmount") && text.includes("2475.00   DuePayableAmount"));
    check("currency row", text.includes("currency: EUR"));
    check("honesty footer present", text.includes("NOT CHECKED (honesty)") && text.includes("Generated on-device by MyCloudy — nothing was uploaded."));

    const pdfMeta = {
      fileName: "factur.pdf",
      bytes: 2048,
      mode: "pdf" as const,
      attachmentName: "factur-x.xml",
      xmpClaim: "EN 16931",
    };
    const pdfText = buildReportText(
      { verdict: "warnings", checks: res.checks, totals: res.totals },
      pdfMeta,
      {}
    );
    check("pdf mode input line names the attachment", pdfText.includes("Input: PDF — embedded XML extracted — factur-x.xml"));
    check("xmp claim line", pdfText.includes("XMP conformance claim: EN 16931"));
    check("warn verdict word", pdfText.includes("VERDICT: PASS WITH WARNINGS"));

    const labels: ReportLabels = {
      "vei.title": "Prüfbericht",
      "vei.kRoot": "Wurzelelement",
      "vei.vPass": "BESTANDEN",
    };
    const labeled = buildReportText(
      { verdict: res.verdict, checks: res.checks, totals: res.totals },
      meta,
      labels
    );
    check("label overrides respected", labeled.includes("MyCloudy — Prüfbericht") && labeled.includes("[PASS] Wurzelelement") && labeled.includes("VERDICT: BESTANDEN"));
    check("unknown keys fall back to English", labeled.includes("13 passed, 0 warnings, 0 failed"));
    check(
      "deterministic: same input → byte-identical report",
      buildReportText({ verdict: res.verdict, checks: res.checks, totals: res.totals }, meta, labels) === labeled
    );

    /* parseRun */
    const d0 = parseRun("");
    check("parseRun defaults", d0.locale === "en" && d0.fileWord === "" && Object.keys(d0.labels).length === 0, d0);
    const garbage = parseRun("not json at all");
    check("parseRun garbage degrades", garbage.locale === "en" && garbage.fileWord === "");
    const full = parseRun(
      JSON.stringify({
        locale: "hi",
        fileWord: "  bad\u0007 word  ",
        labels: {
          "vei.title": "टाइटल",
          "notvei.key": "dropped",
          "vei.ok": "x".repeat(300),
          "vei.num": 42,
        },
      })
    );
    check("parseRun locale must be exactly hi", full.locale === "hi");
    check("parseRun fileWord sanitized", full.fileWord === "bad word", full.fileWord);
    check(
      "parseRun labels filtered (vei.* + string only, 240 cap)",
      Object.keys(full.labels).length === 2 &&
        full.labels["vei.title"] === "टाइटल" &&
        full.labels["vei.ok"] === "x".repeat(240),
      full.labels
    );

    /* outputBaseName */
    check("strips .xml", outputBaseName("My Doc.XML", "en") === "My Doc");
    check("strips .pdf", outputBaseName("My Doc.PDF", "en") === "My Doc");
    check("keeps other extensions", outputBaseName("archive.tar", "en") === "archive.tar");
    check("unsafe chars replaced", !/[\\/:*?"<>|]/.test(outputBaseName('weird<>:"/\\|?*name.pdf', "en")));
    check("nameless fallback en", outputBaseName(".pdf", "en") === "document");
    check("nameless fallback hi", outputBaseName(".xml", "hi") === "दस्तावेज़");
    check("fileWord override", outputBaseName(".pdf", "en", "report") === "report");
    check("long names capped at 120", outputBaseName("x".repeat(300) + ".xml", "en").length === 120);
  }

  /* ================================================================== */
  console.log("── 12. worker helpers ────────────────────────────────────");
  /* ================================================================== */
  {
    const u8 = new Uint8Array([1, 2, 3]);
    check("pick: null attachments", pickXmlAttachment(null) === null);
    check("pick: empty attachments", pickXmlAttachment({}) === null);
    check("pick: non-xml only", pickXmlAttachment({ "readme.txt": { content: u8 } }) === null);
    check("pick: junk content not Uint8Array", pickXmlAttachment({ "weird": { content: "str" } }) === null);
    check(
      "pick: factur-x.xml by name",
      pickXmlAttachment({ "factur-x.xml": { content: u8 } })?.name === "factur-x.xml"
    );
    check(
      "priority beats alphabetical (zugferd over invoice)",
      pickXmlAttachment({
        "invoice.xml": { content: u8 },
        "zugferd-invoice.xml": { content: u8 },
      })?.name === "zugferd-invoice.xml"
    );
    check(
      "xrechnung before the generic fallback",
      pickXmlAttachment({
        "cii.xml": { content: u8 },
        "xrechnung.xml": { content: u8 },
      })?.name === "xrechnung.xml"
    );
    check(
      "uppercase preferred name matched case-insensitively",
      pickXmlAttachment({ "FACTUR-X.XML": { content: u8 } })?.name === "FACTUR-X.XML"
    );
    check(
      "uppercase .XML picked by the case-insensitive fallback",
      pickXmlAttachment({ "data.XML": { content: u8 }, "aaa.txt": { content: u8 } })?.name === "data.XML"
    );
    check(
      "fallback xml names sorted alphabetically",
      pickXmlAttachment({
        "zzz.xml": { content: u8 },
        "aaa.xml": { content: u8 },
      })?.name === "aaa.xml"
    );
    check(
      "preferred entry with junk content skipped, next xml used",
      pickXmlAttachment({
        "factur-x.xml": { content: "nope" },
        "invoice.xml": { content: u8 },
      })?.name === "invoice.xml"
    );

    check("decode: utf-8", decodeXmlText(enc.encode("héllo <a/>")) === "héllo <a/>");
    const le = decodeXmlText(toUtf16("<a/>", true));
    check("decode: utf-16le with BOM", le.includes("<a/>") && le.length <= 4, JSON.stringify(le));
    const be = decodeXmlText(toUtf16("<a/>", false));
    check("decode: utf-16be with BOM", be.includes("<a/>") && be.length <= 4, JSON.stringify(be));

    const xmp =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa">' +
      "<fx:DocumentType>INVOICE</fx:DocumentType>" +
      "<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>" +
      "</rdf:Description></rdf:RDF></x:xmpmeta>";
    check("xmp: conformance level extracted", conformanceFromXmp(xmp) === "EN 16931", conformanceFromXmp(xmp));
    check(
      "xmp: padded value trimmed",
      conformanceFromXmp("<a:ConformanceLevel>  BASIC WL  </a:ConformanceLevel>") === "BASIC WL"
    );
    check("xmp: no claim → null", conformanceFromXmp("<fx:DocumentType>INVOICE</fx:DocumentType>") === null);
    check("xmp: empty → null", conformanceFromXmp("") === null);
    check("xmp: null → null", conformanceFromXmp(null) === null);
    check("xmp: overlong value (49+ chars) → null", conformanceFromXmp("<a:ConformanceLevel>" + "L".repeat(60) + "</a:ConformanceLevel>") === null);
    check(
      "xmp: mismatched close prefix → null",
      conformanceFromXmp("<a:ConformanceLevel>BASIC</b:ConformanceLevel>") === null
    );
  }

  /* ================================================================== */
  console.log("── 13. REAL E2E — XML mode (self-shimmed worker) ─────────");
  /* ================================================================== */

  /* The self shim (publisher smoke pattern) + the /pdfjs Bun module
   * plugin, so the REAL worker — including its pdf.js PDF path — runs
   * headless in bun. */
  const messages: WorkerResponse[] = [];
  const workerGlobal = globalThis as unknown as {
    postMessage: (msg: unknown) => void;
    onmessage: ((event: { data: WorkerRunRequest }) => void) | null;
    location: { href: string };
  };
  workerGlobal.postMessage = (msg: unknown): void => {
    messages.push(msg as WorkerResponse);
  };
  workerGlobal.location = { href: "http://localhost/" };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;

  /* The Bun plugin maps the worker-lib's "/pdfjs/*" URL imports onto
   * public/pdfjs (a custom namespace + onLoad — the only form that
   * works for runtime URL imports under bun). */
  interface PluginOnResolveArgs {
    path: string;
    importer: string;
  }
  interface PluginBuilder {
    onResolve(
      options: { filter: RegExp },
      cb: (args: PluginOnResolveArgs) => { path: string; namespace: string }
    ): void;
    onLoad(
      options: { filter: RegExp; namespace?: string },
      cb: (args: { path: string; namespace: string }) => {
        contents: string;
        loader: string;
      }
    ): void;
  }
  const bunModuleName = "bun";
  const { plugin } = (await import(bunModuleName)) as {
    plugin: (opts: { name: string; setup(build: PluginBuilder): void }) => void;
  };
  plugin({
    name: "pdfjs-root-map",
    setup(build) {
      build.onResolve({ filter: /^\/pdfjs\// }, (args) => ({
        path: fileURLToPath(new URL(`../public${args.path}`, import.meta.url)),
        namespace: "pdfjs-public",
      }));
      build.onLoad({ filter: /.*/, namespace: "pdfjs-public" }, (args) => ({
        contents: readFileSync(args.path, "utf8"),
        loader: "js",
      }));
    },
  });

  await import("../tools/validate-e-invoice/worker");
  check("worker: module loaded, onmessage registered", typeof workerGlobal.onmessage === "function");

  const drive = async (
    runId: number,
    files: File[],
    run = ""
  ): Promise<WorkerResponse> => {
    const before = messages.length;
    workerGlobal.onmessage!({
      data: {
        type: "run",
        runId,
        toolId: "validate-e-invoice",
        options: { run },
        files,
      } as WorkerRunRequest,
    });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const hit = messages
        .slice(before)
        .find(
          (m) =>
            m.runId === runId &&
            (m.type === "result" || m.type === "error")
        );
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) throw new Error(`worker run ${runId} did not finish`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  const blobText = async (b: Blob): Promise<string> =>
    new TextDecoder().decode(new Uint8Array(await b.arrayBuffer()));

  {
    /* the golden path: the valid sample through the REAL worker */
    const res = await drive(101, [
      new File([enc.encode(buildCii()) as BlobPart], "sample-invoice.xml"),
    ]);
    check("xml run: result", res.type === "result", res);
    if (res.type === "result") {
      const out = res.outputs[0]!;
      check("xml run: output name", out.name === "sample-invoice-validation-report.txt", out.name);
      check("xml run: text mime", out.mime === "text/plain;charset=utf-8");
      const d = (res.detail ?? {}) as Record<string, unknown>;
      check(
        "xml run: detail verdict/counts/mode",
        d.verdict === "pass" && d.checksPassed === 13 && d.checksWarned === 0 && d.checksFailed === 0 && d.inputMode === "xml" && d.lineCount === 2,
        d
      );
      const report = d.report as
        | { verdict: string; checks: Check[]; totals: Record<string, string | null> }
        | undefined;
      check(
        "xml run: the full check list rides the detail",
        report?.checks.map((c) => c.id).join(",") ===
          "root,context,docId,docDate,typeCode,seller,buyer,lines,sumLines,grand,due,taxes,currency" &&
          report.checks.every((c) => c.status === "pass"),
        report?.checks.map((c) => c.id)
      );
      check(
        "xml run: totals in the detail",
        report?.totals.taxBasis === "2500.00" && report?.totals.grandTotal === "2975.00" && report?.totals.due === "2475.00",
        report?.totals
      );
      const text = await blobText(out.blob);
      check("xml run: report verdict line", text.includes("VERDICT: PASS"));
      check("xml run: report first check row", text.includes("[PASS] Root element is CrossIndustryInvoice (CII)"));
      check("xml run: report honesty footer", text.includes("NOT CHECKED (honesty)"));
      check("xml run: report totals table", text.includes("2975.00   GrandTotalAmount"));
      check("xml run: report input line", text.includes("Input: CII XML (direct)"));
    }
    const pcts = messages
      .filter((m) => m.type === "progress")
      .map((m) => (m as { pct: number }).pct);
    check("xml run: progress posted", pcts.includes(15) && pcts.includes(40) && pcts.includes(80), pcts);

    /* Hindi labels flow through options.run (the create-invoice precedent) */
    const hiRes = await drive(
      102,
      [new File([enc.encode(buildCii()) as BlobPart], ".xml")],
      JSON.stringify({
        locale: "hi",
        fileWord: "दस्तावेज़",
        labels: {
          "vei.title": "ई-इनवॉइस वैलिडेशन रिपोर्ट",
          "vei.kRoot": "रूट एलिमेंट CrossIndustryInvoice (CII) है",
          "vei.vPass": "पास",
        },
      })
    );
    check("hi run: result", hiRes.type === "result", hiRes);
    if (hiRes.type === "result") {
      check(
        "hi run: nameless file falls back to the localized word",
        hiRes.outputs[0]!.name === "दस्तावेज़-validation-report.txt",
        hiRes.outputs[0]!.name
      );
      const text = await blobText(hiRes.outputs[0]!.blob);
      check("hi run: Hindi title in the report", text.includes("MyCloudy — ई-इनवॉइस वैलिडेशन रिपोर्ट"), text.slice(0, 120));
      check("hi run: Hindi check row", text.includes("[PASS] रूट एलिमेंट CrossIndustryInvoice (CII) है"));
      check("hi run: Hindi verdict word", text.includes("VERDICT: पास"));
      check("hi run: untranslated keys fall back to English", text.includes("TOTALS RECONCILIATION"));
    }

    /* UTF-16 encoded XML files (decodeXmlText's BOM branches, end to end) */
    const leRes = await drive(103, [
      new File([toUtf16(buildCii(), true) as BlobPart], "utf16le.xml"),
    ]);
    check("utf-16le run: result", leRes.type === "result", leRes);
    if (leRes.type === "result") {
      const d = (leRes.detail ?? {}) as Record<string, unknown>;
      check("utf-16le run: verdict pass (BOM sniff + decode)", d.verdict === "pass" && d.checksPassed === 13, d);
    }
    const beRes = await drive(104, [
      new File([toUtf16(buildCii(), false) as BlobPart], "utf16be.xml"),
    ]);
    check("utf-16be run: result", beRes.type === "result", beRes);
    if (beRes.type === "result") {
      const d = (beRes.detail ?? {}) as Record<string, unknown>;
      check("utf-16be run: verdict pass (BOM sniff + decode)", d.verdict === "pass" && d.checksPassed === 13, d);
    }

    /* prolog-only XML: parses to nothing → honest errXmlParse */
    const prologRes = await drive(105, [
      new File([latin1('<?xml version="1.0" encoding="UTF-8"?>') as BlobPart], "empty.xml"),
    ]);
    check(
      "prolog-only xml → vei.errXmlParse",
      prologRes.type === "error" && prologRes.code === "vei.errXmlParse",
      prologRes
    );

    /* plain text → not xml */
    const txtRes = await drive(106, [
      new File([latin1("hello plain text file") as BlobPart], "notes.txt"),
    ]);
    check(
      "plain text → vei.errNotXml with the file name as detail",
      txtRes.type === "error" && txtRes.code === "vei.errNotXml" && txtRes.detail === "notes.txt",
      txtRes
    );

    /* binary noise → not xml */
    const noise = new Uint8Array(2048);
    for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 31 + 7) & 0xff;
    const noiseRes = await drive(107, [new File([noise as BlobPart], "blob.bin")]);
    check("binary noise → vei.errNotXml", noiseRes.type === "error" && noiseRes.code === "vei.errNotXml", noiseRes);

    /* no file at all */
    const noFileRes = await drive(108, []);
    check("no file → tool.errorGeneric", noFileRes.type === "error" && noFileRes.code === "tool.errorGeneric", noFileRes);

    /* non-run messages are ignored */
    const beforeCount = messages.length;
    workerGlobal.onmessage!({ data: { type: "nope" } as never });
    await new Promise((r) => setTimeout(r, 30));
    check("non-run messages ignored", messages.length === beforeCount);

    /* the 20 MB sanity gate */
    const big =
      '<?xml version="1.0"?>\n<!-- ' +
      "x".repeat(MAX_INPUT_BYTES + 1024) +
      " -->";
    check("fixture: over the gate", enc.encode(big).length > MAX_INPUT_BYTES);
    const bigRes = await drive(109, [new File([enc.encode(big) as BlobPart], "huge.xml")]);
    check(
      "over 20 MB → vei.errTooBig",
      bigRes.type === "error" && bigRes.code === "vei.errTooBig",
      bigRes
    );
  }

  /* ================================================================== */
  console.log("── 14. REAL E2E — PDF mode (pdf-lib attach + pdf.js) ─────");
  /* ================================================================== */
  {
    const buildPdf = async (
      cii: string | null,
      opts: { names?: string[]; xmp?: string } = {}
    ): Promise<Uint8Array> => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([612, 792]);
      page.drawText("Factur-X smoke fixture", { x: 72, y: 700, size: 12, font });
      for (const name of opts.names ?? []) {
        await doc.attach(enc.encode(cii ?? "<a/>"), name, {
          mimeType: "text/xml",
          description: "embedded XML",
          creationDate: new Date(2026, 1, 15),
          modificationDate: new Date(2026, 1, 15),
        });
      }
      if (opts.xmp !== undefined) {
        const dict = doc.context.obj({ Type: "Metadata", Subtype: "XML" });
        const stream = PDFRawStream.of(dict, enc.encode(opts.xmp));
        doc.catalog.set(PDFName.of("Metadata"), doc.context.register(stream));
      }
      return new Uint8Array(await doc.save());
    };

    const XMP = (claim: string): string =>
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa">' +
      "<fx:DocumentType>INVOICE</fx:DocumentType>" +
      `<fx:ConformanceLevel>${claim}</fx:ConformanceLevel>` +
      "</rdf:Description></rdf:RDF></x:xmpmeta>";

    /* the golden PDF path: factur-x.xml attachment, extracted by pdf.js */
    const bytes = await buildPdf(buildCii(), { names: ["factur-x.xml"] });
    const res = await drive(201, [new File([bytes as BlobPart], "factur.pdf")]);
    check("pdf run: result", res.type === "result", res);
    if (res.type === "result") {
      const d = (res.detail ?? {}) as Record<string, unknown>;
      check(
        "pdf run: mode + attachment + verdict + 13 checks",
        d.inputMode === "pdf" && d.attachmentName === "factur-x.xml" && d.verdict === "pass" && d.checksPassed === 13 && d.checksFailed === 0,
        d
      );
      check("pdf run: no XMP claim without metadata", d.xmpClaim === undefined, d.xmpClaim);
      const text = await blobText(res.outputs[0]!.blob);
      check("pdf run: report names the embedded source", text.includes("Input: PDF — embedded XML extracted — factur-x.xml"), text.slice(0, 200));
      check("pdf run: no conformance row without a claim", !text.includes("ConformanceLevel"));
      check("pdf run: checks ran on the EXTRACTED xml (invoice id present)", text.includes("INV-2026-042"));
    }

    /* generic .xml fallback name */
    const fbBytes = await buildPdf(buildCii(), { names: ["invoice-data.xml"] });
    const fbRes = await drive(202, [new File([fbBytes as BlobPart], "fallback.pdf")]);
    check("fallback run: result", fbRes.type === "result", fbRes);
    if (fbRes.type === "result") {
      check(
        "any embedded .xml picked by the fallback",
        (fbRes.detail as Record<string, unknown>)?.attachmentName === "invoice-data.xml",
        (fbRes.detail as Record<string, unknown>)?.attachmentName
      );
    }

    /* priority: zugferd-invoice.xml beats a lower-sorting invoice.xml */
    const prioBytes = await buildPdf(buildCii(), {
      names: ["invoice.xml", "zugferd-invoice.xml"],
    });
    const prioRes = await drive(203, [new File([prioBytes as BlobPart], "prio.pdf")]);
    check("priority run: result", prioRes.type === "result", prioRes);
    if (prioRes.type === "result") {
      check(
        "zugferd-invoice.xml wins over invoice.xml",
        (prioRes.detail as Record<string, unknown>)?.attachmentName === "zugferd-invoice.xml",
        (prioRes.detail as Record<string, unknown>)?.attachmentName
      );
    }

    /* uppercase preferred name (case-insensitive match) */
    const upBytes = await buildPdf(buildCii(), { names: ["FACTUR-X.XML"] });
    const upRes = await drive(204, [new File([upBytes as BlobPart], "upper.pdf")]);
    if (upRes.type === "result") {
      check(
        "FACTUR-X.XML matched case-insensitively",
        (upRes.detail as Record<string, unknown>)?.attachmentName === "FACTUR-X.XML",
        (upRes.detail as Record<string, unknown>)?.attachmentName
      );
    } else {
      check("uppercase run: result", false, upRes);
    }

    /* XMP conformance cross-check, consistent case (claim ≤ contents) */
    const okXmpBytes = await buildPdf(buildCii(), {
      names: ["factur-x.xml"],
      xmp: XMP("BASIC"),
    });
    const okXmpRes = await drive(205, [new File([okXmpBytes as BlobPart], "claim-ok.pdf")]);
    check("xmp consistent: result", okXmpRes.type === "result", okXmpRes);
    if (okXmpRes.type === "result") {
      const d = (okXmpRes.detail ?? {}) as Record<string, unknown>;
      const report = d.report as { checks: Check[] } | undefined;
      const conf = report?.checks.find((c) => c.id === "conformance");
      check(
        "xmp consistent: 14 checks, conformance pass",
        d.checksPassed === 14 && d.verdict === "pass" && d.xmpClaim === "BASIC",
        d
      );
      check(
        "xmp consistent: nConfLower with both sides named",
        conf?.status === "pass" && conf?.expected === "BASIC (XMP)" && conf?.actual === "EN 16931 (XML)" && conf?.note === "vei.nConfLower",
        conf
      );
      const text = await blobText(okXmpRes.outputs[0]!.blob);
      check("xmp consistent: report carries the claim line", text.includes("XMP conformance claim: BASIC"));
    }

    /* XMP conformance cross-check, mismatch (claim above contents) */
    const mmBytes = await buildPdf(buildCii({ buyerReference: null }), {
      names: ["factur-x.xml"],
      xmp: XMP("EN 16931"),
    });
    const mmRes = await drive(206, [new File([mmBytes as BlobPart], "claim-high.pdf")]);
    check("xmp mismatch: result", mmRes.type === "result", mmRes);
    if (mmRes.type === "result") {
      const d = (mmRes.detail ?? {}) as Record<string, unknown>;
      const report = d.report as { checks: Check[] } | undefined;
      const conf = report?.checks.find((c) => c.id === "conformance");
      check(
        "xmp mismatch: verdict warnings, conformance the only warn",
        d.verdict === "warnings" && d.checksWarned === 1 && d.checksFailed === 0,
        d
      );
      check(
        "xmp mismatch: exact expected/actual strings",
        conf?.status === "warn" && conf?.note === "vei.nConfMismatch" && conf?.expected === "EN 16931 (XMP)" && conf?.actual === "BASIC (XML)",
        conf
      );
    }

    /* PDF with NO attachment at all */
    const noneBytes = await buildPdf(buildCii(), {});
    const noneRes = await drive(207, [new File([noneBytes as BlobPart], "bare.pdf")]);
    check(
      "no attachment → vei.errNoAttachment, empty detail",
      noneRes.type === "error" && noneRes.code === "vei.errNoAttachment" && (noneRes.detail ?? "") === "",
      noneRes
    );

    /* PDF with only a non-XML attachment */
    const txtOnlyBytes = await buildPdf(null, { names: ["readme.txt"] });
    const txtOnlyRes = await drive(208, [new File([txtOnlyBytes as BlobPart], "readme.pdf")]);
    check(
      "non-xml-only attachments → vei.errNoAttachment, names in detail",
      txtOnlyRes.type === "error" && txtOnlyRes.code === "vei.errNoAttachment" && txtOnlyRes.detail === "readme.txt",
      txtOnlyRes
    );
  }

  /* ================================================================== */
  console.log("── 15. REAL E2E — honest rejections ──────────────────────");
  /* ================================================================== */
  {
    /* encrypted PDF (validate is not crack) */
    const encDoc = await CantooPDF.create();
    encDoc.addPage([300, 300]);
    await encDoc.encrypt({ userPassword: "secret", algorithm: "AES-256" });
    const encBytes = new Uint8Array(await encDoc.save({ useObjectStreams: false }));
    const encRes = await drive(301, [new File([encBytes as BlobPart], "locked.pdf")]);
    check(
      "encrypted PDF → tool.errorEncrypted",
      encRes.type === "error" && encRes.code === "tool.errorEncrypted",
      encRes
    );

    /* %PDF- prefixed garbage: sniffs pdf, pdf.js refuses it */
    const junkRes = await drive(302, [
      new File([latin1("%PDF-1.7\nnot really a pdf, just bytes that look like one\n") as BlobPart], "garbage.pdf"),
    ]);
    check(
      "%PDF- garbage → tool.errorCorrupt",
      junkRes.type === "error" && junkRes.code === "tool.errorCorrupt",
      junkRes
    );
  }

  /* ================================================================== */
  console.log("── 16. config + i18n sanity ──────────────────────────────");
  /* ================================================================== */
  {
    const { config } = await import("../tools/validate-e-invoice/config");
    check("config toolId", config.toolId === "validate-e-invoice");
    check("config outputKind text", config.outputKind === "text");
    check("config single-file tool", config.minFiles === 1 && config.maxFiles === 1);
    check(
      "config howKeys are vei.*",
      (config.howKeys ?? []).length === 3 && (config.howKeys ?? []).every((k) => k.startsWith("vei.")),
      config.howKeys
    );
    check(
      "config chains to the sibling invoice tools",
      (config.chainToolIds ?? []).includes("xml-invoice-to-pdf") && (config.chainToolIds ?? []).includes("pdf-to-e-invoice"),
      config.chainToolIds
    );
    check(
      "config features bilingual",
      config.features.length >= 5 && config.features.every((f) => f.en.length > 0 && f.hi.length > 0)
    );
    check(
      "config faq bilingual",
      config.faq.length >= 4 && config.faq.every((q) => q.q.en.length > 0 && q.q.hi.length > 0 && q.a.en.length > 0 && q.a.hi.length > 0)
    );

    /* tool i18n leaf parity */
    const i18n = JSON.parse(
      readFileSync("tools/validate-e-invoice/i18n.json", "utf8")
    ) as {
      en: { vei: Record<string, string> };
      hi: { vei: Record<string, string> };
    };
    const enKeys = Object.keys(i18n.en.vei).sort();
    const hiKeys = Object.keys(i18n.hi.vei).sort();
    check(
      "tool i18n en/hi leaf parity (vei.*)",
      JSON.stringify(enKeys) === JSON.stringify(hiKeys) && enKeys.length >= 100,
      { en: enKeys.length, hi: hiKeys.length }
    );
    check(
      "tool i18n no empty values",
      Object.values(i18n.en.vei).every((v) => v.trim().length > 0) &&
        Object.values(i18n.hi.vei).every((v) => v.trim().length > 0)
    );

    /* every key the model's report builder knows resolves */
    const labelKeys = Object.keys(REPORT_LABELS_EN);
    check(
      "REPORT_LABELS_EN keys all resolve in en+hi",
      labelKeys.every((k) => k.replace(/^vei\./, "") in i18n.en.vei && k.replace(/^vei\./, "") in i18n.hi.vei),
      labelKeys.filter((k) => !(k.replace(/^vei\./, "") in i18n.en.vei) || !(k.replace(/^vei\./, "") in i18n.hi.vei))
    );

    /* every key the surface references resolves */
    const surfaceSrc = readFileSync("tools/validate-e-invoice/surface.tsx", "utf8");
    const used = new Set<string>();
    for (const m of surfaceSrc.matchAll(/t\("vei\.([A-Za-z0-9]+)"/g)) used.add(`vei.${m[1]}`);
    used.add("vei.stPass");
    used.add("vei.stWarn");
    used.add("vei.stFail");
    const reportKeysBlock = /const REPORT_KEYS = \[([\s\S]*?)\] as const;/.exec(surfaceSrc);
    const reportKeys = reportKeysBlock
      ? [...reportKeysBlock[1].matchAll(/"([A-Za-z0-9]+)"/g)].map((m) => `vei.${m[1]}`)
      : [];
    for (const k of reportKeys) used.add(k);
    for (const k of config.howKeys ?? []) used.add(k);
    const missing = [...used].filter((k) => !(k.replace(/^vei\./, "") in i18n.en.vei));
    check("every vei.* key the surface/config references resolves", missing.length === 0, missing);
    check(
      "the surface's REPORT_KEYS match the model's REPORT_LABELS_EN exactly",
      reportKeys.length > 0 &&
        reportKeys.slice().sort().join(",") === labelKeys.slice().sort().join(","),
      { reportKeys: reportKeys.length, labelKeys: labelKeys.length }
    );

    /* worker error codes resolve */
    const workerSrc = readFileSync("tools/validate-e-invoice/worker.ts", "utf8");
    const errCodes = [...workerSrc.matchAll(/"vei\.(err[A-Za-z]+)"/g)].map((m) => m[1]);
    check(
      "worker vei.* error codes resolve in the tool i18n",
      ["errNotXml", "errNoAttachment", "errXmlParse", "errTooBig"].every((c) => errCodes.includes(c)) &&
        errCodes.every((c) => c in i18n.en.vei),
      errCodes
    );
    const catalogEn = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as Record<string, unknown>;
    const toolNs = catalogEn.tool as Record<string, unknown> | undefined;
    check(
      "shared tool.* error codes exist in the merged catalog",
      toolNs !== undefined && "errorEncrypted" in toolNs && "errorCorrupt" in toolNs && "errorGeneric" in toolNs
    );
  }

  console.log(
    `\nvalidate-e-invoice smoke: ${pass} passed, ${fail} failed` +
      (fail ? "\n  " + failures.join("\n  ") : " — ALL GREEN")
  );
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
