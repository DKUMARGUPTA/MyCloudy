import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { fileBaseName } from "../stamp-common/layout";
import { RM_IDS } from "../meta-common/meta";
import {
  loadMetaDoc,
  saveMetaDoc,
  stripAllMetadata,
} from "../meta-common/worker-lib";

/**
 * Remove PDF metadata worker (PRD §8.3): strips the whole Info dictionary,
 * (optionally) the XMP /Metadata stream AND the page-level extras — every
 * page's /PieceInfo, its own /Metadata stream, every annotation's /M
 * modification date — on the OWN engine (P6-s), on-device, zero network.
 * Every strip is object-level (the objects are dropped from the file, not
 * just blanked); the honest per-category counts ride the result detail.
 * Smoke-locked in scripts/smoke-metadata.ts.
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
  const meta = loadMetaDoc(bytes); // typed encrypted/corrupt throws
  const pageCount = meta.pageCount;

  post({ type: "progress", runId, pct: 35, stage: "processing" });
  const report = stripAllMetadata(meta, alsoXmp);

  post({ type: "progress", runId, pct: 90, stage: "saving" });
  const saved = saveMetaDoc(meta);
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
    detail: {
      files: 1,
      pages: pageCount,
      removedInfoFields: report.removedFields.length,
      removedXmp: report.removedXmp,
      strippedPieceInfo: report.removedPieceInfo,
      strippedPageMetadata: report.removedPageMetadata,
      strippedAnnotationDates: report.removedAnnotationDates,
    },
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
