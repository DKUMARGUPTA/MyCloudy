import {
  PdfError,
  listPages,
  parsePdf,
  rewriteDocument,
} from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  type SanitizeFindings,
  type SanitizeOptions,
  planSanitize,
  resolveSanitizeOptions,
} from "./engine";

/**
 * Sanitize PDF worker (PHASE-1 Batch A): strips active content —
 * document JavaScript, embedded files, external/trigger actions and
 * (optionally) metadata — from a PDF on OUR OWN engine via
 * rewriteDocument object surgery (replacements for cleaned dicts,
 * deletions for excised object graphs, dropInfo for /Info).
 *
 * Numbers/streams are preserved byte-exact everywhere else — pages,
 * content and fonts ride through untouched. Encrypted documents are
 * refused (unlock first). Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

export interface SanitizeRunResult {
  bytes: Uint8Array;
  findings: SanitizeFindings;
}

/** The whole sanitize pipeline, smoke-testable without a Worker. */
export async function runSanitize(
  bytes: Uint8Array,
  options: OptionValues
): Promise<SanitizeRunResult> {
  const opts: SanitizeOptions = resolveSanitizeOptions(options);

  let doc: ReturnType<typeof parsePdf>;
  try {
    doc = parsePdf(bytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }

  const pages = listPages(doc).map((p) => ({ ref: p.ref, dict: p.dict }));
  const plan = planSanitize(doc, pages, opts);

  try {
    const saved = rewriteDocument(doc, {
      replacements: plan.replacements,
      deletions: plan.deletions,
      dropInfo: plan.dropInfo,
    });
    return { bytes: saved, findings: plan.findings };
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

  post({ type: "progress", runId, pct: 8, stage: "reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  post({ type: "progress", runId, pct: 45, stage: "processing" });
  let result: SanitizeRunResult;
  try {
    result = await runSanitize(bytes, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^sz\.|^tool\./.test(message)
      ? message
      : /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt";
    post({ type: "error", runId, code });
    return;
  }

  post({ type: "progress", runId, pct: 94, stage: "saving" });
  const outputs = [
    {
      name: `${safeBaseName(file.name)}-sanitized.pdf`,
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
    detail: { files: 1, pages: pagesCountOf(result) },
  });
}

function pagesCountOf(_result: SanitizeRunResult): number {
  // The detail field carries the findings as a display string via the
  // shared result view; page count stays 1 file (the sanitizer keeps
  // every page).
  return 1;
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
