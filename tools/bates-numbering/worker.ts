import { StampContext, type StampFontKey } from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Bates numbering worker (PHASE-1 Batch B): stamps prefix + zero-padded
 * sequential number + suffix on every page of every file — the series
 * CONTINUES across the batch (legal exhibit sets).
 *
 * Runs 100% on OUR OWN engine (StampContext — the page-numbers
 * pipeline). Never touches the network.
 */

export interface BatesOptions {
  prefix: string;
  suffix: string;
  start: number;
  digits: number;
  position:
    | "bottom-right"
    | "bottom-left"
    | "bottom-center"
    | "top-right"
    | "top-left"
    | "top-center";
  margin: number;
  size: number;
  font: "helvetica" | "courier" | "times";
}

function resolveOptions(values: OptionValues): BatesOptions {
  const clamp = (n: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, n));
  const num = (v: unknown, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const posRaw = values.position;
  const fontRaw = values.font;
  return {
    prefix: typeof values.prefix === "string" ? values.prefix : "",
    suffix: typeof values.suffix === "string" ? values.suffix : "",
    start: clamp(Math.floor(num(values.start, 1)), 1, 999_999),
    digits: clamp(Math.floor(num(values.digits, 6)), 4, 12),
    position:
      posRaw === "bottom-left" || posRaw === "bottom-center" || posRaw === "top-right" || posRaw === "top-left" || posRaw === "top-center"
        ? posRaw
        : "bottom-right",
    margin: clamp(num(values.margin, 24), 6, 100),
    size: clamp(num(values.size, 10), 6, 36),
    font: fontRaw === "courier" || fontRaw === "times" ? fontRaw : "helvetica",
  };
}

/** The full stamp text for page n of the series. */
export function batesText(
  opts: Pick<BatesOptions, "prefix" | "suffix" | "digits">,
  value: number
): string {
  const padded = String(value).padStart(opts.digits, "0");
  return `${opts.prefix}${padded}${opts.suffix}`;
}

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

export interface BatesProgress {
  pct: number;
  stage: "reading" | "processing" | "saving";
  detail?: { page: number; pages: number };
}

export interface BatesFileResult {
  bytes: Uint8Array;
  pages: number;
  first: number;
  last: number;
}

/** Stamp ONE file, continuing the series from `next`. Returns the next free number. */
export async function runBatesFile(
  bytes: Uint8Array,
  options: OptionValues,
  next: number,
  onProgress?: (p: BatesProgress) => void
): Promise<BatesFileResult> {
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

  const fontKey: StampFontKey =
    opts.font === "courier" ? "courier" : opts.font === "times" ? "times" : "helvetica";

  let value = next;
  for (let i = 0; i < ctx.pageCount; i += 1) {
    const page = ctx.pages[i]!;
    const w = page.mediaBox[2] - page.mediaBox[0];
    const h = page.mediaBox[3] - page.mediaBox[1];
    const text = batesText(opts, value);
    const tw = ctx.measure(text, fontKey, opts.size);
    let x = page.mediaBox[0] + w - opts.margin - tw;
    let y = page.mediaBox[1] + opts.margin - opts.size * 0.25;
    if (opts.position === "bottom-left" || opts.position === "top-left") {
      x = page.mediaBox[0] + opts.margin;
    } else if (opts.position === "bottom-center" || opts.position === "top-center") {
      x = page.mediaBox[0] + (w - tw) / 2;
    }
    if (opts.position.startsWith("top")) {
      y = page.mediaBox[1] + h - opts.margin - opts.size * 0.75;
    }
    ctx.stampText(i, { x, y, text, size: opts.size, font: fontKey });
    value += 1;
    onProgress?.({
      pct: Math.round(8 + (84 / ctx.pageCount) * (i + 1)),
      stage: "processing",
      detail: { page: i + 1, pages: ctx.pageCount },
    });
  }

  onProgress?.({ pct: 94, stage: "saving" });
  try {
    const saved = ctx.write();
    return {
      bytes: saved,
      pages: ctx.pageCount,
      first: next,
      last: value - 1,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(/encrypt/i.test(message) ? "tool.errorEncrypted" : "tool.errorCorrupt");
  }
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const opts = resolveOptions(options);
  const outputs: Array<{ name: string; mime: string; blob: Blob }> = [];
  let next = opts.start;
  let totalPages = 0;
  let done = 0;
  for (const file of files) {
    post({
      type: "progress",
      runId,
      pct: Math.max(4, Math.round((done / files.length) * 100)),
      stage: "reading",
    });
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      post({ type: "error", runId, code: "tool.errorCorrupt" });
      return;
    }
    let result: BatesFileResult;
    try {
      result = await runBatesFile(bytes, options, next, (p) => {
        post({
          type: "progress",
          runId,
          pct: Math.round(4 + ((done + p.pct / 100) / files.length) * 92),
          stage: p.stage,
          detail: p.detail,
        });
      });
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
    next = result.last + 1;
    totalPages += result.pages;
    outputs.push({
      name: `${safeBaseName(file.name)}-bates.pdf`,
      mime: "application/pdf",
      blob: new Blob([result.bytes as unknown as BlobPart], {
        type: "application/pdf",
      }),
    });
    done += 1;
  }

  post({ type: "progress", runId, pct: 98, stage: "saving" });
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
