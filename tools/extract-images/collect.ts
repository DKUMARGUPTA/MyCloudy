import type { PDFDocumentProxy } from "pdfjs-dist";

import { imageKey } from "./engine";

/**
 * Extract PDF images — the pdf.js operator-list walk shared by the pool
 * worker and the read-only surface probe. The walk itself is pure logic
 * over (lib.OPS, doc, pools); the bun smoke drives it against a synthetic
 * document (same contract, no pdf.js needed), while the real pdf.js path
 * is exercised in-browser by the orchestrator's agent-browser QA.
 *
 * For every page the operator list is scanned for the four image-painting
 * operators; named XObjects resolve through `page.objs` (per-page pool) or
 * `page.commonObjs` (the "g_"-prefixed globals shared across pages), inline
 * images carry their payload directly in the operator arguments. The
 * callback form of `PDFObjects.get` is used so late-arriving decodes are
 * awaited naturally, and `null` payloads (decode failures) are skipped the
 * same way the pdf.js canvas would warn-and-skip them.
 *
 * Dedupe: the same named XObject painted on many pages (or many times on
 * one page — the optimizer folds repeats into paintImageXObjectRepeat)
 * yields exactly ONE detection, attributed to its first paint. Selection
 * ordinals count EVERY image op on a page (before any size filtering), so
 * the surface probe and the worker run derive identical keys
 * (F<file>-P<page>-I<ordinal>).
 */

/** pdf.js module namespace shape this walk needs (works for legacy too). */
export interface PdfjsWalkLib {
  OPS: {
    paintImageXObject: number;
    paintImageXObjectRepeat: number;
    paintInlineImageXObject: number;
    paintInlineImageXObjectGroup: number;
  };
}

/** Minimal pool surface (pdf.js PDFObjects, callback form). */
export interface ObjsPool {
  get(objId: string, callback: (data: unknown) => void): null;
}

/** One accepted image detection (bitmap OR raw kind/data payload). */
export interface RawImage {
  /** Stable selection key: F<fileIndex>-P<page>-I<ordinal>. */
  key: string;
  /** 1-based page number of the first paint. */
  page: number;
  /** nth image op on that page (pre-filter, 1-based). */
  ordinal: number;
  width: number;
  height: number;
  /** pdf.js ImageKind (0 when the bitmap path applies). */
  kind: number;
  /** Decoded ImageBitmap form (browsers with OffscreenCanvas support). */
  bitmap: ImageBitmap | null;
  /** Raw data form (no-OffscreenCanvas environments, inline images). */
  data: Uint8Array | Uint8ClampedArray | null;
}

export interface CollectHooks {
  /** Page progress (1-based page, page count of the document). */
  onPage?: (page: number, pages: number) => void;
  /**
   * Streaming sink — called once per accepted (deduped) detection in page
   * order. May be async; the walk waits, so at most one image payload is
   * being consumed at a time (memory stays flat on scanned PDFs).
   */
  onImage?: (image: RawImage) => void | Promise<void>;
  /** Cooperative cancel — checked between pages and before each resolve. */
  shouldStop?: () => boolean;
  /** Probe limit: stop after this many pages (0/undefined = all). */
  maxPages?: number;
  /** Probe limit: stop after this many accepted detections. */
  maxImages?: number;
}

export interface CollectStats {
  pagesProbed: number;
  accepted: number;
  truncated: boolean;
}

interface PdfImageObj {
  width?: unknown;
  height?: unknown;
  kind?: unknown;
  bitmap?: unknown;
  data?: unknown;
}

interface PdfPageLike {
  objs: ObjsPool;
  commonObjs: ObjsPool;
}

interface OperatorListLike {
  fnArray: number[];
  argsArray: unknown[][];
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isBytes(value: unknown): value is Uint8Array | Uint8ClampedArray {
  return (
    value instanceof Uint8Array || value instanceof Uint8ClampedArray
  );
}

/** Await a (possibly late) named object from its pool; null on failure. */
function resolveObj(pool: ObjsPool, objId: string): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    pool.get(objId, (data: unknown) => resolve(data));
  });
}

function poolFor(page: PdfPageLike, objId: string): ObjsPool {
  return objId.startsWith("g_") ? page.commonObjs : page.objs;
}

/** Validate + normalize a decoded pdf.js image payload, or null. */
function toRawImage(
  key: string,
  page: number,
  ordinal: number,
  obj: PdfImageObj | null
): RawImage | null {
  if (obj === null || typeof obj !== "object") return null;
  const width = obj.width;
  const height = obj.height;
  if (!isPositiveInt(width) || !isPositiveInt(height)) return null;
  // Guard against absurd sizes before any pixel work happens.
  if (width > 16384 || height > 16384) return null;
  if (obj.bitmap != null) {
    return {
      key,
      page,
      ordinal,
      width,
      height,
      kind: 0,
      bitmap: obj.bitmap as ImageBitmap,
      data: null,
    };
  }
  if (isBytes(obj.data)) {
    const kind =
      typeof obj.kind === "number" && Number.isInteger(obj.kind)
        ? obj.kind
        : 0;
    return {
      key,
      page,
      ordinal,
      width,
      height,
      kind,
      bitmap: null,
      data: obj.data,
    };
  }
  return null;
}

/**
 * Walk every page of `doc` (1..numPages in order) and stream accepted
 * image detections to `hooks.onImage`. Never throws for per-image decode
 * failures — those resolve as null and are skipped, exactly like the
 * pdf.js renderer does.
 */
export async function collectImages(
  lib: PdfjsWalkLib,
  doc: PDFDocumentProxy,
  fileIndex: number,
  hooks: CollectHooks
): Promise<CollectStats> {
  const seenIds = new Set<string>();
  const pages = doc.numPages;
  const pageLimit = hooks.maxPages && hooks.maxPages > 0
    ? Math.min(pages, hooks.maxPages)
    : pages;
  let accepted = 0;
  let truncated = false;

  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    if (pageNumber > pageLimit) {
      truncated = true;
      break;
    }
    if (hooks.shouldStop?.()) return { pagesProbed: pageNumber - 1, accepted, truncated };

    const page = (await doc.getPage(pageNumber)) as unknown as {
      getOperatorList(): Promise<OperatorListLike>;
    } & PdfPageLike;
    const ops = await page.getOperatorList();
    hooks.onPage?.(pageNumber, pages);

    let ordinal = 0;
    const fnArray = ops.fnArray;
    const argsArray = ops.argsArray;
    for (let i = 0; i < fnArray.length; i += 1) {
      if (hooks.shouldStop?.()) {
        return { pagesProbed: pageNumber, accepted, truncated };
      }
      const fn = fnArray[i];
      const args = argsArray[i] ?? [];
      if (
        fn === lib.OPS.paintImageXObject ||
        fn === lib.OPS.paintImageXObjectRepeat
      ) {
        ordinal += 1;
        const objId = args[0];
        if (typeof objId !== "string" || objId === "") continue;
        if (seenIds.has(objId)) continue; // dedupe across pages/paints
        seenIds.add(objId);
        if (hooks.maxImages && hooks.maxImages > 0 && accepted >= hooks.maxImages) {
          truncated = true;
          break;
        }
        const obj = (await resolveObj(poolFor(page, objId), objId)) as
          | PdfImageObj
          | null;
        const raw = toRawImage(
          imageKey(fileIndex, pageNumber, ordinal),
          pageNumber,
          ordinal,
          obj
        );
        if (raw) {
          accepted += 1;
          await hooks.onImage?.(raw);
        }
      } else if (
        fn === lib.OPS.paintInlineImageXObject ||
        fn === lib.OPS.paintInlineImageXObjectGroup
      ) {
        ordinal += 1;
        // Inline payloads live in the operator args themselves.
        const obj = (args[0] ?? null) as PdfImageObj | null;
        if (hooks.maxImages && hooks.maxImages > 0 && accepted >= hooks.maxImages) {
          truncated = true;
          break;
        }
        const raw = toRawImage(
          imageKey(fileIndex, pageNumber, ordinal),
          pageNumber,
          ordinal,
          obj
        );
        if (raw) {
          accepted += 1;
          await hooks.onImage?.(raw);
        }
      }
    }
  }

  return { pagesProbed: Math.min(pages, pageLimit), accepted, truncated };
}
