/**
 * PDF to Greyscale — thin worker over the raster-color core: every
 * rendered page's pixels get the Rec. 601 luma (transforms.ts
 * greyscalePixels) and the page is rebuilt. The core owns rendering,
 * the pixel-budget clamp, progress and error mapping.
 */
import type { WorkerRunRequest } from "@/lib/workers/protocol";
import { greyscalePixels } from "../raster-color-common/transforms";
import {
  postRasterColorError,
  runRasterColor,
} from "../raster-color-common/worker-core";

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  runRasterColor(data, {
    outputSuffix: "-greyscale",
    defaultQuality: 85,
    transformFor: () => greyscalePixels,
  }).catch((error: unknown) => {
    postRasterColorError(data.runId, error);
  });
};
