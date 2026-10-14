"use client";

import type { PDFDocumentProxy } from "pdfjs-dist";

import { loadPdfjs } from "@/lib/pdf/pdfjs";

import {
  type PageViewportLike,
  type TextBlock,
  buildLines,
  buildBlocks,
  countChars,
  harvestPieces,
} from "./engine";

/**
 * Copy from PDF — extraction half (pdf.js, main thread).
 *
 * Walks every page's text layer ONCE on load (getTextContent — no
 * rendering), converts each run into DISPLAY space via the page
 * viewport (scale 1, /Rotate and crop offsets handled by pdf.js) and
 * builds the clickable paragraph blocks the surface overlays.
 *
 * The worker runs its own extraction inside a Web Worker for the
 * download path — the two share the pure engine, so interactive copy
 * and exported .txt read identically.
 */

/** Honest guard: interactive selection covers the first N pages. */
export const MAX_EXTRACT_PAGES = 200;

export interface ExtractProgress {
  page: number;
  pages: number;
}

export interface ExtractedPage {
  index: number;
  /** Display size in points (viewport scale 1). */
  viewW: number;
  viewH: number;
  blocks: TextBlock[];
}

export interface ExtractResult {
  pages: ExtractedPage[];
  /** Pages the guard skipped (0 when the whole document was read). */
  truncated: number;
}

interface PageLike {
  getViewport: (params: { scale: number }) => PageViewportLike;
  getTextContent: () => Promise<{ items: unknown[] }>;
  cleanup: () => void;
}

/**
 * Extracts clickable text blocks for the whole document.
 * Main-thread only (pdf.js owns its own worker pool).
 */
export async function extractPageBlocks(
  file: File,
  onProgress?: (p: ExtractProgress) => void
): Promise<ExtractResult> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc: PDFDocumentProxy = await pdfjs.getDocument({
    data,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;

  const pageCount = doc.numPages;
  const readable = Math.min(pageCount, MAX_EXTRACT_PAGES);
  const pages: ExtractedPage[] = [];

  for (let p = 1; p <= readable; p += 1) {
    const page = (await doc.getPage(p)) as unknown as PageLike;
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const pieces = harvestPieces(viewport, content.items);
    page.cleanup();

    const lines = buildLines(pieces);
    const blocks = buildBlocks(lines, `p${p - 1}-`, p - 1).filter(
      (block) => countChars(block.text) > 0
    );
    pages.push({
      index: p - 1,
      viewW: viewport.width,
      viewH: viewport.height,
      blocks,
    });
    onProgress?.({ page: p, pages: readable });
  }

  await doc.cleanup();
  return { pages, truncated: Math.max(0, pageCount - readable) };
}
