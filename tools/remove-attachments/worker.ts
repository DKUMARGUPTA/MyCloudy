import { listPages, parsePdf, PdfError } from "@/lib/own/pdf";
import type { ParsedPdf } from "@/lib/own/pdf";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "@/lib/workers/protocol";
import { removeAttachmentsFromDoc } from "./worker-lib";

/**
 * Remove attachments worker (P3-d) — thin shell over the PURE
 * worker-lib surgery (inventory → annotation protection → reference
 * strip → object deletion → classic rewrite). On-device, typed
 * errors, honest nothing-to-do refusal.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

function engineErrorCode(error: unknown): string {
  if (error instanceof PdfError && error.code === "encrypted") {
    return "tool.errorEncrypted";
  }
  return "tool.errorCorrupt";
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, files } = request;
  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  let removedTotal = 0;
  let keptAnnotated = 0;
  let totalPages = 0;
  const outputs: { name: string; mime: string; blob: Blob }[] = [];

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex]!;
    post({
      type: "progress",
      runId,
      pct: 5 + Math.round((fileIndex / files.length) * 88),
      stage: "reading",
    });

    const bytes = new Uint8Array(await file.arrayBuffer());
    let doc: ParsedPdf;
    try {
      doc = parsePdf(bytes);
    } catch (error: unknown) {
      post({
        type: "error",
        runId,
        code: engineErrorCode(error),
        detail: file.name,
      });
      return;
    }

    post({
      type: "progress",
      runId,
      pct: 5 + Math.round(((fileIndex + 0.5) / files.length) * 88),
      stage: "processing",
    });

    totalPages += listPages(doc).length;

    let outcome;
    try {
      outcome = removeAttachmentsFromDoc(doc);
    } catch (error: unknown) {
      post({ type: "error", runId, code: engineErrorCode(error) });
      return;
    }
    if (outcome === null) continue;

    removedTotal += outcome.removed;
    keptAnnotated += outcome.keptAnnotated;
    outputs.push({
      name: `${safeBaseName(file.name)}-no-attachments.pdf`,
      mime: "application/pdf",
      blob: new Blob([outcome.bytes as unknown as BlobPart], {
        type: "application/pdf",
      }),
    });

    post({
      type: "progress",
      runId,
      pct: 5 + Math.round(((fileIndex + 1) / files.length) * 88),
      stage: "processing",
    });
  }

  if (removedTotal === 0) {
    post({
      type: "error",
      runId,
      code: "tool.errorNothingToDo",
      detail: undefined,
    });
    return;
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: {
      files: outputs.length,
      pages: totalPages,
      attachments: removedTotal,
      attachmentsKeptAnnotated: keptAnnotated,
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    post({
      type: "error",
      runId: data.runId,
      code: engineErrorCode(error),
      detail: undefined,
    });
  });
};
