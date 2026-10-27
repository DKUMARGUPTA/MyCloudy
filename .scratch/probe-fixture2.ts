import { PDFDocument, PDFName, PDFRawStream, PDFDict } from "pdf-lib";
import { deflateSync, inflateSync } from "node:zlib";

const xmp = `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#"><fx:DocumentType>INVOICE</fx:DocumentType><fx:DocumentFileName>factur-x.xml</fx:DocumentFileName></rdf:Description></rdf:RDF></x:xmpmeta>`;

const doc2 = await PDFDocument.create();
doc2.addPage([300, 200]);
const comp = deflateSync(new TextEncoder().encode(xmp));
const xmpDict2 = doc2.context.obj({ Type: PDFName.of("Metadata"), Subtype: PDFName.of("XML"), Filter: PDFName.of("FlateDecode") }) as PDFDict;
doc2.catalog.set(PDFName.of("Metadata"), doc2.context.register(PDFRawStream.of(xmpDict2, comp)));
const b2 = await doc2.save({ useObjectStreams: false });
const l2 = Buffer.from(b2).toString("latin1");

// dump every stream region
let idx = 0;
let n = 0;
while (n < 12) {
  const st = l2.indexOf("stream", idx);
  if (st === -1) break;
  const en = l2.indexOf("endstream", st);
  if (en === -1) break;
  let s = st + 6; while (s < en && (b2[s] === 13 || b2[s] === 10)) s += 1;
  let e = en; while (e > s && (b2[e - 1] === 13 || b2[e - 1] === 10)) e -= 1;
  console.log(`stream #${n}: st=${st} en=${en} s=${s} e=${e} len=${e - s}`);
  console.log("  context:", JSON.stringify(l2.slice(Math.max(0, st - 90), st + 2)));
  if (e > s) {
    try {
      const out = inflateSync(b2.subarray(s, e));
      console.log("  inflated:", out.length, "bytes, has fx:", Buffer.from(out).toString("latin1").includes("fx:DocumentType"));
    } catch (err) {
      console.log("  inflate FAILED:", (err as Error).message);
    }
  }
  idx = en + 9;
  n += 1;
}
console.log("total bytes:", b2.length);
console.log("raw has /Metadata:", l2.includes("/Metadata"));
console.log("raw has FlateDecode:", l2.includes("FlateDecode"));
// show the metadata area
const mIdx = l2.indexOf("/Metadata");
console.log("metadata region:", JSON.stringify(l2.slice(mIdx, mIdx + 160)));
process.exit(0);
