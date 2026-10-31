import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import { collectPieces, pageText, type RawTextItem } from "../pdf-to-txt/text-layout";
import {
  buildPdfJson,
  renderPdfJson,
  type JsonPage,
} from "./worker-lib";

/**
 * PDF to JSON worker (P3-a / R55) — extracts every page's geometry and
 * selectable text with pdf.js (fake-worker mode, the pdf-to-txt recipe),
 * then ships the structured document as pretty JSON: pages with
 * width/height/rotation, text (flow or per-line), counts, and optional
 * per-item positions for layout analysis.
 *
 * Scanned PDFs (zero selectable text anywhere) end with an honest error —
 * OCR first, then export. Device-only, zero network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.pdf$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const layout: "flow" | "lines" = options.layout === "lines" ? "lines" : "flow";
  const includeTextItems = options.textItems === true;

  const pdfjs = await loadPdfjsInWorker();
  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let totalPages = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const base = safeBaseName(file.name);

    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({
      data,
      ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
    }).promise;

    const pages: JsonPage[] = [];
    for (let i = 0; i < doc.numPages; i += 1) {
      const page = await doc.getPage(i + 1);
      const content = await page.getTextContent();
      // Geometry at scale 1 = the raw PDF point box (rotation applied by
      // pdf.js viewport, the number readers expect).
      const viewport = page.getViewport({ scale: 1 });
      const rawItems = content.items as RawTextItem[];
      const text = pageText(rawItems, layout);
      const pageOut: JsonPage = {
        page: i + 1,
        width: Math.round(viewport.width * 100) / 100,
        height: Math.round(viewport.height * 100) / 100,
        rotation: ((page.rotate % 360) + 360) % 360,
        text,
        charCount: text.replace(/\s/g, "").length,
        wordCount: (text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).length,
      };
      if (includeTextItems) {
        pageOut.textItems = collectPieces(rawItems).map((piece) => ({
          text: piece.str,
          x: Math.round(piece.x * 100) / 100,
          y: Math.round(piece.y * 100) / 100,
          width: Math.round(piece.w * 100) / 100,
          fontSize: Math.round(piece.size * 100) / 100,
        }));
      }
      pages.push(pageOut);
      page.cleanup();
      totalPages += 1;
      post({
        type: "progress",
        runId,
        pct: Math.round(
          ((fileIndex + (i + 1) / doc.numPages) / files.length) * 95,
        ),
        stage: "processing",
        detail: { page: i + 1, pages: doc.numPages },
      });
    }
    doc.cleanup();

    const exportDoc = buildPdfJson(pages, {
      layout,
      includeTextItems,
      fileName: file.name,
      fileSize: file.size,
      now: new Date().toISOString(),
    });
    if (!exportDoc) {
      post({
        type: "error",
        runId,
        code: "tool.errorNoText",
        detail: file.name,
      });
      return;
    }

    const body = renderPdfJson(exportDoc);
    outputs.push({
      name: `${base}.json`,
      mime: "application/json;charset=utf-8",
      blob: new Blob([body], { type: "application/json;charset=utf-8" }),
    });
  }

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: totalPages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
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
