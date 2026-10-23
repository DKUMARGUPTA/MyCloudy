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
  buildOdt,
  coerceRunOptions,
  docTitleFrom,
  extractOdtBlocks,
  ODT_MIME,
  odtStats,
  outputBaseName,
  pageBlocksOf,
  pdfErrorMessageToCode,
  type FontStyleInfo,
  type OdtBlock,
  type OdtDocModel,
  type PdfTextItemInput,
} from "./model";

/**
 * PDF → OpenDocument Text worker (RB4-d). 100% on-device: pdf.js runs
 * INSIDE this worker (fake-worker mode, the pdf-to-txt recipe), the
 * file arrives by structured clone and the .odt Blob leaves the same
 * way — zero network. The package is written by the model's fflate
 * zipSync, shaped exactly for the odt-to-pdf parser to read back.
 *
 *  1. coerceRunOptions — pages range, the one-file-per-page switch,
 *     locale + the localized fallback word;
 *  2. pdf.js getDocument on a COPY of the buffer (pinned lesson: pdf.js
 *     transfers + detaches the ArrayBuffer it receives — the original
 *     bytes must survive for the font pass below), one getTextContent
 *     per selected page, page.cleanup() + doc.destroy() afterwards;
 *  3. buildFontStyleMap — pdf.js 4.x reports only internal font ids
 *     ("g_d0_f3"), never the real names, so bold/italic is recovered
 *     from the PDF itself (the pdf-to-word enrichment, extended with
 *     italic): each page's distinct item ids (first-use order) are
 *     zipped with the page's distinct /Font resource keys in Tf
 *     first-use order; a BaseFont like "Helvetica-Bold" or
 *     "Helvetica-Oblique" marks the id. Any mismatch (form XObjects,
 *     inherited resources, Type3) skips that page's enrichment — styles
 *     degrade honestly to the font-name regex only;
 *  4. extractOdtBlocks + buildOdt — a single .odt, or one .odt per
 *     page (multi-output; the shared result view offers per-file
 *     download plus "Download all (ZIP)").
 *
 * Scanned PDFs (zero selectable text) fail with tool.errorNoText —
 * honest, same as pdf-to-word/pdf-to-txt. The dc:title comes from the
 * PDF's own info dictionary (getMetadata), falling back to the first
 * heading.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/* ------------------------------------------------------------------ */
/* Font-style enrichment (pdf.js id → PDF font table)                  */
/* ------------------------------------------------------------------ */

/** BaseFont names that read as bold / italic (real names only). */
const BOLD_BASEFONT_RE = /(bold|black|heavy|demi|semib)/i;
const ITALIC_BASEFONT_RE = /(italic|oblique)/i;

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

/** True when the font dict's BaseFont reads as the given style. */
function baseFontMatches(name: PDFName | undefined, bold: boolean): boolean {
  if (!name) return false;
  const re = bold ? BOLD_BASEFONT_RE : ITALIC_BASEFONT_RE;
  return re.test(pdfNameText(name));
}

/** Bold/italic of one font dict (descendant's BaseFont counts for Type0). */
function fontDictStyle(doc: PDFDocument, value: unknown): FontStyleInfo {
  const dict = value instanceof PDFRef
    ? doc.context.lookupMaybe(value, PDFDict)
    : value instanceof PDFDict
      ? value
      : undefined;
  if (!dict) return { bold: false, italic: false };
  const baseFont = dict.get(PDFName.of("BaseFont"));
  if (baseFont instanceof PDFName) {
    return {
      bold: baseFontMatches(baseFont, true),
      italic: baseFontMatches(baseFont, false),
    };
  }
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
    if (childName instanceof PDFName) {
      return {
        bold: baseFontMatches(childName, true),
        italic: baseFontMatches(childName, false),
      };
    }
  }
  return { bold: false, italic: false };
}

/**
 * Maps pdf.js internal font ids → bold/italic for the whole document, by
 * correlating each page's distinct ids (item order) with that page's
 * distinct Tf-used resource keys (content-stream order). Exported for
 * the smoke, which drives the same enrichment on real fixtures.
 */
export async function buildFontStyleMap(
  bytes: Uint8Array,
  pages: readonly PdfTextItemInput[][]
): Promise<Map<string, FontStyleInfo>> {
  const result = new Map<string, FontStyleInfo>();
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
      for (const item of pages[index] ?? []) {
        const fn = typeof item?.fontName === "string" ? item.fontName : "";
        if (fn.length > 0 && !ids.includes(fn)) ids.push(fn);
      }
      if (ids.length === 0) continue;

      const node = pdf.getPage(index).node;
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
        const value = fonts.get(PDFName.of(distinctKeys[i] as string));
        result.set(
          ids[i] as string,
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
  const { runId, files } = request;
  const opts = coerceRunOptions(request.options as Record<string, unknown>);

  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 10, stage: "reading" });
  const pdfjs = await loadPdfjsInWorker();
  // PINNED LESSON: pdf.js transfers + detaches the buffer it is handed —
  // pass a COPY so `bytes` stays valid for the font pass afterwards.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;
  post({ type: "progress", runId, pct: 15, stage: "processing" });

  try {
    const pageNumbers = parsePageSpec(opts.pages, doc.numPages);
    if (pageNumbers === null || pageNumbers.length === 0) {
      post({ type: "error", runId, code: "tool.errorInvalidPages" });
      return;
    }

    // Document title: the PDF's own info dictionary, if it carries one.
    let info: unknown = null;
    try {
      const meta = await doc.getMetadata();
      info = meta?.info ?? null;
    } catch {
      /* metadata is optional */
    }

    const pages: PdfTextItemInput[][] = [];
    let chars = 0;
    for (let i = 0; i < pageNumbers.length; i += 1) {
      const page = await doc.getPage(pageNumbers[i] as number + 1);
      let content;
      try {
        content = await page.getTextContent();
      } finally {
        page.cleanup();
      }
      const items = content.items as PdfTextItemInput[];
      pages.push(items);
      for (const item of items) {
        if (typeof item.str === "string") chars += item.str.trim().length;
      }
      post({
        type: "progress",
        runId,
        pct: 15 + Math.round((65 * (i + 1)) / pageNumbers.length),
        stage: "processing",
        detail: { page: i + 1, pages: pageNumbers.length },
      });
    }

    // Scans have zero selectable text — fail honestly instead of
    // shipping an empty package (the pdf-to-word precedent; the FAQ
    // suggests the OCR tool for this exact case).
    if (chars === 0) {
      post({
        type: "error",
        runId,
        code: "tool.errorNoText",
        detail: file.name,
      });
      return;
    }

    const styleMap = await buildFontStyleMap(bytes, pages);
    const model = extractOdtBlocks(pages, { styleMap });

    post({ type: "progress", runId, pct: 85, stage: "saving" });

    // Title fallback: the first heading's joined text.
    const firstHeading = model.blocks.find(
      (b) => b.headingLevel !== undefined
    );
    const fallbackTitle = firstHeading
      ? firstHeading.runs.map((r) => r.text).join("").trim()
      : "";
    const title = docTitleFrom(info, fallbackTitle);

    const base = outputBaseName(file.name, opts.locale, opts.fileWord);
    const style = { bodyPt: model.bodyPt, headingPt: model.headingPt };

    const outputs: { name: string; mime: string; blob: Blob }[] = [];
    if (opts.perPage) {
      // One honest .odt per selected page (empty pages keep one empty
      // paragraph — the builder guarantees a valid body).
      for (let i = 0; i < pageNumbers.length; i += 1) {
        const blocks: OdtBlock[] = pageBlocksOf(
          model as OdtDocModel,
          pageNumbers[i] as number
        );
        const pageOdt = buildOdt(blocks, { ...style, title });
        outputs.push({
          name: `${base}-page${(pageNumbers[i] as number) + 1}.odt`,
          mime: ODT_MIME,
          blob: new Blob([pageOdt as unknown as BlobPart], {
            type: ODT_MIME,
          }),
        });
      }
    } else {
      const odt = buildOdt(model.blocks, { ...style, title });
      outputs.push({
        name: `${base}.odt`,
        mime: ODT_MIME,
        blob: new Blob([odt as unknown as BlobPart], { type: ODT_MIME }),
      });
    }

    const stats = odtStats(model.blocks);
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
