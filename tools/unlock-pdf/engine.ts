import type { OptionValues } from "@/lib/tools/config-types";

import { sanitizeBase } from "../lock-pdf/engine";

/**
 * Unlock PDF — pure engine (PRD §7.6/§8.3: "remove a password you know, or
 * owner restrictions — no cracking").
 *
 * Zero runtime imports except the lock sibling's pure helpers — no
 * @cantoo/pdf-lib here (that stays worker-only, see worker.ts) — so the
 * interactive surface can share this module on the main thread and the
 * smoke script can verify every decision headlessly in bun.
 *
 * The option contract (what the surface writes via onChange and the worker
 * reads from request.options):
 *   mode      "password" | "restrictions"
 *   password  string     (password mode only — the open or owner password)
 */

export const UNLOCK_IDS = {
  mode: "mode",
  password: "password",
} as const;

export type UnlockMode = "password" | "restrictions";

/**
 * Normalize the surface options. An unknown or missing mode falls back to
 * the restrictions mode — the honest default that never pretends to know a
 * password (runs can arrive from chains/APIs without the surface, and a
 * real open password there reports "this file needs its password first").
 */
export function resolveUnlockOptions(
  options: OptionValues
): { mode: UnlockMode; password: string } {
  const mode: UnlockMode =
    options[UNLOCK_IDS.mode] === "password" ? "password" : "restrictions";
  const raw = options[UNLOCK_IDS.password];
  return { mode, password: typeof raw === "string" ? raw : "" };
}

/* ------------------------------------------------------------------ */
/* The not-encrypted decision rule (smoke-pinned)                      */
/* ------------------------------------------------------------------ */

/**
 * THE rule for "nothing to unlock", isolated for tests.
 *
 * @cantoo/pdf-lib only reports `isEncrypted === true` on a load that did
 * NOT decrypt: a password load decrypts into a fresh context and the
 * PDFDocument constructor already deletes the trailer /Encrypt there, so
 * it ALWAYS reports false — a with-password load can never answer this
 * question (and a plain `load(bytes)` throws EncryptedPDFError for every
 * encrypted file instead). The probe therefore loads WITHOUT a password
 * but WITH `ignoreEncryption: true`: that parse never decrypts, never
 * throws for encryption, and reports:
 *
 *   isEncrypted === false → no /Encrypt dictionary → nothing to unlock
 *   isEncrypted === true  → protected (open password and/or owner
 *                           restrictions) → continue with the mode
 *
 * A parse failure during the probe is corruption — the worker maps it to
 * tool.errorCorrupt via classifyUnlockError.
 */
export function isNothingToUnlock(probeIsEncrypted: boolean): boolean {
  return !probeIsEncrypted;
}

/* ------------------------------------------------------------------ */
/* Naming + result summary                                            */
/* ------------------------------------------------------------------ */

/** Output download name: "<base>-unlocked.pdf" (pdf-to-images rule). */
export function unlockOutputName(fileName: string): string {
  return `${sanitizeBase(fileName)}-unlocked.pdf`;
}

/** Run summary for the result view (PRD §8.1: "1 file, 3 pages"). */
export function unlockResultDetail(pageCount: number): {
  files: number;
  pages: number;
} {
  return { files: 1, pages: pageCount };
}

/* ------------------------------------------------------------------ */
/* Error classification                                                */
/* ------------------------------------------------------------------ */

/**
 * Map a thrown @cantoo/pdf-lib error message to the run error code the
 * shell toast translates:
 *
 *   /password/i    → "Password incorrect" (wrong password, password mode)
 *                    or "NEEDS PASSWORD" (the restrictions-mode open with
 *                    the empty user password hit a real open password) —
 *                    the mode decides which honest copy the user sees.
 *   parse family   → corrupt input. Every cantoo parse failure is a
 *                    PDFParsingError ("Failed to parse PDF document …",
 *                    "No PDF header found", "Parser stalled", …).
 *   anything else  → generic (exotic /Encrypt dictionaries, writer
 *                    failures on otherwise-parsable files).
 */
export function classifyUnlockError(
  mode: UnlockMode,
  message: string
): string {
  if (/password/i.test(message)) {
    return mode === "password"
      ? "unlock.errWrongPassword"
      : "unlock.errPasswordRequired";
  }
  if (/failed to parse|no pdf header/i.test(message)) {
    return "tool.errorCorrupt";
  }
  return "tool.errorGeneric";
}

/* ------------------------------------------------------------------ */
/* Surface CTA gating                                                  */
/* ------------------------------------------------------------------ */

/**
 * What the on-device pdf.js probe + mode + password state mean for the
 * sticky CTA. Pure — the smoke pins it next to the worker's own rules.
 *
 *   "unknown"     still scanning — brief block with the reading reason
 *   "error"       the scanner could not read the file — NOT blocked: the
 *                 worker is the authority and reports its own precise
 *                 error when the user runs
 *   "plain"       nothing to remove (the worker refuses too)
 *   "locked" / "restricted" → blocked only in password mode until a
 *                 password is typed
 */
export function unlockBlockedKey(
  probeKind: "unknown" | "locked" | "restricted" | "plain" | "error",
  mode: UnlockMode,
  password: string
): string | null {
  if (probeKind === "unknown") return "unlock.ctaReading";
  if (probeKind === "plain") return "unlock.ctaNotEncrypted";
  if (probeKind === "error") return null;
  if (mode === "password" && password === "") return "unlock.ctaNeedPassword";
  return null;
}
