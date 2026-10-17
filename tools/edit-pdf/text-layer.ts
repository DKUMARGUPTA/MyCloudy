import { loadPdfjs } from "@/lib/pdf/pdfjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

import { matchFont, type HarvestPiece } from "./model";

/**
 * Edit PDF — existing-text harvest (P8.3, PRD §8.2 "Text layer (pdf.js)
 * detect karke click par text block edit mode").
 *
 * Main-thread pdf.js access (the make-fillable detect.ts pattern): one
 * document is opened per harvest call, pieces are mapped through the
 * scale-1 viewport matrix (rotation + crop handled by pdf.js itself — the
 * P4.3 "apply the matrix directly" insight) and each piece carries its
 * resolved font match so the surface can pre-style the retype box.
 *
 * Font metadata comes from pdf.js's translated fonts via commonObjs — the
 * document is opened with `fontExtraProperties: true` (verified in
 * pdf.min.mjs 4.10.38: exportData then includes name/bold/italic/
 * isMonospace/isSerifFont). Everything is defensive: shapes that don't
 * match degrade to the CSS fallback family, never to a crash.
 */

interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
  fontName?: unknown;
}

interface RawStyle {
  fontFamily?: unknown;
}

interface TranslatedFont {
  name?: unknown;
  bold?: unknown;
  italic?: unknown;
  isMonospace?: unknown;
  isSerifFont?: unknown;
}

const DEVA_TEXT_RE = /[\u0900-\u097F]/;

/** Opens a doc with font metadata enabled (main thread only). */
async function openDoc(file: File): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  return pdfjs.getDocument({
    data,
    // Full font properties ride the common objects (name/bold/italic...).
    fontExtraProperties: true,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;
}

function fontMetaFor(
  page: { commonObjs?: unknown },
  fontName: string | null
): TranslatedFont | null {
  if (!fontName) return null;
  try {
    const objs = page.commonObjs as
      | { has?: (k: string) => boolean; get?: (k: string) => unknown }
      | undefined;
    if (!objs || typeof objs.get !== "function") return null;
    if (typeof objs.has === "function" && !objs.has(fontName)) return null;
    const font = objs.get(fontName) as TranslatedFont | null;
    if (typeof font === "object" && font !== null) return font;
    return null;
  } catch {
    return null;
  }
}

function boolOrUndef(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/**
 * One pdf.js page → display-space pieces. Shared by the single-page
 * harvest (click-to-edit) and the bulk scan (find & replace) so the two
 * paths can never drift apart.
 */
async function piecesFromPage(page: PDFPageProxy): Promise<HarvestPiece[]> {
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  const m = viewport.transform as number[];
  const [ma, mb, mc, md, me, mf] = (Array.isArray(m) ? m : []).map(Number);
  if (![ma, mb, mc, md, me, mf].every(Number.isFinite)) return [];
  const styles = (content.styles ?? {}) as Record<string, RawStyle>;

  const out: HarvestPiece[] = [];
  for (const raw of content.items as unknown[]) {
    const item = raw as RawTextItem;
    if (typeof item.str !== "string" || item.str.trim().length === 0) continue;
    const tr = item.transform;
    if (!Array.isArray(tr) || tr.length < 6) continue;
    const x0 = Number(tr[4]);
    const y0 = Number(tr[5]);
    if (!Number.isFinite(x0) || !Number.isFinite(y0)) continue;
    const width = typeof item.width === "number" ? item.width : 0;
    const hRaw =
      typeof item.height === "number" && Math.abs(item.height) > 0
        ? Math.abs(item.height)
        : Math.abs(Number(tr[3])) || 10;
    const h = hRaw > 0 ? hRaw : 10;

    // The viewport matrix maps user space → display space (rotation and
    // crop offsets included). Baseline start + advance end, min/max over
    // both mapped corners (piecesFromItems recipe, P8.2/P4.3).
    const sx = ma * x0 + mc * y0 + me;
    const sy = mb * x0 + md * y0 + mf;
    const ex = ma * (x0 + width) + mc * (y0 - h) + me;
    const ey = mb * (x0 + width) + md * (y0 - h) + mf;
    const x = Math.min(sx, ex);
    const xEnd = Math.max(sx, ex);
    if (xEnd - x <= 0.01) continue; // vertical / zero-advance run

    const fontName = typeof item.fontName === "string" ? item.fontName : null;
    const style = fontName !== null ? styles[fontName] : undefined;
    const meta = fontMetaFor(page as { commonObjs?: unknown }, fontName);
    const rawName =
      typeof meta?.name === "string" && meta.name.length > 0 ? meta.name : "";
    out.push({
      index: out.length,
      x,
      xEnd,
      baseline: sy,
      h,
      str: item.str,
      font: matchFont(rawName, {
        bold: boolOrUndef(meta?.bold),
        italic: boolOrUndef(meta?.italic),
        mono: boolOrUndef(meta?.isMonospace),
        serif: boolOrUndef(meta?.isSerifFont),
        cssFamily:
          typeof style?.fontFamily === "string" ? style.fontFamily : undefined,
        hasDeva: DEVA_TEXT_RE.test(item.str),
      }),
    });
  }
  return out;
}

/**
 * Harvests one page's text pieces in display space (y down, pt). Returns
 * [] for pages without a text layer (scans) — the surface shows its honest
 * "no selectable text" notice in that case.
 */
export async function harvestPageText(
  file: File,
  pageIndex: number
): Promise<HarvestPiece[]> {
  const doc = await openDoc(file);
  try {
    if (pageIndex < 0 || pageIndex >= doc.numPages) return [];
    const page = await doc.getPage(pageIndex + 1);
    return await piecesFromPage(page);
  } finally {
    await doc.destroy();
  }
}

export interface ScanProgress {
  page: number;
  pages: number;
}

/**
 * Bulk harvest for Find & Replace: every page's pieces (the surface's
 * 500-page guard applies). Calls back per page so the dialog can show an
 * honest progress count.
 */
export async function scanPagesText(
  file: File,
  maxPages: number,
  onProgress?: (p: ScanProgress) => void
): Promise<HarvestPiece[][]> {
  const doc = await openDoc(file);
  try {
    const count = Math.min(doc.numPages, maxPages);
    const all: HarvestPiece[][] = [];
    for (let p = 1; p <= count; p += 1) {
      const page = await doc.getPage(p);
      all.push(await piecesFromPage(page));
      onProgress?.({ page: p, pages: count });
    }
    return all;
  } finally {
    await doc.destroy();
  }
}
