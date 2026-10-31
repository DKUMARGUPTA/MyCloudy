import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import {
  billingDemoMode,
  billingLimitsActive,
  FREE_DAILY_TASKS,
  PRO_DAILY_TASKS,
} from "@/lib/billing/plans";

/**
 * GET /api/limits?anonId=<localStorage id> — the free-tier daily task
 * counter (R28, decision D3 — docs/rules/16-BILLING-RESEARCH.md §4).
 *
 * Public (guests count too): the quota is keyed on the same anonymous
 * per-browser id the usage beacon already sends (PRD §14 privacy — no user
 * id, no IP in usage data). A signed-in Pro session simply lifts the cap.
 *
 * Response: { plan, usedToday, maxToday, remaining, hard }
 *  - usedToday: successful runs today (AnonUsage sums; failures never count)
 *  - hard: FALSE while no payment provider is configured → shadow mode
 *    (counter + soft nudges, never a block). Flips true the moment
 *    RAZORPAY_KEY_ID / STRIPE_SECRET_KEY exist — limits and payments go
 *    live together, never limits-before-payments.
 *
 * BILLING_DEMO sandbox may force hard=true via ?demoHard=1 to exercise the
 * blocked-path UI in review builds.
 */

export const dynamic = "force-dynamic";

const ANON_ID = /^[A-Za-z0-9_-]{8,64}$/;

export async function GET(request: Request) {
  const limit = rateLimit(`limits:${clientIp(request)}`, 60, 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } }
    );
  }

  const url = new URL(request.url);
  const anonId = url.searchParams.get("anonId") ?? "";
  if (!ANON_ID.test(anonId)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    /* Optional session read — a Pro session lifts the cap, guests are fine. */
    let plan: "free" | "pro" = "free";
    try {
      const session = await getSessionUser(request);
      if (session?.plan === "pro") plan = "pro";
    } catch {
      /* Session resolution is best-effort here — the counter must work
       * for guests even when the auth DB hiccups. */
    }

    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const agg = await db.anonUsage.aggregate({
      _sum: { count: true },
      where: { anonId, day },
    });

    const usedToday = agg._sum.count ?? 0;
    const maxToday = plan === "pro" ? PRO_DAILY_TASKS : FREE_DAILY_TASKS;
    const hard =
      billingLimitsActive() ||
      (billingDemoMode() && url.searchParams.get("demoHard") === "1");

    return NextResponse.json({
      plan,
      usedToday,
      maxToday,
      remaining: Math.max(0, maxToday - usedToday),
      hard,
      day,
    });
  } catch (err) {
    console.error("[api/limits] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
