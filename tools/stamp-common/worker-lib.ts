import {
  PDFDocument,
  StandardFonts,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import "regenerator-runtime/runtime";
import fontkit from "@pdf-lib/fontkit";

import {
  type StampFontId,
  type StampMark,
  type TextMeasurer,
} from "./layout";
import type { WmFontId } from "../add-watermark/wm-options";

/**
 * Worker-side helpers shared by the page-numbers and header-footer workers:
 * stamp-font loading (standard + the self-hosted Devanagari TTF) and the
 * ONE centered drawText recipe (the exact math the preview canvas mirrors).
 *
 * The Devanagari font is fetched from THIS ORIGIN (/fonts/…, self-hosted
 * Noto Sans Devanagari, OFL — see public/fonts/NotoSansDevanagari-OFL.txt),
 * cached per worker lifetime, and embedded with { subset: true } so only the
 * used glyphs ship in the output. No user file data ever leaves the device
 * (PRD §2.2 mode D).
 */

const STANDARD_FONT_MAP: Record<WmFontId, StandardFonts> = {
  helvetica: StandardFonts.Helvetica,
  helveticaBold: StandardFonts.HelveticaBold,
  times: StandardFonts.TimesRoman,
  timesBold: StandardFonts.TimesRomanBold,
  courier: StandardFonts.Courier,
  courierBold: StandardFonts.CourierBold,
};

const DEVA_FONT_URL = "/fonts/NotoSansDevanagari-Regular.ttf";

let devaBytesPromise: Promise<Uint8Array> | null = null;

/**
 * Absolute URL for the font asset, resolved against the worker's REAL base:
 *
 * - Production / static workers are served over http(s), so resolving
 *   against `self.location.href` gives the right origin.
 * - Development (Turbopack) builds workers from `blob:` URLs, where a
 *   relative fetch("/fonts/…") throws "Failed to parse URL" (an opaque
 *   base) — but the blob URL itself embeds the origin, so we recover it
 *   from there.
 */
function devaFontUrl(): string {
  try {
    const viaLocation = new URL(DEVA_FONT_URL, self.location.href);
    if (viaLocation.protocol === "http:" || viaLocation.protocol === "https:") {
      return viaLocation.href;
    }
  } catch {
    // opaque base (blob: workers) — fall through to the blob-origin recovery
  }
  const blobOrigin = /^blob:(https?:\/\/[^/]+)/i.exec(self.location.href);
  if (blobOrigin) return `${blobOrigin[1]}${DEVA_FONT_URL}`;
  return DEVA_FONT_URL; // last resort — let fetch try its own base
}

/** Fetches the self-hosted Devanagari TTF once per worker lifetime. */
function loadDevanagariBytes(): Promise<Uint8Array> {
  if (!devaBytesPromise) {
    devaBytesPromise = fetch(devaFontUrl()).then(async (res) => {
      if (!res.ok) throw new Error("devanagari-font-fetch");
      return new Uint8Array(await res.arrayBuffer());
    });
    devaBytesPromise.catch(() => {
      devaBytesPromise = null; // retry on the next run
    });
  }
  return devaBytesPromise;
}

export interface StampFonts {
  fontFor: (fontId: StampFontId) => PDFFont;
  measure: TextMeasurer;
}

/**
 * Embeds the fonts a stamp run needs. `needDevanagari` must be decided
 * BEFORE measuring (the widths feed the placement math): pass true when the
 * resolved option values can produce non-WinAnsi text (Hindi digits,
 * Devanagari field text, a non-ASCII {filename} / {title}).
 */
export async function loadStampFonts(
  doc: PDFDocument,
  needDevanagari: boolean
): Promise<StampFonts> {
  const standard = new Map<StampFontId, PDFFont>();
  const fontFor = (fontId: StampFontId): PDFFont => {
    const existing = standard.get(fontId);
    if (existing) return existing;
    // embedStandardFont is synchronous for the 14 built-in fonts
    // (verified against pdf-lib 1.17.1 before this file was written).
    const pdfFont = doc.embedStandardFont(
      STANDARD_FONT_MAP[fontId as WmFontId]
    );
    standard.set(fontId, pdfFont);
    return pdfFont;
  };

  let deva: PDFFont | null = null;
  if (needDevanagari) {
    doc.registerFontkit(fontkit);
    const bytes = await loadDevanagariBytes();
    deva = await doc.embedFont(bytes, { subset: true });
  }

  return {
    fontFor: (fontId) =>
      fontId === "devanagari"
        ? (deva ?? fontFor("helvetica"))
        : fontFor(fontId),
    measure: (text, fontId, size) =>
      (
        fontId === "devanagari"
          ? (deva ?? fontFor("helvetica"))
          : fontFor(fontId)
      ).widthOfTextAtSize(text, size),
  };
}

/**
 * Draws one mark center-anchored at (cx, cy) — the exact math the preview
 * canvas uses: the baseline sits 0.25em above the box bottom so the em-box
 * middle matches the canvas "middle" baseline.
 */
export function drawStampMark(
  page: PDFPage,
  mark: StampMark,
  font: PDFFont
): void {
  const textW = font.widthOfTextAtSize(mark.text, mark.size);
  page.drawText(mark.text, {
    x: mark.cx - textW / 2,
    y: mark.cy - mark.size * 0.25,
    size: mark.size,
    font,
    opacity: mark.opacity,
  });
}

/** Strips path separators + unsafe chars from a download display name. */
export function safeStampBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}
