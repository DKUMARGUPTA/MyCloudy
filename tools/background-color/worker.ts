import { PdfError, StampContext } from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Background color worker (R50) — full-page solid fill behind (or over)
 * the content of the selected pages.
 *
 * 100% on OUR OWN PDF engine (StampContext.stampRect with `behind`).
 * Typed refusal for encrypted/corrupt inputs; progress per page; the
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

const PRESETS: Record<string, { r: number; g: number; b: number }> = {
  yellow: { r: 1, g: 0.95, b: 0.6 },
  ivory: { r: 1, g: 0.97, b: 0.87 },
  mint: { r: 0.85, g: 1, b: 0.9 },
  sky: { r: 0.85, g: 0.93, b: 1 },
  pink: { r: 1, g: 0.88, b: 0.92 },
  gray: { r: 0.92, g: 0.92, b: 0.92 },
};

interface BackgroundOptions {
  color: { r: number; g: number; b: number };
  colorName: string;
  opacity: number;
  behind: boolean;
}

function resolveOptions(options: OptionValues): BackgroundOptions | null {
  const key =
    typeof options.color === "string" && options.color.length > 0
      ? options.color
      : "yellow";

  let color: { r: number; g: number; b: number };
  if (key === "custom") {
    const raw =
      typeof options.hex === "string"
        ? options.hex.replace(/^#/, "").trim()
        : "";
    if (!/^[0-9a-fA-F]{6}$/.test(raw)) {
      return null; // invalid hex — typed refusal upstream
    }
    color = {
      r: Number.parseInt(raw.slice(0, 2), 16) / 255,
      g: Number.parseInt(raw.slice(2, 4), 16) / 255,
      b: Number.parseInt(raw.slice(4, 6), 16) / 255,
    };
  } else {
    color = PRESETS[key] ?? PRESETS.yellow!;
  }

  const opacityRaw = Number(options.opacity);
  const opacity = Number.isFinite(opacityRaw)
    ? Math.min(Math.max(opacityRaw, 10), 100) / 100
    : 1;
  const behind = options.layer !== "over";
  return { color, colorName: key, opacity, behind };
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const bg = resolveOptions(options);
  if (bg === null) {
    post({ type: "error", runId, code: "tool.errorBadHex" });
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
  const total = targets.length;
  let done = 0;

  for (const pageIndex of targets) {
    const page = ctx.pages[pageIndex]!;
    // Full MediaBox coverage — the fill IS the page background.
    const [x0, y0, x1, y1] = page.mediaBox;
    ctx.stampRect(pageIndex, {
      x: x0,
      y: y0,
      width: x1 - x0,
      height: y1 - y0,
      color: bg.color,
      opacity: bg.opacity,
      behind: bg.behind,
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
        name: `${safeBaseName(file.name)}-background.pdf`,
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
