/**
 * Lock / Unlock PDF shared engine (PRD §8.4) — OWN-ENGINE PORT (P6-w-b).
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
 * Runs on our own PDF engine (src/lib/own/pdf/security.ts — the standard
 * security handler: AES-256 V5/R6 + AES-128 V4/R4 writer, V1-R6 reader).
 * Everything runs inside the tool workers — bytes in, bytes out, zero
 * network. The @cantoo/pdf-lib reload paths in scripts/smoke-lock.ts are
 * the ORACLE only (devDependency).
 *
 * UNLOCK INSIGHT (still true, cheaper now): a re-encrypt-in-place of a
 * loaded doc can never fully shake the encryption world, but a whole-
 * document REWRITE through rewriteDocument writes its own trailer and
 * xref — feeding it the decrypted replacement table + deleting the
 * /Encrypt object rebuilds a structurally clean file. Custom Info keys
 * now survive straight from OUR OWN decryption (no more two-parse
 * recovery dance) — the audit R3-b semantics are kept exactly: the six
 * editable standards come from `meta` when supplied, CreationDate/
 * ModDate/Trapped stay dropped, everything non-standard rides through.
 */

import {
  encryptDocument,
  listPages,
  openEncrypted,
  pdfInfoText,
  PdfError,
  parsePdf,
  ref,
  rewriteDocument,
} from "@/lib/own/pdf";
import type { PdfObj } from "@/lib/own/pdf";

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

/** Info keys that never ride through an unlock (pinned R3-b policy). */
const DROP_INFO_KEYS = new Set(["CreationDate", "ModDate", "Trapped"]);

/** The six editable fields → Info dict keys. */
const EDITABLE_FIELDS: Array<[keyof UnlockMeta, string]> = [
  ["title", "Title"],
  ["author", "Author"],
  ["subject", "Subject"],
  ["keywords", "Keywords"],
  ["creator", "Creator"],
  ["producer", "Producer"],
];

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
  let doc: ReturnType<typeof parsePdf>;
  try {
    doc = parsePdf(bytes);
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new SecurityError("tool.errorAlreadyEncrypted");
    }
    throw error;
  }
  const pageCount = listPages(doc).length;
  const saved = encryptDocument(doc, {
    userPassword: req.userPw,
    ownerPassword: req.ownerPw.length > 0 ? req.ownerPw : req.userPw,
    algorithm: req.alg === "aes128" ? "AES-128" : "AES-256",
    permissions: {
      printing: req.permissions.printing ? "highResolution" : false,
      copying: req.permissions.copying,
      modifying: req.permissions.modifying,
      annotating: req.permissions.annotating,
      fillingForms: req.permissions.fillingForms,
      contentAccessibility: req.permissions.contentAccessibility,
      documentAssembly: false,
    },
  });
  return { bytes: saved, pageCount };
}

/* ------------------------------------------------------------------ */
/* Unlock                                                              */
/* ------------------------------------------------------------------ */

/**
 * Remove encryption: open with the password, decrypt every object, and
 * rebuild through rewriteDocument with the /Encrypt object deleted (the
 * whole-document rewrite writes its own trailer — nothing from the
 * encryption world can leak). Throws
 *   SecurityError("tool.errorNotEncrypted") — nothing to remove,
 *   SecurityError("tool.errorWrongPassword") — password wrong/missing.
 *
 * INFO POLICY (audit R3-b, unchanged semantics): the six editable
 * standard fields come from the pdf.js `meta` snapshot when supplied,
 * else from our own decryption; CreationDate/ModDate/Trapped stay
 * dropped; every non-standard key rides through from the decrypted
 * Info — custom workflows (IRP numbers, PDF/X stamps) survive.
 */
export async function unlockPdf(
  bytes: Uint8Array,
  password: string,
  meta: UnlockMeta | null = null
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  // 1. Is it encrypted at all? (a plain parse succeeding = nothing to do)
  try {
    parsePdf(bytes);
    throw new SecurityError("tool.errorNotEncrypted");
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    if (error instanceof PdfError && error.code === "encrypted") {
      // Encrypted — fall through to the password attempt.
    } else {
      throw error; // corrupt/unsupported — honest passthrough
    }
  }

  // 2. Open it with the user's password ("" works for owner-only files).
  const opened = openEncrypted(bytes, password);
  if (opened.kind === "wrong-password") {
    throw new SecurityError("tool.errorWrongPassword");
  }
  if (opened.kind === "not-encrypted") {
    throw new SecurityError("tool.errorNotEncrypted");
  }
  const { doc, replacements, pageCount, encryptNum, infoNum, nextFreeNum } =
    opened.opened;

  // 3. Info surgery on the decrypted dict (the pinned R3-b semantics).
  const extras: Array<{ num: number; obj: PdfObj }> = [];
  let authoredInfoNum = -1;
  if (infoNum !== null && replacements.has(infoNum)) {
    const infoObj = replacements.get(infoNum)!;
    if (infoObj.k === "dict" || infoObj.k === "stream") {
      const rebuilt = new Map<string, PdfObj>();
      for (const [key, value] of infoObj.m) {
        if (DROP_INFO_KEYS.has(key)) {
          continue; // timestamps/layout state — pinned drop
        }
        const field = EDITABLE_FIELDS.find((f) => f[1] === key);
        if (field !== undefined && meta !== null) {
          const v = meta[field[0]];
          if (v !== undefined) {
            rebuilt.set(key, key === "Keywords" ? keywordsObj(v) : pdfInfoText(v));
          }
          // absent from meta → dropped (the old fresh-setter parity)
        } else {
          rebuilt.set(key, value); // customs + decrypted standards (meta null)
        }
      }
      if (meta !== null) {
        for (const [field, key] of EDITABLE_FIELDS) {
          if (rebuilt.has(key)) continue;
          const v = meta[field];
          if (v !== undefined) {
            rebuilt.set(key, key === "Keywords" ? keywordsObj(v) : pdfInfoText(v));
          }
        }
      }
      replacements.set(infoNum, { k: "dict", m: rebuilt });
    }
  } else if (meta !== null) {
    // No Info object in the source — author a fresh one (pdf-lib's
    // fresh.setTitle parity) above every existing number.
    const m = new Map<string, PdfObj>();
    for (const [field, key] of EDITABLE_FIELDS) {
      const v = meta[field];
      if (v !== undefined) m.set(key, key === "Keywords" ? keywordsObj(v) : pdfInfoText(v));
    }
    if (m.size > 0) {
      authoredInfoNum = nextFreeNum;
      extras.push({ num: authoredInfoNum, obj: { k: "dict", m } });
      doc.trailer.set("Info", ref(authoredInfoNum));
    }
  }

  // 4. Whole-document rewrite — fresh trailer + xref, /Encrypt deleted.
  const saved = rewriteDocument(doc, {
    replacements,
    deletions: new Set<number>([encryptNum]),
    extraObjects: extras.length > 0 ? extras : undefined,
  });
  return { bytes: saved, pageCount };
}

/** pdf-lib setKeywords parity: comma-split into literal strings. */
function keywordsObj(v: string): PdfObj {
  const items = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i += 1) b[i] = s.charCodeAt(i) & 0xff;
      return { k: "lstr" as const, b };
    });
  return { k: "arr", items };
}

/* ------------------------------------------------------------------ */
/* Post-save verification (both tools run it before reporting success) */
/* ------------------------------------------------------------------ */

/**
 * Lock verify: the saved file must open with the password — and NOT
 * open without it (when there is one). Runs the FULL own-engine crypto
 * round-trip (parse + password validation + decrypt walk).
 */
export async function verifyLocked(
  bytes: Uint8Array,
  userPw: string
): Promise<void> {
  const opened = openEncrypted(bytes, userPw);
  if (opened.kind === "wrong-password") {
    throw new SecurityError("tool.errorWrongPassword");
  }
  if (opened.kind === "not-encrypted") {
    throw new SecurityError("tool.errorAlreadyEncrypted");
  }
  if (userPw.length > 0) {
    const noPw = openEncrypted(bytes, "");
    if (noPw.kind === "ok") {
      throw new SecurityError("tool.errorAlreadyEncrypted");
    }
  }
}

/**
 * Unlock verify: the rebuilt output must carry no /Encrypt in its TRAILER
 * (structural parse — the parser refuses encrypted input) + plain
 * reopens.
 *
 * Why structural: a raw-bytes `text.includes("/Encrypt")` scan
 * false-positives when a document's TEXT literally contains "/Encrypt
 * 26 0 R" (this project's own docs do) — a perfectly unlocked file was
 * wrongly reported as still-encrypted. The parse reads the actual
 * trailer; only when the bytes are unparseable at all do we fall back
 * to the raw substring scan, and the structural refusal stays the
 * final authority either way.
 */
export async function verifyUnlocked(bytes: Uint8Array): Promise<void> {
  try {
    parsePdf(bytes);
    return; // clean plain parse — nothing encrypted anywhere
  } catch (error) {
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new SecurityError("tool.errorAlreadyEncrypted");
    }
    // Unparseable — the pinned raw-substring fallback before failing.
    const text = new TextDecoder("latin1").decode(bytes);
    if (text.includes("/Encrypt")) {
      throw new SecurityError("tool.errorAlreadyEncrypted");
    }
    throw error; // genuinely corrupt — the honest parse error
  }
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
