import {
  CreateContext,
  type CreatePage,
  type StampTtfFont,
} from "@/lib/own/pdf";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadDevanagariBytes } from "../stamp-common/deva";
import {
  cHexColor,
  cOutputName,
  planPages,
  sanitizeCSpec,
  type CLabel,
} from "./model";

/**
 * Create PDF export worker (PRD §7.3). The noFile SURFACE drives this
 * worker directly (write-pdf pattern): the sanitized template spec rides
 * options.doc as JSON (re-sanitized here — never trust the blob) and the
 * run carries no files at all.
 *
 * The pure model (./model.ts planPages) produces the whole drawing plan;
 * this worker just paints it through OUR engine (CreateContext, P6-i):
 * drawRectangle/drawLine/drawEllipse for rules + dots, drawText for the
 * labels — Helvetica standard-14 for Latin (WinAnsi through our metrics),
 * the embedded Noto Devanagari subset (embedTtf — OUR shaper/subsetter)
 * only when the Hindi planner needs it. Device-only, zero network with
 * file data, zero pdf-lib.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** Align-aware drawText (the anchor rules the model's CLabel documents). */
function drawLabel(
  page: CreatePage,
  label: CLabel,
  helvWidth: (t: string, s: number) => number,
  noto: StampTtfFont | null,
): void {
  if (label.text.length === 0) return;
  const useNoto = label.font === "noto" && noto !== null;
  const width = useNoto
    ? noto.measure(label.text, label.size)
    : helvWidth(label.text, label.size);
  const x =
    label.align === "center"
      ? label.x - width / 2
      : label.align === "right"
        ? label.x - width
        : label.x;
  page.drawText({
    x,
    y: label.y,
    text: label.text,
    size: label.size,
    color: cHexColor(label.color),
    ...(useNoto ? { ttf: noto } : { font: "helvetica" as const }),
  });
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options } = request;

  const docRaw = typeof options.doc === "string" ? options.doc : "";
  if (docRaw.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 6, stage: "reading" });

  let parsed: unknown;
  try {
    parsed = JSON.parse(docRaw);
  } catch {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const spec = sanitizeCSpec(parsed);

  post({ type: "progress", runId, pct: 10, stage: "processing" });

  const plan = planPages(spec);
  const ctx = CreateContext.create();
  let noto: StampTtfFont | null = null;
  if (plan.needNoto) {
    const bytes = await loadDevanagariBytes(); // throws "devanagari-font-fetch"
    noto = ctx.embedTtf(bytes);
  }
  const helvWidth = (text: string, size: number): number =>
    ctx.measure(text, "helvetica", size);

  for (let p = 0; p < plan.pages.length; p += 1) {
    const page = ctx.addPage(plan.width, plan.height);
    const laid = plan.pages[p];

    for (const rect of laid.rects) {
      page.drawRectangle({
        x: rect.x,
        y: rect.y,
        width: rect.w, // explicit width/height (the P4.4 pdf-lib rule)
        height: rect.h,
        color: cHexColor(rect.color),
      });
    }
    for (const line of laid.lines) {
      page.drawLine({
        start: { x: line.x1, y: line.y1 },
        end: { x: line.x2, y: line.y2 },
        thickness: line.width ?? 0.7,
        color: cHexColor(line.color),
      });
    }
    for (const dot of laid.dots) {
      // A filled ellipse with equal radii (pdf-lib has no drawCircle).
      page.drawEllipse({
        x: dot.x,
        y: dot.y,
        xScale: dot.r,
        yScale: dot.r,
        color: cHexColor(dot.color),
      });
    }
    for (const label of laid.labels) {
      drawLabel(page, label, helvWidth, noto);
    }

    post({
      type: "progress",
      runId,
      pct: Math.min(
        88,
        10 + Math.round(((p + 1) / plan.pages.length) * 78)
      ),
      stage: "processing",
      detail: { page: p + 1, pages: plan.pages.length },
    });
  }

  post({ type: "progress", runId, pct: 92, stage: "saving" });

  // R44 branding — metadata only; the document stays clean.
  ctx.setProducer("DocoPDF");
  ctx.setCreator("DocoPDF");
  ctx.setTitle(cOutputName(spec).replace(/\.pdf$/i, ""));
  ctx.setCreationDate(new Date());
  const saved = ctx.write();
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: cOutputName(spec),
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: {
      files: 1,
      pages: plan.pages.length,
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /font-fetch|devanagari|fontkit/i.test(message)
      ? "create.errorFont"
      : "tool.errorGeneric";
    post({
      type: "error",
      runId: data.runId,
      code,
      detail: code === "tool.errorGeneric" ? message.slice(0, 200) : undefined,
    });
  });
};
