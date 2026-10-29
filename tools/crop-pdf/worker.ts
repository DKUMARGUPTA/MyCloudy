import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import { CropRunError, runCrop } from "./worker-lib";

/**
 * Crop PDF worker (PRD §8.2) — thin message shell over runCrop (the
 * worker-lib shared-pipeline precedent, P6-t): the engine side runs 100%
 * on our own micro-engine (parsePdf → /CropBox surgery on the parsed
 * graph → rewriteDocument), on-device, zero network. The display-margins →
 * user-space mapping (including /Rotate 90 / 180 / 270 pages) comes from
 * crop-options, the same pure module the live preview uses, so what you
 * dragged is what you get.
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

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await runCrop(bytes, options, (progress) => {
    post({
      type: "progress",
      runId,
      pct: progress.pct,
      stage: progress.stage,
      detail: progress.detail,
    });
  });

  const outputs = [
    {
      name: `${fileBaseName(file.name)}-cropped.pdf`,
      mime: "application/pdf",
      blob: new Blob([result.bytes as unknown as BlobPart], {
        type: "application/pdf",
      }),
    },
  ];

  post({
    type: "result",
    runId,
    outputs,
    detail: { files: 1, pages: result.targets },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    if (error instanceof CropRunError) {
      post({ type: "error", runId: data.runId, code: error.code, detail: error.detail });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const code = /password|encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code, detail: undefined });
  });
};
