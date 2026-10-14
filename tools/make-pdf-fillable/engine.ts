import {
  PDFDocument,
  PDFCheckBox,
  PDFTextField,
  rgb,
} from "pdf-lib";

/**
 * Make PDF fillable — PURE engine (PRD §8.2 "Make fillable": "Auto-detect
 * likely fields (underlines, boxes) + manual add; field properties;
 * export as AcroForm").
 *
 * Two halves:
 *
 *  1. Geometry (smoke-locked, no pdf.js needed): candidate classification,
 *     underline merging, name suggestion from nearby text, unique naming,
 *     and the PDF-user-space ↔ display-space transforms for all four
 *     /Rotate values (mirroring pdf.js PageViewport's transform table).
 *
 *  2. The pdf-lib AcroForm builder (also bun-runnable): builds the output
 *     document from the final FieldSpec list — text fields (optionally
 *     multiline) and checkboxes with pdf-lib's own form API.
 *
 * The pdf.js-dependent half (walking page operator lists for lines and
 * boxes) lives in detect.ts and runs in the surface's main thread; it only
 * feeds these pure helpers.
 */

export type FieldKind = "text" | "multiline" | "checkbox";

/** A form field candidate — coords are PDF user-space points, y from the
 *  BOTTOM (pdf-lib convention), `page` is 0-based. */
export interface FieldSpec {
  id: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: FieldKind;
  name: string;
  /** Surface toggle — disabled candidates are NOT sent to the worker. */
  enabled: boolean;
}

/** A horizontal underline segment in user space (y = baseline height). */
export interface LineSeg {
  x1: number;
  x2: number;
  y: number;
}

/** A text item box in user space (for label matching). */
export interface TextItemBox {
  str: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// ---------------------------------------------------------------------------
// Pure geometry — candidate extraction helpers (detect.ts feeds these)
// ---------------------------------------------------------------------------

/** Minimum underline length that becomes a field (pt). Shorter segments
 *  are decoration (dashes, table rules stay under this per-glyph). */
export const MIN_LINE_PT = 30;
/** Gap between collinear segments still merged into ONE field (pt) —
 *  dashed/dotted underlines arrive as many small lineTo pairs. */
export const MERGE_GAP_PT = 14;
/** Height above an underline that the text field occupies (pt). */
export const LINE_FIELD_H_PT = 16;
/** Lift the field 2pt above the line so typed text sits on it (pt). */
export const LINE_LIFT_PT = 2;

/** Checkbox candidate square bounds (pt). */
export const CHECKBOX_MIN = 7;
export const CHECKBOX_MAX = 20;
/** Rect → text-box candidate bounds (pt): wide and single-line tall. */
export const BOX_TEXT_MIN_W = 50;
export const BOX_TEXT_MAX_H = 46;

/** Merge collinear horizontal segments on the same baseline whose gaps
 *  are under MERGE_GAP_PT. Input order doesn't matter; output is sorted. */
export function mergeLineSegments(segments: LineSeg[]): LineSeg[] {
  const byBaseline = new Map<number, LineSeg[]>();
  for (const seg of segments) {
    const lo = Math.min(seg.x1, seg.x2);
    const hi = Math.max(seg.x1, seg.x2);
    const key = Math.round(seg.y);
    const bucket = byBaseline.get(key) ?? [];
    bucket.push({ x1: lo, x2: hi, y: key });
    byBaseline.set(key, bucket);
  }
  const merged: LineSeg[] = [];
  for (const bucket of byBaseline.values()) {
    bucket.sort((a, b) => a.x1 - b.x1);
    let current: LineSeg | null = null;
    for (const seg of bucket) {
      if (current === null) {
        current = { ...seg };
        continue;
      }
      if (seg.x1 <= current.x2 + MERGE_GAP_PT) {
        current.x2 = Math.max(current.x2, seg.x2);
      } else {
        merged.push(current);
        current = { ...seg };
      }
    }
    if (current !== null) merged.push(current);
  }
  return merged.filter((s) => s.x2 - s.x1 >= MIN_LINE_PT);
}

/** Classify a stroked/filled rectangle: checkbox square, text box, or
 *  nothing (decoration). Width/height in user-space points. */
export function classifyRect(
  w: number,
  h: number
): "checkbox" | "textbox" | null {
  const aw = Math.abs(w);
  const ah = Math.abs(h);
  const squareish = Math.abs(aw - ah) <= Math.max(6, Math.min(aw, ah) * 0.45);
  if (
    aw >= CHECKBOX_MIN &&
    aw <= CHECKBOX_MAX &&
    ah >= CHECKBOX_MIN &&
    ah <= CHECKBOX_MAX &&
    squareish
  ) {
    return "checkbox";
  }
  if (aw >= BOX_TEXT_MIN_W && ah >= 10 && ah <= BOX_TEXT_MAX_H) {
    return "textbox";
  }
  return null;
}

/** Underline → field rect: sits on the line, lifted LINE_LIFT_PT. */
export function lineToSpecRect(seg: LineSeg): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const x = Math.min(seg.x1, seg.x2);
  const w = Math.abs(seg.x2 - seg.x1);
  return {
    x,
    y: seg.y + LINE_LIFT_PT,
    w,
    h: LINE_FIELD_H_PT,
  };
}

/** The label for a field rect: the closest text item whose right edge is
 *  within 240pt to the LEFT of the rect (or directly above for checkbox
 *  squares). Returns a cleaned base name or null. */
export function labelForRect(
  rect: { x: number; y: number; w: number; h: number },
  items: TextItemBox[],
  kind: FieldKind
): string | null {
  const rTop = rect.y + rect.h;
  const rBot = rect.y;
  let best: { dist: number; str: string } | null = null;
  for (const item of items) {
    const text = item.str.trim();
    if (text.length === 0) continue;
    const iMid = (item.y1 + item.y2) / 2;
    if (kind === "checkbox") {
      // Above the box, roughly aligned (same column).
      const dx = Math.max(
        0,
        Math.max(rect.x, item.x1) - Math.min(rect.x + rect.w, item.x2)
      );
      const dy = item.y1 - rTop;
      if (dy < -2 || dy > 28 || dx > 24) continue;
      const dist = dx + dy;
      if (best === null || dist < best.dist) best = { dist, str: text };
    } else {
      // Left of the field, vertically overlapping the typed line.
      if (iMid < rBot - 4 || iMid > rTop + 4) continue;
      const gap = rect.x - item.x2;
      if (gap < -4 || gap > 240) continue;
      if (best === null || gap < best.dist) best = { dist: gap, str: text };
    }
  }
  if (best === null) return null;
  // "Full Name:" → "Full Name"; drop leading bullets/dashes, collapse ws.
  return best.str
    .replace(/^[\s•▪\-–—*·]+/, "")
    .replace(/[:*]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

/** Dedupe a field name against taken ones: "Name", "Name 2", "Name 3"… */
export function uniqueName(base: string, taken: Set<string>): string {
  const clean = base.replace(/\s+/g, " ").trim().slice(0, 40) || "Field";
  if (!taken.has(clean)) {
    taken.add(clean);
    return clean;
  }
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${clean} ${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  const stamped = `${clean} ${Date.now()}`;
  taken.add(stamped);
  return stamped;
}

// ---------------------------------------------------------------------------
// PDF ↔ display space transforms (all four /Rotate values)
// ---------------------------------------------------------------------------

export interface PageView {
  /** pdf.js page.view: [x0, y0, x1, y1] of the CROP box, user space. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** /Rotate 0 | 90 | 180 | 270 (normalized). */
  rotate: number;
}

/** Display (visible) page size in points, /Rotate applied. */
export function displaySize(view: PageView): { w: number; h: number } {
  const uw = view.x1 - view.x0;
  const uh = view.y1 - view.y0;
  return view.rotate === 90 || view.rotate === 270
    ? { w: uh, h: uw }
    : { w: uw, h: uh };
}

/** User-space point → display point (y down, origin top-left), matching
 *  pdf.js PageViewport with scale 1 for each rotation. */
export function pdfToDisplayPoint(
  px: number,
  py: number,
  view: PageView
): { x: number; y: number } {
  switch (view.rotate) {
    case 90:
      return { x: py - view.y0, y: px - view.x0 };
    case 180:
      return { x: view.x1 - px, y: py - view.y0 };
    case 270:
      return { x: view.y1 - py, y: view.x1 - px };
    default:
      return { x: px - view.x0, y: view.y1 - py };
  }
}

/** Display point → user-space point (inverse of pdfToDisplayPoint). */
export function displayToPdfPoint(
  dx: number,
  dy: number,
  view: PageView
): { x: number; y: number } {
  switch (view.rotate) {
    case 90:
      return { x: dy + view.x0, y: dx + view.y0 };
    case 180:
      return { x: view.x1 - dx, y: view.y0 + dy };
    case 270:
      return { x: view.x1 - dy, y: view.y1 - dx };
    default:
      return { x: dx + view.x0, y: view.y1 - dy };
  }
}

/** PDF rect (x, y, w, h; y from bottom) → display rect (x, y, w, h; y
 *  from top), /Rotate-aware. */
export function pdfRectToDisplay(
  rect: { x: number; y: number; w: number; h: number },
  view: PageView
): { x: number; y: number; w: number; h: number } {
  const corners = [
    pdfToDisplayPoint(rect.x, rect.y, view),
    pdfToDisplayPoint(rect.x + rect.w, rect.y + rect.h, view),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Display rect (y from top) → PDF rect (y from bottom), /Rotate-aware. */
export function displayRectToPdf(
  rect: { x: number; y: number; w: number; h: number },
  view: PageView
): { x: number; y: number; w: number; h: number } {
  const corners = [
    displayToPdfPoint(rect.x, rect.y, view),
    displayToPdfPoint(rect.x + rect.w, rect.y + rect.h, view),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// ---------------------------------------------------------------------------
// pdf-lib AcroForm builder (bun-runnable — the worker is a thin shim)
// ---------------------------------------------------------------------------

export interface BuildReport {
  fieldsAdded: number;
  textFields: number;
  checkboxes: number;
  pages: number;
}

export interface BuildOptions {
  /** Draw a light border around text fields (checkboxes always get one). */
  outlinedTextFields: boolean;
}

/** Count existing AcroForm fields (honest "already has N" surface copy). */
export async function countExistingFields(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, {
    updateMetadata: false,
  });
  try {
    return doc.getForm().getFields().length;
  } catch {
    return 0;
  }
}

/** Clamp specs into page bounds and drop empties; keeps order. */
export function sanitizeSpecs(
  specs: FieldSpec[],
  pageViews: PageView[]
): FieldSpec[] {
  const out: FieldSpec[] = [];
  for (const spec of specs) {
    if (!spec.enabled) continue;
    const view = pageViews[spec.page];
    if (!view) continue;
    if (!(spec.w > 4) || !(spec.h > 4)) continue;
    const page = displaySize(view);
    const x = Math.max(0, Math.min(spec.x, page.w - 6));
    const y = Math.max(0, Math.min(spec.y, page.h - 6));
    const w = Math.min(spec.w, page.w - x);
    const h = Math.min(spec.h, page.h - y);
    if (!(w > 4) || !(h > 4)) continue;
    out.push({ ...spec, x, y, w, h });
  }
  return out;
}

/**
 * Add AcroForm fields to the document. PURE pdf-lib — no pdf.js, so the
 * smoke test drives the whole builder end to end.
 */
export async function buildFieldPdf(
  bytes: Uint8Array,
  specs: FieldSpec[],
  options: BuildOptions
): Promise<{ bytes: Uint8Array; report: BuildReport }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = doc.getForm();
  const pages = doc.getPages();

  const taken = new Set<string>();
  for (const field of form.getFields()) {
    taken.add(field.getName());
  }

  let textFields = 0;
  let checkboxes = 0;
  for (const spec of specs) {
    if (!spec.enabled) continue;
    const page = pages[spec.page];
    if (!page) continue;
    const name = uniqueName(spec.name, taken);
    if (spec.kind === "checkbox") {
      const box = form.createCheckBox(name);
      const size = Math.min(spec.w, spec.h);
      // Square checkbox centered in the detected rect.
      const dx = spec.x + (spec.w - size) / 2;
      const dy = spec.y + (spec.h - size) / 2;
      box.addToPage(page, {
        x: dx,
        y: dy,
        width: size,
        height: size,
        borderWidth: 1,
        borderColor: rgb(0.45, 0.49, 0.55),
      });
      checkboxes += 1;
    } else {
      const field = form.createTextField(name);
      if (spec.kind === "multiline") field.enableMultiline();
      field.addToPage(page, {
        x: spec.x,
        y: spec.y,
        width: spec.w,
        height: spec.h,
        ...(options.outlinedTextFields
          ? { borderWidth: 1, borderColor: rgb(0.62, 0.65, 0.7) }
          : { borderWidth: 0 }),
      });
      textFields += 1;
    }
  }

  const saved = await doc.save({ useObjectStreams: true });
  return {
    bytes: saved,
    report: {
      fieldsAdded: textFields + checkboxes,
      textFields,
      checkboxes,
      pages: pages.length,
    },
  };
}

// Re-export the pdf-lib field classes the worker/surface may typecheck
// against (single import site for the pdf-lib form API).
export { PDFCheckBox, PDFTextField };
