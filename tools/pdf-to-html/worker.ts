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
  buildHtml,
  coerceRunOptions,
  docStats,
  extractDocument,
  layoutLineCount,
  outputBaseName,
  pdfErrorMessageToCode,
  type FontStyle,
  type PdfTextItemInput,
} from "./model";

/**
 * PDF → HTML worker (RB4-b). 100% on-device, EN + हिंदी: pdf.js runs
 * INSIDE this worker (fake-worker mode, the pdf-to-txt/pdf-to-word
 * recipe), the file arrives by structured clone and the single
 * self-contained .html Blob leaves the same way — zero network.
 *
 * Pipeline:
 *  1. coerceRunOptions — mode (flow/layout), page-number markers,
 *     page range, locale + localized fallback word;
 *  2. pdf.js getDocument on a FRESH copy (pinned lesson: pdf.js
 *     transfers + detaches the buffer it receives — the original
 *     bytes must survive for the font pass), one getTextContent per
 *     SELECTED page, page.cleanup() + doc.destroy() afterwards;
 *  3. <title> — the PDF's own metadata Title, falling back to the
 *     first h1 text, then the file name;
 *  4. buildFontStyleMap — pdf.js 4.x reports only internal font ids
 *     ("g_d0_f3"), never the real names, so bold AND italic are
 *     recovered from the PDF itself (the pdf-to-word correlation:
 *     each page's distinct item ids zipped with the page's distinct
 *     /Font resource keys in Tf first-use order; BaseFont names like
 *     "Helvetica-Bold" / "Helvetica-Oblique" carry the style);
 *  5. extractDocument + buildHtml → one .html download.
 *
 * Honest failure modes: a PDF with NO selectable text anywhere stops
 * with tool.errorNoText (scans need the OCR tool first — never an
 * empty file); encrypted files stop with tool.errorEncrypted;
 * unreadable bytes with tool.errorCorrupt.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** BaseFont names that read as bold / italic. */
const BOLD_BASEFONT_RE = /(bold|black|heavy|demi|semib)/i;
const ITALIC_BASEFONT_RE = /(italic|oblique)/i;

interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  fontName?: unknown;
}

/* ------------------------------------------------------------------ */
/* Style enrichment (pdf.js id → PDF font table)                       */
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
      parent instanceof PDFRef
        ? doc.context.lookupMaybe(parent, PDFDict)
        : undefined;
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
    if (!keys.includes(match[1])) keys.push(match[1]);
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

/** The style of one font dict's BaseFont (descendant-aware for Type0). */
function fontDictStyle(
  doc: PDFDocument,
  value: unknown
): FontStyle {
  const dict =
    value instanceof PDFRef
      ? doc.context.lookupMaybe(value, PDFDict)
      : value instanceof PDFDict
        ? value
        : undefined;
  if (!dict) return { bold: false, italic: false };

  let name: string | null = null;
  const baseFont = dict.get(PDFName.of("BaseFont"));
  if (baseFont instanceof PDFName) name = pdfNameText(baseFont);
  if (name === null) {
    // Type0 wrapped fonts keep the real face in the descendant's name.
    const descendant = dict.get(PDFName.of("DescendantFonts"));
    if (descendant instanceof PDFArray && descendant.size() > 0) {
      const child = descendant.get(0);
      const childDict =
        child instanceof PDFRef
          ? doc.context.lookupMaybe(child, PDFDict)
          : child instanceof PDFDict
            ? child
            : undefined;
      const childName = childDict?.get(PDFName.of("BaseFont"));
      if (childName instanceof PDFName) name = pdfNameText(childName);
    }
  }
  if (name === null) return { bold: false, italic: false };
  return {
    bold: BOLD_BASEFONT_RE.test(name),
    italic: ITALIC_BASEFONT_RE.test(name),
  };
}

/**
 * Maps pdf.js internal font ids → {bold, italic} for the whole
 * document, by correlating each selected page's distinct ids (item
 * order) with that page's distinct Tf-used resource keys
 * (content-stream order). `pageIndexes` holds each entry's ORIGINAL
 * 0-based pdf.js page index (page ranges keep the correlation true).
 * Exported for the smoke, which drives the same enrichment on real
 * fixtures.
 */
export async function buildFontStyleMap(
  bytes: Uint8Array,
  pageIndexes: readonly number[],
  pages: readonly PdfTextItemInput[][]
): Promise<Map<string, FontStyle>> {
  const result = new Map<string, FontStyle>();
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
    for (let entry = 0; entry < pageCount; entry += 1) {
      const pageIndex = pageIndexes[entry] ?? entry;
      if (pageIndex < 0 || pageIndex >= pdf.getPageCount()) continue;

      // Distinct pdf.js font ids on this page, in first-appearance order.
      const ids: string[] = [];
      for (const item of pages[entry]) {
        const fn = typeof item?.fontName === "string" ? item.fontName : "";
        if (fn.length > 0 && !ids.includes(fn)) ids.push(fn);
      }
      if (ids.length === 0) continue;

      const node = pdf.getPage(pageIndex).node;
      const keys = tfOrderForPage(pdf, node);
      const fonts = fontResourcesFor(pdf, node);
      if (!fonts) continue;
      // pdf.js assigns one id per distinct FONT OBJECT, while pdf-lib
      // writes a fresh resource key per drawText call — dedupe the keys
      // by the object they resolve to (first key per object wins) so
      // both sides count the same things before correlating.
      const seenRefs = new Set<string>();
      const seenDicts = new WeakSet<PDFDict>();
      const distinctKeys: string[] = [];
      for (const key of keys) {
        const value = fonts.get(PDFName.of(key));
        if (value === undefined) continue; // dangling key
        if (value instanceof PDFRef) {
          const objectId = value.toString();
          if (seenRefs.has(objectId)) continue;
          seenRefs.add(objectId);
        } else if (value instanceof PDFDict) {
          if (seenDicts.has(value)) continue;
          seenDicts.add(value);
        } else {
          continue; // not a font dict/ref — skip, honest
        }
        distinctKeys.push(key);
      }
      if (distinctKeys.length !== ids.length) {
        continue; // mismatch (forms / weird streams) → skip, stay honest
      }
      for (let i = 0; i < ids.length; i += 1) {
        const value = fonts.get(PDFName.of(distinctKeys[i]));
        result.set(
          ids[i],
          value === undefined ? { bold: false, italic: false } : fontDictStyle(pdf, value)
        );
      }
    }
  } catch {
    // Any surprise mid-walk keeps whatever was resolved so far.
  }
  return result;
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

    /* ---- <title>: metadata → first h1 → file name (honest cascade) ---- */
    let title = "";
    try {
      const meta = await doc.getMetadata();
      const info = (meta as { info?: { Title?: unknown } }).info;
      if (typeof info?.Title === "string") title = info.Title.trim().slice(0, 120);
    } catch {
      // No readable metadata → the heading/file-name fallbacks apply.
    }

    /* ---- one getTextContent per selected page ---- */
    const items: PdfTextItemInput[][] = [];
    const widths: number[] = [];
    const heights: number[] = [];
    let chars = 0;
    for (let i = 0; i < pageNumbers.length; i += 1) {
      const page = await doc.getPage(pageNumbers[i] + 1);
      const viewport = page.getViewport({ scale: 1 });
      let content;
      try {
        content = await page.getTextContent();
      } finally {
        page.cleanup();
      }
      const pageItems = content.items as RawTextItem[];
      items.push(pageItems);
      widths.push(viewport.width);
      heights.push(viewport.height);
      for (const item of pageItems) {
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

    // Scans have zero selectable text — fail honestly instead of
    // shipping an empty file (the pdf-to-word/pdf-to-txt precedent;
    // the FAQ suggests the OCR tool for this exact case).
    if (chars === 0) {
      post({
        type: "error",
        runId,
        code: "tool.errorNoText",
        detail: file.name,
      });
      return;
    }

    const styleMap = await buildFontStyleMap(bytes, pageNumbers, items);

    const inputs = items.map((pageItems, i) => ({
      pageNo: pageNumbers[i] + 1,
      widthPt: widths[i],
      heightPt: heights[i],
      items: pageItems,
    }));
    const extracted = extractDocument(inputs, { styleMap });

    if (!title) {
      const h1 = extracted.blocks.find(
        (block) => block.kind === "para" && block.headingLevel === 1
      );
      if (h1) {
        title = h1.runs.map((r) => r.text).join("").trim().slice(0, 120);
      }
    }
    if (!title) {
      title = file.name.replace(/\.pdf$/i, "").trim().slice(0, 120);
    }

    post({ type: "progress", runId, pct: 85, stage: "saving" });

    const html = buildHtml(extracted, {
      mode: opts.mode,
      pageNumbers: opts.pageNumbers,
      title,
      pageWord: opts.pageWord,
      noTextWord: opts.noTextWord,
    });

    const base = outputBaseName(file.name, opts.locale);
    const stats = docStats(extracted);
    const detail: Record<string, number | boolean> = {
      files: 1,
      pages: pageNumbers.length,
      headings: stats.headings ?? 0,
    };
    if (opts.mode === "layout") {
      detail.paragraphs = layoutLineCount(extracted);
    } else {
      detail.paragraphs = stats.paragraphs ?? 0;
    }

    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${base}.html`,
          mime: "text/html",
          blob: new Blob([html], { type: "text/html; charset=utf-8" }),
        },
      ],
      detail,
    });
  } finally {
    await doc.destroy().catch(() => undefined);
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
