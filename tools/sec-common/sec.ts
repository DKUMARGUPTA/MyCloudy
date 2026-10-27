/**
 * Shared security-tool model (Protect PDF / Unlock PDF, PRD §7.6).
 *
 * Pure data + math only — no DOM, no React, no worker imports — so scripts
 * can smoke-test everything (split-tool pattern). The encryption itself
 * lives in each tool's worker via @cantoo/pdf-lib (the pdf-lib fork with
 * AES-256 support); stock pdf-lib can neither create nor open encrypted
 * files, and the two packages must never be mixed in one module graph
 * (instanceof + parse contexts differ — P3.15 lesson, see worklog).
 */

/* ------------------------------------------------------------------ */
/* Option ids (panel ↔ worker contract)                                */
/* ------------------------------------------------------------------ */

export const LOCK_IDS = {
  password: "lockPassword",
  confirm: "lockConfirm",
  ownerPassword: "lockOwnerPassword",
  /** "high" (full quality) · "low" (low resolution) · "none". */
  printQuality: "lockPrintQuality",
  copy: "lockPermCopy",
  modify: "lockPermModify",
  annotate: "lockPermAnnotate",
  forms: "lockPermForms",
  assemble: "lockPermAssemble",
} as const;

export const UNLOCK_IDS = {
  password: "unlockPassword",
} as const;

/* ------------------------------------------------------------------ */
/* Typed-password strength (typed, not generated)                      */
/* ------------------------------------------------------------------ */

const CLASSES: [RegExp, number][] = [
  [/[a-z]/, 26],
  [/[A-Z]/, 26],
  [/[0-9]/, 10],
  [/[^a-zA-Z0-9\s]/, 33], // common printable symbols (pessimistic pool)
];

/**
 * Shannon-style entropy estimate for a password the user TYPED (the
 * generator has its own exact math in generate-password/engine). Pool =
 * union of the character classes actually present, so "aaaaaaaa" scores
 * low not because of repetition heuristics but because its pool is 26 ×
 * its short length — honest enough without pretending to know the picker.
 */
export function typedPasswordBits(password: string): number {
  if (!password) return 0;
  let pool = 0;
  for (const [re, size] of CLASSES) if (re.test(password)) pool += size;
  if (/\s/.test(password)) pool += 1; // whitespace adds (a little) real pool
  if (pool === 0) pool = 1;
  return Math.round(password.length * Math.log2(pool));
}

/* ------------------------------------------------------------------ */
/* Lock defaults                                                       */
/* ------------------------------------------------------------------ */

/**
 * Sharing-friendly defaults (PRD §7.6): recipients may print and copy
 * text and fill forms, but not remix the document. Accessibility stays
 * on unconditionally (see worker: we never disable it).
 */
export const LOCK_DEFAULTS = {
  printQuality: "high" as "high" | "low" | "none",
  copy: true,
  modify: false,
  annotate: false,
  forms: true,
  assemble: false,
} as const;

/** Map panel values to the fork's UserPermissions shape. */
export function toUserPermissions(values: {
  printQuality: "high" | "low" | "none";
  copy: boolean;
  modify: boolean;
  annotate: boolean;
  forms: boolean;
  assemble: boolean;
}): {
  printing: boolean | "lowResolution" | "highResolution";
  copying: boolean;
  modifying: boolean;
  annotating: boolean;
  fillingForms: boolean;
  contentAccessibility: true;
  documentAssembly: boolean;
} {
  return {
    printing:
      values.printQuality === "high"
        ? "highResolution"
        : values.printQuality === "low"
          ? "lowResolution"
          : false,
    copying: values.copy,
    modifying: values.modify,
    annotating: values.annotate,
    fillingForms: values.forms,
    // Never trade screen-reader access for "protection" — a PDF that
    // blinds assistive tech is both hostile and, in several
    // jurisdictions, unlawful to publish.
    contentAccessibility: true,
    documentAssembly: values.assemble,
  };
}
