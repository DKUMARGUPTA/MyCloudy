import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
// P6-v: the style enrichment lives on the OWN engine now (one shared port
// for all four pdf-to-X extractors — parsePdf + listPages + our own stream
// decoders under the same correlation semantics).
import { buildFontStyleMap } from "../pdfjs-common/font-style-map";

// Re-exported for the smoke, which drives the same enrichment on real
// fixtures through the worker's own surface.
export { buildFontStyleMap };
import {
  buildMarkdown,
  coerceRunOptions,
  extractMarkdownModel,
  firstHeadingText,
  markdownStats,
  MD_MIME,
  outputBaseName,
  pageSlice,
  pdfErrorMessageToCode,
  type MdFontStyle,
  type MdLinkRect,
  type PdfTextItemInput,
} from "./model";

/**
 * PDF → Markdown worker (RB4-c) — 100% on-device, EN+हिंदी.
 *
 * Protocol (pdf-to-word + pdf-to-powerpoint recipe):
 *
 *  1. coerceRunOptions — defensive coercion of the surface's option
 *     payload (page range, one-file-per-page switch, page rules,
 *     provenance comment, YAML front matter, locale, fallback word);
 *  2. pdf.js getDocument on a COPY of the buffer (pinned lesson: pdf.js
 *     transfers + detaches the ArrayBuffer it receives — the original
 *     bytes must survive for the font pass below); parsePageSpec picks
 *     the selected pages ("1-3, 5, 8-");
 *  3. one getTextContent per selected page, plus getAnnotations for
 *     LINK rects with a real URL (http/https/mailto/ftp only — internal
 *     GoTo destinations and javascript: URIs are skipped honestly);
 *     page.cleanup() + doc.destroy() afterwards;
 *  4. buildFontStyleMap — pdf.js 4.x reports only internal font ids
 *     ("g_d0_f3"), never the real names, so bold AND italic are
 *     recovered from the PDF itself: each page's distinct item ids
 *     (first-use order) are zipped with the page's distinct /Font
 *     resource keys in Tf first-use order; a BaseFont like
 *     "Helvetica-Oblique" marks the id italic. Any mismatch (form
 *     XObjects, inherited resources, Type3) skips that page's
 *     enrichment — styles degrade honestly to off;
 *  5. extractMarkdownModel + buildMarkdown → .md outputs:
 *     default ONE .md for the whole selection (optional "---" between
 *     pages), or the per-page switch → one .md per selected page
 *     (multiple outputs; the shared result view offers the ZIP).
 *
 * Scanned PDFs (zero selectable text) fail with tool.errorNoText —
 * honest, same as pdf-to-word (the OCR chain is suggested in the FAQ).
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  fontName?: unknown;
}
/* ------------------------------------------------------------------ */
/* Link annotations (pdf.js display intent)                              */
/* ------------------------------------------------------------------ */

/** Link-annotation data shape pdf.js getAnnotations reports (loose on
 * purpose — unknown fields ignored). Exported with linkRectsFor so the
 * smoke drives the REAL coercion on real fixtures. */
export interface RawAnnotation {
  subtype?: unknown;
  url?: unknown;
  unsafeUrl?: unknown;
  rect?: unknown;
}

/** The URL schemes we are honest about (javascript: never passes). */
const URL_RE = /^(https?|mailto|ftp):/i;

/** Link rects with a usable URL for one page (empty on any damage).
 * Exported for the smoke, which drives the same coercion on real
 * fixtures. */
export function linkRectsFor(annots: readonly RawAnnotation[]): MdLinkRect[] {
  const out: MdLinkRect[] = [];
  for (const annotation of annots) {
    if (annotation?.subtype !== "Link") continue;
    const url =
      typeof annotation.url === "string"
        ? annotation.url
        : typeof annotation.unsafeUrl === "string"
          ? annotation.unsafeUrl
          : "";
    if (!URL_RE.test(url)) continue;
    const rect = annotation.rect;
    if (!Array.isArray(rect) || rect.length < 4) continue;
    const x1 = Number(rect[0]);
    const y1 = Number(rect[1]);
    const x2 = Number(rect[2]);
    const y2 = Number(rect[3]);
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    out.push({
      x1: Math.min(x1, x2),
      y1: Math.min(y1, y2),
      x2: Math.max(x1, x2),
      y2: Math.max(y1, y2),
      url: url.slice(0, 2000),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

async function run(request: WorkerRunRequest): Promise<void> {
  const runId = request.runId;
  const opts = coerceRunOptions(request.options as Record<string, unknown>);
  const file = request.files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 10, stage: "reading" });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdfjs = await loadPdfjsInWorker();

  // PINNED LESSON: pdf.js transfers + detaches the buffer it is handed —
  // pass a COPY so `bytes` stays valid for the font pass afterwards.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  });
  const doc = await task.promise;

  try {
    const pageNumbers = parsePageSpec(opts.pages, doc.numPages);
    if (pageNumbers === null || pageNumbers.length === 0) {
      post({ type: "error", runId, code: "tool.errorInvalidPages" });
      return;
    }

    post({ type: "progress", runId, pct: 15, stage: "processing" });

    const pages: RawTextItem[][] = [];
    const links: MdLinkRect[][] = [];
    let chars = 0;
    for (let i = 0; i < pageNumbers.length; i += 1) {
      const page = await doc.getPage(pageNumbers[i] + 1);
      const content = await page.getTextContent();
      const annots = await page
        .getAnnotations({ intent: "display" })
        .catch(() => [] as RawAnnotation[]);
      page.cleanup();
      const items = content.items as RawTextItem[];
      pages.push(items);
      links.push(linkRectsFor(annots));
      for (const item of items) {
        if (typeof item.str === "string") chars += item.str.trim().length;
      }
      post({
        type: "progress",
        runId,
        pct: 15 + Math.round((55 * (i + 1)) / pageNumbers.length),
        stage: "processing",
        detail: { page: i + 1, pages: pageNumbers.length },
      });
    }

    // Scans have zero selectable text — fail honestly instead of shipping
    // an empty file (the pdf-to-txt / pdf-to-word precedent).
    if (chars === 0) {
      post({
        type: "error",
        runId,
        code: "tool.errorNoText",
        detail: file.name,
      });
      return;
    }

    post({ type: "progress", runId, pct: 75, stage: "processing" });

    const styleMap = await buildFontStyleMap(bytes, pageNumbers, pages);
    const model = extractMarkdownModel(pages, { styleMap, links });
    const stats = markdownStats(model);
    const base = outputBaseName(file.name, opts.locale);

    post({ type: "progress", runId, pct: 90, stage: "saving" });

    const outputs: { name: string; mime: string; blob: Blob }[] = [];
    if (opts.perPage) {
      // One file per selected page (multiple outputs; the shared result
      // view offers "download all as ZIP"). Heading tiers stay
      // document-wide so levels are consistent across the files.
      const single = pageNumbers.length === 1;
      for (let i = 0; i < pageNumbers.length; i += 1) {
        const slice = pageSlice(model, i);
        const pageMd = buildMarkdown(slice, {
          metaComment: opts.metaComment,
          frontMatter: opts.frontMatter,
          title: firstHeadingText(model) || base,
          sourceName: file.name,
          pages: 1,
        });
        outputs.push({
          name: single ? `${base}.md` : `${base}_page${pageNumbers[i] + 1}.md`,
          mime: MD_MIME,
          blob: new Blob([pageMd], { type: MD_MIME }),
        });
      }
    } else {
      const markdown = buildMarkdown(model, {
        pageRules: opts.pageRules,
        metaComment: opts.metaComment,
        frontMatter: opts.frontMatter,
        title: firstHeadingText(model) || base,
        sourceName: file.name,
        pages: pageNumbers.length,
      });
      outputs.push({
        name: `${base}.md`,
        mime: MD_MIME,
        blob: new Blob([markdown], { type: MD_MIME }),
      });
    }

    post({
      type: "result",
      runId,
      outputs,
      detail: {
        files: outputs.length,
        pages: pageNumbers.length,
        paragraphs: stats.paragraphs,
        headings: stats.headings,
      },
    });
  } finally {
    await doc.cleanup().catch(() => undefined);
    await task.destroy().catch(() => undefined);
  }
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId: data.runId,
      code: pdfErrorMessageToCode(message),
    });
  });
};
