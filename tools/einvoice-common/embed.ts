/**
 * Factur-X attachment machinery (P9 batch 5) — embeds an e-invoice XML
 * into a PDF the way Factur-X / ZUGFeRD readers expect:
 *
 *   1. an UNCOMPRESSED /EmbeddedFile stream (always extractable),
 *   2. a /Filespec with /F + /UF + /EF + /AFRelationship Data,
 *   3. the catalog's /Names → /EmbeddedFiles name tree,
 *   4. the catalog's /AF array,
 *   5. an XMP packet declaring pdfaid part 3 (PDF/A-3) + the fx: data
 *      (DocumentType INVOICE, the attachment filename).
 *
 * pdf-lib has no attachment API — this is the low-level context work.
 * Honest scope: this makes a structured, reader-detectable e-invoice
 * PDF; FULL PDF/A-3 certification (every font embedded, output intents)
 * still needs a desktop validator, and the FAQ says so.
 */

import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFString,
  PDFHexString,
  PDFArray,
  PDFDict,
  PDFNumber,
} from "pdf-lib";

export interface AttachResult {
  bytes: Uint8Array;
  /** The attachment filename that was embedded. */
  name: string;
  pages: number;
}

/** XMP with pdfaid part 3 + fx: Factur-X identification. */
function buildXmp(
  attachmentName: string,
  documentType: string,
  invoiceId: string
): string {
  const now = new Date().toISOString();
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXmlText(invoiceId)}</rdf:li></rdf:Alt></dc:title>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreatorTool>Sidocs</xmp:CreatorTool>
      <xmp:CreateDate>${now}</xmp:CreateDate>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>Sidocs e-invoice</pdf:Producer>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
      <fx:DocumentType>${escapeXmlText(documentType)}</fx:DocumentType>
      <fx:DocumentFileName>${escapeXmlText(attachmentName)}</fx:DocumentFileName>
      <fx:Version>1.0</fx:Version>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

function escapeXmlText(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Attaches `xml` to the PDF loaded from `pdfBytes` and returns the new
 * bytes. The attachment stream stays UNCOMPRESSED so any reader (and
 * our own validator) can pull it out with plain byte scanning.
 */
export async function attachXmlToPdf(
  pdfBytes: Uint8Array,
  xml: string,
  attachmentName = "factur-x.xml",
  opts?: { documentType?: string; invoiceId?: string }
): Promise<AttachResult> {
  const doc = await PDFDocument.load(pdfBytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
  });
  const context = doc.context;
  const xmlBytes = new TextEncoder().encode(xml);

  /* 1 — EmbeddedFile stream (uncompressed). */
  const streamDict = context.obj({
    Type: "EmbeddedFile",
    Subtype: PDFName.of("text#2Fxml"),
    Size: PDFNumber.of(xmlBytes.length),
  }) as PDFDict;
  const stream = PDFRawStream.of(streamDict, xmlBytes);
  const streamRef = context.register(stream);

  /* 2 — Filespec. */
  const filespec = context.obj({
    Type: "Filespec",
    F: PDFString.of(attachmentName),
    UF: PDFHexString.fromText(attachmentName),
    Desc: PDFString.of("Factur-X e-invoice data"),
    AFRelationship: PDFName.of("Data"),
    EF: { F: streamRef, UF: streamRef },
  });
  const filespecRef = context.register(filespec);

  /* 3 — Catalog /Names → /EmbeddedFiles tree (flat: one name). */
  const catalog = doc.catalog;
  const embeddedNames = context.obj({
    Names: context.obj([PDFHexString.fromText(attachmentName), filespecRef]),
  }) as PDFDict;

  let names = catalog.get(PDFName.of("Names"));
  if (names instanceof PDFDict) {
    names.set(PDFName.of("EmbeddedFiles"), embeddedNames);
  } else {
    const fresh = context.obj({ EmbeddedFiles: embeddedNames }) as PDFDict;
    catalog.set(PDFName.of("Names"), fresh);
  }

  /* 4 — /AF array. */
  const af = PDFArray.withContext(context);
  af.push(filespecRef);
  catalog.set(PDFName.of("AF"), af);

  /* 5 — XMP metadata stream (replaces any existing). */
  const xmp = buildXmp(
    attachmentName,
    opts?.documentType ?? "INVOICE",
    opts?.invoiceId ?? "Invoice"
  );
  const xmpBytes = new TextEncoder().encode(xmp);
  const xmpDict = context.obj({
    Type: "Metadata",
    Subtype: PDFName.of("XML"),
    Length: PDFNumber.of(xmpBytes.length),
  }) as PDFDict;
  const xmpStream = PDFRawStream.of(xmpDict, xmpBytes);
  catalog.set(PDFName.of("Metadata"), context.register(xmpStream));

  const bytes = await doc.save({ useObjectStreams: false });
  return {
    bytes: bytes as unknown as Uint8Array,
    name: attachmentName,
    pages: doc.getPageCount(),
  };
}
