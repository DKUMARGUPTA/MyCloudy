import type { OptionValues } from "@/lib/tools/config-types";

/**
 * Doc info + Remove metadata — shared pure module (PRD §8.2 "Change
 * document information" + §8.3 "Remove metadata"). No React, no pdf-lib
 * imports: the surfaces (pdf.js reads), the panels and the workers
 * (pdf-lib writes) all share these types, option ids and resolvers so what
 * the preview shows is exactly what the worker writes.
 *
 * Field semantics (worker contract):
 *   undefined  → leave the field untouched (option never set)
 *   ""          → REMOVE the field from the Info dict
 *   other string → set the field to that exact text
 */

export const DI_IDS = {
  title: "title",
  author: "author",
  subject: "subject",
  keywords: "keywords",
  creator: "creator",
  producer: "producer",
  creationMode: "creationMode",
  modMode: "modMode",
  stripXmp: "stripXmp",
  stripCustom: "stripCustom",
} as const;

export const RM_IDS = {
  alsoXmp: "alsoXmp",
} as const;

/** The six editable text fields, in display order. */
export const META_TEXT_FIELDS = [
  DI_IDS.title,
  DI_IDS.author,
  DI_IDS.subject,
  DI_IDS.keywords,
  DI_IDS.creator,
  DI_IDS.producer,
] as const;

export type MetaTextField = (typeof META_TEXT_FIELDS)[number];

export type DateMode = "keep" | "now" | "remove";

export const DATE_MODES: readonly DateMode[] = ["keep", "now", "remove"];

/** What pdf.js found in the file (main-thread read, display only). */
export interface DocInfoRead {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  /** Parsed PDF dates; null when the file has none. */
  creationDate: Date | null;
  modificationDate: Date | null;
  /** Custom / non-standard Info entries beside the six known fields. */
  custom: { key: string; value: string }[];
  /** A non-empty XMP /Metadata packet is attached to the catalog. */
  hasXmp: boolean;
}

/** Worker-side resolved edits for change-pdf-doc-info. */
export interface DocInfoEdits {
  title: string | undefined;
  author: string | undefined;
  subject: string | undefined;
  keywords: string | undefined;
  creator: string | undefined;
  producer: string | undefined;
  creationMode: DateMode;
  modMode: DateMode;
  stripXmp: boolean;
  /** Remove custom (non-standard) Info entries beyond the six fields. */
  stripCustom: boolean;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asMode(value: unknown): DateMode {
  return value === "now" || value === "remove" ? value : "keep";
}

export function resolveDocInfoEdits(values: OptionValues): DocInfoEdits {
  return {
    title: asString(values[DI_IDS.title]),
    author: asString(values[DI_IDS.author]),
    subject: asString(values[DI_IDS.subject]),
    keywords: asString(values[DI_IDS.keywords]),
    creator: asString(values[DI_IDS.creator]),
    producer: asString(values[DI_IDS.producer]),
    creationMode: asMode(values[DI_IDS.creationMode]),
    modMode: asMode(values[DI_IDS.modMode]),
    stripXmp: values[DI_IDS.stripXmp] === true,
    stripCustom: values[DI_IDS.stripCustom] === true,
  };
}

/** True when at least one visible thing would change in the output. */
export function docInfoHasChanges(
  edits: DocInfoEdits,
  snapshot: DocInfoRead
): boolean {
  const pairs: [string | undefined, string][] = [
    [edits.title, snapshot.title],
    [edits.author, snapshot.author],
    [edits.subject, snapshot.subject],
    [edits.keywords, snapshot.keywords],
    [edits.creator, snapshot.creator],
    [edits.producer, snapshot.producer],
  ];
  const textChanged = pairs.some(
    ([edit, current]) => edit !== undefined && edit !== current
  );
  return (
    textChanged ||
    edits.creationMode !== "keep" ||
    edits.modMode !== "keep" ||
    (edits.stripXmp && snapshot.hasXmp) ||
    (edits.stripCustom && snapshot.custom.length > 0)
  );
}

/** Localized display for a PDF date ("" when null). */
export function formatMetaDate(date: Date | null, locale: string): string {
  if (date === null) return "";
  try {
    return new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}

/** The value a field will have after applying the edits (for the AFTER column). */
export function afterValue(
  edit: string | undefined,
  current: string
): { value: string; changed: boolean } {
  if (edit === undefined) return { value: current, changed: false };
  return { value: edit, changed: edit !== current };
}
