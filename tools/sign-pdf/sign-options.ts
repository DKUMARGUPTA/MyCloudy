import type { OptionValues } from "@/lib/tools/config-types";
import { parsePageSpec } from "@/lib/workers/protocol";

/**
 * Sign PDF option ids + the placement math shared by the drag SURFACE and
 * the pdf-lib WORKER (PRD §7.6 "Sign PDF — draw/type/upload; place it on
 * any page").
 *
 * Position lives in PERCENTS of the RENDERED page (what pdf.js shows,
 * /Rotate already applied) so the drag overlay and the worker agree on
 * every rotation:
 *
 *   xPct  — signature CENTER, % of display width, 0 = left edge
 *   yPct  — signature CENTER, % of display height, 0 = TOP edge
 *   sizePct — signature WIDTH, % of display width
 *
 * The worker inverse-maps the display percents into pdf-lib user space
 * per /Rotate (0/90/180/270) with a compensating image rotation, so the
 * signature lands upright and pixel-exact on rotated scans too. The
 * mapping below is derived from the pdf.js viewport transforms — the same
 * math fill-out-pdf's scan.ts uses forward.
 */

export const SIGN_IDS = {
  x: "sigX",
  y: "sigY",
  size: "sigSize",
  pages: "pages",
} as const;

export interface SignOptions {
  /** 0-100, center, % of display width. */
  xPct: number;
  /** 0-100, center, % of display height, from the TOP. */
  yPct: number;
  /** 4-90, signature width as % of display width. */
  sizePct: number;
  /** Page spec: "1", "1-3, 5", "all". */
  pages: string;
}

export const SIGN_DEFAULTS: SignOptions = {
  xPct: 62,
  yPct: 78,
  sizePct: 25,
  pages: "1",
};

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Coerces raw option values into typed sign options (worker + surface). */
export function resolveSignOptions(values: OptionValues): SignOptions {
  return {
    xPct: clamp(asNumber(values[SIGN_IDS.x], SIGN_DEFAULTS.xPct), 0, 100),
    yPct: clamp(asNumber(values[SIGN_IDS.y], SIGN_DEFAULTS.yPct), 0, 100),
    sizePct: clamp(
      Math.round(asNumber(values[SIGN_IDS.size], SIGN_DEFAULTS.sizePct)),
      4,
      90
    ),
    pages: asString(values[SIGN_IDS.pages], SIGN_DEFAULTS.pages),
  };
}

/** Target page indices for a spec, or null when the spec is invalid. */
export function signTargetIndices(
  pages: string,
  pageCount: number
): number[] | null {
  return parsePageSpec(pages, pageCount);
}

/** Normalizes any page rotation to 0/90/180/270 (clockwise, display). */
export function normalizeRotation(angle: number): number {
  const rounded = Math.round(angle / 90) * 90;
  return ((rounded % 360) + 360) % 360;
}

/**
 * Display → user-space mapping for a point given in percents of the
 * RENDERED page. Returns the pdf-lib user-space center (y up) plus the
 * compensating CCW angle the image must be drawn with to appear upright.
 */
export function displayPctToUser(
  xPct: number,
  yPct: number,
  rotation: number,
  userW: number,
  userH: number
): { ux: number; uy: number; thetaDeg: number } {
  const r = normalizeRotation(rotation);
  const swap = r === 90 || r === 270;
  const dispW = swap ? userH : userW;
  const dispH = swap ? userW : userH;
  const cx = (clamp(xPct, 0, 100) / 100) * dispW;
  const cy = (clamp(yPct, 0, 100) / 100) * dispH;
  switch (r) {
    case 90:
      // display X = user y, display Y = user x
      return { ux: cy, uy: cx, thetaDeg: 90 };
    case 180:
      // display X = userW - x, display Y = y
      return { ux: userW - cx, uy: cy, thetaDeg: 180 };
    case 270:
      // display X = userH - y, display Y = userW - x
      return { ux: userW - cy, uy: userH - cx, thetaDeg: 270 };
    default:
      // display X = x, display Y = userH - y
      return { ux: cx, uy: userH - cy, thetaDeg: 0 };
  }
}

/**
 * Bottom-left draw anchor for an image whose CENTER is at (ux, uy) in user
 * space, drawn with CCW rotation theta — pdf-lib rotates around (x, y), so
 * the anchor is the center minus the rotated half-extents.
 */
export function rotatedAnchor(
  ux: number,
  uy: number,
  w: number,
  h: number,
  thetaDeg: number
): { ax: number; ay: number } {
  const rad = (thetaDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // half-extents of the local box from center to the bottom-left corner
  const hx = -w / 2;
  const hy = -h / 2;
  return {
    ax: ux + hx * cos - hy * sin,
    ay: uy + hx * sin + hy * cos,
  };
}

/**
 * Signature image size in USER points for a sizePct of the DISPLAY width.
 * w and h are the same numbers passed to drawImage (rotation just turns
 * the box; the local frame keeps its own width/height).
 */
export function signatureBoxSize(
  sizePct: number,
  rotation: number,
  userW: number,
  userH: number,
  imageAspect: number // height / width of the signature PNG
): { w: number; h: number } {
  const r = normalizeRotation(rotation);
  const dispW = r === 90 || r === 270 ? userH : userW;
  const w = (clamp(sizePct, 4, 90) / 100) * dispW;
  return { w, h: w * imageAspect };
}
