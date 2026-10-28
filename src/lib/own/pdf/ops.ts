/**
 * DocoPDF own PDF micro-engine — page-surgery operations (P6-a, extended
 * P6-c + P6-d).
 *
 * Two-level API so callers that write MANY outputs from ONE source
 * (extract "one page = one file") parse exactly once:
 *   parseForOrganize(bytes)  → OrganizeSource { doc, pages }
 *   organizePages(source, plan, onProgress?) → Uint8Array
 * and the byte-level convenience wrapper:
 *   organizePdf(bytes, plan, onProgress?) → OrganizeResult
 * Multi-document merges (P6-d) parse each input once and rebuild through:
 *   organizeMerge(sources, plan, onProgress?) → Uint8Array
 *
 * Everything below runs on OUR parser + OUR writer — zero external code.
 */

import {
  listPages,
  materializeInheritable,
  normalizeRotation,
  type PdfPageInfo,
} from "./document";
import { type PdfObj, cloneDict, num } from "./objects";
import { PdfError, parsePdf, type ParsedPdf } from "./parser";
import { writeDocument, type WritePage } from "./writer";

export type PlanEntry =
  | {
      /** Copy source page `src` (0-based reading order). */
      kind: "page";
      src: number;
      /** Rotation added to the page's existing /Rotate (normalized). */
      rotateDelta?: number;
      /**
       * Extra own-dict overrides applied to the copied page (P6-h, the
       * halve route): typically MediaBox/CropBox windowing and clamped
       * Bleed/Trim/Art boxes. Applied AFTER rotateDelta — explicit entries
       * win. Inheritable entries still materialize for keys not in `set`.
       */
      set?: Array<[string, PdfObj]>;
    }
  | { kind: "blank"; width: number; height: number }
  | {
      /** Blank page sized like source page `src`'s MediaBox. */
      kind: "blank-from";
      src: number;
    };

/** One parsed source, ready for any number of organize passes. */
export interface OrganizeSource {
  doc: ParsedPdf;
  pages: PdfPageInfo[];
}

/**
 * Plan entry for MULTI-document merges (P6-d): `doc` indexes into the
 * `sources` array passed to organizeMerge. Same three shapes as PlanEntry,
 * each qualified with its source document.
 */
export type MergePlanEntry =
  | {
      /** Copy `sources[doc]` page `src` (0-based reading order). */
      kind: "page";
      doc: number;
      src: number;
      /** Rotation added to the page's existing /Rotate (normalized). */
      rotateDelta?: number;
      /** Own-dict overrides on the copied page (see PlanEntry.set). */
      set?: Array<[string, PdfObj]>;
    }
  | { kind: "blank"; width: number; height: number }
  | {
      /** Blank page sized like `sources[doc]` page `src`'s MediaBox. */
      kind: "blank-from";
      doc: number;
      src: number;
    };

export interface OrganizeResult {
  bytes: Uint8Array;
  /** Number of pages written (plan length). */
  pageCount: number;
  /** True when the source parse needed brute-force recovery. */
  recovered: boolean;
}

/** Per-page progress: fraction 0..1 of pages written, 1-based page number. */
export type OrganizeProgress = (fraction: number, page: number) => void;

const MAX_PLAN = 200_000;
const MAX_DIM = 14_400;

const SANITY_LIMITS = {
  plan: MAX_PLAN,
  dimension: MAX_DIM,
} as const;

/** Parses + walks the page tree once; re-use the result for many writes. */
export function parseForOrganize(bytes: Uint8Array): OrganizeSource {
  const doc = parsePdf(bytes);
  return { doc, pages: listPages(doc) };
}

function blankSizedLike(page: PdfPageInfo): WritePage {
  const [x0, y0, x1, y1] = page.mediaBox;
  const width = x1 - x0;
  const height = y1 - y0;
  if (
    !Number.isFinite(width) || !Number.isFinite(height) ||
    width <= 0 || height <= 0 ||
    width > SANITY_LIMITS.dimension || height > SANITY_LIMITS.dimension
  ) {
    throw new PdfError("corrupt", "source page has an unusable MediaBox");
  }
  return { type: "blank", width, height };
}

function buildWritePages(source: OrganizeSource, plan: PlanEntry[]): WritePage[] {
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new PdfError("corrupt", "empty page plan");
  }
  if (plan.length > SANITY_LIMITS.plan) {
    throw new PdfError("corrupt", "plan exceeds sanity cap");
  }
  return plan.map((entry) => {
    if (entry.kind === "blank") {
      if (
        !Number.isFinite(entry.width) || !Number.isFinite(entry.height) ||
        entry.width <= 0 || entry.height <= 0 ||
        entry.width > SANITY_LIMITS.dimension || entry.height > SANITY_LIMITS.dimension
      ) {
        throw new PdfError("corrupt", "blank page size out of range");
      }
      return {
        type: "blank" as const,
        width: entry.width,
        height: entry.height,
      };
    }
    if (entry.kind === "blank-from") {
      const page = source.pages[entry.src];
      if (!page) {
        throw new PdfError("corrupt", `page index ${entry.src} out of range`);
      }
      return blankSizedLike(page);
    }
    const page = source.pages[entry.src];
    if (!page) {
      throw new PdfError("corrupt", `page index ${entry.src} out of range`);
    }
    const set: Array<[string, PdfObj]> = [];
    if (entry.rotateDelta !== undefined && entry.rotateDelta !== 0) {
      const target = normalizeRotation(page.rotate + entry.rotateDelta);
      set.push(["Rotate", num(target)]);
    }
    if (entry.set !== undefined) set.push(...entry.set);
    const dict = cloneDict(page.dict, {
      drop: ["Parent"],
      set: set.length > 0 ? set : undefined,
    });
    materializeInheritable(dict, page);
    return { type: "copy" as const, doc: source.doc, srcNum: page.ref.num, dict };
  });
}

/**
 * Rebuild a PDF from a plan against an ALREADY-parsed source: selected
 * source pages (any order, duplicates allowed, optional rotation deltas)
 * plus blank pages at any position. Content streams are copied
 * byte-exactly — nothing re-encodes. Duplicate indices each get their own
 * page dict in the output (rotations independent), while shared immutable
 * graphs (content streams, fonts) are written once — valid PDF and
 * typically smaller than pdf-lib's per-copy duplication.
 */
export function organizePages(
  source: OrganizeSource,
  plan: PlanEntry[],
  onProgress?: OrganizeProgress,
): Uint8Array {
  const writePages = buildWritePages(source, plan);
  return writeDocument(writePages, source.doc.version, onProgress);
}

/** Byte-level convenience wrapper: parse once, write once. */
export function organizePdf(
  bytes: Uint8Array,
  plan: PlanEntry[],
  onProgress?: OrganizeProgress,
): OrganizeResult {
  const source = parseForOrganize(bytes);
  const bytesOut = organizePages(source, plan, onProgress);
  return {
    bytes: bytesOut,
    pageCount: plan.length,
    recovered: source.doc.recovered,
  };
}

/** Picks the HIGHEST PDF version among sources — never a downgrade. */
function maxVersion(sources: OrganizeSource[]): string | undefined {
  let best = 0;
  let bestVersion: string | undefined;
  for (const source of sources) {
    const raw = source.doc.version;
    const match = /^(\d+)\.(\d+)$/.exec(raw ?? "");
    if (!match) continue;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const value = major * 10 + minor;
    if (value > best) {
      best = value;
      bestVersion = raw;
    }
  }
  return bestVersion;
}

/**
 * Rebuild ONE PDF from pages of MANY parsed sources (P6-d merge kernel on
 * top of the same writer): any order, duplicates allowed, blanks at any
 * position — every source graph is copied through the shared reachable-set
 * union (a font shared by two inputs is still written once per document it
 * came from). Output header carries the highest input version.
 */
export function organizeMerge(
  sources: OrganizeSource[],
  plan: MergePlanEntry[],
  onProgress?: OrganizeProgress,
): Uint8Array {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new PdfError("corrupt", "merge needs at least one source");
  }
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new PdfError("corrupt", "empty page plan");
  }
  if (plan.length > SANITY_LIMITS.plan) {
    throw new PdfError("corrupt", "plan exceeds sanity cap");
  }
  const resolveSource = (docIndex: number): OrganizeSource => {
    if (
      !Number.isInteger(docIndex) ||
      docIndex < 0 ||
      docIndex >= sources.length
    ) {
      throw new PdfError("corrupt", `source index ${docIndex} out of range`);
    }
    return sources[docIndex]!;
  };
  const writePages = plan.map((entry) => {
    if (entry.kind === "blank") {
      if (
        !Number.isFinite(entry.width) ||
        !Number.isFinite(entry.height) ||
        entry.width <= 0 ||
        entry.height <= 0 ||
        entry.width > SANITY_LIMITS.dimension ||
        entry.height > SANITY_LIMITS.dimension
      ) {
        throw new PdfError("corrupt", "blank page size out of range");
      }
      return {
        type: "blank" as const,
        width: entry.width,
        height: entry.height,
      };
    }
    if (entry.kind === "blank-from") {
      const refPage = resolveSource(entry.doc).pages[entry.src];
      if (!refPage) {
        throw new PdfError(
          "corrupt",
          `page index ${entry.src} out of range in source ${entry.doc}`,
        );
      }
      return blankSizedLike(refPage);
    }
    const source = resolveSource(entry.doc);
    const page = source.pages[entry.src];
    if (!page) {
      throw new PdfError(
        "corrupt",
        `page index ${entry.src} out of range in source ${entry.doc}`,
      );
    }
    const set: Array<[string, PdfObj]> = [];
    if (entry.rotateDelta !== undefined && entry.rotateDelta !== 0) {
      const target = normalizeRotation(page.rotate + entry.rotateDelta);
      set.push(["Rotate", num(target)]);
    }
    if (entry.set !== undefined) set.push(...entry.set);
    const dict = cloneDict(page.dict, {
      drop: ["Parent"],
      set: set.length > 0 ? set : undefined,
    });
    materializeInheritable(dict, page);
    return {
      type: "copy" as const,
      doc: source.doc,
      srcNum: page.ref.num,
      dict,
    };
  });
  return writeDocument(writePages, maxVersion(sources), onProgress);
}
