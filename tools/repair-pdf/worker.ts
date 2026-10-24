import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  outputBaseName,
  parseRun,
  repairPdf,
  RepairError,
  type RepairDetail,
} from "./model";

/**
 * Repair PDF worker (RB3-c, device mode) — the raw-byte PDF salvager.
 *
 * The whole two-stage pipeline lives in model.ts (worker-pure, smoke-
 * tested headless); this file is the thin boundary: parse the options
 * payload, post honest progress, map every RepairError onto an i18n key
 * and post the repair report as the run detail.
 *
 * Error mapping (repair is NOT crack — unlock-pdf is the password tool):
 *   errEncrypted → tool.errorEncrypted   (password-protected input)
 *   errNoObjects → rep.errNoObjects      (no "N G obj" pattern anywhere)
 *   errNoCatalog → rep.errNoCatalog      (objects but no /Type /Catalog)
 *   errNoPages   → rep.errNoPages        (catalog but no reachable page)
 *   errVerify    → rep.errVerify         (rebuilt output failed strict load)
 *   anything else → tool.errorCorrupt
 *
 * Device-only: the File arrives by structured clone, the repaired PDF
 * Blob goes back — nothing touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function mapError(error: unknown): string {
  if (error instanceof RepairError) {
    if (error.code === "errEncrypted") return "tool.errorEncrypted";
    return `rep.${error.code}`;
  }
  return "tool.errorCorrupt";
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
  post({ type: "progress", runId, pct: 45, stage: "processing" });

  const { bytes: out, report } = await repairPdf(bytes, opts);
  post({ type: "progress", runId, pct: 85, stage: "saving" });

  const name = `${outputBaseName(file.name, opts.locale, opts.fileWord)}-repaired.pdf`;
  const detail: RepairDetail = {
    files: 1,
    pages: report.pages,
    beforeBytes: report.bytesIn,
    afterBytes: report.bytesOut,
    structureWasValid: report.structureWasValid,
    unchanged: report.unchanged,
    loadFailed: report.loadFailed,
    xrefRebuilt: report.xrefRebuilt,
    headerFixed: report.headerFixed,
    eofMissing: report.eofMissing,
    truncationDetected: report.truncationDetected,
    objectsRecovered: report.objectsRecovered,
    duplicatesResolved: report.duplicatesResolved,
    streamLengthsFixed: report.streamLengthsFixed,
    xrefStreamSalvaged: report.xrefStreamSalvaged,
    xrefStreamEntries: report.xrefStreamEntries,
  };

  post({
    type: "result",
    runId,
    outputs: [
      {
        name,
        mime: "application/pdf",
        blob: new Blob([out as unknown as BlobPart], {
          type: "application/pdf",
        }),
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
      code: mapError(error),
      detail: error instanceof Error ? error.message : String(error),
    });
  });
};
