import {
  CreateContext,
  type CreateImage,
  type StampFontKey,
  type StampTtfFont,
} from "@/lib/own/pdf";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadDevanagariBytes } from "../stamp-common/deva";
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
 * REAL font metrics, so the surface's live preview (canvas metrics,
 * metric-compatible browser faces) shows the same pages. Paint goes
 * through OUR engine (CreateContext, P6-i): text pieces via the full
 * standard-14 ×3-family set (WinAnsi through our metrics — kerning
 * included) + the embedded Noto Devanagari subset (embedTtf — OUR
 * shaper/subsetter) for Devanagari blocks, underline/hr/table-border
 * strokes, quote bars, table header backgrounds, images embedded once
 * (JPEG DCT passthrough / PNG RGB+SMask) and drawn with explicit
 * width/height (the P4.4 pdf-lib rule). Device-only, zero network with
 * file data, zero pdf-lib.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

interface FontSet {
  /** The standard font for a spec (null when the block routes to Noto). */
  stdFor: (spec: FontSpec, script: ScriptFont) => StampFontKey | null;
  measure: MeasureRun;
  /** The embedded Devanagari TTF (non-null exactly when stdFor can return null). */
  noto: StampTtfFont | null;
}

/** FontSpec → one of the 12 WinAnsi standard-14s. */
function stdKey(spec: FontSpec): StampFontKey {
  if (spec.family === "mono") {
    if (spec.bold && spec.italic) return "courierBoldOblique";
    if (spec.bold) return "courierBold";
    if (spec.italic) return "courierOblique";
    return "courier";
  }
  if (spec.family === "serif") {
    if (spec.bold && spec.italic) return "timesBoldItalic";
    if (spec.bold) return "timesBold";
    if (spec.italic) return "timesItalic";
    return "times";
  }
  if (spec.bold && spec.italic) return "helveticaBoldOblique";
  if (spec.bold) return "helveticaBold";
  if (spec.italic) return "helveticaOblique";
  return "helvetica";
}

async function loadFonts(
  ctx: CreateContext,
  needNoto: boolean,
): Promise<FontSet> {
  let noto: StampTtfFont | null = null;
  if (needNoto) {
    const bytes = await loadDevanagariBytes(); // throws "devanagari-font-fetch"
    noto = ctx.embedTtf(bytes);
  }
  return {
    // v1 rule: a "noto" block paints WHOLLY through the embedded TTF.
    stdFor: (spec, script) => (script === "noto" && noto ? null : stdKey(spec)),
    measure: (text, spec, size, script) =>
      script === "noto" && noto
        ? noto.measure(text, size)
        : ctx.measure(text, stdKey(spec), size),
    noto,
  };
}

/** Embeds one image asset (magic-byte sniff; the store normalised JPG/PNG). */
function embedAsset(ctx: CreateContext, file: File): Promise<CreateImage> {
  return file
    .arrayBuffer()
    .then((buf) => {
      const bytes = new Uint8Array(buf);
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
      try {
        return isJpeg ? ctx.embedJpeg(bytes) : ctx.embedPng(bytes);
      } catch {
        // wrong sniff or exotic bytes — try the other codec
        return isJpeg ? ctx.embedPng(bytes) : ctx.embedJpeg(bytes);
      }
    });
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

  const ctx = CreateContext.create();
  const needNoto = docNeedNoto(doc);
  const fonts = await loadFonts(ctx, needNoto);

  // images ride `files` in assetOrderOf order (surface pairing contract)
  const order = assetOrderOf(doc);
  if (files.length < order.length) {
    post({ type: "error", runId, code: "write.errorAssets" });
    return;
  }
  const imageSizes: Record<string, { w: number; h: number }> = {};
  const embedded: CreateImage[] = [];
  for (let i = 0; i < order.length; i += 1) {
    const image = await embedAsset(ctx, files[i]!);
    imageSizes[order[i]!] = { w: image.width, h: image.height };
    embedded.push(image);
  }

  post({ type: "progress", runId, pct: 10, stage: "processing" });

  const laid = layoutDoc({ doc, imageSizes, measure: fonts.measure });

  for (let p = 0; p < laid.pages.length; p += 1) {
    const page = ctx.addPage(pageW, pageH);
    const laidPage = laid.pages[p];

    for (const rect of laidPage.rects) {
      page.drawRectangle({
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        color: parseHexColor(rect.color),
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
        color: parseHexColor(line.color),
      });
    }
    for (const piece of laidPage.pieces) {
      if (piece.text.length === 0) continue;
      const std = fonts.stdFor(piece.spec, piece.script);
      // std === null ⟺ script === "noto" ⟺ fonts.noto !== null
      page.drawText({
        x: piece.x,
        y: piece.baseline,
        text: piece.text,
        size: piece.size,
        color: parseHexColor(piece.color),
        ...(std ? { font: std } : { ttf: fonts.noto! }),
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

  // R44 branding — metadata only; the document stays clean.
  ctx.setProducer("DocoPDF");
  ctx.setCreator("DocoPDF");
  ctx.setTitle(doc.title);
  ctx.setCreationDate(new Date());
  const saved = ctx.write();
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
