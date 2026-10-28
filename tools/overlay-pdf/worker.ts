import type {
  WorkerRunRequest,
  WorkerResponse,
} from "@/lib/workers/protocol";
import { PdfError, StampContext } from "@/lib/own/pdf";
import { classifyOverlayError, resolveOverlayOptions } from "./engine";
import { loadOverlaySource, overlayPdfs } from "./worker-lib";

/**
 * Overlay PDF worker (PRD §8.3): stamps every page of an overlay PDF onto
 * a base PDF as REAL embedded pages — vector content, selectable text and
 * the overlay's own transparency all survive; nothing is rasterized and no
 * network is touched (files arrive by structured clone, the Blob returns
 * the same way). The heavy pipeline lives in worker-lib.ts, shared with the
 * smoke test so the test exercises exactly what ships.
 *
 * P6-j: 100% OUR OWN PDF ENGINE. The base document rides a StampContext
 * (pages preserved byte-exact, the draw ops appended/prepended to /Contents),
 * and the overlay pages embed as source-anchored Form XObjects whose
 * referenced graphs (fonts, nested XObjects…) the writer BFS-copies exactly
 * once per source object — pdf-lib embedPdf/drawPage parity, verified in
 * smoke-pdf-core §19.
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
  // when the user can't tell the base from the stamp. Our parser refuses
  // encrypted documents with a typed error up front (the structural probe
  // IS the parse), and every refusal carries the name.
  const loadNamedBase = (): StampContext => {
    try {
      return StampContext.load(baseBytes);
    } catch (error: unknown) {
      if (error instanceof PdfError && error.code === "encrypted") {
        post({
          type: "error",
          runId,
          code: "tool.errorEncrypted",
          detail: baseFile.name,
        });
        throw new Error("handled");
      }
      post({
        type: "error",
        runId,
        code: "tool.errorCorrupt",
        detail: baseFile.name,
      });
      throw new Error("handled");
    }
  };
  const loadNamedOverlay = () => {
    try {
      return loadOverlaySource(overlayBytes);
    } catch (error: unknown) {
      if (error instanceof PdfError && error.code === "encrypted") {
        post({
          type: "error",
          runId,
          code: "tool.errorEncrypted",
          detail: overlayFile.name,
        });
        throw new Error("handled");
      }
      post({
        type: "error",
        runId,
        code: "tool.errorCorrupt",
        detail: overlayFile.name,
      });
      throw new Error("handled");
    }
  };

  let baseDoc: StampContext;
  let overlaySource: ReturnType<typeof loadOverlaySource>;
  try {
    baseDoc = loadNamedBase();
    overlaySource = loadNamedOverlay();
  } catch {
    return; // the named refusal was already posted
  }
  if (overlaySource.pages.length === 0) {
    post({ type: "error", runId, code: "overlay.errorNoPages" });
    return;
  }

  let stamped: number;
  let saved: Uint8Array;
  try {
    const outcome = overlayPdfs(baseDoc, overlaySource, opts, (progress) => {
      post({
        type: "progress",
        runId,
        pct: progress.pct,
        stage: "processing",
        detail: { page: progress.page, pages: progress.pages },
      });
    });
    stamped = outcome.stamped;
    post({ type: "progress", runId, pct: 96, stage: "saving" });
    saved = outcome.bytes;
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
    if (message === "handled") return;
    post({
      type: "error",
      runId: data.runId,
      code: classifyOverlayError(message),
      detail: undefined,
    });
  });
};
