import type { OptionValues } from "@/lib/tools/config-types";
import {
  displayDims,
  displayRectToUserBox,
  type DisplayRect,
  type PageBox,
} from "../halve-pdf-pages/engine";

/**
 * Divide PDF pages — shared planning logic (generalizes the halve-pdf-pages
 * crop-window engine from 2 pieces to N, in either axis or both).
 *
 * Pure functions only (no pdf-lib, no pdf.js, no DOM) so the SAME code runs
 * in the worker (authoritative MediaBox/CropBox writes). The display→user
 * mapping and box math are imported from the halve engine, where they are
 * pinned by scripts/smoke-halve.ts — one source of truth for /Rotate-aware
 * cropping across the crop/halve/divide family.
 *
 * Coordinate model (identical to halve): pieces are laid out in DISPLAY
 * space (what the reader sees — columns left→right, rows top→bottom), then
 * mapped to PDF user space per page /Rotate, so a vertical cut of a
 * /Rotate 90 page slices the unrotated box on the Y axis — exactly what
 * the viewer shows as left/right.
 */

export const DIVIDE_IDS = {
  axis: "axis",
  pieces: "pieces",
  pages: "pages",
} as const;

export type DivideAxis = "vertical" | "horizontal" | "grid";
export type DividePieces = 2 | 3 | 4;

export interface DivideOptions {
  /** vertical = columns (left→right); horizontal = rows (top→bottom); grid = both. */
  axis: DivideAxis;
  /** Pieces per axis (grid → pieces × pieces). */
  pieces: DividePieces;
  pages: string;
}

export const DIVIDE_DEFAULTS: DivideOptions = {
  axis: "vertical",
  pieces: 2,
  pages: "all",
};

export const DIVIDE_PIECES: readonly DividePieces[] = [2, 3, 4];

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function resolveDivideOptions(values: OptionValues): DivideOptions {
  const axisRaw = String(values[DIVIDE_IDS.axis] ?? DIVIDE_DEFAULTS.axis);
  const axis: DivideAxis =
    axisRaw === "horizontal" || axisRaw === "grid"
      ? (axisRaw as DivideAxis)
      : "vertical";
  const piecesRaw = clampInt(values[DIVIDE_IDS.pieces], DIVIDE_DEFAULTS.pieces, 2, 4);
  return {
    axis,
    pieces: (DIVIDE_PIECES as readonly number[]).includes(piecesRaw)
      ? (piecesRaw as DividePieces)
      : DIVIDE_DEFAULTS.pieces,
    pages:
      typeof values[DIVIDE_IDS.pages] === "string"
        ? (values[DIVIDE_IDS.pages] as string)
        : DIVIDE_DEFAULTS.pages,
  };
}

/* ------------------------------------------------------------------ */
/* Divide geometry + plan                                              */
/* ------------------------------------------------------------------ */

/**
 * The user-space boxes one page divides into, in reading order:
 * vertical → columns left→right; horizontal → rows top→bottom;
 * grid → row by row (top row left→right first).
 */
export function divideBoxes(
  view: PageBox,
  rotation: number,
  opts: Pick<DivideOptions, "axis" | "pieces">
): PageBox[] {
  const { dw, dh } = displayDims(rotation, view.width, view.height);
  const n = opts.pieces;
  const cols = opts.axis === "horizontal" ? 1 : n;
  const rows = opts.axis === "vertical" ? 1 : n;
  const cellW = dw / cols;
  const cellH = dh / rows;
  const boxes: PageBox[] = [];
  // Row 0 is the TOP row: its display rect sits at the top of the page.
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const rect: DisplayRect = {
        x0: col * cellW,
        x1: (col + 1) * cellW,
        yUp0: dh - (row + 1) * cellH,
        yUp1: dh - row * cellH,
      };
      boxes.push(displayRectToUserBox(rect, view, rotation));
    }
  }
  return boxes;
}

/** One output page: which source page, which piece of it. */
export interface DivideEntry {
  /** 0-based index into the SOURCE document. */
  sourceIndex: number;
  /** Index into divideBoxes(...) for this page (reading order). */
  piece: number;
  /** Total pieces for this page (for progress + result detail). */
  pieces: number;
}

/**
 * Output order: for every selected page (ascending), its pieces in reading
 * order — page 1 pieces, then page 2 pieces, and so on.
 */
export function planDivide(indices: readonly number[], pieces: number): DivideEntry[] {
  const plan: DivideEntry[] = [];
  for (const sourceIndex of indices) {
    for (let piece = 0; piece < pieces; piece += 1) {
      plan.push({ sourceIndex, piece, pieces });
    }
  }
  return plan;
}
