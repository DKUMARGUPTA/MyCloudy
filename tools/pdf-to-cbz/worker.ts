import { zipSync, type Zippable } from "@/lib/own/zip";
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
 * PDF to CBZ worker (P3-a / R55) — every selected page is rasterised
 * (the pdf-to-images recipe: pdf.js fake-worker, sequential renders, one
 * canvas at a time, pixel budget guard) and packed into a .cbz — a ZIP
 * archive of page images, the comic-book convention. Pages are named
 * page-001.jpg style so every comic reader sorts them in order. Our own
 * ZIP engine does the packing (STORE — the page encodes are already
 * compressed). Device-only, zero network.
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

  const isPng = options.format === "png";
  const mime = isPng ? "image/png" : "image/jpeg";
  const ext = isPng ? "png" : "jpg";
  const dpi = Number(options.dpi ?? 150);
  const scale = Math.max(0.5, Math.min(8, dpi / 72));
  const quality = Math.max(0.4, Math.min(1, Number(options.quality ?? 85) / 100));

  const pdfjs = await loadPdfjsInWorker();
  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  const budget = new RenderPixelBudget();
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

    const pageNumbers = parsePageSpec(
      String(options.pages ?? "all"),
      doc.numPages
    );
    if (pageNumbers === null || pageNumbers.length === 0) {
      doc.destroy();
      post({ type: "error", runId, code: "tool.errorInvalidPages" });
      return;
    }

    // Zero-pad the sequence so lexical order = page order in every reader.
    const pad = Math.max(3, String(pageNumbers.length).length);
    const entries: Zippable = {};
    try {
      for (let i = 0; i < pageNumbers.length; i += 1) {
        const pageNumber = pageNumbers[i] + 1; // 1-based in pdf.js
        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale });
        const width = Math.max(1, Math.round(viewport.width));
        const height = Math.max(1, Math.round(viewport.height));

        // Budget check BEFORE the render (and the canvas alloc).
        if (!budget.tryConsume(width, height)) {
          throw new Error("render-budget");
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
          type: mime,
          quality: isPng ? undefined : quality,
        });
        entries[`${base}/page-${String(i + 1).padStart(pad, "0")}.${ext}`] =
          new Uint8Array(await blob.arrayBuffer());
        totalPages += 1;

        post({
          type: "progress",
          runId,
          pct: Math.round(
            ((fileIndex + (i + 1) / pageNumbers.length) / files.length) * 92,
          ),
          stage: "processing",
          detail: { page: i + 1, pages: pageNumbers.length },
        });
      }
    } finally {
      doc.destroy();
    }

    // The CBZ itself — own ZIP engine, STORE (pages are already encoded).
    post({
      type: "progress",
      runId,
      pct: Math.round(((fileIndex + 1) / files.length) * 96),
      stage: "saving",
    });
    const zipped = zipSync(entries, { level: 0 });
    outputs.push({
      name: `${base}.cbz`,
      mime: "application/vnd.comicbook+zip",
      blob: new Blob([zipped as unknown as BlobPart], {
        type: "application/vnd.comicbook+zip",
      }),
    });
  }

  post({ type: "progress", runId, pct: 98, stage: "saving" });
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
    const code =
      message === "render-budget"
        ? "tool.errorRenderBudget"
        : /password/i.test(message)
          ? "tool.errorEncrypted"
          : /canvas/i.test(message)
            ? "tool.errorGeneric"
            : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code });
  });
};
