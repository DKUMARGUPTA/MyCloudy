import { StampContext, type StampFontKey } from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type RunStage,
  type StageDetail,
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Add stamps worker (PHASE-1 Batch C): one text stamp per selected page —
 * big diagonal across the middle or one of nine positions, colour +
 * opacity + rotation + size, via StampContext (the page-numbers/
 * watermark pipeline on OUR OWN engine). Never touches the network.
 */

export const STAMP_COLORS: Record<string, { r: number; g: number; b: number }> = {
  red: { r: 0.85, g: 0.15, b: 0.15 },
  gray: { r: 0.45, g: 0.45, b: 0.45 },
  blue: { r: 0.2, g: 0.33, b: 0.5 },
  green: { r: 0.13, g: 0.5, b: 0.25 },
  purple: { r: 0.45, g: 0.25, b: 0.6 },
  black: { r: 0, g: 0, b: 0 },
};

type Placement =
  | "diagonal"
  | "top-left" | "top-center" | "top-right"
  | "middle-left" | "middle-center" | "middle-right"
  | "bottom-left" | "bottom-center" | "bottom-right";

const PLACEMENTS: readonly Placement[] = [
  "diagonal",
  "top-left", "top-center", "top-right",
  "middle-left", "middle-center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
];

export interface StampOptions {
  text: string;
  placement: Placement;
  color: { r: number; g: number; b: number };
  opacity: number;
  size: number;
  angle: number;
  pages: string;
}

function resolveOptions(values: OptionValues): StampOptions {
  const placementRaw = values.placement as Placement;
  const opacityRaw = Number(values.opacity);
  const sizeRaw = Number(values.size);
  const angleRaw = Number(values.angle);
  return {
    text: typeof values.text === "string" && values.text.length > 0 ? values.text : "DRAFT",
    placement: PLACEMENTS.includes(placementRaw) ? placementRaw : "diagonal",
    color: STAMP_COLORS[values.color as string] ?? STAMP_COLORS.red!,
    opacity:
      Number.isFinite(opacityRaw) && opacityRaw >= 10 && opacityRaw <= 100
        ? opacityRaw / 100
        : 0.25,
    size:
      Number.isFinite(sizeRaw) && sizeRaw >= 8 && sizeRaw <= 96 ? sizeRaw : 48,
    angle:
      Number.isFinite(angleRaw) && angleRaw >= -90 && angleRaw <= 90
        ? angleRaw
        : 45,
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

export interface StampProgress {
  pct: number;
  stage: RunStage;
  detail?: StageDetail;
}

export interface StampRunResult {
  bytes: Uint8Array;
  pages: number;
}

/** The whole pipeline, smoke-testable without a Worker. */
export async function runAddStamps(
  bytes: Uint8Array,
  options: OptionValues,
  onProgress?: (progress: StampProgress) => void
): Promise<StampRunResult> {
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

  const fontKey: StampFontKey = "helvetica";
  const textW = ctx.measure(opts.text, fontKey, opts.size);

  indices.forEach((pageIndex, i) => {
    const page = ctx.pages[pageIndex]!;
    const w = page.mediaBox[2] - page.mediaBox[0];
    const h = page.mediaBox[3] - page.mediaBox[1];
    let x: number;
    let y: number;
    let rotate = opts.angle;
    if (opts.placement === "diagonal") {
      // Centred; rotation about the baseline-left anchor (pdf-lib
      // semantics), so shift by half the rotated text box.
      x = page.mediaBox[0] + (w - textW) / 2;
      y = page.mediaBox[1] + (h - opts.size) / 2;
    } else {
      const margin = Math.min(24, Math.max(12, w * 0.04));
      const [vert, horiz] = opts.placement.split("-") as [string, string];
      if (horiz === "left") {
        x = page.mediaBox[0] + margin;
      } else if (horiz === "right") {
        x = page.mediaBox[0] + w - margin - textW;
      } else {
        x = page.mediaBox[0] + (w - textW) / 2;
      }
      if (vert === "top") {
        y = page.mediaBox[1] + h - margin - opts.size;
      } else if (vert === "bottom") {
        y = page.mediaBox[1] + margin;
      } else {
        y = page.mediaBox[1] + (h - opts.size) / 2;
      }
      if (opts.angle !== 0) {
        // Rotated corner stamps rotate about their own anchor.
        rotate = opts.angle;
      }
    }
    ctx.stampText(pageIndex, {
      x,
      y,
      text: opts.text,
      size: opts.size,
      font: fontKey,
      color: opts.color,
      opacity: opts.opacity,
      rotate,
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

  let result: StampRunResult;
  try {
    result = await runAddStamps(bytes, options, (progress) => {
      post({ type: "progress", runId, ...progress });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^st\.|^tool\./.test(message)
      ? message
      : /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt";
    post({ type: "error", runId, code });
    return;
  }

  const outputs = [
    {
      name: `${safeBaseName(file.name)}-stamped.pdf`,
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
