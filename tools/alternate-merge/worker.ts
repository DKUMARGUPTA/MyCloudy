import {
  PdfError,
  organizeMerge,
  parseForOrganize,
  type MergePlanEntry,
  type OrganizeSource,
} from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Alternate merge worker (R50) — interleaves exactly two PDFs page by
 * page (A1, B1, A2, B2…) through the shared own-engine organize path
 * with byte-exact content passthrough.
 *
 * Options: which file leads, and how the longer file's leftover pages
 * are handled (append at the end vs blank-pad to keep the weave).
 * Typed refusal for encrypted/corrupt inputs; real progress per page;
 * the PDFs never leave the device.
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

interface AltMergeOptions {
  lead: 0 | 1;
  blankPad: boolean;
}

function resolveOptions(options: OptionValues): AltMergeOptions {
  const lead: 0 | 1 = options.lead === "second" ? 1 : 0;
  const blankPad = options.tail === "blank";
  return { lead, blankPad };
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  if (files.length < 2) {
    post({ type: "error", runId, code: "tool.errorNeedTwoFiles" });
    return;
  }
  const alt = resolveOptions(options);

  post({ type: "progress", runId, pct: 5, stage: "reading" });
  const sources: OrganizeSource[] = [];
  for (let i = 0; i < 2; i += 1) {
    const file = files[i]!;
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
    post({ type: "progress", runId, pct: 5 + (i + 1) * 8, stage: "reading" });
  }

  const counts = [sources[0]!.pages.length, sources[1]!.pages.length];
  if (counts[0] === 0 || counts[1] === 0) {
    post({ type: "error", runId, code: "tool.errorNothingToDo" });
    return;
  }

  // Weave order: A B A B… where A = the leading file.
  const [a, b] = alt.lead === 0 ? [0, 1] : [1, 0];
  const plan: MergePlanEntry[] = [];
  const maxLen = Math.max(counts[a]!, counts[b]!);
  for (let i = 0; i < maxLen; i += 1) {
    if (i < counts[a]!) {
      plan.push({ kind: "page", doc: a, src: i });
    } else if (alt.blankPad && i < counts[b]!) {
      plan.push({ kind: "blank-from", doc: b, src: Math.max(0, i - 1) });
    }
    if (i < counts[b]!) {
      plan.push({ kind: "page", doc: b, src: i });
    } else if (alt.blankPad && i + 1 < maxLen && i < counts[a]!) {
      plan.push({ kind: "blank-from", doc: b, src: Math.max(0, counts[b]! - 1) });
    }
  }

  if (plan.length === 0) {
    post({ type: "error", runId, code: "tool.errorNothingToDo" });
    return;
  }

  post({ type: "progress", runId, pct: 25, stage: "processing" });
  let merged: Uint8Array;
  try {
    merged = organizeMerge(sources, plan, (fraction, page) => {
      post({
        type: "progress",
        runId,
        pct: Math.round(25 + 65 * fraction),
        stage: "processing",
        detail: { page, pages: plan.length },
      });
    });
  } catch (error: unknown) {
    post({ type: "error", runId, code: engineErrorCode(error), detail: undefined });
    return;
  }

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  const firstName = safeBaseName(files[a]!.name);
  const secondName = safeBaseName(files[b]!.name);
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${firstName}-${secondName}-alternating.pdf`.slice(0, 140),
        mime: "application/pdf",
        blob: new Blob([merged as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: 2, pages: plan.length },
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
