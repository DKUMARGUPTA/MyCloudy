import type * as PdfjsModule from "pdfjs-dist";

/**
 * Self-hosted pdf.js loader (PRD §2.3: pdf.js from /public/pdfjs, never a CDN).
 *
 * The library + worker + cmaps + standard fonts were copied at install time
 * from the pinned npm package `pdfjs-dist@4.10.38` into /public/pdfjs, so the
 * runtime import below is same-origin and CSP-clean ('self'). The bundler
 * ignore comments keep Turbopack/webpack from resolving the public URL.
 */

export const PDFJS_ASSET_VERSION = "4.10.38";

let pdfjsPromise: Promise<typeof PdfjsModule> | null = null;

export function loadPdfjs(): Promise<typeof PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // Non-literal specifier: the bundler ignore comments below keep this
      // a runtime import from our own origin (/public/pdfjs) instead of a
      // statically-resolved module — PRD §2.3 self-hosting, CSP 'self'.
      const moduleUrl = "/pdfjs/pdf.min.mjs";
      const lib = (await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ moduleUrl
      )) as typeof PdfjsModule;
      lib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
      return lib;
    })();
  }
  return pdfjsPromise;
}

/** Common document params: CJK/Indic cmaps + standard fonts, self-hosted. */
export const PDF_DOC_PARAMS = {
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdfjs/standard_fonts/",
} as const;
