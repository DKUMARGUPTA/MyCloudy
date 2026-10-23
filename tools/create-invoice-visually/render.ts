/**
 * Create invoice visually — the pdf-lib executor (RB5-a).
 *
 * model.buildCommands produces the ENTIRE draw plan as pure data (every
 * text/image/rect/line with exact pt coordinates, top-left origin,
 * alignment and wrapping already resolved). This file only EXECUTES
 * that plan:
 *
 *  - fonts: pure-WinAnsi documents use base-14 Helvetica (regular /
 *    bold / oblique / bold-oblique, nothing embedded); ANY Devanagari
 *    or non-WinAnsi character (₹!) switches to the self-hosted Noto
 *    Sans Devanagari subset — via stamp-common's loadStampFonts in
 *    the worker (same-origin fetch, blob-URL dev recovery), or via
 *    injected bytes in the smoke (bun has no self.location).
 *  - measure: the REAL embedded font metrics flow back into
 *    buildCommands, so the PDF's word-wrap is measured with the very
 *    font it draws (not the approximation).
 *  - y-flip: commands use top-left origin; PDF y grows up — text y is
 *    a BASELINE, rects/images flip to their bottom edge.
 *  - logo: PNG or JPEG data URLs only (embedPng/embedJpg are AWAITED —
 *    the pinned create-invoice lesson). SVG is rejected with a typed
 *    error the UI maps to an honest "convert it to PNG first" message.
 */

import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFImage,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

import { loadStampFonts } from "../stamp-common/worker-lib";
import { PAGE_A4, type CanvasRun } from "./types";
import { buildCommands, needsNoto, type MeasureFn } from "./model";

/* ------------------------------------------------------------------ */
/* Small helpers (re-derived from the create-invoice renderer)         */
/* ------------------------------------------------------------------ */

function hexColor(s: string): ReturnType<typeof rgb> {
  const n = Number.parseInt(s.slice(1), 16);
  if (!Number.isFinite(n)) {
    return rgb(0.067, 0.067, 0.067); // #111 fallback
  }
  return rgb(
    ((n >> 16) & 255) / 255,
    ((n >> 8) & 255) / 255,
    (n & 255) / 255
  );
}

function dataUrlBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:image/") || comma < 0) return null;
  try {
    const b64 = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(b64.length);
    for (let i = 0; i < b64.length; i++) bytes[i] = b64.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** PNG / JPEG only — the honest SVG rejection lives HERE. */
async function embedLogo(
  doc: PDFDocument,
  src: string
): Promise<PDFImage> {
  if (/^data:image\/svg/i.test(src)) {
    throw new Error("logo-svg-not-supported");
  }
  const bytes = dataUrlBytes(src);
  if (!bytes) throw new Error("logo-decode-failed");
  try {
    if (/^data:image\/png/i.test(src)) {
      // ⚠️ embedPng/embedJpg are ASYNC (pdf-lib) — the un-awaited version
      // left width/height NaN and logos silently vanished (the pinned
      // create-invoice lesson). Always awaited here.
      return await doc.embedPng(bytes);
    }
    if (/^data:image\/jpe?g/i.test(src)) {
      return await doc.embedJpg(bytes);
    }
  } catch {
    // corrupt/truncated raster: pdf-lib's own message ("The input is not a
    // PNG file!") must still map to the typed logo error — the smoke found
    // it was falling through to tool.errorGeneric.
    throw new Error("logo-decode-failed");
  }
  throw new Error("logo-decode-failed"); // webp/gif… → honest typed error
}

/* ------------------------------------------------------------------ */
/* Renderer                                                             */
/* ------------------------------------------------------------------ */

export interface RenderCanvasReport {
  /** Elements in the run (drawn or not — empty logo slots count). */
  elementCount: number;
  /** Commands actually executed. */
  commandCount: number;
  /** "noto" = embedded Noto subset, "helvetica" = nothing embedded. */
  font: "helvetica" | "noto";
  /** Raster images embedded (logos). */
  images: number;
}

export interface RenderCanvasResult {
  bytes: Uint8Array;
  report: RenderCanvasReport;
}

/**
 * Draw the canvas run as a single-page A4 vector PDF. `opts.notoBytes`
 * lets the smoke inject the self-hosted TTF (bun has no worker
 * self.location to resolve the font URL against).
 */
export async function renderCanvasPdf(
  run: CanvasRun,
  opts: { notoBytes?: Uint8Array } = {}
): Promise<RenderCanvasResult> {
  const doc = await PDFDocument.create();

  // ---- fonts -------------------------------------------------------
  const noto = needsNoto(run);
  let notoFont: PDFFont | null = null;
  if (noto) {
    if (opts.notoBytes) {
      doc.registerFontkit(fontkit);
      notoFont = await doc.embedFont(opts.notoBytes, { subset: true });
    } else {
      const fonts = await loadStampFonts(doc, true);
      notoFont = fonts.fontFor("devanagari");
    }
  }
  const stdCache = new Map<string, PDFFont>();
  const helv = (id: StandardFonts): PDFFont => {
    const hit = stdCache.get(id);
    if (hit) return hit;
    const font = doc.embedStandardFont(id); // sync for the base-14
    stdCache.set(id, font);
    return font;
  };
  const helvFor = (bold: boolean, italic: boolean): PDFFont =>
    helv(
      bold && italic
        ? StandardFonts.HelveticaBoldOblique
        : bold
          ? StandardFonts.HelveticaBold
          : italic
            ? StandardFonts.HelveticaOblique
            : StandardFonts.Helvetica
    );
  // Real metrics flow into the layout (wrap boundaries measured with
  // the exact font the PDF draws).
  const measure: MeasureFn = (text, size, bold = false) =>
    notoFont
      ? notoFont.widthOfTextAtSize(text, size)
      : helvFor(bold, false).widthOfTextAtSize(text, size);

  // ---- plan + execute ----------------------------------------------
  const commands = buildCommands(run, measure);
  const page = doc.addPage([PAGE_A4.wPt, PAGE_A4.hPt]);
  const H = PAGE_A4.hPt;
  let images = 0;

  for (const c of commands) {
    switch (c.op) {
      case "text": {
        // Noto mode: the Regular-only face covers Latin + ₹ + Devanagari;
        // bold/italic flags degrade to size/colour emphasis (honest).
        const font = notoFont ?? helvFor(c.bold, c.italic);
        page.drawText(c.text, {
          x: c.x,
          y: H - c.y, // command y = baseline from the page top
          size: c.size,
          font,
          color: hexColor(c.color),
        });
        break;
      }
      case "rect": {
        page.drawRectangle({
          x: c.x,
          y: H - c.y - c.h,
          width: c.w,
          height: c.h,
          color: hexColor(c.color),
        });
        break;
      }
      case "line": {
        page.drawLine({
          start: { x: c.x1, y: H - c.y1 },
          end: { x: c.x2, y: H - c.y2 },
          thickness: c.width,
          color: hexColor(c.color),
        });
        break;
      }
      case "image": {
        const img = await embedLogo(doc, c.src);
        images += 1;
        page.drawImage(img, {
          x: c.x,
          y: H - c.y - c.h,
          width: c.w,
          height: c.h,
        });
        break;
      }
    }
  }

  // ---- metadata + save ----------------------------------------------
  const title = run.d.docNumber || (run.locale === "hi" ? "इनवॉइस" : "Invoice");
  doc.setProducer("DocoPDF");
  doc.setCreator("DocoPDF");
  doc.setTitle(title.slice(0, 120));
  doc.setCreationDate(new Date());

  const bytes = await doc.save();
  return {
    bytes,
    report: {
      elementCount: run.d.elements.length,
      commandCount: commands.length,
      font: noto ? "noto" : "helvetica",
      images,
    },
  };
}
