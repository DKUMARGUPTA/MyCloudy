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
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import {
  buildDocx,
  DOCX_MIME,
  docxStats,
  extractTextBlocks,
  parseRun,
  type DocxParaBlock,
  type PdfTextItemInput,
} from "./model";

/**
 * PDF → Word worker (RB1-b, the 68th tool) — 100% on-device, EN+हिंदी.
 *
 * Protocol mirrors create-resume / pdf-to-txt:
 *
 *  1. parseRun — defensive coercion of the surface's options payload
 *     (headings on/off, page breaks, locale, localized fallback word);
 *  2. pdf.js getDocument on a COPY of the buffer (pinned lesson: pdf.js
 *     transfers + detaches the ArrayBuffer it receives — the original
 *     bytes must survive for the font pass below), one getTextContent
 *     per page, page.cleanup() + task.destroy() afterwards;
 *  3. buildFontBoldMap — pdf.js 4.x reports only internal font ids
 *     ("g_d0_f3"), never the real names, so bold is recovered from the
 *     PDF itself: each page's distinct item ids (first-use order) are
 *     zipped with the page's distinct /Font resource keys in Tf
 *     first-use order; a BaseFont like "Helvetica-Bold" marks the id
 *     bold. Any mismatch (form XObjects, inherited resources, Type3)
 *     skips that page's enrichment — bold degrades honestly to off;
 *  4. extractTextBlocks + buildDocx (fflate OOXML) → Blob download.
 *     Table detection (default on): consecutive lines with matching
 *     column clusters become real Word tables; everything else keeps
 *     the paragraph path. The detail reports the tables count.
 *
 * Scanned PDFs (zero selectable text) fail with tool.errorNoText —
 * honest, same as pdf-to-txt (OCR chain suggested in the FAQ copy).
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** BaseFont names that read as bold. */
const BOLD_BASEFONT_RE = /(bold|black|heavy|demi|semib)/i;

interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  fontName?: unknown;
}

/* ------------------------------------------------------------------ */
/* Bold enrichment (pdf.js id → PDF font table)                       */
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

/** True when the font dict's BaseFont reads as a bold face. */
function fontDictIsBold(doc: PDFDocument, value: unknown): boolean {
  const dict = value instanceof PDFRef
    ? doc.context.lookupMaybe(value, PDFDict)
    : value instanceof PDFDict
      ? value
      : undefined;
  if (!dict) return false;
  const baseFont = dict.get(PDFName.of("BaseFont"));
  if (baseFont instanceof PDFName) {
    if (BOLD_BASEFONT_RE.test(pdfNameText(baseFont))) return true;
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
      return BOLD_BASEFONT_RE.test(pdfNameText(childName));
    }
  }
  return false;
}

/**
 * Maps pdf.js internal font ids → bold for the whole document, by
 * correlating each page's distinct ids (item order) with that page's
 * distinct Tf-used resource keys (content-stream order). Exported for
 * the smoke, which drives the same enrichment on real fixtures.
 */
export async function buildFontBoldMap(
  bytes: Uint8Array,
  pages: readonly PdfTextItemInput[][]
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
  } catch {
    return result; // unreadable structure → no bold, honest degradation
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
        const value = fonts.get(PDFName.of(keys[i]));
        result.set(ids[i], value === undefined ? false : fontDictIsBold(pdf, value));
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
  const opts = parseRun(String(request.options.run ?? ""));
  const file = request.files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 20, stage: "reading" });

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

  const pages: RawTextItem[][] = [];
  let chars = 0;
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    page.cleanup();
    const items = content.items as RawTextItem[];
    pages.push(items);
    for (const item of items) {
      if (typeof item.str === "string") chars += item.str.trim().length;
    }
  }
  await doc.cleanup();
  await task.destroy();

  post({ type: "progress", runId, pct: 45, stage: "processing" });

  // Scans have zero selectable text — fail honestly instead of shipping
  // an empty file (the pdf-to-txt precedent; the FAQ suggests the OCR
  // tool for this exact case).
  if (chars === 0) {
    post({
      type: "error",
      runId,
      code: "tool.errorNoText",
      detail: file.name,
    });
    return;
  }

  const boldMap = await buildFontBoldMap(bytes, pages);
  const model = extractTextBlocks(pages, {
    boldMap,
    headings: opts.headings,
    tables: opts.tables,
  });

  post({ type: "progress", runId, pct: 85, stage: "saving" });

  // Title = first Heading1 paragraph, else the first paragraph (a table
  // block carries no runs and is never the title).
  const titlePara =
    model.blocks.find(
      (block): block is DocxParaBlock =>
        block.kind === "para" && block.headingLevel === 1
    ) ??
    model.blocks.find(
      (block): block is DocxParaBlock => block.kind === "para"
    );
  const docx = buildDocx(model, {
    pageBreaks: opts.pageBreaks,
    title: titlePara ? titlePara.runs.map((r) => r.text).join(" ") : "",
  });

  const base =
    file.name
      .replace(/\.pdf$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .trim()
      .slice(0, 120) || opts.fileWord || "document";

  const stats = docxStats(model);
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${base}.docx`,
        mime: DOCX_MIME,
        blob: new Blob([docx as unknown as BlobPart], { type: DOCX_MIME }),
      },
    ],
    detail: {
      files: 1,
      pages: stats.pages,
      paragraphs: stats.paragraphs,
      headings: stats.headings,
      tables: stats.tables,
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /password/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code });
  });
};
