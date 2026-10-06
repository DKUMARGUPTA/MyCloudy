/**
 * PRE-BUILD smoke test for the Doc info + Remove metadata tools (P3.9).
 * Verifies the pdf-lib engine behaviors BOTH tools depend on BEFORE any UI
 * is written (the P3.3 lesson — prove the engine, then build on it):
 *
 *  1. A PDF with full Info (title/author/subject/keywords/creator/producer/
 *     dates) + an attached XMP /Metadata stream round-trips through
 *     save() → load() — getters return every value, XMP survives.
 *  2. STRIP ALL: deleting the Info indirect object + clearing
 *     trailerInfo.Info + deleting catalog /Metadata (and its stream object)
 *     saves cleanly and NONE of it survives a reload — no Info entry in the
 *     new trailer at all, no /Metadata in the catalog.
 *  3. PARTIAL EDIT: setting some fields and deleting others (empty input →
 *     delete the Info entry) produces exactly the requested dict.
 *  4. EMPTY INFO CLEANUP: when every field is removed the leftover empty
 *     Info dict is dropped entirely (no dangling `/Info << >>`).
 *  5. setKeywords round-trips a comma list; dates set from Date objects
 *     come back as Dates via getCreationDate/getModificationDate.
 *  6. updateMetadata:false on load keeps pdf-lib from re-adding its own
 *     Producer/ModDate on save (the tools control every field).
 *
 * Run: bun scripts/smoke-metadata.ts
 */
import { writeFile } from "node:fs/promises";
import {
  PDFDocument,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRawStream,
} from "pdf-lib";
import { applyDocInfoEdits, stripAllMetadata } from "../tools/meta-common/worker-lib";

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function pass(message: string): void {
  console.log(`PASS ${message}`);
}

function assert(cond: boolean, message: string): void {
  if (cond) pass(message);
  else fail(message);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  assert(
    actual === expected,
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
  );
}

/** Minimal but valid XMP packet, the way desktop tools embed one. */
function xmpPacket(title: string, author: string): Uint8Array {
  const xml =
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>` +
    `<dc:creator><rdf:Seq><rdf:li>${author}</rdf:li></rdf:Seq></dc:creator>` +
    `</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  return new TextEncoder().encode(xml);
}

/** Attaches an XMP /Metadata stream to the doc catalog. */
function attachXmp(doc: PDFDocument, title: string, author: string): void {
  const dict = PDFDict.withContext(doc.context);
  dict.set(PDFName.of("Type"), PDFName.of("Metadata"));
  dict.set(PDFName.of("Subtype"), PDFName.of("XML"));
  const stream = PDFRawStream.of(dict, xmpPacket(title, author));
  const ref = doc.context.register(stream);
  doc.catalog.set(PDFName.of("Metadata"), ref);
}

async function main(): Promise<void> {
  /* ---- 1. Build a metadata-rich fixture ------------------------------ */
  const src = await PDFDocument.create();
  src.setTitle("Quarterly Report", { showInWindowTitleBar: true });
  src.setAuthor("Priya Sharma");
  src.setSubject("Finance");
  src.setKeywords(["report", "2026", "confidential"]);
  src.setCreator("Word Processor Pro 9");
  src.setProducer("LibreOffice 7.6");
  const creation = new Date(Date.UTC(2026, 9, 5, 9, 30, 0));
  src.setCreationDate(creation);
  src.setModificationDate(new Date(Date.UTC(2026, 9, 6, 12, 0, 0)));
  // A CUSTOM (non-standard) Info entry, like real-world files carry.
  const srcInfo = src.context.lookup(src.context.trailerInfo.Info as never, PDFDict);
  srcInfo.set(PDFName.of("GTS_PDFXVersion"), PDFHexString.fromText("PDF/X-1a"));
  src.addPage([612, 792]);
  attachXmp(src, "Quarterly Report", "Priya Sharma");
  const bytes = await src.save();

  await writeFile("download/qa-p39-meta.pdf", bytes);
  console.log(`fixture download/qa-p39-meta.pdf (${bytes.length} bytes)`);

  /* ---- 2. Read-back via a fresh load --------------------------------- */
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  eq(doc.getTitle(), "Quarterly Report", "read title");
  eq(doc.getAuthor(), "Priya Sharma", "read author");
  eq(doc.getSubject(), "Finance", "read subject");
  // pdf-lib 1.17.1 stores Keywords as ONE joined string (setKeywords joins
  // with spaces) — our tools write the comma text directly via PDFHexString.
  eq(
    doc.getKeywords(),
    "report 2026 confidential",
    "read keywords (pdf-lib joins array with spaces)"
  );
  eq(doc.getCreator(), "Word Processor Pro 9", "read creator");
  eq(doc.getProducer(), "LibreOffice 7.6", "read producer");
  assert(
    doc.getCreationDate()?.getUTCFullYear() === 2026,
    "read creation date year"
  );
  assert(doc.catalog.get(PDFName.of("Metadata")) !== undefined, "xmp present");

  // Comma-text keywords round-trip exactly as typed (the doc-info form path).
  const docKw = await PDFDocument.load(bytes, { updateMetadata: false });
  const infoKw = docKw.context.lookup(
    docKw.context.trailerInfo.Info as never,
    PDFDict
  );
  infoKw.set(PDFName.of("Keywords"), PDFHexString.fromText("invoice, GST, 2026"));
  const kwSaved = await docKw.save();
  const kwCheck = await PDFDocument.load(kwSaved, { updateMetadata: false });
  eq(
    kwCheck.getKeywords(),
    "invoice, GST, 2026",
    "comma keywords round-trip verbatim"
  );

  /* ---- 3. STRIP ALL via the REAL worker-lib --------------------------- */
  const report = stripAllMetadata(doc, true);
  eq(report.removedFields.length, 9, "strip report counts Info entries (incl. dates + custom)");
  assert(report.removedXmp, "strip report: xmp removed");

  const stripped = await doc.save();
  await writeFile("download/qa-p39-stripped.pdf", stripped);
  // Raw bytes first: the saved trailer must not carry /Info at all. (The
  // getters below lazily RE-CREATE an empty Info dict — pdf-lib's
  // getInfoDict() registers a fresh one when missing — so bytes are the
  // honest witness. LESSON for the worker: never read getters after strip.)
  eq(
    new TextDecoder().decode(stripped).includes("/Info"),
    false,
    "saved bytes contain no /Info anywhere"
  );

  const check = await PDFDocument.load(stripped, { updateMetadata: false });
  // trailerInfo checks BEFORE any getter can re-create it:
  eq(
    check.context.trailerInfo.Info,
    undefined,
    "trailer has no /Info entry at all"
  );
  eq(
    check.catalog.get(PDFName.of("Metadata")),
    undefined,
    "catalog has no /Metadata"
  );
  eq(check.getPageCount(), 1, "pages intact after strip");
  // getters now (they may re-create an empty dict in memory — that is
  // harmless and never saved again here):
  eq(check.getTitle(), undefined, "stripped title gone");
  eq(check.getAuthor(), undefined, "stripped author gone");
  eq(check.getSubject(), undefined, "stripped subject gone");
  eq(check.getKeywords(), undefined, "stripped keywords gone");
  eq(check.getCreator(), undefined, "stripped creator gone");
  eq(check.getProducer(), undefined, "stripped producer gone");
  eq(check.getCreationDate(), undefined, "stripped creation date gone");
  eq(check.getModificationDate(), undefined, "stripped mod date gone");

  /* ---- 4. PARTIAL EDIT via the REAL applyDocInfoEdits ---------------- */
  const doc2 = await PDFDocument.load(bytes, { updateMetadata: false });
  applyDocInfoEdits(doc2, {
    title: "New Title",
    author: "Arjun",
    subject: "", // remove
    keywords: "invoice, GST, 2026",
    creator: "", // remove
    producer: undefined, // untouched
    creationMode: "keep",
    modMode: "now",
    stripXmp: false,
    stripCustom: false,
  });
  const partial = await doc2.save();
  const check2 = await PDFDocument.load(partial, { updateMetadata: false });
  eq(check2.getTitle(), "New Title", "partial: new title");
  eq(check2.getAuthor(), "Arjun", "partial: new author");
  eq(check2.getSubject(), undefined, "partial: subject deleted");
  eq(check2.getCreator(), undefined, "partial: creator deleted");
  eq(check2.getProducer(), "LibreOffice 7.6", "partial: producer untouched");
  eq(
    check2.getKeywords(),
    "invoice, GST, 2026",
    "partial: keywords set as typed (comma text)"
  );
  assert(
    check2.getCreationDate() !== undefined,
    "partial: creation date kept"
  );
  assert(
    check2.getModificationDate() !== undefined,
    "partial: mod date set to now"
  );
  assert(
    check2.catalog.get(PDFName.of("Metadata")) !== undefined,
    "partial: xmp kept when stripXmp=false"
  );
  // stripCustom=false → the custom entry survives:
  const info2b = check2.context.lookup(
    check2.context.trailerInfo.Info as never,
    PDFDict
  );
  assert(
    info2b.get(PDFName.of("GTS_PDFXVersion")) !== undefined,
    "partial: custom entry kept when stripCustom=false"
  );

  /* ---- 5. EMPTY INFO CLEANUP (everything removed) --------------------- */
  const doc3 = await PDFDocument.load(bytes, { updateMetadata: false });
  applyDocInfoEdits(doc3, {
    title: "",
    author: "",
    subject: "",
    keywords: "",
    creator: "",
    producer: "",
    creationMode: "remove",
    modMode: "remove",
    stripXmp: true,
    stripCustom: true,
  });
  const emptied = await doc3.save();
  const check3 = await PDFDocument.load(emptied, { updateMetadata: false });
  eq(
    check3.context.trailerInfo.Info,
    undefined,
    "empty info dropped from trailer"
  );
  eq(
    check3.catalog.get(PDFName.of("Metadata")),
    undefined,
    "empty info: xmp also stripped"
  );
  eq(check3.getPageCount(), 1, "empty info: pages intact");
  // (cleanup already verified above)
  /* ---- 6. updateMetadata:false keeps pdf-lib's own stamp out --------- */
  const doc4 = await PDFDocument.load(bytes, { updateMetadata: false });
  doc4.setTitle("Only Title");
  const saved4 = await doc4.save();
  const check4 = await PDFDocument.load(saved4, { updateMetadata: false });
  eq(check4.getProducer(), "LibreOffice 7.6", "producer not overwritten");
  eq(check4.getTitle(), "Only Title", "title written");

  console.log("\nALL 22 METADATA CHECKS PASS");
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
