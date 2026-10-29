/**
 * DocoPDF own PDF micro-engine — standard-font stamping (P6-f).
 *
 * Widths/kern/WinAnsi data live in the GENERATED stamp-fonts-data.ts (from
 * @pdf-lib/standard-fonts AFM — the same numbers pdf-lib reads at runtime).
 * This module adds the behaviors the stamp pipeline needs, mirroring
 * pdf-lib's StandardFontEmbedder exactly:
 *
 *   - measureStdText:  Σ width(glyph) + kern(left,right), × size/1000
 *   - encodeWinAnsi:   text → WinAnsi bytes (throws typed on unmappable chars,
 *                      same contract as pdf-lib's encodeText try/catch that
 *                      surfaces tool.errorWatermarkChars)
 */

import { PdfError } from "./parser";
import {
  STD_FONTS,
  WIN_ANSI_CODE,
  WIN_ANSI_NAME,
  type StampFontKey,
} from "./stamp-fonts-data";

export type { StampFontKey };

/** True when every character of `text` is WinAnsi-encodable. */
export function winAnsiEncodable(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (!WIN_ANSI_CODE.has(text.codePointAt(i)!)) return false;
  }
  return true;
}

/**
 * Width of `text` in `font` at `size` (PDF points) — kerning included,
 * pdf-lib-identical (their widthOfTextAtSize sums WX + KernPair amounts).
 * Throws PdfError("chars") on any non-WinAnsi character — callers translate
 * that to the same tool error the legacy pdf-lib path raised.
 */
export function measureStdText(text: string, font: StampFontKey, size: number): number {
  const codes = encodeWinAnsiBytes(text, font);
  const metrics = STD_FONTS[font];
  let totalWidth = 0;
  let prevName: string | undefined;
  for (const code of codes) {
    const width = metrics.widths[code] ?? -1;
    if (width < 0) {
      throw new PdfError("chars", `WinAnsi code ${code} has no glyph in ${metrics.base}`);
    }
    const name = WIN_ANSI_NAME.get(code);
    let kernAmount = 0;
    if (prevName !== undefined && name !== undefined) {
      kernAmount = metrics.kern[`${prevName}|${name}`] ?? 0;
    }
    // Integer units accumulate exactly; scale applied ONCE at the end —
    // the exact pdf-lib StandardFontEmbedder arithmetic order (float parity).
    totalWidth += width + kernAmount;
    if (name !== undefined) prevName = name;
  }
  const scale = size / 1000;
  return totalWidth * scale;
}

/**
 * `text` → WinAnsi byte codes (one per character). Throws typed "chars" on
 * the first unmappable character — the parity of pdf-lib's
 * `font.encodeText(text)` try/catch in the workers.
 */
export function encodeWinAnsiBytes(text: string, _font: StampFontKey): number[] {
  const codes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    const code = WIN_ANSI_CODE.get(cp);
    if (code === undefined) {
      const hex = cp.toString(16).toUpperCase().padStart(4, "0");
      throw new PdfError(
        "chars",
        `WinAnsi cannot encode U+${hex} ("${String.fromCodePoint(cp)}")`,
      );
    }
    codes.push(code);
  }
  return codes;
}

/** `text` → hex string body (2 hex digits per WinAnsi code) for the Tj op. */
export function encodeWinAnsiHex(text: string, font: StampFontKey): string {
  return encodeWinAnsiBytes(text, font)
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("");
}

/** pdf-lib heightAtSize(size, {descender:false}) — the per-family ascent
 * (probed live: Helvetica family 718, Times 683, Courier 629 per 1000).
 * P6-o: the edit-pdf worker's baseline math. */
const STD_ASCENT: Record<StampFontKey, number> = {
  helvetica: 718,
  helveticaBold: 718,
  helveticaOblique: 718,
  helveticaBoldOblique: 718,
  times: 683,
  timesBold: 683,
  timesItalic: 683,
  timesBoldItalic: 683,
  courier: 629,
  courierBold: 629,
  courierOblique: 629,
  courierBoldOblique: 629,
};

export function stdFontAscent(font: StampFontKey, size: number): number {
  return (STD_ASCENT[font] / 1000) * size;
}
