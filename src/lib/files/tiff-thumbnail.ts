/**
 * TIFF thumbnails: browsers can't render TIFF inside <img>, but we ship a
 * decoder — so TIFF inputs get a REAL page-1 preview (scaled onto a small
 * canvas) instead of a format glyph. Guarded by a pixel cap so huge scans
 * never jank the main thread; failures fall back to the glyph via the
 * caller's error state.
 */

import {
  TiffFile,
  TiffError,
  TIFF_MAX_PIXELS,
} from "../../../tools/imgconv/tiff";

const THUMBNAIL_MAX_PIXELS = 16_000_000; // ≈ a 300-DPI A4 page

/** True when the blob looks like a TIFF (magic bytes). */
export async function isTiffBlob(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return (
    (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0) ||
    (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a)
  );
}

/**
 * Decode page 1 of the TIFF and return a scaled PNG blob (or null when the
 * file is too big / not decodable here — the glyph fallback applies).
 */
export async function renderTiffThumbnail(
  blob: Blob,
  maxDim = 200
): Promise<{ blob: Blob; width: number; height: number } | null> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
  if (bytes.length > 400 * 1024 * 1024) return null;

  let file: TiffFile;
  try {
    file = TiffFile.parse(bytes);
  } catch (error) {
    if (error instanceof TiffError && error.kind === "tiff-too-large") {
      return null; // huge page: glyph fallback, no jank
    }
    return null;
  }

  const info = file.pageInfo(0);
  if (info.width * info.height > Math.min(TIFF_MAX_PIXELS, THUMBNAIL_MAX_PIXELS)) {
    return null;
  }

  try {
    const page = file.decodePage(0);
    const scale = Math.min(maxDim / page.width, maxDim / page.height, 1);
    const width = Math.max(1, Math.round(page.width * scale));
    const height = Math.max(1, Math.round(page.height * scale));
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(width, height)
        : null;
    if (canvas) {
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.putImageData(
        new ImageData(page.rgba, page.width, page.height),
        0,
        0
      );
      // Downscale in a second pass (putImageData ignores the transform).
      const scaled = new OffscreenCanvas(width, height);
      const sContext = scaled.getContext("2d");
      if (!sContext) return null;
      sContext.imageSmoothingQuality = "high";
      sContext.drawImage(canvas, 0, 0, width, height);
      const out = await scaled.convertToBlob({ type: "image/png" });
      return { blob: out, width: page.width, height: page.height };
    }
  } catch {
    return null;
  }
  return null;
}
