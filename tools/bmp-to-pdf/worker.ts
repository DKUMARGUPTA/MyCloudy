import { CreateContext } from "@/lib/own/pdf";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  BmpDecodeError,
  decodeBmp,
  isBmpBytes,
} from "../raster-decode-common/bmp";
import {
  computeImagePlacement,
  encodeRaster,
  type ImageOrientation,
  type ImagePageSize,
} from "../raster-decode-common/render";

/**
 * BMP to PDF worker (P3-c — create-resume protocol):
 *
 *  1. every file's bytes → BM signature check (honest errorUnsupported
 *     for anything else) → OWN pure decoder (headers CORE→V5, BI_RGB /
 *     RLE8 / RLE4 / BITFIELDS, 1–32-bit, both row orders);
 *  2. palette rasters (≤ 8-bit) and rasters with transparency embed
 *     losslessly as PNG; 24-bit photo rasters embed as JPEG 0.92 over
 *     white (the imagegrid recipe, one canvas at a time);
 *  3. one PDF page per file — A4/Letter contain-fit or fit-to-image,
 *     margins honoured — written on the OWN engine with producer
 *     "DocoPDF" and the first file's base name.
 *
 * Honest refusals: BM signature missing, decoder corruption/unsupported
 * features (mapped to errorDecode / errorUnsupported), images beyond
 * 40 MP (errorImageTooLarge).
 */

function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
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
      const v = String(request.options.pageSize ?? "a4");
      return v === "fit" || v === "letter" ? (v as ImagePageSize) : "a4";
    })();
    const orientation: ImageOrientation = (() => {
      const v = String(request.options.orientation ?? "auto");
      return v === "portrait" || v === "landscape" ? (v as ImageOrientation) : "auto";
    })();
    const margin = String(request.options.margin ?? "small");

    const doc = CreateContext.create();
    let firstName = "";
    let pages = 0;

    for (let i = 0; i < request.files.length; i += 1) {
      const file = request.files[i]!;
      const raw = new Uint8Array(await file.arrayBuffer());
      if (!isBmpBytes(raw)) {
        post({
          type: "error",
          runId,
          code: "tool.errorUnsupported",
          detail: file.name,
        });
        return;
      }
      let raster;
      try {
        raster = decodeBmp(raw);
      } catch (error) {
        if (error instanceof BmpDecodeError) {
          post({
            type: "error",
            runId,
            code:
              error.code === "too-large"
                ? "tool.errorInputTooLarge"
                : error.code === "unsupported"
                  ? "tool.errorUnsupported"
                  : "tool.errorDecode",
            detail:
              error.code === "too-large"
                ? `${file.name} is over 40 megapixels`
                : file.name,
          });
          return;
        }
        throw error;
      }
      // ≤ 8-bit = palette art → PNG; 24-bit photos → JPEG; alpha → PNG.
      const preferPng = raster.hasAlpha || (raster.depth ?? 24) <= 8;
      const prepared = await encodeRaster(raster, preferPng);
      const image =
        prepared.kind === "jpeg"
          ? doc.embedJpeg(prepared.bytes)
          : doc.embedPng(prepared.bytes);
      const place = computeImagePlacement(
        prepared.width,
        prepared.height,
        { pageSize, orientation, margin },
      );
      const page = doc.addPage(place.pageW, place.pageH);
      page.drawImage(image, {
        x: place.x,
        y: place.y,
        width: place.w,
        height: place.h,
      });
      pages += 1;
      if (firstName === "") firstName = baseName(file.name);
      post({
        type: "progress",
        runId,
        pct: 10 + Math.round(((i + 1) / request.files.length) * 78),
        stage: "processing",
      });
    }

    post({ type: "progress", runId, pct: 92, stage: "saving" });

    doc.setProducer("DocoPDF");
    doc.setCreator("DocoPDF");
    doc.setTitle(firstName || "bitmaps");
    doc.setCreationDate(new Date());

    const outBytes = doc.write();
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${firstName || "bitmaps"}.pdf`,
          mime: "application/pdf",
          blob: new Blob([outBytes as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: {
        files: request.files.length,
        pages,
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
