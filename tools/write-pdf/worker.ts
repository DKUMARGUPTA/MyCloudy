import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadStampFonts } from "../stamp-common/worker-lib";
import {
  type FontSpec,
  type MeasureRun,
  type ScriptFont,
} from "../txt-to-pdf/text-layout";
import {
  W_PAGE_SIZES,
  assetOrderOf,
  docNeedNoto,
  layoutDoc,
  parseHexColor,
  sanitizeWDoc,
  wOutputName,
} from "./model";

/**
 * Write PDF export worker (PRD §8 "Write PDF"). The noFile SURFACE drives
 * this worker directly (the generate-qr-code no-run pattern, but heavy
 * work stays in a real Web Worker): the document rides options.doc as
 * JSON (sanitized here — never trust the blob) and the doc's image
 * assets ride `files` in assetOrderOf(doc) order.
 *
 * Layout runs through the shared pure engine (./model.ts layoutDoc) with
 * REAL pdf-lib font metrics, so the surface's live preview (canvas
 * metrics, metric-compatible browser faces) shows the same pages. Paint:
 * text pieces via fontFor (standard-14 ×3 families + embedded Noto for
 * Devanagari blocks), underline/hr/table-border strokes, quote bars,
 * table header backgrounds, images embedded once and drawn with explicit
 * width/height (the P4.4 pdf-lib rule). Device-only, zero network with
 * file data.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

interface FontSet {
  fontFor: (spec: FontSpec, script: ScriptFont) => PDFFont;
  measure: MeasureRun;
}

async function loadFonts(doc: PDFDocument, needNoto: boolean): Promise<FontSet> {
  // stamp-common pipeline: standard fonts + the embedded Devanagari TTF
  const stampFonts = await loadStampFonts(doc, needNoto);
  const helv = stampFonts.fontFor("helvetica");
  const helvBold = stampFonts.fontFor("helveticaBold");
  const courier = stampFonts.fontFor("courier");
  const courierBold = stampFonts.fontFor("courierBold");
  const helvOblique = doc.embedStandardFont(StandardFonts.HelveticaOblique);
  const helvBoldOblique = doc.embedStandardFont(
    StandardFonts.HelveticaBoldOblique
  );
  const times = doc.embedStandardFont(StandardFonts.TimesRoman);
  const timesBold = doc.embedStandardFont(StandardFonts.TimesRomanBold);
  const timesItalic = doc.embedStandardFont(StandardFonts.TimesRomanItalic);
  const timesBoldItalic = doc.embedStandardFont(
    StandardFonts.TimesRomanBoldItalic
  );
  const courierOblique = doc.embedStandardFont(StandardFonts.CourierOblique);
  const courierBoldOblique = doc.embedStandardFont(
    StandardFonts.CourierBoldOblique
  );
  const noto = needNoto ? stampFonts.fontFor("devanagari") : null;

  const fontFor = (spec: FontSpec, script: ScriptFont): PDFFont => {
    if (script === "noto" && noto) return noto; // v1 rule: whole block Noto
    if (spec.family === "mono") {
      if (spec.bold && spec.italic) return courierBoldOblique;
      if (spec.bold) return courierBold;
      if (spec.italic) return courierOblique;
      return courier;
    }
    if (spec.family === "serif") {
      if (spec.bold && spec.italic) return timesBoldItalic;
      if (spec.bold) return timesBold;
      if (spec.italic) return timesItalic;
      return times;
    }
    if (spec.bold && spec.italic) return helvBoldOblique;
    if (spec.bold) return helvBold;
    if (spec.italic) return helvOblique;
    return helv;
  };
  return {
    fontFor,
    measure: (text, spec, size, script) =>
      fontFor(spec, script).widthOfTextAtSize(text, size),
  };
}

/** Embeds one image asset (magic-byte sniff; the store normalised JPG/PNG). */
async function embedImage(doc: PDFDocument, file: File): Promise<PDFImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  try {
    return isJpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  } catch {
    // wrong sniff or exotic bytes — try the other codec
    return isJpeg ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  }
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;

  const docRaw = typeof options.doc === "string" ? options.doc : "";
  if (docRaw.length === 0) {
    post({ type: "error", runId, code: "write.errorEmpty" });
    return;
  }

  post({ type: "progress", runId, pct: 4, stage: "reading" });

  let parsed: unknown;
  try {
    parsed = JSON.parse(docRaw);
  } catch {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const { doc } = sanitizeWDoc(parsed);
  const hasContent = doc.blocks.some((block) => {
    if (block.kind === "pagebreak") return false;
    if (block.kind === "hr") return true;
    if (block.kind === "table") return true;
    if (block.kind === "image") return true;
    return block.runs.length > 0;
  });
  if (!hasContent) {
    post({ type: "error", runId, code: "write.errorEmpty" });
    return;
  }

  const base = W_PAGE_SIZES[doc.setup.pageSize];
  const pageW = doc.setup.landscape ? base.height : base.width;
  const pageH = doc.setup.landscape ? base.width : base.height;

  const pdf = await PDFDocument.create();
  const needNoto = docNeedNoto(doc);
  const fonts = await loadFonts(pdf, needNoto);

  // images ride `files` in assetOrderOf order (surface pairing contract)
  const order = assetOrderOf(doc);
  if (files.length < order.length) {
    post({ type: "error", runId, code: "write.errorAssets" });
    return;
  }
  const imageSizes: Record<string, { w: number; h: number }> = {};
  const embedded: PDFImage[] = [];
  for (let i = 0; i < order.length; i += 1) {
    const image = await embedImage(pdf, files[i]);
    imageSizes[order[i]] = { w: image.width, h: image.height };
    embedded.push(image);
  }

  post({ type: "progress", runId, pct: 10, stage: "processing" });

  const laid = layoutDoc({ doc, imageSizes, measure: fonts.measure });

  for (let p = 0; p < laid.pages.length; p += 1) {
    const page = pdf.addPage([pageW, pageH]);
    const laidPage = laid.pages[p];

    for (const rect of laidPage.rects) {
      page.drawRectangle({
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        color: rgbFromHex(rect.color),
      });
    }
    for (const image of laidPage.images) {
      const asset = embedded[image.index];
      if (!asset) continue;
      // explicit width/height (pdf-lib silently ignores w/h — P4.4 rule)
      page.drawImage(asset, {
        x: image.x,
        y: image.y,
        width: image.w,
        height: image.h,
      });
    }
    for (const line of laidPage.lines) {
      page.drawLine({
        start: { x: line.x1, y: line.y1 },
        end: { x: line.x2, y: line.y2 },
        thickness: line.w,
        color: rgbFromHex(line.color),
      });
    }
    for (const piece of laidPage.pieces) {
      if (piece.text.length === 0) continue;
      page.drawText(piece.text, {
        x: piece.x,
        y: piece.baseline,
        size: piece.size,
        font: fonts.fontFor(piece.spec, piece.script),
        color: rgbFromHex(piece.color),
      });
    }

    post({
      type: "progress",
      runId,
      pct: Math.min(88, 10 + Math.round(((p + 1) / laid.pages.length) * 78)),
      stage: "processing",
      detail: { page: p + 1, pages: laid.pages.length },
    });
  }

  post({ type: "progress", runId, pct: 92, stage: "saving" });

  const saved = await pdf.save({ useObjectStreams: true });
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: wOutputName(doc.title),
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: {
      files: 1,
      pages: laid.pages.length,
      words: laid.words,
      images: laid.images,
    },
  });
}

function rgbFromHex(hex: string | undefined): ReturnType<typeof rgb> {
  const { r, g, b } = parseHexColor(hex);
  return rgb(r, g, b);
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /font-fetch|devanagari|fontkit/i.test(message)
      ? "write.errorFont"
      : "tool.errorGeneric";
    post({
      type: "error",
      runId: data.runId,
      code,
      detail: code === "tool.errorGeneric" ? message.slice(0, 200) : undefined,
    });
  });
};
