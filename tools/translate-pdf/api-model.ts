import { z } from "zod";

import {
  TRANSLATE_LIMITS,
  TARGET_LANGUAGES,
  type TargetLangCode,
} from "./model";

/**
 * Translate PDF (R9-c) — API contract shared by the route and the smoke.
 * Deliberately SDK-free so scripts/smoke-translate-pdf.ts can import the
 * zod schema and the prompt builder WITHOUT pulling z-ai-web-dev-sdk into
 * the test graph (that stays server-only in src/app/api/translate/route.ts).
 *
 * The limits here mirror TRANSLATE_LIMITS in ./model.ts exactly — the
 * smoke pins both sides together so they can never drift apart silently.
 */

export const TRANSLATE_API = {
  /** Mirrors TRANSLATE_LIMITS.batchChars (+1 newline slack). */
  maxBatchChars: 3_000,
  maxTargetChars: 8_000,
  /** Whole-request wall clock (model included). */
  timeoutMs: 60_000,
  /** Total attempts (1 try + 1 retry). */
  attempts: 2,
} as const;

const targetEnum = z.enum(
  TARGET_LANGUAGES.map((l) => l.code) as [TargetLangCode, ...TargetLangCode[]],
);

export const translateBodySchema = z.object({
  text: z.string().min(1).max(TRANSLATE_API.maxBatchChars),
  target: targetEnum,
  locale: z.enum(["en", "hi"]).default("en"),
});

export type TranslateBody = z.infer<typeof translateBodySchema>;

/** Stable error codes — the worker maps these to i18n tool.* keys. */
export type TranslateErrorCode =
  | "badRequest"
  | "timeout"
  | "aiUnavailable"
  | "emptyTranslation";

export const TRANSLATE_ERROR_STATUS: Record<TranslateErrorCode, number> = {
  badRequest: 400,
  timeout: 504,
  aiUnavailable: 502,
  emptyTranslation: 502,
};

/** English prompt language name for a target code (models read English). */
export function promptLanguageName(target: TargetLangCode): string {
  switch (target) {
    case "hi":
      return "Hindi (Devanagari script)";
    case "mr":
      return "Marathi (Devanagari script)";
    case "en":
      return "English";
    case "es":
      return "Spanish";
    case "fr":
      return "French";
    case "de":
      return "German";
    case "it":
      return "Italian";
    case "pt":
      return "Portuguese";
    case "nl":
      return "Dutch";
    default:
      return "English";
  }
}

/**
 * The translation prompt. The strict rules keep the output machine-strippable:
 * ONLY the translation, same line structure, numbers/URLs untouched.
 */
export function buildTranslatePrompt(target: TargetLangCode): string {
  return [
    `Translate the user's text into ${promptLanguageName(target)}.`,
    "Rules you must follow:",
    "1. Output ONLY the translation — no preamble, no quotes around it, no notes, no original text.",
    "2. Keep the same number of lines as the input: translate each line, keep empty structure intact.",
    "3. Keep numbers, dates, URLs, code and file names exactly as they are.",
    "4. Translate the meaning naturally — do not transliterate word by word unless the text is a name.",
    `5. Write the translation in the script ${promptLanguageName(target)} uses.`,
  ].join("\n");
}

/** The strip the worker applies defensively (models add quotes anyway). */
export function stripWrappingQuotes(text: string): string {
  let out = String(text ?? "").trim();
  // Matching single wrapping pair of "..." / “...” / '...'
  if (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith("“") && out.endsWith("”")) ||
    (out.startsWith("'") && out.endsWith("'"))
  ) {
    const inner = out.slice(1, -1);
    // Only strip when the input did NOT have the same wrapping pair.
    if (!/^[“"']/.test(inner)) out = inner;
  }
  return out;
}
