/**
 * Main-thread HEIC preview helper (workspace thumbnails, PRD §8.6 HEIC
 * tools + §6.3 FileCard/ImageGrid).
 *
 * Browsers other than Safari cannot render HEIC in <img>/objectURL, so
 * image inputs from iPhones would show broken previews. This module decodes
 * HEIC files (native Safari path first, then the self-hosted libheif WASM
 * via src/lib/heic/heic-decode.ts) into a small JPEG preview blob —
 * sequentially queued and cached so a grid of 50 photos stays smooth.
 *
 * Public API:
 *   looksHeic(file) — cheap sync check (mime/extension); false negatives OK
 *   isHeicBytes(head) — magic-byte brand check (the authority)
 *   resolveHeicPreview(file, maxDim?) — null for non-HEIC (caller keeps its
 *     fast objectURL path), else { url, width, height } once decoded
 */

import { decodeHeicToBitmap } from "./heic-decode";

/** HEIC-family MIME types (browsers may or may not report these). */
const HEIC_MIME = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

/** Cheap sync pre-check — callers still confirm via bytes when unsure. */
export function looksHeic(file: File | { name: string; type: string }): boolean {
  if (HEIC_MIME.has(file.type)) return true;
  return /\.(heic|heif|hif)$/i.test(file.name);
}

/** ftyp brand sniff — accepts the HEIC/HEIF family, not AVIF. */
export function isHeicBytes(head: Uint8Array): boolean {
  const has = (bytes: number[], offset = 0) =>
    bytes.every((byte, i) => head[offset + i] === byte);
  if (!has([0x66, 0x74, 0x79, 0x70], 4)) return false;
  const brand = String.fromCharCode(
    head[8] ?? 0,
    head[9] ?? 0,
    head[10] ?? 0,
    head[11] ?? 0
  );
  return ["heic", "heix", "hevc", "hevm", "hevs", "heim", "heis", "mif1", "msf1"].includes(brand);
}

export interface HeicPreview {
  /** Small JPEG preview blob (create your own object URL from this). */
  blob: Blob;
  /** Cache-owned object URL — never revoke from the caller. */
  url: string;
  width: number;
  height: number;
}

interface CacheEntry {
  promise: Promise<HeicPreview | null>;
}

const previewCache = new Map<File, CacheEntry>();
const MAX_CACHE = 64;

/** Sequential decode queue — one HEIC at a time keeps the main thread sane. */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function decodePreview(
  file: File,
  maxDim: number
): Promise<HeicPreview | null> {
  let raw: Uint8Array | null = null;
  try {
    // Native decode first (Safari — no WASM needed).
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      const bytes = new Uint8Array(await file.arrayBuffer());
      raw = bytes;
      bitmap = await decodeHeicToBitmap(bytes);
    }
    try {
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
      return {
        blob,
        url: URL.createObjectURL(blob),
        width: bitmap.width,
        height: bitmap.height,
      };
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

/**
 * Returns null when the file is not HEIC (caller keeps its fast path).
 * HEIC files get a queued, cached preview — concurrent calls share one
 * decode. A failed decode resolves to null (honest fallback: no preview).
 */
export function resolveHeicPreview(
  file: File,
  maxDim = 480
): Promise<HeicPreview | null> {
  const cached = previewCache.get(file);
  if (cached) return cached.promise;

  const task = enqueue(async () => {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (!isHeicBytes(head)) return null;
    return await decodePreview(file, maxDim);
  });

  const entry: CacheEntry = { promise: task };
  previewCache.set(file, entry);
  // Simple LRU: evict the oldest entry beyond the cap (its URL dies with
  // it — previews are cheap to re-decode if the card is seen again).
  if (previewCache.size > MAX_CACHE) {
    const oldest = previewCache.keys().next().value;
    if (oldest !== undefined && oldest !== file) {
      const evicted = previewCache.get(oldest);
      previewCache.delete(oldest);
      void evicted?.promise.then((p) => {
        if (p) URL.revokeObjectURL(p.url);
      });
    }
  }
  return task;
}
