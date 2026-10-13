import { PDFDocument } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import {
  type RedactMark,
  activeMarks,
  boxColor,
  flattenDpi,
  parseRedactMarks,
} from "./engine";

/**
 * Redact PDF worker (PRD §8.4): TRUE redaction, not a cover-up.
 *
 * Pipeline:
 *  1. pdf.js renders every marked page at the chosen DPI (rotation applied,
 *     display space — the same geometry the preview overlay shows).
 *  2. Opaque boxes are painted onto the raster BEFORE encoding, so the
 *     redacted pixels simply do not exist in the image.
 *  3. The output is a NEW document: unmarked pages are copied vector-perfect
 *     with pdf-lib copyPages; each marked page is replaced by a JPEG-only
 *     page of the painted raster. Nothing else from a marked page survives —
 *     content streams, annotations, form widgets and their field values are
 *     never copied into the output at all (pdf-lib keeps unreferenced
 *     objects OUT of a document it builds itself, unlike in-place edits
 *     whose orphaned streams still serialize).
 *  4. Verification: the finished bytes are re-opened with pdf.js and every
 *     marked page must contain zero selectable text. If it does not, the run
 *     fails honestly instead of shipping a broken redaction.
 *
 * Device-only as everywhere: the File arrives by structured clone, the
 * result Blob goes straight back — no network hop, ever.
 */

type PdfjsModule = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function loadPdfjsInWorker(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      if (
        typeof (globalThis as { document?: unknown }).document === "undefined"
      ) {
        (globalThis as { document?: unknown }).document = {
          baseURI: self.location.href,
        };
      }
      const libUrl = "/pdfjs/pdf.min.mjs";
      const workerUrl = "/pdfjs/pdf.worker.min.mjs";
      const lib = (await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ libUrl
      )) as PdfjsModule;
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

/** Safety valve: no single page raster may exceed this many pixels. */
const MAX_CANVAS_PIXELS = 40_000_000;

interface PaintedPage {
  pageIndex: number;
  bytes: Uint8Array;
  /** Display dims at scale 1 (the new page's size). */
  w: number;
  h: number;
}

/**
 * Renders one page with its boxes painted on. Display fractions × canvas
 * dims is the whole geometry — the preview overlay, the marks and this
 * raster share one coordinate system.
 */
async function paintPage(
  pdfjs: PdfjsModule,
  doc: import("pdfjs-dist").PDFDocumentProxy,
  markPage: number,
  marks: RedactMark[],
  dpi: number,
  color: string
): Promise<PaintedPage> {
  const page = await doc.getPage(markPage + 1);
  const base = page.getViewport({ scale: 1 });
  let scale = dpi / 72;
  const pixelBudget = base.width * base.height * scale * scale;
  if (pixelBudget > MAX_CANVAS_PIXELS) {
    scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixelBudget);
  }
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.round(viewport.width));
  const height = Math.max(1, Math.round(viewport.height));

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas-2d-unavailable");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  await page.render({
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;

  // Opaque overwrite — the covered pixels are gone before encoding.
  context.fillStyle = color;
  for (const mark of marks) {
    context.fillRect(
      Math.floor(mark.x * width),
      Math.floor(mark.y * height),
      Math.max(1, Math.ceil(mark.w * width)),
      Math.max(1, Math.ceil(mark.h * height))
    );
  }
  page.cleanup();

  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  return {
    pageIndex: markPage,
    bytes: new Uint8Array(await blob.arrayBuffer()),
    w: base.width,
    h: base.height,
  };
}

/** Joins every text item of a page — "" means "no selectable text". */
async function pageSelectableText(
  pdfjs: PdfjsModule,
  data: Uint8Array,
  pageIndex: number
): Promise<string> {
  const doc = await pdfjs.getDocument({
    data,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;
  try {
    const page = await doc.getPage(pageIndex + 1);
    const content = await page.getTextContent();
    page.cleanup();
    return (content.items as { str?: unknown }[])
      .map((item) => (typeof item.str === "string" ? item.str : ""))
      .join("")
      .trim();
  } finally {
    doc.cleanup();
  }
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const mkey = typeof options.mkey === "string" ? options.mkey : "";
  const marks = activeMarks(parseRedactMarks(options[`m:${mkey}`]), 10_000);
  if (marks.length === 0) {
    post({ type: "error", runId, code: "tool.errorRedactNoMarks" });
    return;
  }
  const dpi = flattenDpi(options.dpi);
  const color = boxColor(options.color);

  post({ type: "progress", runId, pct: 5, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());

  // Fail fast on encrypted / unparseable files before any heavy work.
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
  } catch (error) {
    post({
      type: "error",
      runId,
      code:
        error instanceof Error && /encrypt/i.test(error.message)
          ? "tool.errorEncrypted"
          : "tool.errorCorrupt",
    });
    return;
  }
  const pageCount = src.getPageCount();

  const pdfjs = await loadPdfjsInWorker();
  const jsDoc = await pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;
  try {
    // Marks outside the real page range (stale payload) are dropped.
    const valid = marks.filter((m) => m.page < jsDoc.numPages);
    if (valid.length === 0) {
      post({ type: "error", runId, code: "tool.errorRedactNoMarks" });
      return;
    }
    const pagesByMark = new Map<number, RedactMark[]>();
    for (const mark of valid) {
      const list = pagesByMark.get(mark.page) ?? [];
      list.push(mark);
      pagesByMark.set(mark.page, list);
    }

    // --- 1. Paint every marked page ----------------------------------
    const painted: PaintedPage[] = [];
    let done = 0;
    for (const [pageIndex, pageMarks] of pagesByMark) {
      painted.push(await paintPage(pdfjs, jsDoc, pageIndex, pageMarks, dpi, color));
      done += 1;
      post({
        type: "progress",
        runId,
        pct: 10 + Math.round((done / pagesByMark.size) * 55),
        stage: "processing",
        detail: { page: done, pages: pagesByMark.size },
      });
    }

    // --- 2. Rebuild: copies for clean pages, JPEG pages for marked ----
    post({ type: "progress", runId, pct: 68, stage: "processing" });
    const out = await PDFDocument.create();
    const keep = Array.from({ length: pageCount }, (_, i) => i).filter(
      (i) => !pagesByMark.has(i)
    );
    const copied = keep.length > 0 ? await out.copyPages(src, keep) : [];
    let copyAt = 0;
    const redactedIndexes: number[] = [];
    for (let i = 0; i < pageCount; i += 1) {
      const paint = painted.find((p) => p.pageIndex === i);
      if (paint) {
        const page = out.addPage([paint.w, paint.h]);
        const img = await out.embedJpg(paint.bytes);
        page.drawImage(img, {
          x: 0,
          y: 0,
          width: paint.w,
          height: paint.h,
        });
        redactedIndexes.push(i);
      } else {
        out.addPage(copied[copyAt]);
        copyAt += 1;
      }
    }

    post({ type: "progress", runId, pct: 86, stage: "saving" });
    const outBytes = await out.save({ useObjectStreams: true });

    // --- 3. Verify: marked pages must carry zero selectable text ------
    post({ type: "progress", runId, pct: 92, stage: "saving" });
    for (const pageIndex of redactedIndexes) {
      const text = await pageSelectableText(pdfjs, outBytes.slice(), pageIndex);
      if (text.length > 0) {
        post({ type: "error", runId, code: "tool.errorRedactVerify" });
        return;
      }
    }

    post({ type: "progress", runId, pct: 98, stage: "saving" });
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${fileBaseName(file.name)}-redacted.pdf`,
          mime: "application/pdf",
          blob: new Blob([outBytes as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: { files: 1, pages: out.getPageCount() },
    });
  } finally {
    jsDoc.cleanup();
  }
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  const data = event.data;
  if (data?.type !== "run") return;
  void run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /password/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code });
  });
};
