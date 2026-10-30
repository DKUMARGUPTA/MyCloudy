import {
  asArr,
  asDict,
  catalogDict,
  decodeStreamBytes,
  decodeTextString,
  parsePdf,
  resolve,
  type PdfObj,
  type ParsedPdf,
} from "@/lib/own/pdf";

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
 *     probe-verified against pdf.worker 4.10.38): the OWN PARSER walks
 *     the raw catalog, resolves each filespec's /EF stream and decodes
 *     it (decodeStreamBytes) — still fully on-device;
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
 * resolved through the own parser, and each filespec's /EF stream is
 * decoded (still on-device — pure structure walking, no network).
 */
export async function afWalkAttachments(
  bytes: Uint8Array
): Promise<RawAttachment[]> {
  const out: RawAttachment[] = [];
  let doc: ParsedPdf;
  try {
    // encryptedOk: an encrypted stream decodes to garbage the XML picker
    // rejects — Path B then decides honestly (the @cantoo
    // ignoreEncryption parity).
    doc = parsePdf(bytes, { encryptedOk: true });
  } catch {
    return out; // unreadable structure → no walk, Path B decides honestly
  }
  try {
    const catalog = catalogDict(doc);
    if (catalog === null) return out;
    const seen = new Set<Map<string, PdfObj>>();
    const filespecs: { name: string; dict: Map<string, PdfObj> }[] = [];

    const textOf = (value: PdfObj | undefined): string => {
      if (value !== undefined && (value.k === "str" || value.k === "lstr" || value.k === "hstr")) {
        return decodeTextString(value.b);
      }
      return "";
    };

    const pushFilespec = (fallback: string, value: PdfObj | undefined): void => {
      const dict = asDict(resolve(doc, value));
      if (dict === undefined) return;
      if (seen.has(dict)) return;
      seen.add(dict);
      const better =
        textOf(dict.get("UF")) || textOf(dict.get("F"));
      filespecs.push({ name: better || fallback, dict });
    };

    // /AF — an array of filespec (refs or dicts).
    const af = asArr(resolve(doc, catalog.get("AF")));
    if (af !== undefined) {
      for (const item of af) pushFilespec("", item);
    }

    // /Names/EmbeddedFiles/Names — flat [name, filespecRef] pairs.
    const namesDict = asDict(resolve(doc, catalog.get("Names")));
    const embedded = namesDict
      ? asDict(resolve(doc, namesDict.get("EmbeddedFiles")))
      : undefined;
    const pairs = embedded
      ? asArr(resolve(doc, embedded.get("Names")))
      : undefined;
    if (pairs !== undefined) {
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        pushFilespec(textOf(pairs[i]), pairs[i + 1]);
      }
    }

    for (const { name, dict } of filespecs) {
      const ef = asDict(resolve(doc, dict.get("EF")));
      if (ef === undefined) continue;
      const streamValue = ef.get("UF") ?? ef.get("F");
      const stream = resolve(doc, streamValue);
      if (stream === undefined || stream.k !== "stream") continue;
      const decoded = decodeStreamBytes(stream.raw, stream.m);
      out.push({ name, bytes: decoded });
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
