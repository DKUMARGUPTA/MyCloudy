/**
 * Edit PDF — client-side font plumbing (main thread only).
 *
 * WYSIWYG strategy: the canvas overlay measures text with font stacks that
 * are metric-compatible with the fonts the WORKER embeds at export time —
 *
 *   sans  → "Helvetica, Arial, Liberation Sans"  ↔ pdf-lib Helvetica
 *   serif → "Times New Roman, Liberation Serif"   ↔ pdf-lib TimesRoman
 *   mono  → "Courier New, Liberation Mono"       ↔ pdf-lib Courier
 *   deva  → the self-hosted Noto Sans Devanagari (next/font variable)
 *           ↔ the SAME TTF embedded via fontkit (public/fonts) — identical
 *           metrics by construction.
 *
 * Wrapped lines are measured once here and stored on the text object; the
 * export burns exactly those lines, so the two sides can never disagree
 * about reflow (only ±1px raster differences at the line's right edge).
 */

import {
  hasDevanagari,
  wrapTextLines,
  type EdAlign,
  type EdFontFamily,
  type EdTextObj,
} from "./model";

const LATIN_STACKS: Record<Exclude<EdFontFamily, "deva">, string> = {
  sans: '"Helvetica", "Arial", "Liberation Sans", "DejaVu Sans", sans-serif',
  serif: '"Times New Roman", "Liberation Serif", "DejaVu Serif", serif',
  mono: '"Courier New", "Liberation Mono", "DejaVu Sans Mono", monospace',
};

let devaStack: string | null = null;

/** The generated next/font family name for Noto Sans Devanagari. */
function resolveDevaStack(): string {
  if (devaStack !== null) return devaStack;
  let stack = '"Noto Sans Devanagari"';
  try {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue("--font-noto-devanagari")
      .trim();
    if (value !== "") stack = `${value}, "Noto Sans Devanagari"`;
  } catch {
    // Non-DOM context (defensive — this module is main-thread only).
  }
  devaStack = stack;
  return stack;
}

export function fontFamilyStack(family: EdFontFamily): string {
  return family === "deva"
    ? resolveDevaStack()
    : LATIN_STACKS[family];
}

/** CSS font shorthand for a canvas 2d context / inline style. */
export function cssFont(
  family: EdFontFamily,
  size: number,
  bold: boolean,
  italic: boolean
): string {
  const style = italic ? "italic " : "";
  const weight = bold ? "700" : "400";
  return `${style}${weight} ${size}px ${fontFamilyStack(family)}`;
}

/** Inline style for a DOM text editor div (same stack as measurement). */
export function domFontStyle(
  family: EdFontFamily,
  size: number,
  bold: boolean,
  italic: boolean
): React.CSSProperties {
  return {
    fontFamily: fontFamilyStack(family),
    fontSize: `${size}px`,
    fontWeight: bold ? 700 : 400,
    fontStyle: italic ? "italic" : "normal",
    lineHeight: `${size * 1.25}px`,
  };
}

let measureCtx: CanvasRenderingContext2D | null = null;

function context(): CanvasRenderingContext2D | null {
  if (measureCtx !== null) return measureCtx;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 8;
  measureCtx = canvas.getContext("2d");
  return measureCtx;
}

/** Measure a string with a css font shorthand (pt at scale 1). */
export function measureText(text: string, font: string): number {
  const ctx = context();
  if (!ctx || text === "") return 0;
  ctx.font = font;
  return ctx.measureText(text).width;
}

/** Ascent fraction (baseline from the top of a line) for a font config. */
export function measureAscent(
  family: EdFontFamily,
  size: number,
  bold: boolean,
  italic: boolean
): number {
  const ctx = context();
  if (!ctx) return 0.8;
  ctx.font = cssFont(family, size, bold, italic);
  const metrics = ctx.measureText("ह्ंMg");
  const ascent = metrics.actualBoundingBoxAscent;
  if (!Number.isFinite(ascent) || ascent <= 0) return 0.8;
  return Math.min(1.25, Math.max(0.4, ascent / size));
}

/** CSS text-align value for an EdAlign. */
export function alignCss(align: EdAlign): "left" | "center" | "right" {
  return align;
}

/**
 * Recompute a text object's wrapped lines (and ascent) after any change
 * to its text, box width or font configuration. Text containing Devanagari
 * auto-switches to the Devanagari font (the standard-14 families cannot
 * encode it — the UI and the export both follow this rule). Callers must
 * use the RETURNED object (immutable update).
 */
export function rewrapText(obj: EdTextObj): EdTextObj {
  const family =
    obj.family !== "deva" && hasDevanagari(obj.text) ? "deva" : obj.family;
  const font = cssFont(family, obj.size, obj.bold, obj.italic);
  const lines = wrapTextLines(obj.text, obj.w, (t) => measureText(t, font));
  const ascent = measureAscent(family, obj.size, obj.bold, obj.italic);
  return { ...obj, family, lines, ascent };
}
