import { CreateContext, type StampTtfFont } from "@/lib/own/pdf";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadDevanagariBytes } from "../stamp-common/deva";
import { type ConvertFace } from "../convert-common/face";
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
 *     italic set as std keys), while ANY non-WinAnsi char switches
 *     everything to the self-hosted Noto Sans Devanagari subset (OUR
 *     Type0/CIDFontType2 subsetter + Indic shaper, Regular only —
 *     hierarchy honestly comes from size);
 *  4. drawHtmlPdf — the exact render.ts the smoke script drives;
 *  5. write with producer/creator "DocoPDF" and the title-derived name.
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

/** the worker's EN font set — the 8 base-14 std keys as cheap face
 * consts (the create-side recipe: std faces embed nothing, so the old
 * pdf-lib embedStandardFont cache has no work left to dedupe). */
function enFontSet(): HtmlFontSet {
  const courier = { std: "courier" } as const;
  const courierBold = { std: "courierBold" } as const;
  const courierBoldOblique = { std: "courierBoldOblique" } as const;
  const courierOblique = { std: "courierOblique" } as const;
  const helvetica = { std: "helvetica" } as const;
  const helveticaBold = { std: "helveticaBold" } as const;
  const helveticaBoldOblique = { std: "helveticaBoldOblique" } as const;
  const helveticaOblique = { std: "helveticaOblique" } as const;
  return {
    isNoto: false,
    resolve(bold, italic, mono): ConvertFace {
      if (mono) {
        return bold && italic
          ? courierBoldOblique
          : bold
            ? courierBold
            : italic
              ? courierOblique
              : courier;
      }
      return bold && italic
        ? helveticaBoldOblique
        : bold
          ? helveticaBold
          : italic
            ? helveticaOblique
            : helvetica;
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
      post({ type: "error", runId, code: "html.errNoFile" });
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (inputTooLarge(bytes.byteLength)) {
      post({ type: "error", runId, code: "html.errTooLarge", detail: file.name });
      return;
    }
    post({ type: "progress", runId, pct: 15, stage: "reading" });

    const text = decodeHtmlBytes(bytes);
    if (!looksLikeHtml(text)) {
      post({ type: "error", runId, code: "html.errNotHtml", detail: file.name });
      return;
    }

    // parse + boundary coercion (tampered/oversized docs clamp here)
    const doc = parseHtmlRun(JSON.stringify(parseHtml(text)));
    if (doc.blocks.length === 0) {
      post({ type: "error", runId, code: "html.errNoDoc", detail: file.name });
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

    const pdfDoc = CreateContext.create();
    let fonts: HtmlFontSet;
    if (needsNoto(doc)) {
      // Devanagari (or any non-WinAnsi) content → the embedded Noto
      // subset for EVERYTHING. OFL ships Regular only: hierarchy comes
      // from size, and bold text falls back to the regular face.
      // loadDevanagariBytes throws the typed "devanagari-font-fetch".
      const noto: StampTtfFont = pdfDoc.embedTtf(await loadDevanagariBytes());
      fonts = {
        isNoto: true,
        resolve: () => ({ ttf: noto }),
      };
    } else {
      fonts = enFontSet();
    }
    post({ type: "progress", runId, pct: 60, stage: "processing" });

    const report = drawHtmlPdf(pdfDoc, fonts, doc, opts);
    post({ type: "progress", runId, pct: 88, stage: "saving" });

    pdfDoc.setProducer("DocoPDF");
    pdfDoc.setCreator("DocoPDF");
    const baseName = outputBaseName(doc.title || file.name, lang);
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
