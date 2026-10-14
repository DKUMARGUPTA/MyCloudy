import type { OptionValues } from "@/lib/tools/config-types";

/**
 * Pages per sheet (N-up) — shared planning logic (PRD §8.1: "2, 4, 6, 9 or
 * 16 pages on one sheet with live preview").
 *
 * Pure functions only (no pdf-lib, no pdf.js, no DOM) so the SAME code runs
 * in the custom panel (live sheet preview via pdf.js bitmaps) and in the tool
 * worker (authoritative pdf-lib placement) — the split/crop pattern of one
 * smoke-tested planning module per tool.
 *
 * Coordinate model:
 * - Sheet/cell geometry lives in PDF points with Y pointing UP (pdf-lib page
 *   space). Row 0 is the TOP row of the sheet.
 * - Source pages are described by their DISPLAY dims (the size the reader
 *   sees — /Rotate applied). The panel gets those from pdf.js viewports; the
 *   worker gets them from pdf-lib's getCropBox() + getRotation().
 * - `embedPlacement` additionally takes the page's UNROTATED form dims and
 *   /Rotate value and returns the exact pdf-lib `drawPage` arguments, because
 *   pdf-lib's embedPage does NOT apply /Rotate — the caller must rotate the
 *   placement itself. The anchor math is pinned by scripts/smoke-nup.ts.
 */

export const NUP_IDS = {
  layout: "layout",
  sheetSize: "sheetSize",
  orientation: "sheetOrientation",
  order: "order",
  margin: "margin",
  spacing: "spacing",
  borders: "borders",
  pages: "pages",
} as const;

export type NupLayout = 2 | 4 | 6 | 9 | 16;
export type NupSheetSize = "a4" | "letter" | "match";
export type NupOrientation = "portrait" | "landscape" | "auto";
export type NupOrder = "row" | "column";

/** Millimetres → points (1 pt = 1/72 in, 1 in = 25.4 mm). */
export const MM_TO_PT = 72 / 25.4;

/** A4 portrait in points. */
export const A4_PT = { w: 595.28, h: 841.89 } as const;
/** US Letter portrait in points. */
export const LETTER_PT = { w: 612, h: 792 } as const;

/** Absolute input caps for the margin/spacing fields (mm). */
export const NUP_MM_MAX = 30;

/** Smallest cell the layout clamps keep (pt) — degenerate sheets clamp to it. */
export const MIN_CELL_PT = 6;

export const NUP_LAYOUTS: readonly NupLayout[] = [2, 4, 6, 9, 16];
export const NUP_SHEET_SIZES: readonly NupSheetSize[] = ["a4", "letter", "match"];

export interface NupOptions {
  layout: NupLayout;
  sheetSize: NupSheetSize;
  orientation: NupOrientation;
  order: NupOrder;
  /** Sheet margin in mm from every edge (clamped 0-30). */
  marginMM: number;
  /** Gap between cells in mm (clamped 0-30). */
  spacingMM: number;
  borders: boolean;
  pages: string;
}

export const NUP_DEFAULTS: NupOptions = {
  layout: 2,
  sheetSize: "a4",
  orientation: "auto",
  order: "row",
  marginMM: 8,
  spacingMM: 4,
  borders: true,
  pages: "all",
};

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Normalizes any /Rotate-style angle to 0 / 90 / 180 / 270. */
export function normalizeRotation(rotation: number): 0 | 90 | 180 | 270 {
  return (((Math.round(rotation / 90) * 90) % 360) + 360) % 360 as 0 | 90 | 180 | 270;
}

/** Displayed (reader-visible) dims of a page box rotated by /Rotate. */
export function displayDims(
  rotation: number,
  vw: number,
  vh: number
): { w: number; h: number } {
  return normalizeRotation(rotation) % 180 === 0
    ? { w: vw, h: vh }
    : { w: vh, h: vw };
}

export function resolveNupOptions(values: OptionValues): NupOptions {
  const layoutRaw = values[NUP_IDS.layout];
  const layoutNumber = Math.round(asNumber(layoutRaw, NUP_DEFAULTS.layout));
  const sizeRaw = values[NUP_IDS.sheetSize];
  const orientationRaw = values[NUP_IDS.orientation];
  const orderRaw = values[NUP_IDS.order];
  return {
    layout: (NUP_LAYOUTS as readonly number[]).includes(layoutNumber)
      ? (layoutNumber as NupLayout)
      : NUP_DEFAULTS.layout,
    sheetSize: (NUP_SHEET_SIZES as readonly string[]).includes(sizeRaw as string)
      ? (sizeRaw as NupSheetSize)
      : NUP_DEFAULTS.sheetSize,
    orientation: (["portrait", "landscape", "auto"] as const).includes(
      orientationRaw as NupOrientation
    )
      ? (orientationRaw as NupOrientation)
      : NUP_DEFAULTS.orientation,
    order: orderRaw === "column" ? "column" : "row",
    marginMM: clamp(asNumber(values[NUP_IDS.margin], NUP_DEFAULTS.marginMM), 0, NUP_MM_MAX),
    spacingMM: clamp(asNumber(values[NUP_IDS.spacing], NUP_DEFAULTS.spacingMM), 0, NUP_MM_MAX),
    borders: values[NUP_IDS.borders] !== false,
    pages:
      typeof values[NUP_IDS.pages] === "string"
        ? (values[NUP_IDS.pages] as string)
        : NUP_DEFAULTS.pages,
  };
}

/* ------------------------------------------------------------------ */
/* Grid + sheet geometry                                               */
/* ------------------------------------------------------------------ */

/**
 * Grid columns/rows for a layout. 2-up splits by sheet orientation (1×2
 * portrait / 2×1 landscape), 6-up likewise (2×3 portrait / 3×2 landscape);
 * the square layouts (4 → 2×2, 9 → 3×3, 16 → 4×4) are orientation-invariant.
 */
export function gridForLayout(
  layout: NupLayout,
  orientation: "portrait" | "landscape"
): { cols: number; rows: number } {
  switch (layout) {
    case 2:
      return orientation === "portrait"
        ? { cols: 1, rows: 2 }
        : { cols: 2, rows: 1 };
    case 4:
      return { cols: 2, rows: 2 };
    case 6:
      return orientation === "portrait"
        ? { cols: 2, rows: 3 }
        : { cols: 3, rows: 2 };
    case 9:
      return { cols: 3, rows: 3 };
    case 16:
      return { cols: 4, rows: 4 };
  }
}

/** "auto" orients the sheet by the first page's display aspect ratio. */
export function effectiveOrientation(
  orientation: NupOrientation,
  firstPageAspect: number
): "portrait" | "landscape" {
  if (orientation === "landscape") return "landscape";
  if (orientation === "portrait") return "portrait";
  return firstPageAspect >= 1 ? "landscape" : "portrait";
}

/**
 * Sheet size in points. "match" uses the first page's display dims (unknown
 * → A4); every size is then arranged into the effective orientation.
 */
export function sheetSizePt(
  sheetSize: NupSheetSize,
  orientation: "portrait" | "landscape",
  firstPage: { w: number; h: number } | null
): { w: number; h: number } {
  let base: { w: number; h: number };
  if (sheetSize === "letter") {
    base = { w: LETTER_PT.w, h: LETTER_PT.h };
  } else if (sheetSize === "match") {
    base =
      firstPage && firstPage.w > 0 && firstPage.h > 0
        ? { w: firstPage.w, h: firstPage.h }
        : { w: A4_PT.w, h: A4_PT.h };
  } else {
    base = { w: A4_PT.w, h: A4_PT.h };
  }
  const min = Math.min(base.w, base.h);
  const max = Math.max(base.w, base.h);
  return orientation === "portrait" ? { w: min, h: max } : { w: max, h: min };
}

/**
 * Clamps margin/spacing into a feasible grid: both are capped at a quarter of
 * the sheet's short side, spacing then margin shrink until every cell keeps
 * MIN_CELL_PT. Always succeeds for cols/rows ≥ 1.
 */
export function sheetMetrics(
  sheetW: number,
  sheetH: number,
  cols: number,
  rows: number,
  marginMM: number,
  spacingMM: number
): { margin: number; spacing: number; cellW: number; cellH: number } {
  const sheetMin = Math.max(1, Math.min(sheetW, sheetH));
  const cap = Math.min(6 * NUP_MM_MAX, sheetMin / 4);
  let margin = clamp(marginMM * MM_TO_PT, 0, cap);
  let spacing = clamp(spacingMM * MM_TO_PT, 0, cap);
  const gapCols = Math.max(0, cols - 1);
  const gapRows = Math.max(0, rows - 1);
  if (gapCols > 0) {
    spacing = Math.min(
      spacing,
      Math.max(0, (sheetW - 2 * margin - cols * MIN_CELL_PT) / gapCols)
    );
  }
  if (gapRows > 0) {
    spacing = Math.min(
      spacing,
      Math.max(0, (sheetH - 2 * margin - rows * MIN_CELL_PT) / gapRows)
    );
  }
  margin = Math.min(
    margin,
    Math.max(0, (sheetW - gapCols * spacing - cols * MIN_CELL_PT) / 2),
    Math.max(0, (sheetH - gapRows * spacing - rows * MIN_CELL_PT) / 2)
  );
  margin = Math.max(0, margin);
  return {
    margin,
    spacing,
    cellW: (sheetW - 2 * margin - gapCols * spacing) / cols,
    cellH: (sheetH - 2 * margin - gapRows * spacing) / rows,
  };
}

/* ------------------------------------------------------------------ */
/* Sheet plan                                                          */
/* ------------------------------------------------------------------ */

/** One grid cell on one sheet (PDF points, Y up; row 0 = top row). */
export interface NupCell {
  /** Slot within the sheet (0-based reading order). */
  slot: number;
  /** Index into the SELECTED page list (0-based, ascending). */
  pageIndex: number;
  col: number;
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NupSheet {
  /** 0-based sheet number. */
  index: number;
  cells: NupCell[];
}

export interface NupPlan {
  sheetW: number;
  sheetH: number;
  cols: number;
  rows: number;
  margin: number;
  spacing: number;
  cellW: number;
  cellH: number;
  perSheet: number;
  sheets: NupSheet[];
  orientation: "portrait" | "landscape";
}

/**
 * Lays the selected pages onto sheets. `pageCount` = number of SELECTED
 * pages; `firstPage` = display dims of the first selected page (drives
 * "match" sizing + "auto" orientation; null → A4 portrait fallback).
 */
export function planSheets(
  pageCount: number,
  opts: NupOptions,
  firstPage: { w: number; h: number } | null
): NupPlan {
  const first = firstPage ?? { w: A4_PT.w, h: A4_PT.h };
  const orientation = effectiveOrientation(
    opts.orientation,
    first.w / Math.max(1, first.h)
  );
  const { cols, rows } = gridForLayout(opts.layout, orientation);
  const size = sheetSizePt(opts.sheetSize, orientation, firstPage);
  const { margin, spacing, cellW, cellH } = sheetMetrics(
    size.w,
    size.h,
    cols,
    rows,
    opts.marginMM,
    opts.spacingMM
  );
  const perSheet = cols * rows;
  const sheetCount = Math.max(1, Math.ceil(pageCount / perSheet));
  const sheets: NupSheet[] = [];
  for (let s = 0; s < sheetCount; s += 1) {
    const cells: NupCell[] = [];
    for (let slot = 0; slot < perSheet && s * perSheet + slot < pageCount; slot += 1) {
      const col =
        opts.order === "row" ? slot % cols : Math.floor(slot / rows);
      const row =
        opts.order === "row" ? Math.floor(slot / cols) : slot % rows;
      cells.push({
        slot,
        pageIndex: s * perSheet + slot,
        col,
        row,
        x: margin + col * (cellW + spacing),
        y: margin + (rows - 1 - row) * (cellH + spacing),
        w: cellW,
        h: cellH,
      });
    }
    sheets.push({ index: s, cells });
  }
  return {
    sheetW: size.w,
    sheetH: size.h,
    cols,
    rows,
    margin,
    spacing,
    cellW,
    cellH,
    perSheet,
    sheets,
    orientation,
  };
}

/** Centered fit of display-sized content (bitmap) into a cell. */
export function fitIntoCell(
  cell: { x: number; y: number; w: number; h: number },
  contentW: number,
  contentH: number
): { x: number; y: number; width: number; height: number; scale: number } {
  const scale = Math.min(cell.w / Math.max(1, contentW), cell.h / Math.max(1, contentH));
  const width = contentW * scale;
  const height = contentH * scale;
  return {
    x: cell.x + (cell.w - width) / 2,
    y: cell.y + (cell.h - height) / 2,
    width,
    height,
    scale,
  };
}

/* ------------------------------------------------------------------ */
/* /Rotate-aware pdf-lib placement                                     */
/* ------------------------------------------------------------------ */

export interface EmbedPlacement {
  /** drawPage anchor (the form's origin AFTER rotation — see header). */
  x: number;
  y: number;
  /** drawPage width/height: the form's UNROTATED dims, scaled. */
  width: number;
  height: number;
  /** The pdf-lib draw rotation: (360 − /Rotate) % 360 — see below. */
  rotate: 0 | 90 | 180 | 270;
  /** The visible (reader-facing) content box for checks/overlays. */
  visX: number;
  visY: number;
  visW: number;
  visH: number;
  scale: number;
}

/**
 * pdf-lib's drawPage emits `translate(x,y) · rotate(φ) · scale(sx,sy)` — the
 * form is scaled in its own space and then rotated about the anchor. TWO
 * subtleties are pinned by scripts/smoke-nup.ts (pdf.js pixel-verified):
 *
 * 1. pdf-lib's `rotate` is counter-clockwise-positive, while a viewer's
 *    /Rotate is clockwise-positive. Reproducing what the reader sees for
 *    /Rotate θ needs φ = (360 − θ) % 360.
 * 2. The anchor therefore sits on a different corner per angle (the visible
 *    box always occupies the quadrant the rotated axes grow INTO):
 *      /Rotate   0 → bottom-left, 90 → top-left,
 *             180 → top-right, 270 → bottom-right.
 *
 * `pageW/pageH` are the EMBEDDED form's dims (unrotated); the visible box
 * is the same content with swapped axes for 90/270.
 */
export function embedPlacement(
  cell: { x: number; y: number; w: number; h: number },
  pageW: number,
  pageH: number,
  rotation: number
): EmbedPlacement {
  const source = normalizeRotation(rotation);
  const swap = source === 90 || source === 270;
  const effW = swap ? pageH : pageW;
  const effH = swap ? pageW : pageH;
  const scale = Math.min(cell.w / Math.max(1, effW), cell.h / Math.max(1, effH));
  const visW = effW * scale;
  const visH = effH * scale;
  const visX = cell.x + (cell.w - visW) / 2;
  const visY = cell.y + (cell.h - visH) / 2;
  let x = visX;
  let y = visY;
  if (source === 90) {
    y = visY + visH;
  } else if (source === 180) {
    x = visX + visW;
    y = visY + visH;
  } else if (source === 270) {
    x = visX + visW;
  }
  const drawAngle = ((360 - source) % 360) as 0 | 90 | 180 | 270;
  return {
    x,
    y,
    width: pageW * scale,
    height: pageH * scale,
    rotate: drawAngle,
    visX,
    visY,
    visW,
    visH,
    scale,
  };
}
