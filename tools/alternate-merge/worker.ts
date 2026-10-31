import {
  organizeMerge,
  parseForOrganize,
  PdfError,
  type MergePlanEntry,
  type OrganizeSource,
} from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Alternate & merge worker (PHASE-1 Batch B): round-robin page plan
 * through the engine's multi-document merge — A1, B1, A2, B2… until the
 * longest file is exhausted; leftovers kept at the end (or dropped).
 *
 * Runs 100% on OUR OWN PDF micro-engine (organizeMerge — one parse per
 * input). Never touches the network.
 */

export interface AlternateOptions {
  lead: "first" | "second";
  tail: "keep" | "drop";
}

function resolveOptions(values: OptionValues): AlternateOptions {
  return {
    lead: values.lead === "second" ? "second" : "first",
    tail: values.tail === "drop" ? "drop" : "keep",
  };
}

/** Build the round-robin plan (pure — smoke-tested directly). */
export function planAlternate(
  pageCounts: readonly number[],
  opts: AlternateOptions
): MergePlanEntry[] {
  const files = pageCounts.length;
  if (files < 2) {
    throw new Error("tool.errorGeneric");
  }
  // Order: leading file first. With 2 files the lead is A or B; with
  // more, "second" rotates the first file to the END (stable cycle).
  let order: number[];
  if (opts.lead === "second") {
    order = [...Array.from({ length: files - 1 }, (_, i) => i + 1), 0];
  } else {
    order = Array.from({ length: files }, (_, i) => i);
  }

  const plan: MergePlanEntry[] = [];
  const next = new Array<number>(files).fill(0);
  const total = pageCounts.reduce((a, b) => a + b, 0);
  const maxLen = Math.max(...pageCounts);

  for (let slot = 0; slot < maxLen; slot += 1) {
    for (const doc of order) {
      const src = next[doc]!;
      if (src < pageCounts[doc]!) {
        plan.push({ kind: "page", doc, src });
        next[doc] = src + 1;
      }
    }
    if (plan.length >= total) break;
  }

  // Leftovers: with `keep` the round-robin already appended them in
  // file order as each file ran dry (they simply stopped contributing
  // slots). With `drop`, remove any TAIL entries beyond the interleave
  // depth — i.e. keep only pages inside the first `minLen` slots.
  if (opts.tail === "drop") {
    const minLen = Math.min(...pageCounts);
    const kept: MergePlanEntry[] = [];
    const seen = new Array<number>(files).fill(0);
    for (const entry of plan) {
      if (entry.kind === "page" && seen[entry.doc]! < minLen) {
        kept.push(entry);
        seen[entry.doc]! += 1;
      }
    }
    return kept;
  }

  return plan;
}

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

export interface AlternateRunResult {
  bytes: Uint8Array;
  pages: number;
}

/** The whole pipeline, smoke-testable without a Worker. */
export async function runAlternate(
  inputs: Array<{ name: string; bytes: Uint8Array }>,
  options: OptionValues
): Promise<AlternateRunResult> {
  const opts = resolveOptions(options);
  if (inputs.length < 2) {
    throw new Error("tool.errorGeneric");
  }

  const sources: OrganizeSource[] = [];
  for (const input of inputs) {
    try {
      sources.push(parseForOrganize(input.bytes));
    } catch (error) {
      if (error instanceof PdfError && error.code === "encrypted") {
        throw new Error("tool.errorEncrypted");
      }
      throw new Error("tool.errorCorrupt");
    }
  }
  if (sources.some((s) => s.pages.length < 1)) {
    throw new Error("tool.errorCorrupt");
  }

  const plan = planAlternate(
    sources.map((s) => s.pages.length),
    opts
  );

  try {
    const saved = organizeMerge(sources, plan);
    return { bytes: saved, pages: plan.length };
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  if (files.length < 2) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 6, stage: "reading" });
  const inputs: Array<{ name: string; bytes: Uint8Array }> = [];
  for (const file of files) {
    try {
      inputs.push({
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
    } catch {
      post({ type: "error", runId, code: "tool.errorCorrupt" });
      return;
    }
    post({
      type: "progress",
      runId,
      pct: Math.round(6 + (inputs.length / files.length) * 40),
      stage: "reading",
    });
  }

  let result: AlternateRunResult;
  try {
    result = await runAlternate(inputs, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^tool\./.test(message)
      ? message
      : /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt";
    post({ type: "error", runId, code });
    return;
  }

  post({ type: "progress", runId, pct: 94, stage: "saving" });
  const first = safeBaseName(files[0]!.name);
  const second = safeBaseName(files[1]!.name);
  const outputs = [
    {
      name: `${first}-x-${second}-alternating.pdf`,
      mime: "application/pdf",
      blob: new Blob([result.bytes as unknown as BlobPart], {
        type: "application/pdf",
      }),
    },
  ];

  post({
    type: "result",
    runId,
    outputs,
    detail: { files: inputs.length, pages: result.pages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
