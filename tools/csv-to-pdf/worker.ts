import { CreateContext } from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { parseCsv, renderCsvTable } from "./engine";

/**
 * CSV → PDF worker (PHASE-3 batch 3): RFC-4180 parsing + a print-grade
 * table (bold header, zebra rows, hairline grid, measured columns,
 * header repeated on continuation pages) on OUR OWN engine. Up to 10
 * files per run, one PDF each. Never touches the network.
 */

const A4 = { width: 595.28, height: 841.89 };
const MAX_ROWS = 20000;
const MAX_COLS = 60;

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function outputBaseName(name: string): string {
  return name
    .replace(/\.(csv|tsv|txt)$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 120) || "table";
}

export interface CsvRunOptions {
  delimiter: string;
  pageSize: { width: number; height: number };
  orientation: "portrait" | "landscape";
  fontSize: number;
  header: boolean;
  zebra: boolean;
  grid: boolean;
}

export function resolveCsvOptions(values: OptionValues): CsvRunOptions {
  const sizeRaw = Number(values.fontSize);
  const pageRaw = String(values.pageSize ?? "a4");
  const size =
    pageRaw === "letter"
      ? { width: 612, height: 792 }
      : pageRaw === "a3"
        ? { width: 841.89, height: 1190.55 }
        : A4;
  return {
    delimiter:
      values.delimiter === "tab"
        ? "\t"
        : values.delimiter === "semicolon"
          ? ";"
          : ",",
    pageSize: size,
    orientation: values.orientation === "landscape" ? "landscape" : "portrait",
    fontSize:
      Number.isFinite(sizeRaw) && sizeRaw >= 6 && sizeRaw <= 14
        ? Math.round(sizeRaw)
        : 9,
    header: values.header !== false,
    zebra: values.zebra !== false,
    grid: values.grid !== false,
  };
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const opts = resolveCsvOptions(options);

  const outputs: Array<{ name: string; mime: string; blob: Blob }> = [];
  let totalPages = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex]!;
    post({
      type: "progress",
      runId,
      pct: Math.round(4 + (8 * fileIndex) / files.length),
      stage: "reading",
    });
    let text: string;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      post({ type: "error", runId, code: "tool.errorCorrupt" });
      return;
    }
    if (text.trim().length === 0) {
      post({ type: "error", runId, code: "c2p.errorEmpty", detail: file.name });
      return;
    }

    const table = parseCsv(text, opts.delimiter);
    if (table.rows.length === 0) {
      post({ type: "error", runId, code: "c2p.errorEmpty", detail: file.name });
      return;
    }
    if (table.rows.length > MAX_ROWS) {
      post({ type: "error", runId, code: "c2p.errorTooLarge", detail: file.name });
      return;
    }
    const columns = table.rows.reduce(
      (max, row) => Math.max(max, row.length),
      0
    );
    if (columns > MAX_COLS) {
      post({ type: "error", runId, code: "c2p.errorTooWide", detail: file.name });
      return;
    }

    const ctx = CreateContext.create();
    const layout = renderCsvTable(ctx, table.rows, {
      pageSize: opts.pageSize,
      fontSize: opts.fontSize,
      header: opts.header,
      zebra: opts.zebra,
      grid: opts.grid,
      orientation: opts.orientation,
    });
    totalPages += layout.pages;

    const saved = ctx.write();
    outputs.push({
      name: `${outputBaseName(file.name)}.pdf`,
      mime: "application/pdf",
      blob: new Blob([saved as unknown as BlobPart], {
        type: "application/pdf",
      }),
    });

    post({
      type: "progress",
      runId,
      pct: Math.round(
        8 + (86 * (fileIndex + 1)) / files.length
      ),
      stage: "processing",
      detail: { page: fileIndex + 1, pages: files.length },
    });
  }

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: totalPages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^c2p\.|^tool\./.test(message)
      ? message
      : /chars/i.test(message)
        ? "c2p.errorNotText"
        : "tool.errorGeneric";
    post({ type: "error", runId: data.runId, code });
  });
};
