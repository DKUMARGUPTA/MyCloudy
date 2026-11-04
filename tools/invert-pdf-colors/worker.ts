/**
 * Invert PDF Colors — thin worker over the raster-color core: every
 * rendered page's pixels get the 255−v flip (tools/raster-color-common/
 * transforms.ts invertPixels) and the page is rebuilt. The core owns
 * rendering, the pixel-budget clamp, progress and error mapping.
 */
import type { WorkerRunRequest } from "@/lib/workers/protocol";
import { invertPixels } from "../raster-color-common/transforms";
import {
  postRasterColorError,
  runRasterColor,
} from "../raster-color-common/worker-core";

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  runRasterColor(data, {
    outputSuffix: "-inverted",
    defaultQuality: 85,
    transformFor: () => invertPixels,
  }).catch((error: unknown) => {
    postRasterColorError(data.runId, error);
  });
};
