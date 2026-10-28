import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { StampContext, type StampFontKey, type StampTtfFont } from "@/lib/own/pdf";
import { loadDevanagariBytes, safeStampBaseName } from "../stamp-common/deva";
import { fileBaseName, type TextMeasurer } from "../stamp-common/layout";
import { HF_SPEC, hfNeedsDevanagari, resolveHfOptions } from "./hf-options";

/**
 * Header & footer worker (PRD §8.2): stamps left/center/right header and
 * footer text with {page} {pages} {date} {filename} {title} variables onto
 * the chosen pages of a single PDF — on-device, zero network (except the
 * self-hosted /fonts TTF fetch when Devanagari text is involved).
 *
 * P6-g: 100% OUR OWN PDF ENGINE — including the Devanagari route ({title}/
 * {filename}/literal Hindi text is shaped by OUR GSUB/Indic shaper and
 * embedded as a Type0/CIDFontType2 subset through our engine; fontkit-parity
 * verified in smoke-pdf-core §17). The mark math comes from HF_SPEC.marks —
 * the SAME pure functions the live preview canvas uses.
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
  const hf = resolveHfOptions(options);

  post({ type: "progress", runId, pct: 4, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());

  const ctx = StampContext.load(bytes);
  const targets = HF_SPEC.targets(hf, ctx.pageCount);
  if (targets === null || targets.length === 0) {
    post({ type: "error", runId, code: "pn.errorNoPages" });
    return;
  }

  const title = ctx.getTitle();
  const fileBase = fileBaseName(file.name);

  let deva: StampTtfFont | null = null;
  if (hfNeedsDevanagari(hf, file.name, title)) {
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

  post({ type: "progress", runId, pct: 10, stage: "processing" });
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

    const marks = HF_SPEC.marks(measure, hf, {
      pageIndex,
      pageCount: ctx.pageCount,
      pageW,
      pageH,
      fileName: file.name,
      fileBase,
      title,
    });
    for (const mark of marks) {
      // drawStampMark parity: baseline 0.25em above the box bottom; the mark
      // color intentionally not applied (legacy draws black).
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
      name: `${safeStampBaseName(file.name)}-header-footer.pdf`,
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
