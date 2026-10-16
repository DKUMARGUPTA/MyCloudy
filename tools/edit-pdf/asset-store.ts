/**
 * Edit PDF — in-memory image/signature asset store (the watermark
 * logo-store pattern, multi-entry).
 *
 * The editor SURFACE owns the uploads (image tool + signature pad); the
 * WORKER needs the same bytes as run ASSETS (config.collectAssets → they
 * ride the worker message, never the network). Objects reference assets
 * by `assetKey`; the run blob carries `assetOrder` and the store's
 * collectRunAssets() returns the matching File[].
 *
 * Memory only — assets die with the tab (privacy §2.2). Object URLs are
 * revoked on removal/clear.
 */

import { decodeHeicToBitmap } from "@/lib/heic/heic-decode";

export interface EditorAsset {
  key: string;
  file: File;
  /** Object URL for <img> display (revoked by remove/clear). */
  url: string;
  /** Natural pixel size (post normalisation). */
  w: number;
  h: number;
}

const ASSET_EVENT = "docopdf:editor-assets-change";

const store = new Map<string, EditorAsset>();
/** Stable snapshot for useSyncExternalStore (refreshed on notify). */
let snapshot: EditorAsset[] = [];
let seq = 0;

function notify(): void {
  snapshot = [...store.values()];
  try {
    window.dispatchEvent(new Event(ASSET_EVENT));
  } catch {
    /* no window (SSR) — nothing to notify */
  }
}

export function subscribeAssets(callback: () => void): () => void {
  window.addEventListener(ASSET_EVENT, callback);
  return () => window.removeEventListener(ASSET_EVENT, callback);
}

/** Stable snapshot (useSyncExternalStore-compatible). */
export function getAssetsSnapshot(): EditorAsset[] {
  return snapshot;
}

export function getAsset(key: string): EditorAsset | undefined {
  return store.get(key);
}

/** Max dimension an asset is normalised to (protects worker memory). */
const MAX_DIM = 4096;

function keyFor(name: string): string {
  seq += 1;
  const base = name.replace(/\.[a-z0-9]+$/i, "").replace(/[^\w-]+/g, "_");
  return `a${seq}_${base}`.slice(0, 60);
}

/**
 * Normalises one decoded bitmap to a PNG File (downscaling when huge).
 * Used for signature pads and formats pdf-lib cannot embed directly.
 */
async function bitmapToPngFile(
  bitmap: ImageBitmap,
  name: string
): Promise<File> {
  let w = bitmap.width;
  let h = bitmap.height;
  const scale = Math.min(1, MAX_DIM / Math.max(w, h));
  w = Math.max(1, Math.round(w * scale));
  h = Math.max(1, Math.round(h * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas-2d-unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new File([blob], `${name}.png`, { type: "image/png" });
}

/**
 * Adds an image file. JPG/PNG pass through untouched (pdf-lib embeds
 * them natively) after a decode probe — a corrupt file must fail HERE,
 * not at export time; everything else (WEBP/HEIC/GIF/BMP/…) is decoded
 * — HEIC through the self-hosted libheif WASM — and re-encoded as PNG.
 * Resolves with the stored asset; rejects when nothing can decode it.
 */
export async function addImageFile(file: File): Promise<EditorAsset> {
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
  // Natural size (for aspect-true placement) + the honesty probe: a
  // JPG/PNG that cannot be decoded would only fail inside the export
  // worker otherwise.
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
  const asset: EditorAsset = {
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

/** Adds a ready PNG blob (the signature pad output). */
export async function addPngBlob(blob: Blob, name: string): Promise<EditorAsset> {
  const file = new File([blob], `${name}.png`, { type: "image/png" });
  return addImageFile(file);
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
  runOrder = [];
  notify();
}

// ---------------------------------------------------------------------------
// Run pairing (collectAssets ↔ worker)
// ---------------------------------------------------------------------------

/** Asset keys the next run should carry, in a stable order. */
let runOrder: string[] = [];

/** Records which assets the CURRENT objects reference (surface commit). */
export function setRunOrder(keys: string[]): void {
  runOrder = [...keys];
}

/** The File[] collectAssets hands the worker (aligned with runOrder). */
export function collectRunAssets(): File[] {
  const files: File[] = [];
  for (const key of runOrder) {
    const asset = store.get(key);
    if (asset) files.push(asset.file);
  }
  return files;
}

// Dev-only introspection hook (never called by product code).
declare global {
  interface Window {
    __edAssets?: () => { keys: string[]; runOrder: string[] };
  }
}
if (typeof window !== "undefined") {
  window.__edAssets = () => ({
    keys: [...store.keys()],
    runOrder: [...runOrder],
  });
}
