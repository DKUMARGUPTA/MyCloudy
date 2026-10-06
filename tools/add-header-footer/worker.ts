import { PDFDocument } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { drawStampMark, loadStampFonts, safeStampBaseName } from "../stamp-common/worker-lib";
import { fileBaseName } from "../stamp-common/layout";
import { HF_SPEC, hfNeedsDevanagari, resolveHfOptions } from "./hf-options";

/**
 * Header & footer worker (PRD §8.2): stamps left/center/right header and
 * footer text with {page} {pages} {date} {filename} {title} variables onto
 * the chosen pages of a single PDF — on-device, pdf-lib only. Non-ASCII text
 * (e.g. Hindi) automatically renders with the self-hosted embedded
 * Devanagari font (subset), so Indian-language running heads just work.
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
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const pageCount = doc.getPageCount();
  const targets = HF_SPEC.targets(hf, pageCount);
  if (targets === null || targets.length === 0) {
    post({ type: "error", runId, code: "pn.errorNoPages" });
    return;
  }

  const rawTitle = doc.getTitle();
  const title = typeof rawTitle === "string" ? rawTitle : "";
  const fileBase = fileBaseName(file.name);
  const needDeva = hfNeedsDevanagari(hf, file.name, title);

  post({ type: "progress", runId, pct: 10, stage: "processing" });
  const fonts = await loadStampFonts(doc, needDeva);

  const total = targets.length;
  let done = 0;
  for (const pageIndex of targets) {
    const page = doc.getPage(pageIndex);
    const pageW = page.getWidth();
    const pageH = page.getHeight();

    const marks = HF_SPEC.marks(fonts.measure, hf, {
      pageIndex,
      pageCount,
      pageW,
      pageH,
      fileName: file.name,
      fileBase,
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
    const message = error instanceof Error ? error.message : String(error);
    const code = /encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : /devanagari|font-fetch/i.test(message)
        ? "pn.errorFont"
        : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code, detail: undefined });
  });
};
