import { PDFDocument, StandardFonts, PDFName, PDFNumber, PDFRawStream, PDFString, PDFHexString, PDFDict } from "pdf-lib";
import { deflateSync } from "node:zlib";

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"><rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:factur-x.eu:1p0:minimum</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext><rsm:ExchangedDocument><ram:ID>RE-2024-0517</ram:ID><ram:TypeCode>380</ram:TypeCode><ram:IssueDateTime><udt:DateTimeString format="102">20240517</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument></rsm:CrossIndustryInvoice>`;

const doc = await PDFDocument.create();
const page = doc.addPage([595.28, 841.89]);
const helv = await doc.embedStandardFont(StandardFonts.Helvetica);
page.drawText("Invoice RE-2024-0517", { x: 40, y: 800, size: 14, font: helv });

const xmlBytes = new TextEncoder().encode(xml);
const embeddedDict = doc.context.obj({
  Type: PDFName.of("EmbeddedFile"),
  Subtype: PDFName.of("text#2Fxml"),
  Params: doc.context.obj({ Size: PDFNumber.of(xmlBytes.length) }),
}) as PDFDict;
const embeddedStream = PDFRawStream.of(embeddedDict, xmlBytes);
const embeddedRef = doc.context.register(embeddedStream);

const filespec = doc.context.obj({
  Type: PDFName.of("Filespec"),
  F: PDFString.of("factur-x.xml"),
  UF: PDFHexString.fromText("factur-x.xml"),
  EF: doc.context.obj({ F: embeddedRef, UF: embeddedRef }),
  AFRelationship: PDFName.of("Data"),
});
const filespecRef = doc.context.register(filespec);

doc.catalog.set(PDFName.of("AF"), doc.context.obj([filespecRef]));
doc.catalog.set(PDFName.of("Names"), doc.context.obj({
  EmbeddedFiles: { Names: doc.context.obj([PDFHexString.fromText("factur-x.xml"), filespecRef]) },
}));

const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#"><pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance><fx:DocumentType>INVOICE</fx:DocumentType><fx:DocumentFileName>factur-x.xml</fx:DocumentFileName></rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
const rawXmp = new TextEncoder().encode(xmp);
const xmpDict = doc.context.obj({ Type: PDFName.of("Metadata"), Subtype: PDFName.of("XML") }) as PDFDict;
doc.catalog.set(PDFName.of("Metadata"), doc.context.register(PDFRawStream.of(xmpDict, rawXmp)));

const bytes = await doc.save({ useObjectStreams: false });
console.log("PDF size:", bytes.length);
const latin = Buffer.from(bytes).toString("latin1");

// probe regexes
console.log("has /EmbeddedFile:", latin.includes("/EmbeddedFile"));
console.log("AF match:", /\/AF\s*\[\s*\d/.test(latin));
const afRel = /\/AFRelationship\s*\/([A-Za-z0-9]+)/.exec(latin);
console.log("AFRelationship:", afRel?.[1]);
console.log("fx:DocumentType:", /<fx:DocumentType[^>]*>([^<]*)<\/fx:DocumentType>/.exec(latin)?.[1]);
console.log("pdfaid part:", /<pdfaid:part[^>]*>([^<]*)<\/pdfaid:part>/.exec(latin)?.[1]);

// dump catalog region
const afIdx = latin.indexOf("/AF");
console.log("--- catalog region ---");
console.log(JSON.stringify(latin.slice(afIdx - 200, afIdx + 400)));

// pdf.js getAttachments round trip
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const task = getDocument({ data: bytes.slice(), verbosity: 0 });
const pdfdoc = await task.promise;
const att = await pdfdoc.getAttachments();
console.log("attachments:", Object.keys(att ?? {}));
const entry = att?.["factur-x.xml"] as Record<string, unknown>;
console.log("content is Uint8Array:", entry?.content instanceof Uint8Array, "len:", (entry?.content as Uint8Array)?.length);
await pdfdoc.destroy();

// compressed XMP variant
const doc2 = await PDFDocument.create();
doc2.addPage([300, 200]);
const xmp2 = xmp.replace("RE-2024-0517", "X");
const comp = deflateSync(new TextEncoder().encode(xmp2));
const xmpDict2 = doc2.context.obj({ Type: PDFName.of("Metadata"), Subtype: PDFName.of("XML"), Filter: PDFName.of("FlateDecode") }) as PDFDict;
doc2.catalog.set(PDFName.of("Metadata"), doc2.context.register(PDFRawStream.of(xmpDict2, comp)));
const b2 = await doc2.save({ useObjectStreams: false });
const l2 = Buffer.from(b2).toString("latin1");
console.log("compressed variant: raw has fx:", l2.includes("fx:DocumentType"), "| has /Metadata:", l2.includes("/Metadata"));
// inflate scan
let out = ""; let idx = 0;
for (;;) {
  const st = l2.indexOf("stream", idx); if (st === -1) break;
  const en = l2.indexOf("endstream", st); if (en === -1) break;
  let s = st + 6; while (s < en && (b2[s] === 13 || b2[s] === 10)) s += 1;
  let e = en; while (e > s && (b2[e - 1] === 13 || b2[e - 1] === 10)) e -= 1;
  if (e > s) { try { out += inflateSync(b2.subarray(s, e)).toString("latin1"); } catch {} }
  idx = en + 9;
}
console.log("inflated has fx:", out.includes("fx:DocumentType"), "| pdfaid:", out.includes("pdfaid:part"));

// corrupt + encrypted probes
try {
  const bad = getDocument({ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), verbosity: 0 });
  await bad.promise;
} catch (err) {
  console.log("corrupt error name:", (err as Error).name, "| msg:", JSON.stringify((err as Error).message).slice(0, 90));
}
const { PDFDocument: CantooDoc } = await import("@cantoo/pdf-lib");
const cantoo = await CantooDoc.create();
cantoo.addPage([300, 200]);
cantoo.encrypt({ userPassword: "pw" });
const enc = await cantoo.save({ useObjectStreams: false });
try {
  const t2 = getDocument({ data: new Uint8Array(enc), verbosity: 0 });
  await t2.promise;
} catch (err) {
  console.log("encrypted error name:", (err as Error).name, "| msg:", JSON.stringify((err as Error).message).slice(0, 90));
}
process.exit(0);
