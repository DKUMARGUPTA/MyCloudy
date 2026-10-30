/**
 * Worker-side stamp-font helpers — the OWN-ENGINE edition (P6-y): standard
 * faces are base-14 KEYS (no embedding — our engine emits them from
 * stamp-fonts-data), the Devanagari TTF is fetched from THIS ORIGIN
 * (/fonts/…, self-hosted Noto Sans Devanagari, OFL — see
 * public/fonts/NotoSansDevanagari-OFL.txt), cached per worker lifetime,
 * and embedded as a shaped Type0/CIDFontType2 auto-subset via our own
 * engine. Faces come back as ConvertFace handles (convert-common/face),
 * so every consumer's drawText spreads faceOpts(face) and measures through
 * faceWidth — the exact wrap math the pdf-lib build had (std faces measure
 * through CreateContext.measure, pdf-lib-identical, kerning included; the
 * ttf face through StampTtfFont.measure).
 *
 * No user file data ever leaves the device (PRD §2.2 mode D).
 */

import type { StampFontKey, StampTtfFont } from "@/lib/own/pdf";

import { faceOpts, type ConvertFace } from "../convert-common/face";
import type { WmFontId } from "../add-watermark/wm-options";
import { loadDevanagariBytes } from "./deva";
import {
  type StampFontId,
  type StampMark,
  type TextMeasurer,
} from "./layout";

export { loadDevanagariBytes, safeStampBaseName } from "./deva";

const STD_KEY: Record<WmFontId, StampFontKey> = {
  helvetica: "helvetica",
  helveticaBold: "helveticaBold",
  times: "times",
  timesBold: "timesBold",
  courier: "courier",
  courierBold: "courierBold",
};

/**
 * The embed surface both engine contexts share (CreateContext AND
 * StampContext expose measure + embedTtf with these exact shapes).
 */
export type StampFontEmbedder = {
  measure(text: string, font: StampFontKey, size: number): number;
  embedTtf(bytes: Uint8Array): StampTtfFont;
};

export interface StampFonts {
  fontFor: (fontId: StampFontId) => ConvertFace;
  measure: TextMeasurer;
}

/**
 * Resolves the fonts a stamp run needs. `needDevanagari` must be decided
 * BEFORE measuring (the widths feed the placement math): pass true when the
 * resolved option values can produce non-WinAnsi text (Hindi digits,
 * Devanagari field text, a non-ASCII {filename} / {title}).
 */
export async function loadStampFonts(
  ctx: StampFontEmbedder,
  needDevanagari: boolean
): Promise<StampFonts> {
  const deva = needDevanagari
    ? ctx.embedTtf(await loadDevanagariBytes())
    : null;

  const face = (fontId: StampFontId): ConvertFace =>
    fontId === "devanagari"
      ? deva
        ? { ttf: deva }
        : { std: "helvetica" }
      : { std: STD_KEY[fontId] };

  return {
    fontFor: face,
    measure: (text, fontId, size) => {
      if (fontId === "devanagari") {
        return deva ? deva.measure(text, size) : ctx.measure(text, "helvetica", size);
      }
      return ctx.measure(text, STD_KEY[fontId], size);
    },
  };
}

/**
 * Draws one mark center-anchored at (cx, cy) — the exact math the preview
 * canvas uses: the baseline sits 0.25em above the box bottom so the em-box
 * middle matches the canvas "middle" baseline. `widthOf` is the face-aware
 * width (faceWidth over the same face the draw spreads).
 */
export function drawStampMark(
  page: {
    drawText(opts: {
      text: string;
      x: number;
      y: number;
      size: number;
      opacity?: number;
      font?: StampFontKey;
      ttf?: StampTtfFont;
    }): void;
  },
  mark: StampMark,
  face: ConvertFace,
  widthOf: (text: string, size: number) => number
): void {
  const textW = widthOf(mark.text, mark.size);
  page.drawText({
    text: mark.text,
    x: mark.cx - textW / 2,
    y: mark.cy - mark.size * 0.25,
    size: mark.size,
    opacity: mark.opacity,
    ...faceOpts(face),
  });
}
