import { PDFDocument } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { StampContext, type StampFontKey } from "@/lib/own/pdf";
import { drawStampMark, loadStampFonts, safeStampBaseName } from "../stamp-common/worker-lib";
import type { TextMeasurer } from "../stamp-common/layout";
import { fileBaseName } from "../stamp-common/layout";
import { PN_SPEC, pnNeedsDevanagari, resolvePnOptions } from "./pn-options";

/**
 * Add page numbers worker (PRD §8.2): stamps the formatted page number onto
 * the chosen pages of a single PDF — on-device, zero network (except the
 * self-hosted /fonts TTF fetch when Hindi digits are on).
 *
 * P6-f: runs on OUR OWN PDF engine (src/lib/own/pdf StampContext — standard
 * base-14 fonts with pdf-lib-identical metrics). The one remaining pdf-lib
 * branch is the documented DEVANAGARI seam: Hindi digits need the embedded
 * Noto subset with GSUB shaping, which is the next engine phase (P6-g); that
 * path keeps the byte-identical legacy behavior.
 *
 * The mark math (text, center, size, font) comes from PN_SPEC.marks — the
 * SAME pure functions the live preview canvas uses.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** The legacy pdf-lib run — reached ONLY when Hindi digits are requested. */
async function runLegacy(
  runId: number,
  bytes: Uint8Array,
  pn: ReturnType<typeof resolvePnOptions>,
  fileName: string
): Promise<void> {
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const pageCount = doc.getPageCount();
  const targets = PN_SPEC.targets(pn, pageCount);
  if (targets === null || targets.length === 0) {
    post({ type: "error", runId, code: "pn.errorNoPages" });
    return;
  }

  const rawTitle = doc.getTitle();
  const title = typeof rawTitle === "string" ? rawTitle : "";
  post({ type: "progress", runId, pct: 10, stage: "processing" });
  const fonts = await loadStampFonts(doc, true);

  const total = targets.length;
  let done = 0;
  for (const pageIndex of targets) {
    const page = doc.getPage(pageIndex);
    const pageW = page.getWidth();
    const pageH = page.getHeight();

    const marks = PN_SPEC.marks(fonts.measure, pn, {
      pageIndex,
      pageCount,
      pageW,
      pageH,
      fileName,
      fileBase: fileBaseName(fileName),
      title,
    });
    for (const mark of marks) {
      drawStampMark(page, mark, fonts.fontFor(mark.fontId));
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
  const saved = await doc.save({ useObjectStreams: true });
  const outputs = [
    {
      name: `${safeStampBaseName(fileName)}-numbered.pdf`,
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

/** The P6-f own-engine run — every Latin-digits page number goes through here. */
async function runOwn(
  runId: number,
  bytes: Uint8Array,
  pn: ReturnType<typeof resolvePnOptions>,
  fileName: string
): Promise<void> {
  const ctx = StampContext.load(bytes);
  const targets = PN_SPEC.targets(pn, ctx.pageCount);
  if (targets === null || targets.length === 0) {
    post({ type: "error", runId, code: "pn.errorNoPages" });
    return;
  }

  const title = ctx.getTitle();
  post({ type: "progress", runId, pct: 10, stage: "processing" });
  // Widen to the spec's TextMeasurer shape; "devanagari" is unreachable here
  // (the branch above routed Hindi digits to the legacy seam).
  const measure: TextMeasurer = (text, fontId, size) => {
    if (fontId === "devanagari") throw new Error("devanagari unreachable");
    return ctx.measure(text, fontId, size);
  };

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
      fileName,
      fileBase: fileBaseName(fileName),
      title,
    });
    for (const mark of marks) {
      if (mark.fontId === "devanagari") {
        throw new Error("devanagari unreachable");
      }
      const font: StampFontKey = mark.fontId;
      // drawStampMark parity: baseline 0.25em above the box bottom, and —
      // like the legacy drawStampMark — the mark COLOR is not applied here
      // (pdf-lib's default fill is black; the color lives in the preview only).
      const textW = ctx.measure(mark.text, font, mark.size);
      ctx.stampText(pageIndex, {
        x: mark.cx - textW / 2,
        y: mark.cy - mark.size * 0.25,
        text: mark.text,
        size: mark.size,
        font,
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
      name: `${safeStampBaseName(fileName)}-numbered.pdf`,
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

  if (pnNeedsDevanagari(pn)) {
    // The documented Devanagari seam (P6-g will move this onto the own engine).
    await runLegacy(runId, bytes, pn, file.name);
    return;
  }
  await runOwn(runId, bytes, pn, file.name);
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : /devanagari|font-fetch/i.test(message)
        ? "pn.errorFont"
        : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code, detail: undefined });
  });
};
