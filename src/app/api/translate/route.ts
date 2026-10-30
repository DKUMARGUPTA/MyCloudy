import { NextResponse } from "next/server";

import {
  chatComplete,
  getAiConfig,
  type AiConfig,
} from "@/lib/ai/zai-client";

import {
  TRANSLATE_API,
  TRANSLATE_ERROR_STATUS,
  buildTranslatePrompt,
  translateBodySchema,
  type TranslateErrorCode,
} from "../../../../tools/translate-pdf/api-model";
import { targetLang, type TargetLangCode } from "../../../../tools/translate-pdf/model";

/**
 * POST /api/translate — one bounded text batch of "Translate PDF" (R9-c).
 *
 * Same honest privacy shape as /api/chat (the only other server-backed
 * route): the PDF file NEVER leaves the user's device. The worker extracts
 * text on-device and posts ONLY one bounded batch string (≤ 3 000 chars)
 * plus the target language code. Nothing is stored, nothing is logged; the
 * batch exists in this function's memory for one call and is gone.
 *
 * Failure behaviour is honest and stable (codes the worker localizes):
 *   badRequest 400 · aiNotConfigured 503 · aiUnavailable 502 ·
 *   emptyTranslation 502 · timeout 504.
 * The model call gets up to TRANSLATE_API.attempts tries inside one
 * overall TRANSLATE_API.timeoutMs wall clock; each attempt is raced
 * against the remaining budget and the underlying fetch is CANCELLED
 * via AbortSignal when the budget runs out (R21 — the SDK could not do
 * this; the zai-client adapter can).
 */

export const runtime = "nodejs";
export const maxDuration = 120;

type ValidBody = {
  text: string;
  target: TargetLangCode;
  locale: "en" | "hi";
};

function fail(code: TranslateErrorCode): NextResponse {
  return NextResponse.json(
    { error: code },
    { status: TRANSLATE_ERROR_STATUS[code] },
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
        { role: "assistant", content: buildTranslatePrompt(body.target) },
        { role: "user", content: body.text },
      ],
      thinking: { type: "disabled" },
    },
    { config, signal },
  );
  const text = completion.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("emptyTranslation");
  }
  return text.trim();
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: ValidBody;
  try {
    const parsed = translateBodySchema.safeParse(await request.json());
    if (!parsed.success) return fail("badRequest");
    body = parsed.data;
  } catch {
    return fail("badRequest");
  }

  // Language sanity (zod already validates; this keeps the type honest).
  const lang = targetLang(body.target);

  // Resolve the AI backend once per request (R21): absent config →
  // honest instant 503 instead of a doomed retry loop.
  const config = await getAiConfig();
  if (!config) return fail("aiNotConfigured");

  const deadline = Date.now() + TRANSLATE_API.timeoutMs;
  for (
    let attempt = 1;
    attempt <= TRANSLATE_API.attempts;
    attempt += 1
  ) {
    try {
      const text = await withDeadline(
        (signal) => callModel({ ...body, target: lang.code }, config, signal),
        deadline,
      );
      return NextResponse.json({ text });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "emptyTranslation") return fail("emptyTranslation");
      if (message === "deadline") return fail("timeout");
      if (attempt >= TRANSLATE_API.attempts) return fail("aiUnavailable");
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  return fail("aiUnavailable");
}
