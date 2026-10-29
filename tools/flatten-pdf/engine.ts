import {
  StampContext,
  applyAffine,
  axialAlignedBounds,
  composeAffine,
  composeAppearanceTransform,
  type Affine,
  type Quad,
} from "@/lib/own/pdf";

export { applyAffine, axialAlignedBounds, composeAffine, composeAppearanceTransform };
export type { Affine, Quad };
export { IDENTITY_AFFINE } from "@/lib/own/pdf";

/**
 * Flatten PDF engine (PRD §8.4, Optimize) — merges form fields AND
 * annotation appearances into the page content so nothing stays interactive.
 * P6-p: OUR engine end-to-end (pdf-lib no longer runs in the tool path; it
 * remains the dev-time oracle in the smoke).
 *
 * Two targets, in order:
 *  1. Forms: StampContext.flattenSourceForm() (pdf-lib PDFForm.flatten
 *     parity — the burn `q <translate> cm + rotateInPlace(0) + /Fx<n> Do Q`
 *     into the page content, the fields + widget annots removed, the catalog
 *     /AcroForm dropped entirely: nothing interactive remains).
 *  2. Annotations: each remaining annotation's /AP /N appearance XObject is
 *     registered in the page's /Resources /XObject and drawn with a `cm`
 *     that maps its (matrix-transformed) /BBox onto the annotation /Rect —
 *     the exact placement pdf.js uses (verified against pdfjs-dist 4.10
 *     core/annotation.js getTransformMatrix + canvas.js beginAnnotation:
 *     the placement matrix is computed from the axial-aligned bounds of the
 *     BBox corners transformed by the appearance /Matrix, and the /Matrix
 *     itself is applied again when the viewer executes `Do`, so both models
 *     compose identically). The burn operators are appended as a NEW front
 *     content stream (annotations paint above page content), and the page's
 *     /Annots entry is removed entirely — nothing interactive remains.
 *
 * This module is PURE (no canvas/browser APIs) so the same code path runs
 * inside the worker and under bun in scripts/smoke-flatten.ts.
 */

export interface FlattenReport {
  pages: number;
  /** AcroForm fields found before flattening (0 = no form). */
  fieldCount: number;
  /** Annotation appearance streams burned into page content. */
  annotationsBurned: number;
  /** Annotations skipped (no /AP /N, hidden/no-view, widgets, …). */
  annotationsSkipped: number;
  /** True when the run found NOTHING to flatten — the document is
   *  already flat (no fields, no burnable annotations). Normal usage,
   *  not an error: the worker passes the input through untouched and
   *  the result view shows an honest "nothing to flatten" chip. */
  nothingToDo: boolean;
}

/** The written document (valid when !report.nothingToDo). */
export interface FlattenResult {
  report: FlattenReport;
  bytes: Uint8Array;
}

/** Which targets the flatten run touches (tool "scope" option). */
export type FlattenScope =
  | "forms-and-annotations"
  | "forms-only"
  | "annotations-only";

export interface FlattenOptions {
  /** What to flatten (default: forms + annotations). */
  scope?: FlattenScope;
  /**
   * 0-based page indices for the ANNOTATION pass. Null (default) = every
   * page. The forms pass is always document-wide (the tool hint says so
   * honestly).
   */
  annotationPages?: number[] | null;
  /** Worker progress hook: fired after each processed annotation page. */
  onAnnotationPage?: (done: number, total: number) => void;
}

/** The form fields exist but could not be baked (kept honest: no output). */
export class FlattenFormsError extends Error {
  constructor() {
    super("flatten-forms-failed");
    this.name = "FlattenFormsError";
  }
}

/** Maps any worker failure to the i18n key the UI shows. */
export function classifyFlattenError(error: unknown): string {
  if (error instanceof FlattenFormsError) return "flatten.errorFormsFailed";
  const message = error instanceof Error ? error.message : String(error);
  return /encrypt/i.test(message) ? "tool.errorEncrypted" : "tool.errorCorrupt";
}

/**
 * Flattens the document (forms first, then annotation appearances — both
 * controllable via `options.scope`; `options.annotationPages` limits the
 * annotation pass to specific pages).
 *
 * A document with nothing to flatten is NOT an error — the report comes
 * back with `nothingToDo: true` (fieldCount / burned / skipped all zero)
 * and the caller passes the input through unchanged. FlattenFormsError is
 * thrown only when the form fields exist but could not be baked.
 *
 * `preloaded` (worker convenience): a ctx the caller already loaded for
 * page-count validation — same bytes, one parse.
 */
export function flattenDocument(
  bytes: Uint8Array,
  options: FlattenOptions = {},
  preloaded?: StampContext
): FlattenResult {
  const {
    scope = "forms-and-annotations",
    annotationPages = null,
    onAnnotationPage,
  } = options;
  const runForms = scope !== "annotations-only";
  const runAnnotations = scope !== "forms-only";

  const ctx = preloaded ?? StampContext.load(bytes); // typed refusal
  const report: FlattenReport = {
    pages: ctx.pageCount,
    fieldCount: 0,
    annotationsBurned: 0,
    annotationsSkipped: 0,
    nothingToDo: false,
  };

  if (runForms) {
    try {
      report.fieldCount = ctx.flattenSourceForm();
    } catch {
      // Values/appearances could not be baked (exotic or broken fields,
      // unresolvable appearance streams) — refuse instead of shipping
      // silently-still-editable form fields out of a "flatten" tool.
      throw new FlattenFormsError();
    }
  }

  if (runAnnotations) {
    // keepWidgets: the annotations-only scope keeps the form interactive,
    // so widget refs must survive in /Annots.
    const { burned, skipped } = ctx.burnSourceAnnotations({
      slots: annotationPages,
      keepWidgets: scope === "annotations-only",
      onSlot: onAnnotationPage,
    });
    report.annotationsBurned = burned;
    report.annotationsSkipped = skipped;
  }

  // Already flat — nothing to do. Normal usage, not an error: the
  // worker hands the ORIGINAL bytes back untouched (no re-save churn)
  // and the result view shows the "nothing to flatten" info chip.
  report.nothingToDo =
    report.fieldCount === 0 &&
    report.annotationsBurned === 0 &&
    report.annotationsSkipped === 0;

  if (report.nothingToDo) {
    return { report, bytes };
  }
  return { report, bytes: ctx.write() };
}
