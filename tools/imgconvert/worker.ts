import type {
  WorkerRunRequest,
  WorkerResponse,
} from "@/lib/workers/protocol";
import {
  clampQualityPercent,
  rgbaToRgb,
  rgbToRgba,
  sanitizeBaseName,
  sniffIsHeic,
  uniqueOutputName,
} from "./engine";
import { decodeToImageData } from "./heif";

/**
 * Image converter worker (PRD §7.10) — shared by webp-to-jpg, webp-to-png,
 * heic-to-jpg and heic-to-png, exactly like pdf-to-jpg + pdf-to-png share
 * tools/pdf-to-images/worker.ts. The output format is fixed by the tool
 * identity (FORMAT map), never an option.
 *
 * Decode strategy per file: try the browser's own decoder FIRST
 * (createImageBitmap with "from-image" — handles webp/jpg/png everywhere
 * and HEIC on Safari, and bakes EXIF/irot orientation into the pixels).
 * Only when that fails do we read the bytes: HEIC magic → self-hosted
 * libheif wasm; anything else → honest "not a readable image" error.
 *
 * Device-only: files arrive by structured clone and image Blobs go back —
 * no network request ever carries file data. Files run sequentially with
 * one canvas alive at a time, so 20 iPhone photos won't spike memory.
 */

/** Output format per tool — fixed by the tool identity, not an option. */
const FORMAT: Record<
  string,
  { mime: "image/jpeg" | "image/png"; ext: "jpg" | "png"; alpha: boolean }
> = {
  "webp-to-jpg": { mime: "image/jpeg", ext: "jpg", alpha: false },
  "heic-to-jpg": { mime: "image/jpeg", ext: "jpg", alpha: false },
  "webp-to-png": { mime: "image/png", ext: "png", alpha: true },
  "heic-to-png": { mime: "image/png", ext: "png", alpha: true },
};

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** One decoded input, still uncompressed. */
type DecodedImage =
  | { kind: "bitmap"; bitmap: ImageBitmap }
  | {
      kind: "rgba";
      width: number;
      height: number;
      data: Uint8ClampedArray<ArrayBuffer>;
    };

async function decodeImage(file: File): Promise<DecodedImage> {
  // Fast path: the browser's own decoder (orientation baked in).
  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    if (bitmap.width > 0 && bitmap.height > 0) {
      return { kind: "bitmap", bitmap };
    }
    bitmap.close();
  } catch {
    // fall through to the wasm HEIC path
  }

  const buffer = await file.arrayBuffer();
  const head = new Uint8Array(
    buffer,
    0,
    Math.min(12, buffer.byteLength)
  );
  if (!sniffIsHeic(head)) throw new Error("imgconv:corrupt");
  const decoded = await decodeToImageData(buffer);
  return {
    kind: "rgba",
    width: decoded.width,
    height: decoded.height,
    data: decoded.data,
  };
}

async function encodeImage(
  decoded: DecodedImage,
  format: { mime: "image/jpeg" | "image/png"; alpha: boolean },
  quality: number
): Promise<Blob> {
  let width: number;
  let height: number;
  if (decoded.kind === "bitmap") {
    width = decoded.bitmap.width;
    height = decoded.bitmap.height;
  } else {
    width = decoded.width;
    height = decoded.height;
  }
  if (width <= 0 || height <= 0) throw new Error("imgconv:corrupt");

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("imgconv:canvas");

  if (decoded.kind === "bitmap") {
    // JPG has no alpha — flatten onto white before drawing.
    if (!format.alpha) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(decoded.bitmap, 0, 0);
    decoded.bitmap.close();
  } else {
    let data = decoded.data;
    if (!format.alpha) {
      // JPG has no alpha: composite over white in pure data (the smoke-test
      // pinned src-over math) — round-tripping rgbaToRgb → rgbToRgba keeps
      // the canvas fully opaque for the encoder, no temp canvas needed.
      data = rgbToRgba(rgbaToRgb(data, width, height), width, height);
    }
    context.putImageData(new ImageData(data, width, height), 0, 0);
  }

  return canvas.convertToBlob({
    type: format.mime,
    quality: format.alpha ? undefined : quality,
  });
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, toolId, options, files } = request;
  const format = FORMAT[toolId];
  if (!format) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const quality = clampQualityPercent(options.quality) / 100;

  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  const taken = new Set<string>();

  for (let i = 0; i < files.length; i += 1) {
    const decoded = await decodeImage(files[i]);
    const blob = await encodeImage(decoded, format, quality);
    const base = sanitizeBaseName(files[i].name);
    outputs.push({
      name: uniqueOutputName(base, format.ext, taken),
      mime: format.mime,
      blob,
    });

    post({
      type: "progress",
      runId,
      pct: Math.round(((i + 1) / files.length) * 95),
      stage: "processing",
      detail: { page: i + 1, pages: files.length },
    });
  }

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: outputs.length },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      message === "imgconv:heic"
        ? "imgconv.errHeic"
        : message === "imgconv:corrupt"
          ? "imgconv.errCorrupt"
          : /canvas/i.test(message)
            ? "tool.errorGeneric"
            : "tool.errorGeneric";
    post({ type: "error", runId: data.runId, code });
  });
};
