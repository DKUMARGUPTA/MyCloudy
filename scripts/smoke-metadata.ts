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
 *  7. DEEP PAGE-LEVEL STRIP (audit R3-b): page /PieceInfo (direct dict
 *     AND indirect ref), page /Metadata streams and annotation /M dates
 *     are removed with honest per-category counts — the annotations
 *     themselves survive. A clean file reports all-zero categories.
 *  8. stripCustom SCOPE (slash-shape regression): applyDocInfoEdits with
 *     stripCustom removes ONLY the non-standard Info entries — the six
 *     standard fields (and /Trapped) survive.
 *  9. REAL WORKER E2E (audit R3-b, self-shimmed globalThis — the
 *     smoke-sign §6 recipe): the remove-pdf-metadata worker posts the
 *     honest per-category detail (removedInfoFields / removedXmp /
 *     strippedPieceInfo / strippedPageMetadata / strippedAnnotationDates)
 *     and its output bytes are genuinely clean.
 * 10. WIRING + i18n (audit R3-b): protocol RunDetail carries the three
 *     new fields, result-view renders the chips, both catalogs have the
 *     EN+HI strings, the panel carries the deep-clean note.
 *
 * Run: bun scripts/smoke-metadata.ts
 */
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  PDFDocument,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
  type PDFRef,
} from "pdf-lib";
import {
  applyDocInfoEdits,
  infoDict,
  loadMetaDoc,
  saveMetaDoc,
  stripAllMetadata,
} from "../tools/meta-common/worker-lib";
import type { WorkerRunRequest, WorkerResponse } from "../src/lib/workers/protocol";

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

  /* ---- 3. STRIP ALL via the REAL worker-lib (OWN engine, P6-s) --------- */
  const meta = loadMetaDoc(bytes);
  const report = stripAllMetadata(meta, true);
  eq(report.removedFields.length, 9, "strip report counts Info entries (incl. dates + custom)");
  assert(report.removedXmp, "strip report: xmp removed");

  const stripped = saveMetaDoc(meta);
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
  const meta2 = loadMetaDoc(bytes);
  applyDocInfoEdits(meta2, {
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
  const partial = saveMetaDoc(meta2);
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
  const meta3 = loadMetaDoc(bytes);
  applyDocInfoEdits(meta3, {
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
  const emptied = saveMetaDoc(meta3);
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
  const meta4 = loadMetaDoc(bytes);
  applyDocInfoEdits(meta4, {
    title: "Only Title",
    author: undefined,
    subject: undefined,
    keywords: undefined,
    creator: undefined,
    producer: undefined,
    creationMode: "keep",
    modMode: "keep",
    stripXmp: false,
    stripCustom: false,
  });
  const saved4 = saveMetaDoc(meta4);
  const check4 = await PDFDocument.load(saved4, { updateMetadata: false });
  eq(check4.getProducer(), "LibreOffice 7.6", "producer not overwritten");
  eq(check4.getTitle(), "Only Title", "title written");

  /* ---- 7. DEEP PAGE-LEVEL STRIP (audit R3-b) ------------------------- */
  // A 2-page fixture that carries page /PieceInfo (page 1 as a DIRECT dict,
  // page 2 via an INDIRECT ref), a page /Metadata stream on page 1, and
  // annotations with /M on both pages (+ one /M-less control annotation).
  const deep = await PDFDocument.create({ updateMetadata: false });
  deep.setTitle("Deep Clean");
  const pageA = deep.addPage([300, 300]);
  const pageB = deep.addPage([300, 300]);
  const stamp = PDFString.of("D:20261023120000Z");

  const annotWithM = (contents: string): PDFRef =>
    deep.context.register(
      deep.context.obj({
        Type: "Annot",
        Subtype: "Text",
        Rect: [10, 10, 90, 90],
        Contents: PDFHexString.fromText(contents),
        M: PDFString.of("D:20261023120000Z"),
      })
    );
  const annotNoM = deep.context.register(
    deep.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [10, 10, 90, 90],
      Contents: PDFHexString.fromText("no date here"),
    })
  );

  // page A: direct PieceInfo dict + /Metadata stream + 2 dated annots + 1 undated
  pageA.node.set(
    PDFName.of("PieceInfo"),
    deep.context.obj({
      LastModified: stamp,
      Illustrator: deep.context.obj({ LastModified: stamp }),
    })
  );
  const metaDict = PDFDict.withContext(deep.context);
  metaDict.set(PDFName.of("Type"), PDFName.of("Metadata"));
  metaDict.set(PDFName.of("Subtype"), PDFName.of("XML"));
  const metaStream = PDFRawStream.of(
    metaDict,
    new TextEncoder().encode(
      `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
        `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></rdf:RDF></x:xmpmeta>`
    )
  );
  pageA.node.set(PDFName.of("Metadata"), deep.context.register(metaStream));
  pageA.node.set(
    PDFName.of("Annots"),
    deep.context.obj([annotWithM("dated note 1"), annotWithM("dated note 2"), annotNoM])
  );

  // page B: PieceInfo behind an INDIRECT ref + 1 dated annot, no page metadata
  const pieceRef = deep.context.register(
    deep.context.obj({ LastModified: stamp })
  );
  pageB.node.set(PDFName.of("PieceInfo"), pieceRef);
  pageB.node.set(
    PDFName.of("Annots"),
    deep.context.obj([annotWithM("dated note 3")])
  );

  const deepBytes = await deep.save();
  const deepMeta = loadMetaDoc(deepBytes);
  const deepReport = stripAllMetadata(deepMeta, true);
  eq(deepReport.removedPieceInfo, 2, "deep strip: both pages' PieceInfo counted (direct + indirect)");
  eq(deepReport.removedPageMetadata, 1, "deep strip: page metadata stream counted");
  eq(deepReport.removedAnnotationDates, 3, "deep strip: 3 annotation /M dates counted (control skipped)");
  eq(deepReport.removedFields.length, 1, "deep strip: Info entries still counted (Title only)");
  eq(
    deepReport.removedXmp,
    false,
    "deep strip: page-level XMP is NOT misreported as catalog XMP (fixture has none)"
  );

  const deepSaved = saveMetaDoc(deepMeta);
  const deepCheck = await PDFDocument.load(deepSaved, { updateMetadata: false });
  eq(deepCheck.getPageCount(), 2, "deep strip: pages intact");
  for (const [pi, page] of deepCheck.getPages().entries()) {
    eq(
      page.node.get(PDFName.of("PieceInfo")),
      undefined,
      `deep strip: page ${pi + 1} /PieceInfo gone`
    );
    eq(
      page.node.get(PDFName.of("Metadata")),
      undefined,
      `deep strip: page ${pi + 1} /Metadata gone`
    );
  }
  const checkAnnots = (page: ReturnType<PDFDocument["getPages"]>[number], count: number, label: string): void => {
    const annots = page.node.Annots();
    eq(annots?.size() ?? 0, count, `${label}: annotation count unchanged`);
    let withM = 0;
    for (let i = 0; i < (annots?.size() ?? 0); i += 1) {
      const entry = annots!.lookup(i);
      if (entry instanceof PDFDict) {
        if (entry.get(PDFName.of("M")) !== undefined) withM += 1;
        // the annotation itself survives intact:
        eq(
          entry.get(PDFName.of("Subtype")) !== undefined &&
            entry.get(PDFName.of("Contents")) !== undefined,
          true,
          `${label}: annotation substance kept (Subtype + Contents)`
        );
      }
    }
    eq(withM, 0, `${label}: no /M survives`);
  };
  checkAnnots(deepCheck.getPages()[0]!, 3, "deep strip page 1");
  checkAnnots(deepCheck.getPages()[1]!, 1, "deep strip page 2");
  eq(
    deepCheck.context.trailerInfo.Info,
    undefined,
    "deep strip: Info dict still fully removed"
  );

  // Zero-control: a clean file reports all-zero new categories.
  const cleanDoc = await PDFDocument.create({ updateMetadata: false });
  cleanDoc.addPage([200, 200]);
  const cleanBytes = await cleanDoc.save();
  const cleanReport = stripAllMetadata(loadMetaDoc(cleanBytes), true);
  eq(cleanReport.removedPieceInfo, 0, "clean file: 0 PieceInfo");
  eq(cleanReport.removedPageMetadata, 0, "clean file: 0 page metadata");
  eq(cleanReport.removedAnnotationDates, 0, "clean file: 0 annotation dates");
  eq(cleanReport.removedXmp, false, "clean file: no XMP claim");

  /* ---- 8. stripCustom SCOPE (slash-shape regression) --------------- */
  const scopeMeta = loadMetaDoc(bytes);
  infoDict(scopeMeta)?.set("Trapped", { k: "name", v: "False" });
  applyDocInfoEdits(scopeMeta, {
    title: undefined,
    author: undefined,
    subject: undefined,
    keywords: undefined,
    creator: undefined,
    producer: undefined,
    creationMode: "keep",
    modMode: "keep",
    stripXmp: false,
    stripCustom: true,
  });
  const scopeSaved = saveMetaDoc(scopeMeta);
  const scopeCheck = await PDFDocument.load(scopeSaved, { updateMetadata: false });
  eq(scopeCheck.getTitle(), "Quarterly Report", "stripCustom keeps standard Title");
  eq(scopeCheck.getProducer(), "LibreOffice 7.6", "stripCustom keeps standard Producer");
  const scopeInfo2 = scopeCheck.context.lookup(
    scopeCheck.context.trailerInfo.Info as never,
    PDFDict
  );
  eq(
    scopeInfo2.get(PDFName.of("GTS_PDFXVersion")),
    undefined,
    "stripCustom removes the custom entry"
  );
  eq(
    scopeInfo2.get(PDFName.of("Trapped")),
    PDFName.of("False"),
    "stripCustom keeps /Trapped (standard, layout state)"
  );

  /* ---- 9. REAL WORKER E2E (audit R3-b, self-shimmed) ----------------- */
  // The exact drive the browser does: File in, per-category detail out.
  {
    const workerGlobal = globalThis as unknown as {
      postMessage: (msg: unknown) => void;
      onmessage: ((event: { data: WorkerRunRequest }) => void) | null;
      location: { href: string };
    };
    const messages: WorkerResponse[] = [];
    workerGlobal.postMessage = (msg: unknown): void => {
      messages.push(msg as WorkerResponse);
    };
    workerGlobal.location = { href: "http://localhost/" };
    (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
    await import("../tools/remove-pdf-metadata/worker");
    eq(
      typeof workerGlobal.onmessage === "function",
      true,
      "worker E2E: module loaded, onmessage registered"
    );

    const drive = async (
      runId: number,
      options: Record<string, unknown>,
      file: File
    ): Promise<WorkerResponse> => {
      const before = messages.length;
      workerGlobal.onmessage!({
        data: {
          type: "run",
          runId,
          toolId: "remove-pdf-metadata",
          options,
          files: [file],
        } as WorkerRunRequest,
      });
      const done = await (async (): Promise<boolean> => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          if (
            messages
              .slice(before)
              .some(
                (m) => m.runId === runId && (m.type === "result" || m.type === "error")
              )
          ) {
            return true;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        return false;
      })();
      if (!done) throw new Error(`worker run ${runId} did not finish`);
      return messages
        .slice(before)
        .find((m) => m.runId === runId && (m.type === "result" || m.type === "error"))!;
    };

    // The §7 deep fixture through the REAL worker: every category honest.
    const deepRun = await drive(
      1,
      { alsoXmp: true },
      new File([deepBytes as BlobPart], "deep-clean.pdf")
    );
    eq(deepRun.type, "result", "worker E2E: deep fixture → result (not error)");
    if (deepRun.type === "result") {
      eq(deepRun.outputs.length, 1, "worker E2E: one output");
      eq(
        deepRun.outputs[0]!.name,
        "deep-clean-clean.pdf",
        "worker E2E: -clean.pdf output name"
      );
      const d = deepRun.detail as {
        files?: number;
        pages?: number;
        removedInfoFields?: number;
        removedXmp?: boolean;
        strippedPieceInfo?: number;
        strippedPageMetadata?: number;
        strippedAnnotationDates?: number;
      };
      eq(d.files, 1, "worker E2E: files 1");
      eq(d.pages, 2, "worker E2E: pages 2");
      eq(d.removedInfoFields, 1, "worker E2E: removedInfoFields 1 (Title)");
      eq(
        d.removedXmp,
        false,
        "worker E2E: removedXmp false (fixture has no catalog XMP)"
      );
      eq(d.strippedPieceInfo, 2, "worker E2E: strippedPieceInfo 2");
      eq(d.strippedPageMetadata, 1, "worker E2E: strippedPageMetadata 1");
      eq(d.strippedAnnotationDates, 3, "worker E2E: strippedAnnotationDates 3");
      // Output bytes are genuinely clean (the honest witness):
      const outBytes = new Uint8Array(
        await deepRun.outputs[0]!.blob.arrayBuffer()
      );
      const outDoc = await PDFDocument.load(outBytes, { updateMetadata: false });
      eq(
        outDoc.context.trailerInfo.Info,
        undefined,
        "worker E2E: output Info gone"
      );
      let mLeft = 0;
      for (const page of outDoc.getPages()) {
        if (page.node.get(PDFName.of("PieceInfo")) !== undefined) {
          eq(false, true, `worker E2E: page still has PieceInfo`);
        }
        if (page.node.get(PDFName.of("Metadata")) !== undefined) {
          eq(false, true, `worker E2E: page still has Metadata`);
        }
        const annots = page.node.Annots();
        if (annots) {
          for (let i = 0; i < annots.size(); i += 1) {
            const entry = annots.lookup(i);
            if (entry instanceof PDFDict && entry.get(PDFName.of("M")) !== undefined) {
              mLeft += 1;
            }
          }
        }
      }
      eq(mLeft, 0, "worker E2E: no annotation /M survives in output");
      eq(outDoc.getPageCount(), 2, "worker E2E: pages intact in output");
    }

    // The §1 metadata-rich fixture: 9 Info fields + catalog XMP, and the
    // new categories report honest ZEROES (no page-level extras).
    const richRun = await drive(
      2,
      { alsoXmp: true },
      new File([bytes as BlobPart], "rich.pdf")
    );
    eq(richRun.type, "result", "worker E2E: rich fixture → result");
    if (richRun.type === "result") {
      const d = richRun.detail as {
        removedInfoFields?: number;
        removedXmp?: boolean;
        strippedPieceInfo?: number;
        strippedPageMetadata?: number;
        strippedAnnotationDates?: number;
      };
      eq(d.removedInfoFields, 9, "worker E2E: rich fixture 9 Info fields");
      eq(d.removedXmp, true, "worker E2E: rich fixture XMP removed");
      eq(
        d.strippedPieceInfo ?? 0,
        0,
        "worker E2E: rich fixture honest 0 PieceInfo"
      );
      eq(
        d.strippedPageMetadata ?? 0,
        0,
        "worker E2E: rich fixture honest 0 page metadata"
      );
      eq(
        d.strippedAnnotationDates ?? 0,
        0,
        "worker E2E: rich fixture honest 0 annotation dates"
      );
    }

    // alsoXmp:false keeps the catalog XMP (the user's explicit choice) —
    // the page-level privacy strip is NOT optional.
    const keepRun = await drive(
      3,
      { alsoXmp: false },
      new File([bytes as BlobPart], "keepxmp.pdf")
    );
    eq(keepRun.type, "result", "worker E2E: alsoXmp:false → result");
    if (keepRun.type === "result") {
      const d = keepRun.detail as { removedXmp?: boolean; removedInfoFields?: number };
      eq(d.removedXmp, false, "worker E2E: alsoXmp:false keeps XMP (detail honest)");
      eq(d.removedInfoFields, 9, "worker E2E: Info still stripped with alsoXmp:false");
      const outBytes = new Uint8Array(await keepRun.outputs[0]!.blob.arrayBuffer());
      const outDoc = await PDFDocument.load(outBytes, { updateMetadata: false });
      assert(
        outDoc.catalog.get(PDFName.of("Metadata")) !== undefined,
        "worker E2E: catalog XMP survives when the user keeps it"
      );
      eq(
        outDoc.context.trailerInfo.Info,
        undefined,
        "worker E2E: Info still stripped when alsoXmp:false"
      );
    }
  }

  /* ---- 10. WIRING + i18n (audit R3-b) ------------------------------- */
  {
    const protocolSrc = readFileSync("src/lib/workers/protocol.ts", "utf8");
    assert(
      protocolSrc.includes("strippedPieceInfo?: number") &&
        protocolSrc.includes("strippedPageMetadata?: number") &&
        protocolSrc.includes("strippedAnnotationDates?: number"),
      "wiring: protocol RunDetail carries the 3 new strip fields"
    );
    const resultViewSrc = readFileSync(
      "src/components/doco/tool/result-view.tsx",
      "utf8"
    );
    assert(
      resultViewSrc.includes('t("result.rmPieceInfo"') &&
        resultViewSrc.includes('t("result.rmPageMeta"') &&
        resultViewSrc.includes('t("result.rmAnnotDates"'),
      "wiring: result-view renders the 3 new strip chips"
    );
    assert(
      resultViewSrc.includes("runSummary?.removedInfoFields") &&
        resultViewSrc.includes("runSummary?.strippedPieceInfo"),
      "wiring: result-view reads the worker detail keys"
    );
    const workerSrc = readFileSync("tools/remove-pdf-metadata/worker.ts", "utf8");
    assert(
      workerSrc.includes("strippedPieceInfo: report.removedPieceInfo") &&
        workerSrc.includes("strippedPageMetadata: report.removedPageMetadata") &&
        workerSrc.includes("strippedAnnotationDates: report.removedAnnotationDates"),
      "wiring: worker posts the honest per-category counts"
    );
    const panelSrc = readFileSync("tools/remove-pdf-metadata/panel.tsx", "utf8");
    assert(
      panelSrc.includes('t("rmeta.deepNote")'),
      "wiring: panel carries the deep-clean note"
    );
    type I18nCatalog = { result?: Record<string, string>; rmeta?: Record<string, string> };
    const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as I18nCatalog;
    const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as I18nCatalog;
    for (const key of ["rmPieceInfo", "rmPageMeta", "rmAnnotDates"]) {
      const enStr = en.result?.[key];
      const hiStr = hi.result?.[key];
      assert(
        typeof enStr === "string" && enStr.length > 0,
        `i18n: result.${key} EN exists`
      );
      assert(
        typeof hiStr === "string" && hiStr.length > 0,
        `i18n: result.${key} HI exists`
      );
      assert(
        enStr !== hiStr,
        `i18n: result.${key} HI is a real translation (not EN copy)`
      );
    }
    assert(
      typeof en.rmeta?.deepNote === "string" &&
        typeof hi.rmeta?.deepNote === "string" &&
        hi.rmeta.deepNote !== en.rmeta.deepNote,
      "i18n: rmeta.deepNote EN+HI (panel note)"
    );
  }

  console.log("\nALL METADATA CHECKS PASS");
  // House convention: importing any worker keeps bun's event loop alive.
  process.exit(0);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
