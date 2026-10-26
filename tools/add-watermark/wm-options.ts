import type { OptionValues } from "@/lib/tools/config-types";
import { parsePageSpec } from "@/lib/workers/protocol";
import { needsUnicodeFont } from "../stamp-common/layout";

/**
 * Watermark option ids, defaults and pure helpers (PRD §8.2 "Watermark").
 *
 * ONE source of truth shared by the panel (writes), the surface preview
 * (reads) and the worker (reads) — so the live preview always matches the
 * real pdf-lib run. The config schema stays EMPTY (split-tool pattern):
 * the panel owns all interactive values; the worker defaults defensively.
 */

export type WmPosition =
  | "tl"
  | "tc"
  | "tr"
  | "ml"
  | "mc"
  | "mr"
  | "bl"
  | "bc"
  | "br";

export type WmLayout = "all" | "odd" | "even" | "skipFirst" | "range";

export type WmFontId =
  | "helvetica"
  | "helveticaBold"
  | "times"
  | "timesBold"
  | "courier"
  | "courierBold";

export const WM_POSITIONS: WmPosition[] = [
  "tl",
  "tc",
  "tr",
  "ml",
  "mc",
  "mr",
  "bl",
  "bc",
  "br",
];

export const WM_FONTS: { id: WmFontId; labelKey: string; css: string }[] = [
  { id: "helvetica", labelKey: "wm.fontHelv", css: "Helvetica, Arial, sans-serif" },
  { id: "helveticaBold", labelKey: "wm.fontHelvBold", css: "Helvetica, Arial, sans-serif" },
  { id: "times", labelKey: "wm.fontTimes", css: "'Times New Roman', Times, serif" },
  { id: "timesBold", labelKey: "wm.fontTimesBold", css: "'Times New Roman', Times, serif" },
  { id: "courier", labelKey: "wm.fontCourier", css: "'Courier New', Courier, monospace" },
  { id: "courierBold", labelKey: "wm.fontCourierBold", css: "'Courier New', Courier, monospace" },
];

export const WM_COLORS: string[] = [
  "#DC2626", // red — the classic
  "#2563EB", // blue
  "#6B7280", // neutral gray
  "#111827", // near black
  "#16A34A", // green
  "#D97706", // amber
  "#7C3AED", // purple
  "#F8FAFC", // white
];

/** Option ids the panel writes and the worker reads. */
export const WM_IDS = {
  type: "wmType",
  text: "text",
  font: "font",
  size: "size",
  color: "color",
  opacity: "opacity",
  rotation: "rotation",
  position: "position",
  margin: "margin",
  tile: "tile",
  tileGap: "tileGap",
  behind: "behind",
  layout: "layout",
  pages: "pages",
  logoScale: "logoScale",
} as const;

export interface WmOptions {
  type: "text" | "image";
  text: string;
  font: WmFontId;
  size: number;
  color: string;
  opacity: number;
  rotation: number;
  position: WmPosition;
  margin: number;
  tile: boolean;
  tileGap: number;
  behind: boolean;
  layout: WmLayout;
  pages: string;
  logoScale: number;
}

export const WM_DEFAULTS: WmOptions = {
  type: "text",
  text: "CONFIDENTIAL",
  font: "helveticaBold",
  size: 48,
  color: "#DC2626",
  opacity: 0.35,
  rotation: -45,
  position: "mc",
  margin: 32,
  tile: false,
  tileGap: 1,
  behind: false,
  layout: "all",
  pages: "all",
  logoScale: 30,
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

/** Parses "#RGB" / "#RRGGBB" to 0-1 rgb; null when invalid. */
export function parseHexColor(
  value: string
): { r: number; g: number; b: number } | null {
  const hex = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex) && !/^[0-9a-fA-F]{3}$/.test(hex)) {
    return null;
  }
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  return {
    r: Number.parseInt(full.slice(0, 2), 16) / 255,
    g: Number.parseInt(full.slice(2, 4), 16) / 255,
    b: Number.parseInt(full.slice(4, 6), 16) / 255,
  };
}

/** Coerces raw option values into the typed watermark options. */
export function resolveWmOptions(values: OptionValues): WmOptions {
  const fontRaw = asString(values[WM_IDS.font], WM_DEFAULTS.font);
  const font = WM_FONTS.some((f) => f.id === fontRaw)
    ? (fontRaw as WmFontId)
    : WM_DEFAULTS.font;
  const positionRaw = asString(values[WM_IDS.position], WM_DEFAULTS.position);
  const position = WM_POSITIONS.includes(positionRaw as WmPosition)
    ? (positionRaw as WmPosition)
    : WM_DEFAULTS.position;
  const layoutRaw = asString(values[WM_IDS.layout], WM_DEFAULTS.layout);
  const layout = (["all", "odd", "even", "skipFirst", "range"] as const).includes(
    layoutRaw as WmLayout
  )
    ? (layoutRaw as WmLayout)
    : WM_DEFAULTS.layout;
  const colorRaw = asString(values[WM_IDS.color], WM_DEFAULTS.color);
  return {
    type: asString(values[WM_IDS.type], WM_DEFAULTS.type) === "image" ? "image" : "text",
    text: asString(values[WM_IDS.text], WM_DEFAULTS.text).slice(0, 120),
    font,
    size: clamp(Math.round(asNumber(values[WM_IDS.size], WM_DEFAULTS.size)), 8, 144),
    color:
      parseHexColor(colorRaw) === null ? WM_DEFAULTS.color : colorRaw.toUpperCase(),
    opacity: clamp(asNumber(values[WM_IDS.opacity], WM_DEFAULTS.opacity), 0.05, 1),
    rotation: clamp(asNumber(values[WM_IDS.rotation], WM_DEFAULTS.rotation), -90, 90),
    position,
    margin: clamp(asNumber(values[WM_IDS.margin], WM_DEFAULTS.margin), 12, 96),
    tile: asBool(values[WM_IDS.tile], WM_DEFAULTS.tile),
    tileGap: clamp(asNumber(values[WM_IDS.tileGap], WM_DEFAULTS.tileGap), 0.25, 3),
    behind: asBool(values[WM_IDS.behind], WM_DEFAULTS.behind),
    layout,
    pages: asString(values[WM_IDS.pages], WM_DEFAULTS.pages),
    logoScale: clamp(
      Math.round(asNumber(values[WM_IDS.logoScale], WM_DEFAULTS.logoScale)),
      10,
      100
    ),
  };
}

/** CSS font string for the live preview canvas (mirrors the pdf font). */
export function cssFontFor(fontId: WmFontId, sizePx: number): string {
  const entry = WM_FONTS.find((f) => f.id === fontId) ?? WM_FONTS[0];
  const weight = /Bold/.test(entry.id) ? "700" : "400";
  return `${weight} ${sizePx}px ${entry.css}`;
}

/**
 * CSS font string for the preview canvas, unicode-aware: non-WinAnsi text
 * (Devanagari/Hindi) is previewed in the embedded Noto Sans Devanagari
 * family — the same font the worker stamps, so the preview is honest.
 */
export function wmCssFontFor(text: string, fontId: WmFontId, sizePx: number): string {
  if (needsUnicodeFont(text)) {
    let family = "";
    if (typeof window !== "undefined") {
      family = getComputedStyle(document.body)
        .getPropertyValue("--font-noto-devanagari")
        .trim();
    }
    return `400 ${sizePx}px ${family || "'Noto Sans Devanagari'"}`;
  }
  return cssFontFor(fontId, sizePx);
}

/** 9-grid anchor (0-1 both axes) — row-major, y measured from the TOP. */
export function positionAnchor(position: WmPosition): { ax: number; ay: number } {
  const col = position[1]; // l | c | r
  const row = position[0]; // t | m | b
  const ax = col === "l" ? 0 : col === "c" ? 0.5 : 1;
  const ay = row === "t" ? 0 : row === "m" ? 0.5 : 1;
  return { ax, ay };
}

/** Center point (PDF coords, y UP) for a positioned mark of size w×h. */
export function positionCenter(
  position: WmPosition,
  pageW: number,
  pageH: number,
  w: number,
  h: number,
  margin: number
): { cx: number; cy: number } {
  const { ax, ay } = positionAnchor(position);
  const cw = Math.min(w, pageW - 2 * margin);
  const ch = Math.min(h, pageH - 2 * margin);
  const effMarginW = Math.min(margin, (pageW - cw) / 2);
  const effMarginH = Math.min(margin, (pageH - ch) / 2);
  const cx = effMarginW + ax * (pageW - cw - 2 * effMarginW) + cw / 2;
  const cy = pageH - (effMarginH + ay * (pageH - ch - 2 * effMarginH) + ch / 2);
  return { cx, cy };
}

/**
 * Start point (baseline for text, bottom-left for images) so the box CENTER
 * lands at (cx, cy) after pdf-lib rotates it by `rotationDeg` around the
 * start point.
 */
export function rotatedStartPoint(
  cx: number,
  cy: number,
  w: number,
  h: number,
  rotationDeg: number
): { sx: number; sy: number } {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hx = w / 2;
  const hy = h / 2;
  return {
    sx: cx - (cos * hx - sin * hy),
    sy: cy - (sin * hx + cos * hy),
  };
}

/** Tile grid steps — shared by worker + preview. */
export function tileSteps(
  textW: number,
  size: number,
  gap: number
): { stepX: number; stepY: number } {
  return {
    stepX: textW + size * (0.5 + gap),
    stepY: size * (1.5 + gap),
  };
}

/**
 * 0-based target page indices for a layout (PRD §8.2: all / odd / even /
 * range / first-page-excluded). Returns null when a range spec is invalid,
 * and [] when nothing is selected (e.g. skipFirst on a 1-page PDF).
 */
export function targetIndices(
  wm: Pick<WmOptions, "layout" | "pages">,
  pageCount: number
): number[] | null {
  switch (wm.layout) {
    case "all": {
      const all: number[] = [];
      for (let i = 0; i < pageCount; i += 1) all.push(i);
      return all;
    }
    case "odd": {
      const odd: number[] = [];
      for (let i = 0; i < pageCount; i += 2) odd.push(i); // 1-based odd
      return odd;
    }
    case "even": {
      const even: number[] = [];
      for (let i = 1; i < pageCount; i += 2) even.push(i); // 1-based even
      return even;
    }
    case "skipFirst": {
      const rest: number[] = [];
      for (let i = 1; i < pageCount; i += 1) rest.push(i);
      return rest;
    }
    case "range": {
      const spec = wm.pages.trim() === "" ? "all" : wm.pages;
      return parsePageSpec(spec, pageCount);
    }
  }
}
