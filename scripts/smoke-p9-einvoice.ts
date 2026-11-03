/**
 * P9 batch 5 smoke: einvoice-common — CII generation round-trip,
 * minixml walker, CII/UBL parsing, validation rules, pdf-lib
 * attachment extraction. Run: bun scripts/smoke-p9-einvoice.ts
 */
import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";

import { calc, type InvoiceState } from "../tools/create-invoice/model";
import { amt, buildCiiXml, ciiDate, esc } from "../tools/einvoice-common/cii";
import {
  looksLikeXml,
  xmlDialect,
  xmlTag,
  xmlTags,
} from "../tools/einvoice-common/minixml";
import {
  parseInvoiceXml,
  validateEInvoiceXml,
} from "../tools/einvoice-common/parse";
import { extractInvoiceFields } from "../tools/einvoice-common/extract";
import { attachXmlToPdf } from "../tools/einvoice-common/embed";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/* ------------------------- cii.ts ------------------------- */
console.log("cii.ts");

check("esc", esc(`<a b="c">&d`) === "&lt;a b=&quot;c&quot;&gt;&amp;d");
check("ciiDate iso", ciiDate("2026-10-20") === "20261020");
check("ciiDate junk", ciiDate("n/a") === "");
check("amt paise→major", amt(12345) === "123.45");
check("amt negative", amt(-500) === "-5.00");

function sampleState(): InvoiceState {
  return {
    ty: "gst-invoice",
    cur: "INR",
    biz: {
      name: "Sharma Traders",
      addr: "12 MG Road\nBengaluru 560001",
      gstin: "29ABCDE1234F1Z5",
      state: "29",
      phone: "+91 98450 00000",
      email: "billing@sharmatraders.example",
      bank: "HDFC 50100234567890",
      upi: "sharma@hdfcbank",
      logo: "",
      sig: "",
    },
    cli: {
      name: "Verma & Sons",
      addr: "4 Lake View\nPune 411001",
      gstin: "27PQRSX6789K1Z2",
      state: "27",
    },
    pos: "27",
    no: "INV-2026-042",
    date: "2026-10-20",
    due: "2026-11-19",
    valid: "",
    dMode: "f",
    d: "100",
    tr: "18",
    ro: true,
    adv: "5000",
    st: "",
    notes: "Thank you for your business.",
    terms: "Due in 30 days.",
    xv: ["", "", ""],
    items: [
      { d: "Steel bracket", h: "7325", q: "4", r: "250", g: "18" },
      { d: "Copper wire 2m", h: "8544", q: "10", r: "80.50", g: "18" },
      { d: "Manual labour", h: "9985", q: "1", r: "1200", g: "0" },
    ],
  };
}

const s = sampleState();
const c = calc(s);
const xml = buildCiiXml(s, c);
check("xml declares CII root", xml.includes("<rsm:CrossIndustryInvoice"));
check("guideline facturx", xml.includes("urn:factur-x.eu:Factur-X:1.0"));
check("xrechnung profile", buildCiiXml(s, c, "xrechnung").includes("xrechnung_3.0"));
check("invoice id", xml.includes("<ram:ID>INV-2026-042</ram:ID>"));
check("typecode 380", xml.includes("<ram:TypeCode>380</ram:TypeCode>"));
check("issue date 102", xml.includes(">20261020</udt:DateTimeString>"));
check("due date 102", xml.includes(">20261119</udt:DateTimeString>"));
check("seller name", xml.includes("<ram:Name>Sharma Traders</ram:Name>"));
check("buyer name", xml.includes("<ram:Name>Verma &amp; Sons</ram:Name>"));
check("seller gstin VA", xml.includes("schemeID=\"VA\">29ABCDE1234F1Z5<"));
check("currency INR", xml.includes("<ram:InvoiceCurrencyCode>INR</ram:InvoiceCurrencyCode>"));
check("3 line items", (xml.match(/<ram:IncludedSupplyChainTradeLineItem>/g) ?? []).length === 3);
check("line total pre-allowance", xml.includes(`<ram:LineTotalAmount currencyID="INR">${amt(c.L[0].amt)}</ram:LineTotalAmount>`));
check("qty major", xml.includes("<ram:BilledQuantity unitCode=\"C62\">4.00</ram:BilledQuantity>"));
check("net price", xml.includes("<ram:ChargeAmount>250.00</ram:ChargeAmount>"));
check("grand total", xml.includes(`<ram:GrandTotalAmount currencyID="INR">${amt(c.tot)}</ram:GrandTotalAmount>`));
check("advance prepaid", xml.includes(`<ram:TotalPrepaidAmount currencyID="INR">${amt(c.adv)}</ram:TotalPrepaidAmount>`));
check("due payable", xml.includes(`<ram:DuePayableAmount currencyID="INR">${amt(c.bal)}</ram:DuePayableAmount>`));
check("allowance total", xml.includes(`<ram:AllowanceTotalAmount currencyID="INR">${amt(c.disc)}</ram:AllowanceTotalAmount>`));
// Tax buckets: 18% (lines 1+2) and 0% (line 3, category Z).
check("S category for 18%", /CategoryCode>S</.test(xml));
check("Z category for 0%", /CategoryCode>Z</.test(xml));
check("escaped ampersand", xml.includes("Verma &amp; Sons"));
const bucket18 = xml.match(/<ram:BasisAmount[^>]*>([\d.]+)<\/ram:BasisAmount>/g) ?? [];
check("bucket basis present", bucket18.length >= 2);

/* ------------------------- minixml ------------------------- */
console.log("minixml.ts");

const mini = `<?xml version="1.0"?>
<a:root xmlns:a="urn:x">
  <b:Name>First</b:Name>
  <c:Name>Second</c:Name>
  <other>plain</other>
  <deep><Name>nested &amp; deep</Name></deep>
  <empty/>
  <selfy attr="1"/>
</a:root>`;
check("looksLikeXml", looksLikeXml(mini) === true);
check("not xml", looksLikeXml("hello world") === false);
check("dialect cii", xmlDialect(xml) === "cii");
const ublSample = `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"></Invoice>`;
check("dialect ubl", xmlDialect(ublSample) === "ubl");
check("dialect other", xmlDialect("<foo/>") === "other");
check("first tag text", xmlTag(mini, "Name") === "First");
check("all tag texts", JSON.stringify(xmlTags(mini, "Name", undefined, 10)) === JSON.stringify(["First", "Second", "nested & deep"]));
check("plain local name", xmlTag(mini, "other") === "plain");
check("missing → empty", xmlTag(mini, "nope") === "");
check("unesc entities", xmlTags(mini, "Name")[2] === "nested & deep");

/* ------------------------- parse.ts ------------------------- */
console.log("parse.ts");

const parsed = parseInvoiceXml(xml);
check("parses back as CII", parsed.dialect === "cii");
check("invoice no round-trips", parsed.state.no === "INV-2026-042");
check("date round-trips", parsed.state.date === "2026-10-20");
check("due round-trips", parsed.state.due === "2026-11-19");
check("seller name round-trips", parsed.state.biz.name === "Sharma Traders");
check("buyer name round-trips", parsed.state.cli.name === "Verma & Sons");
check("seller gstin round-trips", parsed.state.biz.gstin === "29ABCDE1234F1Z5");
check("buyer gstin round-trips", parsed.state.cli.gstin === "27PQRSX6789K1Z2");
check("currency round-trips", parsed.state.cur === "INR");
check("items round-trip", parsed.state.items.length === 3 && parsed.state.items[0].d === "Steel bracket");
check("item qty round-trips", parsed.state.items[1].q === "10.00" || parsed.state.items[1].q === "10");

/* UBL parsing */
const ubl = `<?xml version="1.0"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>UB-77</cbc:ID>
  <cbc:IssueDate>2026-09-01</cbc:IssueDate>
  <cbc:DueDate>2026-10-01</cbc:DueDate>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>Europa GmbH</cbc:Name></cac:PartyName><cac:PartyTaxScheme><cbc:CompanyID>DE123456789</cbc:CompanyID></cac:PartyTaxScheme></cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyName><cbc:Name>Acme SA</cbc:Name></cac:PartyName></cac:Party></cac:AccountingCustomerParty>
  <cac:InvoiceLine>
    <cbc:InvoicedQuantity unitCode="C62">2</cbc:InvoicedQuantity>
    <cac:Item><cbc:Name>Widget</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount>9.90</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
  <cac:InvoiceLine>
    <cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity>
    <cac:Item><cbc:Name>Gadget</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount>25.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;
const ublParsed = parseInvoiceXml(ubl);
check("ubl dialect", ublParsed.dialect === "ubl");
check("ubl id", ublParsed.state.no === "UB-77");
check("ubl date", ublParsed.state.date === "2026-09-01");
check("ubl currency", ublParsed.state.cur === "EUR");
check("ubl seller", ublParsed.state.biz.name === "Europa GmbH");
check("ubl buyer", ublParsed.state.cli.name === "Acme SA");
check("ubl vat id", ublParsed.state.biz.gstin === "DE123456789");
check("ubl items", ublParsed.state.items.length === 2 && ublParsed.state.items[0].d === "Widget");

/* validate */
const v = validateEInvoiceXml(xml);
const vMap = new Map(v.checks.map((c2) => [c2.name, c2]));
check("validates as CII", vMap.get("XML dialect")?.status === "pass");
check("has invoice number", vMap.get("Invoice number (BT-1)")?.status === "pass");
check("has issue date", vMap.get("Issue date (BT-2)")?.status === "pass");
check("has seller", vMap.get("Seller name (BT-27)")?.status === "pass");
check("has buyer", vMap.get("Buyer name (BT-44)")?.status === "pass");
check("has currency", vMap.get("Currency (BT-5)")?.status === "pass");
check("line items pass", vMap.get("Line items (BG-25)")?.status === "pass");
check("totals add up", vMap.get("Totals add up (BT-102 + BT-110 = BT-112)")?.status === "pass");
check("no failures on our own xml", v.failed === 0, `failed=${v.failed} ${JSON.stringify(v.checks.filter((x) => x.status !== "pass"))}`);

const broken = xml
  .replace("<ram:ID>INV-2026-042</ram:ID>", "")
  .replace(/<ram:IssueDateTime>[\s\S]*?<\/ram:IssueDateTime>/, "");
const v2 = validateEInvoiceXml(broken);
check("missing id fails", v2.checks.find((x) => x.name === "Invoice number (BT-1)")?.status === "fail");
check("missing date fails", v2.checks.find((x) => x.name === "Issue date (BT-2)")?.status === "fail");

const v3 = validateEInvoiceXml("<foo><bar/></foo>");
check("wrong root fails", v3.failed === 1 && v3.checks[0].status === "fail");

/* ------------------------- extract.ts ------------------------- */
console.log("extract.ts");

const page = `
SHARMA TRADERS
12 MG Road, Bengaluru 560001
GSTIN: 29ABCDE1234F1Z5

TAX INVOICE
Invoice No: INV-2026-042        Date: 20/10/2026

Bill To:
Verma & Sons
GSTIN: 27PQRSX6789K1Z2

Steel bracket  4 x 250.00     1,000.00
Copper wire  10 x 80.50        805.00

CGST 9%                          162.45
SGST 9%                          162.45

Grand Total                     ₹2,129.90
`;
const ex = extractInvoiceFields([page]);
check("seller gstin", ex.state.biz.gstin === "29ABCDE1234F1Z5");
check("buyer gstin", ex.state.cli.gstin === "27PQRSX6789K1Z2");
check("invoice no", ex.state.no === "INV-2026-042");
check("date iso", ex.state.date === "2026-10-20");
check("buyer name after marker", ex.state.cli.name === "Verma & Sons");
check("total captured", ex.state.items[0]?.r === "2129.90");
check("currency INR", ex.state.cur === "INR");
check("gst rate 18", ex.state.tr === "18");
check("notes non-empty", ex.notes.length >= 4);
const exEmpty = extractInvoiceFields(["hello\nworld"]);
check("empty extraction flagged", exEmpty.empty === true);

/* ------------------------- embed.ts ------------------------- */
console.log("embed.ts");

// Build a base PDF (pdf-lib), attach our XML, then extract it back the
// way the validator will (byte scan for the uncompressed stream).
const base = await PDFDocument.create();
const page0 = base.addPage([595, 842]);
page0.drawText("Invoice INV-2026-042", { size: 18 });
const baseBytes = await base.save();

const attached = await attachXmlToPdf(baseBytes, xml, "factur-x.xml", {
  documentType: "INVOICE",
  invoiceId: s.no,
});
check("attachment produced", attached.bytes.length > baseBytes.length);
check("pages preserved", attached.pages === 1);

const pdfText = Buffer.from(attached.bytes).toString("latin1");
check("EmbeddedFile dict present", pdfText.includes("/EmbeddedFile"));
check("Filespec present", pdfText.includes("/Filespec"));
check("AFRelationship Data", pdfText.includes("/Data"));
check("name tree present", pdfText.includes("/EmbeddedFiles"));
check("AF array present", pdfText.includes("/AF"));
check("XMP pdfaid part 3", pdfText.includes("<pdfaid:part>3</pdfaid:part>"));
check("XMP fx DocumentType", pdfText.includes("INVOICE") && pdfText.includes("factur-x.xml"));

// Extract back: find the uncompressed XML stream between stream/endstream.
const marker = pdfText.indexOf("factur-x.xml");
const streamAt = pdfText.indexOf("stream", pdfText.indexOf("/EmbeddedFile"));
const start = pdfText.indexOf("<?xml", streamAt);
const end = pdfText.indexOf("</rsm:CrossIndustryInvoice>", start);
check("xml recoverable by byte scan", start !== -1 && end !== -1 && end > start);
if (start !== -1 && end !== -1) {
  const recovered = pdfText.slice(start, end + "</rsm:CrossIndustryInvoice>".length);
  check("recovered xml revalidates", validateEInvoiceXml(recovered).failed === 0);
  check("recovered xml reparses", parseInvoiceXml(recovered).state.no === "INV-2026-042");
}

// Reload the attached PDF with pdf-lib (round-trip sanity).
const reloaded = await PDFDocument.load(attached.bytes);
check("pdf-lib reloads the result", reloaded.getPageCount() === 1);

// Compressed-input extraction path (validator must inflate Flate streams).
const zlibbed = deflateSync(Buffer.from(xml, "utf8"));
check("zlib helper sane", inflateSync(zlibbed).toString("utf8") === xml);

/* ------------------------- summary ------------------------- */
console.log(`\n${pass} passed, ${fail} failed (of ${pass + fail})`);
if (fail > 0) process.exit(1);
