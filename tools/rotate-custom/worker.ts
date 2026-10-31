import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import { RotateRunError, runRotateCustom } from "./worker-lib";

/**
 * Rotate by custom angle worker shell (R52). The whole pipeline lives in
 * worker-lib.ts so the smoke test exercises exactly what ships (the
 * change-pdf-page-size pattern); this file only ferries messages.
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

  post({ type: "progress", runId, pct: 4, stage: "reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt", detail: file.name });
    return;
  }

  try {
    const { bytes: saved, pages } = await runRotateCustom(
      bytes,
      options,
      (progress) => {
        post({
          type: "progress",
          runId,
          pct: progress.pct,
          stage: progress.stage,
          detail: progress.detail,
        });
      }
    );
    post({ type: "progress", runId, pct: 96, stage: "saving" });
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${fileBaseName(file.name)}-rotated.pdf`,
          mime: "application/pdf",
          blob: new Blob([saved as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: { files: 1, pages },
    });
  } catch (error: unknown) {
    if (error instanceof RotateRunError) {
      post({ type: "error", runId, code: error.code, detail: error.detail });
      return;
    }
    post({ type: "error", runId, code: "tool.errorCorrupt" });
  }
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorCorrupt" });
  });
};
