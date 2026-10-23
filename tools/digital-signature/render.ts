/**
 * Digital signature — render (RB6-FIN-a4). The pdf-lib painter + the
 * low-level signature-field construction, extracted from worker.ts so
 * the smoke drives the EXACT export code in bun (request-signature
 * precedent): same block geometry, same /Sig field + /V placeholder
 * dict, same serialization the byte surgeon expects.
 *
 *  - drawSignatureBlock paints the visible block (vector ink, the
 *    WinAnsi-vs-Noto split-run recipe: Latin-only blocks render with
 *    base-14 Helvetica and embed NOTHING; Devanagari or ₹ runs switch
 *    to the embedded Noto Sans Devanagari for exactly those runs) —
 *    signer CN, "Digitally signed", date, reason, location;
 *  - addSignatureField creates the REAL AcroForm /FT /Sig field + its
 *    widget (request-signature's low-level dict recipe) and sets /V to
 *    the signature dictionary: /Type /Sig, /Filter /Adobe.PPKLite,
 *    /SubFilter /adbe.pkcs7.detached, /Reason, /Location, /M (PDF date),
 *    a /Contents placeholder of exactly `placeholderHexLen` ZERO hex
 *    chars and a four-sentinel /ByteRange the model's byte surgeon
 *    rewrites in place at fixed 10-digit width.
 *
 * Everything here is pure pdf-lib — no canvas, no browser APIs — so the
 * worker and the smoke run the identical code path. Nothing is uploaded.
 */

import {
  AnnotationFlags,
  PDFHexString,
  PDFName,
  PDFString,
  PDFWidgetAnnotation,
  degrees,
  rgb,
} from "pdf-lib";
import type { PDFDocument, PDFFont, PDFPage } from "pdf-lib";

import {
  displayRectToUser,
  displaySize,
  isWinAnsiChar,
  labelOf,
  needsNoto,
  positionToDisplayRect,
  pdfDateString,
  sanitizeText,
  splitTextRuns,
  type ByteRange,
  type Rect,
  type SignRun,
} from "./model";
import type { X509Summary } from "./pkcs12";

/* ------------------------------------------------------------------ */
/* Palette + fonts                                                      */
/* ------------------------------------------------------------------ */

const COL_TEXT = rgb(0.067, 0.067, 0.067);
const COL_MUTED = rgb(0.35, 0.37, 0.4);
const COL_ACCENT = rgb(0.043, 0.42, 0.302);
const COL_RULE = rgb(0.55, 0.57, 0.6);

/** The font bundle the worker embeds before calling in. */
export interface BlockFonts {
  base: PDFFont;
  bold: PDFFont;
  /** null on the pure-WinAnsi path (nothing embedded). */
  deva: PDFFont | null;
}

export interface BlockPlan {
  /** Final user-space rect (points, y up, MediaBox offset applied). */
  rect: Rect;
  /** Display-space rect (what the user sees — the smoke's oracle). */
  display: { left: number; top: number; w: number; h: number };
}

/* ------------------------------------------------------------------ */
/* Split-run text helpers (WinAnsi + Devanagari in one string)          */
/* ------------------------------------------------------------------ */

function fontFor(fonts: BlockFonts, deva: boolean): PDFFont {
  return deva && fonts.deva !== null ? fonts.deva : fonts.base;
}

/** Width of a string with the split-run rule (right face per run). */
export function measureText(fonts: BlockFonts, text: string, size: number): number {
  let w = 0;
  for (const run of splitTextRuns(text)) {
    w += fontFor(fonts, run.deva).widthOfTextAtSize(run.text, size);
  }
  return w;
}

/**
 * Draws one line of text starting at (x, y) with the split-run rule —
 * each run in its own face. `rotate` turns the whole line (degrees CCW
 * in user space) so text on a /Rotate 90/180/270 page still reads
 * horizontally in the viewer (request-signature recipe).
 */
export function drawSplitLine(
  page: PDFPage,
  fonts: BlockFonts,
  text: string,
  x: number,
  y: number,
  size: number,
  opts: { bold?: boolean; color?: ReturnType<typeof rgb>; rotate?: number } = {}
): void {
  const color = opts.color ?? COL_TEXT;
  const theta = ((opts.rotate ?? 0) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  let cx = x;
  let cy = y;
  for (const run of splitTextRuns(text)) {
    const font = fontFor(fonts, run.deva);
    page.drawText(run.text, {
      x: cx,
      y: cy,
      size,
      font,
      color,
      ...(opts.rotate !== undefined ? { rotate: degrees(opts.rotate) } : {}),
    });
    if (opts.bold) {
      // No bold Noto face — the create-invoice double-stroke trick,
      // offset along the rotated baseline + text-down direction.
      page.drawText(run.text, {
        x: cx + 0.3 * (cos + sin),
        y: cy + 0.3 * (sin - cos),
        size,
        font,
        color,
        ...(opts.rotate !== undefined ? { rotate: degrees(opts.rotate) } : {}),
      });
    }
    const w = font.widthOfTextAtSize(run.text, size);
    cx += w * cos;
    cy += w * sin;
  }
}

/* ------------------------------------------------------------------ */
/* The visible signature block                                          */
/* ------------------------------------------------------------------ */

/**
 * Paints the visible block on `page`: a hairline frame with an accent
 * top rule, then the signer CN (bold), the "Digitally signed" date line
 * and the optional reason / location rows — all vector ink under the
 * appearance-free widget. Returns the display-space plan (the smoke's
 * hand-checkable geometry).
 */
export function drawSignatureBlock(
  page: PDFPage,
  run: SignRun,
  summary: X509Summary,
  signDate: string,
  fonts: BlockFonts
): BlockPlan {
  const allowNoto = fonts.deva !== null;
  const mediaBox = page.getMediaBox();
  const userW = mediaBox.width;
  const userH = mediaBox.height;
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const disp = displaySize(rotation, userW, userH);
  const drect = positionToDisplayRect(run.position, disp.w, disp.h);
  const u = displayRectToUser(drect, rotation, userW, userH, mediaBox.x, mediaBox.y);

  // --- frame ----------------------------------------------------------
  page.drawRectangle({
    x: u.x,
    y: u.y,
    width: u.w,
    height: u.h,
    borderColor: COL_RULE,
    borderWidth: 0.75,
  });
  // Accent rule along the block's display TOP edge (rotated pages: the
  // display top edge is a different user-space edge).
  const ruleInset = 6;
  switch (rotation) {
    case 90:
      page.drawLine({
        start: { x: u.x + u.w - ruleInset, y: u.y + ruleInset },
        end: { x: u.x + u.w - ruleInset, y: u.y + u.h - ruleInset },
        thickness: 1.5,
        color: COL_ACCENT,
      });
      break;
    case 180:
      page.drawLine({
        start: { x: u.x + ruleInset, y: u.y + u.h - ruleInset },
        end: { x: u.x + u.w - ruleInset, y: u.y + u.h - ruleInset },
        thickness: 1.5,
        color: COL_ACCENT,
      });
      break;
    case 270:
      page.drawLine({
        start: { x: u.x + ruleInset, y: u.y + ruleInset },
        end: { x: u.x + ruleInset, y: u.y + u.h - ruleInset },
        thickness: 1.5,
        color: COL_ACCENT,
      });
      break;
    default:
      page.drawLine({
        start: { x: u.x + ruleInset, y: u.y + u.h - ruleInset },
        end: { x: u.x + u.w - ruleInset, y: u.y + u.h - ruleInset },
        thickness: 1.5,
        color: COL_ACCENT,
      });
  }

  // --- rows (display top-left anchored, rotated to read horizontally) --
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
  const padX = 8;
  const truncate = (text: string, size: number): string => {
    let shown = text;
    while (shown.length > 2 && measureText(fonts, shown, size) > drect.w - 2 * padX) {
      shown = shown.slice(0, -1);
    }
    return shown;
  };

  const cn = sanitizeText(summary.subjectCn, allowNoto);
  const row = (
    text: string,
    fromTop: number,
    size: number,
    opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}
  ): void => {
    const at = anchor(padX, fromTop);
    drawSplitLine(page, fonts, truncate(sanitizeText(text, allowNoto), size), at.x, at.y, size, {
      ...opts,
      rotate: rotation,
    });
  };

  row(`${labelOf(run, "blockSignedBy")} ${cn}`, 14, 9.5, { bold: true });
  row(`${labelOf(run, "blockDateLabel")} ${signDate}`, 27, 7.5, { color: COL_MUTED });
  if (run.reason !== "") {
    row(`${labelOf(run, "blockReasonLabel")} ${run.reason}`, 38, 7.5, { color: COL_MUTED });
  }
  if (run.location !== "") {
    row(`${labelOf(run, "blockLocationLabel")} ${run.location}`, 49, 7.5, { color: COL_MUTED });
  }

  return { rect: u, display: drect };
}

/* ------------------------------------------------------------------ */
/* The signature field + the /V placeholder dict                        */
/* ------------------------------------------------------------------ */

/**
 * A text string for the /Reason /Location /Name entries: a literal PDF
 * string when every char is WinAnsi-safe, else a UTF-16BE hex string
 * with the BOM (PDF 32000 §7.9.2.2 — how Acrobat carries Devanagari).
 */
export function pdfTextStringValue(s: string): PDFString | PDFHexString {
  let winAnsi = true;
  for (const ch of s) {
    if (!isWinAnsiChar(ch.codePointAt(0) ?? 0)) {
      winAnsi = false;
      break;
    }
  }
  if (winAnsi) return PDFString.of(s);
  let hex = "feff";
  const units: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0xffff) {
      units.push(cp);
    } else {
      const v = cp - 0x10000;
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }
  }
  for (const u of units) {
    hex += u.toString(16).padStart(4, "0");
  }
  return PDFHexString.of(hex.toUpperCase());
}

export interface SigFieldInput {
  /** Reserved /Contents hex length (2 × the dry-run CMS length). */
  placeholderHexLen: number;
  reason: string;
  location: string;
  signingTime: Date;
  /** Widget rect — user space; [0,0,0,0]-style for the invisible mode. */
  rect: { x: number; y: number; w: number; h: number };
  /** Unique /T name (sigFieldName). */
  fieldName: string;
  /** The signer's display name for /Name ("" → omit). */
  signerName: string;
}

export interface SigFieldResult {
  fieldName: string;
  /** The sentinel /ByteRange as written (pre-surgery). */
  byteRange: ByteRange;
  /** The /Contents placeholder hex length. */
  placeholderHexLen: number;
}

/**
 * Creates ONE real signature field over `rect` with the /V placeholder
 * dictionary the model's byte surgeon finalizes:
 *
 *   field dict  { FT: /Sig, T: <name>, V: <sigDict> }  — registered,
 *   pushed into the AcroForm's /Fields array;
 *   widget      { Subtype: /Widget, Rect, P }          — registered as
 *   the field's single /Kids entry, pushed into the page's /Annots,
 *   Print flag set.
 *
 * The /V dict carries the four-sentinel /ByteRange
 * (1111111111 ×4 — exactly 10 digits each) and the /Contents zero-hex
 * gap; save() must be called with { useObjectStreams: false } so both
 * land as plain bytes.
 */
export function addSignatureField(
  doc: PDFDocument,
  page: PDFPage,
  input: SigFieldInput
): SigFieldResult {
  const context = doc.context;

  const sigDict = context.obj({
    Type: "Sig",
    Filter: "Adobe.PPKLite",
    SubFilter: "adbe.pkcs7.detached",
    // Insertion order matters: /ByteRange precedes /Contents, so the
    // array sits a few bytes before the gap in the saved bytes (the
    // surgeon's search window).
    ByteRange: [1111111111, 1111111111, 1111111111, 1111111111],
    Contents: PDFHexString.of("0".repeat(input.placeholderHexLen)),
  });
  if (input.reason !== "") {
    sigDict.set(PDFName.of("Reason"), pdfTextStringValue(input.reason));
  }
  if (input.location !== "") {
    sigDict.set(PDFName.of("Location"), pdfTextStringValue(input.location));
  }
  if (input.signerName !== "") {
    sigDict.set(PDFName.of("Name"), pdfTextStringValue(input.signerName));
  }
  sigDict.set(PDFName.of("M"), PDFString.of(pdfDateString(input.signingTime)));
  const sigRef = context.register(sigDict);

  const fieldDict = context.obj({ FT: "Sig" });
  fieldDict.set(PDFName.of("T"), PDFString.of(input.fieldName));
  fieldDict.set(PDFName.of("V"), sigRef);
  const fieldRef = context.register(fieldDict);
  doc.getForm().acroForm.addField(fieldRef);

  const widget = PDFWidgetAnnotation.create(context, fieldRef);
  widget.setRectangle({
    x: input.rect.x,
    y: input.rect.y,
    width: input.rect.w,
    height: input.rect.h,
  });
  if (page.ref !== undefined) widget.setP(page.ref);
  widget.setFlagTo(AnnotationFlags.Print, true);
  const widgetRef = context.register(widget.dict);
  fieldDict.set(PDFName.of("Kids"), context.obj([widgetRef]));
  page.node.addAnnot(widgetRef);

  return {
    fieldName: input.fieldName,
    byteRange: [1111111111, 1111111111, 1111111111, 1111111111],
    placeholderHexLen: input.placeholderHexLen,
  };
}

/** Does the visible-block content need the Devanagari face? (worker). */
export function blockNeedsNoto(
  run: SignRun,
  summary: X509Summary,
  signDate: string
): boolean {
  return (
    needsNoto(Object.values(run.labels).join(" ")) ||
    needsNoto(run.reason) ||
    needsNoto(run.location) ||
    needsNoto(summary.subjectCn) ||
    needsNoto(summary.subjectO) ||
    needsNoto(signDate)
  );
}
