import { PDFArray, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";

import {
  indexedBaseComponents,
  indexedPalette,
  targetSize,
  type ImageCandidate,
  type PaletteInfo,
} from "./engine";
import { encodeGrayJpeg, rgbaToGrayPlane } from "./gray-jpeg";

/**
 * Shared photo recompression pipeline (compress-pdf family).
 *
 * Extracted from the compress-pdf worker so Compress-to-target-size can
 * reuse the exact same decode → interpret → rescale → re-encode path:
 *   - DCTDecode images decode via the browser's native JPEG decoder
 *   - Flate/LZW/… images decode via pdf-lib and are interpreted by
 *     colorspace (gray/RGB/CMYK/Indexed, incl. stream-backed palettes)
 *   - grayscale re-encodes through our true 1-component JPEG encoder
 *
 * Every replacement is size-guarded: unless the re-encoded JPEG is clearly
 * smaller than the ORIGINAL stream (≥2% margin), null is returned and the
 * caller keeps the original bytes.
 */

/** CMYK → RGB, naive (no ink-limit management) — fine for preview photos. */
function cmykToRgb(
  c: number,
  m: number,
  y: number,
  k: number
): [number, number, number] {
  return [
    255 - Math.min(255, c + k),
    255 - Math.min(255, m + k),
    255 - Math.min(255, y + k),
  ];
}

/**
 * Interprets losslessly-decoded raw pixel bytes (per the candidate's
 * strategy) as an ImageData. `paletteOverride` carries a stream-backed
 * /Indexed palette the engine could not read inline.
 */
export function rawPixelsToImageData(
  candidate: ImageCandidate,
  pixels: Uint8Array,
  paletteOverride?: PaletteInfo | null
): ImageData | null {
  const { width, height, strategy, components } = candidate;

  if (strategy === "indexed") {
    const info = paletteOverride ?? indexedPalette(candidate.stream.dict);
    if (!info || info.palette.length === 0) return null;
    const { baseComponents, palette } = info;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, out = 0; i < width * height; i += 1, out += 4) {
      const start =
        Math.min(pixels[i] ?? 0, (info.palette.length / baseComponents | 0) - 1) *
        baseComponents;
      if (baseComponents === 1) {
        const g = palette[start] ?? 0;
        data[out] = g;
        data[out + 1] = g;
        data[out + 2] = g;
      } else if (baseComponents === 3) {
        data[out] = palette[start] ?? 0;
        data[out + 1] = palette[start + 1] ?? 0;
        data[out + 2] = palette[start + 2] ?? 0;
      } else {
        const [r, g, b] = cmykToRgb(
          palette[start] ?? 0,
          palette[start + 1] ?? 0,
          palette[start + 2] ?? 0,
          palette[start + 3] ?? 0
        );
        data[out] = r;
        data[out + 1] = g;
        data[out + 2] = b;
      }
      data[out + 3] = 255;
    }
    return new ImageData(data, width, height);
  }

  const needed = width * height * components;
  if (pixels.length < needed) return null; // truncated stream — keep original

  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, out = 0; i < width * height; i += 1, out += 4) {
    const p = i * components;
    if (components === 1) {
      const g = pixels[p] ?? 0;
      data[out] = g;
      data[out + 1] = g;
      data[out + 2] = g;
    } else if (components === 3) {
      data[out] = pixels[p] ?? 0;
      data[out + 1] = pixels[p + 1] ?? 0;
      data[out + 2] = pixels[p + 2] ?? 0;
    } else {
      const [r, g, b] = cmykToRgb(
        pixels[p] ?? 0,
        pixels[p + 1] ?? 0,
        pixels[p + 2] ?? 0,
        pixels[p + 3] ?? 0
      );
      data[out] = r;
      data[out + 1] = g;
      data[out + 2] = b;
    }
    data[out + 3] = 255;
  }
  return new ImageData(data, width, height);
}

/** /Indexed lookup palette stored as a (possibly filtered) stream. */
function streamPalette(candidate: ImageCandidate): PaletteInfo | null {
  const colorSpace = candidate.stream.dict.lookup(PDFName.of("ColorSpace"));
  if (!(colorSpace instanceof PDFArray) || colorSpace.size() < 4) return null;
  const base = colorSpace.lookup(1);
  if (!(base instanceof PDFName)) return null;
  const baseComponents = indexedBaseComponents(base);
  if (baseComponents === null) return null;
  const lookup = colorSpace.lookup(3);
  if (lookup instanceof PDFRawStream) {
    try {
      const palette = decodePDFRawStream(lookup).decode();
      if (palette.length > 0) return { baseComponents, palette };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Full pipeline for one image candidate → replacement JPEG bytes, or null
 * to keep the original (decode failure / no size gain). Grayscale runs
 * through our true 1-component JPEG encoder (a third smaller than the
 * canvas's YCbCr encode of the same content).
 */
export async function recompressCandidate(
  candidate: ImageCandidate,
  quality: number,
  maxDim: number,
  grayscale: boolean
): Promise<{ bytes: Uint8Array; width: number; height: number; components: 1 | 3 } | null> {
  // Source pixels → an ImageBitmap-ish drawable on a full-size canvas.
  let source: ImageBitmap | OffscreenCanvas;
  try {
    if (candidate.strategy === "jpeg") {
      source = await createImageBitmap(
        new Blob([candidate.stream.contents as BlobPart], {
          type: "image/jpeg",
        })
      );
    } else {
      const pixels = decodePDFRawStream(candidate.stream).decode();
      let imageData = rawPixelsToImageData(candidate, pixels);
      if (imageData === null && candidate.strategy === "indexed") {
        // The palette may live in a stream — resolve it and retry.
        imageData = rawPixelsToImageData(
          candidate,
          pixels,
          streamPalette(candidate)
        );
      }
      if (imageData === null) return null;
      const full = new OffscreenCanvas(candidate.width, candidate.height);
      const fullCtx = full.getContext("2d");
      if (!fullCtx) return null;
      fullCtx.putImageData(imageData, 0, 0);
      source = full;
    }
  } catch {
    return null; // undecodable image — keep the original stream
  }

  const target = targetSize(candidate.width, candidate.height, maxDim);
  const canvas = new OffscreenCanvas(target.width, target.height);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(source, 0, 0, target.width, target.height);
  if ("close" in source && typeof source.close === "function") source.close();

  let bytes: Uint8Array;
  let components: 1 | 3;
  if (grayscale) {
    const imageData = context.getImageData(0, 0, target.width, target.height);
    const plane = rgbaToGrayPlane(imageData.data, target.width, target.height);
    bytes = encodeGrayJpeg(plane, target.width, target.height, quality * 100);
    components = 1;
  } else {
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    bytes = new Uint8Array(await blob.arrayBuffer());
    components = 3;
  }
  // Size guard: only replace when the re-encode clearly wins (≥2%).
  if (bytes.length >= candidate.sourceBytes * 0.98) return null;
  return { bytes, width: target.width, height: target.height, components };
}
