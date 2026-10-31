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
import { buildDuplexPlan, normalizeDuplexOptions } from "./worker-lib";

/**
 * Duplex collate worker (P1-d / R53) — turns a two-block duplex scan
 * (all fronts, then all backs) back into reading order. Runs 100% on our
 * own engine; page content passes through byte-exact. Typed refusals for
 * encrypted/corrupt inputs and for plans that would change nothing.
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
  const { runId, files, options } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const opts = normalizeDuplexOptions(options as OptionValues);

  post({ type: "progress", runId, pct: 8, stage: "reading" });
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
    post({
      type: "error",
      runId,
      code: engineErrorCode(error),
      detail: file.name,
    });
    return;
  }

  const pageCount = parsed.pages.length;
  const built = buildDuplexPlan(pageCount, opts);
  if (built.plan.length === 0) {
    post({
      type: "error",
      runId,
      code: "tool.errorCorrupt",
      detail: file.name,
    });
    return;
  }
  if (!built.changed) {
    // 1–2 pages (or a degenerate arrangement) — collation is a no-op, and
    // the honest refusal beats shipping an identical copy.
    post({
      type: "error",
      runId,
      code: "tool.errorNothingToDo",
      detail: undefined,
    });
    return;
  }

  // Translate the pure plan into organize entries (blank backs reuse the
  // matching front's MediaBox).
  const plan: PlanEntry[] = built.plan.map((entry) =>
    entry.kind === "page"
      ? { kind: "page", src: entry.src }
      : { kind: "blank-from", src: entry.likeSrc },
  );

  post({ type: "progress", runId, pct: 40, stage: "processing" });
  let collated: Uint8Array;
  try {
    collated = organizePages(parsed, plan, (fraction, page) => {
      post({
        type: "progress",
        runId,
        pct: Math.round(40 + 50 * fraction),
        stage: "processing",
        detail: { page, pages: plan.length },
      });
    });
  } catch (error: unknown) {
    post({
      type: "error",
      runId,
      code: engineErrorCode(error),
      detail: undefined,
    });
    return;
  }

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${safeBaseName(file.name)}-collated.pdf`,
        mime: "application/pdf",
        blob: new Blob([collated as unknown as BlobPart], {
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
