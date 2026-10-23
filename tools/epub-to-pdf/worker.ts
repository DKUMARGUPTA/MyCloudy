import { PDFDocument, StandardFonts, type PDFFont, type PDFImage } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadStampFonts } from "../stamp-common/worker-lib";
import {
  chapterWordFor,
  EpubParseError,
  inputTooLarge,
  needsNoto,
  outputBaseName,
  parseEpub,
  stats,
  titleNeedsNoto,
  tocTitleFor,
} from "./model";
import { drawEpubPdf, type EpubFontSet } from "./render";

/**
 * EPUB to PDF worker (RB3-a — the 75th tool) — device-only, zero
 * network beyond the same-origin font. Mirrors the html-to-pdf worker
 * protocol:
 *
 *  1. read the .epub bytes (20 MB cap) and parseEpub them (fflate
 *     unzip + container.xml → OPF → spine → html-to-pdf's parser);
 *     a rejected book (non-ZIP, corrupt, DRM/encryption.xml, missing
 *     mimetype, missing container.xml, missing OPF, empty spine, no
 *     readable text) posts its honest code;
 *  2. font pick — a SINGLE decision per document: pure-WinAnsi books
 *     embed NO font file at all (the base-14 Helvetica × Courier ×
 *     italic set), while ANY non-WinAnsi char (or a localized Hindi
 *     TOC heading / chapter fallback word) switches everything to the
 *     self-hosted Noto Sans Devanagari subset (fontkit subset:true,
 *     Regular only — hierarchy honestly comes from size);
 *  3. cover embed — the OPF-declared PNG/JPG cover via pdf-lib's
 *     embedPng/embedJpg (a cover that fails to embed is honestly
 *     skipped, never a hard failure);
 *  4. drawEpubPdf — the exact render.ts the smoke script drives:
 *     cover page, chapters on fresh pages, inserted TOC with exact
 *     page numbers, optional folios;
 *  5. save with producer/creator "MyCloudy", PDF title/author from
 *     the OPF metadata, and the title-derived download name.
 *
 * Options: pageSize ("a4"|"letter"), margin ("normal"|"narrow"|"wide"),
 * baseFontSize ("small"|"normal"|"large"), includeToc, includeCover,
 * pageNumbers (booleans) and lang ("en"|"hi" — the localized
 * "Contents"/"Chapter"/"Ebook"/"ईबुक" words).
 */

const BASE_FONT_SIZES: Record<string, number> = {
  small: 10,
  normal: 11,
  large: 12.5,
};

function enFontSet(pdfDoc: PDFDocument): EpubFontSet {
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
      post({ type: "error", runId, code: "epub.errNoFile" });
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (inputTooLarge(bytes.byteLength)) {
      post({ type: "error", runId, code: "epub.errTooLarge", detail: file.name });
      return;
    }
    post({ type: "progress", runId, pct: 15, stage: "reading" });

    let book;
    try {
      book = parseEpub(bytes);
    } catch (error) {
      if (error instanceof EpubParseError) {
        post({ type: "error", runId, code: `epub.${error.code}`, detail: file.name });
        return;
      }
      throw error;
    }
    post({ type: "progress", runId, pct: 40, stage: "processing" });

    const opts = {
      pageSize: (String(request.options.pageSize) === "letter"
        ? "letter"
        : "a4") as "a4" | "letter",
      margin: (["narrow", "wide"].includes(String(request.options.margin))
        ? String(request.options.margin)
        : "normal") as "normal" | "narrow" | "wide",
      baseFontSize: BASE_FONT_SIZES[String(request.options.baseFontSize)] ?? 11,
      includeToc: request.options.includeToc !== false,
      includeCover: request.options.includeCover !== false,
      pageNumbers: request.options.pageNumbers !== false,
    };
    const lang: "en" | "hi" = String(request.options.lang) === "hi" ? "hi" : "en";

    const pdfDoc = await PDFDocument.create();

    // font pick — one decision for the whole book. The Hindi UI words
    // (विषय-सूची / अध्याय) and any non-WinAnsi chapter title count.
    const wantNoto =
      needsNoto(book) ||
      (lang === "hi" && (opts.includeToc || book.chapters.some((c) => c.title === ""))) ||
      book.chapters.some((c) => titleNeedsNoto(c.title));
    let fonts: EpubFontSet;
    if (wantNoto) {
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

    // cover embed — a cover that fails to embed is honestly skipped
    let coverImage: PDFImage | null = null;
    if (opts.includeCover && book.cover !== null) {
      try {
        coverImage =
          book.cover.kind === "png"
            ? await pdfDoc.embedPng(book.cover.bytes)
            : await pdfDoc.embedJpg(book.cover.bytes);
      } catch {
        coverImage = null;
      }
    }

    const report = drawEpubPdf(pdfDoc, fonts, book, coverImage, {
      ...opts,
      tocTitle: tocTitleFor(lang),
      chapterWord: chapterWordFor(lang),
    });
    post({ type: "progress", runId, pct: 88, stage: "saving" });

    pdfDoc.setProducer("MyCloudy");
    pdfDoc.setCreator("MyCloudy");
    const baseName = outputBaseName(book.title || file.name, lang);
    pdfDoc.setTitle(baseName);
    if (book.author !== "") pdfDoc.setAuthor(book.author);
    pdfDoc.setCreationDate(new Date());

    const outBytes = await pdfDoc.save();
    const st = stats(book);
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
        chapters: st.chapters,
        words: st.words,
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
