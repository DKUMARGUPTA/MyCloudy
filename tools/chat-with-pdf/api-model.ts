import { z } from "zod";

/**
 * Chat with PDF (R8) — API contract shared by the route and the smoke.
 * Deliberately SDK-free so scripts/smoke-chat-pdf.ts can import the zod
 * schema and the prompt builder WITHOUT pulling z-ai-web-dev-sdk into the
 * test graph (that stays server-only in src/app/api/chat/route.ts).
 *
 * The limits here mirror CHAT_LIMITS in ./model.ts exactly — the smoke pins
 * both sides together so they can never drift apart silently.
 */

export const CHAT_API = {
  /** Mirrors CHAT_LIMITS.historyMessages. */
  maxMessages: 16,
  /** Mirrors CHAT_LIMITS.userMessageChars / assistantMessageChars. */
  maxMessageChars: 4_000,
  /** Mirrors CHAT_LIMITS.excerptBudget + the omitted-marker slack. */
  maxExcerptChars: 50_000,
  maxDocNameChars: 200,
  /** Whole-request wall clock (model included). */
  timeoutMs: 90_000,
  /** Total attempts (1 try + 2 retries). */
  attempts: 3,
} as const;

export const chatBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(CHAT_API.maxMessageChars),
      }),
    )
    .min(1)
    .max(CHAT_API.maxMessages),
  docExcerpt: z.string().max(CHAT_API.maxExcerptChars),
  docName: z.string().max(CHAT_API.maxDocNameChars).optional(),
  /** How many documents the excerpt contains (R9-b multi-file chat). */
  docCount: z.number().int().min(1).max(5).default(1),
  locale: z.enum(["en", "hi"]).default("en"),
});

export type ChatBody = z.infer<typeof chatBodySchema>;

/** Stable error codes — the client maps these to localized toasts. */
export type ChatErrorCode =
  | "badRequest"
  | "timeout"
  | "aiUnavailable"
  | "aiNotConfigured"
  | "emptyAnswer";

export const CHAT_ERROR_STATUS: Record<ChatErrorCode, number> = {
  badRequest: 400,
  timeout: 504,
  aiUnavailable: 502,
  aiNotConfigured: 503,
  emptyAnswer: 502,
};

/**
 * The system prompt. The strict rules matter more than warmth: the model
 * must answer ONLY from the excerpt, cite [[p N]] markers as (p. N), admit
 * when something is not in the document, and match the user's language.
 *
 * docCount 1 keeps the prompt byte-identical to the R8 single-file text;
 * more documents add one rule: cite the file too, like ("name" p. 3).
 */
export function buildSystemPrompt(docCount: number = 1): string {
  const rules = [
    "You are the assistant behind DocoPDF's Chat with PDF. The user has opened one document; a text excerpt of it is provided in the next message.",
    "",
    "Rules you must follow:",
    "1. Answer ONLY from the document excerpt. If the answer is not in it, say plainly that the excerpt does not contain that — never invent facts, numbers, names or quotes.",
    "2. The excerpt marks every page as [[p N]]. Whenever you use something from the document, cite the page like (p. 3). One citation per claim is enough; pick the most relevant page.",
  ];
  if (docCount > 1) {
    rules.push(
      `2a. Several documents are open (${docCount}). The excerpt marks each one as === FILE "name" ===. When you use something from a document, cite the document too, like ("name" p. 3). Make clear which file a fact comes from — never mix documents up.`,
    );
  }
  rules.push(
    "3. Be concise and structured: short paragraphs, bullet lists when they help. No preamble like 'Sure' — get to the answer.",
    "4. Reply in the language the user writes in (Hindi messages get Hindi answers, English gets English).",
    "5. If part of the excerpt was omitted (an [[omitted]] marker appears), be honest that those pages were left out of the context.",
    "6. Questions unrelated to the document: say you can only see this document, then still help if the excerpt happens to cover it.",
  );
  return rules.join("\n");
}

/** The document excerpt travels as its own user message (RAG sandwich). */
export function buildDocMessage(
  excerpt: string,
  docName?: string,
): string {
  const name = docName && docName.trim().length > 0 ? docName.trim() : "document";
  return `DOCUMENT "${name}" — text excerpt below:\n\n${excerpt}\n\n(End of document excerpt.)`;
}

/** Canned ack that keeps user/assistant alternation intact. */
export const DOC_ACK_MESSAGE =
  "Understood — I have read the document excerpt and I am ready for questions about it.";
