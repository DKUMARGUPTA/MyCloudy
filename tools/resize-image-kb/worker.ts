import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { decodeHeicToBitmap } from "@/lib/heic/heic-decode";
import {
  capDimensions,
  dimLadder,
  resolveTargetBytes,
  searchQuality,
} from "./engine";

/**
 * Resize image to KB — device-only worker (PRD §7.10: "Photo + signature
 * under 100/200 KB for exam and government forms").
 *
 * Decoding per source format:
 * - JPG/PNG/WEBP/GIF/BMP: native createImageBitmap (EXIF orientation
 *   applied via imageOrientation: "from-image")
 * - HEIC/HEIF: self-hosted libheif WASM (same recipe as convert-image)
 *
 * Encoding:
 * - JPEG (default): quality binary search (largest q that fits), and when
 *   even q0.30 is too big, the image shrinks ×0.8 steps down to a 120px
 *   long-side floor — size is preserved as long as possible because form
 *   portals check pixels first, beauty second.
 * - PNG: dimension ladder only (PNG has no quality knob); alpha kept.
 *
 * Every canvas readback goes through the canvas-commit guard (P3.19 race:
 * an accelerated OffscreenCanvas can snapshot BLANK before raster ops
 * commit — a blank JPEG is tiny and would silently "win" the budget check,
 * which is exactly the wrong file to hand a user). Convert → decode-yield
 * → convert again, size-stable = committed.
 *
 * Files already under budget in the requested format come back untouched
 * (passthrough). If the floor can't reach the budget, the smallest attempt
 * ships with targetHit: false — an honest amber chip, never a lie.
 *
 * Device-only: files arrive by structured clone, image Blobs go back.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

type InputKind = "jpeg" | "png" | "webp" | "gif" | "bmp" | "heic";

/** Magic-byte sniff — the DropZone pre-checks, the worker re-verifies. */
function sniffInputKind(head: Uint8Array, mime: string): InputKind | null {
  const has = (bytes: number[], offset = 0) =>
    bytes.every((byte, i) => head[offset + i] === byte);
  if (has([0xff, 0xd8, 0xff])) return "jpeg";
  if (has([0x89, 0x50, 0x4e, 0x47])) return "png";
  if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8)) {
    return "webp";
  }
  if (has([0x47, 0x49, 0x46, 0x38])) return "gif";
  if (has([0x42, 0x4d])) return "bmp";
  if (has([0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(
      head[8] ?? 0,
      head[9] ?? 0,
      head[10] ?? 0,
      head[11] ?? 0
    );
    if (
      ["heic", "heix", "hevc", "hevm", "hevs", "heim", "heis", "mif1", "msf1"].includes(brand)
    ) {
      return "heic";
    }
  }
  // Extension-less drops can still carry a usable MIME hint.
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpeg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  if (mime === "image/bmp" || mime === "image/x-ms-bmp") return "bmp";
  return null;
}

function sanitizeBase(name: string): string {
  const base = name.replace(/\.[^.]+$/, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "image";
}

/** Canvas-commit guard, JPEG variant (ocr-pdf P3.19 recipe). */
async function committedJpeg(
  canvas: OffscreenCanvas,
  quality: number
): Promise<Blob> {
  let last = await canvas.convertToBlob({ type: "image/jpeg", quality });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const probe = await createImageBitmap(last);
    probe.close(); // decode yield — lets pending raster ops commit
    const next = await canvas.convertToBlob({ type: "image/jpeg", quality });
    if (next.size === last.size) return next;
    last = next;
  }
  return last;
}

/** Canvas-commit guard, PNG variant. */
async function committedPng(canvas: OffscreenCanvas): Promise<Blob> {
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

/** Fresh canvas at the step size — one resample from the source bitmap
 *  (never step-to-step, which would compound smoothing loss). */
function drawAt(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  opaque: boolean
): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas-2d-unavailable");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  if (opaque) {
    // JPEG has no alpha — flatten transparent pixels onto white.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

interface Attempt {
  blob: Blob;
  width: number;
  height: number;
  hit: boolean;
}

/**
 * JPEG ladder: for every dimension step (big first), binary-search the
 * largest quality that fits. First step that can fit wins; if none can,
 * the smallest attempt ships with hit: false.
 */
async function ladderJpeg(
  bitmap: ImageBitmap,
  startWidth: number,
  startHeight: number,
  target: number
): Promise<Attempt> {
  let smallest: { blob: Blob; width: number; height: number } | null = null;
  const trackSmallest = (blob: Blob, width: number, height: number): void => {
    if (!smallest || blob.size < smallest.blob.size) {
      smallest = { blob, width, height };
    }
  };

  for (const step of dimLadder(startWidth, startHeight)) {
    const canvas = drawAt(bitmap, step.width, step.height, true);
    // Quality → committed blob cache: searchQuality probes each value at
    // most once, and the winning blob is retrieved without a re-encode.
    const cache = new Map<number, Blob>();
    const fits = async (quality: number): Promise<boolean> => {
      let blob = cache.get(quality);
      if (!blob) {
        blob = await committedJpeg(canvas, quality);
        cache.set(quality, blob);
      }
      trackSmallest(blob, step.width, step.height);
      return blob.size <= target;
    };

    const best = await searchQuality(fits);
    if (best !== null) {
      return {
        blob: cache.get(best) as Blob,
        width: step.width,
        height: step.height,
        hit: true,
      };
    }
  }

  const floor = smallest as { blob: Blob; width: number; height: number } | null;
  if (!floor) {
    // Unreachable (the ladder always has at least one step), but a worker
    // must never post an undefined output — fail loudly instead.
    throw new Error("jpeg-ladder-empty");
  }
  return { blob: floor.blob, width: floor.width, height: floor.height, hit: false };
}

/** PNG ladder: no quality knob — shrink ×0.8 steps until the budget fits. */
async function ladderPng(
  bitmap: ImageBitmap,
  startWidth: number,
  startHeight: number,
  target: number
): Promise<Attempt> {
  let smallest: { blob: Blob; width: number; height: number } | null = null;
  const trackSmallest = (blob: Blob, width: number, height: number): void => {
    if (!smallest || blob.size < smallest.blob.size) {
      smallest = { blob, width, height };
    }
  };

  for (const step of dimLadder(startWidth, startHeight)) {
    const canvas = drawAt(bitmap, step.width, step.height, false);
    const blob = await committedPng(canvas);
    trackSmallest(blob, step.width, step.height);
    if (blob.size <= target) {
      return { blob, width: step.width, height: step.height, hit: true };
    }
  }

  const floor = smallest as { blob: Blob; width: number; height: number } | null;
  if (!floor) {
    throw new Error("png-ladder-empty");
  }
  return { blob: floor.blob, width: floor.width, height: floor.height, hit: false };
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;

  const { bytes: target } = resolveTargetBytes(options as Record<string, unknown>);
  const usePng = String(options.format ?? "jpeg") === "png";
  const maxDim = Number(options.maxDim ?? 0);

  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  const usedNames = new Set<string>();
  let allHit = true;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    post({
      type: "progress",
      runId,
      pct: Math.min(88, 5 + Math.round((87 * i) / files.length)),
      stage: "processing",
      detail: { page: i + 1, pages: files.length },
    });

    const raw = new Uint8Array(await file.arrayBuffer());
    const kind = sniffInputKind(raw.slice(0, 16), file.type);
    if (kind === null) {
      post({
        type: "error",
        runId,
        code: "tool.images.errorUnsupported",
        detail: file.name,
      });
      return;
    }

    // Decode → ImageBitmap (EXIF orientation applied by the decoder).
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
          new Blob([raw as unknown as BlobPart], { type: file.type || "image/*" }),
          { imageOrientation: "from-image" }
        );
      } catch {
        // SVG is the known case (workers can't raster it — see the
        // svg-to-pdf tool); everything else is a genuinely broken file.
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
      const capped = capDimensions(bitmap.width, bitmap.height, maxDim);
      const sameFormat = usePng ? kind === "png" : kind === "jpeg";
      const dimsUntouched =
        bitmap.width === capped.width && bitmap.height === capped.height;

      let blob: Blob;
      let hit: boolean;
      if (sameFormat && dimsUntouched && raw.length <= target) {
        // Already under budget in the requested format — passthrough.
        blob = new Blob([raw as unknown as BlobPart], {
          type: usePng ? "image/png" : "image/jpeg",
        });
        hit = true;
      } else {
        const attempt = usePng
          ? await ladderPng(bitmap, capped.width, capped.height, target)
          : await ladderJpeg(bitmap, capped.width, capped.height, target);
        blob = attempt.blob;
        hit = attempt.hit;
      }
      if (!hit) allHit = false;

      const base = sanitizeBase(file.name);
      const ext = usePng ? "png" : "jpg";
      let name = `${base}-resized.${ext}`;
      if (usedNames.has(name)) {
        let n = 2;
        while (usedNames.has(`${base}-${n}-resized.${ext}`)) {
          n += 1;
        }
        name = `${base}-${n}-resized.${ext}`;
      }
      usedNames.add(name);
      outputs.push({
        name,
        mime: usePng ? "image/png" : "image/jpeg",
        blob,
      });
    } finally {
      bitmap.close();
    }
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
    detail: {
      files: outputs.length,
      pages: outputs.length,
      targetHit: allHit,
    },
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
      detail: /canvas/i.test(message) ? message.slice(0, 200) : undefined,
    });
  });
};
