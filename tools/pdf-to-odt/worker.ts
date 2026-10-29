import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
// P6-v: the style enrichment lives on the OWN engine now (one shared port
// for all four pdf-to-X extractors — parsePdf + listPages + our own stream
// decoders under the same correlation semantics).
import { buildFontStyleMap } from "../pdfjs-common/font-style-map";

// Re-exported for the smoke, which drives the same enrichment on real
// fixtures through the worker's own surface.
export { buildFontStyleMap };
import {
  buildOdt,
  coerceRunOptions,
  docTitleFrom,
  extractOdtBlocks,
  ODT_MIME,
  odtStats,
  outputBaseName,
  pageBlocksOf,
  pdfErrorMessageToCode,
  type FontStyleInfo,
  type OdtBlock,
  type OdtDocModel,
  type PdfTextItemInput,
} from "./model";

/**
 * PDF → OpenDocument Text worker (RB4-d). 100% on-device: pdf.js runs
 * INSIDE this worker (fake-worker mode, the pdf-to-txt recipe), the
 * file arrives by structured clone and the .odt Blob leaves the same
 * way — zero network. The package is written by the model's fflate
 * zipSync, shaped exactly for the odt-to-pdf parser to read back.
 *
 *  1. coerceRunOptions — pages range, the one-file-per-page switch,
 *     locale + the localized fallback word;
 *  2. pdf.js getDocument on a COPY of the buffer (pinned lesson: pdf.js
 *     transfers + detaches the ArrayBuffer it receives — the original
 *     bytes must survive for the font pass below), one getTextContent
 *     per selected page, page.cleanup() + doc.destroy() afterwards;
 *  3. buildFontStyleMap — pdf.js 4.x reports only internal font ids
 *     ("g_d0_f3"), never the real names, so bold/italic is recovered
 *     from the PDF itself (the pdf-to-word enrichment, extended with
 *     italic): each page's distinct item ids (first-use order) are
 *     zipped with the page's distinct /Font resource keys in Tf
 *     first-use order; a BaseFont like "Helvetica-Bold" or
 *     "Helvetica-Oblique" marks the id. Any mismatch (form XObjects,
 *     inherited resources, Type3) skips that page's enrichment — styles
 *     degrade honestly to the font-name regex only;
 *  4. extractOdtBlocks + buildOdt — a single .odt, or one .odt per
 *     page (multi-output; the shared result view offers per-file
 *     download plus "Download all (ZIP)").
 *
 * Scanned PDFs (zero selectable text) fail with tool.errorNoText —
 * honest, same as pdf-to-word/pdf-to-txt. The dc:title comes from the
 * PDF's own info dictionary (getMetadata), falling back to the first
 * heading.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/* ------------------------------------------------------------------ */
/* Font-style enrichment (pdf.js id → PDF font table)                  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, files } = request;
  const opts = coerceRunOptions(request.options as Record<string, unknown>);

  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 10, stage: "reading" });
  const pdfjs = await loadPdfjsInWorker();
  // PINNED LESSON: pdf.js transfers + detaches the buffer it is handed —
  // pass a COPY so `bytes` stays valid for the font pass afterwards.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;
  post({ type: "progress", runId, pct: 15, stage: "processing" });

  try {
    const pageNumbers = parsePageSpec(opts.pages, doc.numPages);
    if (pageNumbers === null || pageNumbers.length === 0) {
      post({ type: "error", runId, code: "tool.errorInvalidPages" });
      return;
    }

    // Document title: the PDF's own info dictionary, if it carries one.
    let info: unknown = null;
    try {
      const meta = await doc.getMetadata();
      info = meta?.info ?? null;
    } catch {
      /* metadata is optional */
    }

    const pages: PdfTextItemInput[][] = [];
    let chars = 0;
    for (let i = 0; i < pageNumbers.length; i += 1) {
      const page = await doc.getPage(pageNumbers[i] as number + 1);
      let content;
      try {
        content = await page.getTextContent();
      } finally {
        page.cleanup();
      }
      const items = content.items as PdfTextItemInput[];
      pages.push(items);
      for (const item of items) {
        if (typeof item.str === "string") chars += item.str.trim().length;
      }
      post({
        type: "progress",
        runId,
        pct: 15 + Math.round((65 * (i + 1)) / pageNumbers.length),
        stage: "processing",
        detail: { page: i + 1, pages: pageNumbers.length },
      });
    }

    // Scans have zero selectable text — fail honestly instead of
    // shipping an empty package (the pdf-to-word precedent; the FAQ
    // suggests the OCR tool for this exact case).
    if (chars === 0) {
      post({
        type: "error",
        runId,
        code: "tool.errorNoText",
        detail: file.name,
      });
      return;
    }

    const styleMap = await buildFontStyleMap(bytes, pages);
    const model = extractOdtBlocks(pages, { styleMap });

    post({ type: "progress", runId, pct: 85, stage: "saving" });

    // Title fallback: the first heading's joined text.
    const firstHeading = model.blocks.find(
      (b) => b.headingLevel !== undefined
    );
    const fallbackTitle = firstHeading
      ? firstHeading.runs.map((r) => r.text).join("").trim()
      : "";
    const title = docTitleFrom(info, fallbackTitle);

    const base = outputBaseName(file.name, opts.locale, opts.fileWord);
    const style = { bodyPt: model.bodyPt, headingPt: model.headingPt };

    const outputs: { name: string; mime: string; blob: Blob }[] = [];
    if (opts.perPage) {
      // One honest .odt per selected page (empty pages keep one empty
      // paragraph — the builder guarantees a valid body).
      for (let i = 0; i < pageNumbers.length; i += 1) {
        const blocks: OdtBlock[] = pageBlocksOf(
          model as OdtDocModel,
          pageNumbers[i] as number
        );
        const pageOdt = buildOdt(blocks, { ...style, title });
        outputs.push({
          name: `${base}-page${(pageNumbers[i] as number) + 1}.odt`,
          mime: ODT_MIME,
          blob: new Blob([pageOdt as unknown as BlobPart], {
            type: ODT_MIME,
          }),
        });
      }
    } else {
      const odt = buildOdt(model.blocks, { ...style, title });
      outputs.push({
        name: `${base}.odt`,
        mime: ODT_MIME,
        blob: new Blob([odt as unknown as BlobPart], { type: ODT_MIME }),
      });
    }

    const stats = odtStats(model.blocks);
    post({
      type: "result",
      runId,
      outputs,
      detail: {
        files: outputs.length,
        pages: pageNumbers.length,
        paragraphs: stats.paragraphs,
        headings: stats.headings,
      },
    });
  } finally {
    await doc.destroy().catch(() => undefined);
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
      code: pdfErrorMessageToCode(message),
    });
  });
};
