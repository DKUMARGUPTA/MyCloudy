/**
 * Searchable-text layer for OCR'd PDFs (PRD §8 "PDF OCR — searchable PDF").
 *
 * The output keeps the original page pixels untouched and appends one
 * invisible `drawText` per recognized LINE (pdf-lib, opacity 0). Lines —
 * not words — keep the copy order sane and the content stream small.
 *
 * Geometry contract: OCR bboxes arrive in IMAGE pixel space (y down);
 * two pure mappers turn them into PDF user-space placements:
 *  - `pdfPageLinePlacement` for rendered PDF pages (viewport scale +
 *    /Rotate-aware display→user mapping from tools/crop-pdf/crop-options)
 *  - `imageBoxLinePlacement` for image-backed pages (the exact contain-fit
 *    box the images→PDF worker drew the picture into)
 *
 * Fonts: standard Helvetica covers everything WinAnsi-encodable; any line
 * with characters beyond that (Devanagari, other scripts) is drawn with
 * the embedded self-hosted Noto Sans Devanagari TTF (subset: true). The
 * layer is invisible — search & copy work through the text itself, so
 * glyph shapes are irrelevant, but the ToUnicode CMap of the embedded
 * font keeps even Hindi copy-paste exact.
 */

import {
  PDFDocument,
  StandardFonts,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

import { displayToUser } from "../crop-pdf/crop-options";
import { loadDevanagariBytes } from "../stamp-common/worker-lib";
import type { OcrLine } from "./tesseract";

/* ------------------------------------------------------------------ */
/* Text hygiene (pure)                                                 */
/* ------------------------------------------------------------------ */

/** Punctuation that WinAnsi cannot encode, replaced with safe equivalents. */
const SMART_MAP: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201A": ",",
  "\u201B": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u201E": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u2212": "-",
  "\u2026": "...",
  "\u00A0": " ",
  "\u202F": " ",
  "\u200B": "",
  "\uFEFF": "",
};

/**
 * Normalizes one OCR line for the text layer: drops control characters,
 * replaces typographic punctuation with WinAnsi-safe equivalents and
 * collapses runs of spaces. Returns "" when nothing writable remains.
 */
export function sanitizeLineText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      if (ch === "\t") out += " ";
      continue;
    }
    out += SMART_MAP[ch] ?? ch;
  }
  return out.replace(/ {2,}/g, " ").trim();
}

/**
 * True when the (sanitized) text contains characters Helvetica cannot
 * encode — those lines need the embedded Unicode font instead.
 */
export function needsEmbeddedFont(text: string): boolean {
  return /[\u0100-\uFFFF]/.test(text);
}

/* ------------------------------------------------------------------ */
/* Pixel → PDF placement (pure)                                        */
/* ------------------------------------------------------------------ */

export interface LinePlacement {
  text: string;
  /** Baseline start, PDF user space. */
  x: number;
  y: number;
  /** Font size in PDF points. */
  size: number;
}

/** Baseline sits this fraction of the font size above the bbox bottom. */
const BASELINE_LIFT = 0.22;
/** Bbox height → font size (bbox covers ascender + descender). */
const SIZE_FROM_BOX = 1.08;

/**
 * Placement for a line recognized on a RENDERED PDF page.
 *
 * `scale` is the pdf.js viewport scale (px per display pt), and the render
 * is always in DISPLAY space (pdf.js applies /Rotate), so pixel → display
 * pt is a plain division before the /Rotate-aware display→user mapping.
 */
export function pdfPageLinePlacement(
  line: OcrLine,
  view: {
    rotation: number;
    x: number;
    y: number;
    width: number;
    height: number;
  },
  renderWidth: number,
  renderHeight: number,
  scale: number
): LinePlacement {
  const dx = line.x0 / scale;
  const dyUpBottom = (renderHeight - line.y1) / scale;
  const size = Math.min(
    400,
    Math.max(2, ((line.y1 - line.y0) / scale) * SIZE_FROM_BOX)
  );
  const point = displayToUser(
    view.rotation,
    view.x,
    view.y,
    view.width,
    view.height,
    dx,
    dyUpBottom + size * BASELINE_LIFT
  );
  return { text: line.text, x: point.x, y: point.y, size };
}

/**
 * Placement for a line recognized on an image that was drawn into a
 * contain-fit `box` on the page (the images→PDF recipe).
 */
export function imageBoxLinePlacement(
  line: OcrLine,
  box: { x: number; y: number; w: number; h: number },
  imageWidth: number,
  imageHeight: number
): LinePlacement {
  const sx = box.w / imageWidth;
  const sy = box.h / imageHeight;
  const size = Math.min(
    400,
    Math.max(2, (line.y1 - line.y0) * sy * SIZE_FROM_BOX)
  );
  return {
    text: line.text,
    x: box.x + line.x0 * sx,
    y: box.y + (imageHeight - line.y1) * sy + size * BASELINE_LIFT,
    size,
  };
}

/* ------------------------------------------------------------------ */
/* Fonts (lazy Helvetica + on-demand embedded Devanagari)             */
/* ------------------------------------------------------------------ */

export interface TextLayerFonts {
  helv: PDFFont;
  deva: PDFFont | null;
  /** Embeds the Devanagari font on first non-Latin text (no-op after). */
  ensureDeva(text: string): Promise<void>;
}

/**
 * Fonts for the invisible layer on one output document. Helvetica is
 * embedded immediately; the Devanagari TTF is only fetched + embedded
 * when a placement actually needs it.
 */
export function createTextLayerFonts(doc: PDFDocument): TextLayerFonts {
  const fonts: TextLayerFonts = {
    helv: doc.embedStandardFont(StandardFonts.Helvetica),
    deva: null,
    async ensureDeva(text) {
      if (fonts.deva || !needsEmbeddedFont(text)) return;
      const bytes = await loadDevanagariBytes();
      doc.registerFontkit(fontkit);
      fonts.deva = await doc.embedFont(bytes, { subset: true });
    },
  };
  return fonts;
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Draws the invisible searchable layer on one page: every placement
 * becomes one opacity-0 drawText in reading order. Lines that need the
 * embedded font when it is unavailable are skipped (never a wrong-font
 * crash on a partially-loaded run).
 */
export function drawSearchableLayer(
  page: PDFPage,
  placements: LinePlacement[],
  fonts: { helv: PDFFont; deva: PDFFont | null }
): void {
  for (const placement of placements) {
    const text = sanitizeLineText(placement.text);
    if (text.length === 0) continue;
    const font = needsEmbeddedFont(text) && fonts.deva ? fonts.deva : fonts.helv;
    try {
      page.drawText(text, {
        x: placement.x,
        y: placement.y,
        size: placement.size,
        font,
        opacity: 0,
      });
    } catch {
      // A single unpresentable line never aborts the whole layer.
    }
  }
}
