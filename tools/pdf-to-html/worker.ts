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
  buildHtml,
  coerceRunOptions,
  docStats,
  extractDocument,
  layoutLineCount,
  outputBaseName,
  pdfErrorMessageToCode,
  type FontStyle,
  type PdfTextItemInput,
} from "./model";

/**
 * PDF → HTML worker (RB4-b). 100% on-device, EN + हिंदी: pdf.js runs
 * INSIDE this worker (fake-worker mode, the pdf-to-txt/pdf-to-word
 * recipe), the file arrives by structured clone and the single
 * self-contained .html Blob leaves the same way — zero network.
 *
 * Pipeline:
 *  1. coerceRunOptions — mode (flow/layout), page-number markers,
 *     page range, locale + localized fallback word;
 *  2. pdf.js getDocument on a FRESH copy (pinned lesson: pdf.js
 *     transfers + detaches the buffer it receives — the original
 *     bytes must survive for the font pass), one getTextContent per
 *     SELECTED page, page.cleanup() + doc.destroy() afterwards;
 *  3. <title> — the PDF's own metadata Title, falling back to the
 *     first h1 text, then the file name;
 *  4. buildFontStyleMap — pdf.js 4.x reports only internal font ids
 *     ("g_d0_f3"), never the real names, so bold AND italic are
 *     recovered from the PDF itself (the pdf-to-word correlation:
 *     each page's distinct item ids zipped with the page's distinct
 *     /Font resource keys in Tf first-use order; BaseFont names like
 *     "Helvetica-Bold" / "Helvetica-Oblique" carry the style);
 *  5. extractDocument + buildHtml → one .html download.
 *
 * Honest failure modes: a PDF with NO selectable text anywhere stops
 * with tool.errorNoText (scans need the OCR tool first — never an
 * empty file); encrypted files stop with tool.errorEncrypted;
 * unreadable bytes with tool.errorCorrupt.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  fontName?: unknown;
}
/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

async function run(request: WorkerRunRequest): Promise<void> {
  const runId = request.runId;
  const opts = coerceRunOptions(request.options as Record<string, unknown>);
  const file = request.files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 10, stage: "reading" });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdfjs = await loadPdfjsInWorker();

  // PINNED LESSON: pdf.js transfers + detaches the buffer it is handed —
  // pass a COPY so `bytes` stays valid for the font pass afterwards.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  });
  const doc = await task.promise;

  try {
    const pageNumbers = parsePageSpec(opts.pages, doc.numPages);
    if (pageNumbers === null || pageNumbers.length === 0) {
      post({ type: "error", runId, code: "tool.errorInvalidPages" });
      return;
    }

    post({ type: "progress", runId, pct: 15, stage: "processing" });

    /* ---- <title>: metadata → first h1 → file name (honest cascade) ---- */
    let title = "";
    try {
      const meta = await doc.getMetadata();
      const info = (meta as { info?: { Title?: unknown } }).info;
      if (typeof info?.Title === "string") title = info.Title.trim().slice(0, 120);
    } catch {
      // No readable metadata → the heading/file-name fallbacks apply.
    }

    /* ---- one getTextContent per selected page ---- */
    const items: PdfTextItemInput[][] = [];
    const widths: number[] = [];
    const heights: number[] = [];
    let chars = 0;
    for (let i = 0; i < pageNumbers.length; i += 1) {
      const page = await doc.getPage(pageNumbers[i] + 1);
      const viewport = page.getViewport({ scale: 1 });
      let content;
      try {
        content = await page.getTextContent();
      } finally {
        page.cleanup();
      }
      const pageItems = content.items as RawTextItem[];
      items.push(pageItems);
      widths.push(viewport.width);
      heights.push(viewport.height);
      for (const item of pageItems) {
        if (typeof item.str === "string") chars += item.str.trim().length;
      }
      post({
        type: "progress",
        runId,
        pct: 15 + Math.round((55 * (i + 1)) / pageNumbers.length),
        stage: "processing",
        detail: { page: i + 1, pages: pageNumbers.length },
      });
    }

    // Scans have zero selectable text — fail honestly instead of
    // shipping an empty file (the pdf-to-word/pdf-to-txt precedent;
    // the FAQ suggests the OCR tool for this exact case).
    if (chars === 0) {
      post({
        type: "error",
        runId,
        code: "tool.errorNoText",
        detail: file.name,
      });
      return;
    }

    const styleMap = await buildFontStyleMap(bytes, pageNumbers, items);

    const inputs = items.map((pageItems, i) => ({
      pageNo: pageNumbers[i] + 1,
      widthPt: widths[i],
      heightPt: heights[i],
      items: pageItems,
    }));
    const extracted = extractDocument(inputs, { styleMap });

    if (!title) {
      const h1 = extracted.blocks.find(
        (block) => block.kind === "para" && block.headingLevel === 1
      );
      if (h1) {
        title = h1.runs.map((r) => r.text).join("").trim().slice(0, 120);
      }
    }
    if (!title) {
      title = file.name.replace(/\.pdf$/i, "").trim().slice(0, 120);
    }

    post({ type: "progress", runId, pct: 85, stage: "saving" });

    const html = buildHtml(extracted, {
      mode: opts.mode,
      pageNumbers: opts.pageNumbers,
      title,
      pageWord: opts.pageWord,
      noTextWord: opts.noTextWord,
    });

    const base = outputBaseName(file.name, opts.locale);
    const stats = docStats(extracted);
    const detail: Record<string, number | boolean> = {
      files: 1,
      pages: pageNumbers.length,
      headings: stats.headings ?? 0,
    };
    if (opts.mode === "layout") {
      detail.paragraphs = layoutLineCount(extracted);
    } else {
      detail.paragraphs = stats.paragraphs ?? 0;
    }

    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${base}.html`,
          mime: "text/html",
          blob: new Blob([html], { type: "text/html; charset=utf-8" }),
        },
      ],
      detail,
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
