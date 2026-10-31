import type { OptionValues } from "@/lib/tools/config-types";

/**
 * Divide PDF pages (PHASE-1 Batch A): split each selected page into an
 * N×M grid of pieces — 2 halves, 4 quadrants, 3 strips, up to 4×4.
 * The superset of "halve" for cutting scanned sheets, comic panels and
 * contact sheets into individual pages.
 *
 * Pure functions only (no engine imports) so the SAME planning math can be
 * smoke-tested and reused by the worker. Coordinate model identical to
 * tools/halve-pdf-pages/engine.ts (display→user mapping for /Rotate-aware
 * cuts; kept local per tool-isolation house rule).
 */

export const DIVIDE_IDS = {
  columns: "columns",
  rows: "rows",
  order: "order",
  pages: "pages",
} as const;

export const DIVIDE_MIN = 1;
export const DIVIDE_MAX = 4;

export type DivideOrder = "rows" | "columns";

export interface DivideOptions {
  columns: number;
  rows: number;
  order: DivideOrder;
  pages: string;
}

export const DIVIDE_DEFAULTS: DivideOptions = {
  columns: 2,
  rows: 1,
  order: "rows",
  pages: "all",
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function resolveDivideOptions(values: OptionValues): DivideOptions {
  const cols = Math.floor(
    clamp(Number(values[DIVIDE_IDS.columns]) || DIVIDE_DEFAULTS.columns, 1, DIVIDE_MAX)
  );
  const rows = Math.floor(
    clamp(Number(values[DIVIDE_IDS.rows]) || DIVIDE_DEFAULTS.rows, 1, DIVIDE_MAX)
  );
  return {
    columns: cols,
    rows: rows,
    order: values[DIVIDE_IDS.order] === "columns" ? "columns" : "rows",
    pages:
      typeof values[DIVIDE_IDS.pages] === "string"
        ? (values[DIVIDE_IDS.pages] as string)
        : DIVIDE_DEFAULTS.pages,
  };
}

/* ------------------------------------------------------------------ */
/* Display ↔ user space (same math as halve, tool-local copy)          */
/* ------------------------------------------------------------------ */

export type PageBox = { x: number; y: number; width: number; height: number };

function normalizeRotation(rotation: number): 0 | 90 | 180 | 270 {
  return ((((Math.round(rotation / 90) * 90) % 360) + 360) % 360) as
    | 0
    | 90
    | 180
    | 270;
}

function displayDims(
  rotation: number,
  vw: number,
  vh: number
): { dw: number; dh: number } {
  return normalizeRotation(rotation) % 180 === 0
    ? { dw: vw, dh: vh }
    : { dw: vh, dh: vw };
}

function displayToUser(
  rotation: number,
  vx0: number,
  vy0: number,
  vw: number,
  vh: number,
  dx: number,
  dyUp: number
): { x: number; y: number } {
  switch (normalizeRotation(rotation)) {
    case 90:
      return { x: vx0 + vw - dyUp, y: vy0 + dx };
    case 180:
      return { x: vx0 + vw - dx, y: vy0 + vh - dyUp };
    case 270:
      return { x: vx0 + dyUp, y: vy0 + vh - dx };
    default:
      return { x: vx0 + dx, y: vy0 + dyUp };
  }
}

interface DisplayRect {
  x0: number;
  x1: number;
  yUp0: number;
  yUp1: number;
}

function displayRectToUserBox(
  rect: DisplayRect,
  view: PageBox,
  rotation: number
): PageBox {
  const p00 = displayToUser(
    rotation,
    view.x,
    view.y,
    view.width,
    view.height,
    rect.x0,
    rect.yUp0
  );
  const p11 = displayToUser(
    rotation,
    view.x,
    view.y,
    view.width,
    view.height,
    rect.x1,
    rect.yUp1
  );
  return {
    x: Math.min(p00.x, p11.x),
    y: Math.min(p00.y, p11.y),
    width: Math.abs(p11.x - p00.x),
    height: Math.abs(p11.y - p00.y),
  };
}

/* ------------------------------------------------------------------ */
/* Grid geometry + plan                                                */
/* ------------------------------------------------------------------ */

/** One output piece: source page + its display-space cell (col, row). */
export interface DivideEntry {
  sourceIndex: number;
  col: number;
  row: number;
}

/**
 * The user-space box of one grid cell, in DISPLAY space (col across, row
 * counted from the TOP like a reading grid), mapped through /Rotate.
 */
export function divideCellBox(
  view: PageBox,
  rotation: number,
  columns: number,
  rows: number,
  col: number,
  row: number
): PageBox {
  const { dw, dh } = displayDims(rotation, view.width, view.height);
  const cw = dw / columns;
  const ch = dh / rows;
  const rect: DisplayRect = {
    x0: col * cw,
    x1: (col + 1) * cw,
    // y measured UP: row 0 is the TOP strip.
    yUp0: dh - (row + 1) * ch,
    yUp1: dh - row * ch,
  };
  return displayRectToUserBox(rect, view, rotation);
}

/**
 * Output order: for each selected page, its pieces row-by-row (reading
 * order, left→right then down) or column-by-column (top→bottom then
 * right). Pages ascend.
 */
export function planDivide(
  indices: readonly number[],
  opts: Pick<DivideOptions, "columns" | "rows" | "order">
): DivideEntry[] {
  const plan: DivideEntry[] = [];
  for (const sourceIndex of indices) {
    if (opts.order === "columns") {
      for (let col = 0; col < opts.columns; col += 1) {
        for (let row = 0; row < opts.rows; row += 1) {
          plan.push({ sourceIndex, col, row });
        }
      }
    } else {
      for (let row = 0; row < opts.rows; row += 1) {
        for (let col = 0; col < opts.columns; col += 1) {
          plan.push({ sourceIndex, col, row });
        }
      }
    }
  }
  return plan;
}
