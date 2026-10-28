import type { StampFontKey, StampTtfFont } from "@/lib/own/pdf";

/**
 * The converter-family face (P6-m) — the P6-l ResumeFace recipe lifted to
 * the shared home every *-to-pdf document converter uses: ONE usable text
 * face is either a non-embedded base-14 key (pure-WinAnsi docs — the
 * smallest ATS-clean PDF possible) or the embedded Noto Devanagari
 * subset (OUR Type0/CIDFontType2 subsetter + Indic shaper).
 *
 * The two-mode recipe keeps widthOfTextAtSize parity EXACT: std faces
 * measure through CreateContext.measure (pdf-lib-identical, kerning
 * included), the ttf face through StampTtfFont.measure — so wraps and
 * pagination stay identical by construction (the create-resume /
 * create-invoice precedents).
 */

/** One usable text face: a standard-14 key OR the embedded Devanagari. */
export interface ConvertFace {
  std?: StampFontKey;
  ttf?: StampTtfFont;
}

/** Spread a face into CreatePage.drawText options. */
export function faceOpts(
  f: ConvertFace
):
  | { ttf: StampTtfFont; font?: undefined }
  | { font: StampFontKey; ttf?: undefined } {
  return f.ttf ? { ttf: f.ttf } : { font: f.std ?? "helvetica" };
}

/** Face-aware width — the widthOfTextAtSize replacement. */
export function faceWidth(
  ctx: { measure(text: string, font: StampFontKey, size: number): number },
  f: ConvertFace,
  text: string,
  size: number
): number {
  return f.ttf
    ? f.ttf.measure(text, size)
    : ctx.measure(text, f.std ?? "helvetica", size);
}

/* ------------------------------------------------------------------ */
/* Colors — the pdf-lib rgb() shape, kept so every existing call site   */
/* stands verbatim (draw* options take it as-is on our engine).        */
/* ------------------------------------------------------------------ */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function rgb(r: number, g: number, b: number): RGB {
  return { r, g, b };
}
