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
 * PDF to ZIP worker (PHASE-1 Batch C): renders every selected page via
 * self-hosted pdf.js (fake-worker mode on our own thread — the shared
 * pdf-to-images pipeline), encodes each page as PNG or JPG, and packs
 * them all into ONE zip per input file with our OWN zip writer.
 *
 * Device-only: the File arrives by structured clone, the ZIP Blob goes
 * back. Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

type PdfjsModule = typeof import("pdfjs-dist");

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const isJpg = options.format === "jpg";
  const ext = isJpg ? "jpg" : "png";
  const mime = isJpg ? "image/jpeg" : "image/png";
  const dpi = Number(options.dpi ?? 150);
  const scale = Math.max(0.5, Math.min(8, dpi / 72));
  const quality = 0.87; // balanced JPG quality for archives

  const pdfjs: PdfjsModule = await loadPdfjsInWorker();
  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let renderedPages = 0;
  const budget = new RenderPixelBudget();

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex]!;
    const base = file.name
      .replace(/\.(pdf)$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .slice(0, 120);

    const data = new Uint8Array(await file.arrayBuffer());
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

    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < pageNumbers.length; i += 1) {
      const pageNumber = pageNumbers[i]! + 1; // 1-based in pdf.js
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

      const blob = isJpg
        ? await canvas.convertToBlob({ type: "image/jpeg", quality })
        : await canvas.convertToBlob({ type: "image/png" });
      entries[`page-${String(i + 1).padStart(3, "0")}.${ext}`] = new Uint8Array(
        await blob.arrayBuffer()
      );
      renderedPages += 1;

      post({
        type: "progress",
        runId,
        pct: Math.round(
          6 +
            (84 * ((fileIndex + (i + 1) / pageNumbers.length)) / files.length)
        ),
        stage: "processing",
        detail: { page: i + 1, pages: pageNumbers.length },
      });
    }
    doc.cleanup();

    const zipped = zipSync(entries, { level: isJpg ? 1 : 6 });
    outputs.push({
      name: `${base}-pages.zip`,
      mime: "application/zip",
      blob: new Blob([zipped as unknown as BlobPart], {
        type: "application/zip",
      }),
    });
    post({
      type: "progress",
      runId,
      pct: Math.round(6 + (84 * (fileIndex + 1)) / files.length),
      stage: "processing",
    });
  }

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: renderedPages },
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
