import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import { stripAllMetadata } from "../meta-common/worker-lib";
import {
  collectImageCandidates,
  grayscaleImageData,
  indexedBaseComponents,
  indexedPalette,
  replaceImageStream,
  resolveParams,
  targetSize,
  type ImageCandidate,
  type PaletteInfo,
} from "./engine";

/**
 * Compress PDF worker (PRD §7.5, device mode).
 *
 * Re-encodes embedded photos as JPEG (quality + max pixel size), keeps
 * text/fonts/vector art untouched — selectable text stays selectable.
 * DCTDecode images decode via the browser's native JPEG decoder
 * (createImageBitmap); Flate/LZW/… images decode via pdf-lib's
 * decodePDFRawStream and are interpreted by colorspace into an ImageData.
 * Every replacement is size-guarded: unless the re-encoded JPEG is clearly
 * smaller, the original stream is kept — output can only shrink per
 * image, never regress.
 *
 * Device-only: the File arrives by structured clone, the PDF Blob goes
 * back — nothing touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

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
function rawPixelsToImageData(
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
 * to keep the original (decode failure / no size gain).
 */
async function recompressCandidate(
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

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const params = resolveParams(options as Record<string, unknown>);
  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let totalPages = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    post({
      type: "progress",
      runId,
      pct: Math.round(((fileIndex + 0.05) / files.length) * 100),
      stage: "reading",
      detail: { page: fileIndex + 1, pages: files.length },
    });

    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    totalPages += doc.getPageCount();

    const candidates = collectImageCandidates(doc);

    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const result = await recompressCandidate(
        candidate,
        params.quality,
        params.maxDim,
        params.grayscale
      );
      if (result) {
        replaceImageStream(
          doc.context,
          candidate,
          result.bytes,
          result.width,
          result.height
        );
      }
      post({
        type: "progress",
        runId,
        pct: Math.round(
          ((fileIndex + (i + 1) / candidates.length) / files.length) * 88 + 5
        ),
        stage: "processing",
        detail: { page: i + 1, pages: candidates.length },
      });
    }

    if (params.stripMetadata) stripAllMetadata(doc, true);

    post({
      type: "progress",
      runId,
      pct: Math.round(((fileIndex + 0.94) / files.length) * 100),
      stage: "saving",
    });
    const saved = await doc.save({ useObjectStreams: true });
    outputs.push({
      name: `${fileBaseName(file.name)}-compressed.pdf`,
      mime: "application/pdf",
      blob: new Blob([saved as BlobPart], { type: "application/pdf" }),
    });
  }

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: totalPages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /password|encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code });
  });
};
