/**
 * Create invoice visually — the vector executor (RB5-a, OUR engine since
 * P6-l).
 *
 * model.buildCommands produces the ENTIRE draw plan as pure data (every
 * text/image/rect/line with exact pt coordinates, top-left origin,
 * alignment and wrapping already resolved). This file only EXECUTES
 * that plan:
 *
 *  - fonts: pure-WinAnsi documents use base-14 Helvetica (regular /
 *    bold / oblique / bold-oblique, nothing embedded); ANY Devanagari
 *    or non-WinAnsi character (₹!) switches to the self-hosted Noto
 *    Sans Devanagari subset (OUR Type0/CIDFontType2 subsetter) — via
 *    stamp-common's deva loader in the worker (same-origin fetch,
 *    blob-URL dev recovery), or via injected bytes in the smoke (bun
 *    has no self.location).
 *  - measure: the REAL embedded font metrics flow back into
 *    buildCommands, so the PDF's word-wrap is measured with the very
 *    font it draws (not the approximation).
 *  - y-flip: commands use top-left origin; PDF y grows up — text y is
 *    a BASELINE, rects/images flip to their bottom edge.
 *  - logo: PNG or JPEG data URLs only (SYNC embeds on our engine — the
 *    old pdf-lib await trap is gone). SVG is rejected with a typed
 *    error the UI maps to an honest "convert it to PNG first" message.
 */

import {
  CreateContext,
  type CreateImage,
  type CreatePage,
  type StampFontKey,
  type StampTtfFont,
} from "@/lib/own/pdf";

import { loadDevanagariBytes } from "../stamp-common/deva";
import { PAGE_A4, type CanvasRun } from "./types";
import { buildCommands, needsNoto, type MeasureFn } from "./model";

/* ------------------------------------------------------------------ */
/* Small helpers (re-derived from the create-invoice renderer)         */
/* ------------------------------------------------------------------ */

function hexColor(s: string): { r: number; g: number; b: number } {
  const n = Number.parseInt(s.slice(1), 16);
  if (!Number.isFinite(n)) {
    return { r: 0.067, g: 0.067, b: 0.067 }; // #111 fallback
  }
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
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

/** PNG / JPEG only — the honest SVG rejection lives HERE (SYNC on our engine). */
function embedLogo(doc: CreateContext, src: string): CreateImage {
  if (/^data:image\/svg/i.test(src)) {
    throw new Error("logo-svg-not-supported");
  }
  const bytes = dataUrlBytes(src);
  if (!bytes) throw new Error("logo-decode-failed");
  try {
    if (/^data:image\/png/i.test(src)) {
      return doc.embedPng(bytes);
    }
    if (/^data:image\/jpe?g/i.test(src)) {
      return doc.embedJpeg(bytes);
    }
  } catch {
    // corrupt/truncated raster — the typed logo error, never errorGeneric.
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
  const doc = CreateContext.create();

  // ---- fonts -------------------------------------------------------
  const noto = needsNoto(run);
  let notoFont: StampTtfFont | null = null;
  if (noto) {
    const bytes = opts.notoBytes ?? (await loadDevanagariBytes());
    notoFont = doc.embedTtf(bytes);
  }
  const stdCache = new Map<string, StampFontKey>();
  const helv = (id: StampFontKey): StampFontKey => {
    const hit = stdCache.get(id);
    if (hit) return hit;
    stdCache.set(id, id);
    return id;
  };
  const helvFor = (bold: boolean, italic: boolean): StampFontKey =>
    helv(
      bold && italic
        ? "helveticaBoldOblique"
        : bold
          ? "helveticaBold"
          : italic
            ? "helveticaOblique"
            : "helvetica"
    );
  // Real metrics flow into the layout (wrap boundaries measured with
  // the exact font the PDF draws).
  const measure: MeasureFn = (text, size, bold = false) =>
    notoFont
      ? notoFont.measure(text, size)
      : doc.measure(text, helvFor(bold, false), size);

  // ---- plan + execute ----------------------------------------------
  const commands = buildCommands(run, measure);
  const page: CreatePage = doc.addPage(PAGE_A4.wPt, PAGE_A4.hPt);
  const H = PAGE_A4.hPt;
  let images = 0;

  for (const c of commands) {
    switch (c.op) {
      case "text": {
        // Noto mode: the Regular-only face covers Latin + ₹ + Devanagari;
        // bold/italic flags degrade to size/colour emphasis (honest).
        page.drawText({
          x: c.x,
          y: H - c.y, // command y = baseline from the page top
          text: c.text,
          size: c.size,
          color: hexColor(c.color),
          ...(notoFont ? { ttf: notoFont } : { font: helvFor(c.bold, c.italic) }),
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
        const img = embedLogo(doc, c.src);
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

  const bytes = doc.write();
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
