import {
  ComposeContext,
  type ComposedForm,
  PdfError,
  pdfNumToString,
} from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type RunStage,
  type StageDetail,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  type RotateCustomOptions,
  effectiveRotation,
  placement,
  resolveRotateCustomOptions,
  rotatedDims,
} from "./engine";

/**
 * Rotate custom worker (PHASE-1 Batch B): every page is embedded as a
 * Form XObject once and re-drawn on a new sheet sized to the rotated
 * bounding box, rotated by the chosen angle — vectors, never pixels.
 *
 * Runs 100% on OUR OWN engine (ComposeContext). Never touches the
 * network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

/** q · translate · rotate · scale · /PgN Do · Q (pdf-lib drawPage parity). */
function drawRotatedOps(
  form: ComposedForm,
  sheet: { w: number; h: number },
  thetaDeg: number
): string {
  const t = placement(sheet, { w: form.width, h: form.height }, thetaDeg);
  const angle = (thetaDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    "q",
    `1 0 0 1 ${pdfNumToString(t.tx)} ${pdfNumToString(t.ty)} cm`,
    `${pdfNumToString(cos)} ${pdfNumToString(sin)} ${pdfNumToString(-sin)} ${pdfNumToString(cos)} 0 0 cm`,
    `/${form.key} Do`,
    "Q",
  ].join("\n");
}

export interface RcProgress {
  pct: number;
  stage: RunStage;
  detail?: StageDetail;
}

export interface RcRunResult {
  bytes: Uint8Array;
  pages: number;
}

/** The whole pipeline, smoke-testable without a Worker. */
export async function runRotateCustom(
  bytes: Uint8Array,
  options: OptionValues,
  onProgress?: (progress: RcProgress) => void
): Promise<RcRunResult> {
  const opts: RotateCustomOptions = resolveRotateCustomOptions(options);
  const theta = effectiveRotation(opts);

  let ctx: ComposeContext;
  try {
    ctx = ComposeContext.load(bytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }
  if (ctx.pageCount < 1) {
    throw new Error("tool.errorCorrupt");
  }

  for (let i = 0; i < ctx.pageCount; i += 1) {
    const page = ctx.pages[i]!;
    // UNROTATED crop dims (form space) — the /Rotate value is applied
    // on top of the custom angle for pages that were already turned.
    const w = page.cropBox[2] - page.cropBox[0];
    const h = page.cropBox[3] - page.cropBox[1];
    const norm = ((((Math.round(page.rotate / 90) * 90) % 360) + 360) % 360) as
      | 0
      | 90
      | 180
      | 270;
    const swap = norm === 90 || norm === 270;
    const effW = swap ? h : w;
    const effH = swap ? w : h;

    if (ctx.hasContents(i)) {
      const form = ctx.embedPage(i);
      const totalTheta = theta + norm;
      const dims = rotatedDims(effW, effH, theta);
      const ops = drawRotatedOps(form, dims, totalTheta);
      ctx.addSheet(dims.w, dims.h, ops, [i]);
    } else {
      // Legal empty page: an empty rotated-dims sheet.
      const dims = rotatedDims(effW, effH, theta);
      ctx.addSheet(dims.w, dims.h, "", []);
    }
    onProgress?.({
      pct: Math.round(10 + (80 / ctx.pageCount) * (i + 1)),
      stage: "processing",
      detail: { page: i + 1, pages: ctx.pageCount },
    });
  }

  onProgress?.({ pct: 94, stage: "saving" });
  try {
    const saved = ctx.write();
    return { bytes: saved, pages: ctx.pageCount };
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

  post({ type: "progress", runId, pct: 4, stage: "reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  let result: RcRunResult;
  try {
    result = await runRotateCustom(bytes, options, (progress) => {
      post({ type: "progress", runId, ...progress });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^rc\.|^tool\./.test(message)
      ? message
      : /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt";
    post({ type: "error", runId, code });
    return;
  }

  const outputs = [
    {
      name: `${safeBaseName(file.name)}-rotated.pdf`,
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
