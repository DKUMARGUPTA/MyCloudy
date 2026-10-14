import type { OptionValues } from "@/lib/tools/config-types";

/**
 * Protect PDF option model (PRD §8.3).
 *
 * Split-tool pattern: the schema carries no fields — the interactive surface
 * owns every value and the worker consumes them defensively through
 * `buildEncryptOptions`. Pure and bun-testable (scripts/smoke-lock.ts).
 *
 * Option ids are prefixed `lock*` so they can never collide with the
 * shared schema ids of other tools if a config ever mixes both.
 */

export const LOCK_IDS = {
  /** Open password (what recipients type to open the file). */
  password: "lockPassword",
  /** Owner password (optional master key — can lift restrictions later). */
  owner: "lockOwner",
  /** Cipher: "aes256" (default) | "aes128" (older readers). */
  algorithm: "lockAlgorithm",
  /** Printing: "full" | "low" | "off". */
  print: "lockPrint",
  /** Copy/extract text and images. */
  copy: "lockCopy",
  /** Change page content. */
  edit: "lockEdit",
  /** Add comments and annotations. */
  annotate: "lockAnnotate",
  /** Fill interactive form fields. */
  forms: "lockForms",
  /** Screen-reader / accessibility extraction. */
  access: "lockAccess",
  /** Insert, rotate, delete pages (assemble). */
  assemble: "lockAssemble",
} as const;

export type PrintChoice = "full" | "low" | "off";
export type AlgorithmChoice = "aes256" | "aes128";

/** PRD §8.3: password minimum length (recommend 12+). */
export const LOCK_PASSWORD_MIN = 6;

/**
 * Defaults for a typical shared form or statement: the recipient can read,
 * print and fill, but cannot copy or change the content.
 */
export const LOCK_DEFAULTS: OptionValues = {
  [LOCK_IDS.password]: "",
  [LOCK_IDS.owner]: "",
  [LOCK_IDS.algorithm]: "aes256",
  [LOCK_IDS.print]: "full",
  [LOCK_IDS.copy]: false,
  [LOCK_IDS.edit]: false,
  [LOCK_IDS.annotate]: true,
  [LOCK_IDS.forms]: true,
  [LOCK_IDS.access]: true,
  [LOCK_IDS.assemble]: false,
};

/** Permission block handed to pdf-lib's encrypt() (structural mirror). */
export interface EncryptPlan {
  userPassword: string;
  ownerPassword: string;
  algorithm: "AES-256" | "AES-128";
  permissions: {
    printing: false | "lowResolution" | "highResolution";
    copying: boolean;
    modifying: boolean;
    annotating: boolean;
    fillingForms: boolean;
    contentAccessibility: boolean;
    documentAssembly: boolean;
  };
}

function boolOf(values: OptionValues, id: string): boolean {
  return values[id] === true;
}

/**
 * Defensive parse of raw option values into the exact encrypt() input.
 * Unknown or missing values fall back to the locked-down side, never to
 * "silently allowed".
 */
export function buildEncryptOptions(values: OptionValues): EncryptPlan {
  const userPassword = String(values[LOCK_IDS.password] ?? "");
  const ownerRaw = String(values[LOCK_IDS.owner] ?? "");
  const algorithm: EncryptPlan["algorithm"] =
    values[LOCK_IDS.algorithm] === "aes128" ? "AES-128" : "AES-256";
  const printRaw = String(values[LOCK_IDS.print] ?? "full");
  const printing: EncryptPlan["permissions"]["printing"] =
    printRaw === "off" ? false : printRaw === "low" ? "lowResolution" : "highResolution";
  return {
    userPassword,
    ownerPassword: ownerRaw || userPassword,
    algorithm,
    permissions: {
      printing,
      copying: boolOf(values, LOCK_IDS.copy),
      modifying: boolOf(values, LOCK_IDS.edit),
      annotating: boolOf(values, LOCK_IDS.annotate),
      fillingForms: boolOf(values, LOCK_IDS.forms),
      contentAccessibility: boolOf(values, LOCK_IDS.access),
      documentAssembly: boolOf(values, LOCK_IDS.assemble),
    },
  };
}

/* -------------------- Typed-password strength -------------------- */

const POOL_LOWER = 26;
const POOL_UPPER = 26;
const POOL_DIGITS = 10;
const POOL_SYMBOLS = 33; // printable ASCII symbols + space

/**
 * Honest charset-based entropy estimate for a TYPED password (as opposed to
 * the generator-side `entropyBits` of the password tool): position pools are
 * counted once per class actually present, then bits = length × log2(pool).
 * Deliberately ignores dictionary structure — it is a floor, not a promise.
 */
export function estimateTypedBits(password: string): number {
  if (password.length === 0) return 0;
  let pool = 0;
  if (/[a-z]/.test(password)) pool += POOL_LOWER;
  if (/[A-Z]/.test(password)) pool += POOL_UPPER;
  if (/[0-9]/.test(password)) pool += POOL_DIGITS;
  if (/[^a-zA-Z0-9]/.test(password)) pool += POOL_SYMBOLS;
  if (pool === 0) return 0;
  return Math.round(password.length * Math.log2(pool) * 10) / 10;
}

/** Summary line of the plan for chips/notes ("AES-256 · print: full …"). */
export function planFacts(plan: EncryptPlan): string[] {
  const facts: string[] = [plan.algorithm];
  facts.push(`print:${plan.permissions.printing === false ? "off" : plan.permissions.printing === "lowResolution" ? "low" : "full"}`);
  facts.push(`copy:${plan.permissions.copying ? "on" : "off"}`);
  facts.push(`edit:${plan.permissions.modifying ? "on" : "off"}`);
  return facts;
}
