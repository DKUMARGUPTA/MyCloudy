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
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  type BklOptions,
  bookletSides,
  resolveBklOptions,
  sheetGeometry,
} from "./engine";

/**
 * PDF booklet worker (PHASE-1 Batch A): saddle-stitch imposition via
 * ComposeContext — every selected page embeds ONCE as a Form XObject and
 * each imposed SIDE draws the two pages its slots call for. Pages are
 * placed to FIT their slot (aspect preserved, centred) — mixed source
 * sizes simply letterbox, never distort.
 *
 * Runs 100% on OUR OWN PDF micro-engine. Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

/** Fit a form into a slot, centred, aspect preserved (no rotation). */
function drawFormOps(
  form: ComposedForm,
  slot: { x: number; y: number; w: number; h: number }
): string {
  const scale = Math.min(
    slot.w / Math.max(1, form.width),
    slot.h / Math.max(1, form.height)
  );
  const visW = form.width * scale;
  const visH = form.height * scale;
  const tx = slot.x + (slot.w - visW) / 2;
  const ty = slot.y + (slot.h - visH) / 2;
  return [
    "q",
    `1 0 0 1 ${pdfNumToString(tx)} ${pdfNumToString(ty)} cm`,
    `${pdfNumToString(scale)} 0 0 ${pdfNumToString(scale)} 0 0 cm`,
    `/${form.key} Do`,
    "Q",
  ].join("\n");
}

export interface BklProgress {
  pct: number;
  stage: RunStage;
  detail?: StageDetail;
}

export interface BklRunResult {
  bytes: Uint8Array;
  /** Number of imposed output sides. */
  sides: number;
  /** Selected booklet pages. */
  pages: number;
  /** Blank pages appended for the multiple-of-4 rule. */
  blanks: number;
}

/**
 * The whole imposition pipeline, smoke-testable without a Worker.
 * Errors throw Error with an i18n key.
 */
export async function runBooklet(
  bytes: Uint8Array,
  options: OptionValues,
  onProgress?: (progress: BklProgress) => void
): Promise<BklRunResult> {
  const opts: BklOptions = resolveBklOptions(options);

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
  const indices = parsePageSpec(opts.pages, ctx.pageCount);
  if (indices === null || indices.length === 0) {
    throw new Error("tool.errorInvalidPages");
  }

  // Selected pages become the 1..n booklet; imposition may pad to a
  // multiple of 4 with blank slots.
  const selected = indices.length;
  const sides = bookletSides(selected);
  const geo = sheetGeometry(opts.paper, opts.marginMm, opts.gapMm);

  // Pre-embed every page ONCE (each imposed side reuses the same form).
  const forms = new Map<number, ComposedForm>();
  indices.forEach((pageIndex) => {
    if (ctx.hasContents(pageIndex)) {
      forms.set(pageIndex, ctx.embedPage(pageIndex));
    }
  });

  const formPagesBySheet: number[][] = [];
  const opsBySheet: string[] = [];
  sides.forEach((side, i) => {
    const parts: string[] = [];
    const formPages: number[] = [];
    const slots: Array<{ page: number; slot: { x: number; y: number; w: number; h: number } }> = [
      { page: side.left, slot: geo.left },
      { page: side.right, slot: geo.right },
    ];
    for (const { page, slot } of slots) {
      // page is 1-based into the SELECTED booklet; -1 never occurs here
      // (bookletSides pads via side counts, and blanks are skipped).
      if (page < 1 || page > selected) continue;
      const pageIndex = indices[page - 1]!;
      const form = forms.get(pageIndex);
      if (form) {
        parts.push(drawFormOps(form, slot));
        formPages.push(pageIndex);
      }
    }
    opsBySheet.push(parts.join("\n"));
    formPagesBySheet.push(formPages);
    onProgress?.({
      pct: Math.round(10 + (80 / sides.length) * (i + 1)),
      stage: "processing",
      detail: { page: i + 1, pages: sides.length },
    });
  });

  sides.forEach((_, i) => {
    ctx.addSheet(geo.width, geo.height, opsBySheet[i] ?? "", formPagesBySheet[i] ?? []);
  });

  onProgress?.({ pct: 94, stage: "saving" });
  try {
    const saved = ctx.write();
    const blanks = sides.length * 2 - selected;
    return {
      bytes: saved,
      sides: sides.length,
      pages: selected,
      blanks: blanks > 0 ? blanks : 0,
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

  post({ type: "progress", runId, pct: 4, stage: "reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  let result: BklRunResult;
  try {
    result = await runBooklet(bytes, options, (progress) => {
      post({ type: "progress", runId, ...progress });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^bkl\.|^tool\./.test(message)
      ? message
      : /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt";
    post({ type: "error", runId, code });
    return;
  }

  const outputs = [
    {
      name: `${safeBaseName(file.name)}-booklet.pdf`,
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
    detail: { files: 1, pages: result.sides },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
