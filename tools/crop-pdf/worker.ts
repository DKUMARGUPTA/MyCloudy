import { PDFDocument } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import {
  cropBoxForPage,
  cropTargets,
  resolveCropOptions,
  sameBox,
} from "./crop-options";

/**
 * Crop PDF worker (PRD §8.2): sets the CropBox of the chosen pages so the
 * visible page becomes the selected region — on-device, pdf-lib only, zero
 * network. The display-margins → user-space mapping (including /Rotate 90 /
 * 180 / 270 pages) comes from crop-options, the same pure module the live
 * preview uses, so what you dragged is what you get.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const crop = resolveCropOptions(options);

  post({ type: "progress", runId, pct: 4, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const pageCount = doc.getPageCount();
  const targets = cropTargets(crop, pageCount);
  if (targets === null || targets.length === 0) {
    post({ type: "error", runId, code: "crop.errorNoPages" });
    return;
  }

  post({ type: "progress", runId, pct: 10, stage: "processing" });
  const total = targets.length;
  let done = 0;
  let changed = 0;
  for (const pageIndex of targets) {
    const page = doc.getPage(pageIndex);
    // The page's current visible view (CropBox, falling back to MediaBox)
    // and its /Rotate value define the display space the user dragged in.
    const view = page.getCropBox();
    const rotation = page.getRotation().angle;
    const box = cropBoxForPage(crop, view, rotation);
    if (!sameBox(box, view)) {
      page.setCropBox(box.x, box.y, box.width, box.height);
      changed += 1;
    }

    done += 1;
    post({
      type: "progress",
      runId,
      pct: Math.round(10 + (done / total) * 84),
      stage: "processing",
      detail: { page: done, pages: total },
    });
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  const saved = await doc.save({ useObjectStreams: true });
  const outputs = [
    {
      name: `${fileBaseName(file.name)}-cropped.pdf`,
      mime: "application/pdf",
      blob: new Blob([saved as unknown as BlobPart], {
        type: "application/pdf",
      }),
    },
  ];

  post({
    type: "result",
    runId,
    outputs,
    detail: { files: 1, pages: total },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code, detail: undefined });
  });
};
