import { CreateContext } from "@/lib/own/pdf";

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

/**
 * Rasterize PDF — device-only worker (PRD §8.4, Optimize:
 * "Pages ko images banakar naya PDF (non-editable); DPI choice").
 *
 * pdf.js runs IN THIS WORKER (fake-worker mode via the self-hosted
 * /pdfjs modules — same recipe as tools/pdf-to-images/worker.ts): every
 * selected page is rendered to an OffscreenCanvas at dpi/72 (clamped to
 * [0.5, 8], then clamped again so a page never exceeds 40 megapixels),
 * encoded as JPEG or PNG, and rebuilt by the OWN ENGINE (CreateContext —
 * the scan-pdf / passport-photo precedent) into a NEW document — one
 * page per image at the original page's VISIBLE point size (the pdf.js
 * viewport at scale 1 is /Rotate-aware, so rotation is baked in and the
 * output page has the orientation the user saw).
 *
 * Options read (exact ids, matching tools/rasterize-pdf/config.ts):
 *   dpi          "72" | "96" | "150" (default) | "220" | "300"
 *   format       "jpeg" (default) | "png"
 *   jpegQuality  60-95, default 85 (JPEG only — hidden for PNG)
 *   pages        page-range spec, default "all"
 *
 * Device-only: the File arrives by structured clone, the result Blob
 * goes back the same way. Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

/** Hard per-page pixel budget (PRD NFR §14 memory guard). */
const MAX_PIXELS = 40_000_000;
/** Thrown when one page's render fails — maps to rasterize.errorRender. */
const RENDER_FAILED = "rasterize-render-failed";

/**
 * The smoke-locked clamp (scripts/smoke-rasterize.ts): aspect-preserving
 * downscale when the requested DPI would exceed the 40MP budget. Floor on
 * the scaled targets guarantees the product stays under the cap.
 */
function clampedScaleAndViewport(
  visibleWidthPt: number,
  visibleHeightPt: number,
  dpi: number
): number {
  let scale = Math.max(0.5, Math.min(8, dpi / 72));
  let pixelW = Math.round(visibleWidthPt * scale);
  let pixelH = Math.round(visibleHeightPt * scale);
  if (pixelW * pixelH > MAX_PIXELS) {
    const factor = Math.sqrt(MAX_PIXELS / (pixelW * pixelH));
    const w = Math.floor(pixelW * factor);
    const h = Math.floor(pixelH * factor);
    scale = Math.min(w / visibleWidthPt, h / visibleHeightPt);
    pixelW = Math.round(visibleWidthPt * scale);
    pixelH = Math.round(visibleHeightPt * scale);
  }
  return scale;
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];

  const dpi = Number(options.dpi ?? 150);
  const usePng = String(options.format ?? "jpeg") === "png";
  const quality = Math.max(0.6, Math.min(0.95, Number(options.jpegQuality ?? 85) / 100));
  const spec = String(options.pages ?? "all");

  post({
    type: "progress",
    runId,
    pct: 3,
    stage: "reading",
  });

  const pdfjs = await loadPdfjsInWorker();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({
    data,
    // Worker-safe canvas factory (image pages need createElement).
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;

  const pageNumbers = parsePageSpec(spec, doc.numPages);
  if (pageNumbers === null || pageNumbers.length === 0) {
    post({ type: "error", runId, code: "tool.errorInvalidPages" });
    return;
  }

  const out = CreateContext.create();
  let done = 0;

  for (const pageIndexOfPageNumbers of pageNumbers) {
    // parsePageSpec yields 0-based indices; pdf.js pages are 1-based.
    const pageNumber = pageIndexOfPageNumbers + 1;
    const page = await doc.getPage(pageNumber);
    try {
      // The viewport at scale 1 is the VISIBLE page size in points —
      // /Rotate baked in (pdf.js normalizes negative/≥360 values and
      // treats non-multiples of 90 as 0). The output page uses exactly
      // this orientation.
      const base = page.getViewport({ scale: 1 });
      const scale = clampedScaleAndViewport(base.width, base.height, dpi);
      const viewport = page.getViewport({ scale });
      const pixelW = Math.max(1, Math.round(viewport.width));
      const pixelH = Math.max(1, Math.round(viewport.height));

      const canvas = new OffscreenCanvas(pixelW, pixelH);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas-2d-unavailable");
      // Opaque white background — a PDF page is white, and JPEG has no
      // alpha channel anyway.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, pixelW, pixelH);
      await page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      page.cleanup();

      const blob = await canvas.convertToBlob({
        type: usePng ? "image/png" : "image/jpeg",
        quality: usePng ? undefined : quality,
      });
      const imageBytes = new Uint8Array(await blob.arrayBuffer());

      // 2. Rebuild (own engine): page per image at the visible point size,
      //     full-bleed.
      const image = usePng
        ? out.embedPng(imageBytes)
        : out.embedJpeg(imageBytes);
      const outPage = out.addPage(base.width, base.height);
      outPage.drawImage(image, {
        x: 0,
        y: 0,
        width: base.width,
        height: base.height,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      page.cleanup();
      throw new Error(`${RENDER_FAILED}: page ${pageNumber}: ${message}`);
    }

    done += 1;
    post({
      type: "progress",
      runId,
      pct: Math.min(88, 5 + Math.round((83 * done) / pageNumbers.length)),
      stage: "processing",
      detail: { page: done, pages: pageNumbers.length },
    });
  }

  await doc.cleanup();

  post({
    type: "progress",
    runId,
    pct: 92,
    stage: "saving",
  });

  const saved = out.write();
  const outputName = `${safeBaseName(file.name)}-rasterized.pdf`;

  post({
    type: "result",
    runId,
    outputs: [
      {
        name: outputName,
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: 1, pages: done },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    let code = "tool.errorCorrupt";
    if (/password/i.test(message)) {
      code = "tool.errorEncrypted";
    } else if (message.includes(RENDER_FAILED)) {
      code = "rasterize.errorRender";
    } else if (/canvas/i.test(message)) {
      code = "tool.errorGeneric";
    }
    post({
      type: "error",
      runId: data.runId,
      code,
      detail: code === "tool.errorGeneric" ? message.slice(0, 200) : undefined,
    });
  });
};
