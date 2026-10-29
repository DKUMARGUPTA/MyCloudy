/**
 * Request signature — render (RB6-b, P6-w-a port). The OWN-ENGINE painter
 * for the signing pack, extracted from worker.ts so the smoke script
 * drives the EXACT export code in bun (create-fillable-pdf-form
 * precedent): same geometry, same /Sig field construction, same note
 * layout.
 *
 *  - drawSignHereBoxes paints, per user-placed spot, a visible numbered
 *    "Sign here" placeholder — a DASHED amber rectangle with the spot
 *    number + label + recipient + due date — and (optionally) lays a REAL
 *    empty AcroForm signature field (/FT /Sig) over exactly that rect via
 *    StampContext.createSignatureField (the engine's low-level dict
 *    recipe: an {FT /Sig, T} field dict pushed into the AcroForm's
 *    /Fields array + an appearance-free widget-annotation kid carrying
 *    /Rect + /P + the Print flag, pushed into the page's /Annots — the
 *    equivalent of what PDFAcroText.create + addFieldToParent + addToPage
 *    did under pdf-lib; /Sig has no high-level creator anywhere).
 *  - buildNotePdf paints the request-note PDF (A4, vector text, the
 *    WinAnsi-vs-Noto split-run recipe: Latin-only notes use base-14
 *    Helvetica and embed NOTHING; Devanagari or ₹ runs switch to the
 *    embedded Noto Sans Devanagari for exactly those runs).
 *
 * Everything here is pure engine — no canvas, no browser APIs — so the
 * worker and the smoke run the identical code path. Nothing is uploaded.
 */

import {
  CreateContext,
  StampContext,
  readAcroFormFields,
  type CreatePage,
  type StampFontKey,
  type StampRgb,
  type StampTtfFont,
  measureStdText,
} from "@/lib/own/pdf";
import { zipSync, type Zippable } from "@/lib/own/zip";

import {
  displayRectToUser,
  displaySize,
  fill,
  formatDueDate,
  labelOf,
  sanitizeText,
  sigFieldNames,
  spotDisplayRect,
  splitTextRuns,
} from "./model";
import type { RequestPackRun } from "./types";

/* ------------------------------------------------------------------ */
/* Palette + page constants                                             */
/* ------------------------------------------------------------------ */

const A4: [number, number] = [595.28, 841.89];
const NOTE_MARGIN = 40;

const COL_AMBER: StampRgb = { r: 0.78, g: 0.47, b: 0.04 };
const COL_AMBER_SOFT: StampRgb = { r: 0.55, g: 0.35, b: 0.05 };
const COL_MUTED: StampRgb = { r: 0.35, g: 0.37, b: 0.4 };
const COL_TEXT: StampRgb = { r: 0.067, g: 0.067, b: 0.067 };
const COL_RULE: StampRgb = { r: 0.55, g: 0.57, b: 0.6 };
const COL_ACCENT: StampRgb = { r: 0.043, g: 0.42, b: 0.302 };

/** The font bundle the worker prepares before calling in. */
export interface RenderFonts {
  /** Standard-font key for Latin runs (embeds nothing). */
  base: StampFontKey;
  /** Standard-font key for Latin bold runs. */
  bold: StampFontKey;
  /** null on the pure-WinAnsi path (nothing embedded). */
  deva: StampTtfFont | null;
}

export interface SpotDrawResult {
  /** The /T name of the created signature field ("" when sigFields off). */
  name: string;
  /** 0-based page index the spot landed on. */
  page: number;
  /** Final user-space rect (points, y up, MediaBox offset applied). */
  rect: { x: number; y: number; w: number; h: number };
}

export interface PreparedReport {
  spots: SpotDrawResult[];
  /** True when real /Sig fields were written. */
  sigFields: boolean;
}

/* ------------------------------------------------------------------ */
/* Split-run text helpers (WinAnsi + Devanagari in one string)          */
/* ------------------------------------------------------------------ */

function runIsDeva(fonts: RenderFonts, deva: boolean): boolean {
  return deva && fonts.deva !== null;
}

/** Width of one run with the split-run rule. */
function runWidth(fonts: RenderFonts, text: string, deva: boolean, size: number): number {
  return runIsDeva(fonts, deva)
    ? fonts.deva!.measure(text, size)
    : measureStdText(text, fonts.base, size);
}

/** Width of a string with the split-run rule (right face per run). */
export function measureText(fonts: RenderFonts, text: string, size: number): number {
  let w = 0;
  for (const run of splitTextRuns(text)) {
    w += runWidth(fonts, run.text, run.deva, size);
  }
  return w;
}

/**
 * Greedy word wrap that respects the split-run rule: words are measured
 * with the faces that will actually draw them.
 */
export function wrapRuns(
  text: string,
  fonts: RenderFonts,
  maxW: number,
  size: number
): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (measureText(fonts, candidate, size) <= maxW) {
        line = candidate;
      } else {
        if (line !== "") out.push(line);
        // Hard-break a word wider than the whole column.
        if (measureText(fonts, word, size) > maxW && word.length > 1) {
          let chunk = "";
          for (const ch of word) {
            const next = chunk + ch;
            if (measureText(fonts, next, size) > maxW && chunk !== "") {
              out.push(chunk);
              chunk = ch;
            } else {
              chunk = next;
            }
          }
          line = chunk;
        } else {
          line = word;
        }
      }
    }
    if (line !== "") out.push(line);
  }
  return out;
}

/**
 * Draws one line of (already wrapped) text starting at baseline (x, y) and
 * returns the width consumed — each run in its own face. `rotate` turns the
 * whole line (degrees CCW in user space) so text on a /Rotate 90/180/270
 * page still reads horizontally in the viewer.
 */
export function drawSplitLine(
  ctx: StampContext,
  slot: number,
  fonts: RenderFonts,
  text: string,
  x: number,
  y: number,
  size: number,
  opts: { bold?: boolean; color?: StampRgb; rotate?: number } = {}
): number {
  const color = opts.color ?? COL_TEXT;
  const theta = ((opts.rotate ?? 0) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  let cx = x;
  let cy = y;
  let consumed = 0;
  for (const run of splitTextRuns(text)) {
    const deva = runIsDeva(fonts, run.deva);
    // The SAME face for both passes — Latin bold is the double-stroke
    // trick over the REGULAR face (the original never swapped faces).
    const face = deva ? ({ ttf: fonts.deva! } as const) : ({ font: fonts.base } as const);
    ctx.stampText(slot, {
      x: cx,
      y: cy,
      text: run.text,
      size,
      ...face,
      color,
      ...(opts.rotate !== undefined ? { rotate: opts.rotate } : {}),
    });
    if (opts.bold) {
      ctx.stampText(slot, {
        x: cx + 0.3 * (cos + sin),
        y: cy + 0.3 * (sin - cos),
        text: run.text,
        size,
        ...face,
        color,
        ...(opts.rotate !== undefined ? { rotate: opts.rotate } : {}),
      });
    }
    const w = runWidth(fonts, run.text, run.deva, size);
    cx += w * cos;
    cy += w * sin;
    consumed += w;
  }
  return consumed;
}

/* ------------------------------------------------------------------ */
/* The real AcroForm signature field (the engine's low-level seam)      */
/* ------------------------------------------------------------------ */

/**
 * Creates ONE empty signature field over `rect` (the engine mirrors
 * pdf-lib's registration order):
 *
 *   field dict  { FT: /Sig, T: <name>, Kids: [widget] } — pushed into
 *   the AcroForm's /Fields array;
 *   widget      { Subtype: /Widget, Rect, P, F: Print }  — registered as
 *   the field's single /Kids entry, pushed into the page's /Annots.
 *
 * The widget is intentionally appearance-free: an empty signature field
 * renders nothing in viewers — the VISIBLE placeholder is the dashed box
 * drawn underneath by drawSignHereBoxes, at exactly this rect.
 */
export function createSigField(
  ctx: StampContext,
  slot: number,
  name: string,
  rect: { x: number; y: number; w: number; h: number }
): void {
  ctx.createSignatureField({
    name,
    slot,
    rect: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
    value: null,
  });
}

/* ------------------------------------------------------------------ */
/* The visible numbered placeholders + fields                           */
/* ------------------------------------------------------------------ */

/**
 * Paints every spot + (optionally) its real signature field. Page geometry
 * (MediaBox size/origin + /Rotate) is read per page — displayRectToUser
 * needs both to land the box where the user SAW it on the rendered page.
 */
export function drawSignHereBoxes(
  ctx: StampContext,
  run: RequestPackRun,
  fonts: RenderFonts,
  opts: { sigFields: boolean }
): PreparedReport {
  const allowNoto = fonts.deva !== null;
  const d = run.details;

  // Existing /T names — SignHere_1 must never collide with a field the
  // document already carries (Acrobat addresses fields by name).
  const existing = new Set<string>();
  if (opts.sigFields) {
    for (const field of readAcroFormFields(ctx.doc)) {
      if (field.name !== "") existing.add(field.name);
    }
  }
  const names = sigFieldNames(run.spots.length, existing);
  const dueText = d.dueDate !== "" ? formatDueDate(d.dueDate) : "";
  const report: SpotDrawResult[] = [];

  run.spots.forEach((spot, i) => {
    if (spot.page < 0 || spot.page >= ctx.pageCount) return;
    const info = ctx.pages[spot.page]!;
    const mediaBox = info.mediaBox;
    const userW = mediaBox[2] - mediaBox[0];
    const userH = mediaBox[3] - mediaBox[1];
    const rotation = ((info.rotate % 360) + 360) % 360;
    const disp = displaySize(rotation, userW, userH);
    const drect = spotDisplayRect(spot, disp.w, disp.h);
    const u = displayRectToUser(
      drect,
      rotation,
      userW,
      userH,
      mediaBox[0],
      mediaBox[1]
    );

    // --- the visible dashed placeholder (vector ink) ------------------
    ctx.stampRect(spot.page, {
      x: u.x,
      y: u.y,
      width: u.w,
      height: u.h,
      borderColor: COL_AMBER,
      borderWidth: 1.25,
      borderDashArray: [4, 3],
    });

    const padX = 7;
    const label = sanitizeText(`${i + 1}. ${labelOf(run, "boxLabel")}`, allowNoto);
    // Truncate the label to the DISPLAY box width (ink never overflows the
    // dash). On /Rotate 90/270 pages the user-space width is the swapped
    // axis — measuring against it truncated the label ("2. Sign ").
    let shown = label;
    while (shown.length > 2 && measureText(fonts, shown, 9.5) > disp.w - 2 * padX) {
      shown = shown.slice(0, -1);
    }
    // Text must read horizontally on the RENDERED (rotated) page: the glyph
    // baseline is pre-rotated by the page /Rotate and the anchor is the
    // display top-left of the box mapped back to user space (pdf.js
    // viewport math, the same convention displayRectToUser inverts).
    const anchor = (fromLeft: number, fromTop: number): { x: number; y: number } => {
      switch (rotation) {
        case 90:
          return { x: u.x + fromTop, y: u.y + fromLeft };
        case 180:
          return { x: u.x + u.w - fromLeft, y: u.y + fromTop };
        case 270:
          return { x: u.x + u.w - fromTop, y: u.y + u.h - fromLeft };
        default:
          return { x: u.x + fromLeft, y: u.y + u.h - fromTop };
      }
    };
    const labelAt = anchor(padX, 13.5);
    drawSplitLine(ctx, spot.page, fonts, shown, labelAt.x, labelAt.y, 9.5, {
      bold: true,
      color: COL_AMBER_SOFT,
      rotate: rotation,
    });

    if (disp.h >= 34) {
      if (d.recipientName !== "") {
        const forLine = sanitizeText(
          `${labelOf(run, "forLabel")} ${d.recipientName}`,
          allowNoto
        );
        const at = anchor(padX, 24);
        drawSplitLine(ctx, spot.page, fonts, forLine, at.x, at.y, 7.5, {
          color: COL_MUTED,
          rotate: rotation,
        });
      }
      if (dueText !== "") {
        const dueLine = sanitizeText(
          `${labelOf(run, "dueLabel")} ${dueText}`,
          allowNoto
        );
        const at = anchor(padX, 33.5);
        drawSplitLine(ctx, spot.page, fonts, dueLine, at.x, at.y, 7.5, {
          color: COL_MUTED,
          rotate: rotation,
        });
      }
    }

    // --- the real empty AcroForm signature field over the same rect ---
    if (opts.sigFields) {
      createSigField(ctx, spot.page, names[i]!, u);
    }
    report.push({ name: names[i]!, page: spot.page, rect: u });
  });

  return { spots: report, sigFields: opts.sigFields };
}

/* ------------------------------------------------------------------ */
/* The request-note PDF                                                 */
/* ------------------------------------------------------------------ */

/**
 * Paints the request note into a FRESH A4 document (the worker creates
 * the CreateContext + fonts, then calls this): subject, recipient/sender/
 * due date/document rows, the message, the numbered spot list (page +
 * position as the user placed it) and the "open in any PDF signer"
 * instructions.
 */
export function buildNotePdf(
  doc: CreateContext,
  run: RequestPackRun,
  fileName: string,
  fonts: RenderFonts
): { pages: number } {
  const allowNoto = fonts.deva !== null;
  const d = run.details;
  let page: CreatePage = doc.addPage(A4[0], A4[1]);
  const pageW = A4[0];
  const colW = pageW - 2 * NOTE_MARGIN;
  let y = A4[1] - NOTE_MARGIN;
  let pageCount = 1;

  const newPage = (): void => {
    page = doc.addPage(A4[0], A4[1]);
    y = A4[1] - NOTE_MARGIN;
    pageCount += 1;
  };
  const ensure = (need: number): void => {
    if (y - need < NOTE_MARGIN) newPage();
  };
  const drawWrapped = (
    text: string,
    size: number,
    lineHeight: number,
    opts: { bold?: boolean; color?: StampRgb } = {}
  ): void => {
    const clean = sanitizeText(text, allowNoto);
    for (const line of wrapRuns(clean, fonts, colW, size)) {
      ensure(lineHeight);
      drawNoteLine(page, fonts, line, NOTE_MARGIN, y - size, size, opts);
      y -= lineHeight;
    }
  };

  // --- heading ---------------------------------------------------------
  drawNoteLine(
    page,
    fonts,
    sanitizeText(labelOf(run, "title"), allowNoto),
    NOTE_MARGIN,
    y - 22,
    22,
    { bold: true }
  );
  y -= 34;
  page.drawLine({
    start: { x: NOTE_MARGIN, y },
    end: { x: pageW - NOTE_MARGIN, y },
    thickness: 1.5,
    color: COL_ACCENT,
  });
  y -= 24;

  // --- label/value rows --------------------------------------------------
  const rows: [string, string][] = [];
  if (d.recipientName !== "") rows.push([labelOf(run, "for"), d.recipientName]);
  if (d.senderName !== "") rows.push([labelOf(run, "from"), d.senderName]);
  if (d.dueDate !== "") rows.push([labelOf(run, "due"), formatDueDate(d.dueDate)]);
  rows.push([labelOf(run, "document"), fileName]);
  if (d.subject !== "") rows.push([labelOf(run, "subject"), d.subject]);
  for (const [key, value] of rows) {
    ensure(30);
    const keyText = sanitizeText(key, allowNoto);
    const labelW = Math.max(measureText(fonts, keyText, 10), 90);
    drawNoteLine(page, fonts, keyText, NOTE_MARGIN, y - 10, 10, {
      bold: true,
      color: COL_MUTED,
    });
    const valueX = NOTE_MARGIN + labelW + 10;
    const lines = wrapRuns(
      sanitizeText(value, allowNoto),
      fonts,
      pageW - NOTE_MARGIN - valueX,
      10
    );
    lines.forEach((line, li) => {
      if (li > 0) {
        y -= 15;
        ensure(30);
      }
      drawNoteLine(page, fonts, line, valueX, y - 10, 10);
    });
    y -= 26;
  }

  // --- message -----------------------------------------------------------
  if (d.message !== "") {
    y -= 6;
    drawNoteLine(
      page,
      fonts,
      sanitizeText(labelOf(run, "message"), allowNoto),
      NOTE_MARGIN,
      y - 12,
      12,
      { bold: true }
    );
    y -= 26;
    drawWrapped(d.message, 10, 15);
    y -= 10;
  }

  // --- spot list -----------------------------------------------------------
  y -= 4;
  drawNoteLine(
    page,
    fonts,
    sanitizeText(labelOf(run, "spotsTitle"), allowNoto),
    NOTE_MARGIN,
    y - 12,
    12,
    { bold: true }
  );
  y -= 24;
  run.spots.forEach((spot, i) => {
    const line =
      `${fill(labelOf(run, "spotLine"), { n: String(i + 1), p: String(spot.page + 1) })} — ` +
      `${Math.round(spot.x * 100)}% ${labelOf(run, "whereLeft")}, ` +
      `${Math.round(spot.y * 100)}% ${labelOf(run, "whereTop")}`;
    drawWrapped(line, 10, 15);
  });
  y -= 12;

  // --- how to sign -----------------------------------------------------------
  drawNoteLine(
    page,
    fonts,
    sanitizeText(labelOf(run, "howTitle"), allowNoto),
    NOTE_MARGIN,
    y - 12,
    12,
    { bold: true }
  );
  y -= 26;
  drawWrapped(labelOf(run, "howStep1"), 10, 15);
  drawWrapped(labelOf(run, "howStep2"), 10, 15);

  // --- footer -----------------------------------------------------------------
  y = Math.max(y - 26, NOTE_MARGIN + 32);
  page.drawLine({
    start: { x: NOTE_MARGIN, y: y - 14 },
    end: { x: pageW - NOTE_MARGIN, y: y - 14 },
    thickness: 0.75,
    color: COL_RULE,
  });
  drawNoteLine(
    page,
    fonts,
    sanitizeText(labelOf(run, "privacy"), allowNoto),
    NOTE_MARGIN,
    y - 28,
    8.5,
    { color: COL_MUTED }
  );

  doc.setTitle(d.subject !== "" ? d.subject : labelOf(run, "title"));
  doc.setProducer("DocoPDF");
  doc.setCreationDate(new Date());

  return { pages: pageCount };
}

/**
 * The note painter — same split-run recipe as drawSplitLine but against a
 * CreatePage under construction (the fresh-note half of the pack).
 */
function drawNoteLine(
  page: CreatePage,
  fonts: RenderFonts,
  text: string,
  x: number,
  y: number,
  size: number,
  opts: { bold?: boolean; color?: StampRgb; rotate?: number } = {}
): void {
  const color = opts.color ?? COL_TEXT;
  const theta = ((opts.rotate ?? 0) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  let cx = x;
  let cy = y;
  for (const run of splitTextRuns(text)) {
    const deva = runIsDeva(fonts, run.deva);
    const face = deva ? ({ ttf: fonts.deva! } as const) : ({ font: fonts.base } as const);
    page.drawText({
      x: cx,
      y: cy,
      text: run.text,
      size,
      ...face,
      color,
      ...(opts.rotate !== undefined ? { rotate: opts.rotate } : {}),
    });
    if (opts.bold) {
      page.drawText({
        x: cx + 0.3 * (cos + sin),
        y: cy + 0.3 * (sin - cos),
        text: run.text,
        size,
        ...face,
        color,
        ...(opts.rotate !== undefined ? { rotate: opts.rotate } : {}),
      });
    }
    const w = runWidth(fonts, run.text, run.deva, size);
    cx += w * cos;
    cy += w * sin;
  }
}

/* ------------------------------------------------------------------ */
/* The signing pack (on-device zip — fflate, no server)                 */
/* ------------------------------------------------------------------ */

export interface PackEntry {
  name: string;
  data: Uint8Array;
}

/** zipSync wrapper — the same on-device recipe the office tools use. */
export function zipPack(entries: PackEntry[]): Uint8Array {
  const files: Zippable = {};
  for (const entry of entries) {
    files[entry.name] = entry.data;
  }
  return zipSync(files, { level: 6 });
}
