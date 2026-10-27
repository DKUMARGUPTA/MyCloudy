/**
 * Passport photo maker (PRD "Passport photo" — the images-category tool for
 * India-first photo sizes) — shared types.
 *
 * Everything in this folder is device-only (mode D): the photo arrives by
 * structured clone, every pixel is computed on an OffscreenCanvas inside the
 * Web Worker, and JPEG/PNG/PDF blobs go straight back. No face detection,
 * no AI — the user positions the head against honest overlay guides.
 */

/* ------------------------------ presets ------------------------------ */

/**
 * A country/doctype photo spec. Sizes are a CONVENIENCE: the authority
 * the user is applying to always wins (the surface + FAQ say so, and
 * presets with shaky published numbers carry `verify: true` so the
 * picker shows the "verify with your authority" note).
 */
export interface PassportSpec {
  id: string;
  /** What the user picks (e.g. "Passport / visa"). */
  label: { en: string; hi: string };
  /** Country / authority grouping shown before the label. */
  country: { en: string; hi: string };
  /** Photo width in millimetres. */
  wMm: number;
  /** Photo height in millimetres. */
  hMm: number;
  /** Head height (chin → crown) range, millimetres. */
  headMinMm: number;
  headMaxMm: number;
  /** Guidance eye line: distance from the BOTTOM of the photo, millimetres. */
  eyeFromBottomMm: number;
  /** Honest background note (most authorities want plain white/light). */
  bgNote: { en: string; hi: string };
  /**
   * true when the published numbers vary or are hard to pin down — the
   * preset picker shows the verify-with-your-authority note.
   */
  verify: boolean;
}

/* ------------------------------- options ------------------------------ */

export type SheetKind = "none" | "4x6" | "a4";
/** What the print sheet is encoded as (the single photo has its own format). */
export type SheetFormat = "pdf" | "png";
export type PhotoFormat = "jpeg" | "png";
export type Rotation = 0 | 90 | 180 | 270;

/**
 * Per-image crop + tone settings (the surface's stepper edits one image
 * at a time; every uploaded photo keeps its own adjustments).
 */
export interface CropAdjust {
  /** 1 = largest centered crop that fits; up to 8. */
  zoom: number;
  /** -1 (left edge) … 1 (right edge) of the free travel. */
  panX: number;
  /** -1 (top edge) … 1 (bottom edge) of the free travel. */
  panY: number;
  /** Quarter turns clockwise. */
  rotation: Rotation;
  /** -60…60 (percentage points; multiplicative on the pixels). */
  brightness: number;
  /** -60…60 (percentage points; around mid-gray). */
  contrast: number;
}

/** Fully validated run recipe (what coerceOptions hands the worker). */
export interface RunOptions {
  preset: string;
  /** Aligned with the input file order (never shorter). */
  entries: CropAdjust[];
  bgCleanup: boolean;
  bgTolerance: number;
  sheet: SheetKind;
  sheetFormat: SheetFormat;
  format: PhotoFormat;
  dpi: number;
  locale: "en" | "hi";
}

/* ------------------------------ run detail ---------------------------- */

/**
 * Result summary the worker posts. The shared RunDetail only knows
 * files/pages, so: `files` = photos produced, `pages` = print sheets
 * produced (0 when the sheet is off).
 */
export interface PhotoRunDetail {
  files: number;
  pages: number;
}

/* ------------------------------ pixel plane --------------------------- */

/**
 * ImageData-shaped RGBA plane (width/height/data) — the pure pixel math
 * in model.ts and the worker's canvas readbacks speak this one shape, so
 * the smoke can drive everything without a DOM. The browser's real
 * ImageData satisfies it structurally.
 */
export interface RgbaPlane {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/* ------------------------------ error codes --------------------------- */

/**
 * Internal failure kinds (classifyError maps them onto i18n keys —
 * existing tool.images.* keys wherever the copy is already honest).
 */
export type PhotoErrorKind =
  | "errNotImage"
  | "errImageDecode"
  | "errTooLarge"
  | "errCanvas"
  | "errGeneric";
