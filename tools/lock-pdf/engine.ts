import type { OptionValues } from "@/lib/tools/config-types";

/**
 * Protect PDF (lock-pdf) — pure engine (PRD §7.6/§8.3, phase 4 security).
 *
 * Everything here is plain string/data math with ZERO runtime imports, so the
 * interactive surface can import it on the main thread without dragging
 * @cantoo/pdf-lib into the client bundle (that stays worker-only, see
 * worker.ts), and the smoke script can verify every rule headlessly in bun.
 *
 * The option contract (what the surface writes via onChange and the worker
 * reads from request.options):
 *   openPassword     string   password required to OPEN the pdf (the one to share)
 *   confirmPassword  string   surface-side confirmation gate (worker re-checks length)
 *   ownerPassword   string   optional; "" → cantoo reuses the open password
 *   permPrinting     "highResolution" | "lowResolution" | "notAllowed"
 *   permCopy / permEdit / permAnnotate / permForms / permAccessibility /
 *   permAssemble     boolean permission switches
 *   algorithm        "AES-256" | "AES-128"
 */

/** PRD §8.3: minimum 6 characters, 12+ recommended. */
export const LOCK_MIN_PASSWORD = 6;
export const LOCK_RECOMMENDED_LENGTH = 12;
/** Length of the generated password (Web Crypto, unambiguous alphabet). */
export const GENERATED_PASSWORD_LENGTH = 20;

export const LOCK_IDS = {
  openPassword: "openPassword",
  confirmPassword: "confirmPassword",
  ownerPassword: "ownerPassword",
  printing: "permPrinting",
  copying: "permCopy",
  modifying: "permEdit",
  annotating: "permAnnotate",
  fillingForms: "permForms",
  accessibility: "permAccessibility",
  assembly: "permAssemble",
  algorithm: "algorithm",
} as const;

/**
 * Mirrors @cantoo/pdf-lib's UserPermissions (the library does not root-export
 * the interface, so we restate it structurally — fully assignable both ways).
 */
export interface PdfPermissions {
  printing?: boolean | "lowResolution" | "highResolution";
  modifying?: boolean;
  copying?: boolean;
  annotating?: boolean;
  fillingForms?: boolean;
  contentAccessibility?: boolean;
  documentAssembly?: boolean;
}

export type LockAlgorithm = "AES-256" | "AES-128";

/** Fully resolved worker input (resolveLockParams output). */
export interface LockParams {
  userPassword: string;
  ownerPassword: string;
  algorithm: LockAlgorithm;
  permissions: PdfPermissions;
}

/** Read a string option ("" for anything unset/non-string). */
export function optionString(
  values: OptionValues,
  id: string,
  fallback = ""
): string {
  const raw = values[id];
  return typeof raw === "string" ? raw : fallback;
}

/** Read a boolean option with an explicit fallback for the unset case. */
export function optionBool(
  values: OptionValues,
  id: string,
  fallback: boolean
): boolean {
  const raw = values[id];
  return typeof raw === "boolean" ? raw : fallback;
}

/* ------------------------------------------------------------------ */
/* Password strength heuristic                                         */
/* ------------------------------------------------------------------ */

/** Known-weak passwords: whatever they look like, they are guessed first. */
const COMMON_PASSWORDS = new Set([
  "123456",
  "1234567",
  "12345678",
  "123456789",
  "1234567890",
  "12345",
  "1234",
  "123123",
  "121212",
  "111111",
  "112233",
  "000000",
  "654321",
  "666666",
  "555555",
  "abc123",
  "qwerty",
  "qwerty123",
  "qwertyuiop",
  "password",
  "password1",
  "password123",
  "passw0rd",
  "p@ssword",
  "iloveyou",
  "letmein",
  "welcome",
  "welcome123",
  "monkey",
  "dragon",
  "sunshine",
  "princess",
  "master",
  "lovely",
  "admin",
  "admin123",
  "login",
  "solo",
  "test123",
  "india123",
  "aadhaar123",
]);

/** Keyboard/alphabet runs of 4+ characters (forward or reversed). */
const SEQUENCE_RUNS = [
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789",
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
];

function hasSequentialRun(password: string): boolean {
  const lower = password.toLowerCase();
  for (const run of SEQUENCE_RUNS) {
    for (let i = 0; i + 4 <= run.length; i += 1) {
      const chunk = run.slice(i, i + 4);
      if (
        lower.includes(chunk) ||
        lower.includes([...chunk].reverse().join(""))
      ) {
        return true;
      }
    }
  }
  return false;
}

export interface PasswordStrength {
  /** Estimated brute-force work, in bits of entropy. */
  bits: number;
  /** 0 (weak) … 4 (very strong). */
  score: 0 | 1 | 2 | 3 | 4;
  /** i18n key of the human label for this score. */
  labelKey: string;
}

/**
 * Offline strength estimate: charset-pool entropy (length × log2(pool)) with
 * penalties for repeats, low character variety, keyboard sequences and
 * known-weak passwords. No dictionaries, no network, no deps.
 */
export function passwordStrength(pw: string): PasswordStrength {
  if (pw.length === 0) {
    return { bits: 0, score: 0, labelKey: "lock.strength0" };
  }
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 32;

  let bits = pw.length * Math.log2(Math.max(pool, 2));
  if (/^(.)\1*$/.test(pw)) {
    // Single character repeated ("aaaaaaaa").
    bits *= 0.3;
  } else if (new Set(pw).size <= Math.ceil(pw.length / 2)) {
    // Mostly the same few characters.
    bits *= 0.65;
  }
  if (hasSequentialRun(pw)) bits *= 0.6;
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) bits = Math.min(bits, 10);

  const score: 0 | 1 | 2 | 3 | 4 =
    bits >= 100 ? 4 : bits >= 75 ? 3 : bits >= 50 ? 2 : bits >= 30 ? 1 : 0;
  return { bits: Math.round(bits), score, labelKey: `lock.strength${score}` };
}

/* ------------------------------------------------------------------ */
/* Validation (surface gate + worker guard share these codes)           */
/* ------------------------------------------------------------------ */

/**
 * Validate the surface password triple. Returns the i18n error key to show
 * (inline + as the run-block reason), or null when everything is fine.
 */
export function validatePasswords(
  open: string,
  confirm: string,
  owner: string
): string | null {
  if (open.length === 0) return "lock.errNeedOpen";
  if (open.length < LOCK_MIN_PASSWORD) return "lock.errShort";
  if (confirm !== open) return "lock.errMismatch";
  if (owner.length > 0 && owner.length < LOCK_MIN_PASSWORD) {
    return "lock.errOwnerShort";
  }
  return null;
}

/**
 * AES-128 (security handler revision ≤ 4) pads passwords to Latin-1 bytes,
 * so characters above U+00FF cannot be encoded. AES-256 hashes the UTF-8
 * bytes, so Hindi/Devanagari passwords work there (and only there).
 */
export function latinSafePasswords(open: string, owner: string): boolean {
  const latinOk = (value: string): boolean => {
    for (let i = 0; i < value.length; i += 1) {
      if (value.charCodeAt(i) > 0xff) return false;
    }
    return true;
  };
  return latinOk(open) && latinOk(owner);
}

/* ------------------------------------------------------------------ */
/* Password generator                                                  */
/* ------------------------------------------------------------------ */

/**
 * Exactly 64 unambiguous characters (no l/I/O/0/1/…), so each character maps
 * to 6 whole random bits — no modulo bias, no look-alike confusion.
 */
export const PASSWORD_ALPHABET =
  "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^*";

/**
 * Cryptographically random password from the unambiguous alphabet.
 * `randomBytes` is injectable so tests are deterministic; by default it is
 * filled with Web Crypto (available in window, worker and bun contexts).
 */
export function generatePassword(
  length = GENERATED_PASSWORD_LENGTH,
  randomBytes?: Uint8Array
): string {
  const bytes =
    randomBytes ??
    crypto.getRandomValues(new Uint8Array(Math.max(1, length)));
  let out = "";
  const count = Math.min(length, bytes.length);
  for (let i = 0; i < count; i += 1) {
    out += PASSWORD_ALPHABET[bytes[i] & 63];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Option resolution                                                   */
/* ------------------------------------------------------------------ */

/** Surface defaults per PRD §8.3: printing high, copy + accessibility on. */
export function permissionsFromValues(values: OptionValues): PdfPermissions {
  const printing = optionString(values, LOCK_IDS.printing, "highResolution");
  return {
    printing:
      printing === "highResolution" || printing === "lowResolution"
        ? printing
        : false,
    copying: optionBool(values, LOCK_IDS.copying, true),
    modifying: optionBool(values, LOCK_IDS.modifying, false),
    annotating: optionBool(values, LOCK_IDS.annotating, false),
    fillingForms: optionBool(values, LOCK_IDS.fillingForms, false),
    contentAccessibility: optionBool(values, LOCK_IDS.accessibility, true),
    documentAssembly: optionBool(values, LOCK_IDS.assembly, false),
  };
}

export function algorithmFromValues(values: OptionValues): LockAlgorithm {
  return optionString(values, LOCK_IDS.algorithm, "AES-256") === "AES-128"
    ? "AES-128"
    : "AES-256";
}

export function resolveLockParams(options: OptionValues): LockParams {
  return {
    userPassword: optionString(options, LOCK_IDS.openPassword),
    ownerPassword: optionString(options, LOCK_IDS.ownerPassword),
    algorithm: algorithmFromValues(options),
    permissions: permissionsFromValues(options),
  };
}

/* ------------------------------------------------------------------ */
/* Output naming + error classification                                */
/* ------------------------------------------------------------------ */

/** Sanitize a filename down to its base (pdf-to-images worker rule). */
export function sanitizeBase(name: string): string {
  return (
    name
      .replace(/\.pdf$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .trim()
      .slice(0, 120) || "document"
  );
}

/**
 * Map a thrown error message from the lock pipeline to the run error code
 * the shell toast translates. Encrypted input and non-Latin AES-128
 * passwords are expected user situations; anything else is corruption.
 */
export function classifyLockError(message: string): string {
  if (/is encrypted/i.test(message)) return "lock.errAlreadyEncrypted";
  if (/password/i.test(message)) return "lock.errPasswordChars";
  return "tool.errorCorrupt";
}
