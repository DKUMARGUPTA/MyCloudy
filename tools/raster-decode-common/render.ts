/**
 * Shared raster→PDF assembly helpers (P3-c, R57).
 *
 * - `computeImagePlacement` is PURE geometry (page size + contain rect for
 *   one image) — verifiable headlessly in the smoke battery.
 * - `encodeRaster` is the WORKER-side encode (OffscreenCanvas): palette /
 *   alpha rasters keep PNG crispness, photo rasters embed as JPEG 0.92
 *   over white — the exact imagegrid recipe, reused by bmp/psd/cbz tools.
 */

import type { RasterImage } from "./bmp";

export interface PreparedImage {
  kind: "jpeg" | "png";
  bytes: Uint8Array;
  width: number;
  height: number;
}

export const PAGE_SIZE_PT: Record<"a4" | "letter", { width: number; height: number }> = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
};

export const MARGIN_PT: Record<string, number> = { none: 0, small: 18, big: 54 };

export type ImagePageSize = "fit" | "a4" | "letter";
export type ImageOrientation = "auto" | "portrait" | "landscape";

export interface ImagePlacement {
  pageW: number;
  pageH: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Page size + contain-fit draw rect for one image.
 * "fit" pages adopt the image's pixel size as points (the imagegrid
 * convention); fixed sizes rotate by the image's own shape when
 * orientation is "auto".
 */
export function computeImagePlacement(
  imgW: number,
  imgH: number,
  opts: {
    pageSize: ImagePageSize;
    orientation: ImageOrientation;
    margin: string;
  },
): ImagePlacement {
  const margin = MARGIN_PT[opts.margin] ?? 18;
  if (opts.pageSize === "fit") {
    return {
      pageW: imgW + margin * 2,
      pageH: imgH + margin * 2,
      x: margin,
      y: margin,
      w: imgW,
      h: imgH,
    };
  }
  const base = PAGE_SIZE_PT[opts.pageSize === "letter" ? "letter" : "a4"];
  const landscape =
    opts.orientation === "landscape" ||
    (opts.orientation === "auto" && imgW > imgH);
  const pageW = landscape ? base.height : base.width;
  const pageH = landscape ? base.width : base.height;
  const availW = Math.max(pageW - margin * 2, 1);
  const availH = Math.max(pageH - margin * 2, 1);
  const scale = Math.min(availW / imgW, availH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  return {
    pageW,
    pageH,
    x: (pageW - w) / 2,
    y: (pageH - h) / 2,
    w,
    h,
  };
}

/**
 * Encode a decoded raster through an OffscreenCanvas. Palette / alpha
 * rasters → PNG (lossless); photo rasters → JPEG 0.92 flattened over
 * white (BMP/PSD composites have no meaningful alpha then).
 */
export async function encodeRaster(
  raster: RasterImage,
  preferPng: boolean,
): Promise<PreparedImage> {
  const canvas = new OffscreenCanvas(raster.width, raster.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.putImageData(
    new ImageData(
      raster.rgba as Uint8ClampedArray<ArrayBuffer>,
      raster.width,
      raster.height,
    ) as unknown as ImageData,
    0,
    0,
  );
  if (!preferPng) {
    // Flatten over white (straight alpha → JPEG has no alpha).
    const flat = new OffscreenCanvas(raster.width, raster.height);
    const fctx = flat.getContext("2d");
    if (!fctx) throw new Error("canvas 2d unavailable");
    fctx.fillStyle = "#ffffff";
    fctx.fillRect(0, 0, raster.width, raster.height);
    fctx.drawImage(canvas, 0, 0);
    const blob = await flat.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    return {
      kind: "jpeg",
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width: raster.width,
      height: raster.height,
    };
  }
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return {
    kind: "png",
    bytes: new Uint8Array(await blob.arrayBuffer()),
    width: raster.width,
    height: raster.height,
  };
}
