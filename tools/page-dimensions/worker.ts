import {
  PdfError,
  listPages,
  parsePdf,
  type ParsedPdf,
} from "@/lib/own/pdf";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  buildDimReport,
  renderDimReport,
  type DimReportOptions,
  type DimUnit,
} from "./worker-lib";

/**
 * Page dimensions worker (P1-d / R53) — the read-only size analyzer.
 * Every page's visible box (CropBox with MediaBox fallback) measured in
 * points, converted to mm/inch, classified portrait/landscape/square,
 * matched against standard paper names (±2pt), grouped for mixed-size
 * detection. TXT sheet or JSON — nothing is modified, nothing uploaded.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.pdf$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

function engineErrorCode(error: unknown): string {
  if (error instanceof PdfError && error.code === "encrypted") {
    return "tool.errorEncrypted";
  }
  return "tool.errorCorrupt";
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 12, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());

  post({ type: "progress", runId, pct: 55, stage: "processing" });
  let doc: ParsedPdf;
  try {
    doc = parsePdf(bytes);
  } catch (error: unknown) {
    post({
      type: "error",
      runId,
      code: engineErrorCode(error),
      detail: file.name,
    });
    return;
  }

  const pages = listPages(doc);
  if (pages.length === 0) {
    post({
      type: "error",
      runId,
      code: "tool.errorCorrupt",
      detail: file.name,
    });
    return;
  }

  const unit: DimUnit =
    options.unit === "pt" || options.unit === "in"
      ? (options.unit as DimUnit)
      : "mm";
  const reportOptions: DimReportOptions = {
    format: options.format === "json" ? "json" : "txt",
    unit,
    includePages: options.includePages !== false,
    fileName: file.name,
  };

  let report: string;
  try {
    report = renderDimReport(buildDimReport(pages), reportOptions);
  } catch (error: unknown) {
    post({
      type: "error",
      runId,
      code: engineErrorCode(error),
      detail: file.name,
    });
    return;
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  const isJson = reportOptions.format === "json";
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${safeBaseName(file.name)}-dimensions.${isJson ? "json" : "txt"}`,
        mime: isJson ? "application/json" : "text/plain",
        blob: new Blob([report], {
          type: isJson ? "application/json" : "text/plain",
        }),
      },
    ],
    detail: { files: 1, pages: pages.length },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorCorrupt" });
  });
};
