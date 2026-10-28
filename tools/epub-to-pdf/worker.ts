import {
  CreateContext,
  type CreateImage,
} from "@/lib/own/pdf";
import { unzipSync as fflateUnzipSync, type Unzipped } from "@/lib/own/zip";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { embedDocumentImageOwn } from "@/lib/pdf/embed-image-own";
import { loadDevanagariBytes } from "../stamp-common/deva";
import {
  chapterWordFor,
  EpubParseError,
  inputTooLarge,
  lookupEntry,
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
 *     embed NO font file at all (the base-14 std-key set — Helvetica ×
 *     Courier × italic, non-embedded), while ANY non-WinAnsi char (or a
 *     localized Hindi TOC heading / chapter fallback word) switches
 *     everything to the self-hosted Noto Sans Devanagari (OUR
 *     Type0/CIDFontType2 subsetter + Indic shaper, Regular only —
 *     hierarchy honestly comes from size);
 *  3. cover embed — the OPF-declared PNG/JPG cover via OUR engine's
 *     SYNC embedPng/embedJpeg (a cover that fails to embed is honestly
 *     skipped, never a hard failure);
 *  4. chapter images (audit R4-a) — the book's resolved image refs
 *     (ParsedEpub.images) embed through the shared helper (original
 *     bytes, downscale only for oversized, ≤ 50); remote/missing
 *     parts were already counted honestly at parse time;
 *  5. drawEpubPdf — the exact render.ts the smoke script drives:
 *     cover page, chapters on fresh pages with their images at their
 *     paragraph anchors, inserted TOC with exact page numbers,
 *     optional folios;
 *  6. write with producer/creator "DocoPDF", PDF title/author from
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

/**
 * The base-14 8-way resolution as ConvertFace consts — faces are cheap
 * constants on OUR engine (std keys embed nothing), so there is no
 * cache to keep (the P6-m converter recipe).
 */
function enFontSet(): EpubFontSet {
  const courierBoldOblique = { std: "courierBoldOblique" } as const;
  const courierBold = { std: "courierBold" } as const;
  const courierOblique = { std: "courierOblique" } as const;
  const courier = { std: "courier" } as const;
  const helveticaBoldOblique = { std: "helveticaBoldOblique" } as const;
  const helveticaBold = { std: "helveticaBold" } as const;
  const helveticaOblique = { std: "helveticaOblique" } as const;
  const helvetica = { std: "helvetica" } as const;
  return {
    isNoto: false,
    resolve(bold, italic, mono) {
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

    const pdfDoc = CreateContext.create();

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
      const noto = pdfDoc.embedTtf(await loadDevanagariBytes());
      fonts = {
        isNoto: true,
        resolve: () => ({ ttf: noto }),
      };
    } else {
      fonts = enFontSet();
    }
    post({ type: "progress", runId, pct: 60, stage: "processing" });

    // cover embed — a cover that fails to embed is honestly skipped
    let coverImage: CreateImage | null = null;
    if (opts.includeCover && book.cover !== null) {
      try {
        coverImage =
          book.cover.kind === "png"
            ? pdfDoc.embedPng(book.cover.bytes)
            : pdfDoc.embedJpeg(book.cover.bytes);
      } catch {
        coverImage = null;
      }
    }

    // chapter images (audit R4-a): the book's resolved refs embed once
    // per unique zip path; a part that fails here just leaves the
    // honest alt text (parse-level skips were counted already)
    const chapterImages = new Map<string, CreateImage>();
    if (book.images.length > 0) {
      let files: Unzipped = {};
      try {
        files = fflateUnzipSync(bytes);
      } catch {
        files = {};
      }
      for (const ref of book.images) {
        const entry = lookupEntry(files, ref.path);
        if (entry === undefined) continue;
        const embedded = await embedDocumentImageOwn(pdfDoc, entry);
        if (embedded === null) continue;
        chapterImages.set(ref.path, embedded.image);
      }
    }

    const report = drawEpubPdf(pdfDoc, fonts, book, coverImage, chapterImages, {
      ...opts,
      tocTitle: tocTitleFor(lang),
      chapterWord: chapterWordFor(lang),
    });
    post({ type: "progress", runId, pct: 88, stage: "saving" });

    pdfDoc.setProducer("DocoPDF");
    pdfDoc.setCreator("DocoPDF");
    const baseName = outputBaseName(book.title || file.name, lang);
    pdfDoc.setTitle(baseName);
    if (book.author !== "") pdfDoc.setAuthor(book.author);
    pdfDoc.setCreationDate(new Date());

    const outBytes = pdfDoc.write();
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
        imagesEmbedded: report.imagesDrawn,
        imagesSkipped: book.imagesSkipped,
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
