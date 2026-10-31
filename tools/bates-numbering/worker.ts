import { PdfError, StampContext } from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Bates numbering worker (R50) — legal-discovery sequential page stamp.
 *
 * 100% on OUR OWN PDF engine (StampContext): prefix + zero-padded counter
 * stamped at a chosen position, sequentially across the selected pages.
 * Typed refusal for encrypted/corrupt inputs; real progress per page; the
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

function engineErrorCode(error: unknown): string {
  if (error instanceof PdfError && error.code === "encrypted") {
    return "tool.errorEncrypted";
  }
  return "tool.errorCorrupt";
}

/** Latin-only guard — std fonts can't shape Devanagari (honesty over tofu). */
function latinSafe(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x7e) return false;
  }
  return true;
}

interface BatesOptions {
  prefix: string;
  startNumber: number;
  digits: number;
  position: string;
  size: number;
}

function resolveOptions(options: OptionValues): BatesOptions {
  const prefix =
    typeof options.prefix === "string" ? options.prefix.slice(0, 32) : "";
  const startNumber = Number.isFinite(Number(options.startNumber))
    ? Math.min(Math.max(Math.floor(Number(options.startNumber)), 1), 100000)
    : 1;
  const digitsRaw = Number(options.digits);
  const digits = [4, 5, 6, 7, 8].includes(digitsRaw) ? digitsRaw : 6;
  const position =
    typeof options.position === "string" ? options.position : "bottom-right";
  const sizeRaw = Number(options.size);
  const size = Number.isFinite(sizeRaw)
    ? Math.min(Math.max(sizeRaw, 6), 24)
    : 9;
  return { prefix, startNumber, digits, position, size };
}

function anchor(
  position: string,
  pageW: number,
  pageH: number,
  margin: number,
  textW: number,
  size: number
): { x: number; y: number } {
  // Baseline-left anchor; each slot is inset by `margin`.
  switch (position) {
    case "bottom-center":
      return { x: (pageW - textW) / 2, y: margin };
    case "bottom-left":
      return { x: margin, y: margin };
    case "top-right":
      return { x: pageW - margin - textW, y: pageH - margin - size };
    case "top-center":
      return { x: (pageW - textW) / 2, y: pageH - margin - size };
    case "top-left":
      return { x: margin, y: pageH - margin - size };
    case "bottom-right":
    default:
      return { x: pageW - margin - textW, y: margin };
  }
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const bates = resolveOptions(options);

  if (!latinSafe(bates.prefix)) {
    // Reuse: the message is generic ("embedded font can't carry this text").
    post({ type: "error", runId, code: "tool.errorWatermarkChars" });
    return;
  }

  post({ type: "progress", runId, pct: 6, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());

  let ctx: StampContext;
  try {
    ctx = StampContext.load(bytes);
  } catch (error: unknown) {
    post({
      type: "error",
      runId,
      code: engineErrorCode(error),
      detail: file.name,
    });
    return;
  }

  const targets = parsePageSpec(
    typeof options.pages === "string" ? options.pages : "all",
    ctx.pageCount
  );
  if (targets === null || targets.length === 0) {
    post({ type: "error", runId, code: "tool.errorInvalidPages" });
    return;
  }

  post({ type: "progress", runId, pct: 12, stage: "processing" });
  const margin = Math.max(18, bates.size * 1.6);
  const total = targets.length;
  let done = 0;
  let counter = bates.startNumber;

  for (const pageIndex of targets) {
    const page = ctx.pages[pageIndex]!;
    const pageW = page.mediaBox[2] - page.mediaBox[0];
    const pageH = page.mediaBox[3] - page.mediaBox[1];
    const text = `${bates.prefix}${String(counter).padStart(
      bates.digits,
      "0"
    )}`;
    const textW = ctx.measure(text, "helvetica", bates.size);
    const { x, y } = anchor(
      bates.position,
      pageW,
      pageH,
      margin,
      textW,
      bates.size
    );
    ctx.stampText(pageIndex, {
      x,
      y,
      text,
      size: bates.size,
      font: "helvetica",
    });
    counter += 1;
    done += 1;
    post({
      type: "progress",
      runId,
      pct: Math.round(12 + (done / total) * 84),
      stage: "processing",
      detail: { page: done, pages: total },
    });
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  const saved = ctx.write();
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${safeBaseName(file.name)}-bates.pdf`,
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: 1, pages: total },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    post({
      type: "error",
      runId: data.runId,
      code: engineErrorCode(error),
      detail: undefined,
    });
  });
};
