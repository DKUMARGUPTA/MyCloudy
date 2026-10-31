/**
 * Annotation classification + filtering (P1-d / R53) — PURE module so the
 * smoke battery exercises exactly what ships.
 *
 * PDF annotation subtypes (ISO 32000-1 §12.5.2) sorted into three removal
 * groups; anything unrecognized lands with markup — this is a CLEANUP tool,
 * unknown interactive junk goes when markup goes.
 *
 *   markup: notes, highlights, drawings, stamps, media, popup children…
 *   link:   /Link (kept by default — links are usually wanted)
 *   widget: /Widget form fields (kept by default — see the form switch)
 */

import type { PdfObj, ParsedPdf } from "@/lib/own/pdf";
import { asName, dget, resolve } from "@/lib/own/pdf";

export type AnnotationGroup = "markup" | "link" | "widget";

const MARKUP_SUBTYPES = new Set([
  "3D",
  "Caret",
  "Circle",
  "FileAttachment",
  "FreeText",
  "Highlight",
  "Ink",
  "Line",
  "Movie",
  "Polygon",
  "PolyLine",
  "Popup",
  "PrinterMark",
  "Redact",
  "RichMedia",
  "Screen",
  "Sound",
  "Square",
  "Squiggly",
  "Stamp",
  "StrikeOut",
  "Text",
  "TrapNet",
  "Underline",
  "Watermark",
]);

export function classifyAnnotation(
  subtype: string | undefined,
): AnnotationGroup {
  if (subtype === "Link") return "link";
  if (subtype === "Widget") return "widget";
  return "markup";
}

export interface AnnotationRemoval {
  markup: boolean;
  links: boolean;
  widgets: boolean;
}

/** The /Subtype of one /Annots array item (resolved through refs). */
function annotSubtype(
  doc: ParsedPdf,
  item: PdfObj,
): string | undefined {
  const obj = resolve(doc, item);
  if (!obj || obj.k !== "dict") return undefined;
  return asName(obj.m.get("Subtype"));
}

export interface FilterResult {
  /** Surviving /Annots items (original refs, untouched). */
  kept: PdfObj[];
  /** How many entries were removed. */
  removed: number;
}

/** Applies the removal groups to one page's /Annots items. */
export function filterAnnots(
  doc: ParsedPdf,
  items: PdfObj[],
  removal: AnnotationRemoval,
): FilterResult {
  const kept: PdfObj[] = [];
  let removed = 0;
  for (const item of items) {
    const group = classifyAnnotation(annotSubtype(doc, item));
    const drop =
      (group === "markup" && removal.markup) ||
      (group === "link" && removal.links) ||
      (group === "widget" && removal.widgets);
    if (drop) removed += 1;
    else kept.push(item);
  }
  return { kept, removed };
}

/**
 * Reads a page's own /Annots as an items array — resolving a ref and
 * returning undefined for absent/empty/non-array values. The items stay as
 * the ORIGINAL entries (usually refs) so kept entries serialize untouched.
 */
export function readPageAnnots(
  doc: ParsedPdf,
  pageDict: Map<string, PdfObj>,
): PdfObj[] | undefined {
  const raw = pageDict.get("Annots");
  if (raw === undefined) return undefined;
  const arr = resolve(doc, raw);
  if (!arr || arr.k !== "arr" || arr.items.length === 0) return undefined;
  return arr.items;
}

/** Counts matching annotations across pages (for the nothing-to-do check). */
export function countRemovable(
  doc: ParsedPdf,
  pageDicts: Array<Map<string, PdfObj>>,
  removal: AnnotationRemoval,
): number {
  let total = 0;
  for (const dict of pageDicts) {
    const items = readPageAnnots(doc, dict);
    if (items === undefined) continue;
    total += filterAnnots(doc, items, removal).removed;
  }
  return total;
}

/** True when the catalog carries an /AcroForm (checked before patching). */
export function catalogHasAcroForm(catalog: Map<string, PdfObj>): boolean {
  return dget({ k: "dict", m: catalog }, "AcroForm") !== undefined;
}
