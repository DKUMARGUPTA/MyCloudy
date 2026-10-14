/**
 * Shared pdf.js fake-worker loader for tool workers (the stamp-common
 * precedent, extracted in P4.4 when the OCR tool exposed a latent bug:
 * image pages hit DOMCanvasFactory._createCanvas → `document.createElement`
 * — the old baseURI-only shim broke rasterize/pdf-to-images on scans).
 *
 * Recipe:
 *  - pdf.js (self-hosted /pdfjs) is imported into THIS thread with the
 *    worker module pre-loaded → fake-worker mode: no nested worker, all
 *    parsing/rendering runs on the tool worker's own thread.
 *  - The global `document` shim (workers have none) provides baseURI for
 *    the CMap/StandardFont factories AND createElement → OffscreenCanvas
 *    for the canvas factory, plus documentElement for the rare font-load
 *    style path.
 *  - Pass `ownerDocument: workerDocumentShim()` in every getDocument call
 *    so the canvas factory uses the shim instead of the DOM.
 */

type PdfjsModule = typeof import("pdfjs-dist");

/** Minimal element fake for the rare pdf.js DOM paths (style/span). */
function fakeElement(): {
  style: Record<string, string>;
  append(): void;
  textContent: string;
} {
  return { style: {}, append() {}, textContent: "" };
}

/**
 * A worker-safe stand-in for `document`: same-origin base for URL
 * resolution, `createElement` returning real OffscreenCanvas objects
 * (pdf.js's _scaleImage temp canvases on IMAGE pages need them), and a
 * documentElement head stub for the font-load style path.
 */
export function workerDocumentShim(): {
  baseURI: string;
  createElement: (tag: string) => unknown;
  documentElement: { getElementsByTagName: () => { append(): void }[] };
} {
  return {
    baseURI: self.location.href,
    createElement(tag) {
      return tag === "canvas" ? new OffscreenCanvas(1, 1) : fakeElement();
    },
    documentElement: { getElementsByTagName: () => [fakeElement()] },
  };
}

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/** Loads the self-hosted pdf.js in fake-worker mode (once per worker). */
export function loadPdfjsInWorker(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // pdf.js's default CMap/StandardFont factories resolve URLs against
      // `document.baseURI`, which does not exist inside Web Workers. The
      // shim (same-origin base + OffscreenCanvas createElement) keeps the
      // self-hosted build working without touching its internals.
      if (
        typeof (globalThis as { document?: unknown }).document === "undefined"
      ) {
        (globalThis as { document?: unknown }).document = workerDocumentShim();
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
