import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import { encodeTiff, type TiffPageInput } from "./tiff";

/**
 * PDF → TIFF worker (P9 batch 1): renders every selected page with pdf.js
 * (fake-worker mode, same recipe as pdf-to-images) and packs them into ONE
 * real multi-page TIFF via the local baseline encoder (tiff.ts).
 *
 * Memory honesty: pages are converted RGBA→RGB immediately and canvases are
 * dropped per page, but a multi-page TIFF inherently holds every page at
 * full resolution — the run refuses jobs whose raw pixel payload would
 * pass 600 MB instead of killing the tab with an OOM.
 *
 * Device-only, as everywhere.
 */

type PdfjsModule = typeof import("pdfjs-dist");

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** 600 MB of RGB pixels ≈ a 40-page letter file at 300 DPI — plenty for
 *  real archives, small enough for any laptop to survive. */
const MAX_PIXEL_BYTES = 600 * 1024 * 1024;

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;

  const dpi = Math.max(72, Math.min(600, Number(options.dpi ?? 150)));
  const scale = Math.max(0.5, Math.min(8, dpi / 72));

  const pdfjs = await loadPdfjsInWorker();
  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let totalPages = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
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

    const pageNumbers = parsePageSpec(
      String(options.pages ?? "all"),
      doc.numPages
    );
    if (pageNumbers === null || pageNumbers.length === 0) {
      doc.cleanup();
      post({ type: "error", runId, code: "tool.errorInvalidPages" });
      return;
    }

    // Rough upfront budget from page boxes at this scale (avoids rendering
    // 90% of a doomed job before discovering the OOM).
    let plannedBytes = 0;
    for (const zeroBased of pageNumbers) {
      const page = await doc.getPage(zeroBased + 1);
      const vp = page.getViewport({ scale: 1 });
      page.cleanup();
      plannedBytes += Math.round(vp.width * scale) * Math.round(vp.height * scale) * 3;
    }
    if (plannedBytes > MAX_PIXEL_BYTES) {
      doc.cleanup();
      post({
        type: "error",
        runId,
        code: "tool.errorGeneric",
        detail: "tiff-too-large: lower the DPI or select fewer pages",
      });
      return;
    }

    const pages: TiffPageInput[] = [];
    for (let i = 0; i < pageNumbers.length; i += 1) {
      const pageNumber = pageNumbers[i] + 1; // 1-based in pdf.js
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.round(viewport.width));
      const height = Math.max(1, Math.round(viewport.height));

      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas-2d-unavailable");
      // TIFF baseline RGB here has no alpha channel — pages always get the
      // opaque white base pdf.js paints by default.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      await page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      page.cleanup();

      const image = context.getImageData(0, 0, width, height);
      pages.push({ width, height, rgba: image.data });
      totalPages += 1;

      post({
        type: "progress",
        runId,
        pct: Math.round(
          ((fileIndex + (i + 1) / pageNumbers.length) / files.length) * 95
        ),
        stage: "processing",
        detail: { page: i + 1, pages: pageNumbers.length },
      });
    }
    doc.cleanup();

    const tiff = encodeTiff(pages, dpi);
    outputs.push({
      name: `${base}.tiff`,
      mime: "image/tiff",
      blob: new Blob([tiff], { type: "image/tiff" }),
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
      : /canvas/i.test(message)
        ? "tool.errorGeneric"
        : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code });
  });
};
