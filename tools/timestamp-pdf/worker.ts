import { StampContext, type StampFontKey } from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  parsePageSpec,
  type RunStage,
  type StageDetail,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Timestamp worker (PHASE-3 batch 2): stamps the current local date/time
 * onto every selected page of every input file — four formats, nine
 * placements — via StampContext on OUR OWN engine (the page-numbers /
 * bates pipeline). The clock is read ONCE per run so a batch shares one
 * honest moment. Never touches the network.
 */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Format the date in a fixed Latin shape (the stamp font is WinAnsi). */
export function formatTimestamp(d: Date, format: string): string {
  switch (format) {
    case "date":
      return `${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    case "time":
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    case "iso": {
      const offsetMinutes = -d.getTimezoneOffset();
      const sign = offsetMinutes >= 0 ? "+" : "-";
      const abs = Math.abs(offsetMinutes);
      const tz = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
      return (
        `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
        `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${tz}`
      );
    }
    default:
      return (
        `${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ` +
        `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
      );
  }
}

const COLORS: Record<string, { r: number; g: number; b: number }> = {
  gray: { r: 0.42, g: 0.45, b: 0.5 },
  black: { r: 0, g: 0, b: 0 },
  red: { r: 0.78, g: 0.16, b: 0.16 },
  blue: { r: 0.16, g: 0.32, b: 0.55 },
  green: { r: 0.13, g: 0.46, b: 0.25 },
};

type Placement =
  | "top-left" | "top-center" | "top-right"
  | "middle-left" | "middle-center" | "middle-right"
  | "bottom-left" | "bottom-center" | "bottom-right";

const PLACEMENTS: readonly Placement[] = [
  "top-left", "top-center", "top-right",
  "middle-left", "middle-center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
];

export interface TimestampOptions {
  text: string;
  placement: Placement;
  color: { r: number; g: number; b: number };
  opacity: number;
  size: number;
  pages: string;
}

export function resolveTimestampOptions(
  values: OptionValues,
  now: Date
): TimestampOptions {
  const placementRaw = values.placement as Placement;
  const opacityRaw = Number(values.opacity);
  const sizeRaw = Number(values.size);
  const formatRaw = String(values.format ?? "datetime");
  const prefixRaw =
    typeof values.prefix === "string" ? values.prefix.trim() : "";

  let text = formatTimestamp(now, formatRaw);
  if (prefixRaw.length > 0) {
    text = `${prefixRaw.replace(/\s+/g, " ").slice(0, 60)} ${text}`;
  }

  return {
    text,
    placement: PLACEMENTS.includes(placementRaw) ? placementRaw : "bottom-right",
    color: COLORS[String(values.color ?? "gray")] ?? COLORS.gray!,
    opacity:
      Number.isFinite(opacityRaw) && opacityRaw >= 30 && opacityRaw <= 100
        ? opacityRaw / 100
        : 0.7,
    size:
      Number.isFinite(sizeRaw) && sizeRaw >= 7 && sizeRaw <= 24 ? sizeRaw : 9,
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

export interface TimestampProgress {
  pct: number;
  stage: RunStage;
  detail?: StageDetail;
}

export interface TimestampRunResult {
  bytes: Uint8Array;
  pages: number;
  stamped: string;
}

/** The whole pipeline for ONE file, smoke-testable without a Worker. */
export function runTimestampOne(
  bytes: Uint8Array,
  options: TimestampOptions
): TimestampRunResult {
  let ctx: StampContext;
  try {
    ctx = StampContext.load(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      /encrypt/i.test(message) ? "tool.errorEncrypted" : "tool.errorCorrupt"
    );
  }
  if (ctx.pageCount < 1) {
    throw new Error("tool.errorCorrupt");
  }
  const indices = parsePageSpec(options.pages, ctx.pageCount);
  if (indices === null || indices.length === 0) {
    throw new Error("tool.errorInvalidPages");
  }

  const fontKey: StampFontKey = "helvetica";
  const textW = ctx.measure(options.text, fontKey, options.size);

  for (const pageIndex of indices) {
    const page = ctx.pages[pageIndex]!;
    const w = page.mediaBox[2] - page.mediaBox[0];
    const h = page.mediaBox[3] - page.mediaBox[1];
    const margin = Math.min(24, Math.max(12, w * 0.035));
    const [vert, horiz] = options.placement.split("-") as [string, string];
    let x: number;
    if (horiz === "left") {
      x = page.mediaBox[0] + margin;
    } else if (horiz === "right") {
      x = page.mediaBox[0] + w - margin - textW;
    } else {
      x = page.mediaBox[0] + (w - textW) / 2;
    }
    let y: number;
    if (vert === "top") {
      y = page.mediaBox[1] + h - margin - options.size;
    } else if (vert === "bottom") {
      y = page.mediaBox[1] + margin;
    } else {
      y = page.mediaBox[1] + (h - options.size) / 2;
    }
    ctx.stampText(pageIndex, {
      x,
      y,
      text: options.text,
      size: options.size,
      font: fontKey,
      color: options.color,
      opacity: options.opacity,
    });
  }

  try {
    const saved = ctx.write();
    return { bytes: saved, pages: ctx.pageCount, stamped: options.text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      /encrypt/i.test(message) ? "tool.errorEncrypted" : "tool.errorCorrupt"
    );
  }
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  // One clock reading per run — the whole batch shares one honest moment.
  const opts = resolveTimestampOptions(options, new Date());

  const outputs: Array<{ name: string; mime: string; blob: Blob }> = [];
  let stampedPages = 0;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!;
    post({
      type: "progress",
      runId,
      pct: Math.round(4 + (88 * i) / files.length),
      stage: "reading",
    });
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      post({ type: "error", runId, code: "tool.errorCorrupt" });
      return;
    }
    let result: TimestampRunResult;
    try {
      result = runTimestampOne(bytes, opts);
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
    stampedPages += result.pages;
    outputs.push({
      name: `${safeBaseName(file.name)}-timestamped.pdf`,
      mime: "application/pdf",
      blob: new Blob([result.bytes as unknown as BlobPart], {
        type: "application/pdf",
      }),
    });
  }

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: {
      files: outputs.length,
      pages: stampedPages,
      stamped: opts.text,
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
