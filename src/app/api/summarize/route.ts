import { NextResponse } from "next/server";

import {
  chatComplete,
  getAiConfig,
  type AiConfig,
} from "@/lib/ai/zai-client";

import {
  SUMMARIZE_API,
  SUMMARIZE_ERROR_STATUS,
  buildSummarizePrompt,
  summarizeBodySchema,
  type SummarizeErrorCode,
} from "../../../../tools/summarize-pdf/api-model";

/**
 * POST /api/summarize — the one server call of "Summarize PDF" (R11).
 *
 * Same honest privacy shape as /api/chat and /api/translate (the only
 * server-backed routes): the PDF file NEVER leaves the user's device. The
 * worker extracts text on-device and posts ONLY the bounded, page-marked
 * excerpt (≤ 48 500 chars) plus the option codes. Nothing is stored,
 * nothing is logged; the excerpt exists in this function's memory for one
 * call and is gone.
 *
 * Failure behaviour is honest and stable (codes the surface localizes):
 *   badRequest 400 · aiNotConfigured 503 · aiUnavailable 502 ·
 *   emptySummary 502 · timeout 504.
 * The model call gets up to SUMMARIZE_API.attempts tries inside one
 * overall SUMMARIZE_API.timeoutMs wall clock; each attempt is raced
 * against the remaining budget and the underlying fetch is CANCELLED
 * via AbortSignal when the budget runs out (R21 — the SDK could not do
 * this; the zai-client adapter can).
 */

export const runtime = "nodejs";
export const maxDuration = 120;

type ValidBody = {
  excerpt: string;
  language: "en" | "hi";
  length: "brief" | "standard" | "detailed";
  locale: "en" | "hi";
  docName?: string | undefined;
};

function fail(code: SummarizeErrorCode): NextResponse {
  return NextResponse.json(
    { error: code },
    { status: SUMMARIZE_ERROR_STATUS[code] },
  );
}

/**
 * Race one attempt against the remaining wall-clock budget. The timer is
 * cleared as soon as work settles AND the AbortController cancels the
 * underlying fetch when the deadline wins, so a stuck model can neither
 * hold the request open nor leak an in-flight call (R19 P3 → R21).
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
        {
          role: "assistant",
          content: buildSummarizePrompt(body.language, body.length),
        },
        { role: "user", content: body.excerpt },
      ],
      thinking: { type: "disabled" },
    },
    { config, signal },
  );
  const text = completion.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("emptySummary");
  }
  return text.trim().slice(0, SUMMARIZE_API.maxAnswerChars);
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: ValidBody;
  try {
    const parsed = summarizeBodySchema.safeParse(await request.json());
    if (!parsed.success) return fail("badRequest");
    body = parsed.data;
  } catch {
    return fail("badRequest");
  }

  // Resolve the AI backend once per request. No env vars on Vercel and
  // no sandbox config file → answer honestly and instantly (503) instead
  // of burning the retry budget on an unreachable service (R21).
  const config = await getAiConfig();
  if (!config) return fail("aiNotConfigured");

  const deadline = Date.now() + SUMMARIZE_API.timeoutMs;
  for (
    let attempt = 1;
    attempt <= SUMMARIZE_API.attempts;
    attempt += 1
  ) {
    try {
      const summary = await withDeadline(
        (signal) => callModel(body, config, signal),
        deadline,
      );
      return NextResponse.json({ summary });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "emptySummary") return fail("emptySummary");
      if (message === "deadline") return fail("timeout");
      if (attempt >= SUMMARIZE_API.attempts) return fail("aiUnavailable");
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  return fail("aiUnavailable");
}
