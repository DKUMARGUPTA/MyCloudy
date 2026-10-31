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
 * Add blank page — device-only worker.
 *
 * Runs 100% on OUR OWN PDF micro-engine (src/lib/own/pdf). The document
 * is rebuilt from a plan of page-copies interleaved with `blank-from`
 * entries — each blank sized exactly like its neighbour page (start→p1,
 * end→last, after/before page N→page N). Real progress; typed error
 * codes for the UI's i18n toasts. Never touches the network.
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

interface BlankOptions {
  position: "start" | "end" | "after" | "before";
  atPage: number;
  atPageBefore: number;
  count: number;
}

function resolveOptions(options: OptionValues): BlankOptions {
  const positionRaw = String(options.position ?? "end");
  const position: BlankOptions["position"] =
    positionRaw === "start" || positionRaw === "after" || positionRaw === "before"
      ? (positionRaw as BlankOptions["position"])
      : "end";
  const clampInt = (raw: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  };
  return {
    position,
    atPage: clampInt(options.atPage, 1, 1, 5000),
    atPageBefore: clampInt(options.atPageBefore, 1, 1, 5000),
    count: clampInt(options.count, 1, 1, 20),
  };
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
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
  if (pageCount < 1) {
    post({ type: "error", runId, code: "tool.errorCorrupt", detail: file.name });
    return;
  }

  const opts = resolveOptions(options);

  // Validate the anchor page against the real page count (1-based input).
  if (opts.position === "after" && opts.atPage > pageCount) {
    post({
      type: "error",
      runId,
      code: "tool.errorInvalidPages",
      detail: `${opts.atPage} > ${pageCount}`,
    });
    return;
  }
  if (opts.position === "before" && opts.atPageBefore > pageCount) {
    post({
      type: "error",
      runId,
      code: "tool.errorInvalidPages",
      detail: `${opts.atPageBefore} > ${pageCount}`,
    });
    return;
  }

  /* Plan: page copies with blank-from entries at the chosen spot.
   * blank-from sizes the blank like the REFERENCED source page:
   *   start     → page 0 (the first page)
   *   end       → last page
   *   after N   → page N-1 (0-based N-1 == the page just inserted after)
   *   before N  → page N-1 (the blank matches the page it precedes) */
  const plan: PlanEntry[] = [];
  /* Size anchor: which source page the blanks copy their size from:
   *   start     → page 0 (the first page)
   *   end       → last page
   *   after N   → page N-1 (the page just inserted after)
   *   before N  → page N-1 (the page the blanks precede) */
  let anchorIndex = 0;
  const blanks = (): void => {
    for (let i = 0; i < opts.count; i += 1) {
      plan.push({ kind: "blank-from", src: anchorIndex });
    }
  };
  switch (opts.position) {
    case "start":
      anchorIndex = 0;
      blanks();
      for (let i = 0; i < pageCount; i += 1) plan.push({ kind: "page", src: i });
      break;
    case "end":
      anchorIndex = pageCount - 1;
      for (let i = 0; i < pageCount; i += 1) plan.push({ kind: "page", src: i });
      blanks();
      break;
    case "after":
      anchorIndex = opts.atPage - 1;
      for (let i = 0; i < pageCount; i += 1) {
        plan.push({ kind: "page", src: i });
        if (i === anchorIndex) blanks();
      }
      break;
    case "before":
      anchorIndex = opts.atPageBefore - 1;
      for (let i = 0; i < pageCount; i += 1) {
        if (i === anchorIndex) blanks();
        plan.push({ kind: "page", src: i });
      }
      break;
  }

  post({ type: "progress", runId, pct: 40, stage: "processing" });
  let out: Uint8Array;
  try {
    out = organizePages(parsed, plan, (fraction, page) => {
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
        name: `${safeBaseName(file.name)}-with-blanks.pdf`,
        mime: "application/pdf",
        blob: new Blob([out as unknown as BlobPart], {
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
