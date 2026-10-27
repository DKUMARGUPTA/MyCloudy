/**
 * DocoPDF own PDF micro-engine — page tree (P6-a).
 *
 * Walks the /Pages tree with spec §7.7.3.4 attribute INHERITANCE
 * (MediaBox/CropBox/Resources/Rotate/BleedBox/TrimBox/ArtBox flow down from
 * interior nodes unless a page overrides them). Rotation is normalized to
 * {0, 90, 180, 270} with negative/over-360 tolerance.
 */

import {
  type PdfObj,
  type PdfRef,
  asBox,
  asNum,
  dget,
} from "./objects";
import { PdfError, type ParsedPdf, resolve } from "./parser";

export interface PdfPageInfo {
  /** Indirect ref of the page object. */
  ref: PdfRef;
  /** The page's own dict (shared, read-only — writer clones before edits). */
  dict: Map<string, PdfObj>;
  /** Inherited-then-own MediaBox (spec-required; Letter fallback). */
  mediaBox: [number, number, number, number];
  /** Own-or-inherited CropBox; defaults to mediaBox when absent. */
  cropBox: [number, number, number, number];
  /** Normalized rotation 0|90|180|270. */
  rotate: number;
}

const MAX_TREE_DEPTH = 64;
const MAX_PAGES = 200_000; // sanity cap (organize tools already cap inputs)

export function normalizeRotation(r: number): number {
  if (!Number.isFinite(r)) return 0;
  const m = ((Math.round(r / 90) * 90) % 360 + 360) % 360;
  return m === 0 || m === 90 || m === 180 || m === 270 ? m : 0;
}

function boxOr(
  o: PdfObj | undefined,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  return asBox(o) ?? fallback;
}

/**
 * Enumerate every page in reading order.
 * Throws PdfError("corrupt") when the catalog/pages tree is unusable.
 */
export function listPages(doc: ParsedPdf): PdfPageInfo[] {
  const rootObj = doc.trailer.get("Root");
  const catalog = rootObj ? resolve(doc, rootObj) : undefined;
  if (!catalog || (catalog.k !== "dict" && catalog.k !== "stream")) {
    throw new PdfError("corrupt", "catalog (/Root) missing or unreadable");
  }
  const pagesObj = dget(catalog, "Pages");
  const pagesRoot = pagesObj ? resolve(doc, pagesObj) : undefined;
  if (!pagesRoot || (pagesRoot.k !== "dict" && pagesRoot.k !== "stream")) {
    throw new PdfError("corrupt", "/Pages root missing from catalog");
  }

  const pages: PdfPageInfo[] = [];
  const fallbackBox: [number, number, number, number] = [0, 0, 612, 792];

  const walk = (
    nodeRef: PdfRef,
    node: Map<string, PdfObj>,
    inherited: Map<string, PdfObj>,
    depth: number,
  ): void => {
    if (depth > MAX_TREE_DEPTH) {
      throw new PdfError("corrupt", "page tree deeper than 64 levels");
    }
    if (pages.length > MAX_PAGES) {
      throw new PdfError("corrupt", "page count exceeds sanity cap");
    }
    const type = node.get("Type");
    const typeName = type?.k === "name" ? type.v : undefined;

    // Merge inheritables: child values override inherited ones.
    const merged = new Map<string, PdfObj>(inherited);
    for (const key of INHERIT_KEYS) {
      const own = node.get(key);
      if (own !== undefined) merged.set(key, own);
    }

    if (typeName === "Page") {
      const media = boxOr(merged.get("MediaBox"), fallbackBox);
      pages.push({
        ref: nodeRef,
        dict: node,
        mediaBox: media,
        cropBox: boxOr(merged.get("CropBox"), media),
        rotate: normalizeRotation(asNum(merged.get("Rotate")) ?? 0),
      });
      return;
    }

    // Interior node: /Type Pages (or missing Type with /Kids — tolerated).
    const kidsObj = node.get("Kids");
    if (!kidsObj || kidsObj.k !== "arr") {
      throw new PdfError("corrupt", "pages tree node without /Kids");
    }
    for (const kid of kidsObj.items) {
      if (kid.k !== "ref") {
        throw new PdfError("corrupt", "/Kids entry must be an indirect reference");
      }
      const kidNode = resolve(doc, kid);
      if (!kidNode || (kidNode.k !== "dict" && kidNode.k !== "stream")) {
        throw new PdfError("corrupt", "dangling /Kids entry");
      }
      walk(kid, kidNode.m, merged, depth + 1);
    }
  };

  const pagesRef = pagesObj && pagesObj.k === "ref" ? pagesObj : undefined;
  const rootRef = rootObj && rootObj.k === "ref" ? rootObj : undefined;
  const rootNodeRef: PdfRef =
    pagesRef ?? rootRef ?? { k: "ref", num: -1, gen: 0 };
  walk(rootNodeRef, pagesRoot.m, new Map(), 0);
  return pages;
}

const INHERIT_KEYS = [
  "MediaBox", "CropBox", "Resources", "Rotate", "BleedBox", "TrimBox", "ArtBox",
] as const;
