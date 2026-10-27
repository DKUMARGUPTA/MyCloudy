/**
 * DocoPDF own PDF micro-engine — page-surgery operations (P6-a).
 *
 * organizePdf: the engine seam entry the organize family will call
 * (P6-c migration). Takes raw PDF bytes + a page plan (copied pages with
 * optional rotation deltas, and/or blank pages) and returns fresh bytes.
 * Everything below runs on OUR parser + OUR writer — zero external code.
 */

import { normalizeRotation, listPages } from "./document";
import { type PdfObj, cloneDict, num } from "./objects";
import { PdfError, parsePdf } from "./parser";
import { writeDocument, type WritePage } from "./writer";

export type PlanEntry =
  | {
      kind: "page";
      /** 0-based index into the source document's reading order. */
      src: number;
      /** Rotation added to the page's existing /Rotate (normalized). */
      rotateDelta?: number;
    }
  | { kind: "blank"; width: number; height: number };

export interface OrganizeResult {
  bytes: Uint8Array;
  /** Number of pages written (plan length). */
  pageCount: number;
  /** True when the source parse needed brute-force recovery. */
  recovered: boolean;
}

/**
 * Rebuild a PDF from a plan: selected source pages (any order, optional
 * rotation deltas) plus blank pages at any position. Content streams are
 * copied byte-exactly — nothing re-encodes.
 */
export function organizePdf(bytes: Uint8Array, plan: PlanEntry[]): OrganizeResult {
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new PdfError("corrupt", "empty page plan");
  }
  if (plan.length > 200_000) {
    throw new PdfError("corrupt", "plan exceeds sanity cap");
  }
  const doc = parsePdf(bytes);
  const pages = listPages(doc);

  const writePages: WritePage[] = plan.map((entry) => {
    if (entry.kind === "blank") {
      if (
        !Number.isFinite(entry.width) || !Number.isFinite(entry.height) ||
        entry.width <= 0 || entry.height <= 0 ||
        entry.width > 14_400 || entry.height > 14_400
      ) {
        throw new PdfError("corrupt", "blank page size out of range");
      }
      return { type: "blank", width: entry.width, height: entry.height };
    }
    const page = pages[entry.src];
    if (!page) {
      throw new PdfError("corrupt", `page index ${entry.src} out of range`);
    }
    const set: Array<[string, PdfObj]> = [];
    if (entry.rotateDelta !== undefined && entry.rotateDelta !== 0) {
      const target = normalizeRotation(page.rotate + entry.rotateDelta);
      set.push(["Rotate", num(target)]);
    }
    const dict = cloneDict(page.dict, {
      drop: ["Parent"],
      set: set.length > 0 ? set : undefined,
    });
    return { type: "copy", doc, srcNum: page.ref.num, dict };
  });

  const bytesOut = writeDocument(writePages, doc.version);
  return { bytes: bytesOut, pageCount: plan.length, recovered: doc.recovered };
}
