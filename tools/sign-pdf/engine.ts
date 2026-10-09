import { parsePageSpec } from "@/lib/workers/protocol";

/**
 * Sign PDF — pure placement engine (PRD §7.6 "Sign PDF (visual signature)").
 *
 * Everything here is plain math on plain data, so the smoke script can
 * verify it headlessly with bun. The interactive surface and the worker
 * both import this module — one source of truth for the geometry.
 *
 * Coordinate model (the part worth reading twice):
 * - A placement stores its center and width as FRACTIONS of the page's
 *   DISPLAY box (what pdf.js renders, /Rotate already applied) — exactly
 *   like the CSS overlay that edits it. That makes the preview trivially
 *   zoom-proof and the numbers human-readable (w = 0.25 = quarter page).
 * - The worker must draw in USER space with pdf-lib, where the display
 *   box is the page rotated by /Rotate R (0/90/180/270, clockwise when
 *   displayed). displayFracToUserPoint() is the display→user map, derived
 *   by corner-walking each rotation (the same invariants the fill tool's
 *   scan.ts uses, inverted).
 * - An axis-aligned image in DISPLAY space is drawn in user space by
 *   rotating it by R counter-clockwise first (align), then applying the
 *   user-chosen on-screen rotation `rot` (CSS clockwise). The user→screen
 *   map always has negative determinant (y-flip), so a display-clockwise
 *   rotation is user-counter-clockwise: total pdf-lib angle = R - rot.
 */

export interface SignPlacement {
  id: string;
  /** Signature library id this placement stamps. */
  sigId: string;
  /** Center x as a fraction of the page's DISPLAY width (0..1). */
  cx: number;
  /** Center y as a fraction of the page's DISPLAY height (0..1, from top). */
  cy: number;
  /** Box width as a fraction of the page's DISPLAY width (0.02..1.5). */
  w: number;
  /** On-screen rotation, degrees clockwise (CSS convention). */
  rot: number;
  /** Paint opacity 0.15..1. */
  op: number;
  /** Which pages the placement is stamped on. */
  pages: "this" | "all" | "odd" | "even" | "range";
  /** Page-range spec for pages === "range" ("1-3, 5, 8-"). */
  range?: string;
  /** The page the user placed it on (0-based, drives pages === "this"). */
  pageIndex: number;
}

export interface PageGeom {
  rotation: number;
  width: number;
  height: number;
}

export interface SignDrawBox {
  /** pdf-lib drawImage anchor (image bottom-left, pre-rotation). */
  sx: number;
  sy: number;
  /** Image size in user-space points. */
  w: number;
  h: number;
  /** pdf-lib rotation (degrees, CCW positive) around the anchor. */
  angle: number;
  /** Paint opacity. */
  op: number;
}

export function normRotation(rotation: number): number {
  return ((Math.round(rotation) % 360) + 360) % 360;
}

/** Display-box size of a page: /Rotate 90/270 swaps the media box axes. */
export function displaySizeOf(
  rotation: number,
  width: number,
  height: number
): { w: number; h: number } {
  const r = normRotation(rotation);
  return r === 90 || r === 270 ? { w: height, h: width } : { w: width, h: height };
}

/**
 * Display point (fractions from the display box's top-left, y down) →
 * user-space point. Corner-walked for each rotation:
 *
 *   R=0:   TL=(0,H) → x=fx·W,   y=(1-fy)·H
 *   R=90:  TL=(0,0) → x=fy·W,   y=fx·H
 *   R=180: TL=(W,0) → x=(1-fx)·W, y=fy·H
 *   R=270: TL=(W,H) → x=(1-fy)·W, y=(1-fx)·H
 */
export function displayFracToUserPoint(
  fx: number,
  fy: number,
  rotation: number,
  width: number,
  height: number
): { x: number; y: number } {
  const r = normRotation(rotation);
  const x = clamp01(fx);
  const y = clamp01(fy);
  switch (r) {
    case 90:
      return { x: y * width, y: x * height };
    case 180:
      return { x: (1 - x) * width, y: y * height };
    case 270:
      return { x: (1 - y) * width, y: (1 - x) * height };
    default:
      return { x: x * width, y: (1 - y) * height };
  }
}

/**
 * Full placement → pdf-lib draw box for one page. `aspect` is the
 * signature image's intrinsic height/width ratio; the on-page box keeps
 * that aspect at the requested display width.
 */
export function placementToDrawBox(
  p: SignPlacement,
  page: PageGeom,
  aspect: number
): SignDrawBox {
  const r = normRotation(page.rotation);
  const disp = displaySizeOf(r, page.width, page.height);
  const dw = clampN(p.w, 0.02, 1.5) * disp.w;
  const dh = dw * (aspect > 0 ? aspect : 0.5);
  const center = displayFracToUserPoint(
    clamp01(p.cx),
    clamp01(p.cy),
    r,
    page.width,
    page.height
  );
  const angle = r - clampN(p.rot, -180, 180);
  const rad = (angle * Math.PI) / 180;
  const hx = dw / 2;
  const hy = dh / 2;
  // Offset from the (pre-rotation) anchor to the box center, rotated by
  // the pdf-lib angle — identical to the watermark worker's start point.
  const sx = center.x - (Math.cos(rad) * hx - Math.sin(rad) * hy);
  const sy = center.y - (Math.sin(rad) * hx + Math.cos(rad) * hy);
  return {
    sx,
    sy,
    w: dw,
    h: dh,
    angle,
    op: clampN(p.op, 0.15, 1),
  };
}

/** 0-based page indices a placement stamps; null when a range is invalid. */
export function placementTargets(
  p: SignPlacement,
  pageCount: number
): number[] | null {
  switch (p.pages) {
    case "all":
      return Array.from({ length: pageCount }, (_, i) => i);
    case "odd":
      return Array.from({ length: pageCount }, (_, i) => i).filter(
        (i) => (i + 1) % 2 === 1
      );
    case "even":
      return Array.from({ length: pageCount }, (_, i) => i).filter(
        (i) => (i + 1) % 2 === 0
      );
    case "range":
      return parsePageSpec(p.range ?? "", pageCount);
    default:
      return p.pageIndex >= 0 && p.pageIndex < pageCount ? [p.pageIndex] : null;
  }
}

/** Placements on a given display page (for the strip dots + overlay list). */
export function placementsOnPage(
  placements: readonly SignPlacement[],
  pageIndex: number,
  pageCount: number
): SignPlacement[] {
  const out: SignPlacement[] = [];
  for (const p of placements) {
    const targets = placementTargets(p, pageCount);
    if (targets !== null && targets.includes(pageIndex)) out.push(p);
  }
  return out;
}

const MAX_PLACEMENTS = 60;

/**
 * Defensive parse of the serialized placements option (surface → worker).
 * Bad rows are dropped, never thrown — one corrupt entry can't kill a run.
 */
export function parsePlacementsOption(raw: unknown): SignPlacement[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: SignPlacement[] = [];
  for (const row of parsed) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.sigId !== "string") continue;
    if (r.sigId.length === 0 || r.sigId.length > 80) continue;
    const pages =
      r.pages === "all" || r.pages === "odd" || r.pages === "even" || r.pages === "range"
        ? r.pages
        : "this";
    const range = typeof r.range === "string" ? r.range.slice(0, 120) : undefined;
    const pageIndex =
      typeof r.pageIndex === "number" && Number.isFinite(r.pageIndex)
        ? Math.min(Math.max(Math.round(r.pageIndex), 0), 9999)
        : 0;
    out.push({
      id: r.id.slice(0, 64),
      sigId: r.sigId,
      cx: clampN(asNumber(r.cx, 0.5), 0, 1),
      cy: clampN(asNumber(r.cy, 0.7), 0, 1),
      w: clampN(asNumber(r.w, 0.25), 0.02, 1.5),
      rot: clampN(asNumber(r.rot, 0), -180, 180),
      op: clampN(asNumber(r.op, 1), 0.15, 1),
      pages,
      range,
      pageIndex,
    });
    if (out.length >= MAX_PLACEMENTS) break;
  }
  return out;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp01(n: number): number {
  return Math.min(Math.max(n, 0), 1);
}

function clampN(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
