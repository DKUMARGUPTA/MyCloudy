"use client";

/**
 * Edit PDF — main-thread pdf.js helpers for the editor surface:
 *
 *   • getPageViews — crop-box + /Rotate for every original page (feeds the
 *     display↔user-space transforms in the worker and the display sizes).
 *   • renderPageBitmap — a page rendered at (its own /Rotate + the extra
 *     rotation the user applied in the editor), because the shared
 *     renderPdfThumbnail only honors the page's own /Rotate.
 *
 * Documents are opened once per File (WeakMap) and reused by both helpers;
 * a 2-slot render queue keeps big documents from stampeding pdf.js.
 */

import { loadPdfjs, PDF_DOC_PARAMS } from "@/lib/pdf/pdfjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PageViewLite } from "./model";

interface LoadedDoc {
  doc: PDFDocumentProxy;
  views: PageViewLite[];
}

const docCache = new WeakMap<File, Promise<LoadedDoc>>();

function normalizeRotate(rotate: number): PageViewLite["rotate"] {
  const mod = ((rotate % 360) + 360) % 360;
  // pdf.js treats non-multiples of 90 as 0 (PageViewport contract).
  if (mod === 90) return 90;
  if (mod === 180) return 180;
  if (mod === 270) return 270;
  return 0;
}

/** Open a document once and collect its page views (crop box + rotation). */
export function getLoadedDoc(file: File): Promise<LoadedDoc> {
  const cached = docCache.get(file);
  if (cached) return cached;
  const promise = (async () => {
    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({ data, ...PDF_DOC_PARAMS }).promise;
    const views: PageViewLite[] = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const view = page.view as number[];
      views.push({
        x0: view[0],
        y0: view[1],
        x1: view[2],
        y1: view[3],
        rotate: normalizeRotate(page.rotate as number),
      });
      page.cleanup();
    }
    return { doc, views };
  })();
  docCache.set(file, promise);
  promise.catch(() => docCache.delete(file));
  return promise;
}

/** Crop-box + rotation views for every page of a file. */
export async function getPageViews(file: File): Promise<PageViewLite[]> {
  const loaded = await getLoadedDoc(file);
  return loaded.views;
}

// --- 2-slot render queue ----------------------------------------------------

let active = 0;
const queue: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < 2) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => queue.push(resolve));
  active += 1;
}

function release(): void {
  active = Math.max(0, active - 1);
  const next = queue.shift();
  if (next) next();
}

/**
 * Render one page to a bitmap at `maxDim` on its long side, honoring the
 * page's own /Rotate PLUS the editor's extra quarter-turns.
 */
export async function renderPageBitmap(
  file: File,
  pageIndex: number,
  extraRotation: number,
  maxDim: number
): Promise<ImageBitmap> {
  await acquire();
  try {
    const loaded = await getLoadedDoc(file);
    const page = await loaded.doc.getPage(pageIndex + 1);
    const base = page.getViewport({ scale: 1, rotation: (page.rotate + extraRotation) as number });
    const scale = maxDim / Math.max(base.width, base.height);
    const viewport = page.getViewport({
      scale,
      rotation: (page.rotate + extraRotation) as number,
    });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas-2d-unavailable");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    await page.render({
      canvasContext: context,
      viewport,
    }).promise;
    page.cleanup();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png")
    );
    if (blob === null) throw new Error("render-failed");
    return await createImageBitmap(blob);
  } finally {
    release();
  }
}
