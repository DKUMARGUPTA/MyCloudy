import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

import {
  MAX_INPUT_BYTES,
  PdfaError,
  analyzePdfa,
  buildReportText,
  outputBaseName,
  parseRun,
  sniffPdfBytes,
} from "./model";
import type { PdfaReport, ValidatePdfaDetail } from "./types";

/**
 * Validate PDF/A worker (RB7-b, device mode) — the honest conformance
 * checker. The whole pipeline is PURE in model.ts (bun-smoke-tested);
 * this file is only the I/O boundary:
 *
 *  1. read the File, sniff the %PDF- magic (the surface preview uses
 *     its own local sniff — preview and run can never disagree);
 *  2. the 64 MB sanity gate;
 *  3. analyzePdfa(bytes, level): the raw xref/trailer walk with the
 *     linear object-scan + object-stream recovery, the pages tree, the
 *     inflated content streams, the fonts/XMP/OutputIntent checks and
 *     the verdict (see model.ts for the honest rule list);
 *  4. the result is a deterministic plain-text conformance report (.txt)
 *     + the full PdfaReport in the run detail so the surface renders
 *     the grouped check cards without re-parsing anything.
 *
 * Error mapping:
 *   vpa.errNotPdf        no %PDF- magic anywhere near the head
 *   vpa.errTooBig        beyond the 64 MB sanity gate
 *   tool.errorCorrupt    %PDF- present but nothing walkable (no catalog)
 *   tool.errorGeneric    no file / unexpected failure
 *
 * Device-only: the File arrives by structured clone, the report Blob
 * goes back — nothing touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const opts = parseRun(String(request.options.run ?? ""));
  post({ type: "progress", runId, pct: 15, stage: "reading" });

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_INPUT_BYTES) {
    post({ type: "error", runId, code: "vpa.errTooBig", detail: file.name });
    return;
  }
  if (!sniffPdfBytes(bytes)) {
    post({ type: "error", runId, code: "vpa.errNotPdf", detail: file.name });
    return;
  }

  post({ type: "progress", runId, pct: 40, stage: "processing" });

  let report: PdfaReport;
  try {
    report = analyzePdfa(bytes, opts.level);
  } catch (error) {
    if (error instanceof PdfaError) {
      const code = error.code === "errCorrupt" ? "tool.errorCorrupt" : `vpa.${error.code}`;
      post({ type: "error", runId, code, detail: error.message });
      return;
    }
    post({
      type: "error",
      runId,
      code: "tool.errorCorrupt",
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  post({ type: "progress", runId, pct: 80, stage: "processing" });

  const passed = report.checks.filter((c) => c.status === "pass").length;
  const warned = report.checks.filter((c) => c.status === "warn").length;
  const failed = report.checks.filter((c) => c.status === "fail").length;

  const text = buildReportText(
    report,
    { fileName: file.name, bytes: bytes.length },
    opts.labels
  );
  post({ type: "progress", runId, pct: 92, stage: "saving" });

  const name = `${outputBaseName(file.name, opts.locale, opts.fileWord)}-pdfa-report.txt`;
  const detail: ValidatePdfaDetail = {
    files: 1,
    verdict: report.verdict,
    checksPassed: passed,
    checksWarned: warned,
    checksFailed: failed,
    level: report.effectiveLevel,
    declaredLevel: report.declaredLevel,
    detectedLevel: report.detectedLevel,
    recovered: report.recoveryUsed,
    report,
  };

  post({
    type: "result",
    runId,
    outputs: [
      {
        name,
        mime: "text/plain;charset=utf-8",
        blob: new Blob([text], { type: "text/plain;charset=utf-8" }),
      },
    ],
    detail,
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    post({
      type: "error",
      runId: data.runId,
      code: "tool.errorGeneric",
      detail: error instanceof Error ? error.message : String(error),
    });
  });
};
