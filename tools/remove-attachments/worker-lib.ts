import {
  arrItems,
  asDict,
  asArr,
  catalogDict,
  listPages,
  rewriteDocument,
  dget,
  resolveTrailerRef,
  type ParsedPdf,
  type PdfObj,
} from "@/lib/own/pdf";
import {
  collectAttachments,
  embeddedFileStreamNums,
} from "../attachments-common/nametree";
import { stripEmbeddedFileReferences } from "../attachments-common/write";

/**
 * Remove attachments worker-lib (P3-d) — PURE surgery, smoke-drivable
 * without a Worker (the R48 anatomy discipline):
 *
 *   1. inventory the document-level files (tree + /AF, deduped);
 *   2. protect filespecs still referenced by file-attachment
 *      ANNOTATIONS or page /AF arrays (their objects survive);
 *   3. strip every tree entry + catalog /AF association (in place);
 *   4. delete the orphaned filespec + stream objects (deletions);
 *   5. rewrite CLASSIC — loose objects, byte-exact pages.
 */

export interface RemoveOutcome {
  /** Rewritten PDF bytes (one per input file). */
  bytes: Uint8Array;
  /** Document-level attachments that were inventoried for removal. */
  removed: number;
  /** Attachment objects kept alive for page-pin annotations. */
  keptAnnotated: number;
}

/**
 * Filespec object numbers that must SURVIVE: referenced from an
 * annotation /FS (file-attachment pins) or a page-level /AF array.
 * (The catalog /AF is NOT scanned here — that one is being removed.)
 */
export function protectedFilespecNums(doc: ParsedPdf): Set<number> {
  const protectedNums = new Set<number>();
  const pages = listPages(doc);
  for (const page of pages) {
    const annots = arrItems(dget({ k: "dict", m: page.dict }, "Annots"));
    if (annots !== null) {
      for (const item of annots) {
        const annot = asDict(resolveTrailerRef(doc, item));
        if (annot === undefined) continue;
        const fs = annot.get("FS");
        if (fs !== undefined && fs.k === "ref") protectedNums.add(fs.num);
      }
    }
    const pageAf = asArr(resolveTrailerRef(doc, dget({ k: "dict", m: page.dict }, "AF")));
    if (pageAf !== undefined) {
      for (const item of pageAf) {
        if (item.k === "ref") protectedNums.add(item.num);
      }
    }
  }
  return protectedNums;
}

/**
 * The whole per-file surgery. Returns null when the document carries
 * NO document-level attachments (the honest nothing-to-do refusal).
 */
export function removeAttachmentsFromDoc(doc: ParsedPdf): RemoveOutcome | null {
  const catalog = catalogDict(doc);
  if (catalog === null) return null;

  const inventory = collectAttachments(doc);
  if (inventory.length === 0) return null;

  const protectedNums = protectedFilespecNums(doc);
  const deletions = new Set<number>();
  const allSpecNums = new Set<number>();
  let keptAnnotated = 0;
  for (const info of inventory) {
    allSpecNums.add(info.filespecNum);
    if (protectedNums.has(info.filespecNum)) {
      keptAnnotated += 1;
      continue; // reference goes, object stays (an annotation needs it)
    }
    deletions.add(info.filespecNum);
    for (const streamNum of embeddedFileStreamNums(info.spec)) {
      deletions.add(streamNum);
    }
  }

  // Strip tree + catalog /AF references for EVERY inventoried spec
  // (protected objects lose the reference but keep their bytes).
  stripEmbeddedFileReferences(doc, catalog, allSpecNums);

  const bytes = rewriteDocument(doc, { deletions });
  return { bytes, removed: inventory.length, keptAnnotated };
}

/** Type re-export for worker typing. */
export type { PdfObj };
