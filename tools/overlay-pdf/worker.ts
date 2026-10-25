import { PDFDocument } from "pdf-lib";

import type {
  WorkerRunRequest,
  WorkerResponse,
} from "@/lib/workers/protocol";
import { classifyOverlayError, resolveOverlayOptions } from "./engine";
import { overlayPdfs } from "./worker-lib";

/**
 * Overlay PDF worker (PRD §8.3): stamps every page of an overlay PDF onto
 * a base PDF as REAL embedded pages — vector content, selectable text and
 * the overlay's own transparency all survive; nothing is rasterized and no
 * network is touched (files arrive by structured clone, the Blob returns
 * the same way). The heavy pipeline lives in worker-lib.ts, shared with the
 * smoke test so the test exercises exactly what ships.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** Strips path separators + unsafe chars from a download display name. */
function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const baseFile = files[0];
  const overlayFile = files[1];
  if (!baseFile || !overlayFile) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const opts = resolveOverlayOptions(options);

  post({ type: "progress", runId, pct: 5, stage: "reading" });
  const baseBytes = new Uint8Array(await baseFile.arrayBuffer());
  const overlayBytes = new Uint8Array(await overlayFile.arrayBuffer());

  // R6-b honesty (merge-pdf/pagegrid standard): overlay has TWO inputs, so a
  // locked-file refusal must NAME the file — "unlock it first" is useless
  // when the user can't tell the base from the stamp. Structural probe first
  // (pdf-lib ignoreEncryption load + isEncrypted — never a raw-bytes
  // "/Encrypt" sniff), then the plain load; both refusals carry the name.
  const loadNamed = async (
    bytes: Uint8Array,
    fileName: string
  ): Promise<PDFDocument | null> => {
    let probe: PDFDocument | null = null;
    try {
      probe = await PDFDocument.load(bytes, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
    } catch {
      // Not parseable at all — the plain load below produces the honest
      // corrupt refusal for this file.
    }
    if (probe?.isEncrypted) {
      post({
        type: "error",
        runId,
        code: "tool.errorEncrypted",
        detail: fileName,
      });
      return null;
    }
    try {
      return await PDFDocument.load(bytes, {
        ignoreEncryption: false,
        updateMetadata: false,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      post({
        type: "error",
        runId,
        code: /password|encrypt/i.test(message)
          ? "tool.errorEncrypted"
          : "tool.errorCorrupt",
        detail: fileName,
      });
      return null;
    }
  };

  const baseDoc = await loadNamed(baseBytes, baseFile.name);
  if (baseDoc === null) return;
  const overlayDoc = await loadNamed(overlayBytes, overlayFile.name);
  if (overlayDoc === null) return;
  if (overlayDoc.getPageCount() === 0) {
    post({ type: "error", runId, code: "overlay.errorNoPages" });
    return;
  }

  let stamped: number;
  try {
    stamped = await overlayPdfs(baseDoc, overlayDoc, opts, (progress) => {
      post({
        type: "progress",
        runId,
        pct: progress.pct,
        stage: "processing",
        detail: { page: progress.page, pages: progress.pages },
      });
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no pages selected/.test(message)) {
      post({ type: "error", runId, code: "overlay.errorNoPages" });
    } else if (/no page match/.test(message)) {
      post({ type: "error", runId, code: "overlay.errorNoMatch" });
    } else if (/invalid page range/.test(message)) {
      post({ type: "error", runId, code: "wm.rangeInvalid" });
    } else {
      post({ type: "error", runId, code: classifyOverlayError(message) });
    }
    return;
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  const saved = await baseDoc.save({ useObjectStreams: true });
  const outputs = [
    {
      name: `${safeBaseName(baseFile.name)}-overlaid.pdf`,
      mime: "application/pdf",
      blob: new Blob([saved as unknown as BlobPart], {
        type: "application/pdf",
      }),
    },
  ];

  post({
    type: "result",
    runId,
    outputs,
    detail: { files: 1, pages: stamped },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId: data.runId,
      code: classifyOverlayError(message),
      detail: undefined,
    });
  });
};
