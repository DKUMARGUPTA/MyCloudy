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
import { planFontToOutline } from "./engine";

/**
 * Font to outline worker (PHASE-7): every text-show op drawn with an
 * embedded TrueType (Type0/CIDFontType2, Identity-H) font becomes pure
 * bezier paths — content-stream surgery on our own engine, layout
 * byte-stable. Unsupported fonts are counted and left as text. Device
 * only, no network, ever.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

export interface FoRunResult {
  bytes: Uint8Array;
  pages: number;
  showsConverted: number;
  showsSkipped: number;
  glyphPaths: number;
}

/** The whole pipeline, smoke-testable without a Worker PostMessage. */
export function runFontToOutline(
  bytes: Uint8Array,
  options: OptionValues
): FoRunResult {
  const pagesSpecRaw = options.pages;
  const pagesSpec =
    typeof pagesSpecRaw === "string" && pagesSpecRaw.trim().length > 0
      ? pagesSpecRaw.trim()
      : "all";

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
  const indices = parsePageSpec(pagesSpec, allPages.length);
  if (indices === null || indices.length === 0) {
    throw new Error("tool.errorInvalidPages");
  }
  const selected = indices.map((i) => allPages[i]!);

  const plan = planFontToOutline(doc, selected);
  if (plan.stats.showsConverted === 0) {
    throw new Error("tool.errorNoConvertibleText");
  }

  try {
    const saved = rewriteDocument(doc, {
      replacements: plan.replacements,
    });
    return {
      bytes: saved,
      pages: selected.length,
      showsConverted: plan.stats.showsConverted,
      showsSkipped: plan.stats.showsSkipped,
      glyphPaths: plan.stats.glyphPaths,
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
  let result: FoRunResult;
  try {
    result = runFontToOutline(bytes, options);
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
      name: `${safeBaseName(file.name)}-outlines.pdf`,
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
      textOutlined: result.showsConverted,
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
