import {
  StampContext,
  organizePages,
  parseForOrganize,
  PdfError,
  type PlanEntry,
  type StampTtfFont,
} from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import { loadDevanagariBytes } from "../stamp-common/deva";
import { writeOutline } from "../bookmark-pdf/engine";

/**
 * Table of contents worker (PHASE-3 batch 2):
 *
 *   1. READ  — pdf.js collects the entries (existing bookmarks with their
 *      nesting, or one entry per page titled by its first text line).
 *   2. PLAN  — organizePages prepends/appends blank TOC page(s) sized like
 *      page 1 (vector content of every original page is preserved).
 *   3. DRAW  — StampContext writes the heading, entries, dot leaders and
 *      right-aligned page numbers onto the blanks. All fonts (including
 *      the Devanagari TTF) are embedded BEFORE drawing so every stamp is
 *      synchronous — no write() race.
 *   4. NAV   — writeOutline (the bookmark-pdf engine) adds the matching
 *      clickable bookmarks tree and opens the outline panel.
 *
 * Own engine end to end. Never touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

/** One TOC row (plus its nesting depth for indentation). */
export interface TocEntry {
  title: string;
  /** 1-based page in the ORIGINAL document. */
  page: number;
  depth: number;
}

const MAX_ENTRIES = 500;
const MAX_DEPTH = 6;
const TITLE_MAX = 90;

const hasDevanagari = (s: string): boolean => /[\u0900-\u097F]/.test(s);
/** WinAnsi-safe view of a title (chars > U+00FF dropped for the std font). */
const latinSafe = (s: string): string => s.replace(/[^\x00-\xFF]/g, "");

type PdfjsModule = typeof import("pdfjs-dist");
type PdfjsDoc = Awaited<ReturnType<PdfjsModule["getDocument"]>["promise"]>;

/** Read existing bookmarks → flat entries (depth-capped, page-resolved). */
async function readBookmarkEntries(doc: PdfjsDoc): Promise<TocEntry[]> {
  const out: TocEntry[] = [];
  let outline: Array<{ title: string | null; dest: unknown; items: unknown[] }> = [];
  try {
    outline = (await doc.getOutline()) ?? [];
  } catch {
    outline = [];
  }
  const resolvePage = async (dest: unknown): Promise<number | null> => {
    try {
      let target = dest;
      if (typeof target === "string") {
        target = await doc.getDestination(target);
      }
      if (!Array.isArray(target) || target.length === 0) return null;
      const index = await doc.getPageIndex(target[0]);
      return index + 1;
    } catch {
      return null;
    }
  };
  const walk = async (
    items: Array<{ title: string | null; dest: unknown; items: unknown[] }>,
    depth: number
  ): Promise<void> => {
    for (const item of items) {
      if (out.length >= MAX_ENTRIES) return;
      const page = await resolvePage(item.dest);
      if (page === null) continue;
      const title = (item.title ?? "").trim().slice(0, TITLE_MAX);
      out.push({
        title: title.length > 0 ? title : `Page ${page}`,
        page,
        depth,
      });
      if (depth < MAX_DEPTH - 1 && Array.isArray(item.items)) {
        await walk(item.items as typeof outline, depth + 1);
      }
    }
  };
  await walk(outline, 0);
  return out;
}

/** One entry per page, titled by the page's first text line. */
async function readPageEntries(doc: PdfjsDoc): Promise<TocEntry[]> {
  const out: TocEntry[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    if (out.length >= MAX_ENTRIES) break;
    const page = await doc.getPage(pageNumber);
    let title = "";
    try {
      const content = await page.getTextContent();
      for (const item of content.items as Array<{ str?: string }>) {
        const text = (item.str ?? "").trim();
        if (text.length > 0) {
          title = text;
          break;
        }
      }
    } catch {
      title = "";
    }
    page.cleanup();
    out.push({
      title: title.length > 0 ? title.slice(0, TITLE_MAX) : `Page ${pageNumber}`,
      page: pageNumber,
      depth: 0,
    });
  }
  return out;
}

export interface TocOptions {
  source: "bookmarks" | "pages";
  title: string;
  position: "start" | "end";
  fontSize: number;
  dotLeaders: boolean;
  addBookmarks: boolean;
}

export function resolveTocOptions(values: OptionValues): TocOptions {
  const titleRaw = typeof values.title === "string" ? values.title.trim() : "";
  const sizeRaw = Number(values.fontSize);
  return {
    source: values.source === "pages" ? "pages" : "bookmarks",
    title: titleRaw.length > 0 ? titleRaw.slice(0, 60) : "Table of Contents",
    position: values.position === "end" ? "end" : "start",
    fontSize:
      Number.isFinite(sizeRaw) && sizeRaw >= 8 && sizeRaw <= 14
        ? Math.round(sizeRaw)
        : 11,
    dotLeaders: values.dotLeaders !== false,
    addBookmarks: values.addBookmarks !== false,
  };
}

export interface TocRunResult {
  bytes: Uint8Array;
  entries: number;
  tocPages: number;
  pageCount: number;
}

/** Fit a title into `maxWidth`, appending an ellipsis when truncated. */
function fitTitle(
  text: string,
  maxWidth: number,
  measure: (s: string) => number
): string {
  let out = text;
  let w = measure(out);
  while (out.length > 4 && w > maxWidth) {
    out = `${out.slice(0, out.length - 2).trimEnd()}…`;
    w = measure(out);
  }
  return out;
}

/** The whole TOC build (plan → draw → bookmarks), smoke-testable without pdf.js. */
export async function buildTocFromEntries(
  pdfBytes: Uint8Array,
  entries: readonly TocEntry[],
  opts: TocOptions
): Promise<TocRunResult> {
  if (entries.length === 0) {
    throw new Error("toc.errorNoEntries");
  }

  // 2. PLAN — blank TOC page(s) sized like page 1, at start or end.
  let parsed: ReturnType<typeof parseForOrganize>;
  try {
    parsed = parseForOrganize(pdfBytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }
  const originalCount = parsed.pages.length;
  if (originalCount < 1) {
    throw new Error("tool.errorCorrupt");
  }
  const firstBox = parsed.pages[0]!.mediaBox;
  const tocW = firstBox[2] - firstBox[0];
  const tocH = firstBox[3] - firstBox[1];

  const margin = 56;
  const topReserve = 110; // heading + gap (first TOC page)
  const bottomReserve = 48;
  const lineHeight = opts.fontSize * 1.55;
  const linesFirst = Math.max(
    1,
    Math.floor((tocH - topReserve - bottomReserve) / lineHeight)
  );
  const linesRest = Math.max(
    1,
    Math.floor((tocH - margin - bottomReserve) / lineHeight)
  );
  const tocPages =
    entries.length <= linesFirst
      ? 1
      : 1 + Math.ceil((entries.length - linesFirst) / linesRest);

  const pageEntries: PlanEntry[] = [];
  for (let i = 0; i < originalCount; i += 1) {
    pageEntries.push({ kind: "page", src: i });
  }
  const blanks: PlanEntry[] = [];
  for (let i = 0; i < tocPages; i += 1) {
    blanks.push({ kind: "blank", width: tocW, height: tocH });
  }
  const plan: PlanEntry[] =
    opts.position === "start"
      ? [...blanks, ...pageEntries]
      : [...pageEntries, ...blanks];
  const withBlanks = organizePages(parsed, plan);
  // Physical page number of an original page after insertion.
  const shift = opts.position === "start" ? tocPages : 0;

  // 3. DRAW — heading + entries + dot leaders + numbers on the blanks.
  // Fonts FIRST (async embed), then every stamp is synchronous.
  const ctx = StampContext.load(withBlanks);
  const needsDeva =
    hasDevanagari(opts.title) || entries.some((e) => hasDevanagari(e.title));
  let deva: StampTtfFont | null = null;
  if (needsDeva) {
    deva = ctx.embedTtf(await loadDevanagariBytes());
  }

  const dotW = Math.max(ctx.measure(".", "helvetica", opts.fontSize), 4);
  const inkColor = { r: 0.13, g: 0.14, b: 0.16 };
  const headingColor = { r: 0.08, g: 0.09, b: 0.11 };
  const dotColor = { r: 0.55, g: 0.56, b: 0.6 };

  const drawPage = (t: number, start: number, end: number): void => {
    const page = ctx.pages[t]!;
    const left = page.mediaBox[0] + margin;
    const right =
      page.mediaBox[0] + (page.mediaBox[2] - page.mediaBox[0]) - margin;
    const topY =
      t === 0
        ? page.mediaBox[3] - topReserve + 56
        : page.mediaBox[3] - margin;
    let y =
      t === 0
        ? page.mediaBox[3] - topReserve - lineHeight * 0.78
        : page.mediaBox[3] - margin - lineHeight * 0.78;

    if (t === 0) {
      // Heading — Helvetica Bold 20, Devanagari route when needed.
      if (hasDevanagari(opts.title) && deva !== null) {
        ctx.stampText(t, {
          x: left,
          y: topY,
          text: opts.title,
          size: 20,
          color: headingColor,
          ttf: deva,
        });
      } else {
        const safe = latinSafe(opts.title);
        ctx.stampText(t, {
          x: left,
          y: topY,
          text: safe.length > 0 ? safe : "Table of Contents",
          size: 20,
          font: "helveticaBold",
          color: headingColor,
        });
      }
    }

    for (let i = start; i < end; i += 1) {
      const entry = entries[i]!;
      const indent = Math.min(entry.depth, MAX_DEPTH - 1) * 14;
      const numText = String(entry.page + shift);
      const numW = ctx.measure(numText, "helvetica", opts.fontSize);
      const numberX = right - numW;
      const maxTitleW = (right - left - indent - numW - 12) * 0.72;

      let titleText: string;
      let titleW: number;
      const entryDeva = hasDevanagari(entry.title) && deva !== null;
      if (entryDeva) {
        titleText = fitTitle(entry.title, maxTitleW, (s) =>
          (deva as StampTtfFont).measure(s, opts.fontSize)
        );
        titleW = (deva as StampTtfFont).measure(titleText, opts.fontSize);
      } else {
        const safe = latinSafe(entry.title);
        titleText = fitTitle(
          safe.length > 0 ? safe : `Page ${entry.page}`,
          maxTitleW,
          (s) => ctx.measure(s, "helvetica", opts.fontSize)
        );
        titleW = ctx.measure(titleText, "helvetica", opts.fontSize);
      }

      // Title.
      ctx.stampText(t, {
        x: left + indent,
        y,
        text: titleText,
        size: opts.fontSize,
        font: entryDeva ? undefined : "helvetica",
        color: inkColor,
        ...(entryDeva ? { ttf: deva as StampTtfFont } : {}),
      });

      // Dot leaders between title and number.
      if (opts.dotLeaders) {
        const dotsStart = left + indent + titleW + 6;
        const dots = Math.max(0, Math.floor((numberX - 4 - dotsStart) / dotW));
        if (dots > 0) {
          ctx.stampText(t, {
            x: dotsStart,
            y,
            text: ".".repeat(Math.min(dots, 250)),
            size: opts.fontSize,
            font: "helvetica",
            color: dotColor,
          });
        }
      }

      // Right-aligned page number.
      ctx.stampText(t, {
        x: numberX,
        y,
        text: numText,
        size: opts.fontSize,
        font: "helvetica",
        color: inkColor,
      });

      y -= lineHeight;
    }
  };

  let start = 0;
  for (let t = 0; t < tocPages; t += 1) {
    const capacity = t === 0 ? linesFirst : linesRest;
    const end = Math.min(entries.length, start + capacity);
    drawPage(t, start, end);
    start = end;
  }

  let bytes: Uint8Array;
  try {
    bytes = ctx.write();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      /encrypt/i.test(message) ? "tool.errorEncrypted" : "tool.errorCorrupt"
    );
  }

  // 4. NAV — the clickable bookmarks tree (bookmark-pdf engine).
  if (opts.addBookmarks) {
    const nodes = entries.map((entry) => ({
      id: `toc-${entry.page}-${entry.depth}`,
      title: entry.title,
      page: Math.min(entry.page + shift, originalCount + tocPages),
      children: [],
    }));
    bytes = writeOutline(bytes, [
      { id: "toc-root", title: opts.title, page: 1, children: nodes },
    ]).bytes;
  }

  return {
    bytes,
    entries: entries.length,
    tocPages,
    pageCount: originalCount + tocPages,
  };
}

/** The whole pipeline, smoke-testable without a Worker (pdf.js injected). */
export async function runTableOfContents(
  pdfBytes: Uint8Array,
  options: OptionValues,
  loadPdfjs: () => Promise<PdfjsModule>
): Promise<TocRunResult> {
  const opts = resolveTocOptions(options);

  // 1. READ — entries via pdf.js. NOTE: pdf.js DETACHES the buffer it is
  // handed (transferable), so it gets a COPY — the original bytes must
  // survive for the organize/stamp passes below.
  const pdfjs = await loadPdfjs();
  const reader = await pdfjs.getDocument({
    data: pdfBytes.slice(),
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;
  const entries =
    opts.source === "pages"
      ? await readPageEntries(reader)
      : await readBookmarkEntries(reader);
  await reader.destroy().catch(() => undefined);

  return buildTocFromEntries(pdfBytes, entries, opts);
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 6, stage: "reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  post({ type: "progress", runId, pct: 40, stage: "processing" });
  let result: TocRunResult;
  try {
    result = await runTableOfContents(bytes, options, loadPdfjsInWorker);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^toc\.|^tool\./.test(message)
      ? message
      : /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt";
    post({ type: "error", runId, code });
    return;
  }

  post({ type: "progress", runId, pct: 94, stage: "saving" });
  const outputs = [
    {
      name: `${safeBaseName(file.name)}-toc.pdf`,
      mime: "application/pdf",
      blob: new Blob([result.bytes as unknown as BlobPart], {
        type: "application/pdf",
      }),
    },
  ];
  post({
    type: "result",
    runId,
    outputs,
    detail: {
      files: 1,
      pages: result.pageCount,
      entries: result.entries,
      tocPages: result.tocPages,
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
