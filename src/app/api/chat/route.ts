import { NextResponse } from "next/server";

import {
  chatComplete,
  getAiConfig,
  type AiConfig,
} from "@/lib/ai/zai-client";

import {
  CHAT_API,
  CHAT_ERROR_STATUS,
  buildDocMessage,
  buildSystemPrompt,
  DOC_ACK_MESSAGE,
  chatBodySchema,
  type ChatErrorCode,
} from "../../../../tools/chat-with-pdf/api-model";

/**
 * POST /api/chat — the model behind "Chat with PDF" (R8).
 *
 * Every other DocoPDF tool runs 100% on the device; this is the ONE honest
 * exception and it is shaped to send as little as possible:
 *
 *  - the PDF file NEVER leaves the user's device. The browser extracts
 *    per-page text in a Web Worker and posts ONLY:
 *      • the bounded excerpt string (≤ 50 000 chars, page-marked),
 *      • the visible chat history (≤ 16 messages),
 *      • a display file name and the UI locale.
 *  - the route is STATELESS: no database, no cache, no session store, no
 *    logging of the excerpt, the messages or the answer. The request body
 *    exists in this function's memory for one call and is then gone.
 *  - limits are enforced by zod BEFORE the SDK is ever touched, so abuse
 *    and crafted payloads stop at the door.
 *
 * Failure behaviour is honest and stable (codes the UI localizes):
 *   badRequest 400 · aiNotConfigured 503 · aiUnavailable 502 ·
 *   emptyAnswer 502 · timeout 504.
 * The model call gets up to CHAT_API.attempts tries inside one overall
 * CHAT_API.timeoutMs wall clock; each attempt is raced against the
 * remaining budget and the underlying fetch is CANCELLED via
 * AbortSignal when the budget runs out (R21 — the SDK could not do
 * this; the zai-client adapter can).
 */

export const runtime = "nodejs";
export const maxDuration = 120;

type ValidBody = {
  messages: { role: "user" | "assistant"; content: string }[];
  docExcerpt: string;
  docName?: string;
  docCount: number;
  locale: "en" | "hi";
};

function fail(code: ChatErrorCode): NextResponse {
  return NextResponse.json(
    { error: code },
    { status: CHAT_ERROR_STATUS[code] },
  );
}

/**
 * Race one attempt against the remaining wall-clock budget. The timer is
 * cleared as soon as work settles AND the AbortController cancels the
 * underlying fetch when the deadline wins (R19 P3 → R21).
 */
async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  deadline: number,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("deadline");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("deadline"));
        }, remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function callModel(
  body: ValidBody,
  config: AiConfig,
  signal: AbortSignal,
): Promise<string> {
  const completion = await chatComplete(
    {
      messages: [
        { role: "assistant", content: buildSystemPrompt(body.docCount) },
        { role: "user", content: buildDocMessage(body.docExcerpt, body.docName) },
        { role: "assistant", content: DOC_ACK_MESSAGE },
        ...body.messages,
      ],
      thinking: { type: "disabled" },
    },
    { config, signal },
  );
  const answer = completion.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || answer.trim().length === 0) {
    throw new Error("emptyAnswer");
  }
  return answer.trim();
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: ValidBody;
  try {
    const parsed = chatBodySchema.safeParse(await request.json());
    if (!parsed.success) return fail("badRequest");
    body = parsed.data;
  } catch {
    return fail("badRequest");
  }

  // Resolve the AI backend once per request (R21): absent config →
  // honest instant 503 instead of a doomed retry loop.
  const config = await getAiConfig();
  if (!config) return fail("aiNotConfigured");

  const deadline = Date.now() + CHAT_API.timeoutMs;
  for (let attempt = 1; attempt <= CHAT_API.attempts; attempt += 1) {
    try {
      const answer = await withDeadline(
        (signal) => callModel(body, config, signal),
        deadline,
      );
      return NextResponse.json({ answer });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "emptyAnswer") return fail("emptyAnswer");
      if (message === "deadline") return fail("timeout");
      if (attempt >= CHAT_API.attempts) return fail("aiUnavailable");
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  return fail("aiUnavailable");
}
