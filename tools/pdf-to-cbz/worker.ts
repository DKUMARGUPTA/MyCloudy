import { zipSync } from "@/lib/own/zip";
import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import { RenderPixelBudget } from "../pdfjs-common/pixel-budget";

/**
 * PDF → CBZ worker (PHASE-3 batch 3): the comic-book archive — every
 * selected page rendered with pdf.js and packed as page-001.jpg … into a
 * ZIP renamed .cbz via OUR OWN zipSync (JPEG inside, level-1 stored-ish
 * since JPEG is already compressed). Readers (CDisplayEx, YACReader,
 * Panels) open it directly. Never touches the network.
 */

type PdfjsModule = typeof import("pdfjs-dist");

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "comic";
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const dpi = Number(options.dpi ?? 200);
  const scale = Math.max(0.5, Math.min(6, dpi / 72));
  const qualityRaw = Number(options.quality ?? 85);
  const quality =
    Number.isFinite(qualityRaw) && qualityRaw >= 50 && qualityRaw <= 95
      ? qualityRaw / 100
      : 0.85;

  post({ type: "progress", runId, pct: 4, stage: "reading" });
  const data = new Uint8Array(await file.arrayBuffer());
  const pdfjs: PdfjsModule = await loadPdfjsInWorker();
  const doc = await pdfjs.getDocument({
    data,
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;

  const pageNumbers = parsePageSpec(String(options.pages ?? "all"), doc.numPages);
  if (pageNumbers === null || pageNumbers.length === 0) {
    post({ type: "error", runId, code: "tool.errorInvalidPages" });
    return;
  }

  const budget = new RenderPixelBudget();
  const entries: Record<string, Uint8Array> = {};

  for (let i = 0; i < pageNumbers.length; i += 1) {
    const pageNumber = pageNumbers[i]! + 1;
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));

    if (!budget.tryConsume(width, height)) {
      page.cleanup();
      doc.cleanup();
      post({ type: "error", runId, code: "tool.errorRenderBudget" });
      return;
    }

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas-2d-unavailable");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    page.cleanup();

    const blob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality,
    });
    entries[`page-${String(pageNumber).padStart(3, "0")}.jpg`] = new Uint8Array(
      await blob.arrayBuffer()
    );

    post({
      type: "progress",
      runId,
      pct: Math.round(6 + (84 * (i + 1)) / pageNumbers.length),
      stage: "processing",
      detail: { page: i + 1, pages: pageNumbers.length },
    });
  }
  doc.cleanup();

  post({ type: "progress", runId, pct: 93, stage: "saving" });
  // JPEG payloads are already compressed — level 1 keeps packing fast.
  const zipped = zipSync(entries, { level: 1 });
  const outputs = [
    {
      name: `${safeBaseName(file.name)}.cbz`,
      mime: "application/vnd.comicbook+zip",
      blob: new Blob([zipped as unknown as BlobPart], {
        type: "application/vnd.comicbook+zip",
      }),
    },
  ];
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: 1, pages: pageNumbers.length },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /Invalid PDF|structure|corrupt/i.test(message)
      ? "tool.errorCorrupt"
      : /encrypt|password/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorGeneric";
    post({ type: "error", runId: data.runId, code });
  });
};
