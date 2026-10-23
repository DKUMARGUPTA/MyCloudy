import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadStampFonts } from "../stamp-common/worker-lib";
import { needsNoto, outputBaseName, parseRtf, stats } from "./model";
import { drawRtfPdf, type RtfFonts } from "./render";

/**
 * RTF to PDF worker (RB2-c — 73rd tool) — device-only, zero network
 * beyond the same-origin font. Mirrors the word-to-pdf worker protocol:
 *
 *  1. read the .rtf bytes from request.files[0] and parseRtf them (the
 *     control-word tokenizer + group-stack parser — RTF is plain text,
 *     no zip). Null → the {\rtf magic was missing (honest rejection);
 *     zero paragraphs → no readable content;
 *  2. font pick — pure-WinAnsi content embeds NO font at all (base-14
 *     Helvetica + Bold + Oblique + BoldOblique, all free), while ANY
 *     Devanagari char (incl. \uNNNN? escapes) switches to the
 *     self-hosted Noto Sans Devanagari (fontkit subset:true) — the
 *     create-resume/stamp-common recipe;
 *  3. drawRtfPdf — the exact render.ts the smoke script drives;
 *  4. save with producer "DocoPDF" and the localized file name.
 *
 * Options: pageSize ("auto"|"a4"|"letter"), margin
 * ("auto"|"normal"|"narrow") and locale ("en"|"hi" — the localized
 * fallback word for a nameless file).
 */

async function run(request: WorkerRunRequest): Promise<void> {
  const runId = request.runId;
  const post = (msg: WorkerResponse): void => {
    (self as unknown as Worker).postMessage(msg);
  };
  try {
    const file = request.files[0];
    if (!file) {
      post({
        type: "error",
        runId,
        code: "rtfp.errNoFile",
      });
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    post({ type: "progress", runId, pct: 20, stage: "processing" });

    const doc = parseRtf(bytes);
    if (!doc) {
      post({
        type: "error",
        runId,
        code: "rtfp.errNotRtf",
        detail: file.name,
      });
      return;
    }
    if (doc.paras.length === 0) {
      post({
        type: "error",
        runId,
        code: "rtfp.errNoDoc",
        detail: file.name,
      });
      return;
    }

    const opts = {
      pageSize: (String(request.options.pageSize) === "a4"
        ? "a4"
        : String(request.options.pageSize) === "letter"
          ? "letter"
          : "auto") as "auto" | "a4" | "letter",
      margin: (String(request.options.margin) === "normal"
        ? "normal"
        : String(request.options.margin) === "narrow"
          ? "narrow"
          : "auto") as "auto" | "normal" | "narrow",
    };
    const locale = String(request.options.locale) === "hi" ? "hi" : "en";

    const pdfDoc = await PDFDocument.create();
    let fonts: RtfFonts;
    if (needsNoto(doc)) {
      // Devanagari (or any non-WinAnsi) content → the embedded Noto
      // subset. OFL ships Regular only: every style renders regular
      // (hierarchy comes from size) — the honest Hindi answer.
      const stampFonts = await loadStampFonts(pdfDoc, true);
      const noto: PDFFont = stampFonts.fontFor("devanagari");
      fonts = {
        regular: noto,
        bold: null,
        italic: null,
        boldItalic: null,
      };
    } else {
      fonts = {
        regular: pdfDoc.embedStandardFont(StandardFonts.Helvetica),
        bold: pdfDoc.embedStandardFont(StandardFonts.HelveticaBold),
        italic: pdfDoc.embedStandardFont(StandardFonts.HelveticaOblique),
        boldItalic: pdfDoc.embedStandardFont(StandardFonts.HelveticaBoldOblique),
      };
    }
    post({ type: "progress", runId, pct: 45, stage: "processing" });

    const report = drawRtfPdf(pdfDoc, fonts, doc, opts);
    post({ type: "progress", runId, pct: 85, stage: "saving" });

    pdfDoc.setProducer("DocoPDF");
    pdfDoc.setCreator("DocoPDF");
    pdfDoc.setTitle(outputBaseName(file.name, locale));
    pdfDoc.setCreationDate(new Date());

    const outName = `${outputBaseName(file.name, locale)}.pdf`;
    const docStats = stats(doc);
    const bytes2 = await pdfDoc.save();
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: outName,
          mime: "application/pdf",
          blob: new Blob([bytes2 as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: { pages: report.pages, words: docStats.wordCount },
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
