/**
 * Photo collage shared model (PRD §"Photo collage" — the 62nd tool) —
 * PURE data + math used by the surface (live preview), the worker
 * (PDF/JPG/PNG export) and the smoke script, so what you preview is
 * exactly what exports.
 *
 * A layout is a set of normalized rects (x, y, w, h in 0..1) that tile
 * the unit square with no overlap. computePages() pours the photo list
 * into pages of that template (a partially-filled last page keeps the
 * template with trailing empty cells). Everything downstream (cellRectIn
 * Area, coverCrop, pagePixelSize) is deterministic pixel math off those
 * rects + the CollageStyle wire format below.
 */

import type { L10n } from "@/lib/tools/registry";

/* ------------------------------ layouts ------------------------------ */

export type LayoutId =
  | "duo"
  | "duo-stack"
  | "trio-top"
  | "trio-left"
  | "trio-col"
  | "quad"
  | "six"
  | "nine"
  | "mosaic"
  | "filmstrip";

/** One cell of a template — normalized rect inside the unit square. */
export interface LayoutCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutDef {
  id: LayoutId;
  label: L10n;
  cells: LayoutCell[];
}

const THIRD = 1 / 3;

/** Ten tiling templates (unit square, exact cover, no overlap). */
export const LAYOUTS: LayoutDef[] = [
  {
    id: "duo",
    label: { en: "Two side by side", hi: "दो साथ-साथ" },
    cells: [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ],
  },
  {
    id: "duo-stack",
    label: { en: "Two stacked", hi: "दो ऊपर-नीचे" },
    cells: [
      { x: 0, y: 0, w: 1, h: 0.5 },
      { x: 0, y: 0.5, w: 1, h: 0.5 },
    ],
  },
  {
    id: "trio-top",
    label: { en: "One wide + two", hi: "एक चौड़ा + दो" },
    cells: [
      { x: 0, y: 0, w: 1, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
  {
    id: "trio-left",
    label: { en: "One tall + two", hi: "एक लंबा + दो" },
    cells: [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
  {
    id: "trio-col",
    label: { en: "Three columns", hi: "तीन कॉलम" },
    cells: [
      { x: 0, y: 0, w: THIRD, h: 1 },
      { x: THIRD, y: 0, w: THIRD, h: 1 },
      { x: 2 * THIRD, y: 0, w: THIRD, h: 1 },
    ],
  },
  {
    id: "quad",
    label: { en: "Four (2×2)", hi: "चार (2×2)" },
    cells: [
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
  {
    id: "six",
    label: { en: "Six (2×3)", hi: "छह (2×3)" },
    cells: Array.from({ length: 6 }, (_, i) => ({
      x: (i % 2) * 0.5,
      y: Math.floor(i / 2) * THIRD,
      w: 0.5,
      h: THIRD,
    })),
  },
  {
    id: "nine",
    label: { en: "Nine (3×3)", hi: "नौ (3×3)" },
    cells: Array.from({ length: 9 }, (_, i) => ({
      x: (i % 3) * THIRD,
      y: Math.floor(i / 3) * THIRD,
      w: THIRD,
      h: THIRD,
    })),
  },
  {
    id: "mosaic",
    label: { en: "Hero + two", hi: "मुख्य + दो" },
    cells: [
      { x: 0, y: 0, w: 2 * THIRD, h: 1 },
      { x: 2 * THIRD, y: 0, w: THIRD, h: 0.5 },
      { x: 2 * THIRD, y: 0.5, w: THIRD, h: 0.5 },
    ],
  },
  {
    id: "filmstrip",
    label: { en: "Filmstrip", hi: "फ़िल्मस्ट्रिप" },
    cells: [
      { x: 0, y: 0, w: 1, h: THIRD },
      { x: 0, y: THIRD, w: 1, h: THIRD },
      { x: 0, y: 2 * THIRD, w: 1, h: THIRD },
    ],
  },
];

const LAYOUT_BY_ID = new Map<string, LayoutDef>(
  LAYOUTS.map((layout) => [layout.id, layout])
);

/** Safe lookup — unknown ids fall back to the 2×2 grid. */
export function layoutById(id: string): LayoutDef {
  return LAYOUT_BY_ID.get(id) ?? (LAYOUT_BY_ID.get("quad") as LayoutDef);
}

export function isLayoutId(id: string): boolean {
  return LAYOUT_BY_ID.has(id);
}

/* ---------------------------- pagination ---------------------------- */

export interface PageCell extends LayoutCell {
  /** Index into the flat photo order, or null for an empty trailing cell. */
  photo: number | null;
}

export interface PagePlan {
  /** 0-based page number. */
  index: number;
  cells: PageCell[];
}

export function photosPerPage(layoutId: string): number {
  return layoutById(layoutId).cells.length;
}

/**
 * Pours `photoCount` photos into pages of the template: cells fill in
 * order, a partial last page keeps the template with null trailing
 * cells (the background shows through, honestly).
 */
export function computePages(photoCount: number, layoutId: string): PagePlan[] {
  const layout = layoutById(layoutId);
  const perPage = layout.cells.length;
  const count = Math.max(0, Math.floor(photoCount));
  if (count === 0 || perPage === 0) return [];
  const pageCount = Math.ceil(count / perPage);
  const pages: PagePlan[] = [];
  for (let p = 0; p < pageCount; p += 1) {
    const cells: PageCell[] = layout.cells.map((cell, c) => {
      const photo = p * perPage + c;
      return { ...cell, photo: photo < count ? photo : null };
    });
    pages.push({ index: p, cells });
  }
  return pages;
}

/* ------------------------------- style ------------------------------- */

export type CollageFormat = "a4" | "letter" | "square" | "photo4x6";
export type CollageOrientation = "portrait" | "landscape";
export type CollageBackground = "white" | "soft" | "dark" | "custom";
export type CollageRadius = "none" | "soft" | "round";
export type CollageGap = "none" | "thin" | "cozy";
export type CollageMargin = "none" | "thin" | "cozy";
export type CollageFit = "cover" | "contain";
export type ExportFormat = "pdf" | "jpg" | "png";
export type CollageQuality = "high" | "balanced" | "light";

/** Full collage recipe (the wire format lives in CollageOption below). */
export interface CollageStyle {
  format: CollageFormat;
  orientation: CollageOrientation;
  layout: string;
  background: CollageBackground;
  /** Hex #rrggbb — used when background === "custom". */
  customColor: string;
  radius: CollageRadius;
  gap: CollageGap;
  margin: CollageMargin;
  fit: CollageFit;
  polaroid: boolean;
  /** Page title drawn above the grid (empty = none). */
  title: string;
  /** Polaroid captions, aligned with the photo order. */
  captions: string[];
}

export const MAX_PHOTOS = 50;
export const MAX_CAPTION_CHARS = 60;
export const MAX_TITLE_CHARS = 120;
export const MAX_CAPTIONS = 200;

/**
 * JPEG encode quality per output preset. "high" is the long-standing
 * default (the exact 0.92 the tool shipped with). The collage raster is
 * always composited on an opaque page background first (render.ts fills
 * the full page), so JPEG is alpha-safe for EVERY template — no preset
 * ever needs a transparent encode.
 */
export const JPEG_QUALITY: Record<CollageQuality, number> = {
  high: 0.92,
  balanced: 0.8,
  light: 0.65,
};

export const DEFAULT_STYLE: CollageStyle = {
  format: "a4",
  orientation: "portrait",
  layout: "quad",
  background: "white",
  customColor: "#f5f1ea",
  radius: "soft",
  gap: "thin",
  margin: "cozy",
  fit: "cover",
  polaroid: false,
  title: "",
  captions: [],
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** #rrggbb or the fallback (soft warm paper tone). */
export function sanitizeHexColor(value: unknown, fallback = "#f5f1ea"): string {
  return typeof value === "string" && HEX_RE.test(value.trim())
    ? value.trim().toLowerCase()
    : fallback;
}

function pickString<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function clampText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // Trim to whole characters and drop control characters.
  return value
    .replace(/[\u0000-\u001f]/g, "")
    .slice(0, max)
    .trimEnd();
}

/** Garbage in → defaults out. Every field is validated independently. */
export function sanitizeStyle(value: unknown): CollageStyle {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const captions = Array.isArray(raw.captions)
    ? raw.captions
        .slice(0, MAX_CAPTIONS)
        .map((item) => clampText(item, MAX_CAPTION_CHARS))
    : [];
  return {
    format: pickString(raw.format, ["a4", "letter", "square", "photo4x6"] as const, "a4"),
    orientation: pickString(raw.orientation, ["portrait", "landscape"] as const, "portrait"),
    layout: isLayoutId(String(raw.layout)) ? String(raw.layout) : DEFAULT_STYLE.layout,
    background: pickString(
      raw.background,
      ["white", "soft", "dark", "custom"] as const,
      "white"
    ),
    customColor: sanitizeHexColor(raw.customColor),
    radius: pickString(raw.radius, ["none", "soft", "round"] as const, DEFAULT_STYLE.radius),
    gap: pickString(raw.gap, ["none", "thin", "cozy"] as const, DEFAULT_STYLE.gap),
    margin: pickString(raw.margin, ["none", "thin", "cozy"] as const, DEFAULT_STYLE.margin),
    fit: pickString(raw.fit, ["cover", "contain"] as const, DEFAULT_STYLE.fit),
    polaroid: raw.polaroid === true,
    title: clampText(raw.title, MAX_TITLE_CHARS),
    captions,
  };
}

/* --------------------------- wire format ---------------------------- */

/** [source file index, quarter-turn rotation] — the imagegrid pattern. */
export type CollagePhoto = [source: number, rotation: number];

export interface CollageOption {
  photos: CollagePhoto[];
  style: CollageStyle;
  /** What the Run CTA produces (jpg/png render page 1). */
  exportFormat: ExportFormat;
  /** JPEG encode quality for the PDF page rasters + JPG export.
 *  Optional so older serialized options keep parsing; "high" is the
 *  default. PNG export is lossless and ignores it. */
  quality?: CollageQuality;
  /** UI locale — drives the localized output file name (workers have none). */
  locale: "en" | "hi";
}

export const EXPORT_FORMATS = ["pdf", "jpg", "png"] as const;

export function serializeCollage(option: CollageOption): string {
  return JSON.stringify(option);
}

/**
 * Parses the "collage" option. Falls back to the natural order +
 * defaults for missing/empty values (the state before any edit);
 * structurally invalid data (bad JSON, out-of-range sources) also
 * falls back rather than killing the run — sanitizeStyle already
 * guarantees a drawable recipe either way.
 */
export function parseCollageOption(
  value: unknown,
  fileCount: number
): CollageOption {
  if (value === undefined || value === null || value === "") {
    return {
      photos: Array.from({ length: fileCount }, (_, source): CollagePhoto => [source, 0]),
      style: { ...DEFAULT_STYLE, captions: [] },
      exportFormat: "pdf",
      quality: "high",
      locale: "en",
    };
  }
  let parsed: unknown = null;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
  }
  const raw = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  const photos: CollagePhoto[] = [];
  if (Array.isArray(raw.photos)) {
    for (const item of raw.photos) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [source, rotation] = item;
      if (
        typeof source === "number" &&
        Number.isInteger(source) &&
        source >= 0 &&
        source < fileCount &&
        typeof rotation === "number" &&
        [0, 90, 180, 270].includes(rotation)
      ) {
        photos.push([source, rotation]);
      }
    }
  }
  if (photos.length === 0 && fileCount > 0) {
    // Every entry was invalid (or none shipped): natural order.
    for (let source = 0; source < fileCount; source += 1) photos.push([source, 0]);
  }
  const style = sanitizeStyle(raw.style);
  const exportFormat = pickString(raw.exportFormat, EXPORT_FORMATS, "pdf");
  const quality = pickString(
    raw.quality,
    ["high", "balanced", "light"] as const,
    "high"
  );
  const locale = pickString(raw.locale, ["en", "hi"] as const, "en");
  // Keep captions aligned with the photo count (pad/trim defensively).
  const captions = style.captions.slice(0, photos.length);
  while (captions.length < photos.length) captions.push("");
  return { photos, style: { ...style, captions }, exportFormat, quality, locale };
}

/* ---------------------------- pixel math ---------------------------- */

/** Worker canvases render at 2 px per PDF point (a clean ~144 DPI raster). */
export const PX_PER_PT = 2;

const A4_PT: [number, number] = [595.28, 841.89];
const LETTER_PT: [number, number] = [612, 792];
const SQUARE_PT = 595.28;
/** Classic 4×6 print: 4 in × 6 in at 72 pt/in. */
const PHOTO_4X6_PT: [number, number] = [288, 432];

/** Page size in PDF points (landscape swaps the axes; square ignores it). */
export function pagePtSize(style: CollageStyle): { w: number; h: number } {
  const base: [number, number] =
    style.format === "letter"
      ? LETTER_PT
      : style.format === "square"
        ? [SQUARE_PT, SQUARE_PT]
        : style.format === "photo4x6"
          ? PHOTO_4X6_PT
          : A4_PT;
  if (style.format === "square") return { w: base[0], h: base[1] };
  return style.orientation === "landscape"
    ? { w: base[1], h: base[0] }
    : { w: base[0], h: base[1] };
}

/** Worker/export canvas size in pixels (pt × PX_PER_PT). */
export function pagePixelSize(style: CollageStyle): { w: number; h: number } {
  const pt = pagePtSize(style);
  return { w: Math.round(pt.w * PX_PER_PT), h: Math.round(pt.h * PX_PER_PT) };
}

/** Gap between cells, in PDF points per preset. */
export const GAP_PT: Record<CollageGap, number> = { none: 0, thin: 8, cozy: 18 };
/** Page margin, in PDF points per preset. */
export const MARGIN_PT: Record<CollageMargin, number> = { none: 0, thin: 16, cozy: 34 };
/** Corner radius as a ratio of the page's short edge. */
export const RADIUS_RATIO: Record<CollageRadius, number> = {
  none: 0,
  soft: 0.022,
  round: 0.06,
};
/** Title band height in PDF points (reserved above the grid). */
export const TITLE_BAND_PT = 44;
/** Page-number chip height in PDF points (multi-page, margin > none). */
export const PAGE_TAG_PT = 16;

/** Title font size in PDF points — scales with the page width, clamped. */
export function titleFontPt(style: CollageStyle): number {
  return Math.min(30, Math.max(15, Math.round(pagePtSize(style).w * 0.042)));
}

export interface RectPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Maps a normalized cell into a pixel area, insetting interior edges by
 * half the gap so gutters between neighbours are exactly `gapPx` wide
 * while cells touching the margin stay flush. Exact tiling: the inset
 * edges + gutters always sum back to the area.
 */
export function cellRectInArea(cell: LayoutCell, area: RectPx, gapPx: number): RectPx {
  const half = gapPx / 2;
  const inset = (edge: number): number => (edge > 0 && edge < 1 ? half : 0);
  const left = inset(cell.x);
  const top = inset(cell.y);
  const right = inset(cell.x + cell.w);
  const bottom = inset(cell.y + cell.h);
  return {
    x: area.x + cell.x * area.w + left,
    y: area.y + cell.y * area.h + top,
    w: cell.w * area.w - left - right,
    h: cell.h * area.h - top - bottom,
  };
}

/** Full-page variant (margin box = the cell area). */
export function cellRectPx(
  cell: LayoutCell,
  pageW: number,
  pageH: number,
  marginPx: number,
  gapPx: number
): RectPx {
  return cellRectInArea(
    cell,
    { x: marginPx, y: marginPx, w: pageW - marginPx * 2, h: pageH - marginPx * 2 },
    gapPx
  );
}

export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Cover-crop: the largest centred source rect whose aspect matches the
 * destination, for drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh).
 */
export function coverCrop(sw: number, sh: number, dw: number, dh: number): CropRect {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return { sx: 0, sy: 0, sw: 0, sh: 0 };
  const scale = Math.max(dw / sw, dh / sh);
  const cropW = dw / scale;
  const cropH = dh / scale;
  return {
    sx: (sw - cropW) / 2,
    sy: (sh - cropH) / 2,
    sw: cropW,
    sh: cropH,
  };
}

/** Contain-fit destination rect (centred, letterboxed). */
export function containFit(
  sw: number,
  sh: number,
  dw: number,
  dh: number
): RectPx {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.min(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}

/* ------------------------- decode cap (RAM) ------------------------- */

/**
 * Long-edge pixel cap for decoded collage photos (the mobile OOM guard).
 * The export raster is 2 px/pt, so the largest cell ANY template can
 * draw — a full-height duo/filmstrip cell on A4 ≈ 1684 px — sits
 * comfortably below 2048: normal photos keep full cell resolution
 * (zero copies), while 50 × 12-megapixel phone shots can never be held
 * in RAM at full size at once.
 */
export const PHOTO_LONG_EDGE_CAP = 2048;

/**
 * Per-photo decode cap in px for the chosen style: at least the generous
 * default, never below the largest cell the template can draw at export
 * resolution (future page formats stay honest — a photo is never decoded
 * to less than its cell can display).
 */
export function photoDecodeCap(style: CollageStyle): number {
  const cells = layoutById(style.layout).cells;
  const px = pagePixelSize(style);
  let maxCellLongEdge = 0;
  for (const cell of cells) {
    maxCellLongEdge = Math.max(maxCellLongEdge, cell.w * px.w, cell.h * px.h);
  }
  return Math.ceil(Math.max(PHOTO_LONG_EDGE_CAP, maxCellLongEdge));
}

/* --------------------------- backgrounds ---------------------------- */

/**
 * Background presets — warm paper tones, no indigo/blue. Values are hex
 * so the canvas, the preview and the UI swatches all agree.
 */
export const BACKGROUND_COLORS: Record<Exclude<CollageBackground, "custom">, string> = {
  white: "#ffffff",
  soft: "#f5f1ea",
  dark: "#1c1917",
};

export function backgroundHex(style: CollageStyle): string {
  if (style.background === "custom") return sanitizeHexColor(style.customColor);
  return BACKGROUND_COLORS[style.background];
}

/** Perceived luminance 0..1 for ink-on-background colour choices. */
export function hexLuminance(hex: string): number {
  const clean = sanitizeHexColor(hex, "#ffffff").slice(1);
  const r = Number.parseInt(clean.slice(0, 2), 16) / 255;
  const g = Number.parseInt(clean.slice(2, 4), 16) / 255;
  const b = Number.parseInt(clean.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Dark ink on light pages, light ink on dark ones. */
export function inkHex(background: string): string {
  return hexLuminance(background) > 0.55 ? "#1c1917" : "#faf9f7";
}

/* ---------------------------- captions ------------------------------ */

/**
 * Default polaroid caption: the file name without its extension,
 * trimmed to the caption budget.
 */
export function defaultCaptionFor(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "").replace(/[\u0000-\u001f]/g, " ").trim();
  return stem.slice(0, MAX_CAPTION_CHARS);
}

/** Localized output base name (create-pdf's localized-filename pattern). */
export function outputBaseName(
  locale: "en" | "hi",
  exportFormat: ExportFormat
): string {
  const base = locale === "hi" ? "फ़ोटो-कोलाज" : "photo-collage";
  return `${base}.${exportFormat}`;
}
