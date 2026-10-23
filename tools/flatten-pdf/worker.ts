import { PDFDocument } from "pdf-lib";

import type { OptionValues } from "@/lib/tools/config-types";
import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  FlattenFormsError,
  classifyFlattenError,
  flattenDocument,
  type FlattenScope,
} from "./engine";

/**
 * Flatten PDF — device-only worker (PRD §8.4, Optimize).
 *
 * Options read (exact ids, matching tools/flatten-pdf/config.ts):
 *   scope  "both" (forms + annotations, default) | "forms" | "annotations"
 *   pages  page-range spec for the ANNOTATION pass (default "all") — the
 *          forms pass is document-wide in pdf-lib (the hint says so)
 *
 * The engine (engine.ts) is the same pure pdf-lib pipeline the smoke locks;
 * this wrapper only adds IO, progress and typed error codes for the UI's
 * i18n toasts. Never touches the network.
 *
 * A document with nothing to flatten SUCCEEDS: the input bytes are
 * passed through untouched (no re-save churn) and the result detail
 * carries nothingFlattened: true so the UI shows an honest info chip
 * instead of an error toast — being already flat is normal usage.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

/** Maps the select value to the engine scope. Unknown values → both. */
function readScope(options: OptionValues): FlattenScope {
  const scope = String(options.scope ?? "both");
  if (scope === "forms") return "forms-only";
  if (scope === "annotations") return "annotations-only";
  return "forms-and-annotations";
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  const scope = readScope(options);
  const runAnnotations = scope !== "forms-only";

  post({
    type: "progress",
    runId,
    pct: 3,
    stage: "reading",
  });

  const bytes = new Uint8Array(await file.arrayBuffer());
  let doc: PDFDocument;
  try {
    // Same guards as merge-pdf: encrypted files fail load with an
    // /encrypt/ message, anything else unreadable is corrupt.
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

  // The pages range only steers the annotation pass.
  let annotationPages: number[] | null = null;
  if (runAnnotations) {
    const trimmed = String(options.pages ?? "all").trim();
    if (trimmed !== "" && trimmed.toLowerCase() !== "all") {
      annotationPages = parsePageSpec(trimmed, doc.getPageCount());
      if (annotationPages === null) {
        post({
          type: "error",
          runId,
          code: "tool.errorInvalidPages",
          detail: trimmed,
        });
        return;
      }
    }
  }

  post({
    type: "progress",
    runId,
    pct: 10,
    stage: "processing",
  });

  try {
    const report = flattenDocument(doc, {
      scope,
      annotationPages,
      onAnnotationPage: (done, total) => {
        post({
          type: "progress",
          runId,
          pct: Math.min(88, 10 + Math.round((75 * done) / Math.max(1, total))),
          stage: "processing",
          detail: { page: done, pages: Math.max(1, total) },
        });
      },
    });

    post({
      type: "progress",
      runId,
      pct: 92,
      stage: "saving",
    });

    // Already flat — normal usage, not an error: hand the ORIGINAL bytes
    // back untouched (byte-identical, zero re-save churn) and flag the
    // honest "nothing to flatten" chip on the result card.
    if (report.nothingToDo) {
      post({
        type: "result",
        runId,
        outputs: [
          {
            name: `${safeBaseName(file.name)}-flattened.pdf`,
            mime: "application/pdf",
            blob: new Blob([bytes as unknown as BlobPart], {
              type: "application/pdf",
            }),
          },
        ],
        detail: { files: 1, pages: report.pages, nothingFlattened: true },
      });
      return;
    }

    const saved = await doc.save({ useObjectStreams: true });
    const outputName = `${safeBaseName(file.name)}-flattened.pdf`;

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
      detail: { files: 1, pages: report.pages },
    });
  } catch (error) {
    if (error instanceof FlattenFormsError) {
      // Expected, typed outcome — the engine maps it to its key.
      post({
        type: "error",
        runId,
        code: classifyFlattenError(error),
      });
      return;
    }
    // Anything else is unexpected: generic copy + short technical detail
    // (no file names — pdf-lib messages never contain them).
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId,
      code: "tool.errorGeneric",
      detail: message.slice(0, 200),
    });
  }
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId: data.runId,
      code: /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorGeneric",
      detail: message.slice(0, 200),
    });
  });
};
