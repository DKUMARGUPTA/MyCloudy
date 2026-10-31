import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { audit } from "@/lib/auth";
import { gateUser } from "@/lib/api-auth";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { billingDemoMode, isProPlanId, PRO_PLANS } from "@/lib/billing/plans";

/**
 * POST /api/billing/checkout — start a Pro upgrade (Phase-10 R26; R28
 * added the pro_week 7-day pass SKU).
 *
 * Body: { plan: "pro_monthly" | "pro_yearly" | "pro_week" }.
 *
 * Real providers (Razorpay/Stripe) are not wired yet — this is the stub
 * that keeps the flow honest:
 *  - BILLING_DEMO unset (production): 503 { error: "billingNotConfigured" }
 *    — the same pattern as the AI routes' aiNotConfigured. No fake
 *    payment ever succeeds.
 *  - BILLING_DEMO=1 (sandbox/review): creates a pending Subscription +
 *    a "created" Payment row (INR minor units per the PRD table), and
 *    returns { mode: "demo", subscriptionId }. /api/billing/confirm then
 *    completes the activation so the full surface is testable end-to-end.
 *
 * Audit: "billing.checkout" (metadata only — plan id, no card data ever).
 */

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  plan: z.string().min(1).max(40),
});

export async function POST(request: Request) {
  const gate = await gateUser(request);
  if (gate.reject) return gate.reject;
  const session = gate.user;

  /* Brute/abuse guard — 8 checkout attempts / 10 min / IP. */
  const limit = rateLimit(`billing-checkout:${clientIp(request)}`, 8, 10 * 60 * 1000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } }
    );
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success || !isProPlanId(parsed.data.plan)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const plan = PRO_PLANS[parsed.data.plan];

  if (!billingDemoMode()) {
    return NextResponse.json({ error: "billingNotConfigured" }, { status: 503 });
  }

  try {
    /* One live subscription track per user: older pending rows get
     * superseded so the confirm step can only ever activate the newest. */
    await db.subscription.updateMany({
      where: { userId: session.id, status: "pending" },
      data: { status: "superseded" },
    });

    const subscription = await db.subscription.create({
      data: {
        userId: session.id,
        provider: "demo",
        plan: plan.id,
        status: "pending",
      },
    });

    await db.payment.create({
      data: {
        userId: session.id,
        amount: plan.amountInrMinor,
        currency: "INR",
        status: "created",
      },
    });

    await audit(session.email, "billing.checkout", {
      userId: session.id,
      plan: plan.id,
      mode: "demo",
    });

    return NextResponse.json({
      ok: true,
      mode: "demo" as const,
      plan: plan.id,
      subscriptionId: subscription.id,
    });
  } catch (err) {
    console.error("[api/billing/checkout] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
