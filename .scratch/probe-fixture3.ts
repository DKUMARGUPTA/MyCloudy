import { PDFDocument, PDFName, PDFRawStream, PDFDict } from "pdf-lib";
import { deflateSync, inflateSync } from "node:zlib";

const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#"><pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance><fx:DocumentType>INVOICE</fx:DocumentType><fx:DocumentFileName>factur-x.xml</fx:DocumentFileName></rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;

const doc2 = await PDFDocument.create();
doc2.addPage([300, 200]);
const comp = deflateSync(new TextEncoder().encode(xmp));
const xmpDict2 = doc2.context.obj({ Type: PDFName.of("Metadata"), Subtype: PDFName.of("XML"), Filter: PDFName.of("FlateDecode") }) as PDFDict;
doc2.catalog.set(PDFName.of("Metadata"), doc2.context.register(PDFRawStream.of(xmpDict2, comp)));
const b2 = await doc2.save({ useObjectStreams: false });
const l2 = Buffer.from(b2).toString("latin1");

let out = ""; let idx = 0;
let guard = 0;
while (guard++ < 20) {
  const st = l2.indexOf("stream", idx);
  if (st === -1) break;
  const en = l2.indexOf("endstream", st);
  if (en === -1) break;
  let s = st + 6; while (s < en && (b2[s] === 13 || b2[s] === 10)) s += 1;
  let e = en; while (e > s && (b2[e - 1] === 13 || b2[e - 1] === 10)) e -= 1;
  console.log(`stream st=${st} en=${en} s=${s} e=${e} len=${e - s} context=${JSON.stringify(l2.slice(Math.max(0, st - 60), st + 1))}`);
  if (e > s) {
    try { out += inflateSync(b2.subarray(s, e)).toString("latin1"); } catch (err) { console.log("  inflate fail:", (err as Error).message); }
  }
  idx = en + 9;
}
console.log("inflated has fx:", out.includes("fx:DocumentType"), "| pdfaid:", out.includes("pdfaid:part"));
console.log("out len:", out.length);
process.exit(0);
