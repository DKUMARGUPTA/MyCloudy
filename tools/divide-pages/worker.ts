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
  type DivideOptions,
  type PageBox,
  divideCellBox,
  planDivide,
  resolveDivideOptions,
} from "./engine";

/**
 * Divide PDF pages worker (PHASE-1 Batch A): every selected page becomes
 * a columns × rows grid of output pages, each the same source page
 * windowed to its cell (MediaBox/CropBox override — the halve route).
 * Content is never re-rendered; the shared content stream stays lossless.
 *
 * Runs 100% on OUR OWN PDF micro-engine. Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

export interface DivideProgress {
  pct: number;
  stage: RunStage;
  detail?: StageDetail;
}

export interface DivideRunResult {
  bytes: Uint8Array;
  pages: number;
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
 * Own-dict overrides for one output piece: MediaBox + CropBox set to the
 * cell box, optional Bleed/Trim/Art boxes clamped inside it (same
 * clamping policy as the halve route — absent/unreadable stay alone).
 */
function cellOverrides(
  page: { mediaBox: [number, number, number, number] },
  box: PageBox
): Array<[string, PdfObj]> {
  const set: Array<[string, PdfObj]> = [
    ["MediaBox", boxObj(box)],
    ["CropBox", boxObj(box)],
  ];
  for (const key of ["BleedBox", "TrimBox", "ArtBox"] as const) {
    const raw = (page as unknown as Record<string, unknown>)[key] as
      | [number, number, number, number]
      | undefined;
    if (!raw || raw.length !== 4) continue;
    const x0 = Math.max(raw[0], box.x);
    const y0 = Math.max(raw[1], box.y);
    const x1 = Math.min(raw[2], box.x + box.width);
    const y1 = Math.min(raw[3], box.y + box.height);
    if (x1 - x0 >= 0.01 && y1 - y0 >= 0.01) {
      set.push([
        key,
        {
          k: "arr",
          items: [
            { k: "num", n: x0 },
            { k: "num", n: y0 },
            { k: "num", n: x1 },
            { k: "num", n: y1 },
          ],
        },
      ]);
    }
  }
  return set;
}

/**
 * The whole dividing pipeline, smoke-testable without a Worker.
 * Errors throw Error with an i18n key the UI shows.
 */
export async function runDivide(
  bytes: Uint8Array,
  options: OptionValues,
  onProgress?: (progress: DivideProgress) => void
): Promise<DivideRunResult> {
  const opts: DivideOptions = resolveDivideOptions(options);
  if (opts.columns < 1 || opts.rows < 1 || opts.columns * opts.rows < 2) {
    throw new Error("dv.errorGrid");
  }

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

  const entries = planDivide(indices, opts);

  const plan: PlanEntry[] = entries.map((entry, i) => {
    const page = parsed.pages[entry.sourceIndex]!;
    const view: PageBox = {
      x: page.cropBox[0],
      y: page.cropBox[1],
      width: page.cropBox[2] - page.cropBox[0],
      height: page.cropBox[3] - page.cropBox[1],
    };
    const box = divideCellBox(
      view,
      page.rotate,
      opts.columns,
      opts.rows,
      entry.col,
      entry.row
    );
    onProgress?.({
      pct: Math.round(8 + (84 / entries.length) * (i + 1)),
      stage: "processing",
      detail: { page: i + 1, pages: entries.length },
    });
    return {
      kind: "page" as const,
      src: entry.sourceIndex,
      set: cellOverrides(page, box),
    };
  });

  onProgress?.({ pct: 95, stage: "saving" });
  try {
    const saved = organizePages(parsed, plan);
    return { bytes: saved, pages: entries.length };
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

  post({ type: "progress", runId, pct: 4, stage: "reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  let result: DivideRunResult;
  try {
    result = await runDivide(bytes, options, (progress) => {
      post({ type: "progress", runId, ...progress });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^dv\.|^tool\./.test(message)
      ? message
      : /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt";
    post({ type: "error", runId, code });
    return;
  }

  const outputs = [
    {
      name: `${safeBaseName(file.name)}-divided.pdf`,
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
