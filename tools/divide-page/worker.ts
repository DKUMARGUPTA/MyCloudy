import {
  asBox,
  PdfError,
  organizePages,
  parseForOrganize,
  type PdfObj,
  type PlanEntry,
} from "@/lib/own/pdf";
import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { divideBoxes, resolveDivideOptions } from "./engine";

/**
 * Divide PDF pages — device-only worker.
 *
 * Runs 100% on OUR OWN PDF micro-engine (src/lib/own/pdf). Each output
 * piece is the source page copied with a smaller MediaBox/CropBox window
 * (the halve route generalized to N pieces per axis, grid included) —
 * content streams pass through byte-exact, /Rotate-aware via the halve
 * engine's display→user math. Real progress per piece; typed error codes
 * for the UI's i18n toasts. Never touches the network.
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

/** box → [x0 y0 x1 y1] array object for a page-dict override. */
function boxObj(box: { x: number; y: number; width: number; height: number }): PdfObj {
  return {
    k: "arr",
    items: [
      { k: "num", n: box.x },
      { k: "num", n: box.y },
      { k: "num", n: box.x + box.width },
      { k: "num", n: box.y + box.height },
    ],
  };
}

/** Intersect two user-space boxes; the crop window when either is empty. */
function intersectBoxes(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number } | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 - x0 < 0.01 || y1 - y0 < 0.01) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Own-dict overrides for one piece: windowed MediaBox/CropBox + clamped boxes. */
function pieceOverrides(
  page: { dict: Map<string, PdfObj> },
  piece: { x: number; y: number; width: number; height: number }
): Array<[string, PdfObj]> {
  const set: Array<[string, PdfObj]> = [
    ["MediaBox", boxObj(piece)],
    ["CropBox", boxObj(piece)],
  ];
  const clamp = (key: string): void => {
    const existing = asBox(page.dict.get(key));
    if (existing === undefined) return;
    const box = {
      x: existing[0],
      y: existing[1],
      width: existing[2] - existing[0],
      height: existing[3] - existing[1],
    };
    set.push([key, boxObj(intersectBoxes(box, piece) ?? piece)]);
  };
  clamp("BleedBox");
  clamp("TrimBox");
  clamp("ArtBox");
  return set;
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

  const opts = resolveDivideOptions(options);
  const indices =
    opts.pages.trim() === "" || opts.pages.trim().toLowerCase() === "all"
      ? Array.from({ length: pageCount }, (_, i) => i)
      : parsePageSpec(opts.pages, pageCount);
  if (indices === null || indices.length === 0) {
    post({
      type: "error",
      runId,
      code: "tool.errorInvalidPages",
      detail: opts.pages,
    });
    return;
  }

  /* Per selected page: its piece boxes in user space (reading order).
   * Non-selected pages pass through whole. */
  const piecesPer = opts.axis === "grid" ? opts.pieces * opts.pieces : opts.pieces;
  const boxCache = new Map<number, { x: number; y: number; width: number; height: number }[]>();
  for (const index of indices) {
    const page = parsed.pages[index];
    if (!page) {
      post({
        type: "error",
        runId,
        code: "tool.errorInvalidPages",
        detail: `${index + 1} > ${pageCount}`,
      });
      return;
    }
    const [x0, y0, x1, y1] = page.cropBox;
    const view = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    if (view.width < 2 * piecesPer || view.height < 2 * piecesPer) {
      post({
        type: "error",
        runId,
        code: "tool.errorInvalidPages",
        detail: `page ${index + 1}`,
      });
      return;
    }
    boxCache.set(index, divideBoxes(view, page.rotate, opts));
  }

  const totalOut =
    (pageCount - indices.length) + indices.length * piecesPer;

  post({ type: "progress", runId, pct: 35, stage: "processing" });
  const plan: PlanEntry[] = [];
  const selectedSet = new Set(indices);
  for (let i = 0; i < pageCount; i += 1) {
    if (!selectedSet.has(i)) {
      plan.push({ kind: "page", src: i });
      continue;
    }
    const boxes = boxCache.get(i) ?? [];
    for (const piece of boxes) {
      plan.push({
        kind: "page",
        src: i,
        set: pieceOverrides(parsed.pages[i], piece),
      });
    }
  }

  let out: Uint8Array;
  try {
    out = organizePages(parsed, plan, (fraction, page) => {
      post({
        type: "progress",
        runId,
        pct: Math.round(35 + 55 * fraction),
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
        name: `${safeBaseName(file.name)}-divided.pdf`,
        mime: "application/pdf",
        blob: new Blob([out as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: 1, pages: totalOut },
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
