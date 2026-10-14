/**
 * Scan capture worker (Scan to PDF, PRD §8.5) — receives the full-res
 * captured frame as a transferred ImageBitmap plus the confirmed quad,
 * runs perspective correction + the chosen scanner filter off the main
 * thread, and returns a JPEG the images→PDF worker embeds byte-for-byte.
 *
 * Message contract (both directions plain structured clone):
 *   in : { type: "scan", runId, bitmap, quad, filter, quality, name }
 *   out: { type: "done", runId, blob } | { type: "error", runId, code }
 */

import type { Point } from "./detect";
import { warpAndFilter, type ScanFilter } from "./warp";

interface ScanRequest {
  type: "scan";
  runId: number;
  bitmap: ImageBitmap;
  quad: [Point, Point, Point, Point];
  filter: ScanFilter;
  quality: number;
}

interface ScanDone {
  type: "done";
  runId: number;
  blob: Blob;
  width: number;
  height: number;
}

interface ScanError {
  type: "error";
  runId: number;
  code: string;
}

type ScanResponse = ScanDone | ScanError;

function post(response: ScanResponse): void {
  self.postMessage(response);
}

self.onmessage = (event: MessageEvent<ScanRequest>) => {
  const data = event.data;
  if (data?.type !== "scan") return;
  const { runId, bitmap, quad, filter, quality } = data;
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      post({ type: "error", runId, code: "tool.scan.errorCanvas" });
      return;
    }
    ctx.drawImage(bitmap, 0, 0);
    const w = bitmap.width;
    const h = bitmap.height;
    bitmap.close();
    const frame = ctx.getImageData(0, 0, w, h);
    const warped = warpAndFilter(
      frame.data,
      w,
      h,
      [quad[0], quad[1], quad[2], quad[3]],
      filter
    );
    const out = new OffscreenCanvas(warped.width, warped.height);
    const outCtx = out.getContext("2d");
    if (!outCtx) {
      post({ type: "error", runId, code: "tool.scan.errorCanvas" });
      return;
    }
    const imgData = outCtx.createImageData(warped.width, warped.height);
    imgData.data.set(warped.data);
    outCtx.putImageData(imgData, 0, 0);
    void out
      .convertToBlob({
        type: "image/jpeg",
        quality: Math.min(0.98, Math.max(0.5, quality)),
      })
      .then((blob) => {
        post({ type: "done", runId, blob, width: warped.width, height: warped.height });
      })
      .catch(() => {
        post({ type: "error", runId, code: "tool.scan.errorWarp" });
      });
  } catch {
    post({ type: "error", runId, code: "tool.scan.errorWarp" });
  }
};
