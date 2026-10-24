import { PDFDocument, StandardFonts, type PDFFont, type PDFImage } from "pdf-lib";
import { unzipSync } from "fflate";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { embedDocumentImage } from "@/lib/pdf/embed-image";
import { loadStampFonts } from "../stamp-common/worker-lib";
import {
  MAX_IMAGES,
  needsNoto,
  outputPdfName,
  parseDocx,
  parseWordRun,
  lookupMediaEntry,
  resolveMediaPath,
  type DocxImageBlock,
} from "./model";
import { drawDocxPdf } from "./render";

/**
 * Word to PDF worker (RB1-a — 67th tool) — device-only, zero network
 * beyond the same-origin font. Mirrors the create-resume worker
 * protocol:
 *
 *  1. read the .docx bytes from request.files[0] and parseDocx them
 *     (fflate unzip + the tokenizer), then re-coerce through
 *     parseWordRun — full defensive clamp at the boundary;
 *  2. font pick — pure-WinAnsi content embeds NO font at all
 *     (base-14 Helvetica + HelveticaBold), while ANY Devanagari char
 *     switches to the self-hosted Noto Sans Devanagari (fontkit
 *     subset:true) — the create-resume/stamp-common recipe;
 *  3. images (audit R4-a): every image block's relId resolves through
 *     document.xml.rels to its media/* zip part and embeds via the
 *     shared helper (original bytes, downscale only for oversized,
 *     ≤ MAX_IMAGES) — missing parts/unsupported formats degrade to an
 *     honest skip count, never a crash or a silent drop;
 *  4. drawDocxPdf — the exact render.ts the smoke script drives;
 *  5. save with producer "DocoPDF" and the localized file name.
 *
 * Options: pageSize ("a4"|"letter"), margin ("normal"|"narrow") and
 * fileWord (the localized fallback word for a nameless file).
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
        code: "w2p.errNoFile",
      });
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    post({ type: "progress", runId, pct: 20, stage: "processing" });

    // parse + boundary coercion (tampered/oversized docs clamp here)
    const doc = parseWordRun(JSON.stringify(parseDocx(bytes)));
    if (doc.blocks.length === 0) {
      post({
        type: "error",
        runId,
        code: "w2p.errNoDoc",
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
    const fileWord = String(request.options.fileWord ?? "")
      .slice(0, 60)
      .trim();

    const pdfDoc = await PDFDocument.create();
    let font: PDFFont;
    let boldFont: PDFFont | null = null;
    if (needsNoto(doc)) {
      // Devanagari (or any non-WinAnsi) content → the embedded Noto
      // subset. OFL ships Regular only: hierarchy comes from size, and
      // bold text falls back to the regular face.
      const fonts = await loadStampFonts(pdfDoc, true);
      font = fonts.fontFor("devanagari");
    } else {
      font = pdfDoc.embedStandardFont(StandardFonts.Helvetica);
      boldFont = pdfDoc.embedStandardFont(StandardFonts.HelveticaBold);
    }
    post({ type: "progress", runId, pct: 45, stage: "processing" });

    // images (audit R4-a): resolve relIds → media/* zip parts → embed
    const images = new Map<string, PDFImage>();
    if (doc.blocks.some((b) => b.kind === "image")) {
      let zip: Record<string, Uint8Array> = {};
      try {
        zip = unzipSync(bytes) as Record<string, Uint8Array>;
      } catch {
        zip = {};
      }
      const relIds = [
        ...new Set(
          doc.blocks
            .filter((b): b is DocxImageBlock => b.kind === "image")
            .map((b) => b.relId)
        ),
      ].slice(0, MAX_IMAGES);
      for (const relId of relIds) {
        const target = doc.media[relId];
        if (target === undefined) continue;
        const path = resolveMediaPath(target);
        if (path === "") continue;
        const mediaBytes = lookupMediaEntry(zip, path);
        if (mediaBytes === undefined) continue;
        const embedded = await embedDocumentImage(pdfDoc, mediaBytes);
        if (embedded === null) continue;
        images.set(relId, embedded.image);
      }
    }

    const report = drawDocxPdf(pdfDoc, font, boldFont, doc, opts, images);
    post({ type: "progress", runId, pct: 85, stage: "saving" });

    pdfDoc.setProducer("DocoPDF");
    pdfDoc.setCreator("DocoPDF");
    pdfDoc.setTitle(outputPdfName(file.name, fileWord).replace(/\.pdf$/i, ""));
    pdfDoc.setCreationDate(new Date());

    const bytes2 = await pdfDoc.save();
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: outputPdfName(file.name, fileWord),
          mime: "application/pdf",
          blob: new Blob([bytes2 as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: {
        pages: report.pages,
        words: doc.wordCount,
        imagesEmbedded: report.imagesDrawn,
        imagesSkipped: report.imagesSkipped + doc.imagesDropped,
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
