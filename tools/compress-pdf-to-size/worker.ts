import { PDFDocument } from "pdf-lib";

import {
  type RunDetail,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
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
 * The result detail names WHICH ladder rung produced the output
 * (compressStage + the rung's parameters) so the result card can tell
 * the user HOW the target was reached — lossless clean-up, photo
 * re-encode at N% quality, or rasterized pages at N DPI.
 *
 * Device-only: the File arrives by structured clone, the PDF Blob goes
 * back — nothing touches the network.
 */

type PdfjsModule = typeof import("pdfjs-dist");

function post(response: WorkerResponse): void {
  self.postMessage(response);
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
  // bestImageStep/bestRasterStep remember WHICH rung produced bestBytes
  // (the ladder compounds, so the winning rung's params describe the
  // strongest settings actually applied) — surfaced on the result card.
  let bestBytes = optimized;
  let bestStage: "optimize" | "images" | "raster" = "optimize";
  let bestImageStep = -1;
  let bestRasterStep = -1;

  const finish = (finalBytes: Uint8Array): void => {
    post({ type: "progress", runId, pct: 97, stage: "saving" });
    const detail: RunDetail = {
      files: 1,
      pages: pageCount,
      targetHit: finalBytes.length <= target,
      compressStage: bestStage,
    };
    if (bestStage === "images" && bestImageStep >= 0) {
      const rung = IMAGE_LADDER[bestImageStep];
      detail.compressQuality = Math.round(rung.quality * 100);
      detail.compressMaxDim = rung.maxDim;
      detail.compressGrayscale = rung.grayscale;
    } else if (bestStage === "raster" && bestRasterStep >= 0) {
      detail.compressDpi = RASTER_LADDER[bestRasterStep].dpi;
    }
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
      detail,
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
        bestImageStep = step;
      }
      if (saved.length <= target) break;
    }
  }

  if (bestBytes.length <= target) {
    finish(bestBytes);
    return;
  }

  /* -------- 3. Raster ladder (last resort — text becomes image). -------- */
  const pdfjs = await loadPdfjsInWorker();
  const renderDoc = await pdfjs.getDocument({
    data: bytes.slice(),
    // Worker-safe canvas factory — image pages need createElement
    // (DOMCanvasFactory._createCanvas), the baseURI-only shim blanks them.
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
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
      bestRasterStep = step;
    }
    if (saved.length <= target) break;
  }

  renderDoc.cleanup();
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
