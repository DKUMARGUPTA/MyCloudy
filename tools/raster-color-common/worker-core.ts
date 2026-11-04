/**
 * Shared render→transform→rebuild pipeline for the raster color family
 * (P1-b): the exact rasterize-pdf recipe (pdf.js fake-worker render on
 * an OffscreenCanvas, 40MP per-page pixel cap, opaque white base) with
 * ONE extra step — a PURE pixel transform (tools/raster-color-common/
 * transforms.ts) applied to the page's ImageData before re-encoding.
 *
 * Each tool worker is a thin wrapper: it declares an output suffix, a
 * JPEG-quality default and a `transformFor(options)` factory, then calls
 * `runRasterColor`. Error mapping lives here too (`rasterize.errorRender`
 * is reused — the copy "one of the pages couldn't be turned into an
 * image — try a lower DPI" fits this family word for word).
 *
 * Device-only: the File arrives by structured clone, the result Blob
 * goes back the same way. Never touches the network.
 */
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
import type { PixelTransform } from "./transforms";

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

/** Hard per-page pixel budget (PRD NFR §14 memory guard — rasterize). */
const MAX_PIXELS = 40_000_000;
/** Thrown when one page's render fails — maps to rasterize.errorRender. */
const RENDER_FAILED = "rasterize-render-failed";

/**
 * Aspect-preserving downscale when the requested DPI would exceed the
 * 40MP budget (smoke-locked in scripts/smoke-rasterize.ts).
 */
function clampedScale(
  visibleWidthPt: number,
  visibleHeightPt: number,
  dpi: number,
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

/** What one tool declares to run through this core. */
export interface RasterColorSpec {
  /** Output filename suffix, e.g. "-inverted". */
  outputSuffix: string;
  /** Default JPEG quality (1-100) when the option is absent. */
  defaultQuality: number;
  /** Build this run's pixel transform from the UI options. */
  transformFor: (options: OptionValues) => PixelTransform;
}

/**
 * Rebuild pass: one page per image at the exact visible point size,
 * full-bleed margin 0 — exported so the smoke test can lock it with the
 * pdf-lib oracle (bun cannot run pdf.js's canvas renderer; the rasterize
 * precedent).
 */
export function buildImageOnlyDoc(
  pages: ReadonlyArray<{
    image: Uint8Array;
    isPng: boolean;
    widthPt: number;
    heightPt: number;
  }>,
): Uint8Array {
  const doc = CreateContext.create();
  for (const page of pages) {
    const image = page.isPng
      ? doc.embedPng(page.image)
      : doc.embedJpeg(page.image);
    const out = doc.addPage(page.widthPt, page.heightPt);
    out.drawImage(image, {
      x: 0,
      y: 0,
      width: page.widthPt,
      height: page.heightPt,
    });
  }
  return doc.write();
}

/** The full device-side run for one raster-color tool. */
export async function runRasterColor(
  request: WorkerRunRequest,
  spec: RasterColorSpec,
): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];

  const dpi = Number(options.dpi ?? 150);
  const usePng = String(options.format ?? "jpeg") === "png";
  const quality = Math.max(
    0.6,
    Math.min(0.95, Number(options.jpegQuality ?? spec.defaultQuality) / 100),
  );
  const pageSpec = String(options.pages ?? "all");

  post({ type: "progress", runId, pct: 3, stage: "reading" });

  const pdfjs = await loadPdfjsInWorker();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({
    data,
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;

  const pageNumbers = parsePageSpec(pageSpec, doc.numPages);
  if (pageNumbers === null || pageNumbers.length === 0) {
    post({ type: "error", runId, code: "tool.errorInvalidPages" });
    return;
  }

  const transform = spec.transformFor(options);
  const out = CreateContext.create();
  let done = 0;

  for (const pageIndexOfPageNumbers of pageNumbers) {
    // parsePageSpec yields 0-based indices; pdf.js pages are 1-based.
    const pageNumber = pageIndexOfPageNumbers + 1;
    const page = await doc.getPage(pageNumber);
    try {
      // The viewport at scale 1 is the VISIBLE page size in points —
      // /Rotate baked in. The output page uses exactly this orientation.
      const base = page.getViewport({ scale: 1 });
      const scale = clampedScale(base.width, base.height, dpi);
      const viewport = page.getViewport({ scale });
      const pixelW = Math.max(1, Math.round(viewport.width));
      const pixelH = Math.max(1, Math.round(viewport.height));

      const canvas = new OffscreenCanvas(pixelW, pixelH);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas-2d-unavailable");
      // Opaque white base — a PDF page is white.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, pixelW, pixelH);
      await page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      page.cleanup();

      // THE COLOR STEP — pure transform on the page's pixels.
      const imageData = context.getImageData(0, 0, pixelW, pixelH);
      transform(imageData.data as unknown as Uint8ClampedArray);
      context.putImageData(imageData, 0, 0);

      const blob = await canvas.convertToBlob({
        type: usePng ? "image/png" : "image/jpeg",
        quality: usePng ? undefined : quality,
      });
      const imageBytes = new Uint8Array(await blob.arrayBuffer());

      // Rebuild (own engine): page per image at the visible point size.
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

  post({ type: "progress", runId, pct: 92, stage: "saving" });

  const saved = out.write();
  const outputName = `${safeBaseName(file.name)}${spec.outputSuffix}.pdf`;

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

/**
 * Shared error mapping for the thin workers: render failures reuse the
 * rasterize copy, passwords and corrupt files map like every other
 * device tool.
 */
export function postRasterColorError(
  runId: number,
  error: unknown,
): void {
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
    runId,
    code,
    detail: code === "tool.errorGeneric" ? message.slice(0, 200) : undefined,
  });
}
