import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

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

/**
 * Width/height aspect of a page (PageGrid cell geometry). Uses the cached
 * document + viewport only — no canvas render.
 */
export async function getPdfPageAspect(
  file: File | Blob,
  pageIndex = 0
): Promise<number> {
  const doc = await openDocument(file);
  const page = await doc.getPage(pageIndex + 1); // 1-based in pdf.js
  const viewport = page.getViewport({ scale: 1 });
  const height = Math.max(1, viewport.height);
  return viewport.width / height;
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

/* --------------------- Split support (PRD §8.1) --------------------- */

/** A top-level outline entry resolved to its 1-based start page. */
export interface PdfOutlineEntry {
  title: string;
  page: number;
}

/**
 * Reads the TOP-LEVEL bookmarks of a PDF (PRD §8.1 split mode 3) with the
 * self-hosted pdf.js. Bookmarks that point to external URLs or have
 * unresolvable destinations are skipped — a split needs a real page.
 */
export async function getPdfTopLevelOutline(
  file: File | Blob
): Promise<PdfOutlineEntry[]> {
  const doc = await openDocument(file);
  const outline = await doc.getOutline();
  if (!outline || outline.length === 0) return [];
  const entries: PdfOutlineEntry[] = [];
  for (const item of outline) {
    if (!item.dest) continue;
    try {
      const dest =
        typeof item.dest === "string"
          ? await doc.getDestination(item.dest)
          : item.dest;
      if (!Array.isArray(dest) || dest.length === 0) continue;
      const ref = dest[0];
      if (typeof ref !== "object" || ref === null) continue;
      const pageIndex = await doc.getPageIndex(
        ref as Parameters<typeof doc.getPageIndex>[0]
      );
      const title = (item.title ?? "").trim();
      entries.push({
        title: title.length > 0 ? title : `Bookmark ${entries.length + 1}`,
        page: pageIndex + 1,
      });
    } catch {
      /* unresolvable destination — this bookmark just can't split */
    }
  }
  return entries;
}

export interface BlankDetectionProgress {
  done: number;
  total: number;
}

/**
 * Detects blank separator pages (PRD §8.1 split mode 7). A page is blank
 * when it has no text AND a tiny render is visually near-empty. Text pages
 * skip rendering entirely, so typical documents finish fast; only
 * text-less candidates (e.g. scans) pay for the pixel check.
 */
export async function detectBlankPages(
  file: File | Blob,
  onProgress?: (progress: BlankDetectionProgress) => void
): Promise<number[]> {
  const doc = await openDocument(file);
  const blanks: number[] = [];
  const total = doc.numPages;
  for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
    let blank = false;
    try {
      const page = await doc.getPage(pageNumber);
      const text = await page.getTextContent();
      const hasText = text.items.some(
        (item) =>
          typeof (item as { str?: unknown }).str === "string" &&
          (item as { str: string }).str.trim().length > 0
      );
      if (!hasText) {
        blank = await isPageVisuallyBlank(page);
      }
      page.cleanup();
    } catch {
      blank = false; // unreadable page → treat as content (safe default)
    }
    if (blank) blanks.push(pageNumber);
    onProgress?.({ done: pageNumber, total });
  }
  return blanks;
}

/** Tiny (24px) render + near-white pixel scan, run through the queue. */
async function isPageVisuallyBlank(page: PDFPageProxy): Promise<boolean> {
  await acquire();
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = 24 / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));
    let data: ImageData;
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) return false;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      await page
        .render({
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
        })
        .promise;
      data = context.getImageData(0, 0, width, height);
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return false;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      await page.render({ canvasContext: context, viewport }).promise;
      data = context.getImageData(0, 0, width, height);
    }
    const pixels = data.data;
    const threshold = 245; // near-white tolerance for compression noise
    const darkLimit = Math.ceil((pixels.length / 4) * 0.001); // <0.1% dark
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (
        pixels[i] < threshold ||
        pixels[i + 1] < threshold ||
        pixels[i + 2] < threshold
      ) {
        dark += 1;
        if (dark > darkLimit) return false;
      }
    }
    return true;
  } finally {
    release();
  }
}
