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
  type DisplayLine,
  blocksToMarkdown,
  buildBlocks,
  buildLines,
  countChars,
  harvestPieces,
  linesToFlowText,
  linesToVerbatim,
  textToLines,
} from "./engine";

/**
 * Copy from PDF worker (PRD §7.1, §8.1) — the download half.
 *
 * Per page: pdf.js text layer → display-space lines (the SAME pure
 * engine the interactive surface uses, so a copied paragraph and the
 * exported .txt read identically). Pages without selectable text fall
 * back to on-device OCR — automatically in "auto" mode, on every page
 * in "always", never in "off" — via the self-hosted Tesseract recipe
 * pinned in tools/ocr-pdf (warm singleton, committedPngBlob guard,
 * nothing leaves the origin).
 *
 * Output: <name>.txt (flow paragraphs or verbatim lines) or <name>.md
 * (headings, bullets, paragraphs). Page markers optional.
 */

type PdfjsModule = typeof import("pdfjs-dist");

interface TessPage {
  text?: string;
  confidence?: number;
}
interface TessWorker {
  recognize: (
    image: Blob | OffscreenCanvas,
    options: Record<string, unknown>,
    output: Record<string, boolean>
  ) => Promise<{ data: TessPage }>;
  setParameters: (params: Record<string, string>) => Promise<unknown>;
  reinitialize: (langs: string, oem?: number, config?: Record<string, unknown>) => Promise<unknown>;
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
    gzip: true,
    workerBlobURL: true,
    logger: () => {
      /* per-page progress is already posted from the run loop */
    },
  });
  await worker.setParameters({
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

interface PageLike {
  getViewport: (params: { scale: number }) => {
    width: number;
    height: number;
    transform: number[];
  };
  getTextContent: () => Promise<{ items: unknown[] }>;
  render: (params: Record<string, unknown>) => { promise: Promise<void> };
  cleanup: () => void;
}

async function renderPage(
  doc: PdfDoc,
  pageNumber: number,
  scale: number
): Promise<OffscreenCanvas> {
  const page = (await doc.getPage(pageNumber)) as unknown as PageLike;
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
  return canvas;
}

/**
 * Materializes a rendered page as committed PNG bytes (canvas-commit
 * race guard — see tools/ocr-pdf/worker.ts for the war story).
 */
async function committedPngBlob(canvas: OffscreenCanvas): Promise<Blob> {
  let last = await canvas.convertToBlob({ type: "image/png" });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const probe = await createImageBitmap(last);
    probe.close();
    const next = await canvas.convertToBlob({ type: "image/png" });
    if (next.size === last.size) return next;
    last = next;
  }
  return last;
}

/** Extracts one page's native text as display-space lines. */
async function nativeLines(doc: PdfDoc, pageNumber: number): Promise<DisplayLine[]> {
  const page = (await doc.getPage(pageNumber)) as unknown as PageLike;
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const pieces = harvestPieces(viewport, content.items);
  page.cleanup();
  return buildLines(pieces);
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

/**
 * A page "has text" when this many non-space chars are selectable —
 * below it the page is a scan (or a bare watermark/page number) and
 * Auto mode OCRs it. Copy's promise is "OCR only pages without text",
 * so this is far lower than ocr-pdf's 150-char bar.
 */
const TEXT_PAGE_THRESHOLD = 30;
/** OCR render DPI (the ocr-pdf default — accurate and quick). */
const OCR_DPI = 150;

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;

  const format = options.format === "md" ? "md" : "txt";
  const layout = options.layout === "lines" ? "lines" : "flow";
  const ocrMode =
    options.ocrMode === "always"
      ? "always"
      : options.ocrMode === "off"
        ? "off"
        : "auto";
  const langs =
    options.lang === "hi"
      ? "hin"
      : options.lang === "eng"
        ? "eng"
        : "eng+hin";
  const markPages = options.pageMarks === true;

  post({ type: "progress", runId, pct: 2, stage: "reading" });
  const pdfjs = await loadPdfjsInWorker();

  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let totalPages = 0;
  let totalChars = 0;
  let confSum = 0;
  let confCount = 0;

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

    // Probe every page's native lines once — decides the per-page path.
    const natives: DisplayLine[][] = [];
    for (const pageNumber of pageNumbers) {
      natives.push(await nativeLines(doc, pageNumber + 1));
    }
    const needsOcr = natives.map((lines) => {
      if (ocrMode === "off") return false;
      if (ocrMode === "always") return true;
      return countChars(linesToFlowText(lines)) < TEXT_PAGE_THRESHOLD;
    });

    let tess: TessWorker | null = null;
    if (needsOcr.some((need) => need)) {
      post({ type: "progress", runId, pct: 4, stage: "reading" });
      try {
        tess = await getTessWorker(langs, OCR_DPI);
      } catch {
        doc.cleanup();
        post({ type: "error", runId, code: "tool.errorOcrModel" });
        return;
      }
      post({ type: "progress", runId, pct: 8, stage: "reading" });
    }

    const pageCount = pageNumbers.length;
    const pageTexts: string[] = [];

    for (let i = 0; i < pageCount; i += 1) {
      let lines = natives[i];
      let conf: number | undefined;

      if (needsOcr[i] && tess !== null) {
        const canvas = await renderPage(doc, pageNumbers[i] + 1, OCR_DPI / 72);
        const pngBlob = await committedPngBlob(canvas);
        const result = await tess.recognize(pngBlob, {}, { text: true });
        const text =
          typeof result.data.text === "string" ? result.data.text : "";
        lines = textToLines(text);
        if (typeof result.data.confidence === "number") {
          conf = Math.round(result.data.confidence);
          confSum += result.data.confidence;
          confCount += 1;
        }
      }

      const body =
        format === "md"
          ? blocksToMarkdown(buildBlocks(lines, `p${i}-`, i))
          : layout === "lines"
            ? linesToVerbatim(lines)
            : linesToFlowText(lines);
      pageTexts.push(body);
      totalChars += countChars(body);
      totalPages += 1;

      post({
        type: "progress",
        runId,
        pct: Math.round(
          8 + ((fileIndex + (i + 1) / pageCount) / files.length) * 86
        ),
        stage: "processing",
        detail: { page: i + 1, pages: pageCount, conf },
      });
    }
    doc.cleanup();

    const useMarks = markPages && pageTexts.length > 1;
    const body = pageTexts
      .map((text, i) =>
        useMarks
          ? `${i === 0 ? "" : "\n\n"}───── Page ${pageNumbers[i] + 1} ─────\n${text}`
          : text
      )
      .join(useMarks ? "" : "\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+$/gm, "")
      .trim();

    if (format === "md") {
      outputs.push({
        name: `${base}.md`,
        mime: "text/markdown;charset=utf-8",
        blob: new Blob([body + "\n"], { type: "text/markdown;charset=utf-8" }),
      });
    } else {
      outputs.push({
        name: `${base}.txt`,
        mime: "text/plain;charset=utf-8",
        blob: new Blob([body + "\n"], { type: "text/plain;charset=utf-8" }),
      });
    }
  }

  // Nothing anywhere — honest failure instead of an empty file.
  if (totalChars === 0) {
    post({ type: "error", runId, code: "tool.errorNoText" });
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
