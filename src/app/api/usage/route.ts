import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/usage — anonymous per-tool usage analytics (PRD §2.5).
 *
 * Best-effort by contract: ALWAYS 202 `{ok:true}`. Invalid bodies,
 * rate-limit overflow (60/min per anonId) and database errors are all
 * swallowed silently — analytics must never break the tool flow. No IP
 * storage, no user agent: anonId (client-generated) + tool metadata only.
 */

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  toolId: z.string().min(1).max(60),
  mode: z.enum(["D", "S"]),
  success: z.boolean(),
  durationMs: z.number().int().min(0).max(600_000),
  sizeBucket: z.string().max(20).optional(),
  anonId: z.string().min(8).max(64),
});

const BUCKETS = ["tiny", "small", "medium", "large"] as const;

export async function POST(request: Request) {
  try {
    const json: unknown = await request.json();
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ ok: true }, { status: 202 });
    }

    const { toolId, mode, success, durationMs, anonId } = parsed.data;
    const sizeBucket = (BUCKETS as readonly string[]).includes(
      parsed.data.sizeBucket ?? ""
    )
      ? (parsed.data.sizeBucket as (typeof BUCKETS)[number])
      : "small";

    // 60 events / minute / anonId — overflow is dropped, not reported.
    if (!rateLimit(`usage:${anonId}`, 60, 60_000).ok) {
      return NextResponse.json({ ok: true }, { status: 202 });
    }

    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    try {
      await db.usageEvent.create({
        data: {
          toolId,
          mode,
          success,
          durationMs,
          sizeBucket,
          locale: "en", // server never knows the UI locale (PRD privacy)
          day,
        },
      });
      await db.anonUsage.upsert({
        where: { anonId_toolId_day: { anonId, toolId, day } },
        update: { count: { increment: 1 } },
        create: { anonId, toolId, day, count: 1 },
      });
    } catch {
      // Swallow: usage analytics are never worth a client-visible error.
    }
  } catch {
    // Even unparseable bodies succeed — this endpoint cannot fail.
  }
  return NextResponse.json({ ok: true }, { status: 202 });
}
