import type { OptionValues } from "@/lib/tools/config-types";
import {
  PdfError,
  StampContext,
  encodeWinAnsiBytes,
  type StampFontKey,
  type StampTtfFont,
} from "@/lib/own/pdf";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadDevanagariBytes } from "../stamp-common/deva";
import { resolveEditOps, type EditOp } from "./engine";

/**
 * Edit PDF text worker (PHASE-7): bakes the cover+redraw plan onto the
 * ORIGINAL document with our own StampContext — each edit is one
 * background rect over the old line and one redrawn text run at the
 * line's own baseline, auto-fitted to the covered band. Rotated pages
 * get rotation-compensated text (the full editor's rule: words read
 * upright). Devanagari replacements ride the embedded Noto TTF.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

const DEVA_RE = /[\u0900-\u097F]/;

const ITALIC_MAP: Record<string, StampFontKey> = {
  helvetica: "helveticaOblique",
  "helvetica-b": "helveticaBoldOblique",
  times: "timesItalic",
  "times-b": "timesBoldItalic",
  courier: "courierOblique",
  "courier-b": "courierBoldOblique",
};

export interface EptRunResult {
  bytes: Uint8Array;
  pages: number;
  editsApplied: number;
}

/** The whole pipeline, smoke-testable without a Worker PostMessage. */
export async function runEditText(
  bytes: Uint8Array,
  options: OptionValues
): Promise<EptRunResult> {
  let ctx: StampContext;
  try {
    ctx = StampContext.load(bytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }
  if (ctx.pageCount < 1) {
    throw new Error("tool.errorCorrupt");
  }

  const ops = resolveEditOps(options["edits"], ctx.pageCount);
  if (ops.length === 0) {
    throw new Error("ept.errorNoEdits");
  }

  // The Devanagari TTF loads once, only when some edit needs it.
  let deva: StampTtfFont | null = null;
  const devaFor = async (): Promise<StampTtfFont | null> => {
    if (deva !== null) return deva;
    try {
      const fontBytes = await loadDevanagariBytes();
      deva = ctx.embedTtf(fontBytes);
    } catch {
      deva = null;
    }
    return deva;
  };

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]!;
    const needsDeva = op.font.font === "devanagari" || DEVA_RE.test(op.text);
    if (!needsDeva) {
      // Standard-14 fonts are WinAnsi — an unencodable replacement
      // (emoji, exotic scripts) is skipped honestly, never corrupted.
      try {
        encodeWinAnsiBytes(op.text, "helvetica");
      } catch {
        continue;
      }
    }
    // 1. Cover the old line.
    ctx.stampRect(op.page, {
      x: op.cover.x,
      y: op.cover.y,
      width: op.cover.w,
      height: op.cover.h,
      color: op.bg,
    });
    // 2. Redraw the replacement at the line's baseline.
    const page = ctx.pages[op.page];
    const rotate =
      page.rotate === 90 || page.rotate === 180 || page.rotate === 270
        ? page.rotate
        : 0;
    if (needsDeva) {
      const ttf = await devaFor();
      if (ttf) {
        ctx.stampText(op.page, {
          x: op.x,
          y: op.y,
          text: op.text,
          size: op.size,
          ttf,
          rotate,
        });
        continue;
      }
    }
    const family = op.font.font === "times" || op.font.font === "courier"
      ? op.font.font
      : "helvetica";
    let key: StampFontKey = op.font.bold
      ? (`${family}Bold` as StampFontKey)
      : (family as StampFontKey);
    if (op.font.italic) {
      key = ITALIC_MAP[`${family}${op.font.bold ? "-b" : ""}`] ?? key;
    }
    ctx.stampText(op.page, {
      x: op.x,
      y: op.y,
      text: op.text,
      size: op.size,
      font: key,
      rotate,
    });
  }

  try {
    const saved = ctx.write();
    return {
      bytes: saved,
      pages: ctx.pageCount,
      editsApplied: ops.length,
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
  let result: EptRunResult;
  try {
    result = await runEditText(bytes, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^tool\.|^ept\./.test(message)
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
      name: `${safeBaseName(file.name)}-edited.pdf`,
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
      textEditsApplied: result.editsApplied,
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
