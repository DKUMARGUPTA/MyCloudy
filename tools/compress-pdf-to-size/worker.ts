import { PDFDocument } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import { stripAllMetadata } from "../meta-common/worker-lib";
import {
  collectImageCandidates,
  replaceImageStream,
} from "../compress-pdf/engine";
import {
  committedJpegBlob,
  recompressCandidate,
} from "../compress-common/recompress";
import {
  IMAGE_LADDER,
  RASTER_LADDER,
  resolveTargetBytes,
} from "./engine";

/**
 * Compress-to-target-size worker (PRD §7.5, device mode) — "Iterative
 * compress": walk a deterministic ladder from least to most damage and
 * stop at the first attempt whose output fits the byte budget.
 *
 *   0. Input already fits → handed back untouched, zero risk.
 *   1. Structural pass: pdf-lib object streams + metadata strip.
 *      (Text/photos untouched.)
 *   2. IMAGE_LADDER: re-encode embedded photos step by step (quality ↓,
 *      pixel cap ↓, grayscale at the end) — text, fonts and vector art
 *      stay untouched, so selectable text stays selectable. The per-image
 *      ≥2% size guard means each step can only shrink further.
 *   3. RASTER_LADDER: whole pages rasterized via pdf.js (render → JPEG
 *      with the canvas-commit guard) into a fresh PDF. Last resort for
 *      font/vector-heavy files; text becomes an image.
 *
 * If even the floor misses the budget, the SMALLEST attempt wins and the
 * result reports targetHit: false (an honest chip, never a lie).
 *
 * Device-only: the File arrives by structured clone, the PDF Blob goes
 * back — nothing touches the network.
 */

type PdfjsModule = typeof import("pdfjs-dist");

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/* ------------------------------------------------------------------ */
/* pdf.js (fake-worker mode — same recipe as ocr-pdf / pdf-to-images)  */
/* ------------------------------------------------------------------ */

let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function loadPdfjsInWorker(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      if (
        typeof (globalThis as { document?: unknown }).document === "undefined"
      ) {
        (globalThis as { document?: unknown }).document = {
          baseURI: self.location.href,
        };
      }
      const libUrl = "/pdfjs/pdf.min.mjs";
      const workerUrl = "/pdfjs/pdf.worker.min.mjs";
      const lib = (await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ libUrl
      )) as PdfjsModule;
      await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ workerUrl
      );
      return lib;
    })();
  }
  return pdfjsPromise;
}

/** Rendered page raster + the upright page size in PDF points. */
interface RasterizedPage {
  canvas: OffscreenCanvas;
  widthPt: number;
  heightPt: number;
}

async function rasterizePage(
  doc: Awaited<ReturnType<PdfjsModule["getDocument"]>["promise"]>,
  pageNumber: number,
  dpi: number
): Promise<RasterizedPage> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: dpi / 72 });
  const width = Math.max(1, Math.round(viewport.width));
  const height = Math.max(1, Math.round(viewport.height));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas-2d-unavailable");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  await page.render({
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
    background: undefined,
  });
  page.cleanup();
  return {
    canvas,
    widthPt: base.width,
    heightPt: base.height,
  };
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const target = resolveTargetBytes(options as Record<string, unknown>);
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorNoPages" });
    return;
  }
  const base = fileBaseName(file.name);

  post({ type: "progress", runId, pct: 2, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());

  /* -------- 0. Already under budget — hand back untouched. -------- */
  if (bytes.length <= target) {
    // Page count for the result chip — best-effort (encrypted or damaged
    // files still pass through, just without the count).
    let pageCountPassthrough = 0;
    try {
      pageCountPassthrough = (
        await PDFDocument.load(bytes, {
          ignoreEncryption: true,
          updateMetadata: false,
        })
      ).getPageCount();
    } catch {
      /* the bytes are returned untouched either way */
    }
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${base}-compressed.pdf`,
          mime: "application/pdf",
          blob: new Blob([bytes as BlobPart], { type: "application/pdf" }),
        },
      ],
      detail: {
        files: 1,
        pages: pageCountPassthrough,
        targetHit: true,
      },
    });
    return;
  }

  /* -------- 1. Structural pass: object streams + metadata strip. -------- */
  let pageCount = 0;
  let optimized: Uint8Array;
  let ladderDoc: Awaited<ReturnType<typeof PDFDocument.load>>;
  try {
    ladderDoc = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    pageCount = ladderDoc.getPageCount();
    stripAllMetadata(ladderDoc, true);
    optimized = await ladderDoc.save({ useObjectStreams: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId,
      code: /password|encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt",
    });
    return;
  }

  if (pageCount === 0) {
    post({ type: "error", runId, code: "tool.errorNoPages" });
    return;
  }

  // Best attempt so far — the output can never be bigger than this.
  let bestBytes = optimized;
  let bestStage: "optimize" | "images" | "raster" = "optimize";

  const finish = (finalBytes: Uint8Array) => {
    post({ type: "progress", runId, pct: 97, stage: "saving" });
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${base}-compressed.pdf`,
          mime: "application/pdf",
          blob: new Blob([finalBytes as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: {
        files: 1,
        pages: pageCount,
        targetHit: finalBytes.length <= target,
      },
    });
  };

  if (optimized.length <= target) {
    finish(optimized);
    return;
  }

  /* -------- 2. Image ladder (text stays selectable). -------- */
  // Pessimistic unit total for the progress bar: every ladder step is
  // walked against every image + (later) every page.
  const imageCount = collectImageCandidates(ladderDoc).length;
  const totalUnits =
    imageCount * IMAGE_LADDER.length + pageCount * RASTER_LADDER.length;
  let doneUnits = 0;
  const pctNow = () =>
    Math.min(
      95,
      4 + Math.round((doneUnits / Math.max(1, totalUnits)) * 91)
    );

  if (imageCount > 0) {
    for (let step = 0; step < IMAGE_LADDER.length; step += 1) {
      const params = IMAGE_LADDER[step];
      const candidates = collectImageCandidates(ladderDoc);
      for (let i = 0; i < candidates.length; i += 1) {
        const result = await recompressCandidate(
          candidates[i],
          params.quality,
          params.maxDim,
          params.grayscale
        );
        if (result) {
          replaceImageStream(
            ladderDoc.context,
            candidates[i],
            result.bytes,
            result.width,
            result.height
          );
        }
        doneUnits += 1;
        post({
          type: "progress",
          runId,
          pct: pctNow(),
          stage: "processing",
          detail: { page: i + 1, pages: candidates.length },
        });
      }
      const saved = await ladderDoc.save({ useObjectStreams: true });
      if (saved.length < bestBytes.length) {
        bestBytes = saved;
        bestStage = "images";
      }
      if (saved.length <= target) break;
    }
  }

  if (bestBytes.length <= target) {
    void bestStage;
    finish(bestBytes);
    return;
  }

  /* -------- 3. Raster ladder (last resort — text becomes image). -------- */
  const pdfjs = await loadPdfjsInWorker();
  const renderDoc = await pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;

  for (let step = 0; step < RASTER_LADDER.length; step += 1) {
    const params = RASTER_LADDER[step];
    const outDoc = await PDFDocument.create();
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const raster = await rasterizePage(renderDoc, pageNumber, params.dpi);
      // JPEG bytes only count once the accelerated canvas has committed
      // (see committedJpegBlob — the P3.19 blank-snapshot race).
      const jpegBlob = await committedJpegBlob(raster.canvas, params.quality);
      const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
      const embedded = await outDoc.embedJpg(jpegBytes);
      const page = outDoc.addPage([raster.widthPt, raster.heightPt]);
      page.drawImage(embedded, {
        x: 0,
        y: 0,
        width: raster.widthPt,
        height: raster.heightPt,
      });
      doneUnits += 1;
      post({
        type: "progress",
        runId,
        pct: pctNow(),
        stage: "processing",
        detail: { page: pageNumber, pages: pageCount },
      });
    }
    const saved = await outDoc.save({ useObjectStreams: true });
    if (saved.length < bestBytes.length) {
      bestBytes = saved;
      bestStage = "raster";
    }
    if (saved.length <= target) break;
  }

  renderDoc.cleanup();
  void bestStage;
  finish(bestBytes);
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /password|encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : /canvas-2d/i.test(message)
        ? "tool.errorEncode"
        : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code });
  });
};
