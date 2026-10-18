/**
 * Write PDF — in-memory image asset store (the edit-pdf asset-store
 * pattern, trimmed). The surface owns the uploads (image blocks); the
 * export run needs the same bytes as File[] (they ride the worker message,
 * never the network). Memory only — assets die with the tab (privacy §2.2).
 */

import { decodeHeicToBitmap } from "@/lib/heic/heic-decode";

export interface WAsset {
  key: string;
  file: File;
  /** Object URL for <img> display (revoked on remove/clear). */
  url: string;
  /** Natural pixel size (post normalisation). */
  w: number;
  h: number;
}

const store = new Map<string, WAsset>();
/** Stable snapshot for useSyncExternalStore (rebuilt on notify). */
let snapshot: WAsset[] = [];
let seq = 0;

/** Max dimension an asset is normalised to (protects worker memory). */
const MAX_DIM = 4096;

function keyFor(name: string): string {
  seq += 1;
  const base = name.replace(/\.[a-z0-9]+$/i, "").replace(/[^\w-]+/g, "_");
  return `w${seq}_${base}`.slice(0, 60);
}

function notify(): void {
  snapshot = [...store.values()];
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("docopdf:write-assets"));
  }
}

export function subscribeAssets(callback: () => void): () => void {
  window.addEventListener("docopdf:write-assets", callback);
  return () => window.removeEventListener("docopdf:write-assets", callback);
}

export function getAssetsSnapshot(): WAsset[] {
  return snapshot;
}

export function getAsset(key: string): WAsset | undefined {
  return store.get(key);
}

function bitmapToPngFile(bitmap: ImageBitmap, name: string): Promise<File> {
  let w = bitmap.width;
  let h = bitmap.height;
  const scale = Math.min(1, MAX_DIM / Math.max(w, h));
  w = Math.max(1, Math.round(w * scale));
  h = Math.max(1, Math.round(h * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas-2d-unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.convertToBlob({ type: "image/png" }).then(
    (blob) => new File([blob], `${name}.png`, { type: "image/png" })
  );
}

/**
 * Adds an image file. JPG/PNG pass through untouched (pdf-lib embeds them
 * natively) after a decode probe — a corrupt file must fail HERE, not at
 * export time; everything else (WEBP/HEIC/GIF/BMP/…) is decoded — HEIC
 * through the self-hosted libheif WASM — and re-encoded as PNG.
 */
export async function addImageFile(file: File): Promise<WAsset> {
  const type = (file.type || "").toLowerCase();
  let usable = file;
  if (type !== "image/jpeg" && type !== "image/png") {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      bitmap = null;
    }
    if (!bitmap) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      bitmap = await decodeHeicToBitmap(bytes).catch(() => null);
    }
    if (!bitmap) throw new Error("undecodable-image");
    usable = await bitmapToPngFile(bitmap, file.name || "image");
    bitmap.close();
  }
  let w = 600;
  let h = 400;
  const probe = await createImageBitmap(usable).catch(() => null);
  if (probe) {
    w = probe.width;
    h = probe.height;
    probe.close();
  } else {
    throw new Error("undecodable-image");
  }
  const asset: WAsset = {
    key: keyFor(file.name || "image"),
    file: usable,
    url: URL.createObjectURL(usable),
    w,
    h,
  };
  store.set(asset.key, asset);
  notify();
  return asset;
}

export function removeAsset(key: string): void {
  const asset = store.get(key);
  if (!asset) return;
  URL.revokeObjectURL(asset.url);
  store.delete(key);
  notify();
}

export function clearAssets(): void {
  for (const asset of store.values()) URL.revokeObjectURL(asset.url);
  store.clear();
  notify();
}

/** The File[] for an export run, aligned with the doc's asset order. */
export function collectAssetsInOrder(keys: string[]): File[] {
  const files: File[] = [];
  for (const key of keys) {
    const asset = store.get(key);
    if (asset) files.push(asset.file);
  }
  return files;
}
