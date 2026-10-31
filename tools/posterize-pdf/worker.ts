/**
 * Posterize PDF — thin worker over the raster-color core: every
 * rendered page's pixels get snapped to N evenly spaced levels
 * (transforms.ts posterizePixels) and the page is rebuilt. The core
 * owns rendering, the pixel-budget clamp, progress and error mapping.
 */
import type { WorkerRunRequest } from "@/lib/workers/protocol";
import { posterizePixels } from "../raster-color-common/transforms";
import {
  postRasterColorError,
  runRasterColor,
} from "../raster-color-common/worker-core";

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  runRasterColor(data, {
    outputSuffix: "-posterized",
    defaultQuality: 85,
    transformFor: (options) => {
      // The select promises 2/3/4/6/8; clamp again — a malformed value
      // must never reach the step math.
      const levels = Math.max(
        2,
        Math.min(8, Math.round(Number(options.levels ?? 4) || 4)),
      );
      return (rgba) => posterizePixels(rgba, levels);
    },
  }).catch((error: unknown) => {
    postRasterColorError(data.runId, error);
  });
};
