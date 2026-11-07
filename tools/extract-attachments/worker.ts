import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { runExtractAttachments } from "./worker-lib";

/**
 * Extract attachments worker (PHASE-3 → R59): the pipeline lives in
 * worker-lib (PURE — the surface's pre-run inventory probe runs the
 * same code on the main thread, so the preview IS the output). This
 * module is only the Worker boundary: file → bytes → pipeline →
 * outputs, on OUR OWN parser, never the network.
 *
 * R59 fix (in worker-lib): the stream's /Filter chain is now APPLIED
 * (FlateDecode and friends) — real-world PDFs (Acrobat, pdf-lib
 * attach(), Word) store attachment streams Flate-compressed, and the
 * pre-R59 worker shipped the still-compressed bytes, breaking the
 * "byte-exact" promise.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeName(raw: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 150) : "attachment";
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, files } = request;
  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const outputs: Array<{ name: string; mime: string; blob: Blob }> = [];
  let total = 0;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex]!;
    post({
      type: "progress",
      runId,
      pct: Math.round(8 + (86 * fileIndex) / files.length),
      stage: "reading",
    });
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      post({ type: "error", runId, code: "tool.errorCorrupt" });
      return;
    }
    let result: Awaited<ReturnType<typeof runExtractAttachments>>;
    try {
      result = await runExtractAttachments(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /^tool\./.test(message)
        ? message
        : /encrypt/i.test(message)
          ? "tool.errorEncrypted"
          : "tool.errorCorrupt";
      post({ type: "error", runId, code });
      return;
    }
    if (result.attachments.length === 0) {
      post({ type: "error", runId, code: "et.errorNoAttachments" });
      return;
    }
    for (const att of result.attachments) {
      outputs.push({
        name: safeName(att.name),
        mime: att.mime,
        blob: new Blob([att.bytes as unknown as BlobPart], {
          type: att.mime,
        }),
      });
      total += 1;
    }
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, attachmentsExtracted: total },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
