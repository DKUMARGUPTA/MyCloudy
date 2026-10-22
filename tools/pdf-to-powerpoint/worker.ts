import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import {
  buildPptx,
  coerceRunOptions,
  extractTextSlide,
  outputBaseName,
  pdfErrorMessageToCode,
  PPTX_MIME,
  slideSizeFor,
  type PdfTextItemInput,
  type SlidePage,
} from "./model";

/**
 * PDF → PowerPoint worker (RB3-d). 100% on-device: pdf.js runs INSIDE
 * this worker (fake-worker mode, the pdf-to-txt/pdf-to-excel recipe),
 * the file arrives by structured clone and the .pptx Blob leaves the
 * same way — zero network.
 *
 * Two render modes:
 *  - "text" — one getTextContent per page → the model's line/block/
 *    title pipeline → editable text boxes on the slide. A page with no
 *    selectable text becomes an EMPTY slide (honestly counted in the
 *    run detail) instead of failing the whole run.
 *  - "images" — one render per page to an OffscreenCanvas (the
 *    pdf-to-images pattern: sequential pages, one canvas at a time)
 *    → PNG bytes → a full-bleed p:pic per slide.
 *
 * Pinned lessons honoured:
 *  - the buffer handed to getDocument is a FRESH copy (pdf.js detaches
 *    whatever it receives);
 *  - pages cleanup()ped right after use, doc.destroy() in a finally;
 *  - encrypted files fail with tool.errorEncrypted (pdf.js asks for a
 *    password), unreadable bytes with tool.errorCorrupt — never a
 *    silent empty download.
 *
 * Progress: 10 (reading) → 15 (document open) → interpolated per page
 * → 85 (package zipped) → result.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** Render target: ~1.5× the slide width in px, clamped to sane bounds. */
function renderScaleFor(pageW: number, slideCx: number): number {
  const slideWpt = slideCx / 12700;
  const target = Math.max(640, Math.min(2560, slideWpt * 1.5));
  return Math.max(0.5, Math.min(4, target / (pageW > 0 ? pageW : 1)));
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, files } = request;
  const opts = coerceRunOptions(request.options as Record<string, unknown>);

  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 10, stage: "reading" });
  const pdfjs = await loadPdfjsInWorker();
  // Fresh copy per run — pdf.js DETACHES the buffer it receives.
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({
    data,
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;
  post({ type: "progress", runId, pct: 15, stage: "processing" });

  try {
    const pageNumbers = parsePageSpec(opts.pages, doc.numPages);
    if (pageNumbers === null || pageNumbers.length === 0) {
      post({ type: "error", runId, code: "tool.errorInvalidPages" });
      return;
    }

    // Presentation slide size — from the FIRST selected page (match
    // mode is orientation-aware; mixed-size documents contain-fit each
    // page into the one presentation size, honestly).
    const first = await doc.getPage(pageNumbers[0] + 1);
    const firstViewport = first.getViewport({ scale: 1 });
    const slide = slideSizeFor(
      opts.slideSize,
      firstViewport.width,
      firstViewport.height
    );
    first.cleanup();

    const total = pageNumbers.length;
    const progress = (i: number): void => {
      post({
        type: "progress",
        runId,
        pct: 15 + Math.round((70 * (i + 1)) / total),
        stage: "processing",
        detail: { page: i + 1, pages: total },
      });
    };

    let pptx: Uint8Array;
    let emptySlides = 0;
    if (opts.mode === "images") {
      const images: Uint8Array[] = [];
      const aspects: number[] = [];
      for (let i = 0; i < pageNumbers.length; i += 1) {
        const page = await doc.getPage(pageNumbers[i] + 1);
        const viewport = page.getViewport({ scale: 1 });
        const scale = renderScaleFor(viewport.width, slide.cx);
        const renderViewport = page.getViewport({ scale });
        const width = Math.max(1, Math.round(renderViewport.width));
        const height = Math.max(1, Math.round(renderViewport.height));

        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("canvas-2d-unavailable");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        await page.render({
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport: renderViewport,
        }).promise;
        page.cleanup();

        const blob = await canvas.convertToBlob({ type: "image/png" });
        images.push(new Uint8Array(await blob.arrayBuffer()));
        aspects.push(viewport.width / viewport.height);
        progress(i);
      }
      pptx = buildPptx({
        mode: "images",
        slide,
        slideSizeOption: opts.slideSize,
        images,
        imageAspects: aspects,
        title: outputBaseName(file.name, opts.locale),
      });
    } else {
      const pages: SlidePage[] = [];
      for (let i = 0; i < pageNumbers.length; i += 1) {
        const page = await doc.getPage(pageNumbers[i] + 1);
        const viewport = page.getViewport({ scale: 1 });
        let content;
        try {
          content = await page.getTextContent();
        } finally {
          page.cleanup();
        }
        pages.push(
          extractTextSlide(
            content.items as PdfTextItemInput[],
            viewport.width,
            viewport.height,
            slide
          )
        );
        progress(i);
      }
      emptySlides = pages.filter((page) => page.empty).length;
      pptx = buildPptx({
        mode: "text",
        slide,
        slideSizeOption: opts.slideSize,
        pages,
        title: outputBaseName(file.name, opts.locale),
      });
    }

    post({ type: "progress", runId, pct: 85, stage: "saving" });
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${outputBaseName(file.name, opts.locale)}.pptx`,
          mime: PPTX_MIME,
          blob: new Blob([pptx as unknown as BlobPart], { type: PPTX_MIME }),
        },
      ],
      detail: {
        files: 1,
        pages: total,
        slides: total,
        emptySlides,
      },
    });
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId: data.runId,
      code: pdfErrorMessageToCode(message),
    });
  });
};
