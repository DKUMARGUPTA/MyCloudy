import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import { pageText, type RawTextItem } from "../pdf-to-txt/text-layout";
import {
  bm25Search,
  buildIndex,
  type Bm25Index,
  type SearchHit,
} from "./worker-lib";

/**
 * Ask PDF worker (chat-with-pdf, P2 / R54) — REBUILT self-dependent: no
 * /api call, no provider, no network. pdf.js extracts every page's
 * selectable text (the pdf-to-txt recipe), the PURE BM25 engine indexes
 * the passages, and queries run against that in-memory index. The PDF
 * bytes never leave the device; nothing is uploaded anywhere.
 *
 * Private protocol (no run-step, so not the shared WorkerRunRequest):
 *   → { type: "extract", file: ArrayBuffer }
 *   ← { type: "progress", page, total }
 *   ← { type: "indexed", pages, passages, chars }
 *   ← { type: "search", query }        // after "indexed"
 *   ← { type: "results", query, results: SearchHit[] }
 *   ← { type: "error", code }          // "encrypted" | "corrupt" | "noText"
 */

type PdfjsModule = typeof import("pdfjs-dist");

function post(message: unknown): void {
  self.postMessage(message);
}

let index: Bm25Index | null = null;
let indexedPages = 0;

async function extract(file: ArrayBuffer): Promise<void> {
  const pdfjs: PdfjsModule = await loadPdfjsInWorker();
  const data = new Uint8Array(file);
  const doc = await pdfjs.getDocument({
    data,
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;

  const pages: { page: number; text: string }[] = [];
  for (let i = 0; i < doc.numPages; i += 1) {
    const page = await doc.getPage(i + 1);
    const content = await page.getTextContent();
    page.cleanup();
    pages.push({
      page: i + 1,
      text: pageText(content.items as RawTextItem[], "flow"),
    });
    post({ type: "progress", page: i + 1, total: doc.numPages });
  }
  doc.cleanup();

  const totalChars = pages.reduce(
    (sum, p) => sum + p.text.replace(/\s/g, "").length,
    0,
  );
  if (totalChars === 0) {
    post({ type: "error", code: "noText" });
    return;
  }

  index = buildIndex(pages);
  indexedPages = pages.length;
  post({
    type: "indexed",
    pages: pages.length,
    passages: index.passages.length,
    chars: totalChars,
  });
}

function search(query: string): void {
  if (!index) {
    post({ type: "error", code: "corrupt" });
    return;
  }
  const results: SearchHit[] = bm25Search(index, query, { limit: 8 });
  post({ type: "results", query, results });
}

self.onmessage = (event: MessageEvent) => {
  const data = event.data as
    | { type: "extract"; file: ArrayBuffer }
    | { type: "search"; query: string }
    | { type: "reset" };

  if (data?.type === "reset") {
    index = null;
    indexedPages = 0;
    return;
  }
  if (data?.type === "extract") {
    index = null;
    indexedPages = 0;
    extract(data.file).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      post({
        type: "error",
        code: /password/i.test(message) ? "encrypted" : "corrupt",
      });
    });
    return;
  }
  if (data?.type === "search") {
    search(String(data.query ?? ""));
  }
};
