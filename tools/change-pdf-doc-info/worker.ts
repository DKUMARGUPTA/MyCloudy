import { PDFDocument } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import { resolveDocInfoEdits } from "../meta-common/meta";
import { applyDocInfoEdits } from "../meta-common/worker-lib";

/**
 * Change document information worker (PRD §8.2): applies the form edits to
 * the Info dict with pdf-lib — on-device, zero network. `updateMetadata:
 * false` keeps pdf-lib from stamping its own Producer/ModDate so every
 * field is exactly what the user chose (smoke-locked, see
 * scripts/smoke-metadata.ts).
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
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: false,
    updateMetadata: false,
  });

  post({ type: "progress", runId, pct: 40, stage: "processing" });
  applyDocInfoEdits(doc, edits);

  post({ type: "progress", runId, pct: 92, stage: "saving" });
  const saved = await doc.save({ useObjectStreams: true });
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
    detail: { files: 1, pages: doc.getPageCount() },
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
