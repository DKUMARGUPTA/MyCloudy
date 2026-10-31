import { CreateContext } from "@/lib/own/pdf";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { decodePsd, isPsdBytes, PsdDecodeError } from "../raster-decode-common/psd";
import {
  computeImagePlacement,
  encodeRaster,
  type ImageOrientation,
  type ImagePageSize,
} from "../raster-decode-common/render";

/**
 * PSD to PDF worker (P3-c — create-resume protocol):
 *
 *  1. every file's bytes → 8BPS signature check (honest errorUnsupported
 *     otherwise) → OWN pure composite decoder (raw + PackBits RLE, RGB /
 *     Grayscale, alpha channel, PSD v1 + PSB v2 section lengths);
 *  2. artwork with transparency embeds losslessly as PNG; flat RGB
 *     composites embed as JPEG 0.92 (one canvas at a time);
 *  3. one PDF page per file — A4/Letter contain-fit or fit-to-image —
 *     written on the OWN engine with producer "DocoPDF".
 *
 * Honest refusals: signature missing, 16/32-bit depth, non-RGB/Gray
 * colour modes, composites beyond 40 MP — never a fake conversion.
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
      if (!isPsdBytes(raw)) {
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
        raster = decodePsd(raw);
      } catch (error) {
        if (error instanceof PsdDecodeError) {
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
      // Alpha artwork + grayscale design art → PNG; flat RGB photos → JPEG.
      const preferPng = raster.hasAlpha || raster.gray;
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
    doc.setTitle(firstName || "artwork");
    doc.setCreationDate(new Date());

    const outBytes = doc.write();
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${firstName || "artwork"}.pdf`,
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
