import { PDFDocument } from "pdf-lib";

import type { OptionValues } from "@/lib/tools/config-types";
import type { WorkerRunRequest, WorkerResponse } from "@/lib/workers/protocol";
import {
  classifyBookmarkError,
  normalizeTree,
  writeOutline,
} from "./engine";

/**
 * Bookmark PDF — device-only worker (PRD §7.1 / §8.1, Organize).
 *
 * Options read (exact id, matching the surface writes):
 *   tree  serialized outline tree ({"v":1,"n":[{t,p,c}]}), built by the
 *         surface editor and normalized here against the real page count —
 *         the worker is the authority, never trusting the UI payload.
 *
 * The output REPLACES any existing outline (the engine deletes the old
 * items) and sets /PageMode /UseOutlines so viewers open the panel.
 * Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];

  post({
    type: "progress",
    runId,
    pct: 4,
    stage: "reading",
  });

  const bytes = new Uint8Array(await file.arrayBuffer());
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId,
      code: /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt",
    });
    return;
  }

  const pageCount = doc.getPageCount();
  const tree = normalizeTree((options as OptionValues).tree, pageCount);
  if (tree.length === 0) {
    post({
      type: "error",
      runId,
      code: "bm.errorEmptyTree",
    });
    return;
  }

  post({
    type: "progress",
    runId,
    pct: 45,
    stage: "processing",
  });

  try {
    const report = writeOutline(doc, tree);

    post({
      type: "progress",
      runId,
      pct: 88,
      stage: "saving",
    });

    const saved = await doc.save({ useObjectStreams: true });
    const outputName = `${safeBaseName(file.name)}-bookmarked.pdf`;

    post({
      type: "result",
      runId,
      outputs: [
        {
          name: outputName,
          mime: "application/pdf",
          blob: new Blob([saved as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: {
        files: 1,
        pages: pageCount,
      },
    });
  } catch (error) {
    post({
      type: "error",
      runId,
      code: classifyBookmarkError(error),
    });
  }
}

self.addEventListener("message", (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data && data.type === "run") {
    void run(data);
  }
});

export {};
