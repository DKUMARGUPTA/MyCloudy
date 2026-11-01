import type { OptionValues } from "@/lib/tools/config-types";
import {
  listPages,
  parsePdf,
  PdfError,
  rewriteDocument,
} from "@/lib/own/pdf";
import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { parseHexColor } from "../add-watermark/wm-options";
import { planTextColor, resolveTextColorOptions } from "./engine";

/**
 * Text color worker (PHASE-7): recolor existing text with content-stream
 * surgery on our own engine — BT insertions + in-text colour-op
 * replacements on every selected page's streams AND the Form XObjects
 * they draw (recursively). Vectors only: no raster, no re-render. The
 * PDF never leaves the device.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

export interface TcRunResult {
  bytes: Uint8Array;
  pages: number;
  textBlocks: number;
  colorOpsReplaced: number;
  streamsSkipped: number;
}

/** The whole pipeline, smoke-testable without a Worker PostMessage. */
export function runTextColor(
  bytes: Uint8Array,
  options: OptionValues
): TcRunResult {
  const opts = resolveTextColorOptions(options);

  let doc;
  try {
    doc = parsePdf(bytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }

  const allPages = listPages(doc);
  const indices = parsePageSpec(opts.pages, allPages.length);
  if (indices === null || indices.length === 0) {
    throw new Error("tool.errorInvalidPages");
  }
  const selected = indices.map((i) => allPages[i]!);

  const hex = parseHexColor(opts.color);
  const rgb: [number, number, number] = hex
    ? [hex.r, hex.g, hex.b]
    : [0.86, 0.15, 0.15];

  const plan = planTextColor(doc, selected, rgb);
  if (plan.stats.textObjects === 0) {
    // Honest: no text objects on the selected pages (scan / image-only).
    throw new Error("tool.errorNoText");
  }

  try {
    const saved = rewriteDocument(doc, {
      replacements: plan.replacements,
    });
    return {
      bytes: saved,
      pages: selected.length,
      textBlocks: plan.stats.textObjects,
      colorOpsReplaced: plan.stats.fillReplaced + plan.stats.strokeReplaced,
      streamsSkipped: plan.stats.streamsSkipped,
    };
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
  let result: TcRunResult;
  try {
    result = runTextColor(bytes, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^tool\./.test(message)
      ? message
      : /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt";
    post({ type: "error", runId, code });
    return;
  }

  post({ type: "progress", runId, pct: 92, stage: "saving" });
  const outputs = [
    {
      name: `${safeBaseName(file.name)}-recolored.pdf`,
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
    detail: {
      files: 1,
      pages: result.pages,
      textBlocksRecolored: result.textBlocks,
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
