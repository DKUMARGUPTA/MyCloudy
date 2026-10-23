import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadStampFonts } from "../stamp-common/worker-lib";
import { needsNoto, outputPdfName, parsePub, PubError } from "./model";
import { drawPubPdf } from "./render";

/**
 * Publisher to PDF worker (RB4-e) — device-only, zero network beyond the
 * same-origin font. Mirrors the word-to-pdf worker protocol:
 *
 *  1. read the .pub bytes from request.files[0] and run the honest
 *     salvage pipeline (parseCfb container → UTF-16LE story triage →
 *     reflowed paragraphs — the exact same model the surface previews
 *     with, so preview and output can never disagree);
 *  2. empty result → the honest verdict: errStreamRead when stream
 *     chains broke, errNoText when the container simply held no text;
 *  3. font pick — pure-WinAnsi content embeds NO font at all (base-14
 *     Helvetica + HelveticaBold for heuristic headings), while ANY
 *     Devanagari character switches to the self-hosted Noto Sans
 *     Devanagari (fontkit subset:true) — the create-resume recipe;
 *  4. drawPubPdf — the exact render.ts the smoke script drives;
 *  5. save with producer/creator "DocoPDF" and the localized name.
 *
 * Options: pageSize ("a4"|"letter"), margin ("normal"|"narrow"),
 * fontSize (8–18, default 10.5) and fileWord (the localized fallback
 * word for a nameless file).
 *
 * Error mapping:
 *   PubError errNotPub/errZipFile/errTextFile/errCorrupt/errNoText/
 *   errStreamRead → pub.<code>; font-fetch failures → pub.errFont;
 *   anything else → tool.errorGeneric.
 */

function post(response: WorkerResponse): void {
  (self as unknown as Worker).postMessage(response);
}

function mapError(error: unknown): string {
  if (error instanceof PubError) return `pub.${error.code}`;
  const message = error instanceof Error ? error.message : String(error);
  if (/font-fetch|devanagari|fontkit/i.test(message)) return "pub.errFont";
  return "tool.errorGeneric";
}

async function run(request: WorkerRunRequest): Promise<void> {
  const runId = request.runId;
  try {
    const file = request.files[0];
    if (!file) {
      post({ type: "error", runId, code: "pub.errNoFile" });
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    post({ type: "progress", runId, pct: 20, stage: "processing" });

    // container → stories → reflow (all caps/clamps live in the model)
    const doc = parsePub(bytes);
    if (doc.paras.length === 0) {
      post({
        type: "error",
        runId,
        code:
          doc.streamsFailed > 0 ? "pub.errStreamRead" : "pub.errNoText",
        detail: file.name,
      });
      return;
    }

    const opts = {
      pageSize: (String(request.options.pageSize) === "letter"
        ? "letter"
        : "a4") as "a4" | "letter",
      margin: (String(request.options.margin) === "narrow"
        ? "narrow"
        : "normal") as "normal" | "narrow",
    };
    const fontSizeRaw = Number(request.options.fontSize);
    const baseSize = Number.isFinite(fontSizeRaw)
      ? Math.min(18, Math.max(8, fontSizeRaw))
      : 10.5;
    const fileWord = String(request.options.fileWord ?? "")
      .slice(0, 60)
      .trim();

    const pdfDoc = await PDFDocument.create();
    let font: PDFFont;
    let boldFont: PDFFont | null = null;
    if (needsNoto(doc)) {
      // Devanagari (or any non-WinAnsi) content → the embedded Noto
      // subset. OFL ships Regular only: heuristic headings keep their
      // size hierarchy, weight falls back to the regular face.
      const fonts = await loadStampFonts(pdfDoc, true);
      font = fonts.fontFor("devanagari");
    } else {
      font = pdfDoc.embedStandardFont(StandardFonts.Helvetica);
      boldFont = pdfDoc.embedStandardFont(StandardFonts.HelveticaBold);
    }
    post({ type: "progress", runId, pct: 45, stage: "processing" });

    const report = drawPubPdf(pdfDoc, font, boldFont, doc, {
      ...opts,
      baseSize,
    });
    post({ type: "progress", runId, pct: 85, stage: "saving" });

    pdfDoc.setProducer("DocoPDF");
    pdfDoc.setCreator("DocoPDF");
    pdfDoc.setTitle(outputPdfName(file.name, fileWord).replace(/\.pdf$/i, ""));
    pdfDoc.setCreationDate(new Date());

    const outBytes = await pdfDoc.save();
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: outputPdfName(file.name, fileWord),
          mime: "application/pdf",
          blob: new Blob([outBytes as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: {
        pages: report.pages,
        paragraphs: doc.paraCount,
        chars: doc.charCount,
        streams: doc.streamsUsed,
        streamsFailed: doc.streamsFailed,
      },
    });
  } catch (error) {
    post({
      type: "error",
      runId,
      code: mapError(error),
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  if (event.data?.type === "run") void run(event.data);
};
