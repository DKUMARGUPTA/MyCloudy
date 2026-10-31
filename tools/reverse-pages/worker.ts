import {
  listPages,
  organizePages,
  parseForOrganize,
  PdfError,
  type PlanEntry,
} from "@/lib/own/pdf";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Reverse PDF pages worker (PHASE-1 Batch A): rebuilds each input PDF
 * with its page list reversed — last page first. Batch-capable: one
 * output per input file.
 *
 * Runs 100% on OUR OWN PDF micro-engine (src/lib/own/pdf — zero external
 * code, one typed parse per file, byte-exact content passthrough). No
 * re-rendering: the same page objects are re-emitted in the new order.
 * Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

/** The whole reverse pipeline, smoke-testable without a Worker. */
export async function runReverse(
  bytes: Uint8Array,
  onProgress?: (pct: number) => void
): Promise<Uint8Array> {
  let parsed: ReturnType<typeof parseForOrganize>;
  try {
    parsed = parseForOrganize(bytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }
  const pageCount = parsed.pages.length;
  if (pageCount < 1) {
    throw new Error("tool.errorCorrupt");
  }

  const plan: PlanEntry[] = [];
  for (let i = pageCount - 1; i >= 0; i -= 1) {
    plan.push({ kind: "page", src: i });
    onProgress?.(Math.round(10 + (plan.length / pageCount) * 80));
  }

  try {
    return organizePages(parsed, plan);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }
}

/** Cheap page count of the output (parse once, list only). */
function countPages(bytes: Uint8Array): number {
  try {
    return listPages(parseForOrganize(bytes)).length;
  } catch {
    return 0;
  }
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, files } = request;
  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const outputs: Array<{
    name: string;
    mime: string;
    blob: Blob;
  }> = [];
  let totalPages = 0;
  let done = 0;
  for (const file of files) {
    post({
      type: "progress",
      runId,
      pct: Math.max(4, Math.round((done / files.length) * 100)),
      stage: "reading",
    });
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      post({ type: "error", runId, code: "tool.errorCorrupt" });
      return;
    }
    let saved: Uint8Array;
    try {
      saved = await runReverse(bytes, (pct) => {
        post({
          type: "progress",
          runId,
          pct: Math.round(4 + ((done + pct / 100) / files.length) * 92),
          stage: "processing",
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt";
      post({ type: "error", runId, code });
      return;
    }
    totalPages += countPages(saved);
    outputs.push({
      name: `${safeBaseName(file.name)}-reversed.pdf`,
      mime: "application/pdf",
      blob: new Blob([saved as unknown as BlobPart], {
        type: "application/pdf",
      }),
    });
    done += 1;
  }

  post({ type: "progress", runId, pct: 98, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: totalPages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
