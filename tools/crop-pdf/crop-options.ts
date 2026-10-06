import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WmLayout,
  targetIndices,
} from "../add-watermark/wm-options";

/**
 * Crop PDF option ids, defaults and the display→user-space geometry
 * (PRD §8.2 "Crop": visual crop box drag; margins numeric; apply to all /
 * selected; auto-detect margins; shows before/after).
 *
 * ONE pure module shared by the panel (writes margins), the live preview
 * surface (reads + writes) and the worker (reads) — same as the watermark
 * and stamp rounds.
 *
 * Coordinate model:
 * - The crop is stored as four margins (left/top/right/bottom) in PDF
 *   points, measured from the edges of the page's DISPLAYED orientation
 *   (what pdf.js renders — rotation applied). Every page is cropped by the
 *   same visual margins relative to its own view.
 * - The worker maps display margins → PDF user space per page using the
 *   page's current view box (CropBox, falling back to MediaBox) and its
 *   /Rotate value. The mapping was derived from pdf.js getViewport()
 *   transforms and is proven by scripts/smoke-crop.ts — keep in sync.
 */

export const CROP_IDS = {
  unit: "cropUnit",
  left: "cropLeft",
  top: "cropTop",
  right: "cropRight",
  bottom: "cropBottom",
  layout: "cropLayout",
  pages: "cropPages",
} as const;

export type CropUnit = "pt" | "mm" | "in";

export interface CropOptions {
  /** Display unit for the margin inputs (storage is always points). */
  unit: CropUnit;
  /** Margins from each display edge, PDF points. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  layout: WmLayout;
  pages: string;
}

export const CROP_DEFAULTS: CropOptions = {
  unit: "pt",
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  layout: "all",
  pages: "all",
};

/** Smallest crop kept on any page (pt) — degenerate boxes clamp to this. */
export const MIN_CROP_PT = 18;

export const CROP_UNITS: CropUnit[] = ["pt", "mm", "in"];

/** Points per unit (1 pt = 1/72 in; 1 in = 25.4 mm). */
const PT_PER_UNIT: Record<CropUnit, number> = {
  pt: 1,
  mm: 72 / 25.4,
  in: 72,
};

export function toPt(value: number, unit: CropUnit): number {
  return value * PT_PER_UNIT[unit];
}

export function fromPt(pt: number, unit: CropUnit): number {
  return pt / PT_PER_UNIT[unit];
}

/** Human-friendly margin text: pt integer, mm 1 decimal, in 2 decimals. */
export function formatPtInUnit(pt: number, unit: CropUnit): string {
  const v = fromPt(pt, unit);
  if (unit === "pt") return String(Math.round(v));
  if (unit === "mm") return (Math.round(v * 10) / 10).toFixed(1);
  return (Math.round(v * 100) / 100).toFixed(2);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function resolveCropOptions(values: OptionValues): CropOptions {
  const unitRaw = asString(values[CROP_IDS.unit], CROP_DEFAULTS.unit);
  const layoutRaw = asString(values[CROP_IDS.layout], CROP_DEFAULTS.layout);
  return {
    unit: (CROP_UNITS as string[]).includes(unitRaw)
      ? (unitRaw as CropUnit)
      : CROP_DEFAULTS.unit,
    left: clamp(round1(asNumber(values[CROP_IDS.left], 0)), 0, 10000),
    top: clamp(round1(asNumber(values[CROP_IDS.top], 0)), 0, 10000),
    right: clamp(round1(asNumber(values[CROP_IDS.right], 0)), 0, 10000),
    bottom: clamp(round1(asNumber(values[CROP_IDS.bottom], 0)), 0, 10000),
    layout: (["all", "odd", "even", "skipFirst", "range"] as string[]).includes(
      layoutRaw
    )
      ? (layoutRaw as WmLayout)
      : CROP_DEFAULTS.layout,
    pages: asString(values[CROP_IDS.pages], CROP_DEFAULTS.pages),
  };
}

/** Page indices the crop applies to (null = unparsable range). */
export function cropTargets(
  crop: CropOptions,
  pageCount: number
): number[] | null {
  return targetIndices({ layout: crop.layout, pages: crop.pages }, pageCount);
}

/** True when the box covers the whole page — nothing would change. */
export function cropIsNoOp(crop: CropOptions): boolean {
  return (
    crop.left <= 0 && crop.top <= 0 && crop.right <= 0 && crop.bottom <= 0
  );
}

/* ------------------------------------------------------------------ */
/* Display-space geometry (proven in scripts/smoke-crop.ts)            */
/* ------------------------------------------------------------------ */

/** Displayed page dims (dw, dh) for a view box + /Rotate value. */
export function displayDims(
  rotation: number,
  vw: number,
  vh: number
): { dw: number; dh: number } {
  const r = ((rotation % 360) + 360) % 360;
  return r === 90 || r === 270 ? { dw: vh, dh: vw } : { dw: vw, dh: vh };
}

/**
 * Maps a display-space point (dx from the left edge, dyUp from the bottom
 * edge) to PDF user space, given the page's view box + /Rotate. Derived
 * from pdf.js getViewport() transforms — see the smoke test for the worked
 * examples that lock this math in place.
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
  switch (((rotation % 360) + 360) % 360) {
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

export interface ClampedCropRect {
  /** x from the left edge, display points. */
  x0: number;
  x1: number;
  /** y measured UP from the bottom edge, display points (yUp1 > yUp0). */
  yUp0: number;
  yUp1: number;
}

/**
 * Clamps margins into a display box and keeps a minimum size. Over-sized
 * margins shrink toward the top-right corner.
 */
export function fitCropRect(
  crop: Pick<CropOptions, "left" | "top" | "right" | "bottom">,
  dw: number,
  dh: number,
  minSize = MIN_CROP_PT
): ClampedCropRect {
  // x from the left edge; y from the top edge (display = CSS orientation).
  const x0 = Math.min(Math.max(0, crop.left), dw - minSize);
  const x1 = Math.max(x0 + minSize, Math.min(dw, dw - crop.right));
  const yT = Math.min(Math.max(0, crop.top), dh - minSize);
  const yB = Math.max(yT + minSize, Math.min(dh, dh - crop.bottom));
  // Convert to y-up (from the bottom edge) for the user-space mapping.
  return { x0, x1, yUp0: dh - yB, yUp1: dh - yT };
}

/** The rect as display-space, y-down edges (what the overlay paints). */
export function clampedRectYDown(
  crop: Pick<CropOptions, "left" | "top" | "right" | "bottom">,
  dw: number,
  dh: number,
  minSize = MIN_CROP_PT
): { left: number; top: number; width: number; height: number } {
  const rect = fitCropRect(crop, dw, dh, minSize);
  return {
    left: rect.x0,
    top: dh - rect.yUp1,
    width: rect.x1 - rect.x0,
    height: rect.yUp1 - rect.yUp0,
  };
}

/**
 * The worker's core operation: display margins + a page's view box +
 * /Rotate → the user-space setCropBox arguments.
 */
export function cropBoxForPage(
  crop: Pick<CropOptions, "left" | "top" | "right" | "bottom">,
  view: { x: number; y: number; width: number; height: number },
  rotation: number,
  minSize = MIN_CROP_PT
): { x: number; y: number; width: number; height: number } {
  const { dw, dh } = displayDims(rotation, view.width, view.height);
  const rect = fitCropRect(crop, dw, dh, minSize);
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
export function sameBox(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    Math.abs(a.x - b.x) < 0.01 &&
    Math.abs(a.y - b.y) < 0.01 &&
    Math.abs(a.width - b.width) < 0.01 &&
    Math.abs(a.height - b.height) < 0.01
  );
}
