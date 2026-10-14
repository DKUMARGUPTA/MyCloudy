/**
 * Shared Tesseract.js client for the OCR tool (worker AND surface).
 *
 * tesseract.js@5.1.1 is loaded from a SELF-HOSTED UMD build
 * (/tesseract/tesseract.min.js, runtime import — the pdf.js/libheif
 * recipe) so no bundler resolution or third-party CDN is involved.
 * Every asset it touches lives on this origin (PRD §2.2/§2.3):
 *
 *   /tesseract/tesseract.min.js              controller (this file's import)
 *   /tesseract/worker.min.js                  OCR worker script
 *   /tesseract/tesseract-core-*-lstm.wasm.js wasm engine (LSTM only)
 *   /tessdata/{eng,hin}.traineddata          language models (IndexedDB-cached)
 *
 * `assetOriginUrl` matters in development: Turbopack serves workers from
 * `blob:` URLs where a relative "/path" cannot resolve — the origin is
 * recovered from the blob URL itself (stamp-common recipe).
 */

export interface TessRecognizeResult {
  data: unknown;
}

export interface TessWorkerApi {
  recognize(
    image: Blob,
    options?: Record<string, unknown>,
    output?: Record<string, boolean>
  ): Promise<TessRecognizeResult>;
  terminate(): Promise<unknown>;
}

export interface TessApi {
  createWorker(
    langs: string,
    oem: number,
    options: Record<string, unknown>
  ): Promise<TessWorkerApi>;
}

export type TessStatusMessage = {
  status: string;
  progress: number;
};

/**
 * Absolute URL for a same-origin public asset:
 * - http(s) workers resolve directly against self.location
 * - blob: workers (Turbopack dev) recover the origin from the blob URL
 */
export function assetOriginUrl(path: string): string {
  try {
    const viaLocation = new URL(path, self.location.href);
    if (
      viaLocation.protocol === "http:" ||
      viaLocation.protocol === "https:"
    ) {
      return viaLocation.href;
    }
  } catch {
    // opaque base (blob: workers) — fall through to the blob-origin recovery
  }
  const blobOrigin = /^blob:(https?:\/\/[^/]+)/i.exec(self.location.href);
  if (blobOrigin) return `${blobOrigin[1]}${path}`;
  return path;
}

let tessApiPromise: Promise<TessApi> | null = null;

/** Loads the self-hosted UMD build; it attaches `Tesseract` to `self`. */
export function loadTesseractApi(): Promise<TessApi> {
  if (!tessApiPromise) {
    tessApiPromise = (async () => {
      const libUrl = assetOriginUrl("/tesseract/tesseract.min.js");
      await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ libUrl
      );
      const api = (globalThis as { Tesseract?: TessApi }).Tesseract;
      if (!api) throw new Error("ocr-tesseract-lib-missing");
      return api;
    })();
    tessApiPromise.catch(() => {
      tessApiPromise = null; // retry on the next call
    });
  }
  return tessApiPromise;
}

/**
 * One OCR worker for a language set. OEM 1 = LSTM only (our models are
 * tessdata_fast LSTM builds); `gzip: false` because we host the plain
 * .traineddata files; `cacheMethod: "write"` caches them in IndexedDB
 * after the first download (PRD §8.4 "cached for offline").
 */
export async function createOcrWorker(
  langs: string,
  onStatus: (message: TessStatusMessage) => void
): Promise<TessWorkerApi> {
  const api = await loadTesseractApi();
  return api.createWorker(langs, 1, {
    workerPath: assetOriginUrl("/tesseract/worker.min.js"),
    corePath: assetOriginUrl("/tesseract/"),
    langPath: assetOriginUrl("/tessdata/"),
    cacheMethod: "write",
    cachePath: ".",
    gzip: false,
    workerBlobURL: false,
    legacyCore: false,
    legacyLang: false,
    logger: (message: { status?: unknown; progress?: unknown }) => {
      onStatus({
        status:
          typeof message.status === "string" ? message.status : "working",
        progress:
          typeof message.progress === "number" && message.progress > 0
            ? message.progress
            : 0,
      });
    },
  });
}
