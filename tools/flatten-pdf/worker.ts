import type { OptionValues } from "@/lib/tools/config-types";
import { StampContext } from "@/lib/own/pdf";
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
 *          forms pass is document-wide (the hint says so)
 *
 * P6-p: the engine (engine.ts) is OUR pdf-lib-free pipeline (StampContext
 * burn passes); this wrapper only adds IO, progress and typed error codes
 * for the UI's i18n toasts. Never touches the network.
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
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const scope = readScope(options);
  const runAnnotations = scope !== "forms-only";

  post({
    type: "progress",
    runId,
    pct: 3,
    stage: "reading",
  });

  const bytes = new Uint8Array(await file.arrayBuffer());

  // ONE typed parse drives everything: encrypted files refuse with the
  // honest error code, anything else unreadable is corrupt — and the page
  // count for the range spec comes off the same parse.
  let ctx: StampContext;
  try {
    ctx = StampContext.load(bytes);
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
      annotationPages = parsePageSpec(trimmed, ctx.pageCount);
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
    const { report, bytes: saved } = flattenDocument(
      bytes,
      {
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
      },
      ctx,
    );

    post({
      type: "progress",
      runId,
      pct: 92,
      stage: "saving",
    });

    // Already flat — normal usage, not an error: hand the ORIGINAL bytes
    // back untouched (byte-identical, zero re-save churn) and flag the
    // honest "nothing to flatten" chip on the result card.
    const outputBytes = report.nothingToDo ? bytes : saved;
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${safeBaseName(file.name)}-flattened.pdf`,
          mime: "application/pdf",
          blob: new Blob([outputBytes as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: {
        files: 1,
        pages: report.pages,
        ...(report.nothingToDo ? { nothingFlattened: true } : {}),
      },
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
    // (no file names — engine messages never contain them).
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId,
      code: /encrypt/i.test(message) ? "tool.errorEncrypted" : "tool.errorGeneric",
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
