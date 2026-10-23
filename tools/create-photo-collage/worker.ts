import { PDFDocument } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { decodeHeicToBitmap } from "@/lib/heic/heic-decode";
import { isTiffBytes, TiffFile, TiffError } from "../imgconv/tiff";
import {
  computePages,
  outputBaseName,
  pagePixelSize,
  pagePtSize,
  parseCollageOption,
  photoDecodeCap,
  type CollageStyle,
} from "./model";
import {
  drawCollagePage,
  orientedSource,
  type CollageCtx,
  type CollageSource,
} from "./render";

/**
 * Create photo collage worker (PRD "Photo collage") — device-only.
 * Files arrive by structured clone, every pixel is painted on an
 * OffscreenCanvas by the SAME render.ts the live preview uses, and the
 * result goes straight back as a Blob. Nothing ever leaves the device.
 *
 * Quality policy (honest): the collage is a raster composition, so
 * photos are re-encoded once — JPEG quality 0.92, the same single
 * re-compression policy as the imagegrid's rotated branch. The PDF is
 * one page per collage page with the JPEG drawn at 2 px/pt (~144 DPI).
 * JPG/PNG export renders page 1 only (documented in the UI).
 *
 * Inputs: JPG / PNG / WEBP / GIF decode natively (createImageBitmap),
 * HEIC decodes via Safari's native path with the self-hosted libheif
 * WASM fallback (src/lib/heic/heic-decode.ts), and TIFF uses the
 * clean-room first-page reader (tools/imgconv/tiff.ts). SVG needs a
 * main-thread raster and is honestly unsupported in this tool (v1).
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

type ImageKind = "jpeg" | "png" | "webp" | "gif" | "heic" | "tiff" | "svg" | "unknown";

function sniffImageKind(head: Uint8Array): ImageKind {
  const has = (bytes: number[], offset = 0) =>
    bytes.every((byte, i) => head[offset + i] === byte);
  if (has([0xff, 0xd8, 0xff])) return "jpeg";
  if (has([0x89, 0x50, 0x4e, 0x47])) return "png";
  if (has([0x47, 0x49, 0x46, 0x38])) return "gif";
  if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8)) {
    return "webp";
  }
  if (has([0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(
      head[8] ?? 0,
      head[9] ?? 0,
      head[10] ?? 0,
      head[11] ?? 0
    );
    if (
      ["heic", "heix", "hevc", "hevm", "hevs", "heim", "heis", "mif1", "msf1"].includes(brand)
    ) {
      return "heic";
    }
  }
  if (isTiffBytes(head)) return "tiff";
  return "unknown";
}

/** "<svg" within the first KB (after xml decl / doctype / comments). */
function isSvgBytes(head: Uint8Array): boolean {
  const window = head.subarray(0, 1024);
  let text = "";
  for (let i = 0; i < window.length; i += 1) {
    text += String.fromCharCode(window[i]);
  }
  return /<svg[\s>]/i.test(text);
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}\u0000${detail}`);
}

function tiffErrorCode(error: TiffError): string {
  if (error.kind === "tiff-corrupt") return "tool.images.errorTiffCorrupt";
  if (error.kind === "tiff-too-large") return "tool.images.errorTiffTooLarge";
  return "tool.images.errorTiffUnsupported";
}

/**
 * Decodes one photo to a bitmap. HEIC tries the native decoder first
 * (Safari), then the self-hosted libheif WASM; TIFF reads its first
 * page (a collage cell is a single image — multi-page TIFFs honestly
 * use page 1); SVG is rejected with the honest unsupported error.
 */
async function decodePhoto(file: File): Promise<ImageBitmap> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name) || isSvgBytes(head)) {
    fail("tool.images.errorUnsupported", file.name);
  }
  const kind = sniffImageKind(head);
  if (kind === "unknown") {
    fail("tool.images.errorUnsupported", file.name);
  }
  if (kind === "heic") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Chromium/Firefox: native HEIC decode is unavailable — libheif.
      try {
        return await decodeHeicToBitmap(
          new Uint8Array(await file.arrayBuffer())
        );
      } catch {
        fail("tool.images.errorHeicDecode", file.name);
      }
    }
  }
  if (kind === "tiff") {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const tiff = TiffFile.parse(bytes);
      if (tiff.pageCount === 0) fail("tool.images.errorTiffCorrupt", file.name);
      const page = tiff.decodePage(0);
      const canvas = new OffscreenCanvas(page.width, page.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) fail("tool.images.errorDecode", file.name);
      ctx.putImageData(
        new ImageData(page.rgba, page.width, page.height) as unknown as ImageData,
        0,
        0
      );
      const bitmap = await createImageBitmap(canvas);
      // The canvas was only a bridge to the bitmap — drop its backing
      // store right away (drawImage already copied the pixels).
      canvas.width = 0;
      canvas.height = 0;
      return bitmap;
    } catch (error) {
      if (error instanceof TiffError) fail(tiffErrorCode(error), file.name);
      throw error;
    }
  }
  try {
    return await createImageBitmap(file);
  } catch {
    fail("tool.images.errorDecode", file.name);
  }
}

/** Releases a decoded raster source (bitmap close / canvas zero-size). */
function releaseSource(source: ImageBitmap | OffscreenCanvas): void {
  if (typeof (source as ImageBitmap).close === "function") {
    (source as ImageBitmap).close();
    return;
  }
  // OffscreenCanvas has no close(); a 0×0 resize drops the backing
  // store (safe after every drawImage that consumed it is done).
  const canvas = source as OffscreenCanvas;
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Bounds one decoded photo to the decode cap (the mobile OOM guard):
 * photos within the cap pass through untouched — zero copies, full cell
 * resolution; anything larger is downscaled once through a canvas while
 * the full-res bitmap is released immediately, so a 50-photo run never
 * holds 50 full-resolution bitmaps at once.
 */
function downscaleToCap(
  bitmap: ImageBitmap,
  cap: number
): ImageBitmap | OffscreenCanvas {
  const longEdge = Math.max(bitmap.width, bitmap.height);
  if (longEdge <= cap || bitmap.width <= 0 || bitmap.height <= 0) {
    return bitmap;
  }
  const scale = cap / longEdge;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return bitmap; // honest fallback: keep the full-res decode
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    bitmap,
    0,
    0,
    bitmap.width,
    bitmap.height,
    0,
    0,
    width,
    height
  );
  if (typeof bitmap.close === "function") bitmap.close();
  return canvas;
}

/** Decodes, cap-downscales + quarter-turn rotates one photo (0 = no copy). */
async function preparePhoto(
  file: File,
  rotation: number,
  cap: number
): Promise<CollageSource> {
  const bitmap = await decodePhoto(file);
  // Memory guard: bound each photo to the cell-size cap right after
  // decode and release the full-res source before the next file is
  // touched (50 photos would otherwise all sit in RAM at full size).
  const scaled = downscaleToCap(bitmap, cap);
  const oriented = orientedSource(scaled, rotation, (w, h) => {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d") as CollageCtx | null;
    if (!ctx) fail("tool.images.errorDecode", file.name);
    return { canvas, ctx };
  });
  // Rotation 0 hands the SAME source back — it stays open for drawing.
  if (oriented !== scaled) releaseSource(scaled);
  return oriented;
}

/**
 * Encodes one collage page to a JPEG blob (quality 0.92 — photos). The
 * canvas-commit guard from the OCR round is unnecessary here: nothing
 * reads pixels back, convertToBlob IS the commit.
 */
async function renderPageBlob(
  images: CollageSource[],
  pages: ReturnType<typeof computePages>,
  pageIndex: number,
  pixelW: number,
  pixelH: number,
  style: CollageStyle
): Promise<Blob> {
  const plan = pages[pageIndex];
  if (!plan) fail("tool.errorGeneric", "page");
  const canvas = new OffscreenCanvas(pixelW, pixelH);
  const ctx = canvas.getContext("2d") as CollageCtx | null;
  if (!ctx) fail("tool.images.errorDecode", "canvas");
  drawCollagePage(ctx, plan, images, style, pageIndex, pages.length);
  return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const option = parseCollageOption(options.collage, files.length);
  const { style, exportFormat, locale } = option;

  if (option.photos.length === 0) {
    post({ type: "error", runId, code: "tool.images.errorNoImages" });
    return;
  }

  /* ---------------- decode + rotate every photo ---------------- */
  post({ type: "progress", runId, pct: 3, stage: "reading", detail: { pages: option.photos.length } });
  // Cell-size decode cap — photos above it are downscaled at decode so
  // the run never holds every full-res bitmap at once (mobile OOM guard).
  const decodeCap = photoDecodeCap(style);
  const images: CollageSource[] = [];
  for (let i = 0; i < option.photos.length; i += 1) {
    const [source, rotation] = option.photos[i];
    images.push(await preparePhoto(files[source], rotation, decodeCap));
    if (i % 3 === 2 || i === option.photos.length - 1) {
      post({
        type: "progress",
        runId,
        pct: 3 + Math.round(((i + 1) / option.photos.length) * 34),
        stage: "reading",
      });
    }
  }

  const pages = computePages(images.length, style.layout);
  const pt = pagePtSize(style);
  const px = pagePixelSize(style);
  const baseName = outputBaseName(locale, exportFormat);

  /* ---------------- JPG / PNG: page 1 only (honest) ---------------- */
  if (exportFormat !== "pdf") {
    post({ type: "progress", runId, pct: 70, stage: "processing" });
    const canvas = new OffscreenCanvas(px.w, px.h);
    const ctx = canvas.getContext("2d") as CollageCtx | null;
    if (!ctx) fail("tool.images.errorDecode", "canvas");
    drawCollagePage(ctx, pages[0], images, style, 0, pages.length);
    const blob = await canvas.convertToBlob({
      type: exportFormat === "png" ? "image/png" : "image/jpeg",
      quality: 0.92,
    });
    post({ type: "progress", runId, pct: 96, stage: "saving" });
    post({
      type: "result",
      runId,
      outputs: [{ name: baseName, mime: blob.type, blob }],
      detail: { files: images.length, pages: 1 },
    });
    return;
  }

  /* ---------------- PDF: one page per collage page ---------------- */
  const pdf = await PDFDocument.create();
  for (let p = 0; p < pages.length; p += 1) {
    const jpeg = await renderPageBlob(images, pages, p, px.w, px.h, style);
    const embedded = await pdf.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
    const page = pdf.addPage([pt.w, pt.h]);
    // Explicit width/height — pdf-lib ignores w/h spreads (P4.4 lesson).
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: pt.w,
      height: pt.h,
    });
    post({
      type: "progress",
      runId,
      pct: 37 + Math.round(((p + 1) / pages.length) * 55),
      stage: "processing",
      detail: { page: p + 1, pages: pages.length },
    });
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  const saved = await pdf.save({ useObjectStreams: true });
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: baseName,
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: images.length, pages: pages.length },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const [code, detail] = message.split("\u0000");
    post({
      type: "error",
      runId: data.runId,
      code: code?.startsWith("tool.") ? code : "tool.errorGeneric",
      detail: detail || undefined,
    });
  });
};
