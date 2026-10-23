import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

import {
  MAX_INPUT_BYTES,
  VerifyError,
  analyzeSignatures,
  buildReportText,
  outputBaseName,
  parseRun,
  sniffPdfBytes,
} from "./model";
import type { SignatureReport, VerifyDetail } from "./types";

/**
 * Verify PDF signatures worker (RB6, device mode) — the honest signature
 * analyzer. The whole pipeline is PURE in model.ts (bun-smoke-tested);
 * this file is only the I/O boundary:
 *
 *  1. read the File, sniff the %PDF- magic (surface preview uses the SAME
 *     sniffPdfBytes — preview and run can never disagree);
 *  2. the 64 MB sanity gate;
 *  3. analyzeSignatures(bytes, now): raw xref/trailer walk with the
 *     linear object-scan recovery, /AcroForm /FT /Sig fields, the CMS in
 *     /Contents (minimal DER reader), digest over the exact /ByteRange
 *     bytes, RSASSA-PKCS1-v1_5 verify, coverage check;
 *  4. the result is a deterministic plain-text verification report (.txt)
 *     + the full SignatureReport in the run detail so the surface renders
 *     the per-signature cards without re-parsing anything.
 *
 * Error mapping:
 *   vps.errNotPdf        no %PDF- magic anywhere near the head
 *   vps.errTooBig         beyond the 64 MB sanity gate
 *   tool.errorEncrypted   /Encrypt in the trailer (verify ≠ crack)
 *   tool.errorCorrupt     %PDF- present but the walk found nothing
 *   tool.errorGeneric     no file / unexpected failure
 *
 * A PDF with NO signature fields is an EMPTY report, never an error.
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
    post({ type: "error", runId, code: "vps.errTooBig", detail: file.name });
    return;
  }
  if (!sniffPdfBytes(bytes)) {
    post({ type: "error", runId, code: "vps.errNotPdf", detail: file.name });
    return;
  }

  post({ type: "progress", runId, pct: 40, stage: "processing" });

  let report: SignatureReport;
  try {
    report = await analyzeSignatures(bytes, Date.now());
  } catch (error) {
    if (error instanceof VerifyError) {
      const code =
        error.code === "errEncrypted" ? "tool.errorEncrypted" : `vps.${error.code}`;
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

  const valid = report.signatures.filter((s) => s.status === "valid").length;
  const attention = report.signatures.filter((s) => s.status === "attention").length;
  const invalid = report.signatures.filter((s) => s.status === "invalid").length;

  const text = buildReportText(
    report,
    { fileName: file.name, bytes: bytes.length },
    opts.labels
  );
  post({ type: "progress", runId, pct: 92, stage: "saving" });

  const name = `${outputBaseName(file.name, opts.locale, opts.fileWord)}-verification-report.txt`;
  const detail: VerifyDetail = {
    files: 1,
    signatureCount: report.signatures.length,
    validCount: valid,
    attentionCount: attention,
    invalidCount: invalid,
    unsignedFields: report.unsignedFields.length,
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
