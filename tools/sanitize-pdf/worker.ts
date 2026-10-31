import {
  PdfError,
  organizeMerge,
  parseForOrganize,
  type MergePlanEntry,
  type OrganizeSource,
} from "@/lib/own/pdf";
import type { PdfObj } from "@/lib/own/pdf";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Sanitize PDF — device-only worker.
 *
 * Runs 100% on OUR OWN PDF micro-engine (src/lib/own/pdf). The whole
 * document is REBUILT page-by-page, which is what sanitizes it:
 *
 *  - the fresh catalog never carries /OpenAction, /Names (JavaScript) or
 *    /AcroForm — scripts and auto-run actions simply do not survive;
 *  - no Info dict / XMP is passed to the writer — metadata is dropped;
 *  - per-page /Annots (comments, highlights, links, form widgets) and
 *    /PieceInfo + page /Metadata are set to null — spec-equivalent to
 *    absent — when the switches ask for them.
 *
 * Content streams pass through byte-exact. Batch: up to 5 files, one
 * output per input. Typed error codes; never touches the network.
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

/** Per-page own-dict overrides for the chosen strips (null = spec-absent). */
function sanitizeOverrides(
  annotations: boolean,
  hiddenData: boolean
): Array<[string, PdfObj]> {
  const set: Array<[string, PdfObj]> = [];
  if (annotations) {
    set.push(["Annots", { k: "null" }]);
  }
  if (hiddenData) {
    set.push(["PieceInfo", { k: "null" }]);
    set.push(["Metadata", { k: "null" }]);
  }
  return set;
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const annotations = options.annotations !== false;
  const hiddenData = options.hiddenData !== false;
  // `scripts` needs no per-page work: the rebuilt catalog never carries
  // /OpenAction, /Names or /AA — the switch only communicates intent.
  const scripts = options.scripts !== false;

  if (!annotations && !hiddenData && !scripts) {
    post({ type: "error", runId, code: "tool.errorNothingToDo", detail: undefined });
    return;
  }

  const total = files.length;
  const sources: OrganizeSource[] = [];
  const outputs: {
    name: string;
    mime: string;
    blob: Blob;
  }[] = [];

  // Parse phase: one typed parse per file (the honest file-named refusal).
  for (let index = 0; index < total; index += 1) {
    const file = files[index];
    post({
      type: "progress",
      runId,
      pct: Math.round((index / total) * 30),
      stage: "reading",
      detail: { page: index + 1, pages: total },
    });
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      sources.push(parseForOrganize(bytes));
    } catch (error: unknown) {
      post({
        type: "error",
        runId,
        code: engineErrorCode(error),
        detail: file.name,
      });
      return;
    }
  }

  // Rebuild phase: per-file plan, shared overrides, one output per input.
  const overrides = sanitizeOverrides(annotations, hiddenData);
  let totalPages = 0;
  for (let index = 0; index < total; index += 1) {
    const source = sources[index];
    const plan: MergePlanEntry[] = [];
    for (let p = 0; p < source.pages.length; p += 1) {
      plan.push({
        kind: "page",
        doc: index,
        src: p,
        ...(overrides.length > 0 ? { set: overrides } : {}),
      });
    }
    if (plan.length === 0) {
      post({
        type: "error",
        runId,
        code: "tool.errorCorrupt",
        detail: files[index].name,
      });
      return;
    }
    totalPages += plan.length;
    const base = 30 + (index / total) * 60;
    const cleaned = organizeMerge([source], plan, (fraction, page) => {
      post({
        type: "progress",
        runId,
        pct: Math.round(base + (60 / total) * fraction),
        stage: "processing",
        detail: { page, pages: plan.length },
      });
    });
    outputs.push({
      name: `${safeBaseName(files[index].name)}-sanitized.pdf`,
      mime: "application/pdf",
      blob: new Blob([cleaned as unknown as BlobPart], {
        type: "application/pdf",
      }),
    });
  }

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: total, pages: totalPages },
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
