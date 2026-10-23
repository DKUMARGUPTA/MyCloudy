import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadStampFonts } from "../stamp-common/worker-lib";
import {
  decodeHtmlBytes,
  inputTooLarge,
  looksLikeHtml,
  needsNoto,
  outputBaseName,
  parseHtml,
  parseHtmlRun,
  stats,
} from "./model";
import { drawHtmlPdf, type HtmlFontSet } from "./render";

/**
 * HTML to PDF worker (RB2-d — 74th tool) — device-only, zero network
 * beyond the same-origin font. Mirrors the word-to-pdf worker
 * protocol:
 *
 *  1. read the .html bytes (20 MB cap), decode with the BOM + <meta
 *     charset> aware reader (UTF-8 default, windows-1252 etc.), and
 *     gate on the honest HTML sniff (tag or doctype);
 *  2. parseHtml → parseHtmlRun — full defensive clamp at the boundary;
 *  3. font pick — a SINGLE decision per document: pure-WinAnsi content
 *     embeds NO font file at all (the base-14 Helvetica × Courier ×
 *     italic set), while ANY non-WinAnsi char switches everything to
 *     the self-hosted Noto Sans Devanagari subset (fontkit subset:true,
 *     Regular only — hierarchy honestly comes from size);
 *  4. drawHtmlPdf — the exact render.ts the smoke script drives;
 *  5. save with producer/creator "MyCloudy" and the title-derived name.
 *
 * Options: pageSize ("a4"|"letter"), margin ("normal"|"narrow"),
 * baseFontSize ("small"|"normal"|"large"), showLinks (boolean) and
 * lang ("en"|"hi" — the localized "Webpage"/"वेबपेज" fallback word).
 */

const BASE_FONT_SIZES: Record<string, number> = {
  small: 10,
  normal: 11,
  large: 12.5,
};

function enFontSet(pdfDoc: PDFDocument): HtmlFontSet {
  const cache = new Map<string, PDFFont>();
  const key = (b: boolean, i: boolean, m: boolean): string =>
    `${b ? "B" : ""}${i ? "I" : ""}${m ? "M" : ""}`;
  return {
    isNoto: false,
    resolve(bold, italic, mono) {
      const k = key(bold, italic, mono);
      const hit = cache.get(k);
      if (hit) return hit;
      let font: PDFFont;
      if (mono) {
        font = pdfDoc.embedStandardFont(
          bold && italic
            ? StandardFonts.CourierBoldOblique
            : bold
              ? StandardFonts.CourierBold
              : italic
                ? StandardFonts.CourierOblique
                : StandardFonts.Courier
        );
      } else {
        font = pdfDoc.embedStandardFont(
          bold && italic
            ? StandardFonts.HelveticaBoldOblique
            : bold
              ? StandardFonts.HelveticaBold
              : italic
                ? StandardFonts.HelveticaOblique
                : StandardFonts.Helvetica
        );
      }
      cache.set(k, font);
      return font;
    },
  };
}

async function run(request: WorkerRunRequest): Promise<void> {
  const runId = request.runId;
  const post = (msg: WorkerResponse): void => {
    (self as unknown as Worker).postMessage(msg);
  };
  try {
    const file = request.files[0];
    if (!file) {
      post({ type: "error", runId, code: "h2p.errNoFile" });
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (inputTooLarge(bytes.byteLength)) {
      post({ type: "error", runId, code: "h2p.errTooLarge", detail: file.name });
      return;
    }
    post({ type: "progress", runId, pct: 15, stage: "reading" });

    const text = decodeHtmlBytes(bytes);
    if (!looksLikeHtml(text)) {
      post({ type: "error", runId, code: "h2p.errNotHtml", detail: file.name });
      return;
    }

    // parse + boundary coercion (tampered/oversized docs clamp here)
    const doc = parseHtmlRun(JSON.stringify(parseHtml(text)));
    if (doc.blocks.length === 0) {
      post({ type: "error", runId, code: "h2p.errNoDoc", detail: file.name });
      return;
    }
    post({ type: "progress", runId, pct: 40, stage: "processing" });

    const opts = {
      pageSize: (String(request.options.pageSize) === "letter"
        ? "letter"
        : "a4") as "a4" | "letter",
      margin: (String(request.options.margin) === "narrow"
        ? "narrow"
        : "normal") as "normal" | "narrow",
      baseFontSize: BASE_FONT_SIZES[String(request.options.baseFontSize)] ?? 11,
      showLinks: request.options.showLinks === true,
    };
    const lang: "en" | "hi" = String(request.options.lang) === "hi" ? "hi" : "en";

    const pdfDoc = await PDFDocument.create();
    let fonts: HtmlFontSet;
    if (needsNoto(doc)) {
      // Devanagari (or any non-WinAnsi) content → the embedded Noto
      // subset for EVERYTHING. OFL ships Regular only: hierarchy comes
      // from size, and bold text falls back to the regular face.
      const stampFonts = await loadStampFonts(pdfDoc, true);
      const noto = stampFonts.fontFor("devanagari");
      fonts = {
        isNoto: true,
        resolve: () => noto,
      };
    } else {
      fonts = enFontSet(pdfDoc);
    }
    post({ type: "progress", runId, pct: 60, stage: "processing" });

    const report = drawHtmlPdf(pdfDoc, fonts, doc, opts);
    post({ type: "progress", runId, pct: 88, stage: "saving" });

    pdfDoc.setProducer("MyCloudy");
    pdfDoc.setCreator("MyCloudy");
    const baseName = outputBaseName(doc.title || file.name, lang);
    pdfDoc.setTitle(baseName);
    pdfDoc.setCreationDate(new Date());

    const outBytes = await pdfDoc.save();
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
      detail: { pages: report.pages, words: stats(doc).wordCount },
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
