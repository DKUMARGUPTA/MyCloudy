/**
 * P12-EINVOICE fixtures (re-runnable): the e-invoice round's QA inputs.
 *
 *   public/qa/einv-embed-fixtures/
 *     valid-en16931.xml   — our own CII builder output (round-trip proof)
 *     valid-en16931.pdf   — our own CREATE output: a real hybrid Factur-X
 *                           PDF/A-3 (drop into validate-e-invoice → green)
 *     tampered-en16931.xml— grand total lies (+100)
 *     category-tamper.xml — VAT breakdown base lies
 *     broken.xml          — truncated XML
 *     plain.pdf           — a plain one-page PDF (no XML) for the embed path
 *     badmeta.pdf         — attachment without the fx: XMP block
 *
 * Run: bun scripts/make-einvoice-fixtures.ts
 */
import fs from "node:fs";
import { PDFDocument, embedFacturX, AFRelationship } from "@cantoo/pdf-lib";

import { buildCiiChecked, buildEInvoiceArtifact } from "../tools/einv-common/engine";
import { defaultForm, lineKey, type EInvFormState } from "../tools/einv-common/model";

const OUT = "public/qa/einv-embed-fixtures";

export function sampleForm(): EInvFormState {
  const form = defaultForm();
  form.number = "EINV-2026-042";
  form.issue = "2026-10-19";
  form.due = "2026-11-08";
  form.currency = "INR";
  form.seller = {
    name: "Büromöbel & Tische GmbH",
    street: "Musterstraße 12",
    street2: "Building B",
    city: "Köln",
    postcode: "50667",
    country: "DE",
    taxId: "DE123456789",
    taxScheme: "VA",
    email: "billing@bueromoebel.example",
  };
  form.buyer = {
    name: "Papeterie Lyon SARL",
    street: "15 Rue de la Paix",
    street2: "",
    city: "Lyon",
    postcode: "69002",
    country: "FR",
    taxId: "FR98765432109",
    taxScheme: "VA",
    email: "",
  };
  form.lines = [
    { key: lineKey(), desc: "Conference table \"Elbe\" 240×120", qty: "2", unit: "C62", price: "1500", rate: "19" },
    { key: lineKey(), desc: "Office chair Ergo <Pro>", qty: "5", unit: "C62", price: "249.50", rate: "19" },
    { key: lineKey(), desc: "Desk lamp LED", qty: "8", unit: "C62", price: "39.99", rate: "7" },
    { key: lineKey(), desc: "Assembly service", qty: "3", unit: "HUR", price: "65", rate: "19" },
  ];
  form.iban = "DE89370400440532013000";
  form.accountName = "Büromöbel & Tische GmbH";
  form.upi = "";
  form.notes = "Payable within 14 days, net. Please quote the invoice number.";
  return form;
}

const EN_LABELS = {
  title: "e-Invoice (Factur-X)",
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
  taxCol: "Tax",
  amt: "Amount",
  sub: "Line total",
  allowance: "Allowance",
  charge: "Charge",
  basis: "Tax basis",
  taxBreakdown: "Tax breakdown",
  rate: "Rate",
  category: "Category",
  base: "Base",
  taxTotal: "Tax total",
  rounding: "Rounding",
  grand: "Grand total",
  prepaid: "Prepaid",
  payable: "Payable",
  payment: "Payment",
  account: "Account",
  upi: "UPI",
  notes: "Notes",
  terms: "Terms",
  wordsLabel: "Amount in words:",
  checksOk: "Totals verified",
  checksFail: "Inconsistent totals",
  footerNote:
    "This PDF contains the invoice data as embedded Factur-X XML (EN 16931). Generated on-device by DocoPDF.",
};

function writeBytes(name: string, bytes: Uint8Array): void {
  fs.writeFileSync(`${OUT}/${name}`, bytes);
  console.log(`  wrote ${name} (${bytes.length} B)`);
}

function writeText(name: string, text: string): void {
  writeBytes(name, new TextEncoder().encode(text));
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const form = sampleForm();

  // 1. Our builder's CII XML.
  const { xml } = buildCiiChecked(form);
  writeBytes("valid-en16931.xml", xml);

  // 2. Tampered: grand total +100 (lines/basis stay honest).
  const tampered = new TextDecoder().decode(xml).replace(
    /(<ram:GrandTotalAmount>)([\d.]+)(<\/ram:GrandTotalAmount>)/,
    (_m, a, v: string, z) => `${a}${(Number(v) + 100).toFixed(2)}${z}`
  );
  writeText("tampered-en16931.xml", tampered);

  // 3. Category tamper: first VAT breakdown basis +50.
  const category = new TextDecoder().decode(xml).replace(
    /(<ram:BasisAmount>)([\d.]+)(<\/ram:BasisAmount>)/,
    (_m, a, v: string, z) => `${a}${(Number(v) + 50).toFixed(2)}${z}`
  );
  writeText("category-tamper.xml", category);

  // 4. Broken XML.
  writeText("broken.xml", new TextDecoder().decode(xml).slice(0, 600));

  // 5. Plain one-page PDF.
  const plain = await PDFDocument.create();
  plain.addPage([595.28, 841.89]);
  const plainBytes = await plain.save();
  writeBytes("plain.pdf", plainBytes);

  // 6. Bad-meta hybrid: attachment + PDF/A, but NO fx: XMP block.
  const bad = await PDFDocument.create();
  bad.addPage([595.28, 841.89]);
  bad.convertToPDFA({ conformance: "3B" });
  await bad.attach(xml, "factur-x.xml", {
    mimeType: "text/xml",
    description: "Factur-X invoice data",
    afRelationship: AFRelationship.Alternative,
  });
  const badBytes = await bad.save();
  writeBytes("badmeta.pdf", badBytes);

  // 7. The real thing: our own CREATE output (hybrid, validates green).
  const fontBytes = new Uint8Array(
    fs.readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
  );
  const artifact = await buildEInvoiceArtifact(form, {
    labels: EN_LABELS,
    accent: "#0b6b4d",
    fontBytes,
  });
  writeBytes("valid-en16931.pdf", artifact.bytes);

  console.log("fixtures done");
}

if (import.meta.main) {
  void main();
}
