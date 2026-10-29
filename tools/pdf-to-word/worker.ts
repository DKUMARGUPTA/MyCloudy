import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
// P6-v: the bold enrichment lives on the OWN engine now (one shared port
// for all four pdf-to-X extractors — parsePdf + listPages + our own
// stream decoders under the same correlation semantics).
import { buildFontBoldMap } from "../pdfjs-common/font-style-map";
import {
  buildDocx,
  DOCX_MIME,
  docxStats,
  extractTextBlocks,
  parseRun,
  type DocxParaBlock,
} from "./model";

// Re-exported for the smoke, which drives the same enrichment on real
// fixtures through the worker's own surface.
export { buildFontBoldMap };

/**
 * PDF → Word worker (RB1-b, the 68th tool) — 100% on-device, EN+हिंदी.
 *
 * Protocol mirrors create-resume / pdf-to-txt:
 *
 *  1. parseRun — defensive coercion of the surface's options payload
 *     (headings on/off, page breaks, locale, localized fallback word);
 *  2. pdf.js getDocument on a COPY of the buffer (pinned lesson: pdf.js
 *     transfers + detaches the ArrayBuffer it receives — the original
 *     bytes must survive for the font pass below), one getTextContent
 *     per page, page.cleanup() + task.destroy() afterwards;
 *  3. buildFontBoldMap — pdf.js 4.x reports only internal font ids
 *     ("g_d0_f3"), never the real names, so bold is recovered from the
 *     PDF itself on the OWN engine (the shared font-style-map module:
 *     each page's distinct item ids zipped with its distinct Tf-used
 *     /Font resource keys; BaseFont "*-Bold" names mark the id bold;
 *     mismatches skip the page — bold degrades honestly to off);
 *  4. extractTextBlocks + buildDocx (fflate OOXML) → Blob download.
 *     Table detection (default on): consecutive lines with matching
 *     column clusters become real Word tables; everything else keeps
 *     the paragraph path. The detail reports the tables count.
 *
 * Scanned PDFs (zero selectable text) fail with tool.errorNoText —
 * honest, same as pdf-to-txt (OCR chain suggested in the FAQ copy).
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
  const opts = parseRun(String(request.options.run ?? ""));
  const file = request.files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 20, stage: "reading" });

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

  const pages: RawTextItem[][] = [];
  let chars = 0;
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    page.cleanup();
    const items = content.items as RawTextItem[];
    pages.push(items);
    for (const item of items) {
      if (typeof item.str === "string") chars += item.str.trim().length;
    }
  }
  await doc.cleanup();
  await task.destroy();

  post({ type: "progress", runId, pct: 45, stage: "processing" });

  // Scans have zero selectable text — fail honestly instead of shipping
  // an empty file (the pdf-to-txt precedent; the FAQ suggests the OCR
  // tool for this exact case).
  if (chars === 0) {
    post({
      type: "error",
      runId,
      code: "tool.errorNoText",
      detail: file.name,
    });
    return;
  }

  const boldMap = await buildFontBoldMap(bytes, pages);
  const model = extractTextBlocks(pages, {
    boldMap,
    headings: opts.headings,
    tables: opts.tables,
  });

  post({ type: "progress", runId, pct: 85, stage: "saving" });

  // Title = first Heading1 paragraph, else the first paragraph (a table
  // block carries no runs and is never the title).
  const titlePara =
    model.blocks.find(
      (block): block is DocxParaBlock =>
        block.kind === "para" && block.headingLevel === 1
    ) ??
    model.blocks.find(
      (block): block is DocxParaBlock => block.kind === "para"
    );
  const docx = buildDocx(model, {
    pageBreaks: opts.pageBreaks,
    title: titlePara ? titlePara.runs.map((r) => r.text).join(" ") : "",
  });

  const base =
    file.name
      .replace(/\.pdf$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .trim()
      .slice(0, 120) || opts.fileWord || "document";

  const stats = docxStats(model);
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${base}.docx`,
        mime: DOCX_MIME,
        blob: new Blob([docx as unknown as BlobPart], { type: DOCX_MIME }),
      },
    ],
    detail: {
      files: 1,
      pages: stats.pages,
      paragraphs: stats.paragraphs,
      headings: stats.headings,
      tables: stats.tables,
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /password/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code });
  });
};
