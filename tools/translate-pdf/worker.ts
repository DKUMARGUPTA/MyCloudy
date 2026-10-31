import type { StampTtfFont } from "@/lib/own/pdf";
import { CreateContext, type CreatePage } from "@/lib/own/pdf";
import { faceOpts, faceWidth, type ConvertFace } from "../convert-common/face";

import type { WorkerRunRequest, WorkerResponse } from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import {
  TRANSLATE_LIMITS,
  batchText,
  batchesChars,
  buildBatches,
  isLikelyScanned,
  isTargetLang,
  isTranslateMode,
  normalizePageText,
  scriptOfText,
  adjustCjkBreak,
  targetLang,
  translateOutputName,
  SCRIPT_FONT,
  type ExtractedPage,
} from "./model";
import { bidiVisualLine, shapeArabic } from "./arabic-shape";
import { stripWrappingQuotes } from "./api-model";

/**
 * Translate PDF (R9-c) — worker pipeline, ALL on-device except the bounded
 * translation calls:
 *
 *   pdf.js extracts per-page text (fake-worker, chat-with-pdf recipe)
 *   → buildBatches packs consecutive lines into ≤2 800-char units
 *   → each batch POSTs to /api/translate (ONLY the batch string + target)
 *   → the OWN ENGINE rebuilds a clean re-flowed PDF (A4, real fonts)
 *
 * Layout honesty (FAQ promises exactly this): the output is NOT a pixel
 * copy of the input — text is re-flowed, page count can differ, and every
 * original page gets a small "Page N" header. Devanagari targets embed the
 * self-hosted Noto Sans Devanagari (auto-subset); CJK targets embed Noto
 * Sans SC/JP/KR (auto-subset, kinsoku-lite wrapping); Arabic targets embed
 * Noto Naskh Arabic and go through our own presentation-form shaper +
 * display reorder before drawText; latin targets use Helvetica with
 * winAnsiSafe so drawText can never throw.
 */

type PdfjsModule = typeof import("pdfjs-dist");

interface Piece {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
}

interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
}

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** Same visual-line grouping as chat-with-pdf's worker (shared recipe). */
function pageText(items: RawTextItem[]): string {
  const pieces: Piece[] = [];
  for (const item of items) {
    if (typeof item.str !== "string" || item.str.length === 0) continue;
    const transform = item.transform;
    if (!Array.isArray(transform) || transform.length < 6) continue;
    const x = Number(transform[4]);
    const y = Number(transform[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const size = Math.hypot(
      Number(transform[1]) || 0,
      Number(transform[3]) || 0,
    );
    pieces.push({
      str: item.str,
      x,
      y,
      w: Number(item.width) || 0,
      size: size > 0 ? size : 10,
    });
  }
  if (pieces.length === 0) return "";

  pieces.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: string[] = [];
  let current: Piece[] = [pieces[0]];
  let groupY = pieces[0].y;
  let tol = Math.max(1.5, pieces[0].size * 0.5);

  const flush = (): void => {
    current.sort((a, b) => a.x - b.x);
    const size = current[0].size;
    let text = "";
    let endX: number | null = null;
    for (const piece of current) {
      if (
        endX !== null &&
        piece.x - endX > size * 0.25 &&
        !text.endsWith(" ")
      ) {
        text += " ";
      }
      text += piece.str;
      endX = Math.max(endX ?? 0, piece.x + piece.w);
    }
    lines.push(text.replace(/\s+$/, ""));
  };

  for (let i = 1; i < pieces.length; i += 1) {
    const piece = pieces[i];
    if (Math.abs(piece.y - groupY) <= tol) {
      current.push(piece);
    } else {
      flush();
      current = [piece];
      groupY = piece.y;
      tol = Math.max(1.5, piece.size * 0.5);
    }
  }
  flush();
  return lines.join("\n");
}

async function extractPages(file: ArrayBuffer): Promise<ExtractedPage[]> {
  const pdfjs: PdfjsModule = await loadPdfjsInWorker();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(file),
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;
  try {
    const pages: ExtractedPage[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push({
        page: n,
        text: normalizePageText(pageText(content.items as RawTextItem[])),
      });
      page.cleanup();
    }
    return pages;
  } finally {
    doc.cleanup();
    await doc.destroy();
  }
}

/* ------------------------- the API round-trip ------------------------- */

/**
 * Absolute URL for an asset/endpoint, resolved against the worker's REAL
 * base (blob: workers in dev need the origin recovered from the blob URL —
 * the stamp-common recipe).
 */
function absoluteUrl(path: string): string {
  try {
    const viaLocation = new URL(path, self.location.href);
    if (
      viaLocation.protocol === "http:" ||
      viaLocation.protocol === "https:"
    ) {
      return viaLocation.href;
    }
  } catch {
    // opaque base (blob: workers) — recover the origin from the blob URL
  }
  const blobOrigin = /^blob:(https?:\/\/[^/]+)/i.exec(self.location.href);
  if (blobOrigin) return `${blobOrigin[1]}${path}`;
  return path;
}

async function translateBatch(
  text: string,
  target: string,
  locale: string,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(absoluteUrl("/api/translate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, target, locale }),
    });
  } catch {
    throw new Error("translate-aiUnavailable");
  }
  const data: unknown = await res.json().catch(() => null);
  const translated = (data as { text?: unknown } | null)?.text;
  if (res.ok && typeof translated === "string" && translated.trim().length > 0) {
    return stripWrappingQuotes(translated);
  }
  const code = (data as { error?: unknown } | null)?.error;
  throw new Error(
    code === "timeout"
      ? "translate-timeout"
      : code === "emptyTranslation"
        ? "translate-emptyTranslation"
        : code === "aiNotConfigured"
          ? "translate-aiNotConfigured"
          : "translate-aiUnavailable",
  );
}

/* --------------------------- PDF assembly --------------------------- */

const A4 = { w: 595.28, h: 841.89 } as const;
const MARGIN = 48;

/** Plain RGB triple (the engine's draw-time color shape). */
interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface FlowOptions {
  size: number;
  lineH: number;
  color: Rgb;
  headerColor: Rgb;
  font: ConvertFace;
  headerFont: ConvertFace;
  /** Arabic flow: shape first, reorder each drawn line for the LTR renderer. */
  rtl: boolean;
  /** CJK flow: kinsoku-lite break adjustment (no line starting with 。）」). */
  cjk: boolean;
}

class TextFlow {
  private doc: CreateContext;
  private page: CreatePage | null = null;
  private y = 0;
  private readonly width = A4.w - MARGIN * 2;

  constructor(doc: CreateContext) {
    this.doc = doc;
  }

  private newPage(): void {
    this.page = this.doc.addPage(A4.w, A4.h);
    this.y = A4.h - MARGIN;
  }

  space(amount: number): void {
    if (this.page === null) return;
    this.y -= amount;
  }

  pageHeader(label: string, opts: FlowOptions): void {
    if (this.page !== null && this.y < A4.h - MARGIN - 4) this.newPage();
    if (this.page === null) this.newPage();
    this.line(label, opts.headerFont, 8, 10.5, opts.headerColor);
    this.space(4);
  }

  private line(
    text: string,
    font: ConvertFace,
    size: number,
    lineH: number,
    color: Rgb,
    rtl = false,
  ): void {
    if (this.page === null) this.newPage();
    const page = this.page as CreatePage;
    page.drawText({
      text: rtl ? bidiVisualLine(text) : text,
      x: MARGIN,
      y: Math.max(MARGIN, this.y - size),
      size,
      color,
      ...faceOpts(font),
    });
    this.y -= lineH;
    if (this.y < MARGIN + lineH * 0.25) this.page = null;
  }

  /** Greedy word wrap — binary search for the fitting take, then a
   *  space-cut refinement so lines break at words whenever they can.
   *  CJK paragraphs get kinsoku-lite adjustment (no line starts with a
   *  closer / ends with an opener); Arabic was shaped upstream and each
   *  emitted line is reordered by line() when opts.rtl. */
  wrapped(text: string, opts: FlowOptions): void {
    const { font, size, lineH, color, rtl, cjk } = opts;
    for (const paragraph of text.split("\n")) {
      if (paragraph.trim().length === 0) {
        this.space(lineH * 0.55);
        continue;
      }
      let rest = paragraph;
      while (rest.length > 0) {
        let lo = 1;
        let hi = rest.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (
            faceWidth(this.doc, font, rest.slice(0, mid), size) <= this.width
          ) {
            lo = mid;
          } else {
            hi = mid - 1;
          }
        }
        let take = lo;
        if (take < rest.length && take > 1) {
          // Prefer breaking at the last space inside the fitting prefix.
          const cut = rest.lastIndexOf(" ", take);
          if (cut >= Math.floor(take * 0.4)) take = Math.max(1, cut);
        }
        if (cjk) take = adjustCjkBreak(rest, take);
        this.line(rest.slice(0, take), font, size, lineH, color, rtl);
        rest = rest.slice(take).trimStart();
      }
    }
  }
}

/**
 * Script font loader with a per-run cache: the target language's font and
 * the bilingual original's font are often the same URL — embed once.
 * Fonts are self-hosted TTFs from /fonts (the engine's auto-subset keeps
 * output small).
 */
async function loadScriptFont(
  doc: CreateContext,
  url: string,
  cache: Map<string, StampTtfFont>,
): Promise<StampTtfFont> {
  const cached = cache.get(url);
  if (cached) return cached;
  const res = await fetch(absoluteUrl(url));
  if (!res.ok) throw new Error("translate-fontFetch");
  const bytes = new Uint8Array(await res.arrayBuffer());
  const font = doc.embedTtf(bytes);
  cache.set(url, font);
  return font;
}

/** WinAnsi sanitizer applied only to latin-script draws. */
function latinSafe(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (
      ch === "\n" ||
      ch === "\t" ||
      (code >= 0x20 && code <= 0xff) ||
      code === 0x2018 ||
      code === 0x2019 ||
      code === 0x201c ||
      code === 0x201d ||
      code === 0x2013 ||
      code === 0x2014 ||
      code === 0x2026 ||
      code === 0x20ac
    ) {
      out += ch;
    } else {
      out += "?";
    }
  }
  return out;
}

/* ------------------------------- run ------------------------------- */

async function run(req: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = req;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorNoFile" });
    return;
  }
  const target = isTargetLang(options.targetLang)
    ? options.targetLang
    : "hi";
  const mode = isTranslateMode(options.mode) ? options.mode : "translated";
  const locale = options.locale === "hi" ? "hi" : "en";

  post({
    type: "progress",
    runId,
    pct: 2,
    stage: "reading",
    detail: { page: 0, pages: 0 },
  });

  // 1. Extract on-device.
  const buf = await file.arrayBuffer();
  const pages = await extractPages(buf);

  if (pages.length > TRANSLATE_LIMITS.maxPages) {
    post({ type: "error", runId, code: "tool.errorTranslateTooLong" });
    return;
  }
  if (isLikelyScanned(pages)) {
    post({ type: "error", runId, code: "tool.errorNoText" });
    return;
  }

  // 2. Batch the source text.
  const batches = buildBatches(pages);
  const totalChars = batchesChars(batches);
  if (totalChars > TRANSLATE_LIMITS.maxTotalChars) {
    post({ type: "error", runId, code: "tool.errorTranslateTooLong" });
    return;
  }

  // 3. Translate batch by batch (bounded strings only).
  const translated: string[] = [];
  for (let i = 0; i < batches.length; i += 1) {
    const text = await translateBatch(batchText(batches[i]), target, locale);
    translated.push(text);
    post({
      type: "progress",
      runId,
      pct: 10 + Math.round(((i + 1) / batches.length) * 78),
      stage: "processing",
      detail: { page: batches[i].page, pages: pages.length },
    });
  }

  // 4. Build the output PDF.
  post({ type: "progress", runId, pct: 90, stage: "saving" });
  const doc = CreateContext.create();
  const helv: ConvertFace = { std: "helvetica" };
  const lang = targetLang(target);
  const fontCache = new Map<string, StampTtfFont>();
  let translatedFont: ConvertFace = helv;
  if (lang.font) {
    translatedFont = {
      ttf: await loadScriptFont(doc, lang.font, fontCache),
    };
  }
  const translatedRtl = lang.script === "arabic";
  const translatedCjk =
    lang.script === "han" || lang.script === "kana" || lang.script === "hangul";

  // Per-page translated text: join the batches belonging to each page.
  const perPage = new Map<number, string[]>();
  batches.forEach((b, i) => {
    const list = perPage.get(b.page) ?? [];
    list.push(translated[i] ?? "");
    perPage.set(b.page, list);
  });

  const flow = new TextFlow(doc);
  const translatedOpts: FlowOptions = {
    size: 11,
    lineH: 15.5,
    color: { r: 0.11, g: 0.13, b: 0.15 },
    headerColor: { r: 0.45, g: 0.47, b: 0.5 },
    font: translatedFont,
    headerFont: helv,
    rtl: translatedRtl,
    cjk: translatedCjk,
  };

  for (const p of pages) {
    const pageTranslated = (perPage.get(p.page) ?? []).join("\n");
    if (pageTranslated.trim().length === 0 && p.text.trim().length === 0) {
      continue;
    }
    flow.pageHeader(`Page ${p.page}`, translatedOpts);

    // The translated draw: latin sanitized for Helvetica; Arabic shaped
    // upstream of wrapping then visually reordered per line; CJK verbatim.
    const translatedDraw =
      lang.script === "latin"
        ? latinSafe(pageTranslated)
        : translatedRtl
          ? shapeArabic(pageTranslated)
          : pageTranslated;

    if (mode === "bilingual") {
      const origScript = scriptOfText(p.text);
      const origFontUrl =
        origScript === "latin" ? null : SCRIPT_FONT[origScript];
      const origFont = origFontUrl
        ? { ttf: await loadScriptFont(doc, origFontUrl, fontCache) }
        : helv;
      const origRtl = origScript === "arabic";
      const origText =
        origScript === "latin"
          ? latinSafe(p.text)
          : origRtl
            ? shapeArabic(p.text)
            : p.text;
      flow.wrapped(origText, {
        size: 9.5,
        lineH: 13,
        color: { r: 0.42, g: 0.45, b: 0.48 },
        headerColor: translatedOpts.headerColor,
        font: origFont,
        headerFont: helv,
        rtl: origRtl,
        cjk: origScript === "han" || origScript === "kana" || origScript === "hangul",
      });
      flow.space(8);
      flow.wrapped(translatedDraw, translatedOpts);
      flow.space(20);
    } else {
      flow.wrapped(translatedDraw, translatedOpts);
      flow.space(14);
    }
  }

  // R44 branding — metadata only; the document stays clean.
  doc.setProducer("DocoPDF");
  doc.setCreator("DocoPDF");
  doc.setTitle(translateOutputName(file.name, target).replace(/\.pdf$/i, ""));
  doc.setCreationDate(new Date());
  const bytes = doc.write();
  post({ type: "progress", runId, pct: 98, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: translateOutputName(file.name, target),
        mime: "application/pdf",
        blob: new Blob([bytes as BlobPart], { type: "application/pdf" }),
      },
    ],
    detail: {
      files: 1,
      pages: pages.length,
      translatedChars: totalChars,
      translatedBatches: batches.length,
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^translate-(.+)$/.exec(message)?.[1] ?? "";
    if (code === "timeout") {
      post({ type: "error", runId: data.runId, code: "tool.errorTranslateTimeout" });
    } else if (code === "aiNotConfigured") {
      post({ type: "error", runId: data.runId, code: "tool.errorTranslateNotConfigured" });
    } else if (code === "aiUnavailable" || code === "emptyTranslation" || code === "badRequest") {
      post({ type: "error", runId: data.runId, code: "tool.errorTranslateAi" });
    } else if (code === "fontFetch") {
      post({ type: "error", runId: data.runId, code: "tool.errorPageFont" });
    } else if (/password/i.test(message)) {
      post({ type: "error", runId: data.runId, code: "tool.errorEncrypted" });
    } else {
      post({ type: "error", runId: data.runId, code: "tool.errorCorrupt" });
    }
  });
};
