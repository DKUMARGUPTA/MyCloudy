import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from "pdf-lib";

import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
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

/** BaseFont names that read as bold / italic. */
const BOLD_BASEFONT_RE = /(bold|black|heavy|demi|semib)/i;
const ITALIC_BASEFONT_RE = /(italic|oblique|kursiv)/i;

interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  fontName?: unknown;
}

/* ------------------------------------------------------------------ */
/* Style enrichment (pdf.js id → PDF font table)                        */
/* ------------------------------------------------------------------ */

/** Decoded text of one PDF name ("/Helvetica-Bold" → "Helvetica-Bold"). */
function pdfNameText(name: PDFName): string {
  const raw = name.asString().replace(/^\//, "");
  // #HH escapes per the PDF name rules (rare, but cheap to honour).
  return raw.replace(/#([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

/** The /Font resource dict for a page, walking inherited resources. */
function fontResourcesFor(
  doc: PDFDocument,
  node: PDFDict | undefined
): PDFDict | undefined {
  let current: PDFDict | undefined = node;
  for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
    const res = current.lookupMaybe(PDFName.of("Resources"), PDFDict);
    if (res) {
      const fonts = res.lookupMaybe(PDFName.of("Font"), PDFDict);
      if (fonts) return fonts;
    }
    const parent = current.get(PDFName.of("Parent"));
    current =
      parent instanceof PDFRef ? doc.context.lookupMaybe(parent, PDFDict) : undefined;
  }
  return undefined;
}

/** Distinct /Font resource keys in first-Tf-use order (content stream). */
function tfOrderForPage(doc: PDFDocument, node: PDFDict): string[] {
  const contents = node.get(PDFName.of("Contents"));
  const resolved =
    contents instanceof PDFRef ? doc.context.lookup(contents) : contents;
  const chunks: Uint8Array[] = [];
  const push = (value: unknown): void => {
    if (value instanceof PDFRawStream) {
      chunks.push(decodePDFRawStream(value).decode());
    }
  };
  if (resolved instanceof PDFRawStream) {
    push(resolved);
  } else if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i += 1) {
      push(
        doc.context.lookupMaybe(resolved.get(i) as PDFRef, PDFStream)
      );
    }
  }
  if (chunks.length === 0) return [];

  const text = new TextDecoder("latin1").decode(concat(chunks));
  const keys: string[] = [];
  const re = /\/([A-Za-z0-9#+.\-]+)\s+[-\d.]+\s+Tf/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (!keys.includes(match[1] as string)) keys.push(match[1] as string);
  }
  return keys;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** The font dict's BaseFont, Type0-aware (descendant's name). */
function baseFontName(doc: PDFDocument, value: unknown): string {
  const dict = value instanceof PDFRef
    ? doc.context.lookupMaybe(value, PDFDict)
    : value instanceof PDFDict
      ? value
      : undefined;
  if (!dict) return "";
  const baseFont = dict.get(PDFName.of("BaseFont"));
  if (baseFont instanceof PDFName) return pdfNameText(baseFont);
  // Type0 wrapped fonts keep the real face in the descendant's name.
  const descendant = dict.get(PDFName.of("DescendantFonts"));
  if (descendant instanceof PDFArray && descendant.size() > 0) {
    const child = descendant.get(0);
    const childDict = child instanceof PDFRef
      ? doc.context.lookupMaybe(child, PDFDict)
      : child instanceof PDFDict
        ? child
        : undefined;
    const childName = childDict?.get(PDFName.of("BaseFont"));
    if (childName instanceof PDFName) return pdfNameText(childName);
  }
  return "";
}

/**
 * Maps pdf.js internal font ids → {bold, italic} for the whole document,
 * by correlating each page's distinct ids (item order) with that page's
 * distinct Tf-used resource keys (content-stream order). Exported for
 * the smoke, which drives the same enrichment on real fixtures.
 */
export async function buildFontStyleMap(
  bytes: Uint8Array,
  pages: readonly PdfTextItemInput[][]
): Promise<Map<string, MdFontStyle>> {
  const result = new Map<string, MdFontStyle>();
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
  } catch {
    return result; // unreadable structure → no styles, honest degradation
  }
  try {
    const pageCount = Math.min(pages.length, pdf.getPageCount());
    for (let index = 0; index < pageCount; index += 1) {
      // Distinct pdf.js font ids on this page, in first-appearance order.
      const ids: string[] = [];
      for (const item of pages[index]) {
        const fn = typeof item?.fontName === "string" ? item.fontName : "";
        if (fn.length > 0 && !ids.includes(fn)) ids.push(fn);
      }
      if (ids.length === 0) continue;

      const node = pdf.getPage(index).node;
      const keys = tfOrderForPage(pdf, node);
      const fonts = fontResourcesFor(pdf, node);
      if (!fonts || keys.length !== ids.length) {
        continue; // mismatch (forms / weird streams) → skip, stay honest
      }
      for (let i = 0; i < ids.length; i += 1) {
        const value = fonts.get(PDFName.of(keys[i] as string));
        const name = value === undefined ? "" : baseFontName(pdf, value);
        result.set(ids[i] as string, {
          bold: BOLD_BASEFONT_RE.test(name),
          italic: ITALIC_BASEFONT_RE.test(name),
        });
      }
    }
  } catch {
    // Any surprise mid-walk keeps whatever was resolved so far.
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Link annotations (pdf.js display intent)                              */
/* ------------------------------------------------------------------ */

interface RawAnnotation {
  subtype?: unknown;
  url?: unknown;
  unsafeUrl?: unknown;
  rect?: unknown;
}

/** The URL schemes we are honest about (javascript: never passes). */
const URL_RE = /^(https?|mailto|ftp):/i;

/** Link rects with a usable URL for one page (empty on any damage). */
function linkRectsFor(annots: readonly RawAnnotation[]): MdLinkRect[] {
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

    const styleMap = await buildFontStyleMap(bytes, pages);
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
