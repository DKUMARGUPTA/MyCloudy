import {
  ComposeContext,
  type ComposedForm,
  PdfError,
  pdfNumToString,
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
  type CspOptions,
  planSheet,
  resolveCspOptions,
} from "./engine";

/**
 * Combine to a single page worker (PHASE-1 Batch A): embeds every
 * selected page as a Form XObject (bounded by its crop box) and composes
 * ONE output sheet with all of them in the planned grid.
 *
 * Runs 100% on OUR OWN PDF micro-engine (ComposeContext — the same
 * embed-once/draw-many pipeline as Pages per sheet). Never touches the
 * network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

/**
 * pdf-lib drawPage operator parity (pages-per-sheet pattern): q ·
 * translate · rotate · scale · /PgN Do · Q. Scale operands are RATIOS
 * (target/form dims). /Rotate-aware: a 90° page swaps its effective
 * cell dims and is drawn rotated.
 */
function drawFormOps(
  form: ComposedForm,
  cell: { x: number; y: number; w: number; h: number },
  rotation: number
): string {
  const norm = ((((Math.round(rotation / 90) * 90) % 360) + 360) % 360) as
    | 0
    | 90
    | 180
    | 270;
  const swap = norm === 90 || norm === 270;
  const effW = swap ? form.height : form.width;
  const effH = swap ? form.width : form.height;
  const scale = Math.min(
    cell.w / Math.max(1, effW),
    cell.h / Math.max(1, effH)
  );
  const visW = effW * scale;
  const visH = effH * scale;
  // Centre inside the cell.
  const cx = cell.x + (cell.w - visW) / 2;
  const cy = cell.y + (cell.h - visH) / 2;
  const angle = (norm * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // The rotation happens around the placement origin; for 90/270 the
  // translate lands on the rotated corner (pdf-lib parity).
  let tx = cx;
  let ty = cy;
  if (norm === 90) {
    tx = cx + visW;
  } else if (norm === 180) {
    tx = cx + visW;
    ty = cy + visH;
  } else if (norm === 270) {
    ty = cy + visH;
  }
  const sx = form.width > 0 ? scale : 0;
  const sy = form.height > 0 ? scale : 0;
  return [
    "q",
    `1 0 0 1 ${pdfNumToString(tx)} ${pdfNumToString(ty)} cm`,
    `${pdfNumToString(cos)} ${pdfNumToString(sin)} ${pdfNumToString(-sin)} ${pdfNumToString(cos)} 0 0 cm`,
    `${pdfNumToString(sx)} 0 0 ${pdfNumToString(sy)} 0 0 cm`,
    `/${form.key} Do`,
    "Q",
  ].join("\n");
}

export interface CspProgress {
  pct: number;
  stage: RunStage;
  detail?: StageDetail;
}

export interface CspRunResult {
  bytes: Uint8Array;
  pages: number;
  placed: number;
}

/**
 * The whole pipeline, smoke-testable without a Worker. Errors throw
 * Error with an i18n key.
 */
export async function runCombineSingle(
  bytes: Uint8Array,
  options: OptionValues,
  onProgress?: (progress: CspProgress) => void
): Promise<CspRunResult> {
  const opts: CspOptions = resolveCspOptions(options);

  let ctx: ComposeContext;
  try {
    ctx = ComposeContext.load(bytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }
  if (ctx.pageCount < 1) {
    throw new Error("tool.errorCorrupt");
  }
  const indices = parsePageSpec(opts.pages, ctx.pageCount);
  if (indices === null || indices.length === 0) {
    throw new Error("tool.errorInvalidPages");
  }

  const first = ctx.pages[indices[0] ?? 0]!;
  const plan = planSheet(
    indices.length,
    opts,
    opts.paper === "match"
      ? {
          w: first.cropBox[2] - first.cropBox[0],
          h: first.cropBox[3] - first.cropBox[1],
        }
      : null
  );

  const opsParts: string[] = [];
  const formPages: number[] = [];
  indices.forEach((pageIndex, i) => {
    const cell = plan.cells[i]!;
    // Legal empty pages embed as empty cells.
    if (ctx.hasContents(pageIndex)) {
      const form = ctx.embedPage(pageIndex);
      opsParts.push(drawFormOps(form, cell, ctx.pages[pageIndex]!.rotate));
      formPages.push(pageIndex);
    }
    onProgress?.({
      pct: Math.round(10 + (80 / indices.length) * (i + 1)),
      stage: "processing",
      detail: { page: i + 1, pages: indices.length },
    });
  });

  ctx.addSheet(plan.width, plan.height, opsParts.join("\n"), formPages);

  onProgress?.({ pct: 94, stage: "saving" });
  try {
    const saved = ctx.write();
    return { bytes: saved, pages: 1, placed: indices.length };
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

  let result: CspRunResult;
  try {
    result = await runCombineSingle(bytes, options, (progress) => {
      post({ type: "progress", runId, ...progress });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^csp\.|^tool\./.test(message)
      ? message
      : /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt";
    post({ type: "error", runId, code });
    return;
  }

  const outputs = [
    {
      name: `${safeBaseName(file.name)}-single-page.pdf`,
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
    detail: { files: 1, pages: 1 },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
