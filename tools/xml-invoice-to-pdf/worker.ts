import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadStampFonts } from "../stamp-common/worker-lib";
import {
  MAX_XML_BYTES,
  classifyXmlError,
  invoiceIsEmpty,
  invoiceNeedsNoto,
  looksLikeXml,
  outputPdfName,
  parseCii,
  parseInvoiceLabels,
  parseXmlText,
} from "./model";
import { drawParsedInvoice, type RenderFonts } from "./render";
import type { XinvRunDetail } from "./types";

/**
 * XML e-invoice to PDF worker (RB5-d — 87th tool) — device-only, zero
 * network beyond the same-origin Devanagari font. The create-invoice /
 * word-to-pdf protocol:
 *
 *  1. read the XML text from request.files[0] (10 MB cap, sniffed as XML
 *     up front — garbage is rejected honestly before any parse);
 *  2. parse — DOMParser when the runtime has one, else the model's own
 *     namespace-tolerant parser (both produce the same tree);
 *  3. classify the root: UBL Invoice/CreditNote → honest "not supported
 *     yet" error; any other non-CII root → not a CII e-invoice;
 *  4. parseCii — missing nodes become parse ISSUES that surface in the
 *     result detail; the renderer draws what exists;
 *  5. font pick — pure-WinAnsi content embeds NO font at all (base-14
 *     Helvetica + HelveticaBold), while ANY Devanagari (or ₹) run embeds
 *     the self-hosted Noto Sans Devanagari subset (fontkit subset:true);
 *  6. drawParsedInvoice — the exact render.ts the smoke script drives —
 *     multi-page with repeated header, totals on the last page only.
 *
 * All display labels arrive pre-resolved in `labels` (the surface's t()),
 * so the PDF text matches the UI language exactly.
 */

async function run(request: WorkerRunRequest): Promise<void> {
  const runId = request.runId;
  const post = (msg: WorkerResponse): void => {
    (self as unknown as Worker).postMessage(msg);
  };
  try {
    const file = request.files[0];
    if (!file) {
      post({ type: "error", runId, code: "xinv.errNoFile" });
      return;
    }
    if (file.size > MAX_XML_BYTES) {
      post({
        type: "error",
        runId,
        code: "xinv.errTooLarge",
        detail: file.name,
      });
      return;
    }

    const text = await file.text();
    post({ type: "progress", runId, pct: 20, stage: "reading" });

    if (!looksLikeXml(text)) {
      post({ type: "error", runId, code: "xinv.errNotXml", detail: file.name });
      return;
    }
    const parsed = parseXmlText(text);
    const error = classifyXmlError(text, parsed);
    if (error !== null || !parsed.ok) {
      post({
        type: "error",
        runId,
        code: error ?? "xinv.errMalformed",
        detail: file.name,
      });
      return;
    }
    post({ type: "progress", runId, pct: 35, stage: "processing" });

    const inv = parseCii(parsed.root);
    if (invoiceIsEmpty(inv)) {
      post({ type: "error", runId, code: "xinv.errEmpty", detail: file.name });
      return;
    }

    const labels = parseInvoiceLabels(String(request.options.labels ?? ""));
    const pageSize = String(request.options.pageSize) === "letter" ? "letter" : "a4";
    const fileWord = String(request.options.fileWord ?? "").slice(0, 60);
    post({ type: "progress", runId, pct: 45, stage: "processing" });

    const doc = await PDFDocument.create();
    const needDeva = invoiceNeedsNoto(inv, labels);
    let deva: PDFFont | null = null;
    if (needDeva) {
      // the create-invoice/word-to-pdf recipe: fetch the self-hosted
      // Noto Sans Devanagari TTF + fontkit subset:true — only the used
      // glyphs ship in the output.
      const fontsApi = await loadStampFonts(doc, true);
      deva = fontsApi.fontFor("devanagari");
    }
    const fonts: RenderFonts = {
      base: doc.embedStandardFont(StandardFonts.Helvetica),
      bold: doc.embedStandardFont(StandardFonts.HelveticaBold),
      deva,
    };
    post({ type: "progress", runId, pct: 60, stage: "processing" });

    const report = drawParsedInvoice(doc, fonts, inv, { pageSize, labels });
    post({ type: "progress", runId, pct: 85, stage: "saving" });

    const bytes = await doc.save();
    const detail: XinvRunDetail = {
      pages: report.pages,
      lines: report.lines,
      totalLines: inv.totalLineCount,
      truncated: report.truncated,
      fontPath: report.fontPath,
      issueKeys: inv.issues.map((i) => "xinv." + i.code),
    };
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: outputPdfName(inv.meta.number, fileWord),
          mime: "application/pdf",
          blob: new Blob([bytes as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail,
    });
  } catch (error) {
    post({
      type: "error",
      runId,
      code: "tool.errorGeneric",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  if (event.data?.type === "run") void run(event.data);
};
