import { CreateContext } from "@/lib/own/pdf";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { decodeHeicToBitmap } from "@/lib/heic/heic-decode";
import { isTiffBytes, TiffFile, TiffError } from "../imgconv/tiff";
import {
  JPEG_QUALITY,
  PHOTO_DPI,
  applyBrightnessContrast,
  applyWhiteBackground,
  computeCropRect,
  computeSheetPlan,
  infoLineText,
  parsePassportOption,
  photoOutputName,
  photoPixelSize,
  resolveSize,
  setJpegDpi,
  sheetCellRect,
  sheetOutputName,
  sizeAspect,
} from "./model";

/**
 * Passport photo worker (PRD "Passport photo maker") — device-only.
 * Files arrive by structured clone, every pixel is computed on an
 * OffscreenCanvas by the same model math the live editor previews, and
 * the results go straight back as Blobs. Nothing ever leaves the device.
 *
 * One run delivers BOTH outputs (the result view shows each with its
 * own download button):
 *   1. passport-photo.jpg — the single photo at exactly size×300 DPI
 *      pixels, JPEG 0.92 (the house single re-compression policy), with
 *      a JFIF density tag so print shops see the true DPI.
 *   2. passport-photo-sheet.pdf — the print-ready sheet (4×6 or A4):
 *      the photo embedded ONCE via the own engine's embedJpeg and drawn
 *      at the exact mm→pt cell size N times, thin dashed cut guides
 *      around every copy, and the optional info line in the bottom
 *      margin.
 *
 * Inputs: JPG / PNG / WEBP / GIF decode natively (createImageBitmap),
 * HEIC via Safari's native path with the self-hosted libheif WASM
 * fallback, TIFF via the clean-room first-page reader. SVG needs a
 * main-thread raster and is honestly unsupported here (v1).
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
 * Decodes the photo to a bitmap (the house image route): HEIC tries the
 * native decoder first (Safari) then the self-hosted libheif WASM; TIFF
 * reads its first page; SVG is rejected with the honest unsupported error.
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
      return await createImageBitmap(canvas);
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

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const option = parsePassportOption(options.passport);
  const { style, locale } = option;

  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.images.errorNoImages" });
    return;
  }

  const size = resolveSize(style.sizeId, style.customW, style.customH);
  const pixels = photoPixelSize(size);
  if (pixels.w <= 0 || pixels.h <= 0) {
    fail("tool.images.errorDecode", "size");
  }
  const plan = computeSheetPlan(size, style.sheet, { infoLine: style.infoLine });
  if (plan.copies < 1) {
    // Honest: never shrink a photo to force a fit — ask for a bigger
    // sheet or a smaller size instead.
    fail(
      "pp.errorSheetTooSmall",
      `${Math.round(size.wMM)}x${Math.round(size.hMM)}mm`
    );
  }

  /* ---------------- decode + frame the photo ---------------- */
  post({ type: "progress", runId, pct: 8, stage: "reading" });
  const file = files[0];
  const bitmap = await decodePhoto(file);
  if (bitmap.width <= 0 || bitmap.height <= 0) {
    bitmap.close();
    fail("tool.images.errorDecode", file.name);
  }

  const crop = computeCropRect(
    bitmap.width,
    bitmap.height,
    sizeAspect(size),
    style.zoom,
    style.panX,
    style.panY
  );

  post({ type: "progress", runId, pct: 30, stage: "processing" });
  const canvas = new OffscreenCanvas(pixels.w, pixels.h);
  const ctx = canvas.getContext("2d") as
    | (OffscreenCanvasRenderingContext2D & { canvas: OffscreenCanvas })
    | null;
  if (!ctx) fail("tool.images.errorDecode", "canvas");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  // Flatten over white (passport photos print on white), then the crop.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, pixels.w, pixels.h);
  ctx.drawImage(
    bitmap,
    crop.sx,
    crop.sy,
    crop.sw,
    crop.sh,
    0,
    0,
    pixels.w,
    pixels.h
  );
  bitmap.close();

  // Pixel passes — the SAME pure model functions the preview runs.
  const needsWash = style.background === "white";
  const needsAdjust = style.brightness !== 0 || style.contrast !== 0;
  if (needsWash || needsAdjust) {
    const image = ctx.getImageData(0, 0, pixels.w, pixels.h);
    if (needsWash) {
      applyWhiteBackground(image.data, pixels.w, pixels.h, style.whiteTolerance);
    }
    if (needsAdjust) {
      applyBrightnessContrast(image.data, style.brightness, style.contrast);
    }
    ctx.putImageData(image, 0, 0);
  }

  post({ type: "progress", runId, pct: 55, stage: "processing" });
  const jpegBlob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: JPEG_QUALITY,
  });
  const jpegBytes = setJpegDpi(
    new Uint8Array(await jpegBlob.arrayBuffer()),
    PHOTO_DPI
  );

  /* ---------------- the print sheet PDF ---------------- */
  post({ type: "progress", runId, pct: 70, stage: "processing" });
  const pdf = CreateContext.create();
  // Embed ONCE, draw N times — the shared XObject keeps the file lean.
  const embedded = pdf.embedJpeg(jpegBytes);
  const page = pdf.addPage(plan.pageW, plan.pageH);
  page.drawRectangle({
    x: 0,
    y: 0,
    width: plan.pageW,
    height: plan.pageH,
    color: { r: 1, g: 1, b: 1 },
  });

  const gray = { r: 0.62, g: 0.62, b: 0.62 };
  for (let row = 0; row < plan.rows; row += 1) {
    for (let col = 0; col < plan.cols; col += 1) {
      const cell = sheetCellRect(plan, row, col);
      // Top-left origin → PDF bottom-left flip.
      const x = cell.x;
      const y = plan.pageH - cell.y - cell.h;
      page.drawImage(embedded, {
        x,
        y,
        width: cell.w,
        height: cell.h,
      });
      if (style.cutGuides) {
        // Thin dashed gray rectangle — the cut line (borderDashArray:
        // engine CreateRectOptions takes the pdf-lib border-prefixed dash
        // option verbatim).
        page.drawRectangle({
          x,
          y,
          width: cell.w,
          height: cell.h,
          borderColor: gray,
          borderWidth: 0.5,
          borderDashArray: [2, 2],
        });
      }
    }
  }

  if (plan.infoLine) {
    const font = "helvetica" as const;
    const text = infoLineText(size, plan);
    const fontSize = 7;
    const textW = pdf.measure(text, font, fontSize);
    page.drawText({
      text,
      x: Math.max(2, (plan.pageW - textW) / 2),
      y: 5,
      size: fontSize,
      font,
      color: { r: 0.47, g: 0.45, b: 0.44 },
    });
  }

  post({ type: "progress", runId, pct: 94, stage: "saving" });
  // R44 branding — metadata only; the document stays clean.
  pdf.setProducer("DocoPDF");
  pdf.setCreator("DocoPDF");
  pdf.setTitle(sheetOutputName(locale).replace(/\.pdf$/i, ""));
  pdf.setCreationDate(new Date());
  const saved = pdf.write();
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: photoOutputName(locale),
        mime: "image/jpeg",
        blob: new Blob([jpegBytes as unknown as BlobPart], { type: "image/jpeg" }),
      },
      {
        name: sheetOutputName(locale),
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: {
      files: 1,
      pages: 1,
      copies: plan.copies,
    },
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
      code: code?.startsWith("tool.") || code?.startsWith("pp.") ? code : "tool.errorGeneric",
      detail: detail || undefined,
    });
  });
};
