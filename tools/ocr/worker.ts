import {
  CreateContext,
  PdfError,
  StampContext,
} from "@/lib/own/pdf";

import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  pageCharCount,
  pageText,
  type RawTextItem,
} from "../pdf-to-txt/text-layout";
import { isHeifBytes } from "../imgconv/libheif";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import {
  createOcrEngine,
  isOcrLang,
  recognizeBytes,
  type OcrLang,
  type OcrLine,
  type TesseractWorkerLike,
} from "./tesseract";
import {
  createTextLayerFonts,
  drawSearchableLayer,
  imageBoxLinePlacement,
  pdfPageLinePlacement,
  type LinePlacement,
} from "./text-layer";

/**
 * OCR worker (PRD §8 "PDF OCR" + "Copy from PDF", §2.3 Tesseract.js) — one
 * worker serves BOTH toolIds:
 *
 *  - ocr-pdf: scanned PDFs (or photos) → searchable PDF (invisible text
 *    layer over the untouched pixels) or plain text. Pages render at the
 *    chosen DPI with pdf.js, Tesseract (eng/hi/eng+hi, tessdata_fast,
 *    self-hosted from /tessdata) recognizes them, and the OWN ENGINE
 *    appends one invisible drawText per line — positioned through the
 *    /Rotate-aware display→user mapping proven by the crop tool.
 *  - copy-from-pdf: every page's selectable text, with per-page OCR
 *    fallback for scans (auto mode OCRs ONLY empty pages — the PRD's
 *    "Scan pages par OCR on-demand").
 *
 * Everything stays on-device: the only network fetches are our own
 * /vendor/tesseract wasm, /tessdata models (IndexedDB-cached after first
 * use) and the Devanagari font for non-Latin text layers.
 */

type PdfjsDoc = Awaited<
  ReturnType<Awaited<ReturnType<typeof loadPdfjsInWorker>>["getDocument"]>["promise"]
>;

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function sanitizeBase(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .slice(0, 120) || "document"
  );
}

/** Page spec or an honest error — direct throw keeps the narrowing sane. */
function mustPageNumbers(spec: number[] | null, fileName: string): number[] {
  if (spec === null || spec.length === 0) {
    throw new Error(`tool.errorInvalidPages\u0000${fileName}`);
  }
  return spec;
}

/** Opens one PDF with the own parser (encryption → honest error codes). */
function loadSrcDoc(
  bytes: Uint8Array,
  fileName: string
): StampContext {
  try {
    return StampContext.load(bytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error(`tool.errorEncrypted\u0000${fileName}`);
    }
    throw new Error(`tool.errorCorrupt\u0000${fileName}`);
  }
}

/** Opens one PDF with pdf.js, mapping encryption → honest error codes. */
async function openPdf(
  pdfjs: Awaited<ReturnType<typeof loadPdfjsInWorker>>,
  bytes: Uint8Array,
  fileName: string
): Promise<PdfjsDoc> {
  try {
    return await pdfjs.getDocument({
      data: bytes,
      // Worker-safe canvas factory + font source (see worker-lib header:
      // the tofu fix — real FontFaceSet, or glyph-path rendering).
      ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
    }).promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password/i.test(message)) {
      throw new Error(`tool.errorEncrypted\u0000${fileName}`);
    }
    throw new Error(`tool.errorCorrupt\u0000${fileName}`);
  }
}

/** Renders one page of an OPEN pdf.js doc to JPEG bytes (white-backed). */
async function renderPage(
  doc: PdfjsDoc,
  pageIndex: number,
  scale: number
): Promise<{
  bytes: Uint8Array;
  width: number;
  height: number;
  rotation: number;
  view: number[];
}> {
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.round(viewport.width));
  const height = Math.max(1, Math.round(viewport.height));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("tool.ocr.errorEngine");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  await page.render({
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;
  const rotation = Number(page.rotate) || 0;
  const view = Array.isArray(page.view) ? (page.view as number[]) : [0, 0, width, height];
  page.cleanup();
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    width,
    height,
    rotation,
    view,
  };
}

/* ------------------------------------------------------------------ */
/* Image decoding (photos as OCR input)                                */
/* ------------------------------------------------------------------ */

type ImageKind = "jpeg" | "png" | "webp" | "heic" | "unknown";

function sniffImageKind(head: Uint8Array): ImageKind {
  const has = (bytes: number[], offset = 0) =>
    bytes.every((byte, i) => head[offset + i] === byte);
  if (has([0xff, 0xd8, 0xff])) return "jpeg";
  if (has([0x89, 0x50, 0x4e, 0x47])) return "png";
  if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8)) {
    return "webp";
  }
  if (isHeifBytes(head)) return "heic";
  return "unknown";
}

/** Decoded, ready-to-embed page image (original/re-encoded bytes + dims). */
interface PreparedImage {
  kind: "jpeg" | "png";
  bytes: Uint8Array;
  width: number;
  height: number;
}

async function prepareImage(
  file: File,
  onFail: (code: string, detail: string) => never
): Promise<PreparedImage> {
  const raw = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImageKind(raw.slice(0, 16));

  // Fast path: JPEG/PNG embed (and OCR) the original bytes untouched.
  if (kind === "jpeg" || kind === "png") {
    const bitmap = await createImageBitmap(
      new Blob([raw as unknown as BlobPart], { type: `image/${kind}` })
    );
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();
    return { kind, bytes: raw, width, height };
  }

  if (kind === "unknown") {
    onFail("tool.ocr.errorImage", file.name);
  }

  // HEIC (Chrome cannot decode) → libheif WASM; WEBP → bitmap decode.
  // Scans never need alpha — both re-encode as JPEG over white.
  let width: number;
  let height: number;
  let source: ImageBitmap | ImageData;
  if (kind === "heic") {
    let decoded: Awaited<ReturnType<typeof import("../imgconv/libheif").decodeHeifRgba>>;
    try {
      const { decodeHeifRgba } = await import("../imgconv/libheif");
      decoded = await decodeHeifRgba(raw);
    } catch (error) {
      const marker = error instanceof Error ? error.message : String(error);
      const code = marker.split("\0")[1];
      onFail(
        code?.startsWith("tool.") ? code : "tool.ocr.errorImage",
        file.name
      );
    }
    width = decoded.width;
    height = decoded.height;
    source = new ImageData(decoded.data, width, height);
  } else {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      onFail("tool.ocr.errorImage", file.name);
    }
    width = bitmap.width;
    height = bitmap.height;
    source = bitmap;
  }

  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) onFail("tool.ocr.errorImage", file.name);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    if (source instanceof ImageData) {
      context.putImageData(source, 0, 0);
    } else {
      context.drawImage(source, 0, 0);
    }
    const blob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.92,
    });
    return {
      kind: "jpeg",
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width,
      height,
    };
  } finally {
    if (source instanceof ImageBitmap) source.close();
  }
}

/* ------------------------------------------------------------------ */
/* OCR session (model-load progress + reuse within one run)            */
/* ------------------------------------------------------------------ */

class OcrSession {
  private worker: TesseractWorkerLike | null = null;
  private started = false;

  constructor(
    private readonly runId: number,
    private readonly lang: OcrLang,
    private readonly totalPages: number,
    private readonly from: number,
    private readonly to: number
  ) {}

  async get(): Promise<TesseractWorkerLike> {
    if (!this.started) {
      this.started = true;
      const worker = await createOcrEngine(this.lang, (status, value) => {
        // Model loading is real progress — the first OCR run downloads
        // up to ~5 MB of traineddata (IndexedDB-cached afterwards).
        if (
          status.includes("traineddata") ||
          status.includes("tesseract core") ||
          status.includes("initializing")
        ) {
          post({
            type: "progress",
            runId: this.runId,
            pct: Math.round(
              this.from +
                Math.min(0.45, Math.max(0, value) * 0.45) * (this.to - this.from)
            ),
            stage: "reading",
          });
        }
      });
      this.worker = worker;
    }
    if (!this.worker) throw new Error("tool.ocr.errorEngine");
    return this.worker;
  }

  /** Per-page progress tick (call AFTER each page finishes). */
  pageDone(pagesFinished: number): void {
    const share = this.totalPages > 0 ? pagesFinished / this.totalPages : 1;
    post({
      type: "progress",
      runId: this.runId,
      pct: Math.round(this.from + share * (this.to - this.from)),
      stage: "processing",
      detail: {
        page: Math.min(pagesFinished + 1, this.totalPages),
        pages: this.totalPages,
      },
    });
  }

  async done(): Promise<void> {
    if (this.worker) {
      const worker = this.worker;
      this.worker = null;
      await worker.terminate().catch(() => undefined);
    }
  }
}

/* ------------------------------------------------------------------ */
/* ocr-pdf                                                             */
/* ------------------------------------------------------------------ */

async function runOcrPdf(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;

  const lang = isOcrLang(options.lang) ? options.lang : "eng";
  const dpi = Number(options.dpi) >= 300 ? 300 : 150;
  const scale = dpi / 72;
  const asText = String(options.output ?? "pdf") === "txt";
  const pageMarks = options.pageMarks !== false;
  const fail = (code: string, detail: string): never => {
    throw new Error(`${code}\u0000${detail}`);
  };

  const pdfjs = await loadPdfjsInWorker();

  /** One page of work — either a PDF page or a prepared photo. */
  interface PageWork {
    fileIndex: number;
    pageNumber: number; // 1-based label
    doc?: PdfjsDoc;
    pageIndex?: number; // 0-based
    image?: PreparedImage;
    /** Filled by the OCR pass: */
    lines?: OcrLine[];
    text?: string;
    renderWidth?: number;
    renderHeight?: number;
    rotation?: number;
    view?: number[];
  }

  const work: PageWork[] = [];
  const pdfInputs: { fileIndex: number; doc: PdfjsDoc; bytes: Uint8Array }[] = [];
  const imageInputs: { fileIndex: number; image: PreparedImage }[] = [];
  const openedDocs: PdfjsDoc[] = [];

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    const isPdf =
      head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
    if (isPdf) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // pdf.js takes OWNERSHIP of the buffer it is handed (it transfers
      // the ArrayBuffer to its worker and detaches it) — every consumer
      // that needs the bytes afterwards (own-engine page surgery) must
      // get an independent copy made BEFORE getDocument runs.
      const libBytes = bytes.slice();
      const doc = await openPdf(pdfjs, bytes, file.name);
      openedDocs.push(doc);
      pdfInputs.push({ fileIndex, doc, bytes: libBytes });
      const pageNumbers = mustPageNumbers(
        parsePageSpec(String(options.pages ?? "all"), doc.numPages),
        file.name
      );
      for (const pageIndex of pageNumbers) {
        work.push({ fileIndex, pageNumber: pageIndex + 1, doc, pageIndex });
      }
    } else {
      const image = await prepareImage(file, fail);
      imageInputs.push({ fileIndex, image });
      work.push({ fileIndex, pageNumber: 0, image });
    }
  }

  const session = new OcrSession(runId, lang, work.length, 2, 90);
  try {
    const engine = await session.get();
    for (let i = 0; i < work.length; i += 1) {
      const item = work[i];
      let bytes: Uint8Array;
      if (item.doc && item.pageIndex !== undefined) {
        const rendered = await renderPage(item.doc, item.pageIndex, scale);
        bytes = rendered.bytes;
        item.renderWidth = rendered.width;
        item.renderHeight = rendered.height;
        item.rotation = rendered.rotation;
        item.view = rendered.view;
      } else if (item.image) {
        bytes = item.image.bytes;
      } else {
        continue;
      }
      const result = await recognizeBytes(engine, bytes, {
        user_defined_dpi: String(dpi),
      });
      item.lines = result.lines;
      item.text = result.text;
      session.pageDone(i + 1);
    }
  } finally {
    await session.done().catch(() => undefined);
    for (const doc of openedDocs) doc.cleanup();
  }

  /* ---------------- assemble outputs ---------------- */

  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let totalPages = 0;

  if (asText) {
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const pages = work.filter((item) => item.fileIndex === fileIndex);
      if (pages.length === 0) continue;
      const markPages = pageMarks && pages.length > 1;
      const body = pages
        .map((item, i) => {
          const text = (item.text ?? "").replace(/\n{3,}/g, "\n\n").trim();
          return markPages
            ? `${i === 0 ? "" : "\n\n"}───── Page ${item.pageNumber || i + 1} ─────\n${text}`
            : text;
        })
        .join(markPages ? "" : "\n\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]+$/gm, "")
        .trim();
      totalPages += pages.length;
      outputs.push({
        name: `${sanitizeBase(files[fileIndex].name)}.txt`,
        mime: "text/plain;charset=utf-8",
        blob: new Blob([body + "\n"], { type: "text/plain;charset=utf-8" }),
      });
    }
  } else if (imageInputs.length > 0) {
    // Photos merge into ONE searchable PDF (a scan batch).
    const pdf = CreateContext.create();
    const fonts = createTextLayerFonts(pdf);
    for (const item of work) {
      if (!item.image) continue;
      const image = item.image;
      const embedded =
        image.kind === "jpeg"
          ? pdf.embedJpeg(image.bytes)
          : pdf.embedPng(image.bytes);
      const page = pdf.addPage(image.width, image.height);
      page.drawImage(embedded, {
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
      });
      const placements: LinePlacement[] = (item.lines ?? []).map((line) =>
        imageBoxLinePlacement(
          line,
          { x: 0, y: 0, w: image.width, h: image.height },
          image.width,
          image.height
        )
      );
      for (const placement of placements) {
        await fonts.ensureDeva(placement.text);
      }
      drawSearchableLayer(page, placements, fonts);
      totalPages += 1;
    }
    post({ type: "progress", runId, pct: 95, stage: "saving" });
    const saved = pdf.write();
    outputs.push({
      name: `${sanitizeBase(files[imageInputs[0].fileIndex].name)}-ocr.pdf`,
      mime: "application/pdf",
      blob: new Blob([saved as unknown as BlobPart], { type: "application/pdf" }),
    });
  }

  if (!asText && pdfInputs.length > 0) {
    // Each PDF gets its own output: a copy with the invisible layer.
    // Own engine: the page SUBSET is a slot plan (edit-pdf precedent —
    // distinct output page dicts, shared graphs ride once) and the layer
    // paints through ctx.stampText on each SLOT index.
    for (const input of pdfInputs) {
      const pages = work.filter((item) => item.fileIndex === input.fileIndex);
      if (pages.length === 0) continue;
      const ctx = loadSrcDoc(input.bytes, files[input.fileIndex].name);
      ctx.setSlotPlan(pages.map((item) => ({ src: item.pageIndex ?? 0 })));
      const fonts = createTextLayerFonts(ctx);
      for (let i = 0; i < pages.length; i += 1) {
        const item = pages[i];
        const slot = i;
        const media = ctx.pages[item.pageIndex ?? 0].mediaBox;
        const view =
          item.view ?? [0, 0, media[2] - media[0], media[3] - media[1]];
        const placements: LinePlacement[] = (item.lines ?? []).map((line) =>
          pdfPageLinePlacement(
            line,
            {
              rotation: item.rotation ?? 0,
              x: view[0],
              y: view[1],
              width: view[2] - view[0],
              height: view[3] - view[1],
            },
            item.renderWidth ?? 1,
            item.renderHeight ?? 1,
            scale
          )
        );
        for (const placement of placements) {
          await fonts.ensureDeva(placement.text);
        }
        drawSearchableLayer(
          { drawText: (opts) => ctx.stampText(slot, opts) },
          placements,
          fonts
        );
        totalPages += 1;
      }
      const saved = ctx.write();
      outputs.push({
        name: `${sanitizeBase(files[input.fileIndex].name)}-ocr.pdf`,
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      });
    }
    post({ type: "progress", runId, pct: 95, stage: "saving" });
  }

  if (outputs.length === 0) {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: totalPages },
  });
}

/* ------------------------------------------------------------------ */
/* copy-from-pdf                                                       */
/* ------------------------------------------------------------------ */

async function runCopyFromPdf(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;

  const layout = options.layout === "lines" ? "lines" : "flow";
  const pageMarks = options.pageMarks === true;
  const ocrMode =
    options.ocrMode === "always" || options.ocrMode === "off"
      ? (options.ocrMode as "always" | "off")
      : "auto";
  const lang = isOcrLang(options.lang) ? options.lang : "eng";
  const dpi = 200;
  const scale = dpi / 72;
  const fail = (code: string, detail: string): never => {
    throw new Error(`${code}\u0000${detail}`);
  };

  const pdfjs = await loadPdfjsInWorker();

  interface CopyPage {
    pageNumber: number; // 1-based label
    doc: PdfjsDoc;
    pageIndex: number; // 0-based
    text: string; // embedded text ("" for scans)
    ocrText?: string;
  }

  const perFile: { fileIndex: number; pages: CopyPage[] }[] = [];
  const openedDocs: PdfjsDoc[] = [];

  // Pass 1 — extract embedded text per page (handles stay open).
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await openPdf(pdfjs, bytes, file.name);
    openedDocs.push(doc);
    const pageNumbers = mustPageNumbers(
      parsePageSpec(String(options.pages ?? "all"), doc.numPages),
      file.name
    );
    const pages: CopyPage[] = [];
    for (const pageIndex of pageNumbers) {
      const page = await doc.getPage(pageIndex + 1);
      const content = await page.getTextContent();
      page.cleanup();
      const hasText = pageCharCount(content.items as RawTextItem[]) > 0;
      pages.push({
        pageNumber: pageIndex + 1,
        doc,
        pageIndex,
        text: hasText
          ? pageText(content.items as RawTextItem[], layout)
          : "",
      });
    }
    perFile.push({ fileIndex, pages });
  }

  // Pass 2 — OCR only where needed (auto = scans only; the engine never
  // loads a byte of models on fully-text PDFs).
  const needOcr =
    ocrMode === "always"
      ? perFile.flatMap((entry) => entry.pages)
      : ocrMode === "auto"
        ? perFile.flatMap((entry) => entry.pages.filter((page) => page.text.length === 0))
        : [];

  if (needOcr.length > 0) {
    const session = new OcrSession(runId, lang, needOcr.length, 3, 90);
    try {
      const engine = await session.get();
      let done = 0;
      for (const item of needOcr) {
        const rendered = await renderPage(item.doc, item.pageIndex, scale);
        const result = await recognizeBytes(engine, rendered.bytes, {
          user_defined_dpi: String(dpi),
        });
        item.ocrText = result.text.replace(/\n{3,}/g, "\n\n").trim();
        done += 1;
        session.pageDone(done);
      }
      await session.done();
    } finally {
      await session.done().catch(() => undefined);
    }
  }

  for (const doc of openedDocs) doc.cleanup();

  // Pass 3 — assemble per-file text outputs.
  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let totalPages = 0;
  let totalChars = 0;
  for (const { fileIndex, pages } of perFile) {
    const chunks: string[] = [];
    for (const item of pages) {
      chunks.push(item.text.length > 0 ? item.text : (item.ocrText ?? ""));
      totalPages += 1;
      totalChars += chunks[chunks.length - 1].replace(/\s/g, "").length;
    }
    if (totalChars === 0) {
      // Nothing selectable anywhere and no OCR text produced.
      post({
        type: "error",
        runId,
        code: "tool.errorNoText",
        detail: files[fileIndex].name,
      });
      return;
    }
    const markPages = pageMarks && pages.length > 1;
    const body = chunks
      .map((text, i) =>
        markPages
          ? `${i === 0 ? "" : "\n\n"}───── Page ${pages[i].pageNumber} ─────\n${text}`
          : text
      )
      .join(markPages ? "" : "\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+$/gm, "")
      .trim();
    outputs.push({
      name: `${sanitizeBase(files[fileIndex].name)}.txt`,
      mime: "text/plain;charset=utf-8",
      blob: new Blob([body + "\n"], { type: "text/plain;charset=utf-8" }),
    });
  }

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: totalPages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  const run = data.toolId === "copy-from-pdf" ? runCopyFromPdf : runOcrPdf;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const [code, detail] = message.split("\u0000");
    post({
      type: "error",
      runId: data.runId,
      code: code?.startsWith("tool.") ? code : "tool.errorCorrupt",
      detail: detail || undefined,
    });
  });
};
