import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

import type {
  WorkerRunRequest,
  WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import { loadStampFonts } from "../stamp-common/worker-lib";
import { blockScript } from "../txt-to-pdf/text-layout";
import {
  PIXEL_THRESHOLD,
  buildPairSims,
  buildReportLines,
  classifyCompareError,
  classifyPair,
  diffWordStats,
  groupHunks,
  joinPageText,
  MAX_HUNKS,
  pairPages,
  pixelDiff,
  resolveCompareOptions,
  wordDiff,
  type PagePair,
  type PairStatus,
  type RawTextItem,
  type ReportHunkLine,
  type ReportPairLine,
  type TextHunk,
} from "./engine";

/**
 * Compare PDFs worker (PRD §8.5). pdf.js runs IN THIS WORKER (fake-worker
 * mode via the shared pdfjs-common shim, OffscreenCanvas for rendering —
 * the rasterize/cts recipe, INCLUDING the pinned cleanup()-not-destroy()
 * rule for docs whose pages were rendered).
 *
 * The run writes ONE self-contained report PDF:
 *   page 1..n   English text — summary, the page-pair table and the
 *               text change list (red − / green + lines), Helvetica with
 *               the self-hosted Noto Devanagari embedded only when a
 *               line needs it (per-line script decision, txt-to-pdf
 *               recipe — Hindi file names and hunks render correctly);
 *   then         one page per changed pair: the red/green/purple overlay
 *               render (100 DPI, JPEG q0.85) or, for added/removed
 *               pages, the page itself with a colored frame.
 *
 * The interactive side-by-side / overlay / text views live in the
 * workspace surface; this report is the exportable record. Everything
 * stays on the device — files arrive by structured clone, the Blob goes
 * back the same way.
 */

/** Report render DPI (both files must land on the same pixel grid). */
const RENDER_DPI = 100;
/** Per-image pixel clamp — poster pages downscale to stay memory-safe. */
const MAX_IMAGE_PIXELS = 8_000_000;
/** Honest cap on embedded overlay images. */
const MAX_IMAGE_PAIRS = 60;
/** Overlay JPEG quality. */
const JPEG_QUALITY = 0.85;

/** A4 portrait, pdf-lib points. */
const PAGE_W = 595.3;
const PAGE_H = 841.9;
const MARGIN = 46;
const TEXT_SIZE = 9;
const LINE_H = 13.4;

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function clampedRenderScale(
  baseW: number,
  baseH: number
): number {
  const want = RENDER_DPI / 72;
  if (baseW * baseH * want * want <= MAX_IMAGE_PIXELS) return want;
  return Math.sqrt(MAX_IMAGE_PIXELS / (baseW * baseH));
}

type PdfjsDoc = PDFDocumentProxy;
type PdfjsPage = PDFPageProxy;

/** Blit raw RGBA pixels onto a 2d context (ImageData-safe for TS). */
function putPixels(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  pixels: Uint8ClampedArray,
  w: number,
  h: number
): void {
  const image = ctx.createImageData(w, h);
  image.data.set(pixels);
  ctx.putImageData(image, 0, 0);
}

/** Render one page onto an OffscreenCanvas of EXACTLY w×h pixels. */
async function renderToExact(
  page: PdfjsPage,
  w: number,
  h: number
): Promise<OffscreenCanvas> {
  const base = page.getViewport({ scale: 1 });
  const scale = clampedRenderScale(base.width, base.height);
  const viewport = page.getViewport({ scale });
  const rawW = Math.max(1, Math.round(viewport.width));
  const rawH = Math.max(1, Math.round(viewport.height));
  const canvas = new OffscreenCanvas(rawW, rawH);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("compare-render: 2d-unavailable");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, rawW, rawH);
  await page.render({
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;
  page.cleanup();
  if (rawW === w && rawH === h) return canvas;
  // Different page grids (page size/rotation differs) — stretch onto the
  // original's grid so pixelDiff gets two same-size buffers.
  const target = new OffscreenCanvas(w, h);
  const targetCtx = target.getContext("2d");
  if (!targetCtx) throw new Error("compare-render: 2d-unavailable");
  targetCtx.fillStyle = "#ffffff";
  targetCtx.fillRect(0, 0, w, h);
  targetCtx.drawImage(canvas, 0, 0, w, h);
  return target;
}

interface DocBundle {
  texts: string[];
  doc: PdfjsDoc;
}

async function extractTexts(
  pdfjs: Awaited<ReturnType<typeof loadPdfjsInWorker>>,
  data: Uint8Array,
  onProgress: (page: number, pages: number) => void
): Promise<DocBundle> {
  const doc = await pdfjs.getDocument({
    data,
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;
  const texts: string[] = [];
  for (let page = 1; page <= doc.numPages; page += 1) {
    const pdfPage = await doc.getPage(page);
    const content = await pdfPage.getTextContent();
    pdfPage.cleanup();
    texts.push(joinPageText(content.items as RawTextItem[]));
    onProgress(page, doc.numPages);
  }
  return { texts, doc };
}

interface PairReport {
  pair: PagePair;
  status: PairStatus;
  sim: number;
  removedWords: number;
  addedWords: number;
  hunks: TextHunk[];
}

function wordStatsToReport(
  pairIndex: number,
  pair: PagePair,
  status: PairStatus,
  sim: number,
  stats: { removed: number; added: number },
  hunks: TextHunk[]
): ReportPairLine {
  return {
    pairIndex,
    a: pair.a,
    b: pair.b,
    status,
    sim,
    removedWords: stats.removed,
    addedWords: stats.added,
    changedRatio: null,
  };
}

/* ------------------------------------------------------------------ */
/* Text layout for the report pages                                    */
/* ------------------------------------------------------------------ */

interface Fonts {
  helv: PDFFont;
  noto: PDFFont | null;
}

/** Greedy word-wrap of one report line (per-line script font). */
function wrapLine(
  line: string,
  fonts: Fonts,
  maxWidth: number
): { text: string; noto: boolean }[] {
  if (line.length === 0) return [];
  const noto = fonts.noto !== null && blockScript(line) === "noto";
  const font = noto ? fonts.noto : fonts.helv;
  const measure = (s: string): number =>
    (font ?? fonts.helv).widthOfTextAtSize(s, TEXT_SIZE);
  const words = line.split(" ");
  const out: { text: string; noto: boolean }[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (measure(candidate) <= maxWidth || current.length === 0) {
      current = candidate;
    } else {
      out.push({ text: current, noto });
      current = word;
    }
  }
  if (current.length > 0) out.push({ text: current, noto });
  return out;
}

/** Lay report text lines onto fresh pages; returns the pages used. */
function writeTextPages(
  pdf: PDFDocument,
  lines: string[],
  fonts: Fonts
): number {
  const usableW = PAGE_W - 2 * MARGIN;
  const usableH = PAGE_H - 2 * MARGIN;
  const maxLines = Math.floor(usableH / LINE_H);
  let page: PDFPage | null = null;
  let lineCursor = maxLines; // force a fresh page on the first real line
  const ensureRoom = (): PDFPage => {
    if (page === null || lineCursor >= maxLines) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      lineCursor = 0;
    }
    return page;
  };
  for (const raw of lines) {
    if (raw.length === 0) {
      // Blank separator line: one line slot, no glyph.
      ensureRoom();
      lineCursor += 1;
      continue;
    }
    const wrapped = wrapLine(raw, fonts, usableW);
    for (const piece of wrapped) {
      const page = ensureRoom();
      const font = piece.noto && fonts.noto ? fonts.noto : fonts.helv;
      page.drawText(piece.text, {
        x: MARGIN,
        y: PAGE_H - MARGIN - TEXT_SIZE - lineCursor * LINE_H,
        size: TEXT_SIZE,
        font,
        color: rgb(0.13, 0.13, 0.15),
      });
      lineCursor += 1;
    }
  }
  return pdf.getPageCount();
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  if (files.length !== 2) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const opts = resolveCompareOptions(options);

  post({ type: "progress", runId, pct: 3, stage: "reading" });
  const pdfjs = await loadPdfjsInWorker();

  const dataA = new Uint8Array(await files[0].arrayBuffer());
  const dataB = new Uint8Array(await files[1].arrayBuffer());

  const totalTextPages = (doc: PdfjsDoc): number => doc.numPages;
  let bundleA: DocBundle | null = null;
  let bundleB: DocBundle | null = null;
  try {
    bundleA = await extractTexts(pdfjs, dataA, (page, pages) => {
      post({
        type: "progress",
        runId,
        pct: Math.round(4 + (page / pages) * 16),
        stage: "reading",
        detail: { page, pages },
      });
    });
    bundleB = await extractTexts(pdfjs, dataB, (page, pages) => {
      post({
        type: "progress",
        runId,
        pct: Math.round(20 + (page / pages) * 16),
        stage: "reading",
        detail: { page, pages },
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: "error", runId, code: classifyCompareError(message) });
    return;
  }

  post({ type: "progress", runId, pct: 38, stage: "processing" });
  const prep = {
    ignoreCase: opts.ignoreCase,
    ignoreWhitespace: opts.ignoreWhitespace,
  };
  const sims = buildPairSims(bundleA.texts, bundleB.texts, prep);
  const plan = pairPages(
    bundleA.texts.length,
    bundleB.texts.length,
    (i, j) => sims[i][j],
    opts.mapping
  );

  const pairReports: PairReport[] = [];
  const hunkLines: ReportHunkLine[] = [];
  let hunksCapped = false;
  for (let index = 0; index < plan.pairs.length; index += 1) {
    const pair = plan.pairs[index];
    if (pair.kind === "added" || pair.kind === "removed") {
      const status: PairStatus = pair.kind === "added" ? "added" : "removed";
      // The whole page's text is one honest hunk (capped).
      const text =
        pair.kind === "added"
          ? bundleB.texts[(pair.b ?? 1) - 1]
          : bundleA.texts[(pair.a ?? 1) - 1];
      if (hunkLines.length < MAX_HUNKS) {
        const short =
          text.length > 600 ? `${text.slice(0, 600).trim()}…` : text;
        hunkLines.push({
          a: pair.a,
          b: pair.b,
          hunk: {
            kind: pair.kind === "added" ? "add" : "del",
            before: pair.kind === "removed" ? short : "",
            after: pair.kind === "added" ? short : "",
          },
        });
      } else {
        hunksCapped = true;
      }
      pairReports.push({
        pair,
        status,
        sim: 0,
        removedWords: pair.kind === "removed" ? text.split(/\s+/).filter(Boolean).length : 0,
        addedWords: pair.kind === "added" ? text.split(/\s+/).filter(Boolean).length : 0,
        hunks: [],
      });
      continue;
    }
    const sim = sims[(pair.a ?? 1) - 1][(pair.b ?? 1) - 1];
    const status = classifyPair(pair, sim, opts.sensitivity);
    if (status === "equal") {
      pairReports.push({
        pair,
        status,
        sim,
        removedWords: 0,
        addedWords: 0,
        hunks: [],
      });
      continue;
    }
    const diff = wordDiff(
      bundleA.texts[(pair.a ?? 1) - 1],
      bundleB.texts[(pair.b ?? 1) - 1],
      prep
    );
    const stats = diffWordStats(diff.ops);
    const hunks = groupHunks(diff.ops);
    for (const hunk of hunks) {
      if (hunkLines.length >= MAX_HUNKS) {
        hunksCapped = true;
        break;
      }
      hunkLines.push({ a: pair.a, b: pair.b, hunk });
    }
    pairReports.push({
      pair,
      status,
      sim,
      removedWords: stats.removed,
      addedWords: stats.added,
      hunks,
    });
  }

  post({ type: "progress", runId, pct: 48, stage: "processing" });

  /* ---------------- report assembly ---------------- */

  const reportPairs: ReportPairLine[] = pairReports.map((item, index) =>
    wordStatsToReport(
      index,
      item.pair,
      item.status,
      item.sim,
      { removed: item.removedWords, added: item.addedWords },
      item.hunks
    )
  );

  // Decide which pairs get an image page (changed + added/removed, capped).
  const imageCandidates = pairReports
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status !== "equal");
  const imagePairs = imageCandidates.slice(0, MAX_IMAGE_PAIRS);
  const imagesCapped = imageCandidates.length > imagePairs.length;

  const lines = buildReportLines({
    aName: files[0].name,
    bName: files[1].name,
    aPages: totalTextPages(bundleA.doc),
    bPages: totalTextPages(bundleB.doc),
    options: opts,
    pairs: reportPairs,
    hunks: hunkLines,
    hunksCapped,
    imagesCapped,
  });

  const pdf = await PDFDocument.create();
  pdf.setTitle("PDF comparison report");
  pdf.setProducer("DocoPDF compare-pdf");
  pdf.setCreator("DocoPDF (on-device)");
  const needNoto = lines.some(
    (line) => blockScript(line) === "noto"
  );
  const stampFonts = await loadStampFonts(pdf, needNoto);
  const fonts: Fonts = {
    helv: stampFonts.fontFor("helvetica"),
    noto: needNoto ? stampFonts.fontFor("devanagari") : null,
  };

  writeTextPages(pdf, lines, fonts);
  const textPageCount = pdf.getPageCount();
  void textPageCount;

  post({ type: "progress", runId, pct: 52, stage: "processing" });

  /* ---------------- image pages ---------------- */

  let rendered = 0;
  for (const { item, index } of imagePairs) {
    const pair = item.pair;
    let pageA: PdfjsPage | null = null;
    let pageB: PdfjsPage | null = null;
    try {
      const page = pdf.addPage([PAGE_W, PAGE_H]);
      const caption =
        pair.a === null
          ? `Pair ${index + 1} - new in the revised (p${pair.b})`
          : pair.b === null
            ? `Pair ${index + 1} - removed from the original (p${pair.a})`
            : `Pair ${index + 1} - original p${pair.a} vs revised p${pair.b}`;
      const detail =
        pair.kind === "both"
          ? `${Math.round(item.sim * 100)}% alike - words ${item.removedWords} removed / ${item.addedWords} added - red = removed, green = added, purple = modified`
          : pair.kind === "added"
            ? "present only in the revised file (green frame)"
            : "present only in the original file (red frame)";
      page.drawText(caption, {
        x: MARGIN,
        y: PAGE_H - MARGIN - TEXT_SIZE,
        size: TEXT_SIZE + 1,
        font: fonts.helv,
        color: rgb(0.1, 0.1, 0.12),
      });
      page.drawText(detail, {
        x: MARGIN,
        y: PAGE_H - MARGIN - 2.4 * LINE_H,
        size: TEXT_SIZE - 0.5,
        font: fonts.helv,
        color: rgb(0.42, 0.42, 0.46),
      });

      if (pair.kind === "both") {
        pageA = await bundleA.doc.getPage(pair.a as number);
        pageB = await bundleB.doc.getPage(pair.b as number);
        const base = pageA.getViewport({ scale: 1 });
        const scale = clampedRenderScale(base.width, base.height);
        const w = Math.max(1, Math.round(base.width * scale));
        const h = Math.max(1, Math.round(base.height * scale));
        const canvasA = await renderToExact(pageA, w, h);
        const canvasB = await renderToExact(pageB, w, h);
        const ctxA = canvasA.getContext("2d");
        const ctxB = canvasB.getContext("2d");
        if (ctxA === null || ctxB === null) {
          throw new Error("compare-render: 2d-unavailable");
        }
        const dataA2 = ctxA.getImageData(0, 0, w, h).data;
        const dataB2 = ctxB.getImageData(0, 0, w, h).data;
        const outcome = pixelDiff(
          dataA2,
          dataB2,
          PIXEL_THRESHOLD[opts.sensitivity]
        );
        putPixels(ctxA, outcome.out, w, h);
        const blob = await canvasA.convertToBlob({
          type: "image/jpeg",
          quality: JPEG_QUALITY,
        });
        const image = await pdf.embedJpg(
          new Uint8Array(await blob.arrayBuffer())
        );
        const maxW = PAGE_W - 2 * MARGIN;
        const maxH = PAGE_H - 2 * MARGIN - 3 * LINE_H;
        const fit = Math.min(maxW / image.width, maxH / image.height);
        const drawW = image.width * fit;
        const drawH = image.height * fit;
        page.drawImage(image, {
          x: (PAGE_W - drawW) / 2,
          y: (PAGE_H - 3 * LINE_H - drawH) / 2 + LINE_H,
          width: drawW,
          height: drawH,
        });
      } else {
        const source =
          pair.kind === "added" ? bundleB.doc : bundleA.doc;
        const num = (pair.kind === "added" ? pair.b : pair.a) as number;
        const pdfPage = await source.getPage(num);
        const base = pdfPage.getViewport({ scale: 1 });
        const scale = clampedRenderScale(base.width, base.height);
        const canvas = await renderToExact(
          pdfPage,
          Math.max(1, Math.round(base.width * scale)),
          Math.max(1, Math.round(base.height * scale))
        );
        const blob = await canvas.convertToBlob({
          type: "image/jpeg",
          quality: JPEG_QUALITY,
        });
        const image = await pdf.embedJpg(
          new Uint8Array(await blob.arrayBuffer())
        );
        const maxW = PAGE_W - 2 * MARGIN - 8;
        const maxH = PAGE_H - 2 * MARGIN - 3 * LINE_H - 8;
        const fit = Math.min(maxW / image.width, maxH / image.height);
        const drawW = image.width * fit;
        const drawH = image.height * fit;
        const x = (PAGE_W - drawW) / 2;
        const y = (PAGE_H - 3 * LINE_H - drawH) / 2 + LINE_H;
        page.drawImage(image, { x, y, width: drawW, height: drawH });
        page.drawRectangle({
          x: x - 2,
          y: y - 2,
          width: drawW + 4,
          height: drawH + 4,
          borderColor:
            pair.kind === "added"
              ? rgb(0.16, 0.63, 0.31)
              : rgb(0.87, 0.2, 0.2),
          borderWidth: 2.5,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      post({
        type: "error",
        runId,
        code: classifyCompareError(message),
      });
      return;
    } finally {
      pageA?.cleanup();
      pageB?.cleanup();
    }
    rendered += 1;
    post({
      type: "progress",
      runId,
      pct: Math.round(52 + (rendered / imagePairs.length) * 44),
      stage: "processing",
    });
  }

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  const bytes = await pdf.save();

  post({
    type: "result",
    runId,
    outputs: [
      {
        name: "compare-report.pdf",
        mime: "application/pdf",
        blob: new Blob([bytes as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: 2, pages: plan.pairs.length },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: "error", runId: data.runId, code: classifyCompareError(message) });
  });
};
