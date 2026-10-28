import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { StampContext, type StampFontKey, type StampTtfFont } from "@/lib/own/pdf";
import { loadDevanagariBytes, safeStampBaseName } from "../stamp-common/deva";
import { fileBaseName, type TextMeasurer } from "../stamp-common/layout";
import { PN_SPEC, pnNeedsDevanagari, resolvePnOptions } from "./pn-options";

/**
 * Add page numbers worker (PRD §8.2): stamps the formatted page number onto
 * the chosen pages of a single PDF — on-device, zero network (except the
 * self-hosted /fonts TTF fetch when Hindi digits are on).
 *
 * P6-g: 100% OUR OWN PDF ENGINE — including the Devanagari route (the
 * embedded Noto subset is shaped by OUR GSUB/Indic shaper and written as a
 * Type0/CIDFontType2 subset via our engine; fontkit-parity verified in
 * smoke-pdf-core §17). The mark math comes from PN_SPEC.marks — the SAME
 * pure functions the live preview canvas uses.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const pn = resolvePnOptions(options);

  post({ type: "progress", runId, pct: 4, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());

  const ctx = StampContext.load(bytes);
  const targets = PN_SPEC.targets(pn, ctx.pageCount);
  if (targets === null || targets.length === 0) {
    post({ type: "error", runId, code: "pn.errorNoPages" });
    return;
  }

  const title = ctx.getTitle();
  post({ type: "progress", runId, pct: 10, stage: "processing" });

  let deva: StampTtfFont | null = null;
  if (pnNeedsDevanagari(pn)) {
    try {
      deva = ctx.embedTtf(await loadDevanagariBytes());
    } catch (error) {
      if (error instanceof Error && /font-fetch/.test(error.message)) {
        post({ type: "error", runId, code: "pn.errorFont" });
        return;
      }
      throw error;
    }
  }

  const measure: TextMeasurer = (text, fontId, size) =>
    fontId === "devanagari"
      ? deva
        ? deva.measure(text, size)
        : (() => {
            throw new Error("devanagari unreachable");
          })()
      : ctx.measure(text, fontId as StampFontKey, size);

  const total = targets.length;
  let done = 0;
  for (const pageIndex of targets) {
    const page = ctx.pages[pageIndex]!;
    const pageW = page.mediaBox[2] - page.mediaBox[0];
    const pageH = page.mediaBox[3] - page.mediaBox[1];

    const marks = PN_SPEC.marks(measure, pn, {
      pageIndex,
      pageCount: ctx.pageCount,
      pageW,
      pageH,
      fileName: file.name,
      fileBase: fileBaseName(file.name),
      title,
    });
    for (const mark of marks) {
      // drawStampMark parity: baseline 0.25em above the box bottom; the mark
      // COLOR intentionally not applied (legacy drawStampMark draws black —
      // the color lives in the preview only).
      const isDeva = mark.fontId === "devanagari";
      if (isDeva && !deva) throw new Error("devanagari unreachable");
      const textW = isDeva
        ? deva!.measure(mark.text, mark.size)
        : ctx.measure(mark.text, mark.fontId as StampFontKey, mark.size);
      ctx.stampText(pageIndex, {
        x: mark.cx - textW / 2,
        y: mark.cy - mark.size * 0.25,
        text: mark.text,
        size: mark.size,
        font: isDeva ? undefined : (mark.fontId as StampFontKey),
        ttf: isDeva ? (deva ?? undefined) : undefined,
        opacity: mark.opacity,
      });
    }

    done += 1;
    post({
      type: "progress",
      runId,
      pct: Math.round(10 + (done / total) * 84),
      stage: "processing",
      detail: { page: done, pages: total },
    });
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  const saved = ctx.write();
  const outputs = [
    {
      name: `${safeStampBaseName(file.name)}-numbered.pdf`,
      mime: "application/pdf",
      blob: new Blob([saved as unknown as BlobPart], {
        type: "application/pdf",
      }),
    },
  ];

  post({
    type: "result",
    runId,
    outputs,
    detail: { files: 1, pages: total },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    if (error instanceof Error && error.name === "PdfError") {
      const code =
        (error as Error & { code?: string }).code === "encrypted"
          ? "tool.errorEncrypted"
          : "tool.errorCorrupt";
      post({ type: "error", runId: data.runId, code, detail: undefined });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const code = /encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : /devanagari|font-fetch/i.test(message)
        ? "pn.errorFont"
        : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code, detail: undefined });
  });
};
