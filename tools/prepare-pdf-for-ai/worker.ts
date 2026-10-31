import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import { pageText, type RawTextItem } from "../pdf-to-txt/text-layout";
import {
  buildPreparedDoc,
  renderPrepared,
  type PageText,
  type PrepareFormat,
} from "./worker-lib";

/**
 * Prepare PDF for AI worker (P2 / R54) — extracts every page's selectable
 * text with pdf.js (fake-worker mode, the pdf-to-txt recipe), then runs
 * the PURE chunker and ships a LlamaIndex-style JSON (or JSONL) export:
 * full document + chunk nodes with page metadata, sized by token estimate.
 *
 * Scanned PDFs (zero selectable text) end with an honest error — OCR first,
 * then prepare. Device-only, zero network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.pdf$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const format: PrepareFormat = options.format === "jsonl" ? "jsonl" : "json";
  const chunkTokens = clampInt(options.chunkTokens, 128, 4000, 800);
  const overlapTokens = clampInt(options.overlapTokens, 0, 512, 96);

  const pdfjs = await loadPdfjsInWorker();
  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let totalPages = 0;
  let totalChunks = 0;

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

    const pages: PageText[] = [];
    for (let i = 0; i < doc.numPages; i += 1) {
      const page = await doc.getPage(i + 1);
      const content = await page.getTextContent();
      page.cleanup();
      pages.push({ page: i + 1, text: pageText(content.items as RawTextItem[], "flow") });
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

    const totalChars = pages.reduce(
      (sum, p) => sum + p.text.replace(/\s/g, "").length,
      0,
    );
    if (totalChars === 0) {
      post({
        type: "error",
        runId,
        code: "tool.errorNoText",
        detail: file.name,
      });
      return;
    }

    const prepared = buildPreparedDoc(pages, {
      format,
      chunkTokens,
      overlapTokens,
      fileName: file.name,
      now: new Date().toISOString(),
    });
    if (!prepared) {
      post({
        type: "error",
        runId,
        code: "tool.errorNoText",
        detail: file.name,
      });
      return;
    }
    totalChunks += prepared.nodes.length;

    const body = renderPrepared(prepared, format);
    outputs.push({
      name: `${base}-for-ai.${format}`,
      mime: "application/json;charset=utf-8",
      blob: new Blob([body], { type: "application/json;charset=utf-8" }),
    });
  }

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: totalPages, chunks: totalChunks },
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
