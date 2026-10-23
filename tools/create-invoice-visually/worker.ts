import {
  type RunDetail,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { classifyError, outputName, parseCanvasRun } from "./model";
import { renderCanvasPdf } from "./render";

/**
 * Create invoice visually worker (RB5-a) — device-only, zero network
 * beyond the same-origin Noto font. The create-invoice/resume worker
 * protocol:
 *
 *  1. parseCanvasRun — full defensive coercion at the boundary (clamp
 *     arrays, strip control chars, dedupe ids, cap lengths, drop
 *     broken data URLs);
 *  2. renderCanvasPdf — fonts (needsNoto → embedded Noto subset, else
 *     base-14 Helvetica with NOTHING embedded), the pure command list
 *     built with the REAL font metrics, executed, saved;
 *  3. one output: <docNumber | invoice-date>.pdf, always exactly
 *     1 page (fixed A4 portrait — the honest scope of this tool).
 *
 * All display labels arrive pre-resolved in `labels` (the surface's
 * t()), so the PDF text matches the UI language exactly.
 */

/**
 * Additive per-tool detail fields (the RB1 precedent: pdf-to-word grew
 * +paragraphs the same way). protocol.ts is orchestrator-owned, so the
 * extension lives here — structurally still a RunDetail.
 */
interface CanvasRunDetail extends RunDetail {
  /** Elements in the run (edit-pdf's `objects` carries the command count). */
  elementCount?: number;
  /** "noto" = Noto subset embedded, "helvetica" = nothing embedded. */
  fontsEmbedded?: string;
}

async function run(request: WorkerRunRequest): Promise<void> {
  const runId = request.runId;
  const post = (msg: WorkerResponse): void => {
    (self as unknown as Worker).postMessage(msg);
  };
  try {
    const canvas = parseCanvasRun(String(request.options.canvas ?? ""));
    post({ type: "progress", runId, pct: 20, stage: "processing" });
    post({ type: "progress", runId, pct: 45, stage: "processing" });

    const { bytes, report } = await renderCanvasPdf(canvas);
    post({ type: "progress", runId, pct: 85, stage: "saving" });

    const detail: CanvasRunDetail = {
      pages: 1, // fixed A4 portrait, single page — the honest scope
      objects: report.commandCount,
      images: report.images,
      elementCount: report.elementCount,
      fontsEmbedded: report.font,
    };
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${outputName(canvas.d)}.pdf`,
          mime: "application/pdf",
          blob: new Blob([bytes as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail,
    });
  } catch (error) {
    post({
      type: "error",
      runId,
      code: classifyError(error),
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  if (event.data?.type === "run") void run(event.data);
};
