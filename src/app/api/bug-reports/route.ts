import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/bug-reports — user bug reports / feature requests (P12 triage).
 *
 * Works signed-out (optional email) or signed-in (userId link — attached
 * automatically from the session). Honeypot field "hp": non-empty = bot →
 * fake 201 with no write. browserInfo = standard User-Agent header truncated
 * to 200 chars (no extra PII). Rate limit 5 / 10 min / IP.
 */

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  title: z.string().trim().min(4).max(120),
  message: z.string().trim().min(10).max(4000),
  category: z.enum(["bug", "feature", "other"]),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  toolId: z.string().max(64).optional(),
  email: z.string().trim().email().max(254).optional(),
});

export async function POST(request: Request) {
  // R43 security order: throttle BEFORE parsing — every attempt counts
  // toward the window (DoS hardening; was: bad_request short-circuited
  // first, letting invalid traffic bypass the limiter entirely).
  const rl = rateLimit(`bugr:${clientIp(request)}`, 5, 10 * 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } }
    );
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Honeypot: bots fill hidden fields — pretend success, store nothing.
  if (
    typeof json === "object" &&
    json !== null &&
    typeof (json as { hp?: unknown }).hp === "string" &&
    ((json as { hp: string }).hp.length > 0)
  ) {
    return NextResponse.json(
      { id: crypto.randomUUID() },
      { status: 201 }
    );
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const session = await getSessionUser(request);
    const data = parsed.data;

    const report = await db.bugReport.create({
      data: {
        title: data.title,
        message: data.message,
        category: data.category,
        severity: data.severity ?? "medium",
        toolId: data.toolId || null,
        email: data.email ? data.email.toLowerCase() : null,
        userId: session?.id ?? null,
        browserInfo:
          request.headers.get("user-agent")?.slice(0, 200) ?? null,
      },
    });

    return NextResponse.json({ id: report.id }, { status: 201 });
  } catch (err) {
    console.error("[api/bug-reports] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
