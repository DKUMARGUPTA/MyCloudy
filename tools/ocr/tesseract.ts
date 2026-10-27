/**
 * Shared Tesseract.js OCR engine for Web Workers (PRD §2.3, §8 "PDF OCR").
 *
 * Everything is self-hosted from /public (the hard rule — no CDN, no
 * third-party origin ever sees file data):
 *   /vendor/tesseract/tesseract.esm.min.js  — main library (lazy import)
 *   /vendor/tesseract/worker.min.js        — Tesseract's own classic worker
 *   /vendor/tesseract/tesseract-core-*.wasm.js — LSTM cores (SIMD picked
 *                                                at runtime, wasm inlined)
 *   /tessdata/eng.traineddata, hi.traineddata — tessdata_fast models
 *   (Apache-2.0; hi is the ISO 639-2 `hin` file vendored under its
 *   tesseract.js language code).
 *
 * Running INSIDE our tool worker: Tesseract spawns its own nested worker
 * (`new Worker(workerPath)`, `workerBlobURL: false`) — supported by every
 * current engine (Chromium 69+, Safari 15+, Firefox). Cancelling a run
 * terminates OUR worker, which cascades to the nested one.
 *
 * Traineddata is fetched once per browser via Tesseract's IndexedDB cache
 * (cacheMethod "write") — the PRD's "first use downloads the model, then
 * it is cached for offline" behavior, for free.
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type OcrLang = "eng" | "hi" | "eng+hi";

export const OCR_LANGS: readonly OcrLang[] = ["eng", "hi", "eng+hi"] as const;

export function isOcrLang(value: unknown): value is OcrLang {
  return (
    typeof value === "string" && (OCR_LANGS as readonly string[]).includes(value)
  );
}

/** One recognized line in IMAGE pixel space (y grows downwards). */
export interface OcrLine {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** What a run needs from one recognized page image. */
export interface OcrPageResult {
  text: string;
  lines: OcrLine[];
  confidence: number;
}

/* ------------------------------------------------------------------ */
/* Tesseract JSON → flat lines (pure, Node-testable)                   */
/* ------------------------------------------------------------------ */

interface TessBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface TessLine {
  text: string;
  bbox: TessBbox;
}

interface TessParagraph {
  lines: TessLine[];
}

interface TessBlock {
  paragraphs: TessParagraph[];
}

/**
 * Flattens Tesseract's blocks → paragraphs → lines tree into reading-order
 * lines with pixel bboxes. The tree order IS the reading order Tesseract
 * detected; we only drop empty lines and clamp degenerate boxes.
 */
export function flattenOcrBlocks(blocks: unknown): OcrLine[] {
  if (!Array.isArray(blocks)) return [];
  const out: OcrLine[] = [];
  for (const block of blocks as TessBlock[]) {
    if (!block || !Array.isArray(block.paragraphs)) continue;
    for (const paragraph of block.paragraphs) {
      if (!paragraph || !Array.isArray(paragraph.lines)) continue;
      for (const line of paragraph.lines) {
        if (!line || typeof line.text !== "string") continue;
        const text = line.text.replace(/\s+$/g, "");
        if (text.trim().length === 0) continue;
        const b = line.bbox;
        if (
          !b ||
          !Number.isFinite(b.x0) ||
          !Number.isFinite(b.y0) ||
          !Number.isFinite(b.x1) ||
          !Number.isFinite(b.y1) ||
          b.x1 <= b.x0 ||
          b.y1 <= b.y0
        ) {
          continue;
        }
        out.push({
          text,
          x0: b.x0,
          y0: b.y0,
          x1: b.x1,
          y1: b.y1,
        });
      }
    }
  }
  return out;
}

/** The page-level mean confidence Tesseract reports (0–100). */
export function pageConfidence(page: { confidence?: unknown }): number {
  const value = Number(page.confidence);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/* ------------------------------------------------------------------ */
/* Browser engine loader (vendored, lazy, CSP-clean)                   */
/* ------------------------------------------------------------------ */

const TESSERACT_URL = "/vendor/tesseract/tesseract.esm.min.js";
const WORKER_URL = "/vendor/tesseract/worker.min.js";
const CORE_DIR = "/vendor/tesseract/";
const LANG_DIR = "/tessdata";

/**
 * Absolute URL for a same-origin path, seen from inside the worker.
 * Turbopack's dev server spins workers up on blob: URLs where a plain
 * fetch("/path") has no base to resolve against — the blob URL embeds the
 * real origin, so strip the scheme and resolve against it. (Same recipe as
 * tools/imgconv/libheif.ts.)
 */
function workerAbsoluteUrl(path: string): string {
  const href =
    typeof self !== "undefined" && self.location ? self.location.href : "";
  let base = href;
  if (base.startsWith("blob:")) base = base.slice("blob:".length);
  try {
    return new URL(path, base).href;
  } catch {
    return path;
  }
}

/** The tiny surface of the Tesseract namespace we drive. */
export interface TesseractNamespace {
  createWorker(
    langs: string,
    oem: number,
    options: Record<string, unknown>
  ): Promise<TesseractWorkerLike>;
}

export interface TesseractWorkerLike {
  setParameters(params: Record<string, unknown>): Promise<unknown>;
  recognize(
    image: Uint8Array | Blob,
    options?: Record<string, unknown>,
    output?: Record<string, boolean>
  ): Promise<{ data: TesseractPageData }>;
  terminate(): Promise<unknown>;
}

export interface TesseractPageData {
  text?: string;
  confidence?: number;
  blocks?: unknown;
}

/** Test-only override (Node/Bun smokes inject the node-mode namespace). */
let namespaceOverride: TesseractNamespace | null = null;

export function injectTesseractNamespace(namespace: TesseractNamespace): void {
  namespaceOverride = namespace;
}

let namespacePromise: Promise<TesseractNamespace> | null = null;

function loadTesseractNamespace(): Promise<TesseractNamespace> {
  if (namespaceOverride) return Promise.resolve(namespaceOverride);
  if (!namespacePromise) {
    namespacePromise = (async () => {
      const mod = (await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ workerAbsoluteUrl(
          TESSERACT_URL
        )
      )) as { default: TesseractNamespace };
      if (!mod?.default || typeof mod.default.createWorker !== "function") {
        throw new Error("ocr\0tool.ocr.errorEngine");
      }
      return mod.default;
    })();
    // A failed fetch/compile must not poison the slot forever.
    namespacePromise.catch(() => {
      namespacePromise = null;
    });
  }
  return namespacePromise;
}

/**
 * Spawns a Tesseract worker for `lang` (eng | hi | eng+hi), loads the
 * language models and applies the page-segmentation parameters.
 *
 * `onStatus` receives Tesseract's own progress events during model
 * loading (status strings like "loading language traineddata" with a
 * 0–1 progress) so callers can surface an honest "downloading model"
 * phase before page work starts.
 *
 * Node/Bun (test seam): tesseract.js's node mode spawns a
 * worker_thread from ITS OWN script and reads traineddata from the
 * filesystem — browser paths (worker/core) are omitted and `langPath`
 * can be overridden so smokes run against the VENDORED models.
 */
export async function createOcrEngine(
  lang: OcrLang,
  onStatus?: (status: string, progress: number) => void,
  overrides: { langPath?: string } = {}
): Promise<TesseractWorkerLike> {
  const namespace = await loadTesseractNamespace();
  const logger = (message: { status?: string; progress?: number }) => {
    if (message && typeof message.status === "string") {
      onStatus?.(message.status, Number(message.progress) || 0);
    }
  };
  const nodeLike =
    typeof window === "undefined" &&
    typeof (globalThis as { importScripts?: unknown }).importScripts ===
      "undefined" &&
    typeof process === "object" &&
    process !== null &&
    (process as { versions?: { node?: string } }).versions?.node != null;
  const options: Record<string, unknown> = nodeLike
    ? {
        langPath: overrides.langPath ?? "/tessdata",
        gzip: false,
        logger,
      }
    : {
        workerPath: workerAbsoluteUrl(WORKER_URL),
        corePath: workerAbsoluteUrl(CORE_DIR),
        langPath: workerAbsoluteUrl(LANG_DIR),
        // Traineddata is vendored UNCOMPRESSED — skip the .gz attempt.
        gzip: false,
        // Direct classic worker from our origin (no blob indirection):
        // CSP worker-src 'self' is all we need.
        workerBlobURL: false,
        // Cache the models in Tesseract's own IndexedDB (first-use
        // download, then offline — PRD §8 "Download of models").
        cacheMethod: "write",
        logger,
      };
  const worker = await namespace.createWorker(lang, 1, options);
  await worker.setParameters({
    // Whole-page automatic segmentation (no OSD pass — faster, and
    // deskew is part of the LSTM layout analysis anyway).
    tessedit_pageseg_mode: "3",
    // Keep inter-word spacing realistic for the searchable text layer.
    preserve_interword_spaces: "1",
  });
  return worker;
}

/**
 * Recognizes one image (PNG/JPEG bytes). Bounding boxes come back in the
 * image's pixel space; `text` is Tesseract's own reading of the page.
 */
export async function recognizeBytes(
  worker: TesseractWorkerLike,
  bytes: Uint8Array,
  extraParams?: Record<string, unknown>
): Promise<OcrPageResult> {
  if (extraParams && Object.keys(extraParams).length > 0) {
    await worker.setParameters(extraParams);
  }
  const { data } = await worker.recognize(
    bytes,
    {},
    { text: true, blocks: true }
  );
  return {
    text: typeof data.text === "string" ? data.text : "",
    lines: flattenOcrBlocks(data.blocks),
    confidence: pageConfidence(data),
  };
}
