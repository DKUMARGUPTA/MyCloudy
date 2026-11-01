import { CreateContext } from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  prettyJson,
  renderMonoLines,
} from "../mono-common/engine";

/**
 * JSON → PDF worker (PHASE-3 batch 3): validates the JSON (honest parse
 * errors), pretty-prints with 2-space indent, then renders it as a
 * colourised Courier document — keys, strings and punctuation tinted —
 * through OUR OWN engine. Up to 10 files, one PDF each.
 */

const A4 = { width: 595.28, height: 841.89 };

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function outputBaseName(name: string): string {
  return (
    name
      .replace(/\.(json)$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .trim()
      .slice(0, 120) || "data"
  );
}

export function resolveJsonOptions(values: OptionValues): {
  pageSize: { width: number; height: number };
  orientation: "portrait" | "landscape";
  fontSize: number;
  colorize: boolean;
  maxPages: number;
} {
  const sizeRaw = Number(values.fontSize);
  const pageRaw = String(values.pageSize ?? "a4");
  return {
    pageSize:
      pageRaw === "letter" ? { width: 612, height: 792 } : A4,
    orientation: values.orientation === "landscape" ? "landscape" : "portrait",
    fontSize:
      Number.isFinite(sizeRaw) && sizeRaw >= 6 && sizeRaw <= 14
        ? Math.round(sizeRaw)
        : 9,
    colorize: values.colorize !== false,
    maxPages: 200,
  };
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const opts = resolveJsonOptions(options);

  const outputs: Array<{ name: string; mime: string; blob: Blob }> = [];
  let totalPages = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex]!;
    post({
      type: "progress",
      runId,
      pct: Math.round(4 + (10 * fileIndex) / files.length),
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
      post({ type: "error", runId, code: "j2p.errorEmpty", detail: file.name });
      return;
    }

    let pretty: string;
    try {
      pretty = prettyJson(text);
    } catch {
      post({ type: "error", runId, code: "j2p.errorInvalid", detail: file.name });
      return;
    }

    const lines = pretty.split("\n");
    const ctx = CreateContext.create();
    const layout = renderMonoLines(ctx, lines, {
      pageSize: opts.pageSize,
      orientation: opts.orientation,
      fontSize: opts.fontSize,
      maxPages: opts.maxPages,
      colorize: opts.colorize,
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
      pct: Math.round(10 + (84 * (fileIndex + 1)) / files.length),
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
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
