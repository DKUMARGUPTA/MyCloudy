import {
  PDFArray,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";

import {
  grayscaleImageData,
  indexedBaseComponents,
  indexedPalette,
  targetSize,
  type ImageCandidate,
  type PaletteInfo,
} from "../compress-pdf/engine";

/**
 * Shared impure image-recompression helpers (compress-pdf +
 * compress-pdf-to-size). Everything canvas-touching lives here so both
 * workers stream through the identical decode → scale → re-encode path.
 *
 * Kept verbatim in behaviour to the code that used to live inside
 * compress-pdf/worker.ts (P3.12) — extracted in P3.20 for reuse.
 */

/** CMYK → RGB, naive (no ink-limit management) — fine for preview photos. */
export function cmykToRgb(
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
export function streamPalette(candidate: ImageCandidate): PaletteInfo | null {
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
 * to keep the original (decode failure / no size gain).
 */
export async function recompressCandidate(
  candidate: ImageCandidate,
  quality: number,
  maxDim: number,
  grayscale: boolean
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
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

  if (grayscale) {
    const imageData = context.getImageData(0, 0, target.width, target.height);
    grayscaleImageData(imageData.data);
    context.putImageData(imageData, 0, 0);
  }

  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Size guard: only replace when the re-encode clearly wins (≥2%).
  if (bytes.length >= candidate.sourceBytes * 0.98) return null;
  return { bytes, width: target.width, height: target.height };
}

/**
 * Materializes a rendered page canvas as COMMITTED JPEG bytes.
 *
 * Same race as ocr-pdf's committedPngBlob (P3.19): Chrome's accelerated
 * OffscreenCanvas can resolve pdf.js's render task while raster ops are
 * still pending on the GPU — a readback taken that instant returns a
 * BLANK snapshot. Converting once, letting an image decode yield, and
 * converting again is stable: the deterministic encoder only produces
 * equal sizes once the bitmap has settled. Genuinely blank pages settle
 * immediately (their size never changes), so the loop exits for them too.
 */
export async function committedJpegBlob(
  canvas: OffscreenCanvas,
  quality: number
): Promise<Blob> {
  let last = await canvas.convertToBlob({
    type: "image/jpeg",
    quality,
  });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const probe = await createImageBitmap(last);
    probe.close(); // decode yield — lets the pending raster ops commit
    const next = await canvas.convertToBlob({
      type: "image/jpeg",
      quality,
    });
    if (next.size === last.size) return next;
    last = next;
  }
  return last;
}
