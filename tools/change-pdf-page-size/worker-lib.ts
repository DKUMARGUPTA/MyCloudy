import { PDFDocument, degrees, type PDFEmbeddedPage } from "pdf-lib";

import type { OptionValues } from "@/lib/tools/config-types";
import {
  type RunStage,
  type StageDetail,
  parsePageSpec,
} from "@/lib/workers/protocol";
import {
  type PageSizeOptions,
  type PageSizePageOutcome,
  buildPageSizeReport,
  pageDisplayDims,
  pageNeedsChange,
  resizePlacement,
  resolvePageSizeOptions,
  targetSizePt,
} from "./engine";

/**
 * Change PDF page size — the shared pipeline (worker + smoke import the
 * same function, so the test exercises exactly what ships; the overlay/cts
 * worker-lib precedent).
 *
 * Every SELECTED page lands on a fresh target-size page — A3/A4/A5/Letter/
 * Legal/custom mm, portrait / landscape / auto, content fit / fill /
 * unchanged — while pages that are already at the target are copied
 * byte-identically, so their links, form fields and comments survive
 * untouched. On-device, pdf-lib only, zero network.
 *
 * Pipeline (the n-up precedent): pages needing a change are embedded as
 * Form XObjects bounded by their CROP box (pdf-lib's embedPage does NOT
 * apply /Rotate — resizePlacement's corner-anchor math does), drawn
 * centered with the chosen scale mode. Unchanged runs are copied in batches.
 */

/** Typed run error — the worker message handler maps it to an i18n key 1:1. */
export class PageSizeRunError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, detail?: string) {
    super(code);
    this.name = "PageSizeRunError";
    this.code = code;
    this.detail = detail;
  }
}

export interface PageSizeProgress {
  pct: number;
  stage: RunStage;
  detail?: StageDetail;
}

export interface PageSizeRunResult {
  bytes: Uint8Array;
  report: string;
  pages: number;
  resized: number;
}

/**
 * The whole page-size pipeline, smoke-testable without a Worker (the n-up
 * runNup precedent). `onProgress` receives real per-page progress; errors
 * throw PageSizeRunError with the i18n key the UI should show.
 */
export async function runPageSize(
  bytes: Uint8Array,
  fileName: string,
  options: OptionValues,
  onProgress?: (progress: PageSizeProgress) => void
): Promise<PageSizeRunResult> {
  const opts: PageSizeOptions = resolvePageSizeOptions(options);

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
    throw new PageSizeRunError(
      /encrypt/i.test(message) ? "tool.errorEncrypted" : "tool.errorCorrupt"
    );
  }
  // A "loaded" doc with no pages is just as unusable — corrupt.
  if (pageCount < 1) {
    throw new PageSizeRunError("tool.errorCorrupt");
  }
  const selected = new Set(parsePageSpec(opts.pages, pageCount) ?? []);
  if (selected.size === 0) {
    throw new PageSizeRunError("tool.errorInvalidPages", opts.pages);
  }

  /* ---------------- Plan: per-page display, target, verdict ---------- */

  const outcomes: PageSizePageOutcome[] = [];
  const resize: { index: number }[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    const page = src.getPage(i);
    const view = page.getCropBox();
    const rotation = page.getRotation().angle;
    const display = pageDisplayDims(view, rotation);
    const isSelected = selected.has(i);
    const target = targetSizePt(opts, display);
    const needs = isSelected && pageNeedsChange(display, target);
    const scale = needs
      ? resizePlacement(target, view.width, view.height, rotation, opts.scale)
          .scale
      : 1;
    outcomes.push({
      page: i + 1,
      fromW: display.w,
      fromH: display.h,
      toW: needs ? target.w : display.w,
      toH: needs ? target.h : display.h,
      method: needs ? "resized" : isSelected ? "kept-size" : "kept-unselected",
      scale,
    });
    if (needs) resize.push({ index: i });
  }

  const resizedCount = resize.length;
  const report = buildPageSizeReport(opts, outcomes, fileName);

  // Fast path: nothing would change — hand the original bytes back untouched.
  if (resizedCount === 0) {
    onProgress?.({ pct: 96, stage: "saving" });
    return { bytes, report, pages: pageCount, resized: 0 };
  }

  /* ---------------- Build the output doc ----------------------------- */

  const out = await PDFDocument.create();
  const progressSpan = 84 / pageCount;
  let done = 0;

  const noteProgress = (): void => {
    done += 1;
    onProgress?.({
      pct: Math.round(10 + progressSpan * done),
      stage: "processing",
      detail: { page: done, pages: pageCount },
    });
  };

  // Consecutive unchanged pages are copied in ONE copyPages call (the
  // merge-pdf path preserves annotations, links, form fields byte-for-byte).
  // Changed pages are embedded bounded by their crop box and re-drawn.
  const embedPage = async (index: number): Promise<void> => {
    const page = src.getPage(index);
    const view = page.getCropBox();
    const rotation = page.getRotation().angle;
    const display = pageDisplayDims(view, rotation);
    const target = targetSizePt(opts, display);
    const hasContents = page.node.normalizedEntries().Contents !== undefined;
    const form: PDFEmbeddedPage | null = hasContents
      ? await out.embedPage(page, {
          left: view.x,
          bottom: view.y,
          right: view.x + view.width,
          top: view.y + view.height,
        })
      : null;
    const targetPage = out.addPage([target.w, target.h]);
    if (form) {
      const place = resizePlacement(
        target,
        form.width,
        form.height,
        rotation,
        opts.scale
      );
      targetPage.drawPage(form, {
        x: place.x,
        y: place.y,
        width: place.width,
        height: place.height,
        rotate: degrees(place.rotate),
      });
    }
    noteProgress();
  };

  const copyRun = async (from: number, to: number): Promise<void> => {
    const indices: number[] = [];
    for (let i = from; i <= to; i += 1) indices.push(i);
    const copied = await out.copyPages(src, indices);
    for (const page of copied) out.addPage(page);
    for (let i = from; i <= to; i += 1) noteProgress();
  };

  let runStart = -1;
  for (let i = 0; i < pageCount; i += 1) {
    if (outcomes[i].method === "resized") {
      if (runStart >= 0) {
        await copyRun(runStart, i - 1);
        runStart = -1;
      }
      await embedPage(i);
    } else if (runStart < 0) {
      runStart = i;
    }
  }
  if (runStart >= 0) {
    await copyRun(runStart, pageCount - 1);
  }

  onProgress?.({ pct: 96, stage: "saving" });
  const saved = await out.save({ useObjectStreams: true });
  return {
    bytes: saved,
    report,
    pages: pageCount,
    resized: resizedCount,
  };
}
