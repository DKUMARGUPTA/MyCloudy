import { CreateContext, type CreateImage } from "@/lib/own/pdf";
import { unzipSync } from "@/lib/own/zip";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { BmpDecodeError, decodeBmp, isBmpBytes } from "../raster-decode-common/bmp";
import { decodePsd, isPsdBytes, PsdDecodeError } from "../raster-decode-common/psd";
import {
  computeImagePlacement,
  encodeRaster,
  type ImagePageSize,
} from "../raster-decode-common/render";
import { filterAndSortImageEntries } from "./worker-lib";

/**
 * CBZ to PDF worker (P3-c — create-resume protocol):
 *
 *  1. the archive's bytes → OWN zip engine (unzipSync — a non-ZIP
 *     container throws and is refused honestly as errorNotArchive);
 *  2. entries filtered to images (junk like __MACOSX/.DS_Store skipped)
 *     and sorted in NATURAL page order — "page-2" before "page-10";
 *  3. per page: JPG embeds byte-for-byte (DCT passthrough), PNG embeds
 *     decoded-then-rebuilt, BMP/PSD decode with the OWN pure decoders,
 *     GIF/WEBP/AVIF through the browser's bitmap decoder — one canvas
 *     alive at a time, one PDF page per comic page;
 *  4. guards: ≤ 3,000 pages and ≤ 600 MB uncompressed image data,
 *     both refused honestly (errorNotArchive / errorImageTooLarge).
 */

const MAX_PAGES = 3000;
const MAX_UNCOMPRESSED = 600 * 1024 * 1024;

function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function extOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

/** PNG IHDR dimensions (bytes 16..24, big-endian). */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Browser-decoded formats → lossless PNG through the canvas. */
async function bitmapToPng(
  bytes: Uint8Array,
  mime: string,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const bitmap = await createImageBitmap(
    new Blob([bytes as unknown as BlobPart], { type: mime }),
  );
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    width: bitmap.width,
    height: bitmap.height,
  };
}

async function run(request: WorkerRunRequest): Promise<void> {
  const runId = request.runId;
  const post = (msg: WorkerResponse): void => {
    (self as unknown as Worker).postMessage(msg);
  };
  try {
    if (request.files.length === 0) {
      post({ type: "error", runId, code: "tool.errorNoFile" });
      return;
    }

    const pageSize: ImagePageSize = (() => {
      const v = String(request.options.pageSize ?? "fit");
      return v === "a4" || v === "letter" ? (v as ImagePageSize) : "fit";
    })();
    const margin = String(request.options.margin ?? "none");

    const file = request.files[0]!;
    const raw = new Uint8Array(await file.arrayBuffer());

    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(raw);
    } catch {
      post({ type: "error", runId, code: "tool.errorNotArchive", detail: file.name });
      return;
    }

    const pagePaths = filterAndSortImageEntries(Object.keys(entries));
    if (pagePaths.length === 0) {
      post({ type: "error", runId, code: "tool.errorNotArchive", detail: file.name });
      return;
    }
    if (pagePaths.length > MAX_PAGES) {
      post({
        type: "error",
        runId,
        code: "tool.errorInputTooLarge",
        detail: `${pagePaths.length} pages (max ${MAX_PAGES})`,
      });
      return;
    }
    let totalBytes = 0;
    for (const path of pagePaths) totalBytes += entries[path]!.byteLength;
    if (totalBytes > MAX_UNCOMPRESSED) {
      post({
        type: "error",
        runId,
        code: "tool.errorInputTooLarge",
        detail: `${Math.round(totalBytes / 1024 / 1024)} MB uncompressed (max 600 MB)`,
      });
      return;
    }

    const doc = CreateContext.create();

    for (let i = 0; i < pagePaths.length; i += 1) {
      const path = pagePaths[i]!;
      const bytes = entries[path]!;
      const ext = extOf(path);
      let image: CreateImage;
      if (ext === ".jpg" || ext === ".jpeg") {
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
          post({ type: "error", runId, code: "tool.errorDecode", detail: path });
          return;
        }
        image = doc.embedJpeg(bytes);
      } else if (ext === ".png") {
        const size = pngSize(bytes);
        if (!size || bytes[0] !== 0x89) {
          post({ type: "error", runId, code: "tool.errorDecode", detail: path });
          return;
        }
        image = doc.embedPng(bytes);
      } else if (ext === ".bmp") {
        if (!isBmpBytes(bytes)) {
          post({ type: "error", runId, code: "tool.errorDecode", detail: path });
          return;
        }
        try {
          const raster = decodeBmp(bytes);
          const prepared = await encodeRaster(
            raster,
            raster.hasAlpha || (raster.depth ?? 24) <= 8,
          );
          image =
            prepared.kind === "jpeg"
              ? doc.embedJpeg(prepared.bytes)
              : doc.embedPng(prepared.bytes);
        } catch (error) {
          if (error instanceof BmpDecodeError) {
            post({ type: "error", runId, code: "tool.errorDecode", detail: path });
            return;
          }
          throw error;
        }
      } else if (ext === ".psd") {
        if (!isPsdBytes(bytes)) {
          post({ type: "error", runId, code: "tool.errorDecode", detail: path });
          return;
        }
        try {
          const raster = decodePsd(bytes);
          const prepared = await encodeRaster(raster, raster.hasAlpha || raster.gray);
          image =
            prepared.kind === "jpeg"
              ? doc.embedJpeg(prepared.bytes)
              : doc.embedPng(prepared.bytes);
        } catch (error) {
          if (error instanceof PsdDecodeError) {
            post({ type: "error", runId, code: "tool.errorDecode", detail: path });
            return;
          }
          throw error;
        }
      } else {
        // gif / webp / avif — browser bitmap decoder → PNG
        try {
          const png = await bitmapToPng(bytes, `image/${ext.slice(1)}`);
          image = doc.embedPng(png.bytes);
        } catch {
          post({ type: "error", runId, code: "tool.errorDecode", detail: path });
          return;
        }
      }
      const place = computeImagePlacement(image.width, image.height, {
        pageSize,
        orientation: "auto",
        margin,
      });
      const page = doc.addPage(place.pageW, place.pageH);
      page.drawImage(image, {
        x: place.x,
        y: place.y,
        width: place.w,
        height: place.h,
      });
      post({
        type: "progress",
        runId,
        pct: 8 + Math.round(((i + 1) / pagePaths.length) * 84),
        stage: "processing",
        detail: { page: i + 1, pages: pagePaths.length },
      });
    }

    post({ type: "progress", runId, pct: 95, stage: "saving" });

    const title = baseName(file.name);
    doc.setProducer("DocoPDF");
    doc.setCreator("DocoPDF");
    doc.setTitle(title);
    doc.setCreationDate(new Date());

    const outBytes = doc.write();
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${title}.pdf`,
          mime: "application/pdf",
          blob: new Blob([outBytes as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: {
        files: 1,
        pages: pagePaths.length,
        images: pagePaths.length,
      },
    });
  } catch (error) {
    post({
      type: "error",
      runId,
      code: "tool.errorGeneric",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  if (event.data?.type === "run") void run(event.data);
};
