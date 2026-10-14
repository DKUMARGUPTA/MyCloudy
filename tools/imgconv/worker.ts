import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { decodeHeifRgba, isHeifBytes, isWebpBytes } from "./libheif";
import { allocateOutputName, sanitizeBase } from "./naming";

/**
 * Image format converter worker (PRD §7.10) — shared by heic-to-jpg,
 * heic-to-png, webp-to-jpg and webp-to-png.
 *
 * Decode:
 *   - HEIC/HEIF: libheif WASM (vendored, lazily fetched, see ./libheif)
 *     — the ONLY real decoder path; browsers other than Safari cannot
 *     read HEIC natively.
 *   - WEBP: the browser's own decoder via createImageBitmap (universal
 *     since 2020) with EXIF orientation applied by default
 *     (imageOrientation: "from-image").
 * Encode: OffscreenCanvas.convertToBlob — JPEG honours the quality
 * slider and composites transparency over white; PNG keeps alpha
 * unless the user flattens it.
 *
 * Device-only: files arrive by structured clone, Blobs go back.
 * One image at a time → flat memory even for 50-file batches.
 */

interface ToolSpec {
  from: "heic" | "webp";
  mime: string;
  ext: string;
  alpha: boolean;
}

const SPECS: Record<string, ToolSpec> = {
  "heic-to-jpg": { from: "heic", mime: "image/jpeg", ext: "jpg", alpha: false },
  "heic-to-png": { from: "heic", mime: "image/png", ext: "png", alpha: true },
  "webp-to-jpg": { from: "webp", mime: "image/jpeg", ext: "jpg", alpha: false },
  "webp-to-png": { from: "webp", mime: "image/png", ext: "png", alpha: true },
};

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function fail(code: string, detail?: string): never {
  throw new Error(`imgconv\0${code}${detail ? `\0${detail}` : ""}`);
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, toolId, options, files } = request;
  const spec = SPECS[toolId] ?? SPECS["heic-to-jpg"];

  const quality = Math.max(
    0.4,
    Math.min(1, Number(options.quality ?? 90) / 100)
  );
  // PNG targets: optional flatten (transparent → white) for shops and
  // forms that reject alpha PNGs.
  const flatten = options.flatten === true;

  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  const usedNames = new Map<string, number>();

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const raw = new Uint8Array(await file.arrayBuffer());
    const head = raw.slice(0, 16);

    // Honest input validation by MAGIC BYTES, never by extension.
    if (spec.from === "heic" && !isHeifBytes(head)) {
      fail("tool.imgconv.errorNotHeif", file.name);
    }
    if (spec.from === "webp" && !isWebpBytes(head)) {
      fail("tool.imgconv.errorNotWebp", file.name);
    }

    let width: number;
    let height: number;
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext("2d");
    if (!context) fail("tool.imgconv.errorGeneric", file.name);

    if (spec.from === "heic") {
      // libheif → RGBA (post-rotation channel dims are the truth).
      const image = await decodeHeifRgba(raw);
      width = image.width;
      height = image.height;
      canvas.width = width;
      canvas.height = height;
      const needsFlatten = !spec.alpha || flatten;
      if (needsFlatten) {
        // JPEG has no alpha; a flattened PNG loses it on purpose.
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        const bitmap = await createImageBitmap(
          new ImageData(image.data, width, height)
        );
        try {
          context.drawImage(bitmap, 0, 0);
        } finally {
          bitmap.close();
        }
      } else {
        context.putImageData(new ImageData(image.data, width, height), 0, 0);
      }
    } else {
      // WEBP → native decode (first frame for animations).
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(
          new Blob([raw as unknown as BlobPart], { type: "image/webp" })
        );
      } catch {
        fail("tool.imgconv.errorDecode", file.name);
      }
      width = bitmap.width;
      height = bitmap.height;
      canvas.width = width;
      canvas.height = height;
      const needsFlatten = !spec.alpha || flatten;
      if (needsFlatten) {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
      }
      try {
        context.drawImage(bitmap, 0, 0);
      } finally {
        bitmap.close();
      }
    }

    const blob = await canvas.convertToBlob({
      type: spec.mime,
      quality: spec.alpha ? undefined : quality,
    });

    // Stable output name: base.ext, base-2.ext on a collision.
    const base = sanitizeBase(file.name);
    outputs.push({
      name: allocateOutputName(base, spec.ext, usedNames),
      mime: spec.mime,
      blob,
    });

    post({
      type: "progress",
      runId,
      pct: Math.round(((index + 1) / files.length) * 92),
      stage: "processing",
      detail: { page: index + 1, pages: files.length },
    });
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
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
    const [marker, code, detail] = message.split("\0");
    post({
      type: "error",
      runId: data.runId,
      code:
        marker === "imgconv" && code?.startsWith("tool.")
          ? code
          : "tool.errorCorrupt",
      detail: detail || undefined,
    });
  });
};
