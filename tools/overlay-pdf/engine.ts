import type { OptionValues } from "@/lib/tools/config-types";
import { parsePageSpec } from "@/lib/workers/protocol";
import {
  WM_POSITIONS,
  positionCenter,
  rotatedStartPoint,
  type WmPosition,
} from "../add-watermark/wm-options";

/**
 * Overlay PDF engine (PRD §8.3 "Overlay") — the pure math shared by the
 * live preview surface (main thread) and the pdf-lib worker, so what you
 * see is exactly what the run draws:
 *
 *   - `resolveOverlayOptions`  coerces raw option values into typed options
 *   - `stampTargets`          picks the 0-based BASE pages that receive the
 *                             overlay (all / first / odd / even / range)
 *   - `overlayPageFor`        maps one stamped base page to the 0-based
 *                             OVERLAY page that lands on it (first / match /
 *                             cycle) — null skips the base page honestly
 *   - `overlayPlacement`      computes the draw box (scale = % of the base
 *                             page width, overlay aspect kept), the 9-grid
 *                             center and the pdf-lib rotate-aware start
 *                             point (watermark-round math, re-verified)
 *   - `stampedCount`          drives the "N of M pages stamped" chip
 *
 * The overlay rides as a real embedded page (pdf-lib `embedPdf` +
 * `drawPage` with opacity/rotation) — vector content, selectable text and
 * the overlay's own transparency all survive; nothing is rasterized.
 */

export type OverlayPosition = WmPosition;
export type StampPages = "all" | "first" | "odd" | "even" | "range";
export type OverlaySource = "first" | "match" | "cycle";

export const STAMP_PAGES: StampPages[] = [
  "all",
  "first",
  "odd",
  "even",
  "range",
];

export const OVERLAY_SOURCES: OverlaySource[] = ["first", "match", "cycle"];

/** Option ids the panel writes and the worker reads. */
export const OV_IDS = {
  position: "position",
  margin: "margin",
  scale: "scale",
  opacity: "opacity",
  rotation: "rotation",
  behind: "behind",
  stampPages: "stampPages",
  pages: "pages",
  source: "source",
} as const;

export interface OverlayOptions {
  /** 9-grid anchor for the overlay box center. */
  position: OverlayPosition;
  /** Distance from the page edge, PDF points. */
  margin: number;
  /** Overlay box width as % of the BASE page width (aspect kept). */
  scale: number;
  /** 0.05..1 — pdf-lib drawPage opacity. */
  opacity: number;
  /** -90..90 degrees, applied around the draw start point. */
  rotation: number;
  /** Draw under the base content (stream reorder, watermark technique). */
  behind: boolean;
  /** Which BASE pages receive the overlay. */
  stampPages: StampPages;
  /** Range spec when stampPages === "range". */
  pages: string;
  /** Which overlay page lands on each stamped base page. */
  source: OverlaySource;
}

export const OV_DEFAULTS: OverlayOptions = {
  position: "mc",
  margin: 24,
  scale: 100,
  opacity: 1,
  rotation: 0,
  behind: false,
  stampPages: "all",
  pages: "all",
  source: "first",
};

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Coerces raw option values into the typed overlay options. */
export function resolveOverlayOptions(values: OptionValues): OverlayOptions {
  const positionRaw = asString(values[OV_IDS.position], OV_DEFAULTS.position);
  const position = WM_POSITIONS.includes(positionRaw as WmPosition)
    ? (positionRaw as WmPosition)
    : OV_DEFAULTS.position;
  const stampRaw = asString(values[OV_IDS.stampPages], OV_DEFAULTS.stampPages);
  const stampPages = STAMP_PAGES.includes(stampRaw as StampPages)
    ? (stampRaw as StampPages)
    : OV_DEFAULTS.stampPages;
  const sourceRaw = asString(values[OV_IDS.source], OV_DEFAULTS.source);
  const source = OVERLAY_SOURCES.includes(sourceRaw as OverlaySource)
    ? (sourceRaw as OverlaySource)
    : OV_DEFAULTS.source;
  return {
    position,
    margin: clamp(Math.round(asNumber(values[OV_IDS.margin], OV_DEFAULTS.margin)), 0, 96),
    scale: clamp(
      Math.round(asNumber(values[OV_IDS.scale], OV_DEFAULTS.scale)),
      10,
      150
    ),
    opacity: clamp(asNumber(values[OV_IDS.opacity], OV_DEFAULTS.opacity), 0.05, 1),
    rotation: clamp(
      Math.round(asNumber(values[OV_IDS.rotation], OV_DEFAULTS.rotation)),
      -90,
      90
    ),
    behind: asBool(values[OV_IDS.behind], OV_DEFAULTS.behind),
    stampPages,
    pages: asString(values[OV_IDS.pages], OV_DEFAULTS.pages),
    source,
  };
}

/**
 * 0-based BASE page indices that receive the overlay. null = invalid range
 * spec; [] = nothing selected (e.g. a range that matches no page).
 */
export function stampTargets(
  opts: Pick<OverlayOptions, "stampPages" | "pages">,
  baseCount: number
): number[] | null {
  switch (opts.stampPages) {
    case "all": {
      const all: number[] = [];
      for (let i = 0; i < baseCount; i += 1) all.push(i);
      return all;
    }
    case "first":
      return baseCount > 0 ? [0] : [];
    case "odd": {
      const odd: number[] = [];
      for (let i = 0; i < baseCount; i += 2) odd.push(i); // 1-based odd
      return odd;
    }
    case "even": {
      const even: number[] = [];
      for (let i = 1; i < baseCount; i += 2) even.push(i); // 1-based even
      return even;
    }
    case "range": {
      const spec = opts.pages.trim() === "" ? "all" : opts.pages;
      return parsePageSpec(spec, baseCount);
    }
  }
}

/**
 * The 0-based OVERLAY page that lands on the given stamped base page, or
 * null when this mapping has no overlay page for it (match mode with a
 * shorter overlay leaves the surplus base pages untouched — honestly).
 */
export function overlayPageFor(
  source: OverlaySource,
  baseIndex: number,
  overlayCount: number
): number | null {
  if (overlayCount <= 0) return null;
  switch (source) {
    case "first":
      return 0;
    case "match":
      return baseIndex < overlayCount ? baseIndex : null;
    case "cycle":
      return baseIndex % overlayCount;
  }
}

/** Draw box in PDF points: scale % of the base width, overlay aspect kept. */
export function overlayBox(
  baseW: number,
  baseH: number,
  ovW: number,
  ovH: number,
  scalePct: number
): { boxW: number; boxH: number } {
  const boxW = Math.max(1, (baseW * scalePct) / 100);
  const boxH = boxW * (ovH / Math.max(1, ovW));
  return { boxW, boxH };
}

/**
 * Full placement for one base page: the draw box, the 9-grid center and the
 * rotate-aware pdf-lib start point (drawPage rotates around (x, y) exactly
 * like drawImage — the watermark-round math applies unchanged).
 */
export function overlayPlacement(
  baseW: number,
  baseH: number,
  ovW: number,
  ovH: number,
  opts: Pick<
    OverlayOptions,
    "position" | "margin" | "scale" | "rotation"
  >
): {
  boxW: number;
  boxH: number;
  cx: number;
  cy: number;
  sx: number;
  sy: number;
} {
  const { boxW, boxH } = overlayBox(baseW, baseH, ovW, ovH, opts.scale);
  const { cx, cy } = positionCenter(
    opts.position,
    baseW,
    baseH,
    boxW,
    boxH,
    opts.margin
  );
  const { sx, sy } = rotatedStartPoint(cx, cy, boxW, boxH, opts.rotation);
  return { boxW, boxH, cx, cy, sx, sy };
}

/**
 * How many base pages actually receive the overlay under the current
 * mapping (targets × overlay availability). null = invalid range spec.
 */
export function stampedCount(
  opts: Pick<OverlayOptions, "stampPages" | "pages" | "source">,
  baseCount: number,
  overlayCount: number
): number | null {
  const targets = stampTargets(opts, baseCount);
  if (targets === null) return null;
  let n = 0;
  for (const index of targets) {
    if (overlayPageFor(opts.source, index, overlayCount) !== null) n += 1;
  }
  return n;
}

/** Error classification for the worker catch (password vs corrupt vs generic). */
export function classifyOverlayError(message: string): string {
  if (/password|encrypt/i.test(message)) return "tool.errorEncrypted";
  if (/no pages/i.test(message)) return "overlay.errorNoPages";
  if (/corrupt|parse|invalid/i.test(message)) return "tool.errorCorrupt";
  return "tool.errorCorrupt";
}
