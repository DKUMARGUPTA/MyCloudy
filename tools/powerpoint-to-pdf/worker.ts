import { CreateContext, type StampFontKey } from "@/lib/own/pdf";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadDevanagariBytes } from "../stamp-common/deva";
import type { ConvertFace } from "../convert-common/face";
import {
  MAX_PPTX_BYTES,
  PptxParseError,
  needsNoto,
  outputBaseName,
  parsePptx,
  parsePptxRun,
} from "./model";
import { drawPptxPdf } from "./render";

/**
 * PowerPoint to PDF worker (RB2-a — 71st tool) — device-only, zero
 * network beyond the same-origin font. Mirrors the word-to-pdf worker
 * protocol:
 *
 *  1. read the .pptx bytes from request.files[0] (magic + size checked
 *     again — the surface sniffs too, defense in depth) and parsePptx
 *     them (fflate unzip + the SAX assembler), then re-coerce through
 *     parsePptxRun — full defensive clamp at the boundary;
 *  2. font pick — one decision for the whole deck: pure-WinAnsi content
 *     embeds NO font at all (base-14 Helvetica + HelveticaBold), while
 *     ANY Devanagari char (or a Devanagari notes heading) switches to
 *     the self-hosted Noto Sans Devanagari (OUR Type0/CIDFontType2
 *     subsetter + Indic shaper);
 *  3. drawPptxPdf — the exact render.ts the smoke script drives;
 *  4. write with producer/creator "DocoPDF" and the localized file name.
 *
 * Options: pageSize ("slide-native"|"a4"|"letter"), margin
 * ("normal"|"narrow"), notes (speaker-notes pages), fit (fill the page
 * width), lang (name localization) and notesHeadingFmt (the localized
 * "Slide {n} — notes" template).
 */

function errorCode(err: unknown): string {
  if (err instanceof PptxParseError) {
    switch (err.code) {
      case "pptx-legacy":
        return "ppt.errLegacy";
      case "pptx-not-zip":
        return "ppt.errNotZip";
      case "pptx-corrupt":
        return "ppt.errCorrupt";
      case "pptx-empty":
        return "ppt.errNoDoc";
      case "pptx-too-large":
        return "ppt.errTooLarge";
      default:
        return "tool.errorGeneric";
    }
  }
  return "tool.errorGeneric";
}

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
        code: "ppt.errNoFile",
      });
      return;
    }
    if (file.size > MAX_PPTX_BYTES) {
      post({
        type: "error",
        runId,
        code: "ppt.errTooLarge",
      });
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    post({ type: "progress", runId, pct: 20, stage: "processing" });

    // parse + boundary coercion (tampered/oversized decks clamp here)
    let ppt;
    try {
      ppt = parsePptxRun(JSON.stringify(parsePptx(bytes)));
    } catch (error) {
      post({
        type: "error",
        runId,
        code: errorCode(error),
        detail: error instanceof PptxParseError ? error.code : undefined,
      });
      return;
    }
    if (ppt.slides.length === 0) {
      post({
        type: "error",
        runId,
        code: "ppt.errNoDoc",
        detail: file.name,
      });
      return;
    }

    const pageSize = String(request.options.pageSize);
    const opts = {
      pageSize: (
        pageSize === "a4" || pageSize === "letter" ? pageSize : "slide-native"
      ) as "slide-native" | "a4" | "letter",
      margin: (String(request.options.margin) === "narrow"
        ? "narrow"
        : "normal") as "normal" | "narrow",
      notes: request.options.notes === true,
      fit: request.options.fit === true,
      notesHeadingFmt: String(request.options.notesHeadingFmt ?? "Slide {n} — notes")
        .slice(0, 60),
    };
    const lang = request.options.lang === "hi" ? "hi" : "en";

    const pdfDoc = CreateContext.create();
    let font: ConvertFace;
    let boldKey: StampFontKey | null = null;
    if (needsNoto(ppt, opts.notes ? opts.notesHeadingFmt : "")) {
      // Devanagari (or any non-WinAnsi) content → the embedded Noto
      // subset. OFL ships Regular only: hierarchy comes from size, and
      // bold text falls back to the regular face.
      const notoBytes = await loadDevanagariBytes();
      font = { ttf: pdfDoc.embedTtf(notoBytes) };
    } else {
      font = { std: "helvetica" };
      boldKey = "helveticaBold";
    }
    post({ type: "progress", runId, pct: 45, stage: "processing" });

    const report = drawPptxPdf(pdfDoc, font, boldKey, ppt, opts);
    post({ type: "progress", runId, pct: 85, stage: "saving" });

    const baseName = outputBaseName(file.name, lang);
    pdfDoc.setProducer("DocoPDF");
    pdfDoc.setCreator("DocoPDF");
    pdfDoc.setTitle(baseName);
    pdfDoc.setCreationDate(new Date());

    const outBytes = pdfDoc.write();
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${baseName}.pdf`,
          mime: "application/pdf",
          blob: new Blob([outBytes as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: {
        pages: report.pages,
        slides: ppt.slides.length,
        overflowed: report.overflowed,
      },
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
