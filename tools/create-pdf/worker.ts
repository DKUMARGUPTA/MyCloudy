import { PDFDocument, rgb } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadStampFonts } from "../stamp-common/worker-lib";
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
 * this worker just paints it with pdf-lib: drawLine for rules, a tiny
 * filled drawEllipse for dots, and drawText for the labels — Helvetica
 * standard-14 for Latin, the embedded Noto Devanagari subset (stamp-common
 * recipe) only when the Hindi planner needs it. Device-only, zero network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function colorOf(hex: string | undefined): ReturnType<typeof rgb> {
  const { r, g, b } = cHexColor(hex);
  return rgb(r, g, b);
}

/** Align-aware drawText (the anchor rules the model's CLabel documents). */
function drawLabel(
  page: import("pdf-lib").PDFPage,
  label: CLabel,
  fonts: { helv: import("pdf-lib").PDFFont; noto: import("pdf-lib").PDFFont | null }
): void {
  if (label.text.length === 0) return;
  const font =
    label.font === "noto" && fonts.noto ? fonts.noto : fonts.helv;
  const width = font.widthOfTextAtSize(label.text, label.size);
  const x =
    label.align === "center"
      ? label.x - width / 2
      : label.align === "right"
        ? label.x - width
        : label.x;
  page.drawText(label.text, {
    x,
    y: label.y,
    size: label.size,
    font,
    color: colorOf(label.color),
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
  const pdf = await PDFDocument.create();
  const stampFonts = await loadStampFonts(pdf, plan.needNoto);
  const fonts = {
    helv: stampFonts.fontFor("helvetica"),
    noto: plan.needNoto ? stampFonts.fontFor("devanagari") : null,
  };

  for (let p = 0; p < plan.pages.length; p += 1) {
    const page = pdf.addPage([plan.width, plan.height]);
    const laid = plan.pages[p];

    for (const rect of laid.rects) {
      page.drawRectangle({
        x: rect.x,
        y: rect.y,
        width: rect.w, // explicit width/height (the P4.4 pdf-lib rule)
        height: rect.h,
        color: colorOf(rect.color),
      });
    }
    for (const line of laid.lines) {
      page.drawLine({
        start: { x: line.x1, y: line.y1 },
        end: { x: line.x2, y: line.y2 },
        thickness: line.width ?? 0.7,
        color: colorOf(line.color),
      });
    }
    for (const dot of laid.dots) {
      // pdf-lib has no drawCircle — a filled ellipse with equal radii is one
      page.drawEllipse({
        x: dot.x,
        y: dot.y,
        xScale: dot.r,
        yScale: dot.r,
        color: colorOf(dot.color),
      });
    }
    for (const label of laid.labels) {
      drawLabel(page, label, fonts);
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

  const saved = await pdf.save({ useObjectStreams: true });
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
