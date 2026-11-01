import { ComposeContext, PdfError } from "@/lib/own/pdf";
import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import { RenderPixelBudget } from "../pdfjs-common/pixel-budget";
import { detectSkewAngle, rgbaToGray } from "../ocr-pdf/engine";
import {
  type DeskewOptions,
  correctionFromDetection,
  deskewSheetOps,
  resolveDeskewOptions,
  rotateNorm,
} from "./engine";

/**
 * Deskew PDF worker (PHASE-7):
 *
 *   1. DETECT — pdf.js renders each selected page once at ~110 DPI and
 *      the ocr-pdf Hough-lite projection-profile engine reads the
 *      baseline tilt (median over agreeing strips).
 *   2. APPLY  — our own ComposeContext re-places every page as a Form
 *      XObject; tilted pages rotate about their centre (vectors — text
 *      and line art keep full quality, the raster was only a probe).
 *
 * Pages outside the selection pass through untouched (identity sheet),
 * so no page is ever lost. Own engine end to end. Never touches the
 * network.
 */

type PdfjsModule = typeof import("pdfjs-dist");

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

export interface DkProgress {
  pct: number;
  stage: "reading" | "processing" | "saving";
  detail?: { page: number; pages: number };
}

/** Detection raster target: ~110 DPI, capped at 1400 px on the long side. */
const DETECT_DPI = 110;
const DETECT_MAX_DIM = 1400;

export interface DkApplyResult {
  bytes: Uint8Array;
  pages: number;
  straightened: number;
  /** Per-page corrections actually applied (degrees, visual-CW-positive). */
  corrections: number[];
}

/**
 * Phase 2 — the vector rebuild. `corrections` is indexed by SOURCE page
 * index (0-based); 0 leaves the page 1:1. Pure own-engine, smoke-safe.
 */
export function applyDeskew(
  bytes: Uint8Array,
  corrections: readonly number[],
  sizing: "keep" | "grow"
): DkApplyResult {
  let ctx: ComposeContext;
  try {
    ctx = ComposeContext.load(bytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }
  if (ctx.pageCount < 1) {
    throw new Error("tool.errorCorrupt");
  }

  let straightened = 0;
  const applied: number[] = [];

  for (let i = 0; i < ctx.pageCount; i += 1) {
    const page = ctx.pages[i]!;
    const w = page.cropBox[2] - page.cropBox[0];
    const h = page.cropBox[3] - page.cropBox[1];
    const norm = rotateNorm(page.rotate);
    const swap = norm === 90 || norm === 270;
    const effW = swap ? h : w;
    const effH = swap ? w : h;

    const correction =
      i < corrections.length && Number.isFinite(corrections[i])
        ? corrections[i]!
        : 0;
    applied.push(correction);

    if (ctx.hasContents(i)) {
      const form = ctx.embedPage(i);
      const sheet = deskewSheetOps(
        { key: form.key, width: form.width, height: form.height },
        { w, h, rotate: page.rotate },
        correction,
        sizing
      );
      ctx.addSheet(sheet.w, sheet.h, sheet.ops, [i]);
      if (correction !== 0) straightened += 1;
    } else {
      // Legal empty page: a blank sheet of the visual size.
      ctx.addSheet(effW, effH, "", []);
    }
  }

  try {
    const saved = ctx.write();
    return { bytes: saved, pages: ctx.pageCount, straightened, corrections: applied };
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new Error("tool.errorEncrypted");
    }
    throw new Error("tool.errorCorrupt");
  }
}

/**
 * Phase 1 — the raster probe. Renders each selected page ONCE with
 * pdf.js and reads its baseline tilt. Returns a sparse map of source
 * page index → signed correction (visual-CW-positive, ocr-pdf
 * convention). Needs OffscreenCanvas — browser/E2E turf, not bun.
 */
export async function detectPageAngles(
  bytes: Uint8Array,
  pageNumbers: readonly number[],
  onProgress?: (progress: DkProgress) => void
): Promise<Map<number, number>> {
  // pdf.js DETACHES the buffer it is handed (R32 lesson) — probe a copy.
  const pdfjs: PdfjsModule = await loadPdfjsInWorker();
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;

  const out = new Map<number, number>();
  const budget = new RenderPixelBudget();

  try {
    for (let i = 0; i < pageNumbers.length; i += 1) {
      const pageNumber = pageNumbers[i]! + 1;
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(
        DETECT_DPI / 72,
        DETECT_MAX_DIM / Math.max(base.width, base.height)
      );
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.round(viewport.width));
      const height = Math.max(1, Math.round(viewport.height));

      if (!budget.tryConsume(width, height)) {
        page.cleanup();
        throw new Error("tool.errorRenderBudget");
      }

      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas-2d-unavailable");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      await page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      page.cleanup();

      const image = context.getImageData(0, 0, width, height);
      const gray = rgbaToGray(image.data);
      const detection = detectSkewAngle(gray, width, height);
      const correction = correctionFromDetection(detection.angle, detection.samples);
      if (correction !== 0) {
        out.set(pageNumbers[i]!, correction);
      }

      onProgress?.({
        pct: Math.round(8 + (47 * (i + 1)) / pageNumbers.length),
        stage: "processing",
        detail: { page: i + 1, pages: pageNumbers.length },
      });
    }
  } finally {
    doc.cleanup();
  }

  return out;
}

/** The whole pipeline, smoke-testable without a Worker PostMessage. */
export async function runDeskewPdf(
  bytes: Uint8Array,
  options: Record<string, unknown>,
  onProgress?: (progress: DkProgress) => void
): Promise<DkApplyResult & { selectedPages: number }> {
  const opts: DeskewOptions = resolveDeskewOptions(options);

  // Cheap pre-parse on our own engine first — honest corrupt/encrypted
  // errors before any raster work, and the real page count.
  const probe = ComposeContext.load(bytes);
  const total = probe.pageCount;
  const pageNumbers = parsePageSpec(opts.pages, total);
  if (pageNumbers === null || pageNumbers.length === 0) {
    throw new Error("tool.errorInvalidPages");
  }

  onProgress?.({ pct: 6, stage: "reading" });
  const angles = await detectPageAngles(bytes, pageNumbers, onProgress);

  onProgress?.({ pct: 58, stage: "processing" });
  const corrections = new Array<number>(total).fill(0);
  for (const [index, angle] of angles) {
    corrections[index] = angle;
  }
  const result = applyDeskew(bytes, corrections, opts.sizing);
  return { ...result, selectedPages: pageNumbers.length };
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 4, stage: "reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  let result: Awaited<ReturnType<typeof runDeskewPdf>>;
  try {
    result = await runDeskewPdf(bytes, options, (progress) => {
      post({ type: "progress", runId, ...progress });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^tool\./.test(message)
      ? message
      : /encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt";
    post({ type: "error", runId, code });
    return;
  }

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  const outputs = [
    {
      name: `${safeBaseName(file.name)}-deskewed.pdf`,
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
      pages: result.pages,
      straightenedPages: result.straightened,
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
