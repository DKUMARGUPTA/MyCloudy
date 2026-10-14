import { PDFDocument, degrees, rgb, type PDFEmbeddedPage } from "pdf-lib";

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
 * Pages per sheet (N-up) — device-only worker (PRD §8.1; pdf-lib, MIT).
 *
 * Embeds each selected page once (pdf-lib caches the form XObject) and
 * draws it into the planned grid cell. pdf-lib's embedPage does NOT apply
 * the source page's /Rotate, so the placement is rotated explicitly via the
 * engine's /Rotate-aware anchor math (scripts/smoke-nup.ts pins it). The
 * embedded bounding box is the page's CROP box — pdf-lib's default embed
 * uses the MediaBox with the origin discarded, which would both show
 * cropped-away content and mis-place pages whose MediaBox doesn't start at
 * (0,0). Never touches the network.
 */

const BORDER_COLOR = rgb(0.55, 0.55, 0.62);
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

  let src: PDFDocument;
  let pageCount: number;
  try {
    src = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    pageCount = src.getPageCount();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new NupRunError(
      /encrypt/i.test(message) ? "tool.errorEncrypted" : "tool.errorCorrupt"
    );
  }
  // A "loaded" doc with no pages is just as unusable — corrupt.
  if (pageCount < 1) {
    throw new NupRunError("tool.errorCorrupt");
  }
  const indices = parsePageSpec(opts.pages, pageCount);
  if (indices === null || indices.length === 0) {
    throw new NupRunError("tool.errorInvalidPages", opts.pages);
  }

  // Embed every selected page once, bounded by its CROP box (rotation-free
  // form dims; the placement math applies /Rotate when drawing). The form
  // object is REUSED for every sheet that shows the page — pdf-lib registers
  // a new XObject per embedPage call, so re-embedding would bloat the file.
  // A page with NO /Contents (legal PDF — e.g. pdf-lib-created blanks) would
  // fail deep inside save() (embedPage is lazy), so it is detected up front
  // and embeds as an empty cell instead of failing the whole run.
  const embedSpan = 34 / indices.length;
  const forms = new Map<
    number,
    { form: PDFEmbeddedPage | null; rotation: number; view: { w: number; h: number } }
  >();
  const out = await PDFDocument.create();
  for (let i = 0; i < indices.length; i += 1) {
    const index = indices[i];
    const page = src.getPage(index);
    const view = page.getCropBox();
    const rotation = page.getRotation().angle;
    const hasContents = page.node.normalizedEntries().Contents !== undefined;
    const form = hasContents
      ? await out.embedPage(page, {
          left: view.x,
          bottom: view.y,
          right: view.x + view.width,
          top: view.y + view.height,
        })
      : null;
    forms.set(index, {
      form,
      rotation,
      view: { w: view.width, h: view.height },
    });
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
    const target = out.addPage([plan.sheetW, plan.sheetH]);
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
        target.drawPage(info.form, {
          x: place.x,
          y: place.y,
          width: place.width,
          height: place.height,
          rotate: degrees(place.rotate),
        });
      }
      if (opts.borders) {
        target.drawRectangle({
          x: cell.x,
          y: cell.y,
          width: cell.w,
          height: cell.h,
          borderColor: BORDER_COLOR,
          borderWidth: BORDER_WIDTH,
        });
      }
    }
    onProgress?.({
      pct: Math.round(42 + sheetSpan * (sheet.index + 1)),
      stage: "processing",
      detail: { page: sheet.index + 1, pages: plan.sheets.length },
    });
  }

  onProgress?.({ pct: 95, stage: "saving" });
  const saved = await out.save({ useObjectStreams: true });
  return {
    bytes: saved,
    sheets: plan.sheets.length,
    pages: indices.length,
  };
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
