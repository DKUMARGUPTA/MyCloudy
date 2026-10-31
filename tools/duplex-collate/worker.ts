import {
  organizePages,
  parseForOrganize,
  PdfError,
  type PlanEntry,
} from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Duplex collate worker (PHASE-1 Batch C): reorders the selected pages
 * for manual double-sided printing — odds first, then evens (reversed in
 * the default "manual" mode) — on OUR OWN organize engine. Never touches
 * the network.
 */

export type DuplexMode = "manual" | "odd-even" | "even-odd";

export interface DuplexOptions {
  mode: DuplexMode;
  pages: string;
}

function resolveOptions(values: OptionValues): DuplexOptions {
  const modeRaw = values.mode;
  return {
    mode: modeRaw === "odd-even" || modeRaw === "even-odd" ? modeRaw : "manual",
    pages: typeof values.pages === "string" ? (values.pages as string) : "all",
  };
}

/** Build the collated order (0-based selected indices → output order). */
export function planDuplex(
  selected: readonly number[],
  mode: DuplexMode
): number[] {
  const odds: number[] = [];
  const evens: number[] = [];
  selected.forEach((value, i) => {
    // "Odd/even" by POSITION in the selection (1-based).
    if ((i + 1) % 2 === 1) {
      odds.push(value);
    } else {
      evens.push(value);
    }
  });
  switch (mode) {
    case "odd-even":
      return [...odds, ...evens];
    case "even-odd":
      return [...evens, ...odds];
    default:
      return [...odds, ...evens.reverse()];
  }
}

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

export interface DuplexRunResult {
  bytes: Uint8Array;
  pages: number;
}

/** The whole pipeline, smoke-testable without a Worker. */
export async function runDuplexCollate(
  bytes: Uint8Array,
  options: OptionValues
): Promise<DuplexRunResult> {
  const opts = resolveOptions(options);

  let parsed: ReturnType<typeof parseForOrganize>;
  try {
    parsed = parseForOrganize(bytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }
  if (parsed.pages.length < 1) {
    throw new Error("tool.errorCorrupt");
  }
  const indices = parsePageSpec(opts.pages, parsed.pages.length);
  if (indices === null || indices.length === 0) {
    throw new Error("tool.errorInvalidPages");
  }

  const order = planDuplex(indices, opts.mode);
  const plan: PlanEntry[] = order.map((src) => ({ kind: "page", src }));

  try {
    const saved = organizePages(parsed, plan);
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
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 8, stage: "reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  post({ type: "progress", runId, pct: 45, stage: "processing" });
  let result: DuplexRunResult;
  try {
    result = await runDuplexCollate(bytes, options);
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
  const outputs = [
    {
      name: `${safeBaseName(file.name)}-duplex.pdf`,
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
    detail: { files: 1, pages: result.pages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
