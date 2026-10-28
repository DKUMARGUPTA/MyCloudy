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
  type NupOptions,
  displayDims,
  embedPlacement,
  planSheets,
  resolveNupOptions,
} from "./engine";

/**
 * Pages per sheet (N-up) — device-only worker (PRD §8.1).
 *
 * P6-h: runs 100% on OUR OWN PDF micro-engine (src/lib/own/pdf — zero
 * external code). Each selected page is embedded ONCE as a Form XObject
 * bounded by its CROP box (pdf-lib embedPage parity: BBox + origin
 * translation Matrix, decoded+joined content, own-or-inherited Resources
 * carried through the source-anchored copy path), and every sheet that
 * shows the page draws the SAME form object. The placement math is the
 * engine's /Rotate-aware anchor (tools/pages-per-sheet/engine.ts,
 * pinned by scripts/smoke-nup.ts): the composed `q · translate · rotate ·
 * scale · /PgN Do · Q` sequence reproduces pdf-lib's drawPage operators
 * exactly, and the border strokes reproduce its drawRectangle (stroke-only
 * + dash pattern reset). A page with NO /Contents (legal PDF) embeds as an
 * empty cell instead of failing the run. Never touches the network.
 */

const BORDER_COLOR = { r: 0.55, g: 0.55, b: 0.62 };
const BORDER_WIDTH = 0.5;

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

/** Typed run error — the message handler maps it to an i18n key 1:1. */
export class NupRunError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, detail?: string) {
    super(code);
    this.name = "NupRunError";
    this.code = code;
    this.detail = detail;
  }
}

export interface NupProgress {
  pct: number;
  stage: RunStage;
  detail?: StageDetail;
}

export interface NupRunResult {
  bytes: Uint8Array;
  sheets: number;
  pages: number;
}

/**
 * pdf-lib drawPage operator parity: q, translate, rotate, scale, /Form Do,
 * Q. The scale operands are RATIOS (target/form dims — pdf-lib's
 * xScale = width / embeddedPage.width), not absolute sizes: unlike image
 * XObjects (1 unit = 1 pixel at scale 1), a Form XObject lives in the source
 * page's point space already.
 */
function drawFormOps(
  form: ComposedForm,
  place: { x: number; y: number; width: number; height: number; rotate: number },
): string {
  const angle = (place.rotate * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const sx = form.width > 0 ? place.width / form.width : 0;
  const sy = form.height > 0 ? place.height / form.height : 0;
  return [
    "q",
    `1 0 0 1 ${pdfNumToString(place.x)} ${pdfNumToString(place.y)} cm`,
    `${pdfNumToString(cos)} ${pdfNumToString(sin)} ${pdfNumToString(-sin)} ${pdfNumToString(cos)} 0 0 cm`,
    `${pdfNumToString(sx)} 0 0 ${pdfNumToString(sy)} 0 0 cm`,
    `/${form.key} Do`,
    "Q",
  ].join("\n");
}

/**
 * pdf-lib drawRectangle(border-only) operator parity: stroking color, line
 * width, dash-pattern reset, then the translated rectangle path.
 */
function borderOps(
  cell: { x: number; y: number; w: number; h: number },
): string {
  const { r, g, b } = BORDER_COLOR;
  return [
    "q",
    `${pdfNumToString(r)} ${pdfNumToString(g)} ${pdfNumToString(b)} RG`,
    `${pdfNumToString(BORDER_WIDTH)} w`,
    "[] 0 d",
    `1 0 0 1 ${pdfNumToString(cell.x)} ${pdfNumToString(cell.y)} cm`,
    "0 0 m",
    `0 ${pdfNumToString(cell.h)} l`,
    `${pdfNumToString(cell.w)} ${pdfNumToString(cell.h)} l`,
    `${pdfNumToString(cell.w)} 0 l`,
    "h",
    "S",
    "Q",
  ].join("\n");
}

/**
 * The whole N-up pipeline, smoke-testable without a Worker. `onProgress`
 * receives real per-page progress; errors throw NupRunError with the i18n
 * key the UI should show.
 */
export async function runNup(
  bytes: Uint8Array,
  options: OptionValues,
  onProgress?: (progress: NupProgress) => void
): Promise<NupRunResult> {
  const opts: NupOptions = resolveNupOptions(options);

  let ctx: ComposeContext;
  try {
    ctx = ComposeContext.load(bytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new NupRunError("tool.errorEncrypted");
    }
    // A content filter the engine cannot decode (exotic LZW/RLE content
    // streams) refuses honestly rather than emitting a broken form.
    throw new NupRunError("tool.errorCorrupt");
  }
  // A "loaded" doc with no pages is just as unusable — corrupt.
  if (ctx.pageCount < 1) {
    throw new NupRunError("tool.errorCorrupt");
  }
  const indices = parsePageSpec(opts.pages, ctx.pageCount);
  if (indices === null || indices.length === 0) {
    throw new NupRunError("tool.errorInvalidPages", opts.pages);
  }

  // Embed every selected page once, bounded by its CROP box (the form's
  // unrotated dims; the placement math applies /Rotate when drawing). The
  // form object is REUSED for every sheet that shows the page — re-embedding
  // would bloat the file. A page with NO /Contents (legal PDF — e.g. blanks)
  // embeds as an empty cell instead of failing the whole run.
  const embedSpan = 34 / indices.length;
  const forms = new Map<
    number,
    { form: ComposedForm | null; rotation: number; view: { w: number; h: number } }
  >();
  for (let i = 0; i < indices.length; i += 1) {
    const index = indices[i];
    const page = ctx.pages[index]!;
    const view = {
      w: page.cropBox[2] - page.cropBox[0],
      h: page.cropBox[3] - page.cropBox[1],
    };
    const rotation = page.rotate;
    const form = ctx.hasContents(index) ? ctx.embedPage(index) : null;
    forms.set(index, { form, rotation, view });
    onProgress?.({
      pct: Math.round(8 + embedSpan * (i + 1)),
      stage: "processing",
      detail: { page: i + 1, pages: indices.length },
    });
  }

  // Sheet size drives off the first SELECTED page's display dims.
  const firstInfo = forms.get(indices[0]);
  const firstDisplay = firstInfo
    ? displayDims(firstInfo.rotation, firstInfo.view.w, firstInfo.view.h)
    : null;
  const plan = planSheets(indices.length, opts, firstDisplay);

  const sheetSpan = 50 / plan.sheets.length;
  for (const sheet of plan.sheets) {
    const ops: string[] = [];
    const usedForms: number[] = [];
    for (const cell of sheet.cells) {
      const info = forms.get(indices[cell.pageIndex]);
      if (!info) continue;
      if (info.form) {
        const place = embedPlacement(
          cell,
          info.form.width,
          info.form.height,
          info.rotation
        );
        ops.push(drawFormOps(info.form, place));
        usedForms.push(indices[cell.pageIndex]);
      }
      if (opts.borders) {
        ops.push(borderOps(cell));
      }
    }
    ctx.addSheet(plan.sheetW, plan.sheetH, ops.join("\n"), usedForms);
    onProgress?.({
      pct: Math.round(42 + sheetSpan * (sheet.index + 1)),
      stage: "processing",
      detail: { page: sheet.index + 1, pages: plan.sheets.length },
    });
  }

  onProgress?.({ pct: 95, stage: "saving" });
  try {
    const saved = ctx.write();
    return {
      bytes: saved,
      sheets: plan.sheets.length,
      pages: indices.length,
    };
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new NupRunError("tool.errorEncrypted");
    }
    throw new NupRunError("tool.errorCorrupt");
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

  const result = await runNup(bytes, options, (progress) => {
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
        name: `${safeBaseName(file.name)}-nup.pdf`,
        mime: "application/pdf",
        blob: new Blob([result.bytes as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: 1, pages: result.sheets },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    if (error instanceof NupRunError) {
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
