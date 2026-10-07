import type { OptionValues } from "@/lib/tools/config-types";
import {
  type HfDateFormat,
  type StampMark,
  type StampPageContext,
  type StampToolSpec,
  type TextMeasurer,
  fileBaseName,
  needsUnicodeFont,
  resolveStampVariables,
} from "../stamp-common/layout";
import {
  WM_FONTS,
  type WmFontId,
  type WmLayout,
  targetIndices,
} from "../add-watermark/wm-options";

/**
 * Header & footer option ids, defaults and the tool spec (PRD §8.2 "Header &
 * footer": left/center/right text with variables {page} {pages} {date}
 * {filename} {title}). The header sits one margin below the top edge, the
 * footer one margin above the bottom edge; left/center/right align within
 * the page. Non-ASCII text (e.g. Hindi) automatically upgrades to the
 * embedded Devanagari font — same pure math for the preview and the worker.
 */

export const HF_IDS = {
  headerLeft: "hfHeaderLeft",
  headerCenter: "hfHeaderCenter",
  headerRight: "hfHeaderRight",
  footerLeft: "hfFooterLeft",
  footerCenter: "hfFooterCenter",
  footerRight: "hfFooterRight",
  font: "hfFont",
  size: "hfSize",
  color: "hfColor",
  opacity: "hfOpacity",
  margin: "hfMargin",
  dateFormat: "hfDateFormat",
  layout: "hfLayout",
  pages: "hfPages",
} as const;

export interface HfOptions {
  headerLeft: string;
  headerCenter: string;
  headerRight: string;
  footerLeft: string;
  footerCenter: string;
  footerRight: string;
  font: WmFontId;
  size: number;
  color: string;
  opacity: number;
  margin: number;
  dateFormat: HfDateFormat;
  layout: WmLayout;
  pages: string;
}

export const HF_DEFAULTS: HfOptions = {
  headerLeft: "",
  headerCenter: "",
  headerRight: "",
  footerLeft: "",
  footerCenter: "",
  footerRight: "",
  font: "helvetica",
  size: 9,
  color: "#374151",
  opacity: 1,
  margin: 28,
  dateFormat: "dmy",
  layout: "all",
  pages: "all",
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

const HEX_RE = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

function field(values: OptionValues, id: string, fallback: string): string {
  return asString(values[id], fallback).slice(0, 120);
}

export function resolveHfOptions(values: OptionValues): HfOptions {
  const fontRaw = asString(values[HF_IDS.font], HF_DEFAULTS.font);
  const layoutRaw = asString(values[HF_IDS.layout], HF_DEFAULTS.layout);
  const colorRaw = asString(values[HF_IDS.color], HF_DEFAULTS.color);
  const dateRaw = asString(values[HF_IDS.dateFormat], HF_DEFAULTS.dateFormat);
  return {
    headerLeft: field(values, HF_IDS.headerLeft, ""),
    headerCenter: field(values, HF_IDS.headerCenter, ""),
    headerRight: field(values, HF_IDS.headerRight, ""),
    footerLeft: field(values, HF_IDS.footerLeft, ""),
    footerCenter: field(values, HF_IDS.footerCenter, ""),
    footerRight: field(values, HF_IDS.footerRight, ""),
    font: WM_FONTS.some((f) => f.id === fontRaw)
      ? (fontRaw as WmFontId)
      : HF_DEFAULTS.font,
    size: clamp(Math.round(asNumber(values[HF_IDS.size], HF_DEFAULTS.size)), 6, 24),
    color: HEX_RE.test(colorRaw) ? colorRaw.toUpperCase() : HF_DEFAULTS.color,
    opacity: clamp(asNumber(values[HF_IDS.opacity], HF_DEFAULTS.opacity), 0.05, 1),
    margin: clamp(Math.round(asNumber(values[HF_IDS.margin], HF_DEFAULTS.margin)), 12, 96),
    dateFormat: (["dmy", "mdy", "ymd"] as string[]).includes(dateRaw)
      ? (dateRaw as HfDateFormat)
      : HF_DEFAULTS.dateFormat,
    layout: (["all", "odd", "even", "skipFirst", "range"] as string[]).includes(
      layoutRaw
    )
      ? (layoutRaw as WmLayout)
      : HF_DEFAULTS.layout,
    pages: asString(values[HF_IDS.pages], HF_DEFAULTS.pages),
  };
}

/** True when any field is non-empty. */
export function hfHasAnyText(hf: HfOptions): boolean {
  return (
    hf.headerLeft.trim() !== "" ||
    hf.headerCenter.trim() !== "" ||
    hf.headerRight.trim() !== "" ||
    hf.footerLeft.trim() !== "" ||
    hf.footerCenter.trim() !== "" ||
    hf.footerRight.trim() !== ""
  );
}

/**
 * True when the run needs the embedded Devanagari font: any field has
 * non-WinAnsi text, or a {filename}/{title} variable can resolve to such a
 * name. Called with the RAW fields + the file's own name/title (the worker
 * knows both before it measures).
 */
export function hfNeedsDevanagari(
  hf: HfOptions,
  fileName: string,
  title: string
): boolean {
  const fileBase = fileBaseName(fileName);
  const fields = [
    hf.headerLeft,
    hf.headerCenter,
    hf.headerRight,
    hf.footerLeft,
    hf.footerCenter,
    hf.footerRight,
  ];
  for (const raw of fields) {
    if (needsUnicodeFont(raw)) return true;
    const hasFilename = /\{\s*filename\s*\}/i.test(raw);
    const hasTitle = /\{\s*title\s*\}/i.test(raw);
    if (hasFilename && needsUnicodeFont(fileBase)) return true;
    if (hasTitle && needsUnicodeFont(title)) return true;
  }
  return false;
}

/** Mark font upgrade: Devanagari text always renders with the embedded font. */
function markFontId(hf: HfOptions, text: string): WmFontId | "devanagari" {
  return needsUnicodeFont(text) ? "devanagari" : hf.font;
}

export const HF_SPEC: StampToolSpec<HfOptions> = {
  resolve: resolveHfOptions,

  targets(options, pageCount) {
    return targetIndices(
      { layout: options.layout, pages: options.pages },
      pageCount
    );
  },

  marks(measure, options, ctx) {
    const targets = HF_SPEC.targets(options, ctx.pageCount);
    if (targets === null || targets.indexOf(ctx.pageIndex) === -1) return [];

    const date = new Date();
    const slots: { text: string; align: "l" | "c" | "r"; band: "h" | "f" }[] =
      [];
    const push = (
      raw: string,
      align: "l" | "c" | "r",
      band: "h" | "f"
    ): void => {
      const text = resolveStampVariables(
        raw.trim(),
        ctx,
        date,
        options.dateFormat
      );
      if (text !== "") slots.push({ text, align, band });
    };
    push(options.headerLeft, "l", "h");
    push(options.headerCenter, "c", "h");
    push(options.headerRight, "r", "h");
    push(options.footerLeft, "l", "f");
    push(options.footerCenter, "c", "f");
    push(options.footerRight, "r", "f");
    if (slots.length === 0) return [];

    const pageW = ctx.pageW;
    const pageH = ctx.pageH;
    const m = Math.min(options.margin, pageH / 4);
    const boxH = options.size;
    const headerCy = pageH - m - boxH / 2;
    const footerCy = m + boxH / 2;

    return slots.map((slot) => {
      const fontId = markFontId(options, slot.text);
      const w = measure(slot.text, fontId, options.size);
      let cx: number;
      if (slot.align === "l") {
        cx = Math.min(m, Math.max(0, pageW - w)) + w / 2;
      } else if (slot.align === "c") {
        cx = pageW / 2;
      } else {
        cx = pageW - Math.min(m, Math.max(0, pageW - w)) - w / 2;
      }
      const mark: StampMark = {
        text: slot.text,
        cx,
        cy: slot.band === "h" ? headerCy : footerCy,
        size: options.size,
        fontId,
        color: options.color,
        opacity: options.opacity,
      };
      return mark;
    });
  },

  runBlocked(options, targets) {
    if (!hfHasAnyText(options)) return "hf.ctaEmpty";
    if (targets === null) return "wm.rangeInvalid";
    if (targets.length === 0) return "pn.ctaNoPages";
    return null;
  },

  chips(options, targets, pageCount) {
    if (targets === null) return [];
    const chips: { key: string; params?: Record<string, string | number> }[] =
      [];
    const hasHeader =
      options.headerLeft.trim() !== "" ||
      options.headerCenter.trim() !== "" ||
      options.headerRight.trim() !== "";
    const hasFooter =
      options.footerLeft.trim() !== "" ||
      options.footerCenter.trim() !== "" ||
      options.footerRight.trim() !== "";
    if (hasHeader) chips.push({ key: "hf.chipHeader" });
    if (hasFooter) chips.push({ key: "hf.chipFooter" });
    chips.push({
      key: "wm.markedCount",
      params: { count: targets.length, pages: pageCount },
    });
    return chips;
  },
};
