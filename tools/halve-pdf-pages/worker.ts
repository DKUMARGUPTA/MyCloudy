import {
  asBox,
  organizePages,
  parseForOrganize,
  PdfError,
  type PdfObj,
  type PlanEntry,
} from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type RunStage,
  type StageDetail,
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  type HalveOptions,
  type PageBox,
  halveBoxes,
  planHalves,
  resolveHalveOptions,
} from "./engine";

/**
 * Halve PDF pages — device-only worker (PRD §8.1: "Cut scanned book
 * spreads into left/right single pages"). For every selected page it
 * emits two copies whose MediaBox AND CropBox are the planned halves —
 * the cut is defined in DISPLAY space by the engine (tools/halve-pdf-
 * pages/engine.ts), so a vertical cut of a /Rotate 90 page slices the
 * unrotated box on the other axis, exactly what the reader sees. Content
 * is never re-rendered: the same page objects are re-windowed, so text
 * and vectors stay lossless. Never touches the network.
 *
 * P6-h: runs 100% on OUR OWN PDF micro-engine (src/lib/own/pdf — zero
 * external code). The two halves are independent copies of the source
 * page (each plan entry gets its own cloned dict with its own box set),
 * while the shared content stream is written once. View boxes and
 * rotation come from the engine's own inheritance-aware page tree walk,
 * and every copied page materializes its inherited attributes
 * (MediaBox/CropBox/Rotate/Resources) so nothing is lost when the
 * rebuilt tree drops /Parent — pdf-lib copyPages parity.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

/** Typed run error — the message handler maps it to an i18n key 1:1. */
export class HalveRunError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, detail?: string) {
    super(code);
    this.name = "HalveRunError";
    this.code = code;
    this.detail = detail;
  }
}

export interface HalveProgress {
  pct: number;
  stage: RunStage;
  detail?: StageDetail;
}

export interface HalveRunResult {
  bytes: Uint8Array;
  /** Number of OUTPUT pages (2 per selected page). */
  pages: number;
}

/** Intersect two user-space boxes; null when the overlap is empty. */
function intersectBoxes(a: PageBox, b: PageBox): PageBox | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 - x0 < 0.01 || y1 - y0 < 0.01) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** box → [x0 y0 x1 y1] array object for a page-dict override. */
function boxObj(box: PageBox): PdfObj {
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

/**
 * Own-dict overrides for one output copy: MediaBox + CropBox set to the
 * planned box, optional Bleed/Trim/Art boxes clamped so they never stick
 * out of the new half (absent or unreadable entries are left alone — the
 * CropBox governs the visible area anyway). Reads the page's OWN optional
 * boxes only, matching the pdf-lib-era reads (node.BleedBox() etc.).
 */
function halfOverrides(
  page: { dict: Map<string, PdfObj> },
  half: PageBox,
): Array<[string, PdfObj]> {
  const set: Array<[string, PdfObj]> = [
    ["MediaBox", boxObj(half)],
    ["CropBox", boxObj(half)],
  ];
  const clamp = (key: string): void => {
    const existing = asBox(page.dict.get(key));
    if (existing === undefined) return;
    const box: PageBox = {
      x: existing[0],
      y: existing[1],
      width: existing[2] - existing[0],
      height: existing[3] - existing[1],
    };
    set.push([key, boxObj(intersectBoxes(box, half) ?? half)]);
  };
  clamp("BleedBox");
  clamp("TrimBox");
  clamp("ArtBox");
  return set;
}

/**
 * The whole halving pipeline, smoke-testable without a Worker. `onProgress`
 * receives real per-output-page progress; errors throw HalveRunError with
 * the i18n key the UI should show (same keys the N-up worker uses).
 */
export async function runHalve(
  bytes: Uint8Array,
  options: OptionValues,
  onProgress?: (progress: HalveProgress) => void
): Promise<HalveRunResult> {
  const opts: HalveOptions = resolveHalveOptions(options);

  let parsed: ReturnType<typeof parseForOrganize>;
  try {
    parsed = parseForOrganize(bytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new HalveRunError("tool.errorEncrypted");
    }
    throw new HalveRunError("tool.errorCorrupt");
  }
  // A parsed doc with no pages is just as unusable — corrupt.
  if (parsed.pages.length < 1) {
    throw new HalveRunError("tool.errorCorrupt");
  }
  const indices = parsePageSpec(opts.pages, parsed.pages.length);
  if (indices === null || indices.length === 0) {
    throw new HalveRunError("tool.errorInvalidPages", opts.pages);
  }

  const entries = planHalves(indices, opts);

  // The halves are planned from the source pages' VIEW boxes (CropBox,
  // inherited-aware) + effective /Rotate — one source of truth, then each
  // output copy is windowed to its half via its own dict overrides.
  const plan: PlanEntry[] = entries.map((entry, i) => {
    const page = parsed.pages[entry.sourceIndex]!;
    const view: PageBox = {
      x: page.cropBox[0],
      y: page.cropBox[1],
      width: page.cropBox[2] - page.cropBox[0],
      height: page.cropBox[3] - page.cropBox[1],
    };
    const box =
      entry.half === "whole"
        ? view
        : halveBoxes(view, page.rotate, opts)[entry.half];
    onProgress?.({
      pct: Math.round(8 + (84 / entries.length) * (i + 1)),
      stage: "processing",
      detail: { page: i + 1, pages: entries.length },
    });
    return { kind: "page" as const, src: entry.sourceIndex, set: halfOverrides(page, box) };
  });

  onProgress?.({ pct: 95, stage: "saving" });
  try {
    const saved = organizePages(parsed, plan);
    return { bytes: saved, pages: entries.length };
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new HalveRunError("tool.errorEncrypted");
    }
    throw new HalveRunError("tool.errorCorrupt");
  }
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 4, stage: "reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  const result = await runHalve(bytes, options, (progress) => {
    post({
      type: "progress",
      runId,
      pct: progress.pct,
      stage: progress.stage,
      detail: progress.detail,
    });
  });

  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${safeBaseName(file.name)}-halved.pdf`,
        mime: "application/pdf",
        blob: new Blob([result.bytes as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: 1, pages: result.pages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    if (error instanceof HalveRunError) {
      post({ type: "error", runId: data.runId, code: error.code, detail: error.detail });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const code = /encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code, detail: undefined });
  });
};
