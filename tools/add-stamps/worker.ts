import { PdfError, StampContext } from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Add stamps worker (R50) — rubber-stamp text (APPROVED / DRAFT / custom)
 * at a chosen position with size, color, opacity and rotation.
 *
 * 100% on OUR OWN PDF engine (StampContext.stampText with rotate +
 * opacity). Typed refusal for encrypted/corrupt inputs; progress per
 * page; the PDF never leaves the device.
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

function latinSafe(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x7e) return false;
  }
  return true;
}

const COLORS: Record<string, { r: number; g: number; b: number }> = {
  red: { r: 0.85, g: 0.11, b: 0.13 },
  green: { r: 0.05, g: 0.5, b: 0.2 },
  blue: { r: 0.08, g: 0.28, b: 0.72 },
  black: { r: 0, g: 0, b: 0 },
};

interface StampOptions {
  text: string;
  position: string;
  color: { r: number; g: number; b: number };
  size: number;
  opacity: number;
  rotate: number;
}

function resolveOptions(options: OptionValues): StampOptions {
  const preset =
    typeof options.text === "string" && options.text.length > 0
      ? options.text
      : "APPROVED";
  let text = preset;
  if (preset === "custom") {
    const custom =
      typeof options.customText === "string" ? options.customText : "";
    text = custom.trim().slice(0, 32);
  }
  const position =
    typeof options.position === "string" ? options.position : "bottom-right";
  const colorKey =
    typeof options.color === "string" && COLORS[options.color] !== undefined
      ? options.color
      : "red";
  const sizeRaw = Number(options.size);
  const size = Number.isFinite(sizeRaw)
    ? Math.min(Math.max(sizeRaw, 12), 96)
    : 36;
  const opacityRaw = Number(options.opacity);
  const opacity = Number.isFinite(opacityRaw)
    ? Math.min(Math.max(opacityRaw, 5), 100) / 100
    : 0.25;
  const rotateRaw = Number(options.rotate);
  const rotate = Number.isFinite(rotateRaw) ? rotateRaw : -45;
  return {
    text,
    position,
    color: COLORS[colorKey]!,
    size,
    opacity,
    rotate,
  };
}

function anchor(
  position: string,
  pageW: number,
  pageH: number,
  margin: number,
  textW: number,
  size: number
): { x: number; y: number } {
  // Baseline-left anchor. For rotated stamps the visual center of the
  // text block lands near the slot center — stampText rotates around
  // (x, y), so we offset the anchor by half the text extent.
  switch (position) {
    case "center":
      return { x: (pageW - textW) / 2, y: (pageH - size) / 2 };
    case "bottom-right":
      return { x: pageW - margin - textW, y: margin };
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
  const stamp = resolveOptions(options);

  if (stamp.text.length === 0) {
    // Custom selected but empty — honest refusal instead of a no-op.
    post({ type: "error", runId, code: "tool.errorCustomTextEmpty" });
    return;
  }
  if (!latinSafe(stamp.text)) {
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
  const margin = Math.max(24, stamp.size * 1.2);
  const textW = ctx.measure(stamp.text, "helveticaBold", stamp.size);
  const total = targets.length;
  let done = 0;

  for (const pageIndex of targets) {
    const page = ctx.pages[pageIndex]!;
    const pageW = page.mediaBox[2] - page.mediaBox[0];
    const pageH = page.mediaBox[3] - page.mediaBox[1];
    const { x, y } = anchor(
      stamp.position,
      pageW,
      pageH,
      margin,
      textW,
      stamp.size
    );
    ctx.stampText(pageIndex, {
      x,
      y,
      text: stamp.text,
      size: stamp.size,
      font: "helveticaBold",
      color: stamp.color,
      opacity: stamp.opacity,
      rotate: stamp.rotate,
    });
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
        name: `${safeBaseName(file.name)}-stamped.pdf`,
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
