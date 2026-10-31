import { StampContext } from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type RunStage,
  type StageDetail,
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Change page background colour worker (PHASE-1 Batch C): paints a
 * full-page solid rectangle UNDER every selected page's content via
 * StampContext (behind: true — the watermark underlay seam).
 *
 * Runs 100% on OUR OWN engine. Never touches the network.
 */

/** Curated palette (RGB 0..1). */
export const BG_COLORS: Record<string, { r: number; g: number; b: number }> = {
  ivory: { r: 1, g: 1, b: 0.94 },
  warm: { r: 1, g: 0.96, b: 0.88 },
  mint: { r: 0.88, g: 1, b: 0.94 },
  sky: { r: 0.9, g: 0.95, b: 1 },
  rose: { r: 1, g: 0.92, b: 0.93 },
  gray: { r: 0.9, g: 0.9, b: 0.9 },
  yellow: { r: 1, g: 0.93, b: 0.7 },
  black: { r: 0.08, g: 0.08, b: 0.08 },
};

function resolveOptions(values: OptionValues): {
  color: { r: number; g: number; b: number };
  opacity: number;
  pages: string;
} {
  const colorRaw = values.color;
  const opacityRaw = Number(values.opacity);
  return {
    color: BG_COLORS[colorRaw as string] ?? BG_COLORS.ivory!,
    opacity:
      Number.isFinite(opacityRaw) && opacityRaw >= 10 && opacityRaw <= 100
        ? opacityRaw / 100
        : 1,
    pages: typeof values.pages === "string" ? (values.pages as string) : "all",
  };
}

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

export interface BgProgress {
  pct: number;
  stage: RunStage;
  detail?: StageDetail;
}

export interface BgRunResult {
  bytes: Uint8Array;
  pages: number;
}

/** The whole pipeline, smoke-testable without a Worker. */
export async function runBackgroundColor(
  bytes: Uint8Array,
  options: OptionValues,
  onProgress?: (progress: BgProgress) => void
): Promise<BgRunResult> {
  const opts = resolveOptions(options);

  let ctx: StampContext;
  try {
    ctx = StampContext.load(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(/encrypt/i.test(message) ? "tool.errorEncrypted" : "tool.errorCorrupt");
  }
  if (ctx.pageCount < 1) {
    throw new Error("tool.errorCorrupt");
  }
  const indices = parsePageSpec(opts.pages, ctx.pageCount);
  if (indices === null || indices.length === 0) {
    throw new Error("tool.errorInvalidPages");
  }

  indices.forEach((pageIndex, i) => {
    const page = ctx.pages[pageIndex]!;
    const x0 = page.mediaBox[0];
    const y0 = page.mediaBox[1];
    ctx.stampRect(pageIndex, {
      x: x0,
      y: y0,
      width: page.mediaBox[2] - x0,
      height: page.mediaBox[3] - y0,
      color: opts.color,
      opacity: opts.opacity,
      behind: true,
    });
    onProgress?.({
      pct: Math.round(10 + (80 / indices.length) * (i + 1)),
      stage: "processing",
      detail: { page: i + 1, pages: indices.length },
    });
  });

  onProgress?.({ pct: 94, stage: "saving" });
  try {
    const saved = ctx.write();
    return { bytes: saved, pages: ctx.pageCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(/encrypt/i.test(message) ? "tool.errorEncrypted" : "tool.errorCorrupt");
  }
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 4, stage: "reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  let result: BgRunResult;
  try {
    result = await runBackgroundColor(bytes, options, (progress) => {
      post({ type: "progress", runId, ...progress });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^bg\.|^tool\./.test(message)
      ? message
      : /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt";
    post({ type: "error", runId, code });
    return;
  }

  const outputs = [
    {
      name: `${safeBaseName(file.name)}-tinted.pdf`,
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
    detail: { files: 1, pages: result.pages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
