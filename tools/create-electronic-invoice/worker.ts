import {
  AFRelationship,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
} from "pdf-lib";
import type { PDFRef } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import {
  buildXmpPacket,
  classifyCeiError,
  normalizeLevel,
  validateCiiShape,
} from "./model";
import {
  FACTUR_X_FILENAME,
  type CeiDetail,
  type CiiShape,
} from "./types";

/**
 * create-electronic-invoice worker (RB5-b, device mode).
 *
 * Turns (one existing PDF + one CII XML) into a Factur-X-shaped hybrid
 * invoice, 100% on-device. PROBE-VERIFIED pdf-lib 1.17.1 behaviour this
 * worker relies on (scripts/probe-rb5b-attach.ts, deleted after use):
 *
 *  - doc.attach(bytes, "factur-x.xml", …) writes the EmbeddedFile stream
 *    (flate), the Filespec dict (/Type /Filespec /F /UF /EF /Desc) and
 *    pushes the Filespec ref into BOTH the catalog /AF array and
 *    /Names/EmbeddedFiles — the attach() API DOES create /AF.
 *  - /AFRelationship is NOT written by default — but 1.17.1 accepts the
 *    afRelationship option (belt). The worker ALSO runs a low-level patch
 *    pass (suspenders): after the attach-save, the Filespec is located in
 *    the context and /AFRelationship /Alternative + /Type /Filespec + /F
 *    /UF are FORCED — the same catalog-surgery toolkit as
 *    remove-pdf-metadata / web-optimize-pdf.
 *
 * The XMP /Metadata stream is written by hand (PDFRawStream.of + context
 * register + catalog.set) — the web-optimize-pdf engine's pattern — with
 * the Factur-X properties readers parse.
 *
 * Output is saved with useObjectStreams: FALSE — Factur-X readers had
 * issues with attachments + XMP inside /ObjStm containers, so the final
 * file keeps every object loose.
 *
 * HONEST scope: pages are preserved untouched; no PDF/A-3 conversion
 * happens (no ICC profile, no output intent). The report says whether the
 * SOURCE already carried PDF/A markers.
 */

const PRODUCER = "MyCloudy (mycloudy.in)";

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

const isRef = (obj: unknown): obj is PDFRef =>
  typeof obj === "object" && obj !== null && "objectNumber" in obj;

/** True when the first bytes are %PDF-. */
async function sniffIsPdf(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  return (
    head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 &&
    head[3] === 0x46 && head[4] === 0x2d
  );
}

/** True when the first non-BOM, non-whitespace byte is "<". */
async function sniffIsXml(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  let i = 0;
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;
  while (i < head.length) {
    const c = head[i];
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      i += 1;
      continue;
    }
    return c === 0x3c; // "<"
  }
  return false;
}

/** Decode bytes as UTF-8 text (BOM tolerated). */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * The catalog /Metadata stream text of the loaded doc ("" when absent or
 * not a raw stream) — used for the honest source-PDF/A sniff (pdfaid).
 */
function existingXmpText(doc: PDFDocument): string {
  const metaObj = doc.catalog.get(PDFName.of("Metadata"));
  if (!isRef(metaObj)) return "";
  const stream = doc.context.lookup(metaObj);
  if (!(stream instanceof PDFRawStream)) return "";
  return decodeUtf8(stream.contents);
}

/** Source carried an /OutputIntents entry (the PDF/A marker). */
function hasOutputIntent(doc: PDFDocument): boolean {
  const intents = doc.catalog.get(PDFName.of("OutputIntents"));
  if (intents === undefined) return false;
  const resolved = doc.context.lookupMaybe(intents as never, PDFArray);
  return resolved !== undefined && resolved.size() > 0;
}

interface PatchResult {
  filespecFound: boolean;
  afPresent: boolean;
  /** The patch pass itself added /AFRelationship (pdf-lib default omit). */
  afRelationshipAdded: boolean;
  /** The Filespec ref is inside the catalog /AF array. */
  afContainsFilespec: boolean;
}

/**
 * The low-level Factur-X patch pass (web-optimize-pdf's engine toolkit):
 * find the factur-x.xml Filespec among the indirect objects, FORCE
 * /AFRelationship /Alternative + /Type /Filespec + /F /UF, and make sure
 * the catalog /AF array holds its ref. Idempotent by construction.
 */
function patchFacturXFilespec(doc: PDFDocument): PatchResult {
  const result: PatchResult = {
    filespecFound: false,
    afPresent: false,
    afRelationshipAdded: false,
    afContainsFilespec: false,
  };
  let filespecRef: PDFRef | null = null;

  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of("Type")) !== PDFName.of("Filespec")) continue;
    // Match OUR attachment (a source PDF may already carry other files):
    // the /UF hex string or the /F literal must decode to factur-x.xml.
    const uf = obj.get(PDFName.of("UF"));
    const f = obj.get(PDFName.of("F"));
    const ufText =
      uf instanceof PDFHexString ? uf.decodeText() : "";
    const fText = f instanceof PDFString ? f.asString() : "";
    if (ufText !== FACTUR_X_FILENAME && fText !== FACTUR_X_FILENAME) {
      continue;
    }
    filespecRef = ref;
    result.filespecFound = true;
    if (obj.get(PDFName.of("AFRelationship")) === undefined) {
      result.afRelationshipAdded = true;
    }
    obj.set(PDFName.of("Type"), PDFName.of("Filespec"));
    obj.set(PDFName.of("AFRelationship"), PDFName.of("Alternative"));
    obj.set(PDFName.of("F"), PDFString.of(FACTUR_X_FILENAME));
    obj.set(PDFName.of("UF"), PDFHexString.fromText(FACTUR_X_FILENAME));
    break;
  }

  // Catalog /AF: attach() creates it, but a hostile/weird source may not
  // have allowed that — make sure it exists and holds the Filespec ref.
  const afRaw = doc.catalog.get(PDFName.of("AF"));
  let afArray = doc.context.lookupMaybe(afRaw as never, PDFArray);
  if (afArray === undefined) {
    afArray = doc.context.obj([]);
    doc.catalog.set(PDFName.of("AF"), afArray);
  }
  result.afPresent = true;
  if (filespecRef !== null) {
    for (let i = 0; i < afArray.size(); i += 1) {
      if (String(afArray.get(i)) === String(filespecRef)) {
        result.afContainsFilespec = true;
        break;
      }
    }
    if (!result.afContainsFilespec) {
      afArray.push(filespecRef);
      result.afContainsFilespec = true;
    }
  }
  return result;
}

/**
 * Writes the Factur-X XMP packet into the catalog /Metadata as an
 * UNCOMPRESSED stream (readers parse it raw). A source /Metadata stream,
 * if any, is dropped object-level (remove-pdf-metadata precedent).
 */
function writeXmpMetadata(doc: PDFDocument, xmp: string): boolean {
  const oldMeta = doc.catalog.get(PDFName.of("Metadata"));
  if (isRef(oldMeta)) {
    doc.context.delete(oldMeta);
  }
  const dict = PDFDict.withContext(doc.context);
  dict.set(PDFName.of("Type"), PDFName.of("Metadata"));
  dict.set(PDFName.of("Subtype"), PDFName.of("XML"));
  const stream = PDFRawStream.of(dict, encodeUtf8(xmp));
  const ref = doc.context.register(stream);
  doc.catalog.set(PDFName.of("Metadata"), ref);
  return true;
}

/** utf-8 encode that never throws (lone surrogates become U+FFFD). */
function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;

  // Classify the two inputs by content, not order.
  let pdfFile: File | null = null;
  let xmlFile: File | null = null;
  for (const file of files) {
    if (pdfFile === null && (await sniffIsPdf(file))) {
      pdfFile = file;
      continue;
    }
    if (xmlFile === null && (await sniffIsXml(file))) {
      xmlFile = file;
    }
  }
  if (pdfFile === null) {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }
  if (xmlFile === null) {
    post({ type: "error", runId, code: "cei.errorNoXml" });
    return;
  }

  // XML structural sniff BEFORE touching the PDF — refuse non-CII roots
  // honestly (embedding them as factur-x.xml would produce a file
  // Factur-X readers reject).
  const xmlBytes = new Uint8Array(await xmlFile.arrayBuffer());
  const xmlText = decodeUtf8(xmlBytes);
  const shape: CiiShape = validateCiiShape(xmlText);
  if (!shape.rootOk) {
    post({ type: "error", runId, code: "cei.errorNotCii" });
    return;
  }
  const level = normalizeLevel(options.level);

  post({ type: "progress", runId, pct: 10, stage: "reading" });
  const pdfBytes = new Uint8Array(await pdfFile.arrayBuffer());
  const doc = await PDFDocument.load(pdfBytes, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const pageCount = doc.getPageCount();
  if (pageCount < 1) {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  // Honest source-PDF/A sniff (before we touch anything).
  const sourceOutputIntent = hasOutputIntent(doc);
  const sourceXmpPdfaid = /pdfaid:/i.test(existingXmpText(doc));

  post({ type: "progress", runId, pct: 40, stage: "processing" });
  // Stage 1: attach — pdf-lib writes the EmbeddedFile + Filespec and
  // pushes the ref into catalog /AF (probe-verified). The afRelationship
  // option is the BELT; the patch pass below is the suspenders.
  await doc.attach(xmlBytes, FACTUR_X_FILENAME, {
    mimeType: "text/xml",
    description: "Factur-X Invoice",
    creationDate: new Date(),
    modificationDate: new Date(),
    afRelationship: AFRelationship.Alternative,
  });
  const stage1 = await doc.save({ useObjectStreams: false });

  post({ type: "progress", runId, pct: 65, stage: "processing" });
  // Stage 2: reload, patch the Filespec (AFRelationship /Alternative),
  // write the XMP metadata, save with object streams OFF.
  const doc2 = await PDFDocument.load(stage1, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const patch = patchFacturXFilespec(doc2);
  const xmp = buildXmpPacket(level, PRODUCER);
  const xmpWritten = writeXmpMetadata(doc2, xmp);

  post({ type: "progress", runId, pct: 88, stage: "saving" });
  // useObjectStreams: false — attachments + XMP stay loose; some
  // Factur-X readers mishandle them inside compressed /ObjStm.
  const saved = await doc2.save({ useObjectStreams: false });

  const detail: CeiDetail = {
    files: 1,
    pages: pageCount,
    beforeBytes: pdfBytes.length,
    afterBytes: saved.length,
    attachmentName: FACTUR_X_FILENAME,
    attachmentBytes: xmlBytes.length,
    conformanceLevel: level,
    afPresent: patch.afPresent && patch.afContainsFilespec,
    afRelationshipAlternative: patch.filespecFound,
    xmpWritten,
    xmlShapeOk: shape.ok,
    xmlInvoiceId: shape.invoiceId,
    xmlCurrency: shape.currency,
    xmlLineCount: shape.lineCount,
    sourceOutputIntent,
    sourceXmpPdfaid,
  };

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${fileBaseName(pdfFile.name)}-facturx.pdf`,
        mime: "application/pdf",
        blob: new Blob([saved as BlobPart], { type: "application/pdf" }),
      },
    ],
    detail,
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    post({
      type: "error",
      runId: data.runId,
      code: classifyCeiError(error),
    });
  });
};
