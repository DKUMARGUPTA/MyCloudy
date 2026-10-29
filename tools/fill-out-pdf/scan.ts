import {
  listPages,
  parsePdf,
  readAcroFormFields,
  type AcroFieldInfo,
} from "@/lib/own/pdf";

/**
 * Fill out PDF forms — scan module (PRD §8.2 "Fill out": "Existing form
 * fields highlight; Tab navigation; checkbox/radio/dropdown").
 *
 * P6-p: OUR engine's AcroForm reader (src/lib/own/pdf/acroform.ts — the
 * pdf-lib PDFForm.getFields() parity walk) replaces the pdf-lib read: the
 * same kinds, names, values, flags, options and widget rectangles, now from
 * the own parser (sync, zero pdf-lib). Runs on the main thread against the
 * file bytes — read only, nothing is ever uploaded (mode D tool).
 */

export type FillFieldKind =
  | "text"
  | "checkbox"
  | "radio"
  | "dropdown"
  | "optionlist";

export interface FillWidget {
  /** 0-based page index (best effort — 0 when a widget hides its page). */
  page: number;
  /** Widget rect in PDF user space (points, y up, normalized positive). */
  rect: { x: number; y: number; w: number; h: number };
}

export interface FillFieldScan {
  /** Fully qualified field name (the worker key is "f:<name>"). */
  name: string;
  /** Short display label (last path segment of the qualified name). */
  label: string;
  kind: FillFieldKind;
  widgets: FillWidget[];
  readOnly: boolean;
  required: boolean;
  multiline: boolean;
  maxLength: number | null;
  /** Current value in the file: text string / checkbox boolean / export value. */
  value: string | boolean | null;
  /** Selected export values for multi-select kinds (optionlist). */
  selected: string[];
  /** Choices for radio / dropdown / optionlist fields. */
  options: string[];
}

export interface FormScan {
  pageCount: number;
  /** User-space page geometry (points) + /Rotate, for highlight mapping. */
  pages: { rotation: number; width: number; height: number }[];
  fields: FillFieldScan[];
}

function lastSegment(name: string): string {
  const parts = name.split(".");
  return parts[parts.length - 1] || name;
}

/** CP1252's 0x80-0x9F punctuation block (typed literally). */
const WINANSI_PUNCT = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

/**
 * True when Helvetica (WinAnsi) can encode every character — the check the
 * worker uses to decide which filled text fields need the embedded
 * Devanagari font before the save-time appearance regeneration runs.
 */
export function isWinAnsiText(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) continue;
    if (code >= 0xa0 && code <= 0xff) continue;
    if (WINANSI_PUNCT.includes(ch)) continue;
    return false;
  }
  return true;
}

/** One AcroFieldInfo → the surface's field shape (skip non-fillable kinds). */
function toScanField(field: AcroFieldInfo): FillFieldScan | null {
  if (field.name === "") return null; // unnamed fields cannot be addressed
  const widgets = field.widgets.map((widget) => ({
    page: widget.page,
    rect: { x: widget.rect.x, y: widget.rect.y, w: widget.rect.w, h: widget.rect.h },
  }));
  const base = {
    name: field.name,
    label: lastSegment(field.name),
    widgets,
    readOnly: field.readOnly,
    required: field.required,
  };
  switch (field.kind) {
    case "text":
      return {
        ...base,
        kind: "text",
        multiline: field.multiline,
        maxLength: field.maxLength !== null && field.maxLength >= 0 ? field.maxLength : null,
        value: field.value,
        selected: [],
        options: [],
      };
    case "checkbox":
      return {
        ...base,
        kind: "checkbox",
        multiline: false,
        maxLength: null,
        value: field.value === true,
        selected: [],
        options: [],
      };
    case "radio":
      return {
        ...base,
        kind: "radio",
        multiline: false,
        maxLength: null,
        value: field.value,
        selected: field.value !== null ? [field.value as string] : [],
        options: field.options,
      };
    case "dropdown":
    case "optionlist":
      return {
        ...base,
        kind: field.kind,
        multiline: false,
        maxLength: null,
        value: field.value,
        selected: field.selected,
        options: field.options,
      };
    default:
      // Signature fields and pushbuttons are skipped — nothing to fill.
      return null;
  }
}

/**
 * Scan the AcroForm of a PDF (throws on unreadable/encrypted files — the
 * surface maps any failure to its honest "form could not be read" state).
 */
export async function scanFormFields(
  bytes: Uint8Array | ArrayBuffer
): Promise<FormScan> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const doc = parsePdf(data); // typed encrypted/corrupt errors
  const fields: FillFieldScan[] = [];
  for (const field of readAcroFormFields(doc)) {
    const scanField = toScanField(field);
    if (scanField !== null) fields.push(scanField);
  }
  const pages = listPages(doc);
  return {
    pageCount: pages.length,
    pages: pages.map((page) => ({
      rotation: page.rotate,
      width: page.mediaBox[2] - page.mediaBox[0],
      height: page.mediaBox[3] - page.mediaBox[1],
    })),
    fields,
  };
}

/**
 * Map a user-space rect (pdf-lib, y up) to display points (pdf.js viewport
 * orientation, y down, top-left origin). Derived from the pdf.js viewport
 * transforms for /Rotate 0/90/180/270 — the same math the preview canvas
 * uses, so highlight boxes land exactly on the rendered widgets.
 */
export function userRectToDisplay(
  rect: { x: number; y: number; w: number; h: number },
  rotation: number,
  userW: number,
  userH: number
): { left: number; top: number; w: number; h: number } {
  const x1 = rect.x;
  const y1 = rect.y;
  const x2 = rect.x + rect.w;
  const y2 = rect.y + rect.h;
  let pts: { X: number; Y: number }[];
  switch (rotation) {
    case 90:
      pts = [
        { X: y1, Y: x1 },
        { X: y2, Y: x2 },
      ];
      break;
    case 180:
      pts = [
        { X: userW - x1, Y: y1 },
        { X: userW - x2, Y: y2 },
      ];
      break;
    case 270:
      pts = [
        { X: userH - y1, Y: userW - x1 },
        { X: userH - y2, Y: userW - x2 },
      ];
      break;
    default:
      pts = [
        { X: x1, Y: userH - y1 },
        { X: x2, Y: userH - y2 },
      ];
  }
  const left = Math.min(pts[0].X, pts[1].X);
  const right = Math.max(pts[0].X, pts[1].X);
  const top = Math.min(pts[0].Y, pts[1].Y);
  const bottom = Math.max(pts[0].Y, pts[1].Y);
  return { left, top, w: right - left, h: bottom - top };
}

/** Display-space page size (rotation applied) for percentage mapping. */
export function displaySize(
  rotation: number,
  userW: number,
  userH: number
): { w: number; h: number } {
  return rotation === 90 || rotation === 270
    ? { w: userH, h: userW }
    : { w: userW, h: userH };
}
