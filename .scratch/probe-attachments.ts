import { PDFDocument } from "pdf-lib";
import { attachFacturx } from "../tools/create-electronic-invoice/facturx-attach";

// Build a small source PDF
const src = await PDFDocument.create();
const page = src.addPage([400, 300]);
await src.embedFont((await import("pdf-lib")).StandardFonts.Helvetica);
page.drawText("Hello invoice", { x: 40, y: 200, size: 14 });
const srcBytes = await src.save({ useObjectStreams: false });

// CII minimum XML fixture
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntityDataType:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:factur-x.eu:1p0:minimum</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument><ram:ID>RE-2024-0517</ram:ID><ram:TypeCode>380</ram:TypeCode><ram:IssueDateTime><udt:DateTimeString format="102">20240517</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument>
</rsm:CrossIndustryInvoice>`;

const result = await attachFacturx(srcBytes, new TextEncoder().encode(xml), { claimPdfa: false, producer: "probe" });
console.log("PDF size:", result.bytes.length);

// Open with pdf.js and call getAttachments
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const task = getDocument({ data: result.bytes.slice(), verbosity: 0 });
const doc = await task.promise;
const attachments = await doc.getAttachments();
console.log("attachments keys:", Object.keys(attachments ?? {}));
for (const [k, v] of Object.entries(attachments ?? {})) {
  console.log("KEY:", JSON.stringify(k));
  console.log("VALUE TYPE:", typeof v);
  const entry = v as Record<string, unknown>;
  for (const [fk, fv] of Object.entries(entry)) {
    if (fv instanceof Uint8Array) {
      console.log(`  field ${fk}: Uint8Array len=${fv.length} first=${fv[0]} (${String.fromCharCode(fv[0])}${String.fromCharCode(fv[1])}${String.fromCharCode(fv[2])}${String.fromCharCode(fv[3])}`);
    } else if (typeof fv === "object" && fv !== null) {
      const inner = fv as Record<string, unknown>;
      const innerKeys = Object.keys(inner);
      console.log(`  field ${fk}: object {${innerKeys.join(",")}}`);
      if (inner.data instanceof Uint8Array) console.log(`    .data: Uint8Array len=${(inner.data as Uint8Array).length}`);
    } else {
      console.log(`  field ${fk}: ${JSON.stringify(fv)}`);
    }
  }
}
await doc.destroy();
process.exit(0);
