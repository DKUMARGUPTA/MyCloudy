import {
  hstr,
  listPages,
  lstr,
  parsePdf,
  rewriteDocument,
  type ParsedPdf,
  type PdfObj,
} from "@/lib/own/pdf";

import { type DocInfoEdits } from "./meta";

/**
 * Worker-side metadata engine (PRD §8.2 + §8.3) — OWN-ENGINE port (P6-s).
 * Shared by the change-pdf-doc-info and remove-pdf-metadata workers.
 * Every behavior here is locked by scripts/smoke-metadata.ts — run it
 * after touching this file.
 *
 * The seam is the engine's preserve-numbers rewriter: edits mutate the
 * PARSED graphs (Info dict, catalog, page dicts) in place, deletions +
 * a brand-new Info ride RewriteOptions, and saveMetaDoc re-serializes the
 * whole document with object streams.
 *
 * Byte formats are pdf-lib oracle-parity (P6-l probes):
 *   text fields  → <FEFF…> UTF-16BE hex (hstr, uppercase)
 *   date fields  → literal (D:YYYYMMDDHHmmSSZ) UTC strings (lstr)
 */

/** The parsed document + the accumulated rewrite state. */
export interface MetaDoc {
  readonly doc: ParsedPdf;
  readonly pageCount: number;
  /** Object numbers to omit from the rewrite. */
  readonly deletions: Set<number>;
  /** Drop the trailer /Info (the existing one was deleted). */
  dropInfo: boolean;
  /** A brand-new Info dict (created on demand), written + wired. */
  infoOverride?: { num: number; obj: PdfObj & { k: "dict" } };
}

/** Parse + page count; encrypted/corrupt refusals stay typed throws. */
export function loadMetaDoc(bytes: Uint8Array): MetaDoc {
  const doc = parsePdf(bytes);
  return {
    doc,
    pageCount: listPages(doc).length,
    deletions: new Set(),
    dropInfo: false,
  };
}

/** Serialize the edited document (object streams on — pdf-lib save parity). */
export function saveMetaDoc(m: MetaDoc): Uint8Array {
  return rewriteDocument(m.doc, {
    deletions: m.deletions,
    dropInfo: m.dropInfo,
    infoOverride: m.infoOverride,
    objectStreams: true,
  });
}

/* ── Info dict plumbing ───────────────────────────────────────────── */

/** The trailer /Info object number, when present. */
function infoNum(m: MetaDoc): number | null {
  const info = m.doc.trailer.get("Info");
  return info && info.k === "ref" ? info.num : null;
}

/** The live Info dict map, or undefined when the doc has none. Never creates. */
export function infoDict(m: MetaDoc): Map<string, PdfObj> | undefined {
  const num = infoNum(m);
  if (num === null) return undefined;
  if (m.deletions.has(num)) return undefined;
  const obj = m.doc.getObject(num);
  if (!obj || (obj.k !== "dict" && obj.k !== "stream")) return undefined;
  return obj.m;
}

/** A free object number above every existing one (containers stay above it). */
function nextFreeNum(m: MetaDoc): number {
  let max = 0;
  for (const [num, entry] of m.doc.entries) {
    if (entry.type !== 0 && num > max) max = num;
  }
  return max + 1;
}

/** The live Info map, creating (and wiring) one when absent. */
function ensureInfoDict(m: MetaDoc): Map<string, PdfObj> {
  const existing = infoDict(m);
  if (existing) return existing;
  const obj: PdfObj & { k: "dict" } = { k: "dict", m: new Map() };
  m.infoOverride = { num: nextFreeNum(m), obj };
  return obj.m;
}

/** Drops an entirely-empty Info dict (no dangling `/Info << >>`). */
function dropEmptyInfo(m: MetaDoc): void {
  const override = m.infoOverride;
  if (override !== undefined) {
    if (override.obj.m.size === 0) m.infoOverride = undefined;
    return;
  }
  const dict = infoDict(m);
  if (dict && dict.size === 0) {
    const num = infoNum(m);
    if (num !== null) m.deletions.add(num);
    m.dropInfo = true;
  }
}

/* ── strip side ───────────────────────────────────────────────────── */

export interface StripReport {
  /** Raw Info-dict keys that were present and removed (e.g. "Title"). */
  removedFields: string[];
  removedXmp: boolean;
  /** Pages whose /PieceInfo dictionary was removed (private app data). */
  removedPieceInfo: number;
  /** Page-level /Metadata streams removed (a second XMP copy per page). */
  removedPageMetadata: number;
  /** Annotation /M modification dates removed. */
  removedAnnotationDates: number;
}

/** The catalog dict map (mutable) — null when the trailer /Root is unusable. */
function catalogMap(m: MetaDoc): Map<string, PdfObj> | null {
  const root = m.doc.trailer.get("Root");
  if (!root || root.k !== "ref") return null;
  const catalog = m.doc.getObject(root.num);
  if (!catalog || (catalog.k !== "dict" && catalog.k !== "stream")) return null;
  return catalog.m;
}

/** Removes the catalog /Metadata XMP stream (object bytes included). */
export function stripXmpBlock(m: MetaDoc): boolean {
  const catalog = catalogMap(m);
  if (catalog === null) return false;
  const metaObj = catalog.get("Metadata");
  if (metaObj === undefined) return false;
  if (metaObj.k === "ref") m.deletions.add(metaObj.num);
  catalog.delete("Metadata");
  return true;
}

/**
 * Removes EVERYTHING the remove-metadata tool promises: the whole Info dict
 * (object + trailer reference), the XMP /Metadata stream (when asked) and
 * the page-level extras (PieceInfo, page /Metadata streams, annotation /M
 * dates — always; a privacy tool cannot half-strip). Returns what was
 * actually there — the honest count the result reporting uses.
 */
export function stripAllMetadata(m: MetaDoc, alsoXmp: boolean): StripReport {
  const dict = infoDict(m);
  const removedFields: string[] = [];
  if (dict) {
    for (const [key] of dict) removedFields.push(key);
  }
  const num = infoNum(m);
  if (num !== null) m.deletions.add(num);
  m.dropInfo = true;
  m.infoOverride = undefined; // a strip never leaves a created Info behind
  const removedXmp = alsoXmp ? stripXmpBlock(m) : false;

  let removedPieceInfo = 0;
  let removedPageMetadata = 0;
  let removedAnnotationDates = 0;
  for (const page of listPages(m.doc)) {
    const dropRefKey = (key: string): boolean => {
      const value = page.dict.get(key);
      if (value === undefined) return false;
      if (value.k === "ref") m.deletions.add(value.num);
      page.dict.delete(key);
      return true;
    };
    if (dropRefKey("PieceInfo")) removedPieceInfo += 1;
    if (dropRefKey("Metadata")) removedPageMetadata += 1;
    const annots = page.dict.get("Annots");
    if (annots && annots.k === "arr") {
      for (const entry of annots.items) {
        const annot =
          entry.k === "ref" ? m.doc.getObject(entry.num) : entry;
        // Direct dicts and refs both resolve; a shared dict (two pages
        // referencing one annotation) is counted only where /M still lives.
        if (annot && (annot.k === "dict" || annot.k === "stream")) {
          if (annot.m.has("M")) {
            annot.m.delete("M");
            removedAnnotationDates += 1;
          }
        }
      }
    }
  }
  return {
    removedFields,
    removedXmp,
    removedPieceInfo,
    removedPageMetadata,
    removedAnnotationDates,
  };
}

/* ── edit side (change-pdf-doc-info) ──────────────────────────────── */

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
  "Trapped",
]);

const INFO_TEXT_KEYS: Record<string, string> = {
  Title: "Title",
  Author: "Author",
  Subject: "Subject",
  Keywords: "Keywords",
  Creator: "Creator",
  Producer: "Producer",
};

/** UTF-16BE with the FEFF BOM — pdf-lib's PDFHexString.fromText bytes. */
function utf16beBytes(s: string): Uint8Array {
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xfe;
  out[1] = 0xff;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = c >>> 8;
    out[3 + i * 2] = c & 0xff;
  }
  return out;
}

/** pdf-lib's canonical PDF date — literal (D:YYYYMMDDHHmmSSZ), UTC. */
export function pdfDateString(d: Date): Uint8Array {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const text =
    `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return new TextEncoder().encode(text);
}

/** Applies the doc-info form edits (undefined = untouched, "" = remove). */
export function applyDocInfoEdits(m: MetaDoc, edits: DocInfoEdits): void {
  const texts: [string | undefined, string][] = [
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
      const dict = infoDict(m);
      dict?.delete(key); // remove (missing dict → nothing to delete)
    } else {
      // What the user typed is exactly what round-trips (hex UTF-16BE —
      // pdf-lib setKeywords' array-join quirk does NOT apply here).
      ensureInfoDict(m).set(key, hstr(utf16beBytes(value)));
    }
  }

  // Dates: "now" → the canonical D: string; "remove" → drop the Info
  // entry; "keep" → untouched.
  if (edits.creationMode === "now") {
    ensureInfoDict(m).set("CreationDate", lstr(pdfDateString(new Date())));
  } else if (edits.creationMode === "remove") {
    infoDict(m)?.delete("CreationDate");
  }

  if (edits.modMode === "now") {
    ensureInfoDict(m).set("ModDate", lstr(pdfDateString(new Date())));
  } else if (edits.modMode === "remove") {
    infoDict(m)?.delete("ModDate");
  }

  // Custom entries ("Remove all metadata" removes these too).
  if (edits.stripCustom) {
    const dict = infoDict(m);
    if (dict) {
      for (const key of [...dict.keys()]) {
        if (!KNOWN_INFO_KEYS.has(key)) dict.delete(key);
      }
    }
  }

  if (edits.stripXmp) stripXmpBlock(m);
  dropEmptyInfo(m);
}
