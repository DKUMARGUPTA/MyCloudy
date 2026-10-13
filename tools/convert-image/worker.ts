import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { decodeHeicToBitmap } from "@/lib/heic/heic-decode";

/**
 * Image → image converter worker (PRD §7.10 Image tools / §8.6) — shared by
 * webp-to-jpg, webp-to-png, heic-to-jpg and heic-to-png.
 *
 * Decoding per source format:
 * - WEBP: native createImageBitmap (every modern browser decodes WEBP)
 * - HEIC/HEIF: self-hosted libheif WASM (src/lib/heic/heic-decode.ts) —
 *   works everywhere, not just Safari
 *
 * Encoding per target:
 * - JPG: canvas re-encode at the chosen quality; transparency flattened
 *   onto the chosen background
 * - PNG: lossless, transparency preserved
 *
 * Optional max-dimension downscale (huge photos → email-friendly sizes).
 * Device-only: files arrive by structured clone, image Blobs go back.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

type InputKind = "webp" | "heic" | "unknown";

/** ftyp brand sniff — accepts the HEIC/HEIF family, not AVIF. */
function sniffInputKind(head: Uint8Array): InputKind {
  const has = (bytes: number[], offset = 0) =>
    bytes.every((byte, i) => head[offset + i] === byte);
  if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8)) {
    return "webp";
  }
  if (has([0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(
      head[8] ?? 0,
      head[9] ?? 0,
      head[10] ?? 0,
      head[11] ?? 0
    );
    if (["heic", "heix", "hevc", "hevm", "hevs", "heim", "heis", "mif1", "msf1"].includes(brand)) {
      return "heic";
    }
  }
  return "unknown";
}

/** Expected source kind per tool — a WEBP dropped on a HEIC tool is honest-refused. */
const TOOL_SOURCE: Record<string, InputKind> = {
  "webp-to-jpg": "webp",
  "webp-to-png": "webp",
  "heic-to-jpg": "heic",
  "heic-to-png": "heic",
};

/** Target format per tool. */
const TOOL_TARGET: Record<string, { mime: string; ext: string; alpha: boolean }> = {
  "webp-to-jpg": { mime: "image/jpeg", ext: "jpg", alpha: false },
  "webp-to-png": { mime: "image/png", ext: "png", alpha: true },
  "heic-to-jpg": { mime: "image/jpeg", ext: "jpg", alpha: false },
  "heic-to-png": { mime: "image/png", ext: "png", alpha: true },
};

const BG_RGB: Record<string, [number, number, number]> = {
  white: [1, 1, 1],
  soft: [0.96, 0.955, 0.94],
  black: [0.05, 0.05, 0.05],
};

function sanitizeBase(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .slice(0, 120) || "image"
  );
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, toolId, options, files } = request;
  const source = TOOL_SOURCE[toolId];
  const target = TOOL_TARGET[toolId];
  if (!source || !target) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const quality = Math.max(
    0.4,
    Math.min(1, Number(options.quality ?? 85) / 100)
  );
  const background =
    BG_RGB[String(options.background ?? "white")] ?? BG_RGB.white;
  const maxDim = Number(options.maxDim ?? 0);

  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  const usedNames = new Set<string>();

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const raw = new Uint8Array(await file.arrayBuffer());
    const kind = sniffInputKind(raw.slice(0, 16));
    if (kind === "unknown" || kind !== source) {
      post({
        type: "error",
        runId,
        code: "tool.errorUnsupported",
        detail: file.name,
      });
      return;
    }

    // Decode → ImageBitmap.
    let bitmap: ImageBitmap;
    if (kind === "heic") {
      try {
        bitmap = await decodeHeicToBitmap(raw);
      } catch {
        post({
          type: "error",
          runId,
          code: "tool.images.errorHeicDecode",
          detail: file.name,
        });
        return;
      }
    } else {
      try {
        bitmap = await createImageBitmap(
          new Blob([raw as unknown as BlobPart], { type: "image/webp" })
        );
      } catch {
        post({
          type: "error",
          runId,
          code: "tool.images.errorDecode",
          detail: file.name,
        });
        return;
      }
    }

    try {
      // Optional downscale (keeps aspect, never upscales).
      let width = bitmap.width;
      let height = bitmap.height;
      if (maxDim > 0 && Math.max(width, height) > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
      }

      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas-2d-unavailable");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      if (target.alpha) {
        context.fillStyle = "rgba(0,0,0,0)";
      } else {
        // JPG has no alpha — flatten transparent pixels onto the background.
        context.fillStyle = `rgb(${Math.round(background[0] * 255)}, ${Math.round(
          background[1] * 255
        )}, ${Math.round(background[2] * 255)})`;
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(bitmap, 0, 0, width, height);

      const blob = await canvas.convertToBlob({
        type: target.mime,
        quality: target.alpha ? undefined : quality,
      });

      // Output name: original base + target ext, deduped across inputs.
      const base = sanitizeBase(file.name);
      let name = `${base}.${target.ext}`;
      if (usedNames.has(name)) {
        let n = 2;
        while (usedNames.has(`${base}-${n}.${target.ext}`)) {
          n += 1;
        }
        name = `${base}-${n}.${target.ext}`;
      }
      usedNames.add(name);
      outputs.push({ name, mime: target.mime, blob });
    } finally {
      bitmap.close();
    }

    post({
      type: "progress",
      runId,
      pct: Math.round(((i + 1) / files.length) * 92),
      stage: "processing",
    });
  }

  if (outputs.length === 0) {
    post({ type: "error", runId, code: "tool.images.errorNoImages" });
    return;
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
    post({
      type: "error",
      runId: data.runId,
      code: /canvas/i.test(message) ? "tool.errorGeneric" : "tool.errorCorrupt",
    });
  });
};
