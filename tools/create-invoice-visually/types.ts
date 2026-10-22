/**
 * Create invoice visually (RB5-a) — the WYSIWYG canvas document model.
 *
 * The visual designer's whole state is ONE plain, serializable value:
 * an ordered list of absolutely-positioned elements (array order =
 * z-order, index 0 painted first), the shared items + tax + currency,
 * and the document number used for the output file name. Everything a
 * render needs — nothing about the DOM, the worker or storage — so the
 * same value flows to the live canvas preview, the localStorage draft,
 * the `canvas` run option and the worker boundary untouched.
 *
 * Coordinate system: canvas px @ 96 dpi on a FIXED A4 portrait page.
 * PDF points are exactly px × 72/96 (×0.75); the page is 595.28 ×
 * 841.89 pt = 793.7 × 1122.5 px, and the on-screen sheet is that px
 * box shown at a CSS scale. What you drag is what prints.
 */

/** Page geometry in PDF points (this tool is A4 portrait only — honest). */
export interface PageSpec {
  wPt: number;
  hPt: number;
}

/** The fixed A4 portrait page (matches pdf-lib's A4 to the 0.01 pt). */
export const PAGE_A4: PageSpec = { wPt: 595.28, hPt: 841.89 };

/** px → pt conversion at the canvas' 96 dpi (×72/96 = ×0.75, exact). */
export const PT_PER_PX = 72 / 96;
/** pt → px conversion (×96/72 = ×4/3). */
export const PX_PER_PT = 96 / 72;

/** Full canvas size in px @ 96 dpi (595.28 pt × 4/3, 841.89 pt × 4/3). */
export const CANVAS_W_PX = PAGE_A4.wPt * PX_PER_PT;
export const CANVAS_H_PX = PAGE_A4.hPt * PX_PER_PT;

/** Text alignment inside a text element (PDF mirrors it 1:1). */
export type CanvasAlign = "left" | "center" | "right";

/** The four element kinds the designer can place. */
export type ElementKind = "text" | "logo" | "table" | "totals";

interface ElementBase {
  id: string;
  kind: ElementKind;
  /** Top-left corner in canvas px @ 96 dpi (PDF pt = ×0.75). */
  x: number;
  y: number;
  /** Width in canvas px (height of text/table/totals is derived). */
  w: number;
}

/**
 * A free text block. `text` may contain hard \n breaks; the renderer
 * word-wraps to the element width. `size` is the font size in pt.
 */
export interface TextElement extends ElementBase {
  kind: "text";
  text: string;
  size: number;
  bold: boolean;
  italic: boolean;
  /** "#rrggbb". */
  color: string;
  align: CanvasAlign;
}

/**
 * The logo / image slot. `src` is a PNG or JPEG data URL (the surface
 * converts anything it accepts; SVG is rejected honestly — the PDF
 * renderer embeds raster images only). Empty string = an empty slot
 * that draws NOTHING in the PDF (the placeholder is designer-only).
 */
export interface LogoElement extends ElementBase {
  kind: "logo";
  /** Height in canvas px — the only element with a user-set height. */
  h: number;
  src: string;
}

/** One line item. `amount` is always derived: round2(qty × rate). */
export interface TableRow {
  id: string;
  desc: string;
  qty: number;
  rate: number;
}

/**
 * The items table view. Shows EVERY row of the shared `items` list
 * (there is normally exactly one table element; deleting it removes
 * the numbers from the page but keeps the data in the editor).
 */
export interface TableElement extends ElementBase {
  kind: "table";
  /** Table font size in pt (header + body). */
  size: number;
}

/**
 * The totals block: subtotal, single tax % → amount, grand total —
 * computed from the shared items + taxPct, never hand-typed.
 */
export interface TotalsElement extends ElementBase {
  kind: "totals";
  /** Totals font size in pt. */
  size: number;
}

export type CanvasElement =
  | TextElement
  | LogoElement
  | TableElement
  | TotalsElement;

/** The editable document (no locale strings inside — see CanvasRun). */
export interface InvoiceCanvasDoc {
  /** Paint order = array order (bring forward swaps neighbours). */
  elements: CanvasElement[];
  /** Shared line items shown by the table element(s). */
  items: TableRow[];
  /** One tax percentage for the whole invoice (0–50, NOT GST-specific). */
  taxPct: number;
  /** Currency symbol drawn before amounts ("₹" forces the Noto font). */
  currency: string;
  /** Document number; drives the output file name when non-empty. */
  docNumber: string;
}

/** Worker run payload — the doc plus resolved labels and locale. */
export interface CanvasRun {
  d: InvoiceCanvasDoc;
  /**
   * Display labels pre-resolved through the surface's t() so the PDF
   * matches the UI language exactly (the create-invoice/resume recipe).
   * Keys used: desc, qty, rate, amount, subtotal, tax, total, fileWord.
   */
  labels: Record<string, string>;
  locale: "en" | "hi";
}

/* ------------------------------------------------------------------ */
/* Serialize / deserialize (plain JSON, no schema dependency)           */
/* ------------------------------------------------------------------ */

function isCanvasElementShape(v: unknown): v is CanvasElement {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    (o.kind === "text" ||
      o.kind === "logo" ||
      o.kind === "table" ||
      o.kind === "totals") &&
    typeof o.x === "number" &&
    typeof o.y === "number" &&
    typeof o.w === "number"
  );
}

/**
 * Serialize a run payload for the `canvas` worker option. JSON only —
 * the worker re-validates everything (parseCanvasRun) so a tampered
 * string can never reach the renderer.
 */
export function serializeCanvas(run: CanvasRun): string {
  return JSON.stringify(run);
}

/**
 * Light-shape deserialize (draft restore + smoke round-trip). Returns
 * null when the string is not JSON or not a CanvasRun shape — callers
 * fall back to defaults(). Deep clamping still goes through
 * model.parseCanvasRun before any render.
 */
export function deserializeCanvas(raw: string): CanvasRun | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const d = o.d;
  if (typeof d !== "object" || d === null) return null;
  const doc = d as Record<string, unknown>;
  if (
    !Array.isArray(doc.elements) ||
    !doc.elements.every(isCanvasElementShape) ||
    !Array.isArray(doc.items) ||
    typeof doc.taxPct !== "number" ||
    typeof doc.currency !== "string" ||
    typeof doc.docNumber !== "string" ||
    typeof o.labels !== "object"
  ) {
    return null;
  }
  return {
    d: {
      elements: doc.elements as CanvasElement[],
      items: doc.items as TableRow[],
      taxPct: doc.taxPct,
      currency: doc.currency,
      docNumber: doc.docNumber,
    },
    labels: (o.labels ?? {}) as Record<string, string>,
    locale: o.locale === "hi" ? "hi" : "en",
  };
}
