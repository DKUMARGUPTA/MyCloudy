import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import { runViewMetadata } from "./worker-lib";

/**
 * View PDF metadata worker shell (R52). The whole pipeline lives in
 * worker-lib.ts so the smoke test exercises exactly what ships; this
 * file only ferries messages. Read-only, own engine, on-device.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.pdf$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 12, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());

  post({ type: "progress", runId, pct: 70, stage: "processing" });
  let result: ReturnType<typeof runViewMetadata>;
  try {
    result = runViewMetadata(bytes, file.name, options);
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt", detail: file.name });
    return;
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  const isJson = options.format === "json";
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${safeBaseName(file.name)}-metadata.${isJson ? "json" : "txt"}`,
        mime: isJson ? "application/json" : "text/plain",
        blob: new Blob([result.report], {
          type: isJson ? "application/json" : "text/plain",
        }),
      },
    ],
    detail: { files: 1, pages: result.pageCount },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorCorrupt" });
  });
};
