import type { OptionValues } from "@/lib/tools/config-types";
import {
  MM_TO_PT,
  displayDims,
  normalizeRotation,
} from "../pages-per-sheet/engine";

/**
 * Change PDF page size (PRD §8.3 "Pages per sheet / Halve / Overlay / Crop /
 * Page size"): "A3/A4/A5/Letter/Legal/custom mm; scale content
 * (fit/fill/none); unify mixed sizes."
 *
 * Pure functions only (no pdf-lib, no pdf.js, no DOM) so the SAME code runs
 * in the live preview panel (pdf.js bitmaps) and in the tool worker
 * (authoritative pdf-lib placement) — the split/crop/nup pattern of one
 * smoke-tested planning module per tool.
 *
 * Coordinate model (inherited from the n-up engine):
 * - Target sizes live in PDF points, Y up (pdf-lib page space).
 * - Source pages are described by their DISPLAY dims (what the reader sees —
 *   /Rotate applied). The worker reads them from pdf-lib getCropBox() +
 *   getRotation(); the panel from pdf.js viewports.
 * - `resizePlacement` takes the page's UNROTATED form dims + /Rotate and
 *   returns the exact pdf-lib drawPage arguments (embedPage does NOT apply
 *   /Rotate), generalizing the n-up embedPlacement anchor math to any
 *   scale mode (fit / fill / none). Pinned by scripts/smoke-pagesize.ts.
 */

export const PGSZ_IDS = {
  size: "size",
  customW: "customW",
  customH: "customH",
  orientation: "orientation",
  scale: "scale",
  pages: "pages",
} as const;

export type PageSizePreset =
  | "a3"
  | "a4"
  | "a5"
  | "letter"
  | "legal"
  | "tabloid"
  | "custom";
export type PageSizeOrientation = "portrait" | "landscape" | "auto";
export type PageSizeScale = "fit" | "fill" | "none";

/** ISO/ANSI sheet sizes in portrait points (1 pt = 1/72 in). */
export const PAGE_SIZE_PRESETS: Record<
  Exclude<PageSizePreset, "custom">,
  { w: number; h: number; mmW: number; mmH: number }
> = {
  a3: { w: 841.89, h: 1190.55, mmW: 297, mmH: 420 },
  a4: { w: 595.28, h: 841.89, mmW: 210, mmH: 297 },
  a5: { w: 419.53, h: 595.28, mmW: 148, mmH: 210 },
  letter: { w: 612, h: 792, mmW: 215.9, mmH: 279.4 },
  legal: { w: 612, h: 1008, mmW: 215.9, mmH: 355.6 },
  tabloid: { w: 792, h: 1224, mmW: 279.4, mmH: 431.8 },
};

export const PGSZ_PRESETS: readonly PageSizePreset[] = [
  "a3",
  "a4",
  "a5",
  "letter",
  "legal",
  "tabloid",
  "custom",
];

/** Custom mm input caps — anything a printer could call a "page". */
export const CUSTOM_MM_MIN = 10;
export const CUSTOM_MM_MAX = 2000;

/**
 * Display-size tolerance (pt): a page whose display dims are within this of
 * the target is treated as already-correct and copied byte-identically
 * (annotations, links and form fields survive), instead of re-embedded.
 */
export const SIZE_TOLERANCE_PT = 0.75;

export interface PageSizeOptions {
  size: PageSizePreset;
  customW: number;
  customH: number;
  orientation: PageSizeOrientation;
  scale: PageSizeScale;
  pages: string;
}

export const PGSZ_DEFAULTS: PageSizeOptions = {
  size: "a4",
  customW: 210,
  customH: 297,
  orientation: "auto",
  scale: "fit",
  pages: "all",
};

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function resolvePageSizeOptions(values: OptionValues): PageSizeOptions {
  const sizeRaw = values[PGSZ_IDS.size];
  const orientationRaw = values[PGSZ_IDS.orientation];
  const scaleRaw = values[PGSZ_IDS.scale];
  return {
    size: (PGSZ_PRESETS as readonly string[]).includes(sizeRaw as string)
      ? (sizeRaw as PageSizePreset)
      : PGSZ_DEFAULTS.size,
    customW: clamp(
      asNumber(values[PGSZ_IDS.customW], PGSZ_DEFAULTS.customW),
      CUSTOM_MM_MIN,
      CUSTOM_MM_MAX
    ),
    customH: clamp(
      asNumber(values[PGSZ_IDS.customH], PGSZ_DEFAULTS.customH),
      CUSTOM_MM_MIN,
      CUSTOM_MM_MAX
    ),
    orientation: (
      ["portrait", "landscape", "auto"] as const
    ).includes(orientationRaw as PageSizeOrientation)
      ? (orientationRaw as PageSizeOrientation)
      : PGSZ_DEFAULTS.orientation,
    scale: (["fit", "fill", "none"] as const).includes(
      scaleRaw as PageSizeScale
    )
      ? (scaleRaw as PageSizeScale)
      : PGSZ_DEFAULTS.scale,
    pages:
      typeof values[PGSZ_IDS.pages] === "string"
        ? (values[PGSZ_IDS.pages] as string)
        : PGSZ_DEFAULTS.pages,
  };
}

/* ------------------------------------------------------------------ */
/* Target size                                                         */
/* ------------------------------------------------------------------ */

/**
 * Target page size in points for ONE source page.
 *
 * - "portrait"/"landscape" force the target orientation (the preset's short
 *   and long side rearranged; custom mm values get the same treatment).
 * - "auto" follows the page's own display aspect (landscape source →
 *   landscape target), which is what mixed portrait/landscape documents
 *   almost always want.
 */
export function targetSizePt(
  opts: Pick<PageSizeOptions, "size" | "customW" | "customH" | "orientation">,
  pageDisplay: { w: number; h: number }
): { w: number; h: number } {
  let base: { w: number; h: number };
  if (opts.size === "custom") {
    base = { w: opts.customW * MM_TO_PT, h: opts.customH * MM_TO_PT };
  } else {
    const preset = PAGE_SIZE_PRESETS[opts.size];
    base = { w: preset.w, h: preset.h };
  }
  const min = Math.min(base.w, base.h);
  const max = Math.max(base.w, base.h);
  if (opts.orientation === "portrait") return { w: min, h: max };
  if (opts.orientation === "landscape") return { w: max, h: min };
  // auto — keep each page's own shape.
  return pageDisplay.w >= pageDisplay.h ? { w: max, h: min } : { w: min, h: max };
}

/** pt → mm rounded to 0.1 (labels only — never used for math). */
export function ptToMm(pt: number): number {
  return Math.round((pt / MM_TO_PT) * 10) / 10;
}

/**
 * Human label for a display size in points: "A4 · 210 × 297 mm" when the
 * size matches a known preset (± 0.75 pt, orientation-insensitive), else
 * "148.2 × 210 mm". Used by the preview panel and the worker report.
 */
export function sizeLabelPt(w: number, h: number): string {
  const min = Math.min(w, h);
  const max = Math.max(w, h);
  for (const [key, preset] of Object.entries(PAGE_SIZE_PRESETS)) {
    if (
      Math.abs(min - preset.w) <= SIZE_TOLERANCE_PT &&
      Math.abs(max - preset.h) <= SIZE_TOLERANCE_PT
    ) {
      const name =
        key === "letter"
          ? "Letter"
          : key === "legal"
            ? "Legal"
            : key === "tabloid"
              ? "Tabloid"
              : key.toUpperCase();
      return `${name} · ${preset.mmW} × ${preset.mmH} mm`;
    }
  }
  return `${ptToMm(min)} × ${ptToMm(max)} mm`;
}

/** True when a page's display size already matches the target (± tolerance). */
export function pageNeedsChange(
  display: { w: number; h: number },
  target: { w: number; h: number }
): boolean {
  return (
    Math.abs(display.w - target.w) > SIZE_TOLERANCE_PT ||
    Math.abs(display.h - target.h) > SIZE_TOLERANCE_PT
  );
}

/* ------------------------------------------------------------------ */
/* Scale + placement                                                    */
/* ------------------------------------------------------------------ */

/**
 * Content scale for a mode:
 * - fit: whole page visible (may leave margins) → min ratio
 * - fill: page fully covered (edges may crop) → max ratio
 * - none: keep the original point size → 1
 */
export function resizeScale(
  mode: PageSizeScale,
  target: { w: number; h: number },
  display: { w: number; h: number }
): number {
  if (mode === "none") return 1;
  const rw = target.w / Math.max(1, display.w);
  const rh = target.h / Math.max(1, display.h);
  return mode === "fit" ? Math.min(rw, rh) : Math.max(rw, rh);
}

export interface ResizePlacement {
  /** drawPage anchor (the form's origin AFTER rotation — see n-up engine). */
  x: number;
  y: number;
  /** drawPage width/height: the form's UNROTATED dims, scaled. */
  width: number;
  height: number;
  /** The pdf-lib draw rotation: (360 − /Rotate) % 360. */
  rotate: 0 | 90 | 180 | 270;
  /** The visible (reader-facing) content box on the target page. */
  visX: number;
  visY: number;
  visW: number;
  visH: number;
  scale: number;
}

/**
 * /Rotate-aware placement of an embedded page onto a target page, for any
 * scale mode — the n-up embedPlacement math generalized (n-up always fits).
 *
 * pdf-lib's drawPage emits `translate(x,y) · rotate(φ) · scale(sx,sy)`, so
 * the anchor sits on a different corner per /Rotate angle (the visible box
 * always occupies the quadrant the rotated axes grow INTO):
 *   /Rotate 0 → bottom-left, 90 → top-left, 180 → top-right, 270 →
 *   bottom-right. `pageW/pageH` are the EMBEDDED form's unrotated dims;
 *   the visible box is the same content with swapped axes for 90/270.
 */
export function resizePlacement(
  target: { w: number; h: number },
  pageW: number,
  pageH: number,
  rotation: number,
  mode: PageSizeScale
): ResizePlacement {
  const source = normalizeRotation(rotation);
  const swap = source === 90 || source === 270;
  const effW = swap ? pageH : pageW;
  const effH = swap ? pageW : pageH;
  const scale = resizeScale(mode, target, { w: effW, h: effH });
  const visW = effW * scale;
  const visH = effH * scale;
  const visX = (target.w - visW) / 2;
  const visY = (target.h - visH) / 2;
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

/* ------------------------------------------------------------------ */
/* Mixed-size inventory (the "unify" overview)                         */
/* ------------------------------------------------------------------ */

export interface SizeInventoryRow {
  /** Display size in points (normalized: portrait form w ≤ h). */
  w: number;
  h: number;
  count: number;
  label: string;
}

/**
 * Groups a document's per-page display sizes into distinct rows (portrait
 * form, 1-pt bucket rounding) with counts — the "mixed sizes found" list the
 * panel shows before the run unifies them.
 */
export function buildSizeInventory(
  displaySizes: { w: number; h: number }[]
): SizeInventoryRow[] {
  const buckets = new Map<string, { w: number; h: number; count: number }>();
  for (const size of displaySizes) {
    const w = Math.round(Math.min(size.w, size.h));
    const h = Math.round(Math.max(size.w, size.h));
    const key = `${w}x${h}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.count += 1;
    else buckets.set(key, { w, h, count: 1 });
  }
  const rows = [...buckets.values()].sort(
    (a, b) => b.count - a.count || a.h - b.h
  );
  return rows.map((row) => ({
    ...row,
    label: sizeLabelPt(row.w, row.h),
  }));
}

/* ------------------------------------------------------------------ */
/* Run report                                                          */
/* ------------------------------------------------------------------ */

export interface PageSizePageOutcome {
  /** 1-based page number. */
  page: number;
  /** Display size before (pt). */
  fromW: number;
  fromH: number;
  /** Target size after (pt) — equals `from` for copied pages. */
  toW: number;
  toH: number;
  /** What happened to this page. */
  method: "resized" | "kept-size" | "kept-unselected";
  /** Content scale applied (1 for copied pages). */
  scale: number;
}

/**
 * Plain-text run report (English — the worker has no locale, the pinned
 * redact/search/cts decision).
 */
export function buildPageSizeReport(
  opts: PageSizeOptions,
  outcomes: PageSizePageOutcome[],
  fileName: string
): string {
  const changed = outcomes.filter((o) => o.method === "resized").length;
  const keptSize = outcomes.filter((o) => o.method === "kept-size").length;
  const unselected = outcomes.filter(
    (o) => o.method === "kept-unselected"
  ).length;
  const lines: string[] = [
    "Page size report",
    "================",
    `File: ${fileName}`,
    `Target: ${
      opts.size === "custom"
        ? `custom ${opts.customW} x ${opts.customH} mm`
        : opts.size.toUpperCase()
    }`,
    `Orientation: ${opts.orientation}`,
    `Scale: ${opts.scale}`,
    `Pages: ${outcomes.length} (${changed} resized, ${keptSize} already correct${
      unselected > 0 ? `, ${unselected} not selected` : ""
    })`,
    "",
    "Page  From (pt)          To (pt)            Scale   Method",
    "----  -----------------  -----------------  ------  --------",
  ];
  for (const o of outcomes.slice(0, 400)) {
    lines.push(
      `${String(o.page).padStart(4)}  ${`${Math.round(o.fromW)} x ${Math.round(o.fromH)}`.padEnd(17)}  ${`${Math.round(o.toW)} x ${Math.round(o.toH)}`.padEnd(17)}  ${(Math.round(o.scale * 100) + "%").padStart(5)}   ${o.method}`
    );
  }
  if (outcomes.length > 400) {
    lines.push(`... and ${outcomes.length - 400} more pages`);
  }
  return lines.join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/* Display dims helper for the worker                                  */
/* ------------------------------------------------------------------ */

/**
 * Worker-side display dims of a pdf-lib page: CropBox (falling back to
 * MediaBox happens inside pdf-lib's getCropBox) with /Rotate applied.
 */
export function pageDisplayDims(
  view: { width: number; height: number },
  rotation: number
): { w: number; h: number } {
  return displayDims(rotation, view.width, view.height);
}
