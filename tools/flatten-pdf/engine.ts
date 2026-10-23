import {
  PDFArray,
  PDFContentStream,
  PDFContext,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  type PDFDocument,
  type PDFPage,
  type PDFOperator,
} from "pdf-lib";

/**
 * Flatten PDF engine (PRD §8.4, Optimize) — merges form fields AND
 * annotation appearances into the page content so nothing stays interactive.
 *
 * Two targets, in order:
 *  1. Forms: pdf-lib's PDFForm.flatten() (regenerates appearances from the
 *     current values, then burns the widget appearance streams and removes
 *     the fields + widget annots).
 *  2. Annotations: each remaining annotation's /AP /N appearance XObject is
 *     registered in the page's /Resources /XObject and drawn with a `cm`
 *     that maps its (matrix-transformed) /BBox onto the annotation /Rect —
 *     the exact placement pdf.js uses (verified against pdfjs-dist 4.10
 *     core/annotation.js getTransformMatrix + canvas.js beginAnnotation:
 *     the placement matrix is computed from the axial-aligned bounds of the
 *     BBox corners transformed by the appearance /Matrix, and the /Matrix
 *     itself is applied again when the viewer executes `Do`, so both models
 *     compose identically). The burn operators are appended as a NEW content
 *     stream at the end of the page's /Contents array (content streams are
 *     concatenated in order — the burn lands above the page content, where
 *     viewers paint annotations), and the page's /Annots entry is removed
 *     entirely — nothing interactive remains.
 *
 * pdf-lib quirk handled here: PDFFlateStream caches a content stream's
 * encoded bytes on first serialization and Cache.access() never recomputes
 * after operators are pushed. Streams mutated after their document was
 * saved once (create → save → flatten → save) would therefore silently
 * serialize stale bytes. invalidateContentStreamCaches() drops those caches
 * so the final save picks up every pushed operator (including pdf-lib's own
 * form-flatten draws).
 *
 * This module is PURE pdf-lib (no canvas/browser APIs) so the same code
 * path runs inside the worker and under bun in scripts/smoke-flatten.ts.
 */

/** Affine [a b c d e f] in PDF column-vector convention: p' = M·p. */
export type Affine = [number, number, number, number, number, number];
/** Axis-aligned rectangle [x1 y1 x2 y2] (any corner order). */
export type Quad = [number, number, number, number];

export const IDENTITY_AFFINE: Affine = [1, 0, 0, 1, 0, 0];

/** Applies an affine matrix to a point. */
export function applyAffine(
  m: Affine,
  point: [number, number]
): [number, number] {
  return [
    m[0] * point[0] + m[2] * point[1] + m[4],
    m[1] * point[0] + m[3] * point[1] + m[5],
  ];
}

/**
 * Composes two affines: `compose(outer, inner)` applies `inner` first, then
 * `outer` (the matrix product outer × inner — how PDF concatenates `cm`).
 */
export function composeAffine(outer: Affine, inner: Affine): Affine {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
}

/**
 * Axis-aligned bounds of a /BBox after the appearance /Matrix — pdf.js
 * Util.getAxialAlignedBoundingBox (all four corners transformed, then
 * min/max per axis).
 */
export function axialAlignedBounds(
  bbox: Quad,
  matrix: Affine | null
): Quad {
  const m = matrix ?? IDENTITY_AFFINE;
  const corners: [number, number][] = [
    applyAffine(m, [bbox[0], bbox[1]]),
    applyAffine(m, [bbox[2], bbox[3]]),
    applyAffine(m, [bbox[0], bbox[3]]),
    applyAffine(m, [bbox[2], bbox[1]]),
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of corners) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/**
 * The `cm` that places an appearance stream into its annotation rectangle:
 * pdf.js core/annotation.js getTransformMatrix, character for character.
 * The matrix-transformed BBox is scaled + translated onto the /Rect; a
 * degenerate (zero-width/height) transformed box falls back to a pure
 * translation to the rect's lower-left corner.
 */
export function composeAppearanceTransform(
  rect: Quad,
  bbox: Quad,
  matrix: Affine | null
): Affine {
  const [minX, minY, maxX, maxY] = axialAlignedBounds(bbox, matrix);
  if (minX === maxX || minY === maxY) {
    return [1, 0, 0, 1, rect[0], rect[1]];
  }
  const scaleX = (rect[2] - rect[0]) / (maxX - minX);
  const scaleY = (rect[3] - rect[1]) / (maxY - minY);
  return [
    scaleX,
    0,
    0,
    scaleY,
    rect[0] - minX * scaleX,
    rect[1] - minY * scaleY,
  ];
}

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
   * page. pdf-lib's PDFForm.flatten() is always document-wide, so the pages
   * range never applies to the forms pass (the tool hint says so honestly).
   */
  annotationPages?: number[] | null;
  /** Worker progress hook: fired after each processed annotation page. */
  onAnnotationPage?: (done: number, total: number) => void;
}

/** pdf-lib could not flatten the form fields (kept honest: no output). */
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

/** Annotation flag bits (PDF 32000-1 Table 165). */
const FLAG_HIDDEN = 1 << 1; // 2 — never display or print
const FLAG_NOVIEW = 1 << 5; // 32 — never display on screen

function readQuad(dict: PDFDict, key: string): Quad | null {
  const arr = dict.lookupMaybe(PDFName.of(key), PDFArray);
  if (arr === undefined || arr.size() < 4) return null;
  const q: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const num = arr.lookupMaybe(i, PDFNumber);
    if (num === undefined) return null;
    q.push(num.asNumber());
  }
  return [q[0], q[1], q[2], q[3]];
}

function readAffine(dict: PDFDict, key: string): Affine | null {
  const arr = dict.lookupMaybe(PDFName.of(key), PDFArray);
  if (arr === undefined || arr.size() < 6) return null;
  const m: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const num = arr.lookupMaybe(i, PDFNumber);
    if (num === undefined) return null;
    m.push(num.asNumber());
  }
  return [m[0], m[1], m[2], m[3], m[4], m[5]];
}

interface ResolvedAppearance {
  stream: PDFStream;
  ref: PDFRef;
}

/**
 * Structural view of PDFFlateStream's protected contentsCache — the field
 * is real (see pdf-lib cjs/core/structures/PDFFlateStream.d.ts) but not
 * public API, so it is reached through this narrow, typed shape only.
 */
interface CacheHolder {
  contentsCache?: { invalidate(): void };
}

/**
 * Drops the encoded-bytes cache of every content stream pdf-lib created in
 * this session, so a document that was already saved once serializes the
 * operators pushed since (stale caches are a known pdf-lib 1.17.1 wart:
 * PDFContentStream.push never invalidates contentsCache).
 */
function invalidateContentStreamCaches(doc: PDFDocument): void {
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFContentStream) {
      (object as unknown as CacheHolder).contentsCache?.invalidate();
    }
  }
}

/**
 * Resolves an appearance target (fetched raw from a dict value) to
 * { stream, ref }. Direct (unregistered) streams are registered so the
 * page resources can reference them.
 */
function resolveAppearanceStream(
  target: unknown,
  context: PDFContext
): ResolvedAppearance | null {
  if (target instanceof PDFRef) {
    const resolved = context.lookup(target);
    if (resolved instanceof PDFStream) {
      return { stream: resolved, ref: target };
    }
    return null;
  }
  if (target instanceof PDFStream) {
    return { stream: target, ref: context.register(target) };
  }
  return null;
}

/**
 * The /AP /N entry may be a stream/ref (single appearance) or a state
 * dictionary (checkbox/radio "on" states). For the state maps the
 * annotation's /AS selects the entry; without /AS the first entry is used.
 */
function resolveNormalAppearance(
  annot: PDFDict,
  nRaw: unknown,
  context: PDFContext
): ResolvedAppearance | null {
  if (nRaw === undefined) return null;
  const nResolved = nRaw instanceof PDFRef ? context.lookup(nRaw) : nRaw;
  if (nResolved instanceof PDFDict) {
    const state = annot.lookupMaybe(PDFName.of("AS"), PDFName);
    let chosen: unknown =
      state !== undefined ? nResolved.get(state) : undefined;
    if (chosen === undefined || chosen === null) {
      const values = nResolved.values();
      chosen = values.length > 0 ? values[0] : undefined;
    }
    return resolveAppearanceStream(chosen, context);
  }
  return resolveAppearanceStream(nRaw, context);
}

/**
 * Widget detection: /Subtype /Widget, or a MERGED field dict — a field
 * that is its own only widget carries /FT (and usually /T) instead of a
 * Subtype (PDF 32000-1 §12.5.2). /Parent only ever links widgets into a
 * field hierarchy, so both mark form machinery that the annotation pass
 * must never burn.
 */
function isWidgetAnnotation(annot: PDFDict): boolean {
  const subtype = annot.lookupMaybe(PDFName.of("Subtype"), PDFName);
  if (subtype !== undefined && subtype === PDFName.of("Widget")) return true;
  return (
    annot.get(PDFName.of("FT")) !== undefined ||
    annot.get(PDFName.of("Parent")) !== undefined
  );
}

/**
 * Burns one page's annotations into its content and prunes /Annots.
 *
 * `keepWidgets` (annotations-only scope): the form stays interactive, so
 * widget refs must survive in /Annots — the pass rewrites the array to the
 * widget refs it saw. Otherwise the whole /Annots entry is deleted: a
 * successful form flatten already removed the widgets, and every other
 * annotation has been burned or deliberately dropped.
 */
function burnPageAnnotations(
  page: PDFPage,
  report: FlattenReport,
  keepWidgets: boolean
): void {
  const node = page.node;
  const annots = node.Annots();
  if (annots === undefined) return;

  const burnOperators: PDFOperator[] = [];
  const widgetRefs: PDFRef[] = [];
  const count = annots.size();
  for (let i = 0; i < count; i += 1) {
    const annotRef = annots.get(i);
    const annot = annots.lookup(i);
    if (!(annot instanceof PDFDict)) {
      report.annotationsSkipped += 1;
      continue;
    }

    // Hidden and screen-invisible annotations render nothing — skip them.
    const flagsNumber = annot.lookupMaybe(PDFName.of("F"), PDFNumber);
    const flags = flagsNumber === undefined ? 0 : flagsNumber.asNumber();
    if ((flags & FLAG_HIDDEN) !== 0 || (flags & FLAG_NOVIEW) !== 0) {
      report.annotationsSkipped += 1;
      continue;
    }

    // Widgets belong to the form pass (they are gone by now when it ran).
    if (isWidgetAnnotation(annot)) {
      if (keepWidgets && annotRef instanceof PDFRef) widgetRefs.push(annotRef);
      report.annotationsSkipped += 1;
      continue;
    }

    const ap = annot.lookupMaybe(PDFName.of("AP"), PDFDict);
    const nRaw = ap === undefined ? undefined : ap.get(PDFName.of("N"));
    const appearance = resolveNormalAppearance(annot, nRaw, node.context);
    if (appearance === null) {
      // Most viewers draw nothing without an appearance stream.
      report.annotationsSkipped += 1;
      continue;
    }

    // The appearance placement needs /BBox. It is required by the spec for
    // form XObjects (PDF 32000-1 §8.10.1), but pdf.js keeps rendering these
    // malformed streams with a unit-box fallback (build/pdf.worker.mjs,
    // Annotation.getOperatorList: `lookupRect(getArray("BBox"), [0,0,1,1])`),
    // and the form is clipped to that box — so users SEE them in every
    // pdf.js-based viewer (Firefox, Chrome's pdfium differs but also draws
    // defaults). Flatten must preserve what the user saw: treat a missing
    // /BBox as [0 0 1 1] AND synthesize that /BBox onto the stream, so the
    // burned Do clips to the annotation rect exactly like the viewer did.
    let bbox = readQuad(appearance.stream.dict, "BBox");
    if (bbox === null) {
      bbox = [0, 0, 1, 1];
      appearance.stream.dict.set(
        PDFName.of("BBox"),
        appearance.stream.dict.context.obj([0, 0, 1, 1])
      );
    }
    const rect = readQuad(annot, "Rect");
    if (rect === null) {
      report.annotationsSkipped += 1;
      continue;
    }

    const matrix = readAffine(appearance.stream.dict, "Matrix");
    const cm = composeAppearanceTransform(rect, bbox, matrix);

    // Register the appearance XObject (it may live in another indirect
    // object) and collect the burn: q <placement> cm /Name Do Q.
    const key = node.newXObject("FxFlatten", appearance.ref);
    burnOperators.push(
      pushGraphicsState(),
      concatTransformationMatrix(cm[0], cm[1], cm[2], cm[3], cm[4], cm[5]),
      drawObject(key),
      popGraphicsState()
    );
    report.annotationsBurned += 1;
  }

  // Append every burn as ONE new content stream at the end of /Contents.
  // A fresh stream is immune to pdf-lib's stale-contentsCache trap (see the
  // header note), and /Contents arrays concatenate in order, so the burned
  // appearances paint above the page content exactly where viewers draw
  // annotations. addContentStream wraps a lone /Contents ref into an array
  // first (PDFPageLeaf.normalize), so both shapes work.
  if (burnOperators.length > 0) {
    const context = node.context;
    const burnStream = PDFContentStream.of(context.obj({}), burnOperators);
    node.addContentStream(context.register(burnStream));
  }

  if (keepWidgets) {
    // Keep the form alive: /Annots keeps exactly the widget refs (an empty
    // result means the page had no widgets — drop the entry entirely).
    if (widgetRefs.length > 0) {
      node.set(PDFName.of("Annots"), node.context.obj(widgetRefs));
    } else {
      node.delete(PDFName.of("Annots"));
    }
  } else {
    // Nothing interactive remains on this page.
    node.delete(PDFName.of("Annots"));
  }
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
 */
export function flattenDocument(
  doc: PDFDocument,
  options: FlattenOptions = {}
): FlattenReport {
  const {
    scope = "forms-and-annotations",
    annotationPages = null,
    onAnnotationPage,
  } = options;
  const runForms = scope !== "annotations-only";
  const runAnnotations = scope !== "forms-only";
  const report: FlattenReport = {
    pages: doc.getPageCount(),
    fieldCount: 0,
    annotationsBurned: 0,
    annotationsSkipped: 0,
    nothingToDo: false,
  };

  // Any content stream pdf-lib built earlier may carry stale encoded bytes
  // from a previous save; drop the caches BEFORE pushing new operators.
  invalidateContentStreamCaches(doc);

  if (runForms) {
    const acroForm = doc.catalog.getAcroForm();
    if (acroForm !== undefined) {
      const form = doc.getForm(); // AcroForm exists — no implicit creation
      const fields = form.getFields();
      report.fieldCount = fields.length;
      if (fields.length > 0) {
        try {
          form.flatten(); // regenerates appearances from current values
        } catch {
          // Values could not be baked (exotic/broken fields, non-encodable
          // text) — refuse instead of shipping silently-still-editable form
          // fields out of a "flatten" tool.
          throw new FlattenFormsError();
        }
      }
    }
  }

  if (runAnnotations) {
    const pages = doc.getPages();
    const selected =
      annotationPages === null ? null : new Set(annotationPages);
    // Progress is reported over the pages that actually run the pass.
    const total = selected === null ? pages.length : selected.size;
    let done = 0;
    for (let index = 0; index < pages.length; index += 1) {
      if (selected !== null && !selected.has(index)) continue;
      burnPageAnnotations(
        pages[index],
        report,
        /* keepWidgets */ scope === "annotations-only"
      );
      done += 1;
      onAnnotationPage?.(done, total);
    }
  }

  // Already flat — nothing to do. Normal usage, not an error: the
  // worker hands the ORIGINAL bytes back untouched (no re-save churn)
  // and the result view shows the "nothing to flatten" info chip.
  report.nothingToDo =
    report.fieldCount === 0 &&
    report.annotationsBurned === 0 &&
    report.annotationsSkipped === 0;
  return report;
}
