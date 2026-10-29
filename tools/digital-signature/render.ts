/**
 * Digital signature — render (RB6-FIN-a4, P6-w-a port). The OWN-ENGINE
 * painter + the low-level signature-field construction, extracted from
 * worker.ts so the smoke drives the EXACT export code in bun
 * (request-signature precedent): same block geometry, same /Sig field +
 * /V placeholder dict, same serialization the byte surgeon expects.
 *
 *  - drawSignatureBlock paints the visible block (vector ink, the
 *    WinAnsi-vs-Noto split-run recipe: Latin-only blocks render with
 *    base-14 Helvetica and embed NOTHING; Devanagari or ₹ runs switch
 *    to the embedded Noto Sans Devanagari for exactly those runs) —
 *    signer CN, "Digitally signed", date, reason, location;
 *  - addSignatureField creates the REAL AcroForm /FT /Sig field with its
 *    appearance-free widget (StampContext.createSignatureField — the
 *    engine's dict recipe mirrors pdf-lib's PDFWidgetAnnotation.create +
 *    acroForm.addField + page.node.addAnnot) and sets /V to the signature
 *    dictionary: /Type /Sig, /Filter /Adobe.PPKLite, /SubFilter
 *    /adbe.pkcs7.detached, /Reason, /Location, /Name, /M (PDF date),
 *    a /Contents placeholder of exactly `placeholderHexLen` ZERO hex
 *    chars and a four-sentinel /ByteRange the model's byte surgeon
 *    rewrites in place at fixed 10-digit width.
 *
 * Everything here is pure engine — no canvas, no browser APIs — so the
 * worker and the smoke run the identical code path. Nothing is uploaded.
 */

import {
  StampContext,
  type StampFontKey,
  type StampRgb,
  type StampTtfFont,
  arr,
  encodeWinAnsiBytes,
  hstr,
  lstr,
  measureStdText,
  name,
  num,
  type PdfObj,
} from "@/lib/own/pdf";

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
  type SignRun,
} from "./model";
// isWinAnsiChar rides the ./model import above (the tool's own WinAnsi
// table — the pdf-lib PDFFont.canEncode convention the smoke vectors pin).
import type { X509Summary } from "./pkcs12";

/* ------------------------------------------------------------------ */
/* Palette + fonts                                                      */
/* ------------------------------------------------------------------ */

const COL_TEXT: StampRgb = { r: 0.067, g: 0.067, b: 0.067 };
const COL_MUTED: StampRgb = { r: 0.35, g: 0.37, b: 0.4 };
const COL_ACCENT: StampRgb = { r: 0.043, g: 0.42, b: 0.302 };
const COL_RULE: StampRgb = { r: 0.55, g: 0.57, b: 0.6 };

/** The font bundle the worker prepares before calling in. */
export interface BlockFonts {
  /** Standard-font key for Latin runs (embeds nothing). */
  base: StampFontKey;
  /** Standard-font key for Latin bold runs. */
  bold: StampFontKey;
  /** null on the pure-WinAnsi path (nothing embedded). */
  deva: StampTtfFont | null;
}

export interface BlockPlan {
  /** Final user-space rect (points, y up, MediaBox offset applied). */
  rect: { x: number; y: number; w: number; h: number };
  /** Display-space rect (what the user sees — the smoke's oracle). */
  display: { left: number; top: number; w: number; h: number };
}

/* ------------------------------------------------------------------ */
/* Split-run text helpers (WinAnsi + Devanagari in one string)          */
/* ------------------------------------------------------------------ */

function runIsDeva(fonts: BlockFonts, deva: boolean): boolean {
  return deva && fonts.deva !== null;
}

/** Width of one run with the split-run rule. */
function runWidth(fonts: BlockFonts, text: string, deva: boolean, size: number): number {
  return runIsDeva(fonts, deva)
    ? fonts.deva!.measure(text, size)
    : measureStdText(text, fonts.base, size);
}

/** Width of a string with the split-run rule (right face per run). */
export function measureText(fonts: BlockFonts, text: string, size: number): number {
  let w = 0;
  for (const run of splitTextRuns(text)) {
    w += runWidth(fonts, run.text, run.deva, size);
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
  ctx: StampContext,
  slot: number,
  fonts: BlockFonts,
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
    // The SAME face for both passes — Latin bold is the double-stroke
    // trick over the REGULAR face (the original never swapped to a bold
    // face here; fonts.bold exists for other callers).
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
      // No bold Noto face — the create-invoice double-stroke trick,
      // offset along the rotated baseline + text-down direction.
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
  }
}

/* ------------------------------------------------------------------ */
/* The visible signature block                                          */
/* ------------------------------------------------------------------ */

/**
 * Paints the visible block on `slot`: a hairline frame with an accent
 * top rule, then the signer CN (bold), the "Digitally signed" date line
 * and the optional reason / location rows — all vector ink under the
 * appearance-free widget. Returns the display-space plan (the smoke's
 * hand-checkable geometry).
 */
export function drawSignatureBlock(
  ctx: StampContext,
  slot: number,
  run: SignRun,
  summary: X509Summary,
  signDate: string,
  fonts: BlockFonts
): BlockPlan {
  const allowNoto = fonts.deva !== null;
  const info = ctx.pages[slot]!;
  const mediaBox = info.mediaBox;
  const userW = mediaBox[2] - mediaBox[0];
  const userH = mediaBox[3] - mediaBox[1];
  const rotation = ((info.rotate % 360) + 360) % 360;
  const disp = displaySize(rotation, userW, userH);
  const drect = positionToDisplayRect(run.position, disp.w, disp.h);
  const u = displayRectToUser(drect, rotation, userW, userH, mediaBox[0], mediaBox[1]);

  // --- frame ----------------------------------------------------------
  ctx.stampRect(slot, {
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
      ctx.stampLine(slot, {
        start: { x: u.x + u.w - ruleInset, y: u.y + ruleInset },
        end: { x: u.x + u.w - ruleInset, y: u.y + u.h - ruleInset },
        thickness: 1.5,
        color: COL_ACCENT,
      });
      break;
    case 180:
      ctx.stampLine(slot, {
        start: { x: u.x + ruleInset, y: u.y + u.h - ruleInset },
        end: { x: u.x + u.w - ruleInset, y: u.y + u.h - ruleInset },
        thickness: 1.5,
        color: COL_ACCENT,
      });
      break;
    case 270:
      ctx.stampLine(slot, {
        start: { x: u.x + ruleInset, y: u.y + ruleInset },
        end: { x: u.x + u.w - ruleInset, y: u.y + ruleInset },
        thickness: 1.5,
        color: COL_ACCENT,
      });
      break;
    default:
      ctx.stampLine(slot, {
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
    opts: { bold?: boolean; color?: StampRgb } = {}
  ): void => {
    const at = anchor(padX, fromTop);
    drawSplitLine(ctx, slot, fonts, truncate(sanitizeText(text, allowNoto), size), at.x, at.y, size, {
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

/** UTF-16BE bytes with the FEFF BOM (surrogate pairs handled). */
function utf16beBytes(s: string): Uint8Array {
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
  const out = new Uint8Array(2 + units.length * 2);
  out[0] = 0xfe;
  out[1] = 0xff;
  for (let i = 0; i < units.length; i += 1) {
    out[2 + i * 2] = units[i]! >> 8;
    out[3 + i * 2] = units[i]! & 0xff;
  }
  return out;
}

function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * A text string for the /Reason /Location /Name entries: a literal PDF
 * string when every char is WinAnsi-safe, else a UTF-16BE hex string
 * with the BOM (PDF 32000 §7.9.2.2 — how Acrobat carries Devanagari).
 */
export function pdfTextStringValue(s: string): PdfObj {
  let winAnsi = true;
  for (const ch of s) {
    if (!isWinAnsiChar(ch.codePointAt(0) ?? 0)) {
      winAnsi = false;
      break;
    }
  }
  if (winAnsi) {
    return lstr(new Uint8Array(encodeWinAnsiBytes(s, "helvetica")));
  }
  return hstr(utf16beBytes(s));
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
  byteRange: [number, number, number, number];
  /** The /Contents placeholder hex length. */
  placeholderHexLen: number;
}

/** The four-sentinel /ByteRange — exactly 10 digits each. */
const BR_SENTINEL = 1111111111;

/**
 * Creates ONE real signature field over `rect` with the /V placeholder
 * dictionary the model's byte surgeon finalizes (the engine method
 * mirrors pdf-lib's registration order: V dict → field dict → widget):
 *
 *   field dict  { FT: /Sig, T: <name>, V: <sigDict>, Kids: [widget] }
 *   — pushed into the AcroForm's /Fields array;
 *   widget      { Subtype: /Widget, Rect, P, F: Print } — registered as
 *   the field's single /Kids entry, pushed into the page's /Annots.
 *
 * The /V dict carries the four-sentinel /ByteRange (1111111111 ×4 —
 * exactly 10 digits each) and the /Contents zero-hex gap; write() must
 * run in the engine's classic mode (no object streams) so both land as
 * plain searchable bytes.
 */
export function addSignatureField(
  ctx: StampContext,
  slot: number,
  input: SigFieldInput
): SigFieldResult {
  // Insertion order matters: /ByteRange precedes /Contents, so the
  // array sits a few bytes before the gap in the saved bytes (the
  // surgeon's search window).
  const value: Array<[string, PdfObj]> = [
    ["Type", name("Sig")],
    ["Filter", name("Adobe.PPKLite")],
    ["SubFilter", name("adbe.pkcs7.detached")],
    [
      "ByteRange",
      arr(num(BR_SENTINEL), num(BR_SENTINEL), num(BR_SENTINEL), num(BR_SENTINEL)),
    ],
    // N hex '0' chars = N/2 zero bytes through the writer's hex encoder.
    ["Contents", hstr(new Uint8Array(input.placeholderHexLen >> 1))],
  ];
  if (input.reason !== "") value.push(["Reason", pdfTextStringValue(input.reason)]);
  if (input.location !== "") value.push(["Location", pdfTextStringValue(input.location)]);
  if (input.signerName !== "") value.push(["Name", pdfTextStringValue(input.signerName)]);
  value.push(["M", lstr(asciiBytes(pdfDateString(input.signingTime)))]);

  ctx.createSignatureField({
    name: input.fieldName,
    slot,
    rect: { x: input.rect.x, y: input.rect.y, width: input.rect.w, height: input.rect.h },
    value,
  });

  return {
    fieldName: input.fieldName,
    byteRange: [BR_SENTINEL, BR_SENTINEL, BR_SENTINEL, BR_SENTINEL],
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
