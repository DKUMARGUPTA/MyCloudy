import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument as CantooPDF,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from "@cantoo/pdf-lib";

import type {
  WorkerRunRequest,
  WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import {
  buildInvoiceJson,
  classifyError,
  linesFromItems,
  MAX_CHARS,
  outputBaseName,
  parseRunOptions,
  parseXml,
  pickXmlAttachment,
  sanitizeAttachmentName,
  sniffInvoice,
  summarizeCii,
  type PdfTextItemInput,
} from "./model";
import type { PdfToEInvoiceDetail } from "./types";

/**
 * PDF → e-invoice worker (RB5-c) — 100% on-device, EN+हिंदी.
 *
 * Protocol (the pdf-to-markdown recipe, extended with attachments):
 *
 *  1. parseRunOptions — the surface syncs its options as the "run"
 *     JSON payload (the repair-pdf pattern): locale, fallback word,
 *     Path B page cap;
 *  2. pdf.js getDocument on a COPY of the buffer (the pinned lesson:
 *     pdf.js transfers + detaches the ArrayBuffer it receives — the
 *     original bytes must survive for the raw-catalog walk below);
 *  3. PATH A, attempt 1 — pdf.js getAttachments() (it reads the
 *     /Names/EmbeddedFiles name tree): pick the XML attachment by the
 *     standard names (factur-x.xml, zugferd-invoice.xml, …, any .xml);
 *  4. PATH A, attempt 2 — some producers attach OUTSIDE the name tree
 *     (an /AF array of Filespecs only, which pdf.js never looks at —
 *     probe-verified against pdf.worker 4.10.38): @cantoo/pdf-lib
 *     walks the raw catalog, resolves each filespec's /EF stream and
 *     decodes it — still fully on-device;
 *  5. PATH B — no XML anywhere: getTextContent per page under the
 *     honesty caps (page cap, char cap), the pure model groups the
 *     items into lines and sniffs the fields (best-effort, every hit
 *     with its source snippet and confidence);
 *  6. Output — Path A: the raw .xml file (byte-exact, its own
 *     attachment name) + the field summary in the run detail; Path B:
 *     invoice.json + the same summary shape. Fields NOT found are
 *     listed in the summary's missingKeys — never invented.
 *
 * Honest error taxonomy: encrypted → tool.errorEncrypted (pdf.js asks
 * for a password); unreadable → tool.errorCorrupt; a file that opens
 * but has NO XML and NO selectable text is NOT called corrupt — it
 * gets peinv.errorNoInvoice ("no embedded XML and no selectable text
 * — this PDF is not an e-invoice"), with the OCR tool suggested.
 */

/* ------------------------------------------------------------------ */
/* Loose pdf.js shapes (the smoke drives the same code in-process)     */
/* ------------------------------------------------------------------ */

export interface PdfjsPageLike {
  getTextContent(): Promise<{ items?: unknown }>;
  cleanup?(): void;
}

export interface PdfjsDocLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfjsPageLike>;
  getAttachments?(): Promise<unknown>;
  cleanup?(): Promise<void>;
  destroy?(): Promise<void>;
}

export interface PdfjsLike {
  getDocument(
    options: Record<string, unknown>
  ): { promise: Promise<PdfjsDocLike>; destroy(): Promise<void> };
}

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/* ------------------------------------------------------------------ */
/* Attachment picking                                                   */
/* ------------------------------------------------------------------ */

export interface RawAttachment {
  name: string;
  bytes: Uint8Array;
}

/** pdf.js getAttachments() shape (loose — unknown fields ignored). */
interface PdfjsAttachment {
  filename?: unknown;
  content?: unknown;
}

/** Reads the attachments pdf.js reports (name tree only). */
export function attachmentsFromPdfjs(
  raw: unknown
): RawAttachment[] {
  if (typeof raw !== "object" || raw === null) return [];
  const out: RawAttachment[] = [];
  for (const [key, value] of Object.entries(
    raw as Record<string, PdfjsAttachment>
  )) {
    if (typeof value !== "object" || value === null) continue;
    const content = value.content;
    if (!(content instanceof Uint8Array)) continue;
    const name =
      typeof value.filename === "string" && value.filename.length > 0
        ? value.filename
        : key;
    out.push({ name, bytes: content });
  }
  return out;
}

/**
 * The raw-catalog walk for producers that attach OUTSIDE the name
 * tree: every /AF filespec + the /Names/EmbeddedFiles flat array is
 * resolved through @cantoo/pdf-lib, and each filespec's /EF stream is
 * decoded (still on-device — pure structure walking, no network).
 */
export async function afWalkAttachments(
  bytes: Uint8Array
): Promise<RawAttachment[]> {
  const out: RawAttachment[] = [];
  let pdf: CantooPDF;
  try {
    pdf = await CantooPDF.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
  } catch {
    return out; // unreadable structure → no walk, Path B decides honestly
  }
  try {
    const ctx = pdf.context;
    const catalog = pdf.catalog as unknown as PDFDict;
    const seen = new Set<string>();
    const filespecs: { name: string; dict: PDFDict }[] = [];

    const textOfPdfStringish = (value: unknown): string => {
      if (value instanceof PDFHexString) return value.decodeText();
      if (value instanceof PDFString) return value.asString();
      return "";
    };

    const pushFilespec = (name: string, value: unknown): void => {
      const dict =
        value instanceof PDFRef
          ? ctx.lookupMaybe(value, PDFDict)
          : value instanceof PDFDict
            ? value
            : undefined;
      if (dict === undefined) return;
      const key = dict.toString();
      if (seen.has(key)) return;
      seen.add(key);
      const better =
        textOfPdfStringish(dict.get(PDFName.of("UF"))) ||
        textOfPdfStringish(dict.get(PDFName.of("F")));
      filespecs.push({ name: better || name, dict });
    };

    // /AF — an array of filespec (refs or dicts).
    const af = catalog.get(PDFName.of("AF"));
    if (af instanceof PDFArray) {
      for (let i = 0; i < af.size(); i += 1) {
        pushFilespec("", af.get(i));
      }
    }

    // /Names/EmbeddedFiles/Names — flat [name, filespecRef] pairs.
    const names = ctx.lookupMaybe(catalog.get(PDFName.of("Names")), PDFDict);
    const embedded = names
      ? ctx.lookupMaybe(names.get(PDFName.of("EmbeddedFiles")), PDFDict)
      : undefined;
    const pairs = embedded
      ? ctx.lookupMaybe(embedded.get(PDFName.of("Names")), PDFArray)
      : undefined;
    if (pairs instanceof PDFArray) {
      for (let i = 0; i + 1 < pairs.size(); i += 2) {
        const name = textOfPdfStringish(pairs.get(i));
        pushFilespec(name, pairs.get(i + 1));
      }
    }

    for (const { name, dict } of filespecs) {
      const ef = ctx.lookupMaybe(dict.get(PDFName.of("EF")), PDFDict);
      if (ef === undefined) continue;
      // lookupMaybe has NO PDFRawStream overload — the RB1 pinned
      // lesson: look up the PDFStream base class, then narrow.
      const streamValue =
        ef.get(PDFName.of("UF")) ?? ef.get(PDFName.of("F"));
      const stream = ctx.lookupMaybe(streamValue as PDFRef, PDFStream);
      if (!(stream instanceof PDFRawStream)) continue;
      const decoded = decodePDFRawStream(stream).decode();
      out.push({ name, bytes: new Uint8Array(decoded) });
    }
    return out;
  } catch {
    return out; // any surprise keeps whatever was resolved so far
  }
}

/* ------------------------------------------------------------------ */
/* Run                                                                  */
/* ------------------------------------------------------------------ */

async function run(request: WorkerRunRequest): Promise<void> {
  const pdfjs = await loadPdfjsInWorker();
  await runWithPdfjs(request, pdfjs as unknown as PdfjsLike);
}

/**
 * The whole pipeline, parametric on the pdf.js module so the smoke
 * can drive the REAL worker code in-process (pdfjs-dist/legacy in
 * bun) — the same function the browser worker runs.
 */
export async function runWithPdfjs(
  request: WorkerRunRequest,
  pdfjs: PdfjsLike
): Promise<void> {
  const runId = request.runId;

  // The surface syncs its payload as options.run (repair-pdf pattern).
  let raw: Record<string, unknown> = {};
  const runPayload = (request.options as Record<string, unknown>)?.run;
  if (typeof runPayload === "string") {
    try {
      const parsed: unknown = JSON.parse(runPayload);
      if (typeof parsed === "object" && parsed !== null) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      raw = {};
    }
  } else if (typeof request.options === "object" && request.options !== null) {
    raw = request.options as Record<string, unknown>;
  }
  const opts = parseRunOptions(raw);

  const file = request.files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 10, stage: "reading" });

  const bytes = new Uint8Array(await file.arrayBuffer());

  // PINNED LESSON: pdf.js transfers + detaches the buffer it is
  // handed — pass a COPY so `bytes` stays valid for the /AF walk.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  });
  let doc: PdfjsDocLike;
  try {
    doc = await task.promise;
  } catch (error) {
    // Encrypted (password) / unreadable — the honest taxonomy, posted
    // from the real path (the onmessage catch is belt-and-braces).
    const message = error instanceof Error ? error.message : String(error);
    post({ type: "error", runId, code: classifyError(message) });
    await task.destroy().catch(() => undefined);
    return;
  }

  try {
    const pageCount = doc.numPages;
    post({ type: "progress", runId, pct: 20, stage: "processing" });

    /* ---------------- Path A, attempt 1: pdf.js name tree -------- */
    let candidates = attachmentsFromPdfjs(
      await doc.getAttachments?.().catch(() => null)
    );
    let foundVia: "pdfjs" | "af-walk" = "pdfjs";
    let xml = pickXmlAttachment(candidates);

    /* ---------------- Path A, attempt 2: raw /AF walk ------------- */
    if (xml === null) {
      candidates = await afWalkAttachments(bytes);
      xml = pickXmlAttachment(candidates);
      foundVia = "af-walk";
    }

    if (xml !== null) {
      // Path A — the honest, standards path.
      const xmlText = new TextDecoder("utf-8").decode(xml.bytes);
      const root = parseXml(xmlText);
      const summary = summarizeCii(root);
      summary.attachmentName = xml.name;
      summary.foundVia = foundVia;

      post({ type: "progress", runId, pct: 85, stage: "saving" });

      const detail: PdfToEInvoiceDetail = {
        files: 1,
        pages: pageCount,
        ePath: "A",
        fieldsFound: summary.fields.length,
        summary,
      };
      post({
        type: "result",
        runId,
        outputs: [
          {
            name: sanitizeAttachmentName(xml.name),
            mime: "application/xml",
            blob: new Blob([xml.bytes as unknown as BlobPart], {
              type: "application/xml",
            }),
          },
        ],
        detail,
      });
      return;
    }

    /* ---------------- Path B: layout sniff (best-effort) --------- */
    const pages: PdfTextItemInput[][] = [];
    const limit = Math.min(pageCount, opts.maxPages);
    let chars = 0;
    let truncated = pageCount > limit;
    for (let i = 0; i < limit; i += 1) {
      const page = await doc.getPage(i + 1);
      const content = await page.getTextContent();
      page.cleanup?.();
      const items = (content.items ?? []) as PdfTextItemInput[];
      pages.push(items);
      for (const item of items) {
        if (typeof item?.str === "string") chars += item.str.trim().length;
      }
      if (chars > MAX_CHARS) {
        truncated = true;
        break;
      }
      post({
        type: "progress",
        runId,
        pct: 20 + Math.round((50 * (i + 1)) / limit),
        stage: "processing",
        detail: { page: i + 1, pages: limit },
      });
    }

    // A file with no XML and no selectable text is NOT corrupt — it
    // is simply not an e-invoice (a scan, or not an invoice at all).
    // Say exactly that, never a fake error.
    if (chars === 0) {
      post({
        type: "error",
        runId,
        code: "peinv.errorNoInvoice",
        detail: file.name,
      });
      return;
    }

    const lines = linesFromItems(pages);
    const summary = sniffInvoice(lines, pages.length, truncated);

    post({ type: "progress", runId, pct: 85, stage: "saving" });

    const json = buildInvoiceJson(summary, { sourceName: file.name });
    const detail: PdfToEInvoiceDetail = {
      files: 1,
      pages: pages.length,
      ePath: "B",
      fieldsFound: summary.fields.length,
      summary,
    };
    const jsonName = `${outputBaseName(file.name, opts.locale, opts.fileWord)}.json`;
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: jsonName,
          mime: "application/json",
          blob: new Blob([json], { type: "application/json" }),
        },
      ],
      detail,
    });
  } finally {
    await doc.cleanup?.().catch(() => undefined);
    await task.destroy().catch(() => undefined);
  }
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId: data.runId,
      code: classifyError(message),
    });
  });
};
