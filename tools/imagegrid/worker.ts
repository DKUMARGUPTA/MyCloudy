import {
  CreateContext,
  type CreateImage,
  type CreatePage,
} from "@/lib/own/pdf";

import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import type { OptionValues } from "@/lib/tools/config-types";
import { parseImageGridOption } from "./model";
import { decodeHeicToBitmap } from "@/lib/heic/heic-decode";
import { readJpegOrientation } from "@/lib/images/jpeg-exif";
import { isTiffBytes, TiffFile, TiffError } from "../imgconv/tiff";

/**
 * Images → PDF worker (PRD §8.6) — shared by images-to-pdf and its
 * jpg/png/webp/heic/tiff/svg-to-pdf presets. Device-only: files arrive by
 * structured clone, OUR engine (CreateContext, P6-i) embeds them, the PDF
 * Blob goes straight back. Zero pdf-lib in the shipped path.
 *
 * Quality policy (honest, no silent re-compression):
 * - unrotated JPG/PNG (and unrotated SVG rasters) — and JPGs whose EXIF
 *   orientation is 1 or missing — → the ORIGINAL bytes are embedded
 *   (zero quality loss); EXIF-rotated JPGs (≠ 1) bake the rotation first
 *   so the page and the pixels agree (no sideways/distorted output)
 * - rotated images, or WEBP/GIF/HEIC/TIFF sources → decoded (createImageBitmap,
 *   self-hosted libheif WASM as the HEIC fallback so Chromium works too, and
 *   the clean-room TIFF reader tools/imgconv/tiff.ts for scans/faxes), drawn
 *   (rotated) onto an OffscreenCanvas and re-encoded (JPEG 0.92 for photos,
 *   PNG when the source may carry alpha)
 *
 * TIFF (tiff-to-pdf preset): every page of a multi-page IFD chain becomes a
 * PDF page in order (the "pages" option picks ranges per file), decoded one
 * page at a time so a 100-page fax never spikes memory. "Fit to image" uses
 * the scan's own DPI — a 300-DPI A4 scan lands at exactly A4.
 *
 * SVG (svg-to-pdf preset): workers cannot rasterise SVG (Chrome/Firefox
 * reject SVG blobs in createImageBitmap), so the surface rasterises each
 * SVG on the main thread while its card preview loads and hands the PNGs
 * over as run assets, in workspace file order. This worker pairs the k-th
 * SVG file with the k-th asset. The raster's CSS px map to PDF pt at 96 DPI.
 */

const A4: [number, number] = [595.28, 841.89];
const LETTER: [number, number] = [612, 792];
const MARGIN_PT: Record<string, number> = { none: 0, small: 18, big: 54 };
const BG_RGB: Record<string, [number, number, number]> = {
  white: [1, 1, 1],
  soft: [0.96, 0.955, 0.94],
  dark: [0.09, 0.09, 0.11],
};

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

/** PNG IHDR dimensions — no decode needed (bytes 16..24, big-endian). */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

interface PreparedImage {
  /** pdf-lib embed call to use. */
  kind: "jpeg" | "png";
  bytes: Uint8Array;
  width: number;
  height: number;
  /**
   * Display size in PDF points for "fit" pages: px as-is for regular
   * images, px × 72/dpi for TIFF scans (their own DPI is the truth),
   * px × 0.75 for SVG rasters (CSS px are 96 DPI).
   */
  ptW: number;
  ptH: number;
}

/**
 * Encodes one RGBA raster (TIFF page) applying the entry's quarter-turn
 * rotation in the same pass. Bilevel/palette pages (preferPng) keep PNG
 * crispness; everything else embeds as JPEG 0.92 over white.
 */
async function encodeRgbaPage(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  rotation: number,
  preferPng: boolean,
  onError: (code: string, detail: string) => never
): Promise<PreparedImage> {
  const source = new OffscreenCanvas(width, height);
  const sourceCtx = source.getContext("2d");
  if (!sourceCtx) onError("tool.images.errorDecode", "canvas");
  sourceCtx.putImageData(
    new ImageData(rgba, width, height) as unknown as ImageData,
    0,
    0
  );

  const swap = rotation === 90 || rotation === 270;
  const outW = swap ? height : width;
  const outH = swap ? width : height;
  const target = new OffscreenCanvas(outW, outH);
  const targetCtx = target.getContext("2d");
  if (!targetCtx) onError("tool.images.errorDecode", "canvas");
  if (!preferPng) {
    targetCtx.fillStyle = "#ffffff";
    targetCtx.fillRect(0, 0, outW, outH);
  }
  targetCtx.translate(outW / 2, outH / 2);
  targetCtx.rotate((rotation * Math.PI) / 180);
  targetCtx.drawImage(source, -width / 2, -height / 2);

  const blob = await target.convertToBlob({
    type: preferPng ? "image/png" : "image/jpeg",
    quality: preferPng ? undefined : 0.92,
  });
  return {
    kind: preferPng ? "png" : "jpeg",
    bytes: new Uint8Array(await blob.arrayBuffer()),
    width: outW,
    height: outH,
    ptW: outW,
    ptH: outH,
  };
}

/**
 * Decodes (when needed), rotates and encodes one image. `reuseBitmap`
 * avoids decoding twice for transcode/rotate paths.
 */
async function prepareImage(
  file: File,
  rotation: number,
  onError: (code: string, detail: string) => never
): Promise<PreparedImage> {
  const raw = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImageKind(raw.slice(0, 16));
  const rotated = rotation !== 0;

  // Fast path: original bytes, untouched. JPEGs with an EXIF
  // orientation ≠ 1 (most portrait phone photos) are excluded: their
  // stored pixels are unrotated while every dimension probe sees the
  // oriented bitmap — embedding the raw bytes into an oriented-shaped
  // page draws them sideways AND distorted. Those route through the
  // decode path, where imageOrientation "from-image" bakes the EXIF
  // rotation into the re-encoded bitmap.
  if (!rotated && (kind === "jpeg" || kind === "png")) {
    const orientation = kind === "jpeg" ? readJpegOrientation(raw) : 1;
    if (orientation === 1) {
      const size =
        kind === "png"
          ? pngSize(raw)
          : await bitmapSize(file, onError).catch(() => null);
      if (size) {
        return {
          kind,
          bytes: raw,
          width: size.width,
          height: size.height,
          ptW: size.width,
          ptH: size.height,
        };
      }
    }
  }

  if (kind === "unknown") {
    onError("tool.images.errorUnsupported", file.name);
  }

  // Decode path (rotation, transcode, or EXIF orientation ≠ 1).
  // "from-image" applies EXIF orientation — the decoded bitmap is
  // upright and its width/height are the DISPLAYED (oriented) ones.
  // HEIC: native decode first (Safari), then the self-hosted libheif
  // WASM so Chromium/Edge/Firefox work too — the honest error only
  // fires when both fail.
  let bitmap: ImageBitmap;
  if (kind === "heic") {
    bitmap = await decodeHeicWithFallback(file, raw, onError);
  } else {
    try {
      bitmap = await createImageBitmap(
        kind === "jpeg" || kind === "png"
          ? new Blob([raw as unknown as BlobPart], { type: `image/${kind}` })
          : file,
        { imageOrientation: "from-image" }
      );
    } catch {
      onError("tool.images.errorDecode", file.name);
    }
  }

  try {
    const swap = rotation === 90 || rotation === 270;
    const width = swap ? bitmap.height : bitmap.width;
    const height = swap ? bitmap.width : bitmap.height;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) onError("tool.images.errorDecode", file.name);

    if (kind !== "jpeg" && kind !== "heic") {
      // Sources that may carry alpha → PNG keeps it.
      context.fillStyle = "rgba(0,0,0,0)";
    } else {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
    }
    context.translate(width / 2, height / 2);
    context.rotate((rotation * Math.PI) / 180);
    context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);

    const outKind: "jpeg" | "png" =
      kind === "jpeg" || kind === "heic" ? "jpeg" : "png";
    const blob = await canvas.convertToBlob({
      type: outKind === "jpeg" ? "image/jpeg" : "image/png",
      quality: 0.92,
    });
    return {
      kind: outKind,
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width,
      height,
      ptW: width,
      ptH: height,
    };
  } finally {
    bitmap.close();
  }
}

/** Prepares an already-rasterised PNG (the SVG asset) for embedding. */
async function preparePngRaster(
  raster: File,
  rotation: number,
  onError: (code: string, detail: string) => never,
  natural?: { w: number; h: number }
): Promise<PreparedImage> {
  const raw = new Uint8Array(await raster.arrayBuffer());
  const size = pngSize(raw);
  if (size) {
    // "Fit" pages follow the graphic's own CSS size when the manifest
    // carried it; otherwise the raster's px (both are 96 DPI → pt × 0.75).
    const fitW = (natural?.w ?? size.width) * 0.75;
    const fitH = (natural?.h ?? size.height) * 0.75;
    // Unrotated → embed the raster bytes exactly as rasterised.
    if (rotation === 0) {
      return {
        kind: "png",
        bytes: raw,
        width: size.width,
        height: size.height,
        ptW: fitW,
        ptH: fitH,
      };
    }
    // Rotated → same fast path with swapped fit dims.
    return {
      kind: "png",
      bytes: raw,
      width: size.width,
      height: size.height,
      ptW: fitH,
      ptH: fitW,
    };
  }
  // Rasters are written by our own canvas.toBlob — IHDR is always there.
  // Defensive fallback: decode + rotate through the canvas path.
  return rotatePngBytes(raw, rotation, raster.name, onError);
}

async function rotatePngBytes(
  raw: Uint8Array,
  rotation: number,
  name: string,
  onError: (code: string, detail: string) => never
): Promise<PreparedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(
      new Blob([raw as unknown as BlobPart], { type: "image/png" })
    );
  } catch {
    onError("tool.images.errorDecode", name);
  }
  try {
    const swap = rotation === 90 || rotation === 270;
    const width = swap ? bitmap.height : bitmap.width;
    const height = swap ? bitmap.width : bitmap.height;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) onError("tool.images.errorDecode", name);
    context.fillStyle = "rgba(0,0,0,0)";
    context.translate(width / 2, height / 2);
    context.rotate((rotation * Math.PI) / 180);
    context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return {
      kind: "png",
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width,
      height,
      ptW: width * 0.75,
      ptH: height * 0.75,
    };
  } finally {
    bitmap.close();
  }
}

async function bitmapSize(
  file: File,
  onError: (code: string, detail: string) => never
): Promise<{ width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    onError("tool.images.errorDecode", file.name);
  }
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/**
 * HEIC decode: try the browser's native decoder first (Safari — fast,
 * zero download), fall back to the self-hosted libheif WASM build that
 * works in every browser (src/lib/heic/heic-decode.ts).
 */
async function decodeHeicWithFallback(
  file: File,
  raw: Uint8Array,
  onError: (code: string, detail: string) => never
): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    // Chromium/Firefox: native HEIC decode is unavailable — use libheif.
  }
  try {
    return await decodeHeicToBitmap(raw);
  } catch {
    onError("tool.images.errorHeicDecode", file.name);
  }
}

/** Contain-fit `image` into a cell, centered. */
function fitInto(
  image: { width: number; height: number },
  cell: { x: number; y: number; w: number; h: number }
): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(cell.w / image.width, cell.h / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  return { x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h };
}

/** Maps a TiffError to the honest i18n code (detail = file name). */
function tiffErrorCode(error: TiffError): string {
  if (error.kind === "tiff-corrupt") return "tool.images.errorTiffCorrupt";
  if (error.kind === "tiff-too-large") return "tool.images.errorTiffTooLarge";
  return "tool.images.errorTiffUnsupported";
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files, assets } = request;
  type WorkerEntry = { source: number; rotation: number };
  const entries: WorkerEntry[] =
    parseImageGridOption(options.images, files.length) ??
    Array.from({ length: files.length }, (_, source) => ({ source, rotation: 0 }));

  if (entries.length === 0) {
    post({ type: "error", runId, code: "tool.images.errorNoImages" });
    return;
  }

  const fail = (code: string, detail: string): never => {
    throw new Error(`${code}\u0000${detail}`);
  };

  const pageSize = String(options.pageSize ?? "a4");
  const orientation = String(options.orientation ?? "auto");
  const margin = MARGIN_PT[String(options.margin ?? "small")] ?? 18;
  const twoUp = String(options.layout ?? "one") === "two";
  const background = BG_RGB[String(options.background ?? "white")] ?? BG_RGB.white;
  const pageNumbers = options.pageNumbers === true;
  const pagesSpec = String(options.pages ?? "all");

  /* ---------------- file classification (bytes, once) ---------------- */

  // TIFF files keep their parsed TiffFile (on-demand page decode); SVG
  // files pair with raster assets by workspace order (see svg-raster.ts).
  // The SVG asset list ends with a svg-dims.json manifest carrying each
  // graphic's natural CSS size — "fit" pages follow the graphic's own
  // size, never the upscaled raster's.
  const tiffByFile = new Map<number, TiffFile>();
  const tiffPagesByFile = new Map<number, number[]>();
  const svgAssetByFile = new Map<number, File>();
  const svgNaturalByFile = new Map<number, { w: number; h: number }>();
  {
    // Pop the manifest (last asset) first when present — its entries are
    // aligned with the raster assets (k-th SVG file ↔ k-th of each).
    let svgAssets = assets ?? [];
    const naturalList: Array<{ w: number; h: number }> = [];
    if (
      svgAssets.length > 0 &&
      svgAssets[svgAssets.length - 1].name === "svg-dims.json"
    ) {
      const manifest = svgAssets[svgAssets.length - 1];
      svgAssets = svgAssets.slice(0, -1);
      try {
        const parsed = JSON.parse(await manifest.text()) as unknown;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (
              item &&
              typeof item === "object" &&
              Number.isFinite((item as { w?: unknown }).w) &&
              Number.isFinite((item as { h?: unknown }).h)
            ) {
              const { w, h } = item as { w: number; h: number };
              if (w > 0 && h > 0) {
                naturalList.push({ w, h });
              }
            }
          }
        }
      } catch {
        // Unreadable manifest — fit falls back to raster px (96 DPI).
      }
    }
    let assetIndex = 0;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
      const isSvg =
        file.type === "image/svg+xml" ||
        /\.svg$/i.test(file.name) ||
        isSvgBytes(head);
      if (isSvg) {
        svgAssetByFile.set(index, svgAssets[assetIndex] ?? fail("tool.images.errorSvgRaster", file.name));
        const natural = naturalList[assetIndex];
        if (natural) svgNaturalByFile.set(index, natural);
        assetIndex += 1;
        continue;
      }
      if (isTiffBytes(head)) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const tiff = TiffFile.parse(bytes);
          const wanted = parsePageSpec(pagesSpec, tiff.pageCount);
          if (wanted === null || wanted.length === 0) {
            post({ type: "error", runId, code: "tool.errorInvalidPages" });
            return;
          }
          tiffByFile.set(index, tiff);
          tiffPagesByFile.set(index, wanted);
        } catch (error) {
          if (error instanceof TiffError) {
            fail(tiffErrorCode(error), file.name);
          }
          throw error;
        }
      }
    }
  }

  /* ---------------- expand multi-page TIFF entries ---------------- */

  // A TIFF entry becomes one expanded item per wanted page (so the two-up
  // grid, fit sizing and progress all count real pages); every other entry
  // stays a single item.
  interface ExpandedItem {
    source: number;
    rotation: number;
    tiffPage: number | null;
  }
  const expanded: ExpandedItem[] = [];
  for (const entry of entries) {
    const tiffPages = tiffPagesByFile.get(entry.source);
    if (tiffPages) {
      for (const page of tiffPages) {
        expanded.push({ ...entry, tiffPage: page });
      }
    } else {
      expanded.push({ ...entry, tiffPage: null });
    }
  }

  const ctx = CreateContext.create();
  const created: CreatePage[] = [];

  const groups: ExpandedItem[][] = [];
  if (twoUp) {
    for (let i = 0; i < expanded.length; i += 2) {
      groups.push(expanded.slice(i, i + 2));
    }
  } else {
    groups.push(...expanded.map((item) => [item]));
  }

  for (let g = 0; g < groups.length; g += 1) {
    const group = groups[g];
    const prepared: PreparedImage[] = [];
    for (const item of group) {
      if (item.tiffPage !== null) {
        // TIFF page: on-demand decode (one page in memory at a time),
        // rotation + honest preferPng encode in one pass.
        const tiff = tiffByFile.get(item.source)!;
        const page = tiff.decodePage(item.tiffPage);
        const ptPerPx = page.dpi && page.dpi > 0 ? 72 / page.dpi : 1;
        // Orientation 5-8 are already swapped by the reader; rotation then
        // swaps again — encodeRgbaPage reports the final dims.
        prepared.push(
          await encodeRgbaPage(
            page.rgba,
            page.width,
            page.height,
            item.rotation,
            page.preferPng,
            fail
          ).then((image) => ({
            ...image,
            ptW: image.width * ptPerPx,
            ptH: image.height * ptPerPx,
          }))
        );
      } else if (svgAssetByFile.has(item.source)) {
        const raster = svgAssetByFile.get(item.source)!;
        prepared.push(
          await preparePngRaster(raster, item.rotation, fail, svgNaturalByFile.get(item.source))
        );
      } else {
        prepared.push(
          await prepareImage(files[item.source], item.rotation, fail)
        );
      }
    }

    // Page size: fixed (A4/Letter, orientation-forced or auto) or fitted.
    let pageW: number;
    let pageH: number;
    if (pageSize === "fit") {
      pageW = Math.max(...prepared.map((p) => p.ptW)) + margin * 2;
      pageH = Math.max(...prepared.map((p) => p.ptH)) + margin * 2;
    } else {
      const base = pageSize === "letter" ? LETTER : A4;
      const widest = Math.max(...prepared.map((p) => p.ptW));
      const tallest = Math.max(...prepared.map((p) => p.ptH));
      const landscape =
        orientation === "landscape" ||
        (orientation === "auto" && widest > tallest);
      pageW = landscape ? base[1] : base[0];
      pageH = landscape ? base[0] : base[1];
    }

    const page = ctx.addPage(pageW, pageH);
    created.push(page);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: pageW,
      height: pageH,
      color: {
        r: background[0],
        g: background[1],
        b: background[2],
      },
    });

    // Embed the ORIGINAL bytes (JPEG = DCT passthrough, PNG = decoded
    // DeviceRGB/SMask flate) — zero quality loss, exactly like pdf-lib's
    // embedJpg/embedPng did.
    const embed = (image: PreparedImage): CreateImage =>
      image.kind === "jpeg"
        ? ctx.embedJpeg(image.bytes)
        : ctx.embedPng(image.bytes);

    if (twoUp && prepared.length === 2) {
      const cellW = (pageW - margin * 3) / 2;
      const cellH = pageH - margin * 2;
      for (let i = 0; i < prepared.length; i += 1) {
        const cell = {
          x: margin + i * (cellW + margin),
          y: margin,
          w: cellW,
          h: cellH,
        };
        const box = fitInto(prepared[i], cell);
        const img = embed(prepared[i]);
        // width/height are explicit — w/h from fitInto would otherwise draw
        // the image at its native pixel size (the P4.4 rule, kept).
        page.drawImage(img, {
          x: box.x,
          y: box.y,
          width: box.w,
          height: box.h,
        });
      }
    } else {
      const cell = { x: margin, y: margin, w: pageW - margin * 2, h: pageH - margin * 2 };
      const box = fitInto(prepared[0], cell);
      const img = embed(prepared[0]);
      page.drawImage(img, {
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
      });
    }

    post({
      type: "progress",
      runId,
      pct: Math.round(((g + 1) / groups.length) * 92),
      stage: "processing",
      detail: { page: g + 1, pages: groups.length },
    });
  }

  if (pageNumbers) {
    const total = ctx.pageCount;
    for (let i = 0; i < created.length; i += 1) {
      const label = `${i + 1} / ${total}`;
      const size = ctx.measure(label, "helvetica", 9);
      created[i].drawText({
        x: (created[i].width - size) / 2,
        y: 14,
        text: label,
        size: 9,
        font: "helvetica",
        color: { r: 0.45, g: 0.45, b: 0.5 },
      });
    }
  }

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  const saved = ctx.write();
  const base = files[entries[0].source].name.replace(/\.[^.]+$/, "") || "images";
  const safeBase = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "images";

  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${safeBase}.pdf`,
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: {
      files: 1,
      pages: groups.length,
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
      code: code?.startsWith("tool.") ? code : "tool.errorCorrupt",
      detail: detail || undefined,
    });
  });
};
