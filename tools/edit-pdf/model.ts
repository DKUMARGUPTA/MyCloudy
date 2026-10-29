/**
 * Edit PDF — PURE object model (PRD §8.2.1 flagship editor, sub-phases
 * 8.1 shell + 8.2 objects + 8.5 export).
 *
 * Everything here is framework-free and bun-testable:
 *  - the EditorObject union (text / image / shapes / freehand / whiteout)
 *  - the PDF-user-space ↔ display-space transforms for all four /Rotate
 *    values (mirroring pdf.js PageViewport — the make-pdf-fillable recipe,
 *    copied here so the SURFACE never imports pdf-lib transitively)
 *  - object factories with sane defaults + clamping/sanitising for the
 *    worker (never trust the wire blob)
 *  - z-order operations, hit-testing, bbox math, freehand normalisation
 *  - the coalescing history helper (snapshot stack semantics)
 *
 * Coordinate convention (same as make-pdf-fillable): every object rect is
 * in PDF USER-SPACE points, y measured from the BOTTOM (pdf-lib
 * convention). `page` is 0-based. Display rects (y from top) are derived
 * per page through the PageView (crop box + /Rotate).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EditorFontId =
  | "helvetica"
  | "times"
  | "courier"
  | "devanagari";

export type ObjKind =
  | "text"
  | "image"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "draw"
  | "whiteout"
  | "field";

/** AcroForm widget flavours a field object can export as (P8.4). */
export type FieldType =
  | "text"
  | "multiline"
  | "checkbox"
  | "dropdown"
  | "radio";

export type TextAlign = "left" | "center" | "right";

/** Base rect every object shares (user-space pt, y from bottom). */
export interface ObjBase {
  id: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
  locked: boolean;
  hidden: boolean;
  /** Visual rotation in degrees, CCW-positive, normalized to (-180, 180].
   * Ellipses, freehand strokes and form fields never rotate (P8.6) —
   * pdf-lib's drawEllipse has no rotate and AcroForm widgets stay upright. */
  rotation: number;
}

export interface TextObj extends ObjBase {
  kind: "text";
  text: string;
  font: EditorFontId;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: TextAlign;
  /** Background fill behind the text (null = transparent). */
  bg: string | null;
}

export interface ImageObj extends ObjBase {
  kind: "image";
  /** Key into the run-time asset store / run manifest. */
  assetKey: string;
}

export interface ShapeObj extends ObjBase {
  kind: "rect" | "ellipse" | "line" | "arrow";
  fill: string | null;
  stroke: string | null;
  strokeW: number;
  dash: boolean;
  /** line/arrow only: endpoints as fractions of the bbox. false = the
   * diagonal that reads top-left → bottom-right in DISPLAY space. */
  flip: boolean;
}

export interface DrawObj extends ObjBase {
  kind: "draw";
  /** Freehand points as [fx, fy] fractions of the bbox (0..1). */
  pts: number[][];
  stroke: string;
  strokeW: number;
}

export interface WhiteoutObj extends ObjBase {
  kind: "whiteout";
  fill: string;
}

/** A live AcroForm field placed on the page (P8.4). Checkbox default
 * state rides `value === "on"`; dropdown `value` must be one of
 * `options`; radio objects sharing one `name` form a single group and
 * each carries its own export `value`. */
export interface FieldObj extends ObjBase {
  kind: "field";
  fieldType: FieldType;
  name: string;
  value: string;
  required: boolean;
  /** Dropdown choices (dropdown only). */
  options: string[];
}

export type EditorObject =
  | TextObj
  | ImageObj
  | ShapeObj
  | DrawObj
  | WhiteoutObj
  | FieldObj;

export interface ObjRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// PageView + display transforms (pdf.js-mirrored, /Rotate-aware)
// ---------------------------------------------------------------------------

/**
 * The load-time page view subset render.ts collects (crop box + rotation).
 * pdf.js `page.view` / `page.rotate` only — no R12/R13/R15 plan fields.
 */
export type PageViewLite = Pick<
  PageView,
  "x0" | "y0" | "x1" | "y1" | "rotate"
>;

export interface PageView {
  /** pdf.js page.view: [x0, y0, x1, y1] of the CROP box, user space. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** /Rotate 0 | 90 | 180 | 270 (normalized). */
  rotate: number;
  /**
   * R13 page rotation: the /Rotate this SOURCE page shipped with (captured
   * at load, rides every plan op). The user's rotation offset reads as
   * `rotate − srcRotate` (mod 360) — badges, thumbnails and honest resets
   * key off it. Absent on stale blobs/pre-R13 drafts → treated as 0.
   */
  srcRotate?: number;
  /**
   * R12 page ops: index of the SOURCE page this workspace slot shows.
   * Identity documents (no page ops) have views[i].src === i. Reorders
   * permute the array; deletes splice it; duplicates repeat a src.
   * Optional on the wire — absent (stale blobs/drafts) means identity.
   */
  src?: number;
  /**
   * R15 page crop: the user's visible-region OVERRIDE, inside the view
   * box above (source user space, y from the bottom). Absent = show the
   * whole source crop box. Every display transform pivots through
   * `effectiveView(view)` — the crop merged into x0..y1.
   */
  crop?: CropRect;
}

/**
 * R15: the user-space rect a page is cropped to (see PageView.crop).
 * A rectangle [x0, y0, x1, y1] in PDF user space, exactly like the
 * view box.
 */
export interface CropRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Smallest crop edge the UI (and the blob guard) allows, in points. */
export const MIN_CROP_PT = 24;

/**
 * Shape check only (no box context): finite numbers forming a positive
 * rect after sorting. Used by the worker's trust mask and by
 * sanitizeCrop — garbage never reaches setCropBox.
 */
export function validCropShape(raw: unknown): CropRect | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const c = raw as Partial<Record<keyof CropRect, unknown>>;
  if (
    typeof c.x0 !== "number" || typeof c.y0 !== "number" ||
    typeof c.x1 !== "number" || typeof c.y1 !== "number" ||
    !Number.isFinite(c.x0) || !Number.isFinite(c.y0) ||
    !Number.isFinite(c.x1) || !Number.isFinite(c.y1)
  ) {
    return undefined;
  }
  const x0 = Math.min(c.x0, c.x1);
  const x1 = Math.max(c.x0, c.x1);
  const y0 = Math.min(c.y0, c.y1);
  const y1 = Math.max(c.y0, c.y1);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return undefined;
  return { x0, y0, x1, y1 };
}

/**
 * Full guard: clamps a candidate crop INTO the view box and enforces the
 * minimum size. Returns undefined for anything degenerate — a crop that
 * survives is always a sane, non-empty window inside the page. (The R13
 * lesson, applied to crop: never trust the wire — garbage crops drop to
 * identity, they never resize a page.)
 */
export function sanitizeCrop(
  raw: unknown,
  view: Pick<PageView, "x0" | "y0" | "x1" | "y1">
): CropRect | undefined {
  const shaped = validCropShape(raw);
  if (!shaped) return undefined;
  const x0 = Math.max(shaped.x0, view.x0);
  const y0 = Math.max(shaped.y0, view.y0);
  const x1 = Math.min(shaped.x1, view.x1);
  const y1 = Math.min(shaped.y1, view.y1);
  if (x1 - x0 < MIN_CROP_PT || y1 - y0 < MIN_CROP_PT) return undefined;
  return { x0, y0, x1, y1 };
}

/** The slot's crop after the full sanitize guard (undefined = uncropped). */
export function viewCrop(
  view: PageView | undefined
): CropRect | undefined {
  if (!view?.crop) return undefined;
  return sanitizeCrop(view.crop, view);
}

/**
 * R15: the view every display transform should pivot through — the crop
 * merged into the box. All the /Rotate-aware point/rect mappers only ever
 * read view.x0..x1/y0..y1, so swapping the box for the crop makes the
 * whole surface (objects, gestures, harvest pieces, F&R) crop-native
 * with zero further changes. Ref-stable for uncropped views.
 */
export function effectiveView(view: PageView): PageView {
  const crop = viewCrop(view);
  if (!crop) return view;
  return {
    ...view,
    x0: crop.x0,
    y0: crop.y0,
    x1: crop.x1,
    y1: crop.y1,
  };
}

/**
 * R15: compact crop signature for plan fingerprints ("-" when none) —
 * integer points are plenty for re-render triggers (a drag commits
 * once, far coarser than 1pt).
 */
export function cropSignature(view: PageView | undefined): string {
  const crop = viewCrop(view);
  if (!crop) return "-";
  return `c${Math.round(crop.x0)}:${Math.round(crop.y0)}:${Math.round(
    crop.x1
  )}:${Math.round(crop.y1)}`;
}

/** Display (visible) page size in points, /Rotate applied. */
export function displaySize(view: PageView): { w: number; h: number } {
  const uw = view.x1 - view.x0;
  const uh = view.y1 - view.y0;
  return view.rotate === 90 || view.rotate === 270
    ? { w: uh, h: uw }
    : { w: uw, h: uh };
}

/** User-space point → display point (y down, origin top-left). */
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

/** PDF rect (y from bottom) → display rect (y from top), /Rotate-aware. */
export function pdfRectToDisplay(rect: ObjRect, view: PageView): ObjRect {
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
export function displayRectToPdf(rect: ObjRect, view: PageView): ObjRect {
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
// R12 — Page operations (delete / reorder / duplicate), PURE
// ---------------------------------------------------------------------------

/** Snaps any rotation value to the pdf.js quadrant 0 | 90 | 180 | 270. */
function quadrantRotate(raw: unknown): number {
  const n =
    typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  const r = ((Math.trunc(n) % 360) + 360) % 360;
  return r === 90 || r === 180 || r === 270 ? r : 0;
}

/**
 * Normalises wire views: repairs missing/garbage `src` to the identity
 * position and clamps out-of-range sources. Old blobs and v1 drafts (no
 * src field) come back as identity — page ops never fire on stale data.
 * R13: `rotate`/`srcRotate` snap to quadrants (display transforms only
 * understand quadrants; anything else is tampered/stale data → 0).
 */
export function normalizeViews(
  views: PageView[],
  srcCount: number
): PageView[] {
  return views.map((view, i) => {
    const raw = view?.src;
    const src =
      typeof raw === "number" && Number.isFinite(raw) && raw >= 0
        ? Math.min(Math.trunc(raw), Math.max(0, srcCount - 1))
        : i;
    const rotate = quadrantRotate(view?.rotate);
    // R15: garbage/degenerate crops drop to identity here (clamped into
    // the view box + the minimum size); a surviving crop is re-attached
    // so the raw wire field never leaks through unsanitised.
    const { crop: rawCrop, ...rest } = view;
    const crop = sanitizeCrop(rawCrop, view);
    return {
      ...rest,
      src,
      rotate,
      srcRotate: quadrantRotate(view?.srcRotate ?? rotate),
      ...(crop ? { crop } : {}),
    };
  });
}

/**
 * True when the workspace still shows the document 1:1 (every slot i
 * shows source page i). Truncated workspaces (fewer views than sources,
 * the >500-page clamp) count as identity — the untouched tail keeps
 * exporting exactly as before R12 (zero-regression path in the worker).
 */
export function isIdentityOrder(views: PageView[], srcCount: number): boolean {
  if (views.length > srcCount) return false;
  return views.every((view, i) => (view.src ?? i) === i);
}

/**
 * R13 page rotation: turns one workspace slot by ±90° (positive =
 * clockwise on screen). The slot keeps its user-space geometry — objects
 * ride along with the page, the honest editor semantic — only the view's
 * EFFECTIVE rotation changes; export writes it as /Rotate on the output
 * page. Pure: returns the SAME array ref for out-of-range slots or no-ops.
 */
export function rotatePageViews(
  views: PageView[],
  slot: number,
  delta: number
): PageView[] {
  if (slot < 0 || slot >= views.length) return views;
  const view = views[slot];
  const next = quadrantRotate(view.rotate + delta);
  if (next === view.rotate) return views;
  const out = views.slice();
  out[slot] = { ...view, rotate: next };
  return out;
}

/**
 * R13: the user's rotation offset for a view (0 | 90 | 180 | 270) — how
 * far the slot sits from the rotation its SOURCE page shipped with.
 */
export function rotationOffset(view: PageView): number {
  const base = quadrantRotate(view?.srcRotate ?? view.rotate);
  return (quadrantRotate(view.rotate) - base + 360) % 360;
}

/**
 * R15 page crop: sets (or resets, `crop === null`) one workspace slot's
 * visible region. Pure: returns the SAME array ref for out-of-range
 * slots, explicit no-ops and crops that fail the sanitize guard (the UI
 * already clamps drags — a failure here means a tampered caller, and the
 * honest answer is "nothing changed"). The crop is USER-space, so it
 * rides page rotations exactly like the objects do (rotate the page,
 * rotate its crop).
 */
export function cropPageViews(
  views: PageView[],
  slot: number,
  crop: CropRect | null
): PageView[] {
  if (slot < 0 || slot >= views.length) return views;
  const view = views[slot];
  if (crop === null) {
    if (view.crop === undefined) return views;
    const out = views.slice();
    const { crop: _dropped, ...rest } = view;
    out[slot] = rest;
    return out;
  }
  const next = sanitizeCrop(crop, view);
  if (!next) return views;
  const current = viewCrop(view);
  if (
    current &&
    current.x0 === next.x0 &&
    current.y0 === next.y0 &&
    current.x1 === next.x1 &&
    current.y1 === next.y1
  ) {
    return views;
  }
  const out = views.slice();
  out[slot] = { ...view, crop: next };
  return out;
}

/**
 * Permutation for a drag move: old workspace position → new position.
 * `from` lands exactly on `to`; everything between shifts by one
 * (forward move: from+1..to shift DOWN; backward: to..from-1 shift UP).
 */
export function movePermutation(
  from: number,
  to: number,
  count: number
): number[] {
  const perm = Array.from({ length: count }, (_, i) => i);
  if (
    from < 0 || to < 0 || from >= count || to >= count || from === to
  ) {
    return perm;
  }
  if (from < to) {
    for (let i = from + 1; i <= to; i += 1) perm[i] = i - 1;
  } else {
    for (let i = to; i < from; i += 1) perm[i] = i + 1;
  }
  perm[from] = to;
  return perm;
}

/** Move one workspace page (drag / Move left / Move right). */
export function movePageViews(
  views: PageView[],
  from: number,
  to: number
): PageView[] {
  const count = views.length;
  if (from < 0 || to < 0 || from >= count || to >= count) return views;
  const next = [...views];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Delete one workspace page (guarded — never the last page). Returns the
 * same array reference when the delete is out of bounds or would empty
 * the workspace.
 */
export function deletePageViews(views: PageView[], pos: number): PageView[] {
  if (pos < 0 || pos >= views.length || views.length <= 1) return views;
  const next = [...views];
  next.splice(pos, 1);
  return next;
}

/**
 * Duplicate one workspace page — the new slot (at pos + 1) shows the SAME
 * source page. User objects are NOT cloned (the honest organize rule: the
 * copy duplicates the page content, not the annotations on it).
 */
export function duplicatePageViews(views: PageView[], pos: number): PageView[] {
  if (pos < 0 || pos >= views.length) return views;
  const view = views[pos];
  if (view === undefined) return views;
  const next = [...views];
  next.splice(pos + 1, 0, { ...view });
  return next;
}

/**
 * Remaps object `page` fields after a delete (drop objects on the deleted
 * page, shift the ones above it down) or a duplicate (shift the ones above
 * the insertion point up).
 */
export function remapObjectsForPageOp(
  objects: EditorObject[],
  pos: number,
  kind: "delete" | "duplicate"
): EditorObject[] {
  if (pos < 0) return objects;
  if (kind === "delete") {
    return objects
      .filter((o) => o.page !== pos)
      .map((o) => (o.page > pos ? { ...o, page: o.page - 1 } : o));
  }
  return objects.map((o) => (o.page > pos ? { ...o, page: o.page + 1 } : o));
}

/** Remaps object `page` fields through a full permutation (drag move). */
export function remapObjectsByPermutation(
  objects: EditorObject[],
  perm: number[]
): EditorObject[] {
  return objects.map((o) => {
    const next = perm[o.page];
    return next === undefined || next === o.page ? o : { ...o, page: next };
  });
}

/** Every workspace position currently showing source page `src`. */
export function workspacePositionsForSrc(
  views: PageView[],
  src: number
): number[] {
  const out: number[] = [];
  for (let i = 0; i < views.length; i += 1) {
    if ((views[i]?.src ?? i) === src) out.push(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Constants + clamps
// ---------------------------------------------------------------------------

/** Text inset inside the box (pt) — the textarea padding mirrors this. */
export const TEXT_PAD = 3;
/** CSS line-height multiple — the surface CSS and the worker agree on it. */
export const LINE_HEIGHT = 1.32;
/** Anything under this (pt) never becomes an object from a drag. */
export const MIN_OBJ_PT = 6;
/** Freehand strokes under this many samples are discarded. */
export const MIN_DRAW_POINTS = 3;

export const FONT_OPTIONS: { id: EditorFontId; css: string }[] = [
  { id: "helvetica", css: "Arial, Helvetica, sans-serif" },
  { id: "times", css: "'Times New Roman', Times, serif" },
  { id: "courier", css: "'Courier New', Courier, monospace" },
  {
    id: "devanagari",
    css: "'Noto Sans Devanagari', Arial, sans-serif",
  },
];

export function clampN(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

export function roundPt(n: number): number {
  return Math.round(n * 10) / 10;
}

/** #rgb / #rrggbb → pdf-lib rgb() components. White for garbage. */
export function hexToRgb(hex: string): {
  r: number;
  g: number;
  b: number;
} {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return { r: 1, g: 1, b: 1 };
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const num = Number.parseInt(h, 16);
  return {
    r: ((num >> 16) & 255) / 255,
    g: ((num >> 8) & 255) / 255,
    b: (num & 255) / 255,
  };
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

let objSeq = 0;
/** Fresh object id (timestamp+seq — unique across the session). */
export function nextObjId(prefix = "o"): string {
  objSeq += 1;
  return `${prefix}${Date.now().toString(36)}${objSeq.toString(36)}`;
}

export const DEFAULT_TEXT_COLOR = "#111827";
export const DEFAULT_STROKE_COLOR = "#dc2626";
export const DEFAULT_WHITEOUT_COLOR = "#ffffff";

export function makeText(
  page: number,
  rect: ObjRect,
  overrides: Partial<TextObj> = {}
): TextObj {
  return {
    id: nextObjId("t"),
    page,
    x: roundPt(rect.x),
    y: roundPt(rect.y),
    w: roundPt(rect.w),
    h: roundPt(rect.h),
    opacity: 1,
    locked: false,
    hidden: false,
    rotation: 0,
    kind: "text",
    text: "",
    font: "helvetica",
    size: 12,
    color: DEFAULT_TEXT_COLOR,
    bold: false,
    italic: false,
    underline: false,
    align: "left",
    bg: null,
    ...overrides,
  };
}

export function makeImage(
  page: number,
  rect: ObjRect,
  assetKey: string
): ImageObj {
  return {
    id: nextObjId("i"),
    page,
    x: roundPt(rect.x),
    y: roundPt(rect.y),
    w: roundPt(rect.w),
    h: roundPt(rect.h),
    opacity: 1,
    locked: false,
    hidden: false,
    rotation: 0,
    kind: "image",
    assetKey,
  };
}

export function makeShape(
  page: number,
  rect: ObjRect,
  kind: "rect" | "ellipse" | "line" | "arrow"
): ShapeObj {
  return {
    id: nextObjId("s"),
    page,
    x: roundPt(rect.x),
    y: roundPt(rect.y),
    w: roundPt(rect.w),
    h: roundPt(rect.h),
    opacity: 1,
    locked: false,
    hidden: false,
    rotation: 0,
    kind,
    fill: null,
    stroke: DEFAULT_STROKE_COLOR,
    strokeW: 2,
    dash: false,
    flip: false,
  };
}

export function makeDraw(
  page: number,
  rect: ObjRect,
  pts: number[][]
): DrawObj {
  return {
    id: nextObjId("d"),
    page,
    x: roundPt(rect.x),
    y: roundPt(rect.y),
    w: roundPt(rect.w),
    h: roundPt(rect.h),
    opacity: 1,
    locked: false,
    hidden: false,
    rotation: 0,
    kind: "draw",
    pts,
    stroke: DEFAULT_STROKE_COLOR,
    strokeW: 2.5,
  };
}

export function makeWhiteout(page: number, rect: ObjRect): WhiteoutObj {
  return {
    id: nextObjId("w"),
    page,
    x: roundPt(rect.x),
    y: roundPt(rect.y),
    w: roundPt(rect.w),
    h: roundPt(rect.h),
    opacity: 1,
    locked: false,
    hidden: false,
    rotation: 0,
    kind: "whiteout",
    fill: DEFAULT_WHITEOUT_COLOR,
  };
}

/** Checkbox default-value sentinel (checked ⇔ value === "on"). */
export const FIELD_CHECKED = "on";

/** Suggests a unique field name: "Field", "Field 2", … against the
 * names (and radio group names) already on the page/document. */
export function suggestFieldName(taken: ReadonlySet<string>): string {
  const base = "Field";
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/** Collects every field name currently in use (radio groups included). */
export function takenFieldNames(objects: EditorObject[]): Set<string> {
  const taken = new Set<string>();
  for (const obj of objects) {
    if (obj.kind === "field" && obj.name.trim().length > 0) {
      taken.add(obj.name.trim());
    }
  }
  return taken;
}

/** Default display sizes for click-created fields (pt). */
export const FIELD_DEFAULT_W = 160;
export const FIELD_DEFAULT_H = 20;
export const CHECKBOX_DEFAULT = 14;

export function makeField(
  page: number,
  rect: ObjRect,
  taken: ReadonlySet<string>,
  overrides: Partial<FieldObj> = {}
): FieldObj {
  const fieldType = overrides.fieldType ?? "text";
  // Checkbox/radio widgets want squares — normalise the rect.
  let w = rect.w;
  let h = rect.h;
  if (fieldType === "checkbox" || fieldType === "radio") {
    const size = Math.max(
      MIN_OBJ_PT,
      Math.min(Math.abs(rect.w), Math.abs(rect.h)) || CHECKBOX_DEFAULT
    );
    w = size;
    h = size;
  }
  return {
    id: nextObjId("f"),
    page,
    x: roundPt(rect.x),
    y: roundPt(rect.y),
    w: roundPt(w),
    h: roundPt(h),
    opacity: 1,
    locked: false,
    hidden: false,
    rotation: 0,
    kind: "field",
    fieldType,
    name: suggestFieldName(taken),
    value: "",
    required: false,
    options: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Freehand helpers
// ---------------------------------------------------------------------------

/**
 * Converts raw display-space sample points (pt) into a bbox + fractional
 * point list. Points outside the page are NOT clamped (the caller clamps
 * the gesture to the overlay).
 */
export function normaliseDraw(
  pts: { x: number; y: number }[]
): { rect: ObjRect; fracs: number[][] } | null {
  if (pts.length < MIN_DRAW_POINTS) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  // Degenerate (a dot / a straight horizontal or vertical line) — keep a
  // minimal bbox so the stroke still renders with its width.
  const bw = Math.max(w, 2);
  const bh = Math.max(h, 2);
  const fracs = pts.map((p) => [
    Number(((p.x - minX) / bw).toFixed(4)),
    Number(((p.y - minY) / bh).toFixed(4)),
  ]);
  return {
    rect: { x: minX, y: minY, w: bw, h: bh },
    fracs,
  };
}

/** Display-space endpoints of a line/arrow object (flip-aware). */
export function lineEndpoints(
  disp: ObjRect,
  flip: boolean
): { x1: number; y1: number; x2: number; y2: number } {
  return flip
    ? { x1: disp.x, y1: disp.y + disp.h, x2: disp.x + disp.w, y2: disp.y }
    : { x1: disp.x, y1: disp.y, x2: disp.x + disp.w, y2: disp.y + disp.h };
}

// ---------------------------------------------------------------------------
// Rotation (P8.6) — pure math for the handle + the export compensation
// ---------------------------------------------------------------------------

/** Normalizes any angle into (-180, 180], 0.1° granularity; garbage → 0. */
export function normalizeRotation(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return Math.round(d * 10) / 10;
}

/** Kinds whose objects can rotate (pdf-lib drawEllipse has no rotate;
 * AcroForm widgets and freehand strokes stay upright — honest disables). */
export const ROTATABLE_KINDS: ReadonlySet<string> = new Set([
  "text",
  "image",
  "rect",
  "whiteout",
  "line",
  "arrow",
]);

export function isRotatable(obj: EditorObject): boolean {
  return ROTATABLE_KINDS.has(obj.kind);
}

/**
 * USER-SPACE anchor that makes pdf-lib's rotate-around-(x,y) semantics
 * rotate a w×h rect around its CENTER instead: pdf-lib draws the rect from
 * the anchor then rotates around it, so the anchor must sit at
 * C − R(deg)·(w/2, h/2). At 0° this is exactly the rect origin.
 */
export function rotationAnchor(
  rect: ObjRect,
  deg: number
): { x: number; y: number } {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return {
    x: cx - (cos * rect.w - sin * rect.h) / 2,
    y: cy - (sin * rect.w + cos * rect.h) / 2,
  };
}

/**
 * Rotates a DISPLAY point around a display center by `deg` VISUAL
 * counterclockwise (display space is y-down, so the matrix is the standard
 * math rotation with the angle negated). Used for text anchors and
 * line/arrow endpoints on every /Rotate page.
 */
export function rotateDisplayPoint(
  p: { x: number; y: number },
  c: { x: number; y: number },
  deg: number
): { x: number; y: number } {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + cos * dx + sin * dy, y: c.y - sin * dx + cos * dy };
}

/** Angle (deg, visual CCW) of a display point around a display center. */
export function displayAngle(
  p: { x: number; y: number },
  c: { x: number; y: number }
): number {
  return (Math.atan2(-(p.y - c.y), p.x - c.x) * 180) / Math.PI;
}

/** Point-in-rect that accounts for the object's visual rotation. */
export function hitRectRotated(
  disp: ObjRect,
  rotation: number,
  px: number,
  py: number
): boolean {
  if (rotation % 360 === 0) {
    return hitRect(disp, px, py);
  }
  const c = { x: disp.x + disp.w / 2, y: disp.y + disp.h / 2 };
  // Inverse of the visual-CCW rotation maps the point into object space.
  const local = rotateDisplayPoint({ x: px, y: py }, c, -rotation);
  return (
    local.x >= disp.x &&
    local.x <= disp.x + disp.w &&
    local.y >= disp.y &&
    local.y <= disp.y + disp.h
  );
}

// ---------------------------------------------------------------------------
// Hit-testing + z-order (display-space, axis-aligned)
// ---------------------------------------------------------------------------

export type HitEdge = "nw" | "ne" | "sw" | "se";

export function hitRect(disp: ObjRect, px: number, py: number): boolean {
  return (
    px >= disp.x &&
    px <= disp.x + disp.w &&
    py >= disp.y &&
    py <= disp.y + disp.h
  );
}

/** Corner handle the point is over (within `tol` pt), if any. */
export function hitHandle(
  disp: ObjRect,
  px: number,
  py: number,
  tol: number
): HitEdge | null {
  const corners: { edge: HitEdge; cx: number; cy: number }[] = [
    { edge: "nw", cx: disp.x, cy: disp.y },
    { edge: "ne", cx: disp.x + disp.w, cy: disp.y },
    { edge: "sw", cx: disp.x, cy: disp.y + disp.h },
    { edge: "se", cx: disp.x + disp.w, cy: disp.y + disp.h },
  ];
  for (const c of corners) {
    if (Math.abs(px - c.cx) <= tol && Math.abs(py - c.cy) <= tol) return c.edge;
  }
  return null;
}

/** Topmost (last in array) object at the display point. */
export function pickObject(
  objects: EditorObject[],
  view: PageView,
  px: number,
  py: number
): EditorObject | null {
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const obj = objects[i];
    if (obj.hidden) continue;
    if (!hitRectRotated(pdfRectToDisplay(obj, view), obj.rotation, px, py)) continue;
    return obj;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Snap guides (P8.6) — pure candidate/threshold math for move gestures
// ---------------------------------------------------------------------------

/** A guide line to draw on the page (display pt, page-relative). */
export interface SnapGuide {
  axis: "x" | "y";
  pos: number;
}

export interface SnapResult {
  /** Correction to add to the proposed position (display pt). */
  dx: number;
  dy: number;
  /** The guide lines the snap engaged (targets that were hit). */
  guides: SnapGuide[];
}

/**
 * Snaps a moving rect's edges/centers to the page edges/center and the
 * other objects' edges/centers (threshold in display pt). Pure: given the
 * PROPOSED rect, return the correction + the engaged guide lines.
 */
export function computeSnap(
  proposed: ObjRect,
  page: { w: number; h: number },
  others: ObjRect[],
  threshold: number
): SnapResult {
  const targetXs: number[] = [0, page.w / 2, page.w];
  const targetYs: number[] = [0, page.h / 2, page.h];
  for (const o of others) {
    targetXs.push(o.x, o.x + o.w / 2, o.x + o.w);
    targetYs.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  const bestFor = (
    moving: number[],
    targets: number[],
    axis: "x" | "y"
  ): { d: number; guide: SnapGuide | null } => {
    let bestD = 0;
    let bestGuide: SnapGuide | null = null;
    for (const m of moving) {
      for (const t of targets) {
        const d = t - m;
        if (Math.abs(d) <= threshold && (bestGuide === null || Math.abs(d) < Math.abs(bestD))) {
          bestD = d;
          bestGuide = { axis, pos: t };
        }
      }
    }
    return { d: bestGuide === null ? 0 : bestD, guide: bestGuide };
  };
  const x = bestFor(
    [proposed.x, proposed.x + proposed.w / 2, proposed.x + proposed.w],
    targetXs,
    "x"
  );
  const y = bestFor(
    [proposed.y, proposed.y + proposed.h / 2, proposed.y + proposed.h],
    targetYs,
    "y"
  );
  const guides: SnapGuide[] = [];
  if (x.guide) guides.push(x.guide);
  if (y.guide) guides.push(y.guide);
  return { dx: x.d, dy: y.d, guides };
}

// ---------------------------------------------------------------------------
// Multi-select (P8.6) — marquee + group z-order/duplicate
// ---------------------------------------------------------------------------

/** True when two display rects overlap (marquee intersection test). */
export function rectsIntersect(a: ObjRect, b: ObjRect): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

/** Ids of visible objects on `page` intersecting the marquee rect. */
export function marqueeSelection(
  objects: EditorObject[],
  view: PageView,
  page: number,
  rect: ObjRect
): string[] {
  const ids: string[] = [];
  for (const obj of objects) {
    if (obj.hidden || obj.page !== page) continue;
    if (rectsIntersect(rect, pdfRectToDisplay(obj, view))) ids.push(obj.id);
  }
  return ids;
}

/** Union bbox of the given display rects (empty → null). */
export function unionRects(rects: ObjRect[]): ObjRect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Resize a rect from one corner, keeping w/h ≥ min. Returns display rect. */
export function resizeRect(
  orig: ObjRect,
  edge: HitEdge,
  x2: number,
  y2: number,
  min: number,
  keepAspect: boolean,
  aspect: number
): ObjRect {
  let { x, y, w, h } = orig;
  if (edge === "se") {
    w = Math.max(min, x2 - x);
    h = Math.max(min, y2 - y);
    if (keepAspect) {
      w = Math.max(min, Math.min(w, h * aspect));
      h = w / aspect;
    }
  } else if (edge === "ne") {
    const ny = Math.min(y + h - min, y2);
    w = Math.max(min, x2 - x);
    h = Math.max(min, y + h - ny);
    y = ny;
    if (keepAspect) {
      w = Math.max(min, Math.min(w, h * aspect));
      h = w / aspect;
      y = orig.y + orig.h - h;
    }
  } else if (edge === "sw") {
    const nx = Math.min(x + w - min, x2);
    w = Math.max(min, x + w - nx);
    x = nx;
    h = Math.max(min, y2 - y);
    if (keepAspect) {
      h = Math.max(min, Math.min(h, w / aspect));
      w = h * aspect;
      x = orig.x + orig.w - w;
    }
  } else {
    const nx = Math.min(x + w - min, x2);
    const ny = Math.min(y + h - min, y2);
    w = Math.max(min, x + w - nx);
    h = Math.max(min, y + h - ny);
    x = nx;
    y = ny;
    if (keepAspect) {
      w = Math.max(min, Math.min(w, h * aspect));
      h = w / aspect;
      x = orig.x + orig.w - w;
      y = orig.y + orig.h - h;
    }
  }
  return { x, y, w, h };
}

// ---------------------------------------------------------------------------
// Z-order operations (array order == z order, last = front)
// ---------------------------------------------------------------------------

export function bringToFront(
  objects: EditorObject[],
  id: string
): EditorObject[] {
  const obj = objects.find((o) => o.id === id);
  if (!obj) return objects;
  return [...objects.filter((o) => o.id !== id), obj];
}

export function sendToBack(
  objects: EditorObject[],
  id: string
): EditorObject[] {
  const obj = objects.find((o) => o.id === id);
  if (!obj) return objects;
  return [obj, ...objects.filter((o) => o.id !== id)];
}

export function raiseOne(objects: EditorObject[], id: string): EditorObject[] {
  const idx = objects.findIndex((o) => o.id === id);
  if (idx < 0 || idx === objects.length - 1) return objects;
  const next = [...objects];
  const tmp = next[idx];
  next[idx] = next[idx + 1];
  next[idx + 1] = tmp;
  return next;
}

export function lowerOne(objects: EditorObject[], id: string): EditorObject[] {
  const idx = objects.findIndex((o) => o.id === id);
  if (idx <= 0) return objects;
  const next = [...objects];
  const tmp = next[idx];
  next[idx] = next[idx - 1];
  next[idx - 1] = tmp;
  return next;
}

export function duplicateObject(
  objects: EditorObject[],
  id: string
): { objects: EditorObject[]; copy: EditorObject | null } {
  const idx = objects.findIndex((o) => o.id === id);
  if (idx < 0) return { objects, copy: null };
  const src = objects[idx];
  const copy: EditorObject = {
    ...src,
    id: nextObjId("c"),
    x: roundPt(src.x + 12),
    y: roundPt(Math.max(0, src.y - 12)),
  };
  // Duplicated fields need their own name — same-name fields share one
  // AcroForm value in every reader (radio groups excepted, where the
  // caller duplicates on purpose).
  if (copy.kind === "field" && copy.fieldType !== "radio") {
    copy.name = suggestFieldName(takenFieldNames(objects));
  }
  const next = [...objects];
  next.splice(idx + 1, 0, copy);
  return { objects: next, copy };
}

/** Brings every id in `ids` to the FRONT, preserving their relative order. */
export function bringManyToFront(
  objects: EditorObject[],
  ids: ReadonlySet<string>
): EditorObject[] {
  const moving = objects.filter((o) => ids.has(o.id));
  if (moving.length === 0) return objects;
  return [...objects.filter((o) => !ids.has(o.id)), ...moving];
}

/** Sends every id in `ids` to the BACK, preserving their relative order. */
export function sendManyToBack(
  objects: EditorObject[],
  ids: ReadonlySet<string>
): EditorObject[] {
  const moving = objects.filter((o) => ids.has(o.id));
  if (moving.length === 0) return objects;
  return [...moving, ...objects.filter((o) => !ids.has(o.id))];
}

/** Duplicates every id in `ids` (copies land right after their sources,
 * in z order). Field copies rename like duplicateObject does. */
export function duplicateObjects(
  objects: EditorObject[],
  ids: readonly string[]
): { objects: EditorObject[]; copies: EditorObject[] } {
  let next = [...objects];
  const copies: EditorObject[] = [];
  for (const id of ids) {
    const result = duplicateObject(next, id);
    next = result.objects;
    if (result.copy) copies.push(result.copy);
  }
  return { objects: next, copies };
}

// ---------------------------------------------------------------------------
// History (snapshot stack — simple, unlimited, JSON)
// ---------------------------------------------------------------------------

export const HISTORY_LIMIT = 120;

export function pushSnapshot(
  past: string[],
  snapshot: string,
  future: string[]
): { past: string[]; future: string[] } {
  const nextPast = [...past, snapshot];
  if (nextPast.length > HISTORY_LIMIT) nextPast.shift();
  return { past: nextPast, future: [] };
}

/** Undo: pops past into future, returns the restored snapshot. */
export function undoStep(
  past: string[],
  future: string[],
  current: string
): { past: string[]; future: string[]; snapshot: string | null } {
  if (past.length === 0) return { past, future, snapshot: null };
  const nextPast = [...past];
  const snapshot = nextPast.pop() as string;
  return { past: nextPast, future: [current, ...future], snapshot };
}

/** Redo: pops future into past, returns the restored snapshot. */
export function redoStep(
  past: string[],
  future: string[],
  current: string
): { past: string[]; future: string[]; snapshot: string | null } {
  if (future.length === 0) return { past, future, snapshot: null };
  const [snapshot, ...rest] = future;
  return { past: [...past, current], future: rest, snapshot };
}

// ---------------------------------------------------------------------------
// Wire-format sanitising (worker side — never trust the blob)
// ---------------------------------------------------------------------------

function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

function str(v: unknown, dflt: string): string {
  return typeof v === "string" ? v : dflt;
}

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}

function color(v: unknown, dflt: string): string {
  return typeof v === "string" && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v)
    ? v
    : dflt;
}

function optColor(v: unknown): string | null {
  if (v === null) return null;
  return color(v, "#000000");
}

const FONTS: EditorFontId[] = ["helvetica", "times", "courier", "devanagari"];
const KINDS: ObjKind[] = [
  "text",
  "image",
  "rect",
  "ellipse",
  "line",
  "arrow",
  "draw",
  "whiteout",
  "field",
];

const FIELD_TYPES: FieldType[] = [
  "text",
  "multiline",
  "checkbox",
  "dropdown",
  "radio",
];

/** Parses + clamps one raw object from the wire blob. null = drop it. */
export function sanitizeObject(
  raw: unknown,
  pageCount: number,
  knownAssets: ReadonlySet<string>
): EditorObject | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const kind = KINDS.includes(o.kind as ObjKind) ? (o.kind as ObjKind) : null;
  if (kind === null) return null;
  // R12: an object whose page fell outside the document is DROPPED, not
  // clamped — content must never land on a page the user didn't put it on
  // (deletes/tampered blobs); the surface's remaps keep real objects
  // in-range, so only genuinely stale/hostile objects reach this guard.
  const pageRaw = Math.trunc(num(o.page, 0));
  if (pageRaw < 0 || pageRaw >= Math.max(1, pageCount)) return null;
  const page = pageRaw;
  const base = {
    id: str(o.id, nextObjId("x")),
    page,
    x: num(o.x, 72),
    y: num(o.y, 72),
    w: Math.max(MIN_OBJ_PT, num(o.w, 120)),
    h: Math.max(MIN_OBJ_PT, num(o.h, 24)),
    opacity: clampN(num(o.opacity, 1), 0.05, 1),
    locked: bool(o.locked, false),
    hidden: bool(o.hidden, false),
    rotation: normalizeRotation(num(o.rotation, 0)),
  };
  switch (kind) {
    case "text":
      return {
        ...base,
        kind,
        text: str(o.text, ""),
        font: FONTS.includes(o.font as EditorFontId)
          ? (o.font as EditorFontId)
          : "helvetica",
        size: clampN(num(o.size, 12), 4, 200),
        color: color(o.color, "#111827"),
        bold: bool(o.bold, false),
        italic: bool(o.italic, false),
        underline: bool(o.underline, false),
        align: o.align === "center" || o.align === "right" ? o.align : "left",
        bg: optColor(o.bg),
      };
    case "image": {
      const key = str(o.assetKey, "");
      if (!knownAssets.has(key)) return null;
      return { ...base, kind, assetKey: key };
    }
    case "rect":
    case "ellipse":
    case "line":
    case "arrow":
      return {
        ...base,
        kind,
        fill: optColor(o.fill),
        stroke: optColor(o.stroke),
        strokeW: clampN(num(o.strokeW, 2), 0.25, 40),
        dash: bool(o.dash, false),
        flip: bool(o.flip, false),
      };
    case "draw": {
      const rawPts = Array.isArray(o.pts) ? o.pts : [];
      const pts = rawPts
        .filter(
          (p): p is number[] =>
            Array.isArray(p) &&
            p.length === 2 &&
            typeof p[0] === "number" &&
            typeof p[1] === "number"
        )
        .map((p) => [clampN(p[0], 0, 1), clampN(p[1], 0, 1)]);
      if (pts.length < 2) return null;
      return {
        ...base,
        kind,
        pts,
        stroke: color(o.stroke, "#dc2626"),
        strokeW: clampN(num(o.strokeW, 2.5), 0.25, 40),
      };
    }
    case "whiteout":
      return { ...base, kind, fill: color(o.fill, "#ffffff") };
    case "field": {
      const fieldType = FIELD_TYPES.includes(o.fieldType as FieldType)
        ? (o.fieldType as FieldType)
        : "text";
      const rawOptions = Array.isArray(o.options) ? o.options : [];
      const options = [
        ...new Set(
          rawOptions
            .filter((v): v is string => typeof v === "string")
            .map((v) => v.trim().slice(0, 80))
            .filter((v) => v.length > 0)
        ),
      ].slice(0, 50);
      const value = str(o.value, "").slice(0, 200);
      const name =
        str(o.name, "").replace(/\s+/g, " ").trim().slice(0, 60) ||
        "Field";
      let h = base.h;
      if (fieldType === "checkbox" || fieldType === "radio") {
        // Square widgets (the worker squares them at export too — this
        // keeps the editor preview honest about the final shape).
        const size = Math.max(MIN_OBJ_PT, Math.min(base.w, base.h));
        base.w = size;
        h = size;
      }
      return {
        ...base,
        w: base.w,
        h,
        kind,
        fieldType,
        name,
        value: fieldType === "dropdown" && !options.includes(value) ? "" : value,
        required: bool(o.required, false),
        options: fieldType === "dropdown" ? options : [],
      };
    }
  }
}

/** Parses the full objects array from the wire blob. */
export function sanitizeObjects(
  raw: unknown,
  pageCount: number,
  knownAssets: ReadonlySet<string>
): EditorObject[] {
  if (!Array.isArray(raw)) return [];
  const out: EditorObject[] = [];
  for (const item of raw) {
    const obj = sanitizeObject(item, pageCount, knownAssets);
    if (obj !== null && !obj.hidden) out.push(obj);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Existing-text editing (P8.3 — whiteout + replace, font matching)
// ---------------------------------------------------------------------------

/**
 * A harvested text piece in DISPLAY space (y down, pt) — one horizontal
 * pdf.js text run with its resolved font match attached.
 */
export interface HarvestPiece {
  index: number;
  x: number;
  xEnd: number;
  baseline: number;
  h: number;
  /** R13: the piece's padded band in PDF USER space (y from bottom) —
   *  captured at harvest through the page's own viewport, so it is
   *  rotation-proof: every consumer maps it through the CURRENT view and
   *  a user-rotated slot can never desync covers/retype boxes from their
   *  text. The display fields above stay source-rotation display space
   *  (line grouping reads them). */
  user: ObjRect;
  str: string;
  font: FontMatch;
}

/** How an original PDF font maps onto the editor's embedded fonts. */
export interface FontMatch {
  font: EditorFontId;
  bold: boolean;
  italic: boolean;
  /** true when the original font IS one of our embedded fonts (metrics-safe). */
  exact: boolean;
  /** Human-readable original name ("" when pdf.js exposed none). */
  original: string;
}

/** Fonts whose glyphs we embed — exact replacement is possible for these. */
const EXACT_NAMES = new Set([
  "helvetica",
  "helveticabold",
  "helveticaoblique",
  "helveticaboldoblique",
  "times",
  "timesroman",
  "timesbold",
  "timesitalic",
  "timesbolditalic",
  "courier",
  "courierbold",
  "courieroblique",
  "courierboldoblique",
  "notosansdevanagari",
]);

/** Name → editor family table (subset prefixes already stripped). */
const FAMILY_BY_NAME: Record<string, EditorFontId> = {
  // sans
  helvetica: "helvetica",
  helveticabold: "helvetica",
  helveticaoblique: "helvetica",
  helveticaboldoblique: "helvetica",
  arial: "helvetica",
  arialmt: "helvetica",
  arialboldmt: "helvetica",
  arialunicode: "helvetica",
  liberationsans: "helvetica",
  notosans: "helvetica",
  verdana: "helvetica",
  tahoma: "helvetica",
  segoeui: "helvetica",
  calibri: "helvetica",
  carlito: "helvetica",
  dejavusans: "helvetica",
  opensans: "helvetica",
  // serif
  times: "times",
  timesroman: "times",
  timesbold: "times",
  timesitalic: "times",
  timesbolditalic: "times",
  timesnewroman: "times",
  timesnewromanpsmt: "times",
  timesnewromanpsboldmt: "times",
  timesnewromanpsitalicmt: "times",
  liberationserif: "times",
  notoserif: "times",
  georgia: "times",
  garamond: "times",
  bookmanoldstyle: "times",
  cambria: "times",
  caladea: "times",
  dejavuserif: "times",
  // mono
  courier: "courier",
  courierbold: "courier",
  courieroblique: "courier",
  courierboldoblique: "courier",
  couriernew: "courier",
  couriernewpsmt: "courier",
  couriernewpsboldmt: "courier",
  liberationmono: "courier",
  notosansmono: "courier",
  notoserifmono: "courier",
  dejavusansmono: "courier",
  consolas: "courier",
  menlo: "courier",
  monaco: "courier",
  courierstd: "courier",
  // devanagari
  notosansdevanagari: "devanagari",
  mangal: "devanagari",
  kokila: "devanagari",
  devanagarimt: "devanagari",
  udyog: "devanagari",
};

export interface FontMatchHints {
  /** pdf.js font.bold / .black (font flags), when available. */
  bold?: boolean;
  /** pdf.js font.italic, when available. */
  italic?: boolean;
  /** pdf.js font.isMonospace, when available. */
  mono?: boolean;
  /** pdf.js font.isSerifFont, when available. */
  serif?: boolean;
  /** textContent.styles fontFamily: "serif" | "monospace" | "sans-serif". */
  cssFamily?: string;
  /** The run's text carries Devanagari characters. */
  hasDeva?: boolean;
}

function normaliseFontName(raw: string): string {
  // Strip a subset prefix ("ABCDEF+ArialMT") and punctuation, lowercase.
  const plus = raw.indexOf("+");
  const base = plus >= 0 ? raw.slice(plus + 1) : raw;
  return base.replace(/[\s_-]+/g, "").toLowerCase();
}

/**
 * Maps an original PDF font onto the editor's embedded fonts (PRD §8.2:
 * "font match — standard fonts, embedded font agar subset allow kare, warna
 * closest font suggest"). Exact only for the standard-14 families (and the
 * Devanagari font we embed verbatim); everything else maps to the closest
 * family by name table, class flags or CSS fallback family.
 */
export function matchFont(
  rawName: string,
  hints: FontMatchHints
): FontMatch {
  const norm = normaliseFontName(rawName);
  const bold =
    hints.bold === true ||
    (hints.bold !== false && /bold|black|heavy|semibold|demibold/i.test(rawName));
  const italic =
    hints.italic === true ||
    (hints.italic !== false && /italic|oblique/i.test(rawName));

  // Devanagari text needs the Devanagari pipeline regardless of the name.
  if (hints.hasDeva === true) {
    return {
      font: "devanagari",
      bold,
      italic,
      exact: norm === "notosansdevanagari",
      original: rawName,
    };
  }

  let font: EditorFontId | null = null;
  if (norm !== "" && FAMILY_BY_NAME[norm] !== undefined) {
    font = FAMILY_BY_NAME[norm];
  } else if (hints.mono === true || hints.cssFamily === "monospace") {
    font = "courier";
  } else if (hints.serif === true || hints.cssFamily === "serif") {
    font = "times";
  } else if (norm.includes("devanagari")) {
    font = "devanagari";
  } else if (
    norm.includes("mono") ||
    norm.includes("courier") ||
    norm.includes("consolas") ||
    norm.includes("menlo")
  ) {
    font = "courier";
  } else if (
    norm.includes("serif") ||
    norm.includes("roman") ||
    norm.includes("times") ||
    norm.includes("georgia") ||
    norm.includes("garamond")
  ) {
    font = "times";
  } else if (
    norm.includes("sans") ||
    norm.includes("helvetica") ||
    norm.includes("arial") ||
    norm.includes("verdana") ||
    norm.includes("tahoma") ||
    norm.includes("segoe")
  ) {
    font = "helvetica";
  } else if (font === null) {
    font = "helvetica";
  }

  return {
    font,
    bold,
    italic,
    exact: EXACT_NAMES.has(norm),
    original: rawName,
  };
}

/** Vertical metrics used to expand a piece into a comfortable cover rect. */
export const PIECE_ASCENT = 0.85;
export const PIECE_DESCENT = 0.25;
export const PIECE_PAD = 1.5;

/**
 * The DISPLAY rect a piece's cover/text objects occupy: the glyph band
 * (ascent above the baseline, descent below) plus a small pad, widened by
 * 1pt on each side so ascenders/descenders never peek out.
 */
export function pieceRect(piece: {
  x: number;
  xEnd: number;
  baseline: number;
  h: number;
}): ObjRect {
  const top = piece.baseline - PIECE_ASCENT * piece.h - PIECE_PAD;
  const bottom = piece.baseline + PIECE_DESCENT * piece.h + PIECE_PAD;
  return {
    x: piece.x - 1,
    y: top,
    w: Math.max(8, piece.xEnd - piece.x + 2),
    h: Math.max(10, bottom - top),
  };
}

/**
 * R13: the piece's padded band mapped into the CURRENT view's display
 * space (user-space pivot — correct for every /Rotate AND every user
 * rotation offset; overlay buttons and bitmap sampling read this).
 */
export function pieceDisplayRect(
  piece: Pick<HarvestPiece, "user">,
  view: PageView
): ObjRect {
  return pdfRectToDisplay(piece.user, view);
}

/**
 * Builds the whiteout + retype pair for one harvested piece (PRD §8.2
 * "original text area whiteout + naya text same position par"). Both
 * objects share the piece rect; the cover is inserted BEFORE the text so
 * array z-order draws it first. One history group per call is the caller's
 * responsibility. R13: the rect is the piece's USER-space band — the
 * placement is view-free (rotation-proof by construction).
 */
export function buildReplacePieceObjects(
  page: number,
  piece: HarvestPiece,
  bgHex: string,
  inkHex: string
): { cover: WhiteoutObj; text: TextObj } {
  const pdf = piece.user;
  const cover = makeWhiteout(page, pdf);
  cover.fill = bgHex;
  const text = makeText(page, pdf, {
    text: piece.str,
    font: piece.font.font,
    size: clampN(piece.h, 4, 200),
    color: inkHex,
    bold: piece.font.bold,
    italic: piece.font.italic,
    align: "left",
  });
  return { cover, text };
}

// ---------------------------------------------------------------------------
// Line grouping + find-and-replace planning (PRD §8.2 "Find & Replace")
// ---------------------------------------------------------------------------

/** A visual text line: adjacent same-baseline pieces merged with spaces. */
export interface PieceLine {
  page: number;
  /** Indices into the page's piece array (x order). */
  pieces: number[];
  text: string;
  x: number;
  xEnd: number;
  baseline: number;
  h: number;
  /** R13: union of the line's piece USER rects — the cover spans it on
   *  every /Rotate / user rotation without a display round-trip. */
  user: ObjRect;
}

/** Axis-aligned union of two user-space rects (1pt floor on each side). */
function unionRect(a: ObjRect, b: ObjRect): ObjRect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/**
 * Groups a page's pieces into visual lines: baseline bucket (Δ ≤ 0.45 ×
 * the larger em) + horizontal gap ≤ 1.2 × em joins as a space, pieces sorted
 * by x. The same-baseline rule keeps columns separate (P4.3 insight).
 */
export function groupPiecesIntoLines(
  page: number,
  pieces: HarvestPiece[]
): PieceLine[] {
  const sorted = [...pieces].sort((a, b) => a.x - b.x);
  const lines: PieceLine[] = [];
  for (const p of sorted) {
    const line = lines.find((l) => {
      if (Math.abs(l.baseline - p.baseline) > 0.45 * Math.max(l.h, p.h)) {
        return false;
      }
      // Gap between the line's right edge and this piece (x-sorted so ≥ 0).
      return p.x - l.xEnd <= 1.2 * Math.max(l.h, p.h);
    });
    if (line) {
      line.pieces.push(p.index);
      line.xEnd = Math.max(line.xEnd, p.xEnd);
      line.text = `${line.text} ${p.str}`;
      line.h = Math.max(line.h, p.h);
      line.user = unionRect(line.user, p.user);
    } else {
      lines.push({
        page,
        pieces: [p.index],
        text: p.str,
        x: p.x,
        xEnd: p.xEnd,
        baseline: p.baseline,
        h: p.h,
        user: p.user,
      });
    }
  }
  return lines;
}

export interface LineMatch {
  page: number;
  /** Index into that page's PieceLine array. */
  line: number;
  /** Character range of the occurrence inside line.text. */
  start: number;
  end: number;
}

/** Literal (non-regex) occurrences of the query across all lines. */
export function planLineReplacements(
  lines: PieceLine[],
  query: string,
  matchCase: boolean
): LineMatch[] {
  const out: LineMatch[] = [];
  const needle = matchCase ? query : query.toLowerCase();
  if (needle.length === 0) return out;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const hay = matchCase ? line.text : line.text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      out.push({ page: line.page, line: i, start: at, end: at + needle.length });
      from = at + needle.length;
    }
  }
  return out;
}

/**
 * Builds the whiteout + retype pair for one VISUAL LINE (find & replace):
 * the cover spans the union of the line's piece USER rects (R13 — no
 * display round-trip, so a user-rotated slot gets its cover exactly where
 * the line lives), the retype uses the dominant piece's font match and
 * the substituted text. One history group per call is the caller's
 * responsibility.
 */
export function buildReplaceLineObjects(
  page: number,
  line: PieceLine,
  pagePieces: HarvestPiece[],
  newText: string,
  bgHex: string,
  inkHex: string
): { cover: WhiteoutObj; text: TextObj } {
  const pdf = line.user;
  const cover = makeWhiteout(page, pdf);
  cover.fill = bgHex;
  // Dominant piece = largest em (ties: first in x order).
  let dom = pagePieces[line.pieces[0]] ?? null;
  for (const idx of line.pieces) {
    const p = pagePieces[idx];
    if (p && dom !== null && p.h > dom.h) dom = p;
    else if (p && dom === null) dom = p;
  }
  const text = makeText(page, pdf, {
    text: newText,
    font: dom !== null ? dom.font.font : "helvetica",
    size: clampN(dom !== null ? dom.h : 12, 4, 200),
    color: inkHex,
    bold: dom !== null ? dom.font.bold : false,
    italic: dom !== null ? dom.font.italic : false,
    align: "left",
  });
  return { cover, text };
}

/**
 * Line text with the given occurrence ranges substituted (literal
 * semantics — split/join so regex metacharacters in the query are safe).
 */
export function substituteOccurrences(
  text: string,
  ranges: { start: number; end: number }[],
  replacement: string
): string {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const r of sorted) {
    if (r.start < cursor) continue; // overlap guard
    out += text.slice(cursor, r.start) + replacement;
    cursor = r.end;
  }
  return out + text.slice(cursor);
}

// ---------------------------------------------------------------------------
// Ink/background colour picking from rendered pixels (P8.3)
// ---------------------------------------------------------------------------

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number): string =>
    Math.round(clampN(v, 0, 255)).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Median of an RGBA pixel run (ignores alpha — pages render opaque). */
export function medianRgb(pixels: number[]): { r: number; g: number; b: number } {
  if (pixels.length === 0) return { r: 255, g: 255, b: 255 };
  const by = (ch: 0 | 1 | 2): number => {
    const vals = pixels.filter((_, i) => i % 4 === ch).sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)] ?? 255;
  };
  return { r: by(0), g: by(1), b: by(2) };
}

/**
 * Picks the text ink colour from the pixels under a piece: the darkest
 * cluster on a light background, the brightest on a dark one. Returns null
 * when the contrast is too weak to trust (caller falls back to a default).
 */
export function pickInkFromPixels(
  pixels: number[],
  bgLum: number
): { r: number; g: number; b: number } | null {
  if (pixels.length < 16) return null;
  const lums = pixels
    .filter((_, i) => i % 4 === 3 && pixels[i] > 40)
    .length;
  if (lums < 4) return null;
  const entries: { lum: number; r: number; g: number; b: number }[] = [];
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const { r, g, b } = { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] };
    entries.push({ lum: luminance(r, g, b), r, g, b });
  }
  entries.sort((a, b) => a.lum - b.lum);
  const dark = entries[Math.floor(entries.length * 0.12)];
  const bright = entries[Math.floor(entries.length * 0.88)];
  const pick = bgLum > 0.5 ? dark : bright;
  const contrast = Math.abs(pick.lum - bgLum);
  if (contrast < 0.16) return null;
  return { r: pick.r, g: pick.g, b: pick.b };
}

/** Greedy word-wrap that hard-breaks overlong words (surface CSS + worker). */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (s: string) => number
): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    if (para.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of para.split(/ +/)) {
      const candidate = current.length === 0 ? word : `${current} ${word}`;
      if (measure(candidate) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current.length > 0) {
        lines.push(current);
        current = "";
      }
      if (measure(word) <= maxWidth) {
        current = word;
      } else {
        // Hard-break the overlong word by characters (a single character
        // wider than maxWidth is still emitted — best effort).
        let chunk = "";
        for (const ch of word) {
          if (measure(chunk + ch) > maxWidth && chunk.length > 0) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        current = chunk;
      }
    }
    lines.push(current);
  }
  return lines;
}
