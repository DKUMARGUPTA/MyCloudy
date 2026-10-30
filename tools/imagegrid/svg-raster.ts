/**
 * SVG raster store (main thread) — the add-watermark logo-store pattern
 * generalized for the image grid.
 *
 * Why: Web Workers cannot rasterise SVG (Chrome/Firefox reject SVG blobs
 * in createImageBitmap — verified P4.4), but the main thread renders SVG
 * in <img> everywhere. So while a grid card loads its SVG preview, the
 * file is rasterised ONCE at print-crisp resolution into a PNG File and
 * parked here; config.collectAssets (tools/svg-to-pdf) hands the PNGs to
 * the worker as run assets, aligned to the workspace file order.
 *
 * Raster policy: scale so the longest side reaches TARGET_LONGEST_SIDE
 * (≈ 290 DPI on A4) — small icons upscale (vector, so this stays crisp),
 * already-large art is embedded at its native size. PNG keeps alpha.
 */

import { svgRasterKey } from "./svg-raster-key";

/** Longest raster side in px — print-crisp on A4, sane file sizes. */
const TARGET_LONGEST_SIDE = 2400;
/** Hard raster budget (PRD NFR §14 memory guard, same idea as 40MP PDF). */
const MAX_RASTER_PIXELS = 30_000_000;

const rasters = new Map<string, File>();
const naturalByFile = new Map<string, { w: number; h: number }>();

/* ---------------- pending-state (CTA gate) ---------------- */

let pending = 0;
const listeners = new Set<() => void>();

function bumpPending(delta: number): void {
  pending = Math.max(0, pending + delta);
  for (const listener of listeners) listener();
}

/** useSyncExternalStore glue — re-renders the surface when rasters land. */
export function subscribeSvgPending(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** How many SVG rasters are still being prepared (0 = ready). */
export function svgRastersPending(): number {
  return pending;
}

/** SSR/prerender snapshot — 0 pending rasters on the server (primitive, stable). */
export function svgRastersPendingServer(): number {
  return 0;
}

/* ---------------- detection ---------------- */

/** Cheap SVG check without reading bytes (type or extension). */
export function looksSvg(file: File): boolean {
  return (
    file.type === "image/svg+xml" ||
    (!file.type && /\.svg$/i.test(file.name))
  );
}

/* ---------------- rasterisation ---------------- */

/**
 * Rasterises `file` (PNG File, name mirrors the source) and caches it.
 * Safe to call repeatedly — the second call is a cache hit.
 */
export async function rasterizeSvgFile(file: File): Promise<File> {
  const key = svgRasterKey(file);
  const cached = rasters.get(key);
  if (cached) return cached;

  bumpPending(1);
  try {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = "async";
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("svg-decode-failed"));
        img.src = url;
      });
      const naturalW = img.naturalWidth || 300;
      const naturalH = img.naturalHeight || 150;
      // Upscale small art to the target side (capped), never downscale.
      const factor = Math.max(
        1,
        Math.min(
          TARGET_LONGEST_SIDE / Math.max(naturalW, naturalH),
          Math.sqrt(MAX_RASTER_PIXELS / (naturalW * naturalH)),
          16
        )
      );
      const width = Math.max(1, Math.round(naturalW * factor));
      const height = Math.max(1, Math.round(naturalH * factor));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas-2d-unavailable");
      // drawImage rasterises the vector art AT THE DRAWN SIZE — crisp.
      context.drawImage(img, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/png");
      });
      if (!blob) throw new Error("png-encode-failed");

      const base = file.name.replace(/\.svg$/i, "").slice(0, 120) || "image";
      const raster = new File([blob], `${base}.png`, {
        type: "image/png",
      });
      rasters.set(key, raster);
      naturalByFile.set(key, { w: naturalW, h: naturalH });
      return raster;
    } finally {
      URL.revokeObjectURL(url);
    }
  } finally {
    bumpPending(-1);
  }
}

/* ---------------- run-time asset bridge ---------------- */

let orderKeys: string[] = [];

/**
 * The surface reports the CURRENT workspace files after every change so
 * collectAssets can hand rasters over in exactly the worker's file order
 * (only SVG files produce assets; see the svg-to-pdf worker pairing).
 */
export function setSvgRasterOrder(files: File[]): void {
  orderKeys = files.filter(looksSvg).map(svgRasterKey);
}

/**
 * Rasters for the current order — STRICT: if any listed SVG has no raster
 * yet (or rasterisation failed), NOTHING is returned. The worker then
 * fails honestly instead of pairing the wrong rasters with the wrong
 * files (a partial list would silently misalign the k-th pairing).
 *
 * The LAST element is a small JSON manifest (svg-dims.json) carrying each
 * SVG's natural CSS size in the same order — the worker sizes "fit" pages
 * by the graphic's own size, not the upscaled raster's.
 */
export function getSvgRastersInOrder(): File[] {
  const out: File[] = [];
  const dims: Array<{ w: number; h: number }> = [];
  for (const key of orderKeys) {
    const raster = rasters.get(key);
    if (!raster) return [];
    out.push(raster);
    dims.push(naturalByFile.get(key) ?? { w: 0, h: 0 });
  }
  if (out.length > 0) {
    out.push(
      new File([JSON.stringify(dims)], "svg-dims.json", {
        type: "application/json",
      })
    );
  }
  return out;
}
