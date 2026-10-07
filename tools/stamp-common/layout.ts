import type { OptionValues } from "@/lib/tools/config-types";
import type { WmFontId } from "../add-watermark/wm-options";

/**
 * Shared text-stamp architecture (PRD §8.2 "Page numbers" + "Header & footer").
 *
 * Both tools stamp COMPUTED text (not a fixed string) onto chosen pages of a
 * single PDF — page numbers format a counter, header/footer resolves
 * variables per page. ONE spec interface drives BOTH the live preview canvas
 * (main thread) and the pdf-lib worker, so what you see is what you get:
 *
 *   - `resolve`   coerces raw option values into typed options
 *   - `targets`   picks the 0-based page indices (shared layout selector)
 *   - `marks`     computes the final text + placement for ONE page, using an
 *                 injected `TextMeasurer` (canvas on the main thread,
 *                 pdf-lib fonts in the worker — the exact widths each side
 *                 really has)
 *   - `runBlocked` gates the sticky CTA (amber reason)
 *   - `chips`     drives the preview header status chips
 *
 * Placement math is reused from the watermark tool (positionCenter), which
 * the P3.6 round proved end-to-end.
 */

/** Font ids a mark can carry: the 6 standard PDF fonts + the embedded Devanagari TTF. */
export type StampFontId = WmFontId | "devanagari";

/** One computed text stamp, in PDF points, center-anchored (y up). */
export interface StampMark {
  text: string;
  cx: number;
  cy: number;
  size: number;
  fontId: StampFontId;
  color: string;
  opacity: number;
}

/** Per-page facts the mark computation needs. */
export interface StampPageContext {
  /** 0-based index of the page being computed. */
  pageIndex: number;
  pageCount: number;
  pageW: number;
  pageH: number;
  /** Original file name (with extension). */
  fileName: string;
  /** File name without the .pdf extension ({filename} variable). */
  fileBase: string;
  /** PDF Title metadata, "" when absent ({title} variable). */
  title: string;
}

/** Text width in PDF points — canvas-backed on the main thread, pdf-lib in the worker. */
export type TextMeasurer = (
  text: string,
  fontId: StampFontId,
  size: number
) => number;

export interface StampChip {
  key: string;
  params?: Record<string, string | number>;
}

export interface StampToolSpec<TOptions> {
  resolve(values: OptionValues): TOptions;
  targets(options: TOptions, pageCount: number): number[] | null;
  marks(
    measure: TextMeasurer,
    options: TOptions,
    ctx: StampPageContext
  ): StampMark[];
  runBlocked(
    options: TOptions,
    targets: number[] | null,
    pageCount: number
  ): string | null;
  chips(
    options: TOptions,
    targets: number[] | null,
    pageCount: number
  ): StampChip[];
}

/* ------------------------------------------------------------------ */
/* Number formatting (PRD §8.2 Page numbers: 1, Page 1, 1/N,           */
/* Page 1 of N, i, I, a — plus A for symmetry, Hindi digits optional)  */
/* ------------------------------------------------------------------ */

export type PnFormat =
  | "plain"
  | "page"
  | "slash"
  | "pageOf"
  | "romanLower"
  | "romanUpper"
  | "alphaLower"
  | "alphaUpper";

export const PN_FORMATS: PnFormat[] = [
  "plain",
  "page",
  "slash",
  "pageOf",
  "romanLower",
  "romanUpper",
  "alphaLower",
  "alphaUpper",
];

/** 1-based value → lowercase roman numerals (i, ii, iii, iv, …). */
export function toRoman(value: number, upper: boolean): string {
  if (!Number.isFinite(value) || value <= 0) return String(value);
  const table: [number, string][] = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let rest = Math.floor(value);
  let out = "";
  for (const [num, sym] of table) {
    while (rest >= num) {
      out += sym;
      rest -= num;
    }
  }
  return upper ? out.toUpperCase() : out;
}

/** 1-based value → spreadsheet-style letters (a, b, … z, aa, ab …). */
export function toAlpha(value: number, upper: boolean): string {
  if (!Number.isFinite(value) || value <= 0) return String(value);
  let rest = Math.floor(value);
  let out = "";
  while (rest > 0) {
    const rem = (rest - 1) % 26;
    out = String.fromCharCode(97 + rem) + out;
    rest = Math.floor((rest - 1) / 26);
  }
  return upper ? out.toUpperCase() : out;
}

const HINDI_DIGITS = "०१२३४५६७८९";

/** Replaces ASCII digits with Devanagari digits (०१२३४५६७८९). */
export function toHindiDigits(text: string): string {
  return text.replace(/[0-9]/g, (d) => HINDI_DIGITS[Number(d)]);
}

/** Formats one page-number value per the chosen format. */
export function formatPageNumber(
  value: number,
  format: PnFormat,
  total: number,
  hindiDigits: boolean
): string {
  let out: string;
  switch (format) {
    case "plain":
      out = String(value);
      break;
    case "page":
      out = `Page ${value}`;
      break;
    case "slash":
      out = `${value}/${total}`;
      break;
    case "pageOf":
      out = `Page ${value} of ${total}`;
      break;
    case "romanLower":
      out = toRoman(value, false);
      break;
    case "romanUpper":
      out = toRoman(value, true);
      break;
    case "alphaLower":
      out = toAlpha(value, false);
      break;
    case "alphaUpper":
      out = toAlpha(value, true);
      break;
  }
  return hindiDigits ? toHindiDigits(out) : out;
}

/* ------------------------------------------------------------------ */
/* Header & footer variables (PRD §8.2: {page} {pages} {date}          */
/* {filename} {title})                                                */
/* ------------------------------------------------------------------ */

export type HfDateFormat = "dmy" | "mdy" | "ymd";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local calendar date in the chosen shape: 07/10/2026 · 10/07/2026 · 2026-10-07. */
export function formatStampDate(
  date: Date,
  format: HfDateFormat
): string {
  const d = pad2(date.getDate());
  const m = pad2(date.getMonth() + 1);
  const y = date.getFullYear();
  switch (format) {
    case "dmy":
      return `${d}/${m}/${y}`;
    case "mdy":
      return `${m}/${d}/${y}`;
    case "ymd":
      return `${y}-${m}-${d}`;
  }
}

const VARIABLE_KEYS = ["page", "pages", "date", "filename", "title"] as const;

/**
 * Resolves {page} {pages} {date} {filename} {title} (case-insensitive).
 * Unknown braces are left untouched so users see their typo in the preview.
 */
export function resolveStampVariables(
  text: string,
  ctx: Pick<
    StampPageContext,
    "pageIndex" | "pageCount" | "fileBase" | "title"
  >,
  date: Date,
  dateFormat: HfDateFormat
): string {
  return text.replace(/\{(\s*[a-zA-Z]+\s*)\}/g, (whole, name: string) => {
    const key = name.trim().toLowerCase() as (typeof VARIABLE_KEYS)[number];
    if (!VARIABLE_KEYS.includes(key)) return whole;
    switch (key) {
      case "page":
        return String(ctx.pageIndex + 1);
      case "pages":
        return String(ctx.pageCount);
      case "date":
        return formatStampDate(date, dateFormat);
      case "filename":
        return ctx.fileBase;
      case "title":
        return ctx.title;
    }
  });
}

/** True when the text needs more than WinAnsi can encode (e.g. Devanagari). */
export function needsUnicodeFont(text: string): boolean {
  return /[^\u0000-\u00ff]/.test(text);
}

/** Strips the .pdf extension for the {filename} variable. */
export function fileBaseName(name: string): string {
  return name.replace(/\.pdf$/i, "").trim() || "document";
}
