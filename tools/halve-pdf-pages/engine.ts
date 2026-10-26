import type { OptionValues } from "@/lib/tools/config-types";

/**
 * Halve PDF pages — shared planning logic (PRD §8.1: "Cut scanned book
 * spreads into left/right single pages").
 *
 * Pure functions only (no pdf-lib, no pdf.js, no DOM) so the SAME code runs
 * in the custom panel (live cut-line preview + output count) and in the tool
 * worker (authoritative MediaBox/CropBox writes) — the split/crop planning
 * pattern.
 *
 * Coordinate model (re-derived, minimal, from the display→user-space
 * geometry proven in tools/crop-pdf/crop-options.ts — the pdf.js
 * getViewport() transforms; same math, kept local for tool isolation):
 * - A page VIEW box is its CropBox (falling back to MediaBox) in PDF user
 *   space. /Rotate turns it on the screen; `displayDims` gives the
 *   reader-visible size.
 * - Halves are defined in DISPLAY space (what the reader sees: left/right,
 *   top/bottom), then mapped to user space with `displayToUser` so a
 *   vertical cut of a /Rotate 90 page slices the unrotated box on the Y
 *   axis — exactly what a viewer shows as left/right.
 */

export const HALVE_IDS = {
  cut: "cut",
  verticalOrder: "verticalOrder",
  horizontalOrder: "horizontalOrder",
  position: "cutPosition",
  reverse: "reverseOrder",
  pages: "pages",
  firstPageCover: "firstPageCover",
} as const;

export type HalveCut = "vertical" | "horizontal";
export type HalveVerticalOrder = "left" | "right";
export type HalveHorizontalOrder = "top" | "bottom";

/** Percent cut-position bounds (PRD keeps it near the middle). */
export const HALVE_POSITION_MIN = 40;
export const HALVE_POSITION_MAX = 60;

export interface HalveOptions {
  cut: HalveCut;
  verticalOrder: HalveVerticalOrder;
  horizontalOrder: HalveHorizontalOrder;
  /** Where the cut lands, in percent across the cut axis (40-60). */
  positionPct: number;
  /** Reverse the whole output order (last half first). */
  reverse: boolean;
  pages: string;
  /**
   * Book-spread mode (P5): the FIRST selected page passes through whole
   * (the scanned cover) and every later page is cut into two — the
   * classic "cover, then spreads" scan order.
   */
  firstPageCover: boolean;
}

export const HALVE_DEFAULTS: HalveOptions = {
  cut: "vertical",
  verticalOrder: "left",
  horizontalOrder: "top",
  positionPct: 50,
  reverse: false,
  pages: "all",
  firstPageCover: false,
};

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function resolveHalveOptions(values: OptionValues): HalveOptions {
  const cutRaw = values[HALVE_IDS.cut];
  const vOrderRaw = values[HALVE_IDS.verticalOrder];
  const hOrderRaw = values[HALVE_IDS.horizontalOrder];
  return {
    cut: cutRaw === "horizontal" ? "horizontal" : "vertical",
    verticalOrder: vOrderRaw === "right" ? "right" : "left",
    horizontalOrder: hOrderRaw === "bottom" ? "bottom" : "top",
    positionPct: clamp(
      asNumber(values[HALVE_IDS.position], HALVE_DEFAULTS.positionPct),
      HALVE_POSITION_MIN,
      HALVE_POSITION_MAX
    ),
    reverse: values[HALVE_IDS.reverse] === true,
    pages:
      typeof values[HALVE_IDS.pages] === "string"
        ? (values[HALVE_IDS.pages] as string)
        : HALVE_DEFAULTS.pages,
    firstPageCover: values[HALVE_IDS.firstPageCover] === true,
  };
}

/* ------------------------------------------------------------------ */
/* Display ↔ user space (crop-options math, re-derived)                */
/* ------------------------------------------------------------------ */

/** Normalizes any /Rotate-style angle to 0 / 90 / 180 / 270. */
export function normalizeRotation(rotation: number): 0 | 90 | 180 | 270 {
  return (((Math.round(rotation / 90) * 90) % 360) + 360) % 360 as 0 | 90 | 180 | 270;
}

/** Displayed (reader-visible) dims of a view box rotated by /Rotate. */
export function displayDims(
  rotation: number,
  vw: number,
  vh: number
): { dw: number; dh: number } {
  return normalizeRotation(rotation) % 180 === 0
    ? { dw: vw, dh: vh }
    : { dw: vh, dh: vw };
}

/**
 * Maps a display-space point (dx from the left edge, dyUp from the bottom
 * edge of the DISPLAYED page) to PDF user space, given the page's view box
 * and /Rotate. Derived from pdf.js getViewport() transforms — the worked
 * examples in scripts/smoke-halve.ts lock this math in place.
 */
export function displayToUser(
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

/** A rectangle in display space: x from the left, y measured UP. */
export interface DisplayRect {
  x0: number;
  x1: number;
  yUp0: number;
  yUp1: number;
}

/** A PDF user-space box (what setMediaBox/setCropBox accept). */
export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Maps a display rect into a user-space box (two corners + normalize). */
export function displayRectToUserBox(
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

/** True when two boxes are equal within 1/100 pt. */
export function sameBox(a: PageBox, b: PageBox): boolean {
  return (
    Math.abs(a.x - b.x) < 0.01 &&
    Math.abs(a.y - b.y) < 0.01 &&
    Math.abs(a.width - b.width) < 0.01 &&
    Math.abs(a.height - b.height) < 0.01
  );
}

/* ------------------------------------------------------------------ */
/* Halving geometry + plan                                             */
/* ------------------------------------------------------------------ */

export interface HalveBoxes {
  /** The half that comes out FIRST (per the order options). */
  primary: PageBox;
  /** The half that comes out second. */
  secondary: PageBox;
}

/**
 * The worker's core operation: view box + /Rotate + options → the two
 * user-space boxes the output copies get. A "vertical" cut halves what the
 * READER sees as left/right; for /Rotate 90/270 that slices the unrotated
 * box on the Y axis (and vice versa) — displayToUser handles the mapping.
 */
export function halveBoxes(
  view: PageBox,
  rotation: number,
  opts: Pick<HalveOptions, "cut" | "verticalOrder" | "horizontalOrder" | "positionPct">
): HalveBoxes {
  const { dw, dh } = displayDims(rotation, view.width, view.height);
  const pos =
    clamp(opts.positionPct, HALVE_POSITION_MIN, HALVE_POSITION_MAX) / 100;
  let primary: DisplayRect;
  let secondary: DisplayRect;
  if (opts.cut === "vertical") {
    const cutX = pos * dw;
    const left: DisplayRect = { x0: 0, x1: cutX, yUp0: 0, yUp1: dh };
    const right: DisplayRect = { x0: cutX, x1: dw, yUp0: 0, yUp1: dh };
    primary = opts.verticalOrder === "left" ? left : right;
    secondary = opts.verticalOrder === "left" ? right : left;
  } else {
    const cutH = pos * dh;
    const top: DisplayRect = { x0: 0, x1: dw, yUp0: dh - cutH, yUp1: dh };
    const bottom: DisplayRect = { x0: 0, x1: dw, yUp0: 0, yUp1: dh - cutH };
    primary = opts.horizontalOrder === "top" ? top : bottom;
    secondary = opts.horizontalOrder === "top" ? bottom : top;
  }
  return {
    primary: displayRectToUserBox(primary, view, rotation),
    secondary: displayRectToUserBox(secondary, view, rotation),
  };
}

/** One output page: which source page, and which half of it. */
export interface HalveEntry {
  /** 0-based index into the SOURCE document. */
  sourceIndex: number;
  /** "whole" = book-spread cover pass-through (no cut). */
  half: "primary" | "secondary" | "whole";
}

/**
 * Output order: each selected page's primary half, then its secondary half
 * (or reversed halves for right-/bottom-first), pages ascending. `reverse`
 * flips the WHOLE output sequence — the classic "read the backs first" book
 * scan case.
 */
export function planHalves(
  indices: readonly number[],
  opts: Pick<HalveOptions, "reverse" | "firstPageCover">
): HalveEntry[] {
  const plan: HalveEntry[] = [];
  indices.forEach((sourceIndex, i) => {
    if (i === 0 && opts.firstPageCover) {
      plan.push({ sourceIndex, half: "whole" });
      return;
    }
    plan.push({ sourceIndex, half: "primary" });
    plan.push({ sourceIndex, half: "secondary" });
  });
  if (opts.reverse) plan.reverse();
  return plan;
}
