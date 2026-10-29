import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import { resolveDocInfoEdits } from "../meta-common/meta";
import {
  applyDocInfoEdits,
  loadMetaDoc,
  saveMetaDoc,
} from "../meta-common/worker-lib";

/**
 * Change document information worker (PRD §8.2): applies the form edits to
 * the Info dict on the OWN engine (P6-s) — on-device, zero network. Nothing
 * stamps its own Producer/ModDate, so every field is exactly what the user
 * chose (smoke-locked, see scripts/smoke-metadata.ts).
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
  const edits = resolveDocInfoEdits(options);

  post({ type: "progress", runId, pct: 8, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const meta = loadMetaDoc(bytes); // typed encrypted/corrupt throws

  post({ type: "progress", runId, pct: 40, stage: "processing" });
  applyDocInfoEdits(meta, edits);

  post({ type: "progress", runId, pct: 92, stage: "saving" });
  const saved = saveMetaDoc(meta);
  const outputs = [
    {
      name: `${fileBaseName(file.name)}-edited.pdf`,
      mime: "application/pdf",
      blob: new Blob([saved as BlobPart], { type: "application/pdf" }),
    },
  ];

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: 1, pages: meta.pageCount },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /password|encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code });
  });
};
