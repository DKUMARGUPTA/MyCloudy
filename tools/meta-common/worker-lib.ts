import { PDFDict, PDFHexString, PDFName, PDFDocument } from "pdf-lib";
import type { PDFRef } from "pdf-lib";

import { type DocInfoEdits } from "./meta";

/**
 * Worker-side metadata engine (PRD §8.2 + §8.3), shared by the
 * change-pdf-doc-info and remove-pdf-metadata workers. Every behavior here
 * is locked by scripts/smoke-metadata.ts — run it after touching this
 * file.
 *
 * Two pdf-lib 1.17.1 quirks the smoke test pinned down:
 *  1. getInfoDict() lazily RE-CREATES an empty Info dict whenever a getter
 *     runs on a doc without one — so snapshot BEFORE stripping and never
 *     read getters afterwards (the removed-fields count would lie).
 *  2. setKeywords() joins an array with spaces; the doc-info form writes
 *     the comma text directly via PDFHexString so what the user typed is
 *     exactly what round-trips.
 */

const INFO_TEXT_KEYS: Record<string, PDFName> = {
  Title: PDFName.Title,
  Author: PDFName.Author,
  Subject: PDFName.Subject,
  Keywords: PDFName.of("Keywords"),
  Creator: PDFName.Creator,
  Producer: PDFName.Producer,
};

function asRef(obj: unknown): PDFRef | null {
  if (obj && typeof obj === "object" && "objectNumber" in obj) {
    return obj as PDFRef;
  }
  return null;
}

/** The live Info dict, or undefined when the doc has none. Never creates. */
export function infoDict(doc: PDFDocument): PDFDict | undefined {
  const found = doc.context.lookupMaybe(
    doc.context.trailerInfo.Info as never,
    PDFDict
  );
  return found;
}

function ensureInfoDict(doc: PDFDocument): PDFDict {
  const existing = infoDict(doc);
  if (existing) return existing;
  const dict = PDFDict.withContext(doc.context);
  const ref = doc.context.register(dict);
  doc.context.trailerInfo.Info = ref;
  return dict;
}

/** Drops an entirely-empty Info dict (no dangling `/Info << >>`). */
function dropEmptyInfo(doc: PDFDocument): void {
  const dict = infoDict(doc);
  if (dict && dict.entries().length === 0) {
    const ref = asRef(doc.context.trailerInfo.Info);
    if (ref) doc.context.delete(ref);
    doc.context.trailerInfo.Info = undefined;
  }
}

/** Removes the catalog /Metadata XMP stream (object bytes included). */
export function stripXmpBlock(doc: PDFDocument): boolean {
  const metaObj = doc.catalog.get(PDFName.of("Metadata"));
  if (metaObj === undefined) return false;
  const ref = asRef(metaObj);
  doc.catalog.delete(PDFName.of("Metadata"));
  if (ref) doc.context.delete(ref);
  return true;
}

export interface StripReport {
  /** Raw Info-dict keys that were present and removed (e.g. "Title"). */
  removedFields: string[];
  removedXmp: boolean;
}

/**
 * Removes EVERYTHING: the whole Info dict (object + trailer reference) and,
 * when asked, the XMP /Metadata stream. Returns what was actually there —
 * the honest count the result reporting uses.
 */
export function stripAllMetadata(
  doc: PDFDocument,
  alsoXmp: boolean
): StripReport {
  const dict = infoDict(doc);
  const removedFields: string[] = [];
  if (dict) {
    for (const [key] of dict.entries()) {
      removedFields.push(key.asString());
    }
  }
  const ref = asRef(doc.context.trailerInfo.Info);
  if (ref) doc.context.delete(ref);
  doc.context.trailerInfo.Info = undefined;
  const removedXmp = alsoXmp ? stripXmpBlock(doc) : false;
  return { removedFields, removedXmp };
}

/** Info-dict keys handled by the six text fields + the two date modes. */
const KNOWN_INFO_KEYS = new Set([
  "Title",
  "Author",
  "Subject",
  "Keywords",
  "Creator",
  "Producer",
  "CreationDate",
  "ModDate",
]);

/** Applies the doc-info form edits (undefined = untouched, "" = remove). */
export function applyDocInfoEdits(
  doc: PDFDocument,
  edits: DocInfoEdits
): void {
  const texts: [string | undefined, PDFName][] = [
    [edits.title, INFO_TEXT_KEYS.Title],
    [edits.author, INFO_TEXT_KEYS.Author],
    [edits.subject, INFO_TEXT_KEYS.Subject],
    [edits.keywords, INFO_TEXT_KEYS.Keywords],
    [edits.creator, INFO_TEXT_KEYS.Creator],
    [edits.producer, INFO_TEXT_KEYS.Producer],
  ];
  for (const [value, key] of texts) {
    if (value === undefined) continue; // untouched
    if (value === "") {
      const dict = infoDict(doc);
      dict?.delete(key); // remove (missing dict → nothing to delete)
    } else {
      ensureInfoDict(doc).set(key, PDFHexString.fromText(value));
    }
  }

  // Dates: "now" → pdf-lib's own setters (canonical D: strings);
  // "remove" → drop the Info entry; "keep" → untouched.
  if (edits.creationMode === "now") doc.setCreationDate(new Date());
  else if (edits.creationMode === "remove")
    infoDict(doc)?.delete(PDFName.of("CreationDate"));

  if (edits.modMode === "now") doc.setModificationDate(new Date());
  else if (edits.modMode === "remove")
    infoDict(doc)?.delete(PDFName.of("ModDate"));

  // Custom entries ("Remove all metadata" removes these too).
  if (edits.stripCustom) {
    const dict = infoDict(doc);
    if (dict) {
      for (const [key] of [...dict.entries()]) {
        if (!KNOWN_INFO_KEYS.has(key.asString())) dict.delete(key);
      }
    }
  }

  if (edits.stripXmp) stripXmpBlock(doc);
  dropEmptyInfo(doc);
}
