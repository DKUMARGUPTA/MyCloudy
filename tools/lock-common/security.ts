/**
 * Lock / Unlock PDF shared engine (PRD §8.4):
 *
 *   Lock PDF:   "Open password (strength meter, show/hide, generate
 *               button), Owner password, permissions (print, copy, edit,
 *               annotate, fill forms, accessibility), encryption AES-256
 *               (default) / AES-128."  Validation: "Password min 6
 *               characters (recommend 12+); confirm field; warns
 *               'Password bhool gaye to recover nahi hoga'."
 *
 *   Unlock PDF: "1) Open password maloom hai: enter and remove. 2) Owner
 *               restrictions hatana jab PDF bina open-password khulta ho."
 *               Policy: unknown-password cracking is NOT offered.
 *
 * Engine built on @cantoo/pdf-lib (pdf-lib fork with AES-256/V5/R6
 * encryption; MIT; actively maintained). Everything below runs inside
 * the tool workers — bytes in, bytes out, zero network.
 *
 * UNLOCK INSIGHT (prototype-verified, pin this): a naive
 * load(password)+save() keeps the ORIGINAL xref stream object in the
 * serialized output, so stale "/Encrypt N 0 R" trailer entries survive —
 * plain pdf-lib (and therefore most of our own chained tools) then
 * rejects the "unlocked" file as still-encrypted. The fix is the redact
 * rebuild pattern: fresh PDFDocument + copyPages + manual AcroForm/Info
 * copy via PDFObjectCopier. A fresh context writes its own trailer, so
 * nothing from the encryption world can leak.
 */

import {
  PDFDocument,
  PDFName,
  PDFObjectCopier,
  type SecurityOptions,
} from "@cantoo/pdf-lib";

/* ------------------------------------------------------------------ */
/* Option ids (values ride the shared options state; the surface owns  */
/* every key — the schema stays empty, split-tool pattern)             */
/* ------------------------------------------------------------------ */

export const LOCK_IDS = {
  userPw: "lock.userPw",
  ownerPw: "lock.ownerPw",
  alg: "lock.alg",
  print: "lock.print",
  copy: "lock.copy",
  modify: "lock.modify",
  annotate: "lock.annotate",
  forms: "lock.forms",
  access: "lock.access",
} as const;

export const UNLOCK_IDS = {
  pw: "unlock.pw",
  /** JSON of the standard Info fields read via pdf.js (see UnlockMeta). */
  meta: "unlock.meta",
} as const;

/** Standard Info fields worth preserving across an unlock (read via pdf.js). */
export interface UnlockMeta {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
}

/** Parse the JSON option back into an UnlockMeta (defensive). */
export function parseUnlockMeta(raw: unknown): UnlockMeta | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<UnlockMeta>;
    const out: UnlockMeta = {};
    for (const key of ["title", "author", "subject", "keywords", "creator", "producer"] as const) {
      const v = parsed[key];
      if (typeof v === "string" && v.length > 0) out[key] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Errors (thrown as coded payloads; the workers map them to i18n keys) */
/* ------------------------------------------------------------------ */

export type SecurityErrorCode =
  | "tool.errorAlreadyEncrypted"
  | "tool.errorWrongPassword"
  | "tool.errorNotEncrypted"
  | "tool.errorPwTooShort"
  | "tool.errorNoPassword";

export class SecurityError extends Error {
  readonly code: SecurityErrorCode;
  constructor(code: SecurityErrorCode) {
    super(code);
    this.name = "SecurityError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Lock                                                                */
/* ------------------------------------------------------------------ */

export interface LockRequest {
  /** Open (user) password. 6..1024 chars (PRD: min 6). */
  userPw: string;
  /** Owner password. Falls back to the user password when empty. */
  ownerPw: string;
  /** "aes256" (default) | "aes128" (older readers). */
  alg: "aes256" | "aes128";
  permissions: {
    printing: boolean;
    copying: boolean;
    modifying: boolean;
    annotating: boolean;
    fillingForms: boolean;
    contentAccessibility: boolean;
  };
}

/**
 * PRD validation: min 6 chars when an open password IS set. An empty
 * open password is legal — it means an owner-only restrictions lock
 * (the unlock tool's mode 2 counterpart; the surface still requires a
 * password for the primary flow, the engine stays honest about both).
 */
export function validateLockPw(userPw: string): void {
  if (userPw.length > 0 && userPw.length < 6) {
    throw new SecurityError("tool.errorPwTooShort");
  }
}

/**
 * Encrypt the file. Throws SecurityError("tool.errorAlreadyEncrypted")
 * when the input is locked already (unlock first — honest copy).
 */
export async function lockPdf(
  bytes: Uint8Array,
  req: LockRequest
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  validateLockPw(req.userPw);
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/encrypt/i.test(message)) {
      throw new SecurityError("tool.errorAlreadyEncrypted");
    }
    throw error;
  }
  const pageCount = doc.getPageCount();
  const options: SecurityOptions = {
    userPassword: req.userPw,
    ownerPassword: req.ownerPw.length > 0 ? req.ownerPw : req.userPw,
    algorithm: req.alg === "aes128" ? "AES-128" : "AES-256",
    permissions: toUserPermissions(req.permissions),
  };
  await doc.encrypt(options);
  const saved = await doc.save();
  return { bytes: saved, pageCount };
}

/** UserPermissions shape (the @cantoo type isn't re-exported — structural). */
interface PermSet {
  printing: boolean | "lowResolution" | "highResolution";
  copying: boolean;
  modifying: boolean;
  annotating: boolean;
  fillingForms: boolean;
  contentAccessibility: boolean;
  documentAssembly: boolean;
}

function toUserPermissions(p: LockRequest["permissions"]): PermSet {
  return {
    printing: p.printing ? "highResolution" : false,
    copying: p.copying,
    modifying: p.modifying,
    annotating: p.annotating,
    fillingForms: p.fillingForms,
    contentAccessibility: p.contentAccessibility,
    documentAssembly: false,
  };
}

/* ------------------------------------------------------------------ */
/* Unlock                                                              */
/* ------------------------------------------------------------------ */

/**
 * Remove encryption: rebuild the document into a FRESH context
 * (copyPages + AcroForm copy; page streams parse cleanly through
 * @cantoo). Throws
 *   SecurityError("tool.errorNotEncrypted") — nothing to remove,
 *   SecurityError("tool.errorWrongPassword") — password wrong/missing.
 *
 * INFO INSIGHT (prototype-verified, pin this): @cantoo's re-parse of an
 * encrypted file returns GARBAGE for the trailer Info strings (the file
 * itself is fine — pdf.js reads Title/Author perfectly). So Info is NOT
 * copied from the parsed doc; the caller passes `meta` read via pdf.js on
 * the main thread and we re-apply it with fresh setters instead. Custom
 * keys are dropped (honest scope — the standard six survive).
 */
export async function unlockPdf(
  bytes: Uint8Array,
  password: string,
  meta: UnlockMeta | null = null
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  // 1. Is it encrypted at all?
  try {
    await PDFDocument.load(bytes, { updateMetadata: false });
    throw new SecurityError("tool.errorNotEncrypted");
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (!/encrypt/i.test(message)) throw error;
    // EncryptedPDFError — fall through to the password attempt.
  }

  // 2. Open it with the user's password ("" works for owner-only files).
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(bytes, {
      password,
      updateMetadata: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password/i.test(message)) {
      throw new SecurityError("tool.errorWrongPassword");
    }
    throw error;
  }

  // 3. Rebuild into a fresh context — the whole point (see header note).
  const fresh = await PDFDocument.create();
  const pages = await fresh.copyPages(src, src.getPageIndices());
  for (const page of pages) fresh.addPage(page);
  const copier = PDFObjectCopier.for(src.context, fresh.context);
  const acroForm = src.catalog.get(PDFName.of("AcroForm"));
  if (acroForm) {
    fresh.catalog.set(PDFName.of("AcroForm"), copier.copy(acroForm));
  }
  // Info: re-applied from the pdf.js-read snapshot, never from the
  // tainted @cantoo parse (see header note).
  if (meta) {
    if (meta.title !== undefined) fresh.setTitle(meta.title);
    if (meta.author !== undefined) fresh.setAuthor(meta.author);
    if (meta.subject !== undefined) fresh.setSubject(meta.subject);
    if (meta.keywords !== undefined) fresh.setKeywords(meta.keywords.split(",").map((s) => s.trim()).filter(Boolean));
    if (meta.creator !== undefined) fresh.setCreator(meta.creator);
    if (meta.producer !== undefined) fresh.setProducer(meta.producer);
  }
  const saved = await fresh.save();
  return { bytes: saved, pageCount: pages.length };
}

/* ------------------------------------------------------------------ */
/* Post-save verification (both tools run it before reporting success) */
/* ------------------------------------------------------------------ */

/**
 * Lock verify: the saved file must open with the password — and NOT
 * open without it (when there is one).
 */
export async function verifyLocked(
  bytes: Uint8Array,
  userPw: string
): Promise<void> {
  await PDFDocument.load(bytes, { password: userPw, updateMetadata: false });
  if (userPw.length > 0) {
    try {
      await PDFDocument.load(bytes, { updateMetadata: false });
      throw new SecurityError("tool.errorAlreadyEncrypted");
    } catch (error) {
      if (error instanceof SecurityError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/encrypt/i.test(message)) throw error;
      // EncryptedPDFError without the password — exactly what we want.
    }
  }
}

/**
 * Unlock verify: the rebuilt output must carry no /Encrypt in its TRAILER
 * (structural parse, the FIX-1b ocr-pdf probe pattern) + plain reopens.
 *
 * Why structural: the old raw-bytes `text.includes("/Encrypt")` scan
 * false-positives when a document's TEXT literally contains "/Encrypt
 * 26 0 R" (this project's own docs do) — a perfectly unlocked file was
 * wrongly reported as still-encrypted. The parse reads the actual trailer
 * (`context.trailerInfo.Encrypt` via `isEncrypted`); only when pdf-lib
 * cannot parse the bytes at all do we fall back to the raw substring
 * scan, and the plain reload below stays the final authority either way.
 */
export async function verifyUnlocked(bytes: Uint8Array): Promise<void> {
  let structural: boolean | null = null;
  try {
    const probe = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    structural = probe.isEncrypted;
  } catch {
    structural = null; // unparseable — fall back to the raw scan below
  }
  if (structural === null) {
    const text = new TextDecoder("latin1").decode(bytes);
    if (text.includes("/Encrypt")) {
      throw new SecurityError("tool.errorAlreadyEncrypted");
    }
  } else if (structural) {
    throw new SecurityError("tool.errorAlreadyEncrypted");
  }
  await PDFDocument.load(bytes, { updateMetadata: false });
}

/* ------------------------------------------------------------------ */
/* Strength meter for TYPED passwords (lock surface)                   */
/* ------------------------------------------------------------------ */

const POOL_UPPER = 26;
const POOL_LOWER = 26;
const POOL_DIGITS = 10;
const POOL_SYMBOLS = 33;
const COMMON_PASSWORDS = [
  "password", "123456", "qwerty", "letmein", "welcome", "admin",
  "iloveyou", "monkey", "dragon", "sunshine", "princess", "football",
  "abc123", "111111", "access", "master", "hello", "freedom", "india",
  "passw0rd", "p@ssword", "123123", "654321", "superman", "trustno1",
];

/**
 * Charset-based entropy estimate for a typed password — the same math
 * password managers use for arbitrary input (no dictionary powers, but
 * a common-password penalty keeps it honest). Documented approximation:
 * real strength depends on how the password was CHOSEN; this estimates
 * how hard it is for an attacker who knows nothing about you.
 */
export function estimateTypedBits(pw: string): number {
  if (!pw) return 0;
  let pool = 0;
  if (/[A-Z]/.test(pw)) pool += POOL_UPPER;
  if (/[a-z]/.test(pw)) pool += POOL_LOWER;
  if (/[0-9]/.test(pw)) pool += POOL_DIGITS;
  if (/[^A-Za-z0-9]/.test(pw)) pool += POOL_SYMBOLS;
  let bits = pw.length * Math.log2(Math.max(2, pool));
  const lower = pw.toLowerCase();
  if (COMMON_PASSWORDS.some((common) => lower === common)) {
    bits = Math.min(bits, 8);
  } else if (COMMON_PASSWORDS.some((common) => lower.includes(common))) {
    bits *= 0.55;
  } else if (/^(.)\1+$/.test(pw)) {
    bits = Math.min(bits, 6); // aaaaaa
  } else if (/^[0-9]+$/.test(pw)) {
    bits = Math.min(bits, pw.length * Math.log2(10) * 0.6); // pure digits, capped
  }
  return Math.round(bits);
}
