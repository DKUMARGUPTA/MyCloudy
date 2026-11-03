/**
 * PRE-BUILD smoke test for xml-invoice-to-pdf (P10, the 71st tool).
 *
 *  1. XML PARSER (xml.ts): elements, nesting, attributes, entity
 *     decoding (built-in + decimal + hex, incl. ₹ U+20B9), CDATA,
 *     comments, self-closing tags, arbitrary prefixes, default
 *     namespaces, DOCTYPE skip, BOM, UTF-8 multibyte, and refusals
 *     (truncated, two roots, text outside root, bad close).
 *  2. DIALECTS (engine.ts): UBL 2.1 (India GST + EU VAT + credit
 *     note) and CII (Factur-X EU + India GST) — every expected value
 *     below was derived FROM THE FIXTURE XML BY HAND before running;
 *     the five consistency checks must pass on the good files and FAIL
 *     exactly where the tampered file lies. Amounts VERBATIM.
 *  3. PDF (render.ts): drives the worker's EXACT drawing code with
 *     the self-hosted Noto font from disk — builds, %PDF magic,
 *     reloads, paginates a 45-line invoice, EN + हिंदी labels, and
 *     negative (credit-note) money still renders.
 *
 * Run: bun scripts/smoke-xml-invoice.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

import { parseXml, child, children, textOf, descendant } from "../tools/xml-invoice-to-pdf/xml";
import {
  parseEInvoice,
  formatAmount,
  formatRate,
  formatQty,
  outputBaseName,
  type EInvoice,
} from "../tools/xml-invoice-to-pdf/engine";
import { drawEInvoice, type EInvoiceLabels } from "../tools/xml-invoice-to-pdf/render";

let failures = 0;
let passes = 0;
function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`  FAIL ${what}\n    expected ${e}\n    actual   ${a}`);
  } else {
    passes++;
  }
}
function ok(v: boolean, what: string): void {
  eq(v, true, what);
}
function throws(fn: () => unknown, what: string): void {
  try {
    fn();
    failures++;
    console.error(`  FAIL ${what}: did not throw`);
  } catch (e) {
    if (e instanceof Error && e.message === "xinv.errorXml") passes++;
    else {
      failures++;
      console.error(`  FAIL ${what}: wrong error ${String(e)}`);
    }
  }
}

const FIX = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(`public/qa/einv-fixtures/${name}`));

/* ================================================================== */
console.log("Part 1 — XML parser");
/* ================================================================== */

{
  const doc = parseXml(new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?><!-- c --><a xmlns="urn:a" x="1"><b>B</b><c/>t1<t:d xmlns:t="urn:t" y="&amp;&lt;&gt;&#8377;&#x20B9;">2</t:d><![CDATA[<raw&>]]>t2</a>`
  ));
  eq(doc.name, "a", "root local name");
  eq(doc.ns, "urn:a", "default namespace");
  eq(doc.attrs["x"], "1", "unprefixed attribute");
  eq(textOf(doc, "urn:a", "b"), "B", "nested child text");
  eq(children(doc, "urn:a", "b").length, 1, "children() count");
  const td = child(doc, "urn:t", "d");
  ok(td !== undefined, "prefixed child found by ns");
  eq(td?.attrs["y"], "€₹".slice(0, 0) + "&<>₹₹", "entity + numeric decoding");
  eq(doc.text, "t1<raw&>t2", "concatenated text nodes (CDATA raw + gaps)");
}

{
  // BOM + multibyte + attribute with entities + self-closing content.
  const src = "﻿<r xmlns:u=\"urn:u\"><u:s name=\"नाम &amp; नंबर\">मुझे ₹1,234 चाहिए</u:s><u:e/></r>";
  const doc = parseXml(new TextEncoder().encode(src));
  const s = child(doc, "urn:u", "s");
  eq(s?.text, "मुझे ₹1,234 चाहिए", "BOM + Devanagari + ₹ survive");
  eq(s?.attrs["name"], "नाम & नंबर", "attribute entity decoded");
  ok(child(doc, "urn:u", "e") !== undefined, "self-closing prefixed tag");
}

{
  const doc = parseXml(new TextEncoder().encode(
    `<!DOCTYPE Invoice [ <!ENTITY x "y"> ]><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/>`
  ));
  eq(doc.name, "Invoice", "DOCTYPE with internal subset skipped");
}

throws(() => parseXml(new TextEncoder().encode("<a><b></a>")), "mismatched close");
throws(() => parseXml(new TextEncoder().encode("<a>")), "unclosed");
throws(() => parseXml(new TextEncoder().encode("junk<a/>")), "text before root");
throws(() => parseXml(new TextEncoder().encode("<a/><b/>")), "two roots");
throws(() => parseXml(new TextEncoder().encode("<a x='1>")), "unterminated attr");
throws(() => parseXml(new TextEncoder().encode("")), "empty input");

/* ================================================================== */
console.log("Part 2 — UBL / CII dialects (fixtures, hand-derived)");
/* ================================================================== */

function checkAll(inv: EInvoice, expected: Record<string, boolean>, what: string): void {
  for (const [key, want] of Object.entries(expected)) {
    const got = inv.checks.find((c) => c.key === key)?.ok;
    eq(got, want, `${what}: check ${key}`);
  }
}

{
  const inv = parseEInvoice(FIX("ubl-gst-invoice.xml"));
  eq(inv.format, "UBL", "GST fixture format");
  eq(inv.kind, "invoice", "typeCode 380 → invoice");
  eq(inv.number, "INV/25-26/001", "invoice number");
  eq(inv.issueDate, "2025-06-01", "issue date");
  eq(inv.dueDate, "2025-06-15", "due date");
  eq(inv.currency, "INR", "currency");
  eq(inv.gst, true, "GSTINs detected → Indian GST flavour");
  eq(inv.seller.name, "DocoPDF Traders Pvt Ltd", "seller legal name");
  eq(inv.seller.gstin, "27AAPFU0939F1ZV", "seller GSTIN");
  ok(inv.seller.lines.some((l) => l.includes("Pune")), "seller city in address");
  eq(inv.buyer.name, "Sunrise Electro Enterprises", "buyer name");
  eq(inv.buyer.gstin, "29AAGCB1234F1Z5", "buyer GSTIN");
  eq(inv.lines.length, 3, "line count");
  eq(inv.lines[0].name, "Steel Widget W-100", "line 1 name");
  eq(inv.lines[0].qty, 10, "line 1 qty");
  eq(inv.lines[0].unit, "EA", "line 1 unit");
  eq(inv.lines[0].price, 1000, "line 1 price");
  eq(inv.lines[0].amount, 10000, "line 1 amount verbatim");
  eq(inv.lines[0].vatRate, 18, "line 1 GST %");
  ok(inv.lines[0].ids.includes("8471"), "line 1 HSN captured");
  eq(inv.lines[2].vatRate, 5, "line 3 mixed rate");
  eq(inv.lineTotal, 16000, "line total verbatim");
  eq(inv.allowance, 500, "allowance verbatim");
  eq(inv.taxBasis, 15500, "tax basis verbatim");
  eq(inv.taxTotal, 2230, "tax total verbatim");
  eq(inv.grandTotal, 17730, "grand total verbatim");
  eq(inv.prepaid, 2000, "prepaid verbatim");
  eq(inv.payable, 15730, "payable verbatim");
  eq(inv.taxes.length, 2, "tax subtotals");
  eq(inv.taxes[0].amount, 1980, "18% subtotal");
  eq(inv.payment.upi, "docopdf@upi", "UPI endpoint");
  eq(inv.payment.accountId, "DOCOPDF-CURRENT-001", "bank account");
  eq(inv.notes.length, 1, "notes captured");
  checkAll(inv, { lines: true, basis: true, taxSum: true, grand: true, payable: true }, "GST fixture");
}

{
  const inv = parseEInvoice(FIX("ubl-eu-invoice.xml"));
  eq(inv.format, "UBL", "EU fixture format");
  eq(inv.currency, "EUR", "EUR");
  eq(inv.gst, false, "no GSTIN → not Indian");
  eq(inv.seller.taxId, "DE123456789", "VAT id");
  eq(inv.seller.name, "Büromöbel GmbH & Co. KG", "seller name entity-decoded");
  eq(inv.buyer.taxId, "FR0987654321", "buyer VAT id");
  eq(inv.lines.length, 2, "2 lines");
  eq(inv.lines[0].vatRate, 19, "19%");
  eq(inv.lines[1].vatRate, 7, "7% mixed");
  eq(inv.grandTotal, 279.6, "grand total");
  eq(inv.payment.accountId, "DE02120300000000202051", "IBAN");
  checkAll(inv, { lines: true, basis: true, taxSum: true, grand: true, payable: true }, "EU fixture");
}

{
  const inv = parseEInvoice(FIX("ubl-credit-note.xml"));
  eq(inv.kind, "credit-note", "typeCode 381 → credit note");
  eq(inv.lines[0].amount, -100, "negative line amount");
  eq(inv.grandTotal, -119, "negative grand total");
  eq(inv.payable, -119, "negative payable");
  checkAll(inv, { lines: true, basis: true, grand: true }, "credit note");
}

{
  const inv = parseEInvoice(FIX("cii-eu-invoice.xml"));
  eq(inv.format, "CII", "CII format detected");
  eq(inv.number, "RE-2025-00181", "CII number");
  eq(inv.issueDate, "2025-06-02", "format 102 date → ISO");
  eq(inv.dueDate, "2025-06-16", "payment-terms due date");
  eq(inv.currency, "EUR", "EUR");
  eq(inv.seller.name, "Büromöbel GmbH & Co. KG", "seller");
  eq(inv.seller.taxId, "DE123456789", "VAT from schemeID=VA");
  eq(inv.lines.length, 2, "CII lines");
  eq(inv.lines[0].qty, 2, "CII qty");
  eq(inv.lines[0].price, 95, "CII net price");
  eq(inv.lines[0].amount, 190, "CII line total");
  eq(inv.lines[0].vatRate, 19, "CII rate");
  eq(inv.taxes.length, 2, "CII tax breakdown");
  eq(inv.taxes[1].rate, 7, "second rate");
  eq(inv.grandTotal, 279.6, "CII grand total");
  eq(inv.payment.accountId, "DE02120300000000202051", "CII IBAN");
  eq(inv.payment.accountName, "Kontokorrent", "CII account name");
  checkAll(inv, { lines: true, basis: true, taxSum: true, grand: true, payable: true }, "CII EU fixture");
}

{
  const inv = parseEInvoice(FIX("cii-gst-invoice.xml"));
  eq(inv.gst, true, "CII GSTIN detection");
  eq(inv.seller.gstin, "27AAPFU0939F1ZV", "CII seller GSTIN via schemeID=IN");
  eq(inv.currency, "INR", "CII INR");
  eq(inv.taxes[0].amount, 180, "CII GST amount");
  eq(inv.grandTotal, 1180, "CII grand total");
  eq(inv.lines[0].qtyText, "4", "CII qty text");
  eq(inv.lines[0].unit, "HUR", "CII unit code");
  checkAll(inv, { lines: true, basis: true, taxSum: true, grand: true, payable: true }, "CII GST fixture");
}

{
  const inv = parseEInvoice(FIX("tampered-totals.xml"));
  // Hand-checked math: lines sum 16000.00 but the file claims 16000.01
  // (lines FAIL); 16000.01 − 500 ≠ 15500 (basis FAIL); 15500 + 2230 =
  // 17730 ≠ 17731 (grand FAIL); 17731 − 0 = 17731 (payable itself is
  // consistent — it agrees with the (wrong) grand total).
  checkAll(
    inv,
    { lines: false, basis: false, taxSum: true, grand: false, payable: true },
    "tampered fixture (lies caught)"
  );
}

try {
  parseEInvoice(FIX("broken-truncated.xml"));
  failures++;
  console.error("  FAIL truncated fixture: did not throw");
} catch (e) {
  eq(e instanceof Error ? e.message : "", "xinv.errorXml", "truncated fixture refusal");
  passes++;
}
try {
  parseEInvoice(FIX("not-an-invoice.xml"));
  failures++;
  console.error("  FAIL not-an-invoice fixture: did not throw");
} catch (e) {
  eq(e instanceof Error ? e.message : "", "xinv.errorNotInvoice", "wrong-root refusal");
  passes++;
}

/* ------------------------- formatting ------------------------------ */
{
  const inv = parseEInvoice(FIX("ubl-gst-invoice.xml"));
  eq(formatAmount(inv, 17730), "₹17,730.00", "INR en-IN grouping + symbol");
  eq(formatRate(19), "19%", "rate 19");
  eq(formatRate(19.5), "19.5%", "rate 19.5");
  eq(formatRate(null), "—", "rate null");
  eq(formatQty({ ...inv.lines[0], unit: "HUR", qtyText: "4" } as never), "4 h", "HUR → h");
  eq(formatQty({ ...inv.lines[0], unit: "" } as never), "10", "no unit → bare qty");
  eq(formatQty({ ...inv.lines[0], unit: "ZZZ" } as never), "10 ZZZ", "unknown unit → raw code");
  eq(outputBaseName(inv), "INV-25-26-001", "output name sanitized");
  const invEur = parseEInvoice(FIX("ubl-eu-invoice.xml"));
  eq(formatAmount(invEur, 279.6), "279.60 €", "EUR suffix style");
}

/* ================================================================== */
console.log("Part 3 — PDF render (worker's exact drawing code)");
/* ================================================================== */

const fontBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);

const EN_LABELS: EInvoiceLabels = {
  title: "e-Invoice (UBL 2.1)",
  seller: "From",
  buyer: "Bill to",
  number: "Invoice no.",
  date: "Issue date",
  due: "Due date",
  currency: "Currency",
  buyerRef: "Buyer ref.",
  orderRef: "Order no.",
  taxId: "Tax ID",
  gstin: "GSTIN",
  hash: "#",
  desc: "Description",
  qty: "Qty",
  price: "Unit price",
  taxCol: "Tax %",
  amt: "Amount",
  sub: "Subtotal",
  allowance: "Allowance",
  charge: "Charge",
  basis: "Taxable amount",
  taxBreakdown: "Tax breakdown",
  rate: "Rate",
  category: "Category",
  base: "Base",
  taxTotal: "Total tax",
  rounding: "Rounding",
  grand: "Grand total",
  prepaid: "Prepaid",
  payable: "Balance due",
  payment: "Payment",
  account: "Account",
  upi: "UPI ID",
  notes: "Notes",
  terms: "Terms",
  wordsLabel: "Amount in words:",
  checksOk: "Totals verified",
  checksFail: "Inconsistent totals in the source file",
  footerNote: "Amounts are shown exactly as stated in the source XML — nothing was recalculated.",
};

const HI_LABELS: EInvoiceLabels = {
  ...EN_LABELS,
  title: "ई-इनवॉइस (UBL 2.1)",
  seller: "प्रेषक",
  buyer: "प्राप्तकर्ता",
  number: "इनवॉइस सं.",
  date: "जारी तारीख़",
  due: "देय तारीख़",
  currency: "मुद्रा",
  desc: "विवरण",
  qty: "मात्रा",
  price: "इकाई मूल्य",
  taxCol: "कर %",
  amt: "रकम",
  sub: "उप-योग",
  basis: "कर योग्य राशि",
  taxBreakdown: "कर विवरण",
  rate: "दर",
  category: "श्रेणी",
  base: "आधार",
  taxTotal: "कुल कर",
  grand: "कुल योग",
  prepaid: "अग्रिम",
  payable: "शेष देय",
  payment: "भुगतान",
  account: "खाता",
  notes: "टिप्पणियाँ",
  terms: "शर्तें",
  wordsLabel: "शब्दों में राशि:",
  footerNote: "रकम स्रोत XML में जैसी लिखी है वैसी ही है — कुछ भी दोबारा गणना नहीं हुई।",
};

async function renderAndCheck(
  name: string,
  inv: EInvoice,
  labels: EInvoiceLabels,
  minPages: number
): Promise<void> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  await drawEInvoice(doc, font, inv, labels, "#0b6b4d");
  const bytes = await doc.save();
  const reloaded = await PDFDocument.load(bytes);
  const pages = reloaded.getPageCount();
  ok(
    bytes.length > 1000 && bytes[0] === 0x25 && bytes[1] === 0x50,
    `${name}: %PDF magic + non-trivial size (${bytes.length} B)`
  );
  ok(pages >= minPages, `${name}: ${pages} page(s) ≥ ${minPages}`);
  console.log(`  ok  ${name}: ${pages} page(s), ${(bytes.length / 1024).toFixed(1)} KB`);
}

async function main(): Promise<void> {
  await renderAndCheck("GST EN sheet", parseEInvoice(FIX("ubl-gst-invoice.xml")), EN_LABELS, 1);
  await renderAndCheck("GST HI sheet", parseEInvoice(FIX("ubl-gst-invoice.xml")), HI_LABELS, 1);
  await renderAndCheck("EU EN sheet", parseEInvoice(FIX("ubl-eu-invoice.xml")), EN_LABELS, 1);
  await renderAndCheck("CII HI sheet", parseEInvoice(FIX("cii-eu-invoice.xml")), HI_LABELS, 1);
  await renderAndCheck("credit note (negative)", parseEInvoice(FIX("ubl-credit-note.xml")), EN_LABELS, 1);
  await renderAndCheck("tampered (still renders)", parseEInvoice(FIX("tampered-totals.xml")), EN_LABELS, 1);

  // Pagination: a 45-line invoice must flow onto multiple pages.
  const big = parseEInvoice(FIX("ubl-gst-invoice.xml"));
  big.lines = Array.from({ length: 45 }, (_, i) => ({
    ...big.lines[0],
    id: String(i + 1),
    name: `Long product name number ${i + 1} with extra words to wrap`,
    note: i % 3 === 0 ? "Fragile — handle with care during transport" : "",
  }));
  await renderAndCheck("45-line pagination", big, EN_LABELS, 2);

  // Zero-line minimal invoice still renders (parties + totals only).
  const minimal = parseEInvoice(FIX("ubl-gst-invoice.xml"));
  minimal.lines = [];
  await renderAndCheck("zero-line minimal", minimal, EN_LABELS, 1);

  console.log(
    `\n${failures === 0 ? "ALL GREEN" : "FAILURES"}: ${passes} passed, ${failures} failed`
  );
  if (failures > 0) process.exit(1);
}

void main();
