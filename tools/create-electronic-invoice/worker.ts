import {
  catalogDict,
  listPages,
  parsePdf,
  resolveTrailerRef,
  PdfError,
  type PdfObj,
} from "@/lib/own/pdf";

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
import { attachFacturx } from "./facturx-attach";
import {
  FACTUR_X_FILENAME,
  type CeiDetail,
  type CiiShape,
} from "./types";

/**
 * create-electronic-invoice worker (RB5-b, device mode) — the OWN-ENGINE
 * edition.
 *
 * Turns (one existing PDF + one CII XML) into a Factur-X-shaped hybrid
 * invoice, 100% on-device, in ONE pass (the pdf-lib build needed a
 * attach-then-reload-then-patch dance because attach() omitted
 * /AFRelationship; the own-engine surgery authors the complete Filespec —
 * /Type /Filespec, /F, /UF, /Desc, /EF, /AFRelationship /Alternative —
 * plus catalog /AF + /Names/EmbeddedFiles merges and the XMP /Metadata
 * stream in a single rewriteDocument pass, classic output, object
 * streams OFF: Factur-X readers had issues with attachments + XMP inside
 * /ObjStm containers, so the final file keeps every object loose).
 *
 * HONEST scope: pages are preserved untouched; no PDF/A-3 conversion
 * happens (no ICC profile, no output intent). The report says whether the
 * SOURCE already carried PDF/A markers.
 */

const PRODUCER = "DocoPDF";

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

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
 * The catalog /Metadata stream text of the parsed doc ("" when absent or
 * not a raw stream) — used for the honest source-PDF/A sniff (pdfaid).
 */
function existingXmpText(doc: ReturnType<typeof parsePdf>): string {
  const catalog = catalogDict(doc);
  if (catalog === null) return "";
  const meta = resolveTrailerRef(doc, catalog.get("Metadata"));
  if (meta === undefined || meta.k !== "stream") return "";
  return decodeUtf8(meta.raw);
}

/** Source carried an /OutputIntents entry with content (the PDF/A marker). */
function hasOutputIntent(doc: ReturnType<typeof parsePdf>): boolean {
  const catalog = catalogDict(doc);
  if (catalog === null) return false;
  const intents = resolveTrailerRef(doc, catalog.get("OutputIntents"));
  if (intents === undefined) return false;
  const items = intents.k === "arr" ? intents.items : [];
  return items.length > 0;
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

  post({ type: "progress", runId, pct: 40, stage: "processing" });
  // ONE-PASS own-engine surgery: EmbeddedFile + Filespec
  // (/AFRelationship /Alternative) + /AF + /Names merges + the model's
  // XMP packet, classic rewrite. Encrypted sources refuse typed.
  let pageCount: number;
  let sourceOutputIntent: boolean;
  let sourceXmpPdfaid: boolean;
  let saved: Uint8Array;
  try {
    const parsed = parsePdf(pdfBytes);
    pageCount = listPages(parsed).length;
    if (pageCount < 1) {
      post({ type: "error", runId, code: "tool.errorCorrupt" });
      return;
    }
    // Honest source-PDF/A sniff (before we touch anything).
    sourceOutputIntent = hasOutputIntent(parsed);
    sourceXmpPdfaid = /pdfaid:/i.test(existingXmpText(parsed));
    const xmp = buildXmpPacket(level, PRODUCER);
    ({ bytes: saved } = await attachFacturx(pdfBytes, xmlBytes, {
      claimPdfa: false,
      producer: PRODUCER,
      xmpOverride: xmp,
    }));
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      post({ type: "error", runId, code: "tool.errorEncrypted" });
      return;
    }
    throw error;
  }
  const patch = {
    afPresent: true,
    afContainsFilespec: true,
    filespecFound: true,
    afRelationshipAdded: false,
  };
  const xmpWritten = true;

  post({ type: "progress", runId, pct: 88, stage: "saving" });

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
