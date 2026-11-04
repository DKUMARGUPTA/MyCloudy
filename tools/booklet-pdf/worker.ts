import {
  PdfError,
  organizePages,
  parseForOrganize,
  type PlanEntry,
} from "@/lib/own/pdf";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Booklet PDF — device-only worker.
 *
 * Runs 100% on OUR OWN PDF micro-engine (src/lib/own/pdf). Saddle-stitch
 * imposition: the page count is padded with trailing blanks to a multiple
 * of 4, then pages are re-ordered so a duplex "2 pages per sheet, flip on
 * short edge" print folds straight into a booklet:
 *
 *   sheet s (0-based): front = [n−2s, 2s+1], back = [2s+2, n−2s−1]
 *   flat order: n, 1, 2, n−1, n−2, 3, 4, n−3, …
 *
 * Page content passes through byte-exact; only the order (plus padding
 * blanks) changes. Typed error codes; never touches the network.
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

/**
 * Saddle-stitch imposition order (1-based page numbers, padded count n).
 * Kept as a pure function so a smoke test can pin the classic sequence:
 * n=8 → 8,1,2,7,6,3,4,5.
 */
export function bookletOrder(n: number): number[] {
  const out: number[] = [];
  const sheets = n / 4;
  for (let s = 0; s < sheets; s += 1) {
    out.push(n - 2 * s, 2 * s + 1, 2 * s + 2, n - (2 * s + 1));
  }
  return out;
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
    post({ type: "error", runId, code: "tool.errorNothingToDo", detail: undefined });
    return;
  }

  // Pad to a multiple of 4 with trailing blanks sized like the last page.
  const padded = Math.ceil(pageCount / 4) * 4;
  const order = bookletOrder(padded);

  const plan: PlanEntry[] = [];
  for (const oneBased of order) {
    const index = oneBased - 1;
    if (index < pageCount) {
      plan.push({ kind: "page", src: index });
    } else {
      // Padding blank — same size as the last real page.
      plan.push({ kind: "blank-from", src: pageCount - 1 });
    }
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
        name: `${safeBaseName(file.name)}-booklet.pdf`,
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
