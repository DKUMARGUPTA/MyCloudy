import type { OptionValues } from "@/lib/tools/config-types";
import {
  type PnFormat,
  type StampMark,
  type StampPageContext,
  type StampToolSpec,
  PN_FORMATS,
  formatPageNumber,
} from "../stamp-common/layout";
import {
  WM_FONTS,
  type WmFontId,
  type WmLayout,
  type WmPosition,
  targetIndices,
  positionAnchor,
} from "../add-watermark/wm-options";

/**
 * Page numbers option ids, defaults and the tool spec (PRD §8.2 "Page
 * numbers": formats 1 / Page 1 / 1 of N / Page 1 of N / i / I / a, start
 * number, 9-grid position + margin, font, skip first page, Hindi digits
 * optional). ONE pure module shared by the panel (writes), the live preview
 * surface (reads) and the worker (reads) — same as the watermark round.
 */

export const PN_IDS = {
  format: "pnFormat",
  start: "pnStart",
  hindiDigits: "pnHindiDigits",
  font: "pnFont",
  size: "pnSize",
  color: "pnColor",
  opacity: "pnOpacity",
  position: "pnPosition",
  margin: "pnMargin",
  layout: "pnLayout",
  pages: "pnPages",
} as const;

export interface PnOptions {
  format: PnFormat;
  start: number;
  hindiDigits: boolean;
  font: WmFontId;
  size: number;
  color: string;
  opacity: number;
  position: WmPosition;
  margin: number;
  layout: WmLayout;
  pages: string;
}

export const PN_DEFAULTS: PnOptions = {
  format: "plain",
  start: 1,
  hindiDigits: false,
  font: "helvetica",
  size: 11,
  color: "#111827",
  opacity: 1,
  position: "br",
  margin: 36,
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

/** Formats with Roman/Alpha letters — Hindi digits can't apply to them. */
export function formatUsesDigits(format: PnFormat): boolean {
  return (
    format === "plain" ||
    format === "page" ||
    format === "slash" ||
    format === "pageOf"
  );
}

export function resolvePnOptions(values: OptionValues): PnOptions {
  const formatRaw = asString(values[PN_IDS.format], PN_DEFAULTS.format);
  const fontRaw = asString(values[PN_IDS.font], PN_DEFAULTS.font);
  const positionRaw = asString(values[PN_IDS.position], PN_DEFAULTS.position);
  const layoutRaw = asString(values[PN_IDS.layout], PN_DEFAULTS.layout);
  const colorRaw = asString(values[PN_IDS.color], PN_DEFAULTS.color);
  return {
    format: (PN_FORMATS as string[]).includes(formatRaw)
      ? (formatRaw as PnFormat)
      : PN_DEFAULTS.format,
    start: clamp(Math.round(asNumber(values[PN_IDS.start], PN_DEFAULTS.start)), 1, 9999),
    hindiDigits: asBool(values[PN_IDS.hindiDigits], PN_DEFAULTS.hindiDigits),
    font: WM_FONTS.some((f) => f.id === fontRaw)
      ? (fontRaw as WmFontId)
      : PN_DEFAULTS.font,
    size: clamp(Math.round(asNumber(values[PN_IDS.size], PN_DEFAULTS.size)), 6, 48),
    color: HEX_RE.test(colorRaw) ? colorRaw.toUpperCase() : PN_DEFAULTS.color,
    opacity: clamp(asNumber(values[PN_IDS.opacity], PN_DEFAULTS.opacity), 0.05, 1),
    position: (["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"] as string[]).includes(
      positionRaw
    )
      ? (positionRaw as WmPosition)
      : PN_DEFAULTS.position,
    margin: clamp(Math.round(asNumber(values[PN_IDS.margin], PN_DEFAULTS.margin)), 12, 96),
    layout: (["all", "odd", "even", "skipFirst", "range"] as string[]).includes(
      layoutRaw
    )
      ? (layoutRaw as WmLayout)
      : PN_DEFAULTS.layout,
    pages: asString(values[PN_IDS.pages], PN_DEFAULTS.pages),
  };
}

/** True when the run needs the embedded Devanagari font. */
export function pnNeedsDevanagari(pn: PnOptions): boolean {
  return pn.hindiDigits && formatUsesDigits(pn.format);
}

/** 9-grid anchor placement (PDF coords, y up) for a positioned stamp. */
function pnPositionCenter(
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

export const PN_SPEC: StampToolSpec<PnOptions> = {
  resolve: resolvePnOptions,

  targets(options, pageCount) {
    return targetIndices(
      { layout: options.layout, pages: options.pages },
      pageCount
    );
  },

  marks(measure, options, ctx) {
    const targets = PN_SPEC.targets(options, ctx.pageCount);
    if (targets === null) return [];
    const position = targets.indexOf(ctx.pageIndex);
    if (position === -1) return [];
    const value = options.start + position;
    const text = formatPageNumber(
      value,
      options.format,
      ctx.pageCount,
      options.hindiDigits
    );
    const fontId =
      pnNeedsDevanagari(options) ? "devanagari" : options.font;
    const w = measure(text, fontId, options.size);
    const { cx, cy } = pnPositionCenter(
      options.position,
      ctx.pageW,
      ctx.pageH,
      w,
      options.size,
      options.margin
    );
    const mark: StampMark = {
      text,
      cx,
      cy,
      size: options.size,
      fontId,
      color: options.color,
      opacity: options.opacity,
    };
    return [mark];
  },

  runBlocked(options, targets) {
    if (targets === null) return "wm.rangeInvalid";
    if (targets.length === 0) return "pn.ctaNoPages";
    return null;
  },

  chips(options, targets, pageCount) {
    if (targets === null) return [];
    const chips: { key: string; params?: Record<string, string | number> }[] =
      [
        {
          key: "pn.chipFormat",
          params: {
            sample: formatPageNumber(
              options.start,
              options.format,
              pageCount,
              options.hindiDigits
            ),
          },
        },
      ];
    if (options.hindiDigits && formatUsesDigits(options.format)) {
      chips.push({ key: "pn.chipHindi" });
    }
    chips.push({
      key: "wm.markedCount",
      params: { count: targets.length, pages: pageCount },
    });
    return chips;
  },
};
