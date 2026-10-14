import { PDFDocument, type PDFPage } from "pdf-lib";

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

/**
 * Clamps one optional page box (Bleed/Trim/Art) so it never sticks out of
 * the new half. Absent or unreadable entries are left alone — the CropBox
 * governs the visible area anyway.
 */
function clampOptionalBox(
  page: PDFPage,
  half: PageBox,
  read: () => PageBox | undefined,
  write: (box: PageBox) => void
): void {
  let existing: PageBox | undefined;
  try {
    existing = read();
  } catch {
    return;
  }
  if (existing === undefined) return;
  write(intersectBoxes(existing, half) ?? half);
}

/** Windows a copied page down to one half (MediaBox + CropBox + clamps). */
function applyHalfBox(page: PDFPage, half: PageBox): void {
  page.setMediaBox(half.x, half.y, half.width, half.height);
  page.setCropBox(half.x, half.y, half.width, half.height);
  clampOptionalBox(
    page,
    half,
    () => page.node.BleedBox()?.asRectangle(),
    (box) => page.setBleedBox(box.x, box.y, box.width, box.height)
  );
  clampOptionalBox(
    page,
    half,
    () => page.node.TrimBox()?.asRectangle(),
    (box) => page.setTrimBox(box.x, box.y, box.width, box.height)
  );
  clampOptionalBox(
    page,
    half,
    () => page.node.ArtBox()?.asRectangle(),
    (box) => page.setArtBox(box.x, box.y, box.width, box.height)
  );
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
    throw new HalveRunError(
      /encrypt/i.test(message) ? "tool.errorEncrypted" : "tool.errorCorrupt"
    );
  }
  // A "loaded" doc with no pages is just as unusable — corrupt.
  if (pageCount < 1) {
    throw new HalveRunError("tool.errorCorrupt");
  }
  const indices = parsePageSpec(opts.pages, pageCount);
  if (indices === null || indices.length === 0) {
    throw new HalveRunError("tool.errorInvalidPages", opts.pages);
  }

  const entries = planHalves(indices, opts);

  // Each output page is an INDEPENDENT copy of its source page (verified:
  // pdf-lib returns fresh copies), so the two halves never share boxes.
  // The halves are planned from the SOURCE pages' view boxes + /Rotate —
  // pdf-lib's copier moves inherited entries onto the copied leaf, but
  // reading from the source keeps one source of truth.
  const srcPages = src.getPages();
  const planned = entries.map((entry) => {
    const source = srcPages[entry.sourceIndex];
    const halves = halveBoxes(
      source.getCropBox(),
      source.getRotation().angle,
      opts
    );
    return { box: halves[entry.half] };
  });

  const out = await PDFDocument.create();
  const copies = await out.copyPages(
    src,
    entries.map((entry) => entry.sourceIndex)
  );

  const span = 84 / entries.length;
  for (let i = 0; i < entries.length; i += 1) {
    const page = copies[i];
    applyHalfBox(page, planned[i].box);
    out.addPage(page);
    onProgress?.({
      pct: Math.round(8 + span * (i + 1)),
      stage: "processing",
      detail: { page: i + 1, pages: entries.length },
    });
  }

  onProgress?.({ pct: 95, stage: "saving" });
  const saved = await out.save({ useObjectStreams: true });
  return { bytes: saved, pages: entries.length };
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
