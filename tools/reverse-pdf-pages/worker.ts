import {
  PdfError,
  organizePages,
  parseForOrganize,
  type PlanEntry,
} from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Reverse PDF pages — device-only worker.
 *
 * Runs 100% on OUR OWN PDF micro-engine (src/lib/own/pdf — zero external
 * code). The file is parsed ONCE (typed refusal for encrypted inputs,
 * typed corrupt errors), then rebuilt page-by-page in reverse reading
 * order with byte-exact content passthrough. Real progress per page;
 * typed error codes for the UI's i18n toasts. Never touches the network.
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
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 6, stage: "reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  let parsed;
  try {
    parsed = parseForOrganize(bytes);
  } catch (error: unknown) {
    post({ type: "error", runId, code: engineErrorCode(error), detail: file.name });
    return;
  }

  const pageCount = parsed.pages.length;
  if (pageCount < 2) {
    // A 0/1-page document has nothing to reverse — the honest refusal
    // beats emitting an identical copy.
    post({
      type: "error",
      runId,
      code: "tool.errorNothingToDo",
      detail: undefined,
    });
    return;
  }

  // Reverse reading order: last page first, byte-exact passthrough.
  const plan: PlanEntry[] = [];
  for (let i = pageCount - 1; i >= 0; i -= 1) {
    plan.push({ kind: "page", src: i });
  }

  post({ type: "progress", runId, pct: 40, stage: "processing" });
  let reversed: Uint8Array;
  try {
    reversed = organizePages(parsed, plan, (fraction, page) => {
      post({
        type: "progress",
        runId,
        pct: Math.round(40 + 50 * fraction),
        stage: "processing",
        detail: { page, pages: plan.length },
      });
    });
  } catch (error: unknown) {
    post({ type: "error", runId, code: engineErrorCode(error), detail: undefined });
    return;
  }

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${safeBaseName(file.name)}-reversed.pdf`,
        mime: "application/pdf",
        blob: new Blob([reversed as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: 1, pages: plan.length },
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
