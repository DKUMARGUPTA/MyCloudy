"use client";

import type { PDFDocumentProxy } from "pdfjs-dist";

import { loadPdfjs } from "@/lib/pdf/pdfjs";

import {
  type FieldSpec,
  type LineSeg,
  type TextItemBox,
  classifyRect,
  labelForRect,
  lineToSpecRect,
  mergeLineSegments,
  pdfRectToDisplay,
  uniqueName,
  type PageView,
} from "./engine";

/**
 * Make PDF fillable — detection half (pdf.js-dependent, main thread).
 *
 * Walks each page's operator list (pdf.js `getOperatorList`) and collects:
 *
 *  - OPS.constructPath rectangles → checkbox / text-box candidates
 *    (classifyRect decides; decoration falls through).
 *  - OPS.constructPath horizontal moveTo→lineTo runs → underline
 *    candidates (merged across gaps for dashed/dotted rules).
 *
 * Then walks the text layer (`getTextContent`) and names every candidate
 * after the closest label ("Full Name:" → "Full Name").
 *
 * Everything runs on the user's device; the operator list is parsed in
 * page order with progress callbacks so the surface can show a spinner.
 */

/** Detection tuning: max pages scanned (honest guard — forms are small). */
export const MAX_DETECT_PAGES = 100;

export interface DetectProgress {
  page: number;
  pages: number;
}

export interface DetectResult {
  specs: FieldSpec[];
  /** pdf.js page.view per page (x0, y0, x1, y1) + /Rotate — the surface
   *  uses these for display transforms and the worker for clamping. */
  pageViews: PageView[];
  existingCount: number;
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `d${Date.now().toString(36)}${seq.toString(36)}`;
}

/** Normalise /Rotate to 0/90/180/270 like pdf.js does. */
function normalizeRotate(rotate: number): number {
  const r = ((rotate % 360) + 360) % 360;
  return r === 90 || r === 180 || r === 270 ? r : 0;
}

interface RawPath {
  rects: { x: number; y: number; w: number; h: number }[];
  hLines: LineSeg[];
}

interface PdfjsOps {
  constructPath: number;
  rectangle: number;
  moveTo: number;
  lineTo: number;
  curveTo: number;
  curveTo2: number;
  curveTo3: number;
  closePath: number;
}

/**
 * Pull rectangles + horizontal lines out of one page's operator list.
 * constructPath args = [pathOps, coords, minMax]; path ops use the same
 * OPS enum codes as the fnArray and coords are UNTRANSFORMED user-space
 * values (the canvas CTM applies at render time), so they map 1:1 onto
 * pdf-lib's coordinate space.
 */
async function harvestPath(
  page: { getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }> },
  ops: PdfjsOps
): Promise<RawPath> {
  const opList = await page.getOperatorList();
  const out: RawPath = { rects: [], hLines: [] };

  for (let i = 0; i < opList.fnArray.length; i += 1) {
    if (opList.fnArray[i] !== ops.constructPath) continue;
    const args = opList.argsArray[i];
    if (!Array.isArray(args)) continue;
    const pathOps = args[0] as unknown[] | undefined;
    const coords = args[1] as ArrayLike<number> | undefined;
    if (!pathOps || !coords) continue;

    let ci = 0;
    let cursor: { x: number; y: number } | null = null;
    for (const op of pathOps) {
      if (op === ops.rectangle) {
        const x = coords[ci];
        const y = coords[ci + 1];
        const w = coords[ci + 2];
        const h = coords[ci + 3];
        ci += 4;
        cursor = null;
        if (
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          Number.isFinite(w) &&
          Number.isFinite(h)
        ) {
          out.rects.push({ x, y, w, h });
        }
      } else if (op === ops.moveTo) {
        const x = coords[ci];
        const y = coords[ci + 1];
        ci += 2;
        cursor = { x, y };
      } else if (op === ops.lineTo) {
        const x = coords[ci];
        const y = coords[ci + 1];
        ci += 2;
        if (cursor !== null) {
          // Horizontal segments only (|dy| < 1.5pt), any length.
          if (Math.abs(y - cursor.y) < 1.5) {
            out.hLines.push({ x1: cursor.x, x2: x, y });
          }
        }
        cursor = { x, y };
      } else if (op === ops.closePath) {
        cursor = null;
      } else if (
        op === ops.curveTo ||
        op === ops.curveTo2 ||
        op === ops.curveTo3
      ) {
        // curveTo consumes 6 coords; curveTo2/3 consume 4 each.
        ci += op === ops.curveTo ? 6 : 4;
        cursor = null;
      }
    }
  }
  return out;
}

/** Text layer items → boxes for label matching. */
async function harvestText(
  page: {
    getTextContent: () => Promise<{ items: unknown[] }>;
  }
): Promise<TextItemBox[]> {
  const content = await page.getTextContent();
  const items: TextItemBox[] = [];
  for (const rawItem of content.items) {
    const raw = rawItem as {
      str?: string;
      transform?: number[];
      width?: number;
      height?: number;
    };
    if (typeof raw.str !== "string" || raw.str.trim().length === 0) continue;
    const tr = raw.transform;
    if (!tr || tr.length < 6) continue;
    const height =
      typeof raw.height === "number"
        ? Math.abs(raw.height)
        : Math.abs(tr[3]) || 10;
    const items0 = {
      str: raw.str,
      x1: tr[4],
      y1: tr[5],
      x2: tr[4] + (typeof raw.width === "number" ? raw.width : 0),
      y2: tr[5] + height,
    };
    items.push(items0);
  }
  return items;
}

/** pdf.js page proxy shape used by the walker (loose on purpose). */
interface PageLike {
  view: number[];
  rotate: number;
  cleanup: () => void;
  getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  getTextContent: () => Promise<{ items: unknown[] }>;
  getAnnotations: (params?: { intent?: string }) => Promise<
    { subtype?: string }[]
  >;
}

/**
 * Detect field candidates across the whole document.
 * Main-thread only (pdf.js owns its own worker pool).
 */
export async function detectFields(
  file: File,
  onProgress?: (p: DetectProgress) => void
): Promise<DetectResult> {
  const pdfjs = await loadPdfjs();
  const ops: PdfjsOps = (pdfjs as unknown as { OPS: PdfjsOps }).OPS;
  const data = new Uint8Array(await file.arrayBuffer());
  const doc: PDFDocumentProxy = await pdfjs.getDocument({
    data,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;

  const pageCount = Math.min(doc.numPages, MAX_DETECT_PAGES);
  const pageViews: PageView[] = [];
  const taken = new Set<string>();
  const specs: FieldSpec[] = [];
  let autoIndex = 0;

  let existingCount = 0;

  for (let p = 1; p <= pageCount; p += 1) {
    const page = (await doc.getPage(p)) as unknown as PageLike;
    const rawView = page.view;
    const view: PageView = {
      x0: rawView[0] ?? 0,
      y0: rawView[1] ?? 0,
      x1: rawView[2] ?? 612,
      y1: rawView[3] ?? 792,
      rotate: normalizeRotate(page.rotate ?? 0),
    };
    pageViews.push(view);

    try {
      const annots = await page.getAnnotations({ intent: "display" });
      for (const a of annots) {
        if (a.subtype === "Widget") existingCount += 1;
      }
    } catch {
      // Damaged annotations — detection continues.
    }

    const [raw, textItems] = await Promise.all([
      harvestPath(page, ops),
      harvestText(page),
    ]);

    const pageIndex = p - 1;

    // 1) Underlines → text fields (merged across dashes first).
    const lines = mergeLineSegments(raw.hLines);
    for (const seg of lines) {
      const rect = lineToSpecRect(seg);
      const label = labelForRect(rect, textItems, "text");
      autoIndex += 1;
      specs.push({
        id: nextId(),
        page: pageIndex,
        ...rect,
        kind: "text",
        name: uniqueName(label ?? `Text ${autoIndex}`, taken),
        enabled: true,
      });
    }

    // 2) Rectangles → checkboxes / text boxes.
    for (const rect of raw.rects) {
      const kind = classifyRect(rect.w, rect.h);
      if (kind === null) continue;
      const box = {
        x: Math.min(rect.x, rect.x + rect.w),
        y: Math.min(rect.y, rect.y + rect.h),
        w: Math.abs(rect.w),
        h: Math.abs(rect.h),
      };
      if (kind === "textbox") {
        // Skip rects that duplicate a merged underline field (box + line
        // on the same spot — the line field wins).
        const overlapsLine = specs.some(
          (s) =>
            s.page === pageIndex &&
            s.x < box.x + box.w - 8 &&
            s.x + s.w > box.x + 8 &&
            Math.abs(s.y - box.y) < 6
        );
        if (overlapsLine) continue;
      }
      const label = labelForRect(
        box,
        textItems,
        kind === "checkbox" ? "checkbox" : "text"
      );
      autoIndex += 1;
      specs.push({
        id: nextId(),
        page: pageIndex,
        ...box,
        kind: kind === "checkbox" ? "checkbox" : "text",
        name: uniqueName(label ?? `Field ${autoIndex}`, taken),
        enabled: true,
      });
    }

    page.cleanup();
    onProgress?.({ page: p, pages: pageCount });
  }

  await doc.cleanup();

  // Reading order: page, then top→bottom, left→right (display space).
  specs.sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    const da = pdfRectToDisplay(a, pageViews[a.page]);
    const db = pdfRectToDisplay(b, pageViews[b.page]);
    if (Math.abs(da.y - db.y) > 8) return da.y - db.y;
    return da.x - db.x;
  });

  return { specs, pageViews, existingCount };
}
