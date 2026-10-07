import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  PDFWidgetAnnotation,
} from "pdf-lib";

/**
 * Fill out PDF forms — scan module (PRD §8.2 "Fill out": "Existing form
 * fields highlight; Tab navigation; checkbox/radio/dropdown").
 *
 * Pure pdf-lib read of the AcroForm: enumerates every terminal field with
 * its kind, current value, flags, options and widget rectangles (user
 * space, y up). Runs on the main thread against the file bytes — read
 * only, nothing is ever uploaded (mode D tool).
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

function normRect(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; w: number; h: number } {
  const w = Math.abs(rect.width);
  const h = Math.abs(rect.height);
  const x = rect.width >= 0 ? rect.x : rect.x - w;
  const y = rect.height >= 0 ? rect.y : rect.y - h;
  return { x, y, w, h };
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
 * Devanagari font before doc.save() regenerates appearances.
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

/** Scan the AcroForm of a PDF (throws on encrypted files — honest error). */
export async function scanFormFields(
  bytes: Uint8Array | ArrayBuffer
): Promise<FormScan> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const doc = await PDFDocument.load(data, {
    ignoreEncryption: false,
    updateMetadata: false,
  });

  const pages = doc.getPages();
  const pageByRef = new Map<string, number>();
  pages.forEach((page, index) => {
    pageByRef.set(page.ref.toString(), index);
  });

  const widgetPage = (widget: PDFWidgetAnnotation): number => {
    const p = widget.P();
    if (p) {
      const found = pageByRef.get(p.toString());
      if (found !== undefined) return found;
    }
    // Widgets without /P: resolve the annotation's own ref and look it up
    // among the pages' /Annots arrays (rare, but honest coverage).
    const ref = doc.context.getObjectRef(widget.dict);
    if (ref) {
      const found = pageByRef.get(ref.toString());
      if (found !== undefined) return found;
    }
    return 0;
  };

  const fields: FillFieldScan[] = [];
  for (const field of doc.getForm().getFields()) {
    const name = field.getName();
    if (name === "") continue;
    const widgets = field.acroField
      .getWidgets()
      .map((widget) => ({
        page: widgetPage(widget),
        rect: normRect(widget.getRectangle()),
      }));
    const base = {
      name,
      label: lastSegment(name),
      widgets,
      readOnly: field.isReadOnly(),
      required: field.isRequired(),
    };
    // Most-specific instanceof first (optionlist before dropdown).
    if (field instanceof PDFOptionList) {
      const selected = field.getSelected();
      fields.push({
        ...base,
        kind: "optionlist",
        multiline: false,
        maxLength: null,
        value: selected[0] ?? null,
        selected,
        options: field.getOptions(),
      });
    } else if (field instanceof PDFDropdown) {
      const selected = field.getSelected();
      fields.push({
        ...base,
        kind: "dropdown",
        multiline: false,
        maxLength: null,
        value: selected[0] ?? null,
        selected,
        options: field.getOptions(),
      });
    } else if (field instanceof PDFRadioGroup) {
      const selected = field.getSelected() ?? null;
      fields.push({
        ...base,
        kind: "radio",
        multiline: false,
        maxLength: null,
        value: selected,
        selected: selected !== null ? [selected] : [],
        options: field.getOptions(),
      });
    } else if (field instanceof PDFCheckBox) {
      fields.push({
        ...base,
        kind: "checkbox",
        multiline: false,
        maxLength: null,
        value: field.isChecked(),
        selected: [],
        options: [],
      });
    } else if (field instanceof PDFTextField) {
      const max = field.getMaxLength();
      fields.push({
        ...base,
        kind: "text",
        multiline: field.isMultiline(),
        maxLength: typeof max === "number" && max >= 0 ? max : null,
        value: field.getText() ?? null,
        selected: [],
        options: [],
      });
    }
    // Signature fields and pushbuttons are skipped — nothing to fill.
  }

  return {
    pageCount: pages.length,
    pages: pages.map((page) => ({
      rotation: ((page.getRotation().angle % 360) + 360) % 360,
      width: page.getWidth(),
      height: page.getHeight(),
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
