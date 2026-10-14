import { loadPdfjs, PDF_DOC_PARAMS } from "@/lib/pdf/pdfjs";

/**
 * Unlock PDF classification (PRD §8.3 "Modes"):
 *
 *  1. locked     — the file demands an open password before it opens at all
 *                  (pdf.js rejects with PasswordException NEEDS_PASSWORD).
 *  2. restricted — it OPENS without a password (empty user password) but an
 *                  owner password has limited what the reader may do; the
 *                  permission bits are read and shown honestly.
 *  3. clean      — no encryption at all; nothing to unlock.
 *  4. unreadable — not a parsable PDF.
 *
 * There is deliberately NO fifth mode: DocoPDF never attempts to guess or
 * crack an unknown password (PRD §8.3 policy).
 */

/** Option id carrying the typed password to the worker (surface-owned). */
export const UNLOCK_IDS = {
  password: "unlockPassword",
} as const;

/**
 * pdf.js permission bit VALUES (Permission enum — the /P flag bits 3–12 as
 * powers of two, NOT positions; verified against qpdf's oracle: a file with
 * print-low + accessibility returns [4, 512]).
 */
export const PERM = {
  print: 4, // bit 3: PRINT
  edit: 8, // bit 4: MODIFY_CONTENTS
  copy: 16, // bit 5: COPY
  annotate: 32, // bit 6: MODIFY_ANNOTATIONS
  forms: 256, // bit 9: FILL_INTERACTIVE_FORMS
  access: 512, // bit 10: EXTRACT_FOR_ACCESSIBILITY
  assemble: 1024, // bit 11: ASSEMBLE
  printHq: 2048, // bit 12: PRINT_HIGH_QUALITY
} as const;

export type UnlockClass =
  | { kind: "locked" }
  | { kind: "restricted"; allowed: number[] }
  | { kind: "clean" }
  | { kind: "unreadable" };

function isPasswordException(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "PasswordException"
  );
}

/**
 * Classifies a dropped PDF. Runs on the main thread through the shared
 * self-hosted pdf.js (the same loader every preview uses) — metadata-level
 * reads only, nothing rendered.
 */
export async function classifyPdf(file: File): Promise<UnlockClass> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  try {
    const doc = await pdfjs.getDocument({ data, ...PDF_DOC_PARAMS }).promise;
    let allowed: number[] | null = null;
    try {
      allowed = await doc.getPermissions();
    } catch {
      allowed = null;
    }
    doc.cleanup();
    if (allowed === null) return { kind: "clean" };
    return { kind: "restricted", allowed };
  } catch (error) {
    if (isPasswordException(error)) return { kind: "locked" };
    return { kind: "unreadable" };
  }
}

export type PasswordCheck =
  | { state: "ok"; pageCount: number }
  | { state: "wrong" };

/**
 * Verifies a typed password against the file — the same check the run will
 * do inside the worker, but instant feedback at the input. Returns null
 * while the file shape itself is unknown.
 */
export async function verifyPassword(
  file: File,
  password: string
): Promise<PasswordCheck> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  try {
    const doc = await pdfjs.getDocument({
      data,
      password,
      ...PDF_DOC_PARAMS,
    }).promise;
    const pageCount = doc.numPages;
    doc.cleanup();
    return { state: "ok", pageCount };
  } catch (error) {
    if (isPasswordException(error)) return { state: "wrong" };
    return { state: "wrong" };
  }
}

/** Rows for the restrictions card — true when the bit is ALLOWED. */
export function restrictionRows(allowed: number[]): {
  id: keyof typeof PERM;
  allowed: boolean;
  hqPrint: boolean;
}[] {
  const has = (bit: number) => allowed.includes(bit);
  return [
    { id: "print", allowed: has(PERM.print), hqPrint: has(PERM.printHq) },
    { id: "copy", allowed: has(PERM.copy), hqPrint: false },
    { id: "edit", allowed: has(PERM.edit), hqPrint: false },
    { id: "annotate", allowed: has(PERM.annotate), hqPrint: false },
    { id: "forms", allowed: has(PERM.forms), hqPrint: false },
    { id: "access", allowed: has(PERM.access), hqPrint: false },
    { id: "assemble", allowed: has(PERM.assemble), hqPrint: false },
  ];
}
