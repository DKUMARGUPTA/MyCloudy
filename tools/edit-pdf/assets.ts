"use client";

/**
 * Edit PDF — image asset registry (main thread).
 *
 * Uploaded/pasted images become "assets": normalized image Files (PNG for
 * anything pdf-lib can't embed directly) + display URLs. The run wires
 * assetIds to indexes here; the tool config's collectAssets hands the
 * SAME order to the worker (svg-to-pdf logo-store pattern).
 */

import { useEffect, useState } from "react";

export interface AssetEntry {
  file: File;
  url: string;
  width: number;
  height: number;
}

const assets = new Map<string, AssetEntry>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** The assets Map is read by the surface + config collectAssets. */
export function assetMap(): Map<string, AssetEntry> {
  return assets;
}

export function registerAsset(
  assetId: string,
  file: File,
  width: number,
  height: number
): string {
  const url = URL.createObjectURL(file);
  assets.set(assetId, { file, url, width, height });
  bump();
  return url;
}

export function getAssetUrl(assetId: string): string | null {
  return assets.get(assetId)?.url ?? null;
}

/** Stable insertion order — the worker pairs k-th file with k-th index. */
export function assetFiles(): File[] {
  return [...assets.values()].map((entry) => entry.file);
}

export function assetIndexMap(): Record<string, number> {
  const map: Record<string, number> = {};
  let index = 0;
  for (const key of assets.keys()) {
    map[key] = index;
    index += 1;
  }
  return map;
}

export function clearAssets(): void {
  for (const entry of assets.values()) {
    URL.revokeObjectURL(entry.url);
  }
  assets.clear();
  bump();
}

/** Reactive hook: an object URL for an asset, re-resolved on changes. */
export function useAssetUrl(assetId: string): string | null {
  const [, setState] = useState(0);
  useEffect(() => {
    const listener = (): void => setState((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return assets.get(assetId)?.url ?? null;
}

/**
 * Normalize an image file into something pdf-lib can embed: PNG or JPEG
 * pass through untouched; anything else (webp/gif/bmp/avif…) is decoded
 * and re-encoded as PNG on a canvas. Returns null for undecodable files.
 */
export async function normalizeImageFile(
  file: File
): Promise<{ file: File; width: number; height: number } | null> {
  if (file.type === "image/png" || file.type === "image/jpeg") {
    try {
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return { file, ...size };
    } catch {
      return null;
    }
  }
  if (!file.type.startsWith("image/")) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png")
    );
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    if (blob === null) return null;
    const base = file.name.replace(/\.[^.]+$/, "");
    const converted = new File([blob], `${base || "image"}.png`, {
      type: "image/png",
    });
    return { file: converted, ...size };
  } catch {
    return null;
  }
}
