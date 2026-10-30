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
 *
 * Fonts — the tofu fix (R16): Web Workers have no <style> element, so
 * pdf.js's CSS @font-face fallback CANNOT work here. Without a usable
 * font source its FontLoader throws mid-bind and the FontFallback
 * recovery renders every glyph as the embedded font's .notdef outline —
 * whole pages of tofu boxes (reproduced with Chromium-printed PDFs whose
 * fonts are fully embedded). Two-layer fix:
 *   1. Engines that expose a FontFaceSet on WorkerGlobalScope (Chrome,
 *      Edge, …) get it handed to pdf.js via the shim's `document.fonts`
 *      → embedded fonts register natively and OffscreenCanvas text
 *      renders with the real glyphs (verified end-to-end in-worker).
 *   2. Engines without one (older Safari/Firefox) get `disableFontFace:
 *      true` injected into every getDocument call → pdf.js's fontless
 *      mode, where each glyph is drawn as a Path2D outline compiled from
 *      the embedded font data. Universally correct (the same mode pdf.js
 *      uses under Node.js); it also turns OFF system-font substitution,
 *      so non-embedded standard fonts come from our self-hosted
 *      /pdfjs/standard_fonts data and render as paths too.
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
 * The worker's REAL FontFaceSet, when the engine exposes one on
 * WorkerGlobalScope. This is the only font API a worker ever gets —
 * OffscreenCanvas 2D text resolves families from this very set.
 */
function workerFontFaceSet(): FontFaceSet | undefined {
  const set = (self as { fonts?: FontFaceSet }).fonts;
  // Guard the shape: a set without .add is useless to pdf.js's FontLoader.
  return set && typeof set.add === "function" ? set : undefined;
}

/**
 * A worker-safe stand-in for `document`: same-origin base for URL
 * resolution, `createElement` returning real OffscreenCanvas objects
 * (pdf.js's _scaleImage temp canvases on IMAGE pages need them), the
 * real worker FontFaceSet as `fonts` when available (native embedded-font
 * rendering — see the file header), and a documentElement head stub for
 * the font-load style path.
 */
export function workerDocumentShim(): {
  baseURI: string;
  fonts?: FontFaceSet;
  createElement: (tag: string) => unknown;
  documentElement: { getElementsByTagName: () => { append(): void }[] };
} {
  return {
    baseURI: self.location.href,
    fonts: workerFontFaceSet(),
    createElement(tag) {
      return tag === "canvas" ? new OffscreenCanvas(1, 1) : fakeElement();
    },
    documentElement: { getElementsByTagName: () => [fakeElement()] },
  };
}

/**
 * Force fontless (glyph-path) rendering when the engine has no worker
 * FontFaceSet. pdf.js's FontLoader would otherwise try the CSS-rule
 * branch — which cannot work without a real <style>.sheet — and its
 * error recovery (FontFallback → partial glyphCache paths) renders
 * tofu. With `disableFontFace: true` the evaluator compiles Path2D
 * outlines for every glyph it meets during page evaluation, and the
 * canvas backend paints those instead of calling fillText.
 */
function withWorkerFontFallback(lib: PdfjsModule): PdfjsModule {
  if (workerFontFaceSet() !== undefined) return lib;
  const getDocument = (
    src: Parameters<PdfjsModule["getDocument"]>[0]
  ): ReturnType<PdfjsModule["getDocument"]> =>
    lib.getDocument(
      src !== null &&
        typeof src === "object" &&
        !("disableFontFace" in (src as object))
        ? { ...(src as object), disableFontFace: true }
        : src
    );
  // Module namespace objects are frozen — spread into a plain wrapper
  // and override just getDocument. Every other export passes through.
  return { ...lib, getDocument } as PdfjsModule;
}

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/** Loads the self-hosted pdf.js in fake-worker mode (once per worker). */
export function loadPdfjsInWorker(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // pdf.js's default CMap/StandardFont factories resolve URLs against
      // `document.baseURI`, which does not exist inside Web Workers. The
      // shim (same-origin base + OffscreenCanvas createElement + the real
      // worker FontFaceSet) keeps the self-hosted build working without
      // touching its internals.
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
      return withWorkerFontFallback(lib);
    })();
  }
  return pdfjsPromise;
}
