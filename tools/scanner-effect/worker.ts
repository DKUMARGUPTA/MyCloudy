/**
 * Scanner Effect — thin worker over the raster-color core: every
 * rendered page's pixels go through the scanner transform (greyscale →
 * contrast crunch → sensor noise → optional cream tint, transforms.ts
 * scannerPixels) and the page is rebuilt. The core owns rendering, the
 * pixel-budget clamp, progress and error mapping.
 */
import type { WorkerRunRequest } from "@/lib/workers/protocol";
import {
  SCANNER_NOISE,
  scannerPixels,
  type ScannerTint,
} from "../raster-color-common/transforms";
import {
  postRasterColorError,
  runRasterColor,
} from "../raster-color-common/worker-core";

/** The scan look's contrast crunch — locked by smoke-r51. */
export const SCANNER_CONTRAST = 1.15;

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  runRasterColor(data, {
    outputSuffix: "-scanned",
    defaultQuality: 75,
    transformFor: (options) => {
      const preset = String(options.intensity ?? "medium");
      const noise =
        preset === "light" || preset === "heavy"
          ? SCANNER_NOISE[preset]
          : SCANNER_NOISE.medium;
      const tint: ScannerTint =
        String(options.tint ?? "none") === "cream" ? "cream" : "none";
      return (rgba) =>
        scannerPixels(rgba, {
          noise,
          contrast: SCANNER_CONTRAST,
          tint,
          rng: Math.random,
        });
    },
  }).catch((error: unknown) => {
    postRasterColorError(data.runId, error);
  });
};
