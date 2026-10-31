import {
  ComposeContext,
  type ComposedForm,
  PdfError,
  pdfNumToString,
} from "@/lib/own/pdf";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Combine to single page — device-only worker.
 *
 * Runs 100% on OUR OWN PDF micro-engine (src/lib/own/pdf). Every page is
 * embedded ONCE as a Form XObject (CROP-box bounded, own-or-inherited
 * Resources) and drawn /Rotate-aware — the same placement quadrants the
 * N-up tool pins (tools/pages-per-sheet/worker.ts drawFormOps): the
 * composed `q · translate · rotate · scale · /PgN Do · Q` sequence.
 *
 * Vertical mode stacks pages top-to-bottom, each scaled to the chosen
 * common width; horizontal runs left-to-right at a common height. The
 * PDF page-size cap (14,400 pt) paginates longer strips onto extra
 * output pages automatically — nothing is ever cut off. Never touches
 * the network.
 */

/** Slightly under the engine's 14,400 pt hard cap — safety margin. */
const MAX_DIM = 14_000;
/** Hairline gap when "gap" is on (pt — a printer's 0.4 mm). */
const GAP_PT = 1.2;

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

/** Normalizes any /Rotate-style angle to 0 / 90 / 180 / 270. */
function normalizeRotation(rotation: number): 0 | 90 | 180 | 270 {
  return (((Math.round(rotation / 90) * 90) % 360) + 360) % 360 as 0 | 90 | 180 | 270;
}

/** Displayed (reader-visible) dims of a form rotated by /Rotate. */
function displayDims(
  rotation: number,
  w: number,
  h: number
): { dw: number; dh: number } {
  return normalizeRotation(rotation) % 180 === 0 ? { dw: w, dh: h } : { dw: h, dh: w };
}

/**
 * /Rotate-aware draw of one embedded form with its visible box at
 * (visX, visY, visW, visH) — the anchor sits on the quadrant the rotated
 * axes grow INTO (the N-up placement rule, kept verbatim).
 */
function drawFormOps(
  form: ComposedForm,
  rotation: number,
  visX: number,
  visY: number,
  visW: number,
  visH: number
): string {
  const swap = normalizeRotation(rotation) === 90 || normalizeRotation(rotation) === 270;
  const scale = swap
    ? Math.min(visW / Math.max(1, form.height), visH / Math.max(1, form.width))
    : Math.min(visW / Math.max(1, form.width), visH / Math.max(1, form.height));
  const drawW = form.width * scale;
  const drawH = form.height * scale;
  const r = normalizeRotation(rotation);
  let x = visX;
  let y = visY;
  if (r === 90) {
    y = visY + visH;
  } else if (r === 180) {
    x = visX + visW;
    y = visY + visH;
  } else if (r === 270) {
    x = visX + visW;
  }
  const angle = ((360 - r) % 360) * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    "q",
    `1 0 0 1 ${pdfNumToString(x)} ${pdfNumToString(y)} cm`,
    `${pdfNumToString(cos)} ${pdfNumToString(sin)} ${pdfNumToString(-sin)} ${pdfNumToString(cos)} 0 0 cm`,
    `${pdfNumToString(scale)} 0 0 ${pdfNumToString(scale)} 0 0 cm`,
    `/${form.key} Do`,
    "Q",
  ].join("\n");
}

interface PageInfo {
  index: number;
  form: ComposedForm | null;
  rotation: 0 | 90 | 180 | 270;
  /** Display dims (pt). */
  dw: number;
  dh: number;
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const vertical = String(options.direction ?? "vertical") !== "horizontal";
  const widthModeRaw = String(options.width ?? "first");
  const widthMode: "first" | "widest" | "narrowest" =
    widthModeRaw === "widest" || widthModeRaw === "narrowest"
      ? (widthModeRaw as "widest" | "narrowest")
      : "first";
  const gap = options.gap === true ? GAP_PT : 0;

  post({ type: "progress", runId, pct: 5, stage: "reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  let ctx: ComposeContext;
  try {
    ctx = ComposeContext.load(bytes);
  } catch (error: unknown) {
    post({ type: "error", runId, code: engineErrorCode(error), detail: file.name });
    return;
  }
  if (ctx.pageCount < 2) {
    post({ type: "error", runId, code: "tool.errorNothingToDo", detail: undefined });
    return;
  }

  // Embed every page once; remember its display dims.
  const pages: PageInfo[] = [];
  const embedSpan = 30 / ctx.pageCount;
  for (let i = 0; i < ctx.pageCount; i += 1) {
    const page = ctx.pages[i];
    const view = {
      w: page.cropBox[2] - page.cropBox[0],
      h: page.cropBox[3] - page.cropBox[1],
    };
    const rotation = normalizeRotation(page.rotate);
    const disp = displayDims(rotation, view.w, view.h);
    pages.push({
      index: i,
      form: ctx.hasContents(i) ? ctx.embedPage(i) : null,
      rotation,
      dw: disp.dw,
      dh: disp.dh,
    });
    post({
      type: "progress",
      runId,
      pct: Math.round(5 + embedSpan * (i + 1)),
      stage: "processing",
      detail: { page: i + 1, pages: ctx.pageCount },
    });
  }

  // Target cross-size: the width every page is scaled to (vertical mode)
  // or the height (horizontal mode).
  let target: number;
  if (vertical) {
    const widths = pages.map((p) => p.dw);
    target =
      widthMode === "widest"
        ? Math.max(...widths)
        : widthMode === "narrowest"
          ? Math.min(...widths)
          : (widths[0] ?? 595.28);
  } else {
    const heights = pages.map((p) => p.dh);
    target = heights[0] ?? 841.89;
  }
  target = Math.min(MAX_DIM, Math.max(50, target));

  // Per-page scaled display size (uniform scale to the target cross size,
  // clamped so no single page exceeds the strip cap).
  const scaled = pages.map((p) => {
    let dw = p.dw;
    let dh = p.dh;
    const cross = vertical ? dw : dh;
    if (cross > 0) {
      const s = target / cross;
      dw *= s;
      dh *= s;
    }
    if (vertical && dh > MAX_DIM) {
      const s = MAX_DIM / dh;
      dw *= s;
      dh = MAX_DIM;
    } else if (!vertical && dw > MAX_DIM) {
      const s = MAX_DIM / dw;
      dh *= s;
      dw = MAX_DIM;
    }
    return { dw, dh };
  });

  // Greedy pagination: fill one output page up to the cap, then continue.
  // `along` = distance of the item's start from the strip's top/left edge,
  // gaps included — computed once here, used verbatim in placement.
  interface StripItem {
    page: PageInfo;
    w: number;
    h: number;
    along: number;
  }
  interface Strip {
    items: StripItem[];
    size: number;
    used: number;
  }
  const strips: Strip[] = [];
  let strip: Strip | null = null;
  for (let i = 0; i < pages.length; i += 1) {
    const itemLen = vertical ? scaled[i].dh : scaled[i].dw;
    const itemCross = vertical ? scaled[i].dw : scaled[i].dh;
    const need = itemLen + (strip !== null && strip.items.length > 0 ? gap : 0);
    if (strip === null || (strip.items.length > 0 && strip.used + need > MAX_DIM)) {
      strip = { items: [], size: 0, used: 0 };
      strips.push(strip);
    }
    const along = strip.used;
    strip.used += need;
    strip.size = Math.max(strip.size, itemCross);
    strip.items.push({ page: pages[i], w: scaled[i].dw, h: scaled[i].dh, along });
  }

  // Place items: reading order — first page at the TOP (Y grows up).
  const sheetSpan = 55 / strips.length;
  strips.forEach((s, si) => {
    const ops: string[] = [];
    const usedForms: number[] = [];
    const stripLen = s.used;
    for (const item of s.items) {
      if (!item.page.form) continue; // empty page: keeps its space, draws nothing
      const crossPos = (s.size - (vertical ? item.w : item.h)) / 2;
      if (vertical) {
        const visX = crossPos;
        const visY = stripLen - item.along - item.h;
        ops.push(drawFormOps(item.page.form, item.page.rotation, visX, visY, item.w, item.h));
      } else {
        const visX = item.along;
        const visY = crossPos;
        ops.push(drawFormOps(item.page.form, item.page.rotation, visX, visY, item.w, item.h));
      }
      usedForms.push(item.page.index);
    }
    const w = vertical ? s.size : stripLen;
    const h = vertical ? stripLen : s.size;
    ctx.addSheet(w, h, ops.join("\n"), usedForms);
    post({
      type: "progress",
      runId,
      pct: Math.round(35 + sheetSpan * (si + 1)),
      stage: "processing",
      detail: { page: si + 1, pages: strips.length },
    });
  });

  post({ type: "progress", runId, pct: 93, stage: "saving" });
  let out: Uint8Array;
  try {
    out = ctx.write();
  } catch (error: unknown) {
    post({ type: "error", runId, code: engineErrorCode(error), detail: undefined });
    return;
  }

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${safeBaseName(file.name)}-combined.pdf`,
        mime: "application/pdf",
        blob: new Blob([out as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: 1, pages: strips.length },
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
