import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import { PageSizeRunError, runPageSize } from "./worker-lib";

/**
 * Change PDF page size worker shell (PRD §8.3). The whole pipeline lives in
 * worker-lib.ts so the smoke test exercises exactly what ships (the
 * overlay/cts pattern); this file only ferries messages.
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
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  const result = await runPageSize(bytes, file.name, options, (progress) => {
    post({
      type: "progress",
      runId,
      pct: progress.pct,
      stage: progress.stage,
      detail: progress.detail,
    });
  });

  const base = fileBaseName(file.name);
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${base}-resized.pdf`,
        mime: "application/pdf",
        blob: new Blob([result.bytes as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
      {
        name: `${base}-size-report.txt`,
        mime: "text/plain",
        blob: new Blob([result.report], { type: "text/plain" }),
      },
    ],
    detail: { files: 1, pages: result.pages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    if (error instanceof PageSizeRunError) {
      post({
        type: "error",
        runId: data.runId,
        code: error.code,
        detail: error.detail,
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const code = /encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code, detail: undefined });
  });
};
