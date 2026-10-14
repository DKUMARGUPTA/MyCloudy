import { PDFDocument } from "pdf-lib";
import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import {
  countChars,
  joinTextItems,
  joinTxtPages,
} from "./engine";

/**
 * PDF OCR worker (PRD §8.4) — makes scanned PDFs searchable on-device.
 *
 * Pipeline per page:
 *  1. Quick pdf.js text probe: pages that already carry selectable text
 *     pass through untouched (searchable mode copies the original page
 *     object; text mode uses the extracted text) — mixed documents work
 *     without re-OCRing digital pages.
 *  2. Scanned pages render at the chosen DPI onto an OffscreenCanvas and
 *     go through self-hosted Tesseract (LSTM, /tesseract — see
 *     public/tesseract/LICENSE*.txt, Apache-2.0; nothing leaves origin).
 *  3. Searchable output: tesseract's own PDF renderer writes the page
 *     (raster + invisible word layer with the GlyphLessFont — logical
 *     character order, so Hindi ि/ी matras and conjuncts stay searchable;
 *     the same C++ path OCRmyPDF-style tools rely on). Page PDFs are
 *     merged with pdf-lib next to the passed-through originals.
 *  4. Text output: UTF-8 .txt with the same page markers as pdf-to-txt.
 *
 * Tesseract itself runs as a nested classic worker (blob-wrapped
 * importScripts of the self-hosted worker.min.js — allowed by CSP
 * `worker-src 'self' blob:`) and is kept as a warm singleton so a second
 * run skips the model download (traineddata is also cached in IndexedDB
 * by tesseract itself). Language changes re-initialize in place.
 */

type PdfjsModule = typeof import("pdfjs-dist");

interface TessPage {
  text?: string;
  confidence?: number;
  pdf?: number[] | Uint8Array | null;
}
interface TessWorker {
  recognize: (
    image: Blob | OffscreenCanvas,
    options: Record<string, unknown>,
    output: Record<string, boolean>
  ) => Promise<{ data: TessPage }>;
  setParameters: (
    params: Record<string, string>
  ) => Promise<unknown>;
  reinitialize: (
    langs: string,
    oem?: number,
    config?: Record<string, unknown>
  ) => Promise<unknown>;
  terminate: () => Promise<unknown>;
}
interface TesseractLib {
  createWorker: (
    langs: string,
    oem: number,
    options: Record<string, unknown>
  ) => Promise<TessWorker>;
  OEM: { LSTM_ONLY: number };
}

/* ------------------------------------------------------------------ */
/* Asset URL resolution (blob: dev workers carry the origin inside)    */
/* ------------------------------------------------------------------ */

function assetUrl(path: string): string {
  try {
    const viaLocation = new URL(path, self.location.href);
    if (
      viaLocation.protocol === "http:" ||
      viaLocation.protocol === "https:"
    ) {
      return viaLocation.href;
    }
  } catch {
    // opaque base (Turbopack serves module workers from blob: URLs)
  }
  const blobOrigin = /^blob:(https?:\/\/[^/]+)/i.exec(self.location.href);
  if (blobOrigin) return `${blobOrigin[1]}${path}`;
  return path;
}

/* ------------------------------------------------------------------ */
/* Tesseract (self-hosted ESM bundle, warm singleton)                 */
/* ------------------------------------------------------------------ */

let tessLibPromise: Promise<TesseractLib> | null = null;
let tessWorker: TessWorker | null = null;
let tessLangs = "";

async function loadTesseractLib(): Promise<TesseractLib> {
  if (!tessLibPromise) {
    const url = "/tesseract/tesseract.esm.min.js";
    tessLibPromise = (async () => {
      const mod = (await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ url
      )) as unknown as { default?: TesseractLib } & TesseractLib;
      return mod.default ?? mod;
    })();
  }
  return tessLibPromise;
}

/** A run's language string, e.g. "eng", "hin" or "eng+hin". */
async function getTessWorker(
  langs: string,
  dpi: number
): Promise<TessWorker> {
  if (tessWorker && tessLangs !== langs) {
    // Warm worker, different language — swap the model in place.
    await tessWorker.reinitialize(langs);
    tessLangs = langs;
  }
  if (tessWorker) return tessWorker;
  const tesseract = await loadTesseractLib();
  const worker = await tesseract.createWorker(langs, tesseract.OEM.LSTM_ONLY, {
    workerPath: assetUrl("/tesseract/worker.min.js"),
    corePath: assetUrl("/tesseract"),
    langPath: assetUrl("/tesseract/langs"),
    // Language files are served as .traineddata.gz (see public/tesseract).
    gzip: true,
    workerBlobURL: true,
    logger: () => {
      /* per-page progress is already posted from the run loop */
    },
  });
  await worker.setParameters({
    // Leptonia has no JPEG DPI header for canvases — tell tesseract the
    // render scale so page segmentation and font metrics stay honest.
    user_defined_dpi: String(dpi),
    preserve_interword_spaces: "1",
  });
  tessWorker = worker;
  tessLangs = langs;
  return worker;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

type PdfDoc = Awaited<ReturnType<PdfjsModule["getDocument"]>["promise"]>;

interface RenderedPage {
  canvas: OffscreenCanvas;
}

async function renderPage(
  doc: PdfDoc,
  pageNumber: number,
  scale: number
): Promise<RenderedPage> {
  const page = await doc.getPage(pageNumber);
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
    background: undefined,
  });
  page.cleanup();
  return { canvas };
}

/** Probes a page for selectable text (chars outside whitespace). */
async function probeText(
  doc: PdfDoc,
  pageNumber: number,
  minChars: number
): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  page.cleanup();
  return joinTextItems(content.items as { str?: unknown }[], minChars).text;
}

/** tesseract returns the generated page PDF as a byte array — normalize. */
function tessPdfBytes(pdf: number[] | Uint8Array | null | undefined): Uint8Array {
  if (!pdf || pdf.length === 0) throw new Error("tesseract-pdf-empty");
  return pdf instanceof Uint8Array ? pdf : Uint8Array.from(pdf);
}

/**
 * Materializes a rendered page as committed PNG bytes.
 *
 * Chrome's accelerated OffscreenCanvas can resolve pdf.js's render task
 * while the raster ops are still pending on the GPU — a readback taken
 * that instant returns a BLANK snapshot (verified: a blank ~49 KB PNG
 * for a page whose committed raster is ~87 KB). Converting once, letting
 * an image decode yield, and converting again is stable; the size of two
 * consecutive deterministic encodes only matches once the bitmap has
 * settled, so the loop returns exactly the committed bytes (and exits
 * immediately for genuinely blank pages — their size never changes).
 */
async function committedPngBlob(canvas: OffscreenCanvas): Promise<Blob> {
  let last = await canvas.convertToBlob({ type: "image/png" });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const probe = await createImageBitmap(last);
    probe.close(); // decode yield — lets the pending raster ops commit
    const next = await canvas.convertToBlob({ type: "image/png" });
    if (next.size === last.size) return next;
    last = next;
  }
  return last;
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

/** A page "has text" when this many non-space chars are selectable. */
const TEXT_PAGE_THRESHOLD = 150;

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;

  const langs =
    options.languages === "hin"
      ? "hin"
      : options.languages === "eng+hin"
        ? "eng+hin"
        : "eng";
  const dpi = options.dpi === "300" ? 300 : 150;
  const scale = dpi / 72;
  const outputMode = options.output === "text" ? "text" : "searchable";
  const skipText = options.skipText !== false;
  const markPages = options.pageMarks === true;

  post({ type: "progress", runId, pct: 2, stage: "reading" });
  const pdfjs = await loadPdfjsInWorker();

  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let totalPages = 0;
  let confSum = 0;
  let confCount = 0;
  let totalChars = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const base = file.name
      .replace(/\.(pdf)$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .slice(0, 120);

    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({
      data,
      // Worker-safe canvas factory — image pages need createElement
      // (DOMCanvasFactory._createCanvas), the baseURI-only shim blanks them.
      ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
    }).promise;

    const pageNumbers = parsePageSpec(
      String(options.pages ?? "all"),
      doc.numPages
    );
    if (pageNumbers === null || pageNumbers.length === 0) {
      doc.cleanup();
      post({ type: "error", runId, code: "tool.errorInvalidPages" });
      return;
    }

    // Probe every page's selectable text once — decides the per-page path.
    const nativeTexts: string[] = [];
    for (const pageNumber of pageNumbers) {
      nativeTexts.push(
        await probeText(doc, pageNumber + 1, TEXT_PAGE_THRESHOLD)
      );
    }
    const needsOcr = nativeTexts.map(
      (text) => !(skipText && countChars(text) >= TEXT_PAGE_THRESHOLD)
    );

    let tess: TessWorker | null = null;
    if (needsOcr.some((need) => need)) {
      post({ type: "progress", runId, pct: 4, stage: "reading" });
      try {
        tess = await getTessWorker(langs, dpi);
      } catch {
        post({ type: "error", runId, code: "tool.errorOcrModel" });
        return;
      }
      post({ type: "progress", runId, pct: 8, stage: "reading" });
    }

    const pageCount = pageNumbers.length;
    const progress = (i: number, conf?: number) => {
      post({
        type: "progress",
        runId,
        pct: Math.round(
          8 + ((fileIndex + (i + 1) / pageCount) / files.length) * 84
        ),
        stage: "processing",
        detail: { page: i + 1, pages: pageCount, conf },
      });
    };

    if (outputMode === "text") {
      const pageTexts: string[] = [];
      for (let i = 0; i < pageCount; i += 1) {
        let conf: number | undefined;
        if (!needsOcr[i]) {
          pageTexts.push(nativeTexts[i]);
          totalChars += countChars(nativeTexts[i]);
        } else {
          const rendered = await renderPage(doc, pageNumbers[i] + 1, scale);
          // Same canvas-commit guard as the searchable path (see below).
          const pngBlob = await committedPngBlob(rendered.canvas);
          const result = await tess!.recognize(pngBlob, {}, {
            text: true,
          });
          const text =
            typeof result.data.text === "string" ? result.data.text : "";
          pageTexts.push(text.trim());
          totalChars += countChars(text);
          if (typeof result.data.confidence === "number") {
            conf = Math.round(result.data.confidence);
            confSum += result.data.confidence;
            confCount += 1;
          }
        }
        totalPages += 1;
        progress(i, conf);
      }
      const body = joinTxtPages(pageTexts, pageNumbers, markPages);
      outputs.push({
        name: `${base}.txt`,
        mime: "text/plain;charset=utf-8",
        blob: new Blob([body + "\n"], { type: "text/plain;charset=utf-8" }),
      });
    } else {
      // Searchable PDF: original pages pass through, scanned pages are
      // rebuilt by tesseract's PDF renderer (raster + invisible logical
      // text layer), merged in document order with pdf-lib.
      const srcDoc = needsOcr.some((need) => !need)
        ? await PDFDocument.load(data, { ignoreEncryption: true })
        : null;
      const outDoc = await PDFDocument.create();

      for (let i = 0; i < pageCount; i += 1) {
        let conf: number | undefined;
        if (!needsOcr[i]) {
          const [copied] = await outDoc.copyPages(srcDoc!, [pageNumbers[i]]);
          outDoc.addPage(copied);
          totalChars += countChars(nativeTexts[i]);
        } else {
          const rendered = await renderPage(doc, pageNumbers[i] + 1, scale);
          // Materialize the raster as committed PNG bytes BEFORE recognition:
          // see committedPngBlob — racing the canvas readback handed tesseract
          // a blank image (confidence 0) on accelerated canvases.
          const pngBlob = await committedPngBlob(rendered.canvas);
          const result = await tess!.recognize(
            pngBlob,
            { pdfTitle: base },
            { text: true, pdf: true }
          );
          const pagePdf = await PDFDocument.load(
            tessPdfBytes(result.data.pdf),
            { ignoreEncryption: true }
          );
          const [copied] = await outDoc.copyPages(pagePdf, [0]);
          outDoc.addPage(copied);
          const text =
            typeof result.data.text === "string" ? result.data.text : "";
          totalChars += countChars(text);
          if (typeof result.data.confidence === "number") {
            conf = Math.round(result.data.confidence);
            confSum += result.data.confidence;
            confCount += 1;
          }
        }
        totalPages += 1;
        progress(i, conf);
      }

      post({ type: "progress", runId, pct: 94, stage: "saving" });
      const outBytes = await outDoc.save();
      outputs.push({
        name: `${base}-ocr.pdf`,
        mime: "application/pdf",
        blob: new Blob([outBytes as unknown as BlobPart], {
          type: "application/pdf",
        }),
      });
    }

    doc.cleanup();
  }

  // Nothing recognized anywhere — honest failure instead of an empty file.
  if (totalChars === 0) {
    post({ type: "error", runId, code: "tool.errorOcrEmpty" });
    return;
  }

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: {
      files: outputs.length,
      pages: totalPages,
      confidence: confCount > 0 ? Math.round(confSum / confCount) : undefined,
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /password/i.test(message)
      ? "tool.errorEncrypted"
      : /tesseract|model|traineddata|core/i.test(message)
        ? "tool.errorOcrModel"
        : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code });
  });
};
