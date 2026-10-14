import type { WorkerRunRequest, WorkerResponse } from "@/lib/workers/protocol";

import {
  classifyExtractError,
  expandToRGBA,
  EXI_FORMATS,
  makeImageName,
  parseSelectedSet,
  passesMinSize,
  resolveExiOptions,
  sanitizeExiBase,
} from "./engine";
import { collectImages, type PdfjsWalkLib, type RawImage } from "./collect";

/**
 * Extract PDF images worker (PRD §8.1). pdf.js runs IN THIS WORKER
 * (fake-worker mode, same recipe as pdf-to-images): every page's operator
 * list is walked for image-painting operators and each accepted detection
 * is re-encoded to PNG or JPEG via OffscreenCanvas as soon as it resolves
 * (streaming — one image payload in memory at a time, so a 200-page
 * scanned document never spikes memory).
 *
 * The outputs are the image files themselves — the shared ResultView
 * already offers per-file download plus "Download all (ZIP)".
 *
 * Device-only: the File arrives by structured clone, image Blobs go back.
 */

type PdfjsModule = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function loadPdfjsInWorker(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // pdf.js's default CMap/StandardFont factories resolve URLs against
      // `document.baseURI`, which does not exist inside Web Workers. A
      // one-property shim (same-origin base) keeps the self-hosted build
      // working without touching its internals.
      if (typeof (globalThis as { document?: unknown }).document === "undefined") {
        (globalThis as { document?: unknown }).document = {
          baseURI: self.location.href,
        };
      }
      const libUrl = "/pdfjs/pdf.min.mjs";
      const workerUrl = "/pdfjs/pdf.worker.min.mjs";
      const lib = (await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ libUrl
      )) as PdfjsModule;
      // Pre-load the worker module into THIS thread → fake-worker mode
      // (pdf.js then runs on our own thread — no nested worker needed).
      await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ workerUrl
      );
      return lib;
    })();
  }
  return pdfjsPromise;
}

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** Re-encode one detection to the chosen format (OffscreenCanvas). */
async function encodeImage(
  image: RawImage,
  format: "png" | "jpg"
): Promise<Blob | null> {
  const info = EXI_FORMATS[format];
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas-2d-unavailable");
  if (!info.alpha) {
    // JPEG has no alpha — flatten onto the same white pdf.js paints.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, image.width, image.height);
  }
  if (image.bitmap) {
    context.drawImage(image.bitmap, 0, 0);
    // NOTE: never close pdf.js-owned ImageBitmaps — closing the bitmap
    // behind pdf.js's back breaks later objs/commonObjs resolutions in
    // the same document (found in browser QA: page 2's g_ image never
    // resolved after page 1's bitmap was closed). pdf.js owns the cache.
  } else if (image.data) {
    const rgba = expandToRGBA(
      image.data,
      image.kind,
      image.width,
      image.height
    );
    if (!rgba) return null;
    context.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
  } else {
    return null;
  }
  return canvas.convertToBlob({
    type: info.mime,
    quality: info.alpha ? undefined : info.quality,
  });
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const { minSize, format, selected } = resolveExiOptions(options);
  // Selection keys were minted against file #1 only (the previewed file).
  const selectedSet = parseSelectedSet(selected);

  const pdfjs = await loadPdfjsInWorker();
  const walkLib = pdfjs as unknown as PdfjsWalkLib;
  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let totalPages = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const base = sanitizeExiBase(file.name);

    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({
      data,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
    }).promise;

    let encoded = 0;
    const onImage = async (image: RawImage): Promise<void> => {
      // The size filter applies to every file; the explicit selection
      // (surface checkboxes) only ever restricts the previewed first file.
      if (!passesMinSize(image.width, image.height, minSize)) return;
      if (
        selectedSet !== null &&
        fileIndex === 0 &&
        !selectedSet.has(image.key)
      ) {
        return;
      }
      const blob = await encodeImage(image, format);
      if (!blob) return;
      encoded += 1;
      outputs.push({
        name: makeImageName(base, image.page, encoded, format),
        mime: EXI_FORMATS[format].mime,
        blob,
      });
    };
    const onPage = (page: number, pages: number): void => {
      totalPages += 1;
      post({
        type: "progress",
        runId,
        pct: Math.round(
          ((fileIndex + (0.9 * page) / pages) / files.length) * 95
        ),
        stage: "processing",
        detail: { page, pages },
      });
    };

    try {
      await collectImages(walkLib, doc, fileIndex, { onImage, onPage });
    } finally {
      await doc.destroy().catch(() => undefined);
    }
  }

  // Honest empty result: nothing survived the filters (scanned PDFs are
  // one big photo per page; the size filter hides small images).
  if (outputs.length === 0) {
    post({ type: "error", runId, code: "exi.errorNoImages" });
    return;
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
    post({
      type: "error",
      runId: data.runId,
      code: classifyExtractError(message),
    });
  });
};
