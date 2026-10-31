import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import { pageText, type RawTextItem } from "../pdf-to-txt/text-layout";
import {
  buildExtractiveSummary,
  renderSummaryMarkdown,
  renderSummaryPlainText,
  SUMMARY_LENGTHS,
  type PageText,
  type SummaryLength,
} from "./worker-lib";

/**
 * Summarize PDF worker (P2 / R54) — REBUILT self-dependent: no /api call,
 * no provider, no network. pdf.js extracts every page's selectable text
 * (the pdf-to-txt recipe), the PURE TextRank engine ranks sentences, and
 * the report ships as Markdown or plain text with (p. N) citations on
 * every sentence. Extractive only — the sentences are verbatim.
 *
 * Scanned PDFs (zero selectable text) fail honestly — OCR first.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.pdf$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const length: SummaryLength = SUMMARY_LENGTHS.includes(
    options.length as SummaryLength,
  )
    ? (options.length as SummaryLength)
    : "standard";
  const format = options.format === "txt" ? "txt" : "md";

  post({ type: "progress", runId, pct: 10, stage: "reading" });
  const data = new Uint8Array(await file.arrayBuffer());

  const pdfjs = await loadPdfjsInWorker();
  const doc = await pdfjs.getDocument({
    data,
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;

  post({ type: "progress", runId, pct: 40, stage: "processing" });
  const pages: PageText[] = [];
  for (let i = 0; i < doc.numPages; i += 1) {
    const page = await doc.getPage(i + 1);
    const content = await page.getTextContent();
    page.cleanup();
    pages.push({ page: i + 1, text: pageText(content.items as RawTextItem[], "flow") });
    post({
      type: "progress",
      runId,
      pct: 40 + Math.round(((i + 1) / doc.numPages) * 50),
      stage: "processing",
      detail: { page: i + 1, pages: doc.numPages },
    });
  }
  doc.cleanup();

  const totalChars = pages.reduce(
    (sum, p) => sum + p.text.replace(/\s/g, "").length,
    0,
  );
  if (totalChars === 0) {
    post({ type: "error", runId, code: "tool.errorNoText", detail: file.name });
    return;
  }

  post({ type: "progress", runId, pct: 92, stage: "processing" });
  const summary = buildExtractiveSummary(pages, length);
  if (!summary) {
    post({ type: "error", runId, code: "tool.errorNoText", detail: file.name });
    return;
  }

  const body =
    format === "txt"
      ? renderSummaryPlainText(summary, file.name)
      : renderSummaryMarkdown(summary, file.name);

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${safeBaseName(file.name)}-summary.${format}`,
        mime: format === "txt" ? "text/plain;charset=utf-8" : "text/markdown;charset=utf-8",
        blob: new Blob([body], {
          type: format === "txt" ? "text/plain;charset=utf-8" : "text/markdown;charset=utf-8",
        }),
      },
    ],
    detail: {
      files: 1,
      pages: pages.length,
      sentences: summary.stats.sentencesConsidered,
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /password/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code });
  });
};
