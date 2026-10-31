import {
  organizePages,
  parseForOrganize,
  PdfError,
  type PlanEntry,
} from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Add blank page worker (PHASE-1 Batch A): inserts 1..100 empty pages at
 * the start / end / after page N, sized like page 1, the largest page,
 * A4 or US Letter.
 *
 * Runs 100% on OUR OWN PDF micro-engine — the organize writer's native
 * blank plan entries author truly empty pages (no raster, no fonts).
 * Never touches the network.
 */

const A4: [number, number] = [595.28, 841.89];
const LETTER: [number, number] = [612, 792];

export interface BlankOptions {
  position: "start" | "end" | "after";
  afterPage: number;
  count: number;
  size: "page1" | "largest" | "a4" | "letter";
}

function resolveOptions(values: OptionValues): BlankOptions {
  const positionRaw = values.position;
  const afterRaw = Number(values.afterPage);
  const countRaw = Number(values.count);
  const sizeRaw = values.size;
  return {
    position:
      positionRaw === "start" || positionRaw === "after"
        ? positionRaw
        : "end",
    afterPage:
      Number.isFinite(afterRaw) && afterRaw >= 1
        ? Math.floor(afterRaw)
        : 1,
    count:
      Number.isFinite(countRaw) && countRaw >= 1 && countRaw <= 100
        ? Math.floor(countRaw)
        : 1,
    size:
      sizeRaw === "largest" || sizeRaw === "a4" || sizeRaw === "letter"
        ? sizeRaw
        : "page1",
  };
}

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

export interface BlankRunResult {
  bytes: Uint8Array;
  pages: number;
  blanks: number;
}

/** The whole insert pipeline, smoke-testable without a Worker. */
export async function runAddBlank(
  bytes: Uint8Array,
  options: OptionValues
): Promise<BlankRunResult> {
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
  const pageCount = parsed.pages.length;
  if (pageCount < 1) {
    throw new Error("tool.errorCorrupt");
  }

  // Clamp "after page" into 1..pageCount (the UI bounds it too —
  // defensive parity with the worker-defaults rule).
  const after = Math.min(Math.max(opts.afterPage, 1), pageCount);

  // Blank size from the chosen source.
  let width = A4[0];
  let height = A4[1];
  if (opts.size === "a4") {
    width = A4[0];
    height = A4[1];
  } else if (opts.size === "letter") {
    width = LETTER[0];
    height = LETTER[1];
  } else {
    let pick = 0;
    if (opts.size === "page1") {
      pick = 0;
    } else {
      let best = -1;
      for (let i = 0; i < pageCount; i += 1) {
        const box = parsed.pages[i]!.mediaBox;
        const area = (box[2] - box[0]) * (box[3] - box[1]);
        if (area > best) {
          best = area;
          pick = i;
        }
      }
    }
    const box = parsed.pages[pick]!.mediaBox;
    width = box[2] - box[0];
    height = box[3] - box[1];
  }

  const plan: PlanEntry[] = [];
  const insertAt =
    opts.position === "start" ? 0 : opts.position === "end" ? pageCount : after;
  // "start" inserts BEFORE the loop; "after page N" (and "end" ==
  // after-last) inserts when the loop passes page N — the loop's last
  // iteration (i + 1 === pageCount) covers the end position exactly once.
  if (opts.position === "start") {
    for (let b = 0; b < opts.count; b += 1) {
      plan.push({ kind: "blank", width, height });
    }
  }
  for (let i = 0; i < pageCount; i += 1) {
    plan.push({ kind: "page", src: i });
    if (opts.position !== "start" && i + 1 === insertAt) {
      for (let b = 0; b < opts.count; b += 1) {
        plan.push({ kind: "blank", width, height });
      }
    }
  }

  try {
    const saved = organizePages(parsed, plan);
    return { bytes: saved, pages: plan.length, blanks: opts.count };
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
  let result: BlankRunResult;
  try {
    result = await runAddBlank(bytes, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId, code });
    return;
  }

  post({ type: "progress", runId, pct: 94, stage: "saving" });
  const outputs = [
    {
      name: `${safeBaseName(file.name)}-with-blanks.pdf`,
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
