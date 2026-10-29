/**
 * Edit PDF — page-plan building (R12/R13/R15, worker-side but bun-testable).
 *
 * PURE since P6-o: the workspace plan becomes DATA for the own-engine
 * StampContext slot plan — src duplicates, removals by omission, reorder,
 * per-slot /Rotate (R13) and /CropBox (R15) set overrides. The old pdf-lib
 * tree surgery (copyPages/removePage/insertPage + setRotation/setCropBox)
 * is gone with pdf-lib itself: the engine gives every slot its OWN page
 * dict while shared immutable graphs (content streams, fonts, the
 * AcroForm) ride the writer's reachable-graph copy exactly once — the same
 * semantics the surgery asserted (distinct slots, no aliasing, form
 * survival).
 *
 * Isolated in its own module (no worker globals) so the smoke script
 * drives the exact shipping code against real documents.
 */

import { arr as pdfArr, num as pdfNum, type PdfObj, type StampSlot } from "@/lib/own/pdf";
import {
  sanitizeCrop,
  validCropShape,
  type PageView,
} from "./model";

/** Tampered-blob guard — the surface caps the workspace at 500 slots. */
export const MAX_WORKSPACE_PAGES = 2000;

/** The pure src mapping for one plan entry (the R12 clamp backstop). */
export function planSrc(view: PageView, i: number, srcCount: number): number {
  const raw =
    typeof view.src === "number" && Number.isFinite(view.src) && view.src >= 0
      ? Math.trunc(view.src)
      : i;
  return Math.min(raw, Math.max(0, srcCount - 1));
}

/**
 * The full slot plan for a workspace: one {src} entry per plan slot in
 * plan order (duplicates allowed, omissions drop out). The smoke drives
 * this against real documents; the worker composes it with applySlotSets.
 */
export function buildSlotPlan(
  plan: Array<{ src?: number }>,
  srcCount: number,
): StampSlot[] {
  const max = Math.max(0, srcCount - 1);
  return plan.map((view, i) => ({
    src: Math.min(
      typeof view.src === "number" && Number.isFinite(view.src) && view.src >= 0
        ? Math.trunc(view.src)
        : i,
      max,
    ),
  }));
}

/**
 * The slot's own-dict set overrides (R13 rotate + R15 crop), honoring the
 * WIRE-TRUST rules: only explicit quadrant rotates and well-shaped crops
 * from the blob are honored — defaulted views never flatten a source
 * page's own /Rotate or resize an uncropped page (the R12 src lesson,
 * applied to rotate and crop). Returns undefined when the slot carries
 * neither (the common case — no set rides the output page dict).
 */
export function applySlotSets(
  view: PageView,
  rotateExplicit: boolean,
  sourceRotate: number,
  cropExplicit: boolean
): Array<[string, PdfObj]> | undefined {
  const set: Array<[string, PdfObj]> = [];
  if (
    rotateExplicit &&
    view.rotate !== sourceRotate &&
    [0, 90, 180, 270].includes(view.rotate)
  ) {
    set.push(["Rotate", pdfNum(view.rotate)]);
  }
  if (cropExplicit && validCropShape(view.crop) !== undefined) {
    const crop = sanitizeCrop(view.crop, view);
    if (crop) {
      // Absolute-corner form [x0 y0 x1 y1] — pdf-lib's setCropBox(x, y,
      // w, h) writes exactly this shape.
      set.push([
        "CropBox",
        pdfArr(
          pdfNum(crop.x0),
          pdfNum(crop.y0),
          pdfNum(crop.x1),
          pdfNum(crop.y1),
        ),
      ]);
    }
  }
  return set.length > 0 ? set : undefined;
}
