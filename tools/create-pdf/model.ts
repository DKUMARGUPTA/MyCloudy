/**
 * Create PDF — PURE paper-template layout math (PRD §7.3 "Create PDF":
 * instant ready-made paper & planner PDFs, no document needed).
 *
 * planPages(spec) turns a sanitized template spec into plain drawing data
 * (lines / dots / rects / labels in PDF points, origin bottom-left) that
 * the worker paints with pdf-lib and the surface renders as a scaled live
 * preview — the same pure-engine-for-both recipe as write-pdf. Everything
 * here is pure and headlessly testable: no DOM, no pdf-lib imports, all
 * inputs clamped/sanitized.
 *
 * Hindi planner day labels ride the embedded Noto Devanagari font; the
 * label entries carry their font need ("helv" | "noto") so the worker only
 * loads Noto when the plan actually needs it.
 */

/* ------------------------------------------------------------------ */
/* Spec (wire format)                                                  */
/* ------------------------------------------------------------------ */

export type CTemplate =
  | "blank"
  | "lined"
  | "grid"
  | "dotted"
  | "cornell"
  | "planner";
export type CPageSize = "a4" | "letter" | "a5" | "legal";
export type COrientation = "portrait" | "landscape";
export type CMargin = "none" | "narrow" | "normal";
export type CLineSpacing = "college" | "wide" | "narrow";
export type CGridSize = "5mm" | "2.5mm";
export type CLocale = "en" | "hi";

export interface CSpec {
  template: CTemplate;
  pageSize: CPageSize;
  orientation: COrientation;
  pages: number;
  margin: CMargin;
  lineSpacing: CLineSpacing;
  gridSize: CGridSize;
  /** Red margin rule (lined + cornell). */
  marginLine: boolean;
  /** Name / date / topic line at the top (cornell). */
  headerLine: boolean;
  /** Drives planner day labels + output base name (workers have no locale). */
  locale: CLocale;
}

export const DEFAULT_C_SPEC: CSpec = {
  template: "lined",
  pageSize: "a4",
  orientation: "portrait",
  pages: 1,
  margin: "normal",
  lineSpacing: "college",
  gridSize: "5mm",
  marginLine: true,
  headerLine: true,
  locale: "en",
};

/* ------------------------------------------------------------------ */
/* Geometry presets                                                    */
/* ------------------------------------------------------------------ */

export const C_PAGE_SIZES: Record<CPageSize, { width: number; height: number }> =
  {
    a4: { width: 595.28, height: 841.89 },
    letter: { width: 612, height: 792 },
    a5: { width: 419.53, height: 595.28 },
    legal: { width: 612, height: 1008 },
  };

const MM = 72 / 25.4; // 2.834645669… pt per mm

export const C_MARGINS: Record<CMargin, number> = {
  none: 0,
  narrow: 36,
  normal: 72,
};

/** Ruled-line spacing presets (classic US notebook pitches). */
export const C_LINE_SPACING: Record<CLineSpacing, number> = {
  college: 7.1 * MM, // 20.13 pt
  wide: 8.7 * MM, // 24.66 pt
  narrow: 6.35 * MM, // 18.00 pt
};

export const C_GRID_SIZES: Record<CGridSize, number> = {
  "5mm": 5 * MM, // 14.17 pt
  "2.5mm": 2.5 * MM, // 7.09 pt
};

export const C_DOT_SPACING = 5 * MM;
export const C_DOT_RADIUS = 0.75;

/** Page-count caps (planner = one week per page). */
export function maxPagesFor(template: CTemplate): number {
  return template === "planner" ? 12 : 50;
}

/* Ink colors (hex — neutral greys + the classic red margin rule). */
const INK_RULE = "#a6adb6"; // ruled lines
const INK_GRID = "#b7bec6"; // grid lines + dots
const INK_STRONG = "#6f7680"; // structural lines (cornell, planner rows)
const INK_FAINT = "#cfd4da"; // planner writing lines
const INK_MARGIN = "#e05252"; // red margin rule
const INK_TEXT = "#3f4650"; // labels

/* ------------------------------------------------------------------ */
/* Plan output (worker paints it; preview renders it as DOM)           */
/* ------------------------------------------------------------------ */

export interface CLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width?: number;
}

export interface CDot {
  x: number;
  y: number;
  r: number;
  color: string;
}

export interface CRect {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

export interface CLabel {
  text: string;
  /** Anchor: left edge (left), centre (center) or right edge (right). */
  x: number;
  /** Text baseline. */
  y: number;
  size: number;
  font: "helv" | "noto";
  align: "left" | "center" | "right";
  color?: string;
}

export interface CPage {
  lines: CLine[];
  dots: CDot[];
  rects: CRect[];
  labels: CLabel[];
}

export interface CPlan {
  pages: CPage[];
  width: number;
  height: number;
  template: CTemplate;
  /** True when any label needs the embedded Devanagari font. */
  needNoto: boolean;
}

/* ------------------------------------------------------------------ */
/* Localized PDF content (write-pdf templates.ts precedent — content,  */
/* not UI chrome, so it lives beside the layout math)                  */
/* ------------------------------------------------------------------ */

export const C_DAY_NAMES: Record<CLocale, string[]> = {
  en: [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ],
  hi: [
    "सोमवार",
    "मंगलवार",
    "बुधवार",
    "गुरुवार",
    "शुक्रवार",
    "शनिवार",
    "रविवार",
  ],
};

export const C_NOTES_LABEL: Record<CLocale, string> = {
  en: "Notes",
  hi: "टिप्पणियाँ",
};

const C_BASE_NAMES: Record<CTemplate, Record<CLocale, string>> = {
  blank: { en: "blank-pages", hi: "खाली-पेज" },
  lined: { en: "lined-paper", hi: "रूल्ड-पेज" },
  grid: { en: "grid-paper", hi: "ग्रिड-पेज" },
  dotted: { en: "dot-grid-paper", hi: "डॉट-ग्रिड-पेज" },
  cornell: { en: "cornell-notes", hi: "कॉर्नेल-नोट्स" },
  planner: { en: "weekly-planner", hi: "साप्ताहिक-प्लानर" },
};

/** Output filename: template base (localized) + size + orientation. */
export function cOutputName(spec: CSpec): string {
  const parts = [C_BASE_NAMES[spec.template][spec.locale], spec.pageSize];
  if (spec.orientation === "landscape") parts.push("landscape");
  return `${parts.join("-")}.pdf`;
}

/* ------------------------------------------------------------------ */
/* Sanitizer (never trust the blob)                                    */
/* ------------------------------------------------------------------ */

function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickPages(template: CTemplate, value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(Math.round(n), 1), maxPagesFor(template));
}

export function sanitizeCSpec(input: unknown): CSpec {
  const raw = (typeof input === "object" && input !== null
    ? input
    : {}) as Record<string, unknown>;
  const template = pickEnum(
    raw.template,
    ["blank", "lined", "grid", "dotted", "cornell", "planner"] as const,
    DEFAULT_C_SPEC.template
  );
  return {
    template,
    pageSize: pickEnum(
      raw.pageSize,
      ["a4", "letter", "a5", "legal"] as const,
      DEFAULT_C_SPEC.pageSize
    ),
    orientation: pickEnum(
      raw.orientation,
      ["portrait", "landscape"] as const,
      DEFAULT_C_SPEC.orientation
    ),
    pages: pickPages(template, raw.pages),
    margin: pickEnum(
      raw.margin,
      ["none", "narrow", "normal"] as const,
      DEFAULT_C_SPEC.margin
    ),
    lineSpacing: pickEnum(
      raw.lineSpacing,
      ["college", "wide", "narrow"] as const,
      DEFAULT_C_SPEC.lineSpacing
    ),
    gridSize: pickEnum(
      raw.gridSize,
      ["5mm", "2.5mm"] as const,
      DEFAULT_C_SPEC.gridSize
    ),
    marginLine: pickBool(raw.marginLine, DEFAULT_C_SPEC.marginLine),
    headerLine: pickBool(raw.headerLine, DEFAULT_C_SPEC.headerLine),
    locale: pickEnum(raw.locale, ["en", "hi"] as const, DEFAULT_C_SPEC.locale),
  };
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

interface Box {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

function emptyPage(): CPage {
  return { lines: [], dots: [], rects: [], labels: [] };
}

function buildLined(spec: CSpec, box: Box): CPage {
  const page = emptyPage();
  const spacing = C_LINE_SPACING[spec.lineSpacing];
  for (let y = box.bottom + spacing; y <= box.top + 0.01; y += spacing) {
    page.lines.push({
      x1: box.left,
      y1: y,
      x2: box.right,
      y2: y,
      color: INK_RULE,
      width: 0.7,
    });
  }
  if (spec.marginLine) {
    page.lines.push({
      x1: box.left + 24,
      y1: box.bottom,
      x2: box.left + 24,
      y2: box.top,
      color: INK_MARGIN,
      width: 0.9,
    });
  }
  return page;
}

/** Grid + dot grids are centred in the content box so partial cells split
 *  evenly on both edges — spacing stays EXACT, only the anchor shifts. */
function centeredOffset(content: number, step: number): number {
  const cells = Math.floor(content / step + 1e-6);
  return (content - cells * step) / 2;
}

function buildGrid(spec: CSpec, box: Box): CPage {
  const page = emptyPage();
  const g = C_GRID_SIZES[spec.gridSize];
  const offX = centeredOffset(box.right - box.left, g);
  const offY = centeredOffset(box.top - box.bottom, g);
  for (let x = box.left + offX; x <= box.right + 0.01; x += g) {
    page.lines.push({
      x1: x,
      y1: box.bottom,
      x2: x,
      y2: box.top,
      color: INK_GRID,
      width: 0.5,
    });
  }
  for (let y = box.bottom + offY; y <= box.top + 0.01; y += g) {
    page.lines.push({
      x1: box.left,
      y1: y,
      x2: box.right,
      y2: y,
      color: INK_GRID,
      width: 0.5,
    });
  }
  return page;
}

function buildDotted(_spec: CSpec, box: Box): CPage {
  const page = emptyPage();
  const g = C_DOT_SPACING;
  const offX = centeredOffset(box.right - box.left, g);
  const offY = centeredOffset(box.top - box.bottom, g);
  for (let x = box.left + offX; x <= box.right + 0.01; x += g) {
    for (let y = box.bottom + offY; y <= box.top + 0.01; y += g) {
      page.dots.push({ x, y, r: C_DOT_RADIUS, color: INK_GRID });
    }
  }
  return page;
}

function buildCornell(spec: CSpec, box: Box): CPage {
  const page = emptyPage();
  const contentW = box.right - box.left;
  const contentH = box.top - box.bottom;
  // cue column ~2.5 in, shrinking on small paper
  const cueW = Math.min(180, Math.round(contentW * 0.35));
  const dividerX = box.left + cueW;
  page.lines.push({
    x1: dividerX,
    y1: box.bottom,
    x2: dividerX,
    y2: box.top,
    color: INK_STRONG,
    width: 1,
  });
  const summaryH = Math.min(144, Math.round(contentH * 0.25));
  page.lines.push({
    x1: box.left,
    y1: box.bottom + summaryH,
    x2: box.right,
    y2: box.bottom + summaryH,
    color: INK_STRONG,
    width: 1,
  });
  if (spec.headerLine) {
    page.lines.push({
      x1: box.left,
      y1: box.top - 36,
      x2: box.right,
      y2: box.top - 36,
      color: INK_STRONG,
      width: 1,
    });
  }
  if (spec.marginLine) {
    page.lines.push({
      x1: box.left + 24,
      y1: box.bottom,
      x2: box.left + 24,
      y2: box.top,
      color: INK_MARGIN,
      width: 0.9,
    });
  }
  return page;
}

function buildPlanner(spec: CSpec, box: Box): CPage {
  const page = emptyPage();
  const contentH = box.top - box.bottom;
  const notesH = Math.min(110, Math.round(contentH * 0.18));
  const daysH = contentH - notesH;
  const rowH = daysH / 7;
  const dayNames = C_DAY_NAMES[spec.locale];
  const font: "helv" | "noto" = spec.locale === "hi" ? "noto" : "helv";

  for (let i = 0; i < 7; i += 1) {
    const rowTop = box.top - i * rowH;
    const rowBottom = rowTop - rowH;
    // day label at the row's top-left
    page.labels.push({
      text: dayNames[i],
      x: box.left,
      y: rowTop - 11,
      size: 10,
      font,
      align: "left",
      color: INK_TEXT,
    });
    // row separator (the 7th doubles as the notes-area boundary)
    page.lines.push({
      x1: box.left,
      y1: rowBottom,
      x2: box.right,
      y2: rowBottom,
      color: INK_STRONG,
      width: 0.9,
    });
    // faint writing lines inside the row
    for (let y = rowTop - 24; y > rowBottom + 8; y -= 20) {
      page.lines.push({
        x1: box.left,
        y1: y,
        x2: box.right,
        y2: y,
        color: INK_FAINT,
        width: 0.6,
      });
    }
  }

  // notes area (below the 7th separator)
  const notesTop = box.bottom + notesH;
  page.labels.push({
    text: C_NOTES_LABEL[spec.locale],
    x: box.left,
    y: notesTop - 14,
    size: 9,
    font,
    align: "left",
    color: INK_TEXT,
  });
  for (let y = notesTop - 28; y > box.bottom + 10; y -= 20) {
    page.lines.push({
      x1: box.left,
      y1: y,
      x2: box.right,
      y2: y,
      color: INK_FAINT,
      width: 0.6,
    });
  }
  return page;
}

/** Template spec → full drawing plan. Pure; clamps nothing (sanitize first). */
export function planPages(spec: CSpec): CPlan {
  const base = C_PAGE_SIZES[spec.pageSize];
  const width = spec.orientation === "landscape" ? base.height : base.width;
  const height = spec.orientation === "landscape" ? base.width : base.height;
  const m = C_MARGINS[spec.margin];
  const box: Box = {
    left: m,
    right: width - m,
    bottom: m,
    top: height - m,
  };

  let page: CPage;
  switch (spec.template) {
    case "blank":
      page = emptyPage();
      break;
    case "grid":
      page = buildGrid(spec, box);
      break;
    case "dotted":
      page = buildDotted(spec, box);
      break;
    case "cornell":
      page = buildCornell(spec, box);
      break;
    case "planner":
      page = buildPlanner(spec, box);
      break;
    case "lined":
    default:
      page = buildLined(spec, box);
      break;
  }

  const pages = Array.from({ length: spec.pages }, () => page);
  const needNoto =
    spec.locale === "hi" &&
    spec.template === "planner" &&
    page.labels.some((label) => label.font === "noto");
  return { pages, width, height, template: spec.template, needNoto };
}

/* ------------------------------------------------------------------ */
/* Color helper (worker converts hex → pdf-lib channels)               */
/* ------------------------------------------------------------------ */

/** Parses #rrggbb into 0..1 channels (write-pdf parseHexColor recipe). */
export function cHexColor(
  hex: string | undefined
): { r: number; g: number; b: number } {
  if (hex && /^#[0-9a-fA-F]{6}$/.test(hex)) {
    return {
      r: parseInt(hex.slice(1, 3), 16) / 255,
      g: parseInt(hex.slice(3, 5), 16) / 255,
      b: parseInt(hex.slice(5, 7), 16) / 255,
    };
  }
  return { r: 0.247, g: 0.275, b: 0.314 }; // INK_TEXT
}
