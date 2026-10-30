import { z } from "zod";

import {
  SUMMARIZE_LIMITS,
  SUMMARY_TARGET_WORDS,
  isSummaryLanguage,
  type SummaryLength,
} from "./model";

/**
 * Summarize PDF (R11) — API contract shared by the route and the smoke.
 * SDK-free so scripts/smoke-summarize-pdf.ts can import the zod schema and
 * the prompt builder WITHOUT pulling z-ai-web-dev-sdk into the test graph.
 *
 * The limits here mirror SUMMARIZE_LIMITS exactly — the smoke pins both
 * sides together so they can never drift apart silently.
 */

export const SUMMARIZE_API = {
  /** Mirrors SUMMARIZE_LIMITS.excerptBudget (+1 newline slack). */
  maxExcerptChars: 48_500,
  /** Defensive ceiling on the model's answer (contract says far less). */
  maxAnswerChars: 8_000,
  /** Whole-request wall clock (model included). */
  timeoutMs: 90_000,
  /** Total attempts (1 try + 1 retry). */
  attempts: 2,
} as const;

export const summarizeBodySchema = z.object({
  excerpt: z.string().min(1).max(SUMMARIZE_API.maxExcerptChars),
  language: z.enum(["en", "hi"]),
  length: z.enum(["brief", "standard", "detailed"]),
  locale: z.enum(["en", "hi"]).default("en"),
  docName: z.string().max(200).optional(),
});

export type SummarizeBody = z.infer<typeof summarizeBodySchema>;

/** Stable error codes — the surface maps these to i18n keys. */
export type SummarizeErrorCode =
  | "badRequest"
  | "timeout"
  | "aiUnavailable"
  | "aiNotConfigured"
  | "emptySummary";

export const SUMMARIZE_ERROR_STATUS: Record<SummarizeErrorCode, number> = {
  badRequest: 400,
  timeout: 504,
  aiUnavailable: 502,
  aiNotConfigured: 503,
  emptySummary: 502,
};

function promptLanguageName(code: string): string {
  return isSummaryLanguage(code) && code === "hi"
    ? "Hindi (Devanagari script)"
    : "English";
}

/**
 * The summarization prompt. The section contract is machine-checkable:
 * English "## TL;DR" / "## Key points" / "## Action items" / "## Details"
 * headers regardless of the answer language, so parseSummarySections can
 * map them deterministically and the UI can localize the labels.
 */
export function buildSummarizePrompt(
  language: "en" | "hi",
  length: SummaryLength,
): string {
  const [lo, hi] = SUMMARY_TARGET_WORDS[length];
  const sections =
    length === "brief"
      ? ["## TL;DR", "## Key points"]
      : ["## TL;DR", "## Key points", "## Action items", "## Details"];

  return [
    `Summarize the user's document in ${promptLanguageName(language)}.`,
    `Length target: ${lo}-${hi} words total.`,
    "",
    "Structure — use EXACTLY these section headers, in this order, each on its own line as markdown:",
    ...sections.map((s) => s),
    "",
    "Section rules:",
    "- \"## TL;DR\": 2-3 sentences capturing what the document is and its main message.",
    "- \"## Key points\": 3-7 bullets, each starting with \"- \" and ending with the page citation like (p. 3).",
    "- \"## Action items\" (if listed): ONLY when the document asks the reader to do something; 1-5 bullets with (p. N). If there are none, omit this whole section.",
    length === "brief"
      ? "- No \"## Details\" section in brief mode."
      : "- \"## Details\": short paragraphs with the important specifics (numbers, dates, names, definitions), each claim with (p. N).",
    "",
    "Rules you must follow:",
    "1. Summarize ONLY from the document. If something is not in it, leave it out — never invent.",
    "2. Keep numbers, dates, names and URLs exactly as written in the document.",
    "3. The document text contains page markers like [[p 7]] — use them to cite, and write every citation as (p. N).",
    "4. No preamble like \"Here is the summary\" — start directly with \"## TL;DR\".",
    "5. Plain markdown only: ##, \"- \" bullets and normal text. No tables, no code blocks, no bold headings.",
    "6. Write the CONTENT in the answer language; keep the section headers exactly as given above.",
  ].join("\n");
}
