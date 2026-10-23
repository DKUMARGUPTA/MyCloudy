import type { OptionValues } from "@/lib/tools/config-types";
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
import { TiffBuilder } from "./tiff-writer";

/**
 * PDF → images worker (PRD §8.6) — shared by pdf-to-jpg, pdf-to-png,
 * pdf-to-webp (canvas encodes) and pdf-to-tiff (clean-room TIFF writer).
 *
 * pdf.js runs IN THIS WORKER: we pre-import the self-hosted worker module
 * (/pdfjs/pdf.worker.min.mjs), which sets `globalThis.pdfjsWorker` — pdf.js
 * then detects it and uses fake-worker mode on our own thread (no nested
 * worker, no window dependency). Renders are sequential + one canvas at a
 * time, so a 300-DPI 200-page document never spikes memory.
 *
 * Device-only: the File arrives by structured clone, image Blobs go back.
 */

type PdfjsModule = typeof import("pdfjs-dist");

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** Output format per tool — fixed by the tool identity, not an option. */
const FORMAT: Record<
  string,
  { mime: string; ext: string; alpha: boolean; lossy: boolean }
> = {
  "pdf-to-jpg": { mime: "image/jpeg", ext: "jpg", alpha: false, lossy: true },
  "pdf-to-png": { mime: "image/png", ext: "png", alpha: true, lossy: false },
  "pdf-to-webp": { mime: "image/webp", ext: "webp", alpha: true, lossy: true },
};

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, toolId, options, files } = request;
  const format = FORMAT[toolId] ?? FORMAT["pdf-to-jpg"];
  const isTiff = toolId === "pdf-to-tiff";

  const dpi = Number(options.dpi ?? 150);
  const scale = Math.max(0.5, Math.min(8, dpi / 72));
  const quality = Math.max(0.4, Math.min(1, Number(options.quality ?? 85) / 100));
  const transparent = options.transparent === true && format.alpha && !isTiff;
  // TIFF is written by the clean-room writer (RGB, no alpha) — always a
  // solid white base, and the "transparent" switch isn't offered there.
  const multipageTiff = isTiff && options.multipage !== false;
  const tiffCompression =
    options.compression === "none" ? "none" : ("lzw" as const);

  const pdfjs = await loadPdfjsInWorker();
  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let renderedPages = 0;
  // Run-wide RAM budget: every output page (encoded blob or raw TIFF
  // strip) accumulates until the result step — refuse BEFORE a render
  // that would blow the pixel cap instead of OOMing a phone (ENH-1).
  const budget = new RenderPixelBudget();

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const base = file.name
      .replace(/\.(pdf)$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .slice(0, 120);

    // One chained multi-page TIFF per input file (fresh builder per file —
    // finish() is one-shot). Emitted after the file's page loop ends.
    let tiffBuilder: TiffBuilder | null = null;
    let tiffBuilderPageCount = 0;

    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({
      data,
      // Worker-safe canvas factory — image pages need createElement
      // (DOMCanvasFactory._createCanvas), the baseURI-only shim blanks them.
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
      post({ type: "error", runId, code: "tool.errorInvalidPages" });
      return;
    }

    for (let i = 0; i < pageNumbers.length; i += 1) {
      const pageNumber = pageNumbers[i] + 1; // 1-based in pdf.js
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.round(viewport.width));
      const height = Math.max(1, Math.round(viewport.height));

      // Budget check BEFORE the render (and the canvas alloc): the
      // accumulated pages + this one must stay under the pixel cap.
      if (!budget.tryConsume(width, height)) {
        page.cleanup();
        doc.cleanup();
        post({ type: "error", runId, code: "tool.errorRenderBudget" });
        return;
      }

      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas-2d-unavailable");
      // pdf.js ALWAYS fills the page background (opaque white by default —
      // beginDrawing: fillStyle = background || "#ffffff"). Transparent
      // exports pass a fully transparent background instead.
      if (!transparent) {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
      }
      await page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
        background: transparent ? "rgba(0,0,0,0)" : undefined,
      }).promise;
      page.cleanup();

      // TIFF pages flow through the clean-room writer instead of a canvas
      // encode: raw ImageData pixels, LZW (or none), every page of the file
      // chained into one multi-page .tiff (the scanner convention).
      if (isTiff) {
        const rgba = context.getImageData(0, 0, width, height).data;
        if (multipageTiff) {
          tiffBuilder ??= new TiffBuilder({
            compression: tiffCompression,
            dpi,
          });
          tiffBuilder.addPage({ width, height, rgba });
          tiffBuilderPageCount += 1;
        } else {
          const single = new TiffBuilder({
            compression: tiffCompression,
            dpi,
          });
          single.addPage({ width, height, rgba });
          outputs.push({
            name: `${base}_page${pageNumber}.tiff`,
            mime: "image/tiff",
            blob: new Blob([single.finish() as BlobPart], {
              type: "image/tiff",
            }),
          });
        }
        renderedPages += 1;
        post({
          type: "progress",
          runId,
          pct: Math.round(
            ((fileIndex + (i + 1) / pageNumbers.length) / files.length) * 95
          ),
          stage: "processing",
          detail: { page: i + 1, pages: pageNumbers.length },
        });
        continue;
      }

      const blob = await canvas.convertToBlob({
        type: format.mime,
        quality: format.lossy ? quality : undefined,
      });
      // Honesty guard: browsers without a WEBP encoder (older Safari) hand
      // back PNG bytes silently — refuse before a misnamed file downloads.
      if (toolId === "pdf-to-webp" && blob.type !== format.mime) {
        post({ type: "error", runId, code: "tool.errorWebpUnsupported" });
        return;
      }
      renderedPages += 1;
      outputs.push({
        name:
          pageNumbers.length === 1
            ? `${base}.${format.ext}`
            : `${base}_page${pageNumber}.${format.ext}`,
        mime: format.mime,
        blob,
      });

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

    // The file's pages finish → emit the chained multi-page TIFF now.
    if (isTiff && multipageTiff && tiffBuilderPageCount > 0 && tiffBuilder) {
      outputs.push({
        name: `${base}.tiff`,
        mime: "image/tiff",
        blob: new Blob([tiffBuilder.finish() as BlobPart], {
          type: "image/tiff",
        }),
      });
    }
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
    const code = /password/i.test(message)
      ? "tool.errorEncrypted"
      : /canvas/i.test(message)
        ? "tool.errorGeneric"
        : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code });
  });
};
