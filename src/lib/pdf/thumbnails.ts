import type { PDFDocumentProxy } from "pdfjs-dist";

import { PDF_DOC_PARAMS, loadPdfjs } from "./pdfjs";

/**
 * Thumbnail pipeline (PRD §2.8: <100ms/page, queued so the UI stays smooth).
 *
 * - Documents are cached per File (WeakMap) — the ArrayBuffer pdf.js detaches
 *   is read exactly once per file.
 * - Render jobs run through a small concurrency queue (2 at a time) so a
 *   100-page grid never blocks the main thread.
 * - Only low-res canvases are produced (maxDim-bounded, PNG blobs).
 */

export interface Thumbnail {
  blob: Blob;
  width: number;
  height: number;
}

const docCache = new WeakMap<File | Blob, Promise<PDFDocumentProxy>>();

export class PdfParseError extends Error {
  constructor(message = "pdf-parse", cause?: unknown) {
    super(message);
    this.name = "PdfParseError";
    if (cause !== undefined) this.cause = cause;
  }
}

export function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    /\.pdf$/i.test(file.name) ||
    file.type === "" // extension-less drops are sniffed by magic bytes instead
  );
}

/** %PDF- magic-byte sniff (PRD §2.4: validate content, never extensions). */
export async function sniffIsPdf(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const magic = "%PDF-";
  for (let start = 0; start <= head.length - magic.length; start += 1) {
    let matched = true;
    for (let i = 0; i < magic.length; i += 1) {
      if (head[start + i] !== magic.charCodeAt(i)) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

async function openDocument(file: File | Blob): Promise<PDFDocumentProxy> {
  let doc = docCache.get(file);
  if (!doc) {
    doc = (async () => {
      const pdfjs = await loadPdfjs();
      const data = new Uint8Array(await file.arrayBuffer());
      // A fresh buffer per open: pdf.js detaches whatever it receives.
      return pdfjs.getDocument({ data, ...PDF_DOC_PARAMS }).promise;
    })().catch((cause: unknown) => {
      docCache.delete(file);
      throw new PdfParseError("pdf-parse", cause);
    });
    docCache.set(file, doc);
  }
  return doc;
}

/** Page count for a File (used by FileCards + recent-file entries). */
export async function getPdfPageCount(file: File | Blob): Promise<number> {
  const doc = await openDocument(file);
  return doc.numPages;
}

/* --------------------------- Render queue --------------------------- */

const MAX_CONCURRENT_RENDERS = 2;

let active = 0;
const queue: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_RENDERS) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => queue.push(resolve));
  active += 1;
}

function release(): void {
  active -= 1;
  const next = queue.shift();
  if (next) next();
}

/**
 * Renders one page of a PDF file into a small PNG blob, bounded by maxDim.
 * Queued — call freely for many pages; only two render at once.
 */
export async function renderPdfThumbnail(
  file: File | Blob,
  options: { pageIndex?: number; maxDim?: number } = {}
): Promise<Thumbnail> {
  const pageIndex = options.pageIndex ?? 0;
  const maxDim = options.maxDim ?? 200;
  await acquire();
  try {
    const doc = await openDocument(file);
    const page = await doc.getPage(pageIndex + 1); // 1-based in pdf.js
    const base = page.getViewport({ scale: 1 });
    const scale = maxDim / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));

    let blob: Blob;
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas-2d-unavailable");
      context.fillStyle = "#ffffff"; // avoid transparent PDF backgrounds
      context.fillRect(0, 0, width, height);
      // Offscreen contexts are runtime-compatible; pdf.js types predate them.
      await page
        .render({
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
        })
        .promise;
      blob = await canvas.convertToBlob({ type: "image/png" });
    } else {
      // Older Safari fallback: a detached DOM canvas works the same.
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas-2d-unavailable");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      await page.render({ canvasContext: context, viewport }).promise;
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png")
      ).then((result) => result ?? new Blob([], { type: "image/png" }));
    }
    page.cleanup();
    return { blob, width, height };
  } finally {
    release();
  }
}

/** Frees cached documents for files that are no longer on screen. */
export function forgetPdfDocument(file: File | Blob): void {
  docCache.delete(file);
}
