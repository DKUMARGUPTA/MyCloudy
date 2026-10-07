import { PDFDocument } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import { RM_IDS } from "../meta-common/meta";
import { stripAllMetadata } from "../meta-common/worker-lib";

/**
 * Remove PDF metadata worker (PRD §8.3): strips the whole Info dictionary
 * and (optionally) the XMP /Metadata stream with pdf-lib — on-device, zero
 * network. The strip is object-level (the Info object and XMP stream are
 * dropped from the file, not just blanked) — smoke-locked in
 * scripts/smoke-metadata.ts.
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
  const alsoXmp = options[RM_IDS.alsoXmp] !== false;

  post({ type: "progress", runId, pct: 8, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const pageCount = doc.getPageCount();

  post({ type: "progress", runId, pct: 35, stage: "processing" });
  // Snapshot BEFORE stripping — pdf-lib's getters lazily re-create an empty
  // Info dict, so the count must be read first (see smoke test #3).
  const report = stripAllMetadata(doc, alsoXmp);

  post({ type: "progress", runId, pct: 90, stage: "saving" });
  const saved = await doc.save({ useObjectStreams: true });
  const outputs = [
    {
      name: `${fileBaseName(file.name)}-clean.pdf`,
      mime: "application/pdf",
      blob: new Blob([saved as BlobPart], { type: "application/pdf" }),
    },
  ];

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: 1, pages: pageCount },
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
