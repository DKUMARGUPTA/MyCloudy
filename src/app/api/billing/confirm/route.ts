import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { audit, signSessionJwt, sessionCookieHeader } from "@/lib/auth";
import { gateUser } from "@/lib/api-auth";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { billingDemoMode, isProPlanId, PRO_PLANS } from "@/lib/billing/plans";

/**
 * POST /api/billing/confirm — complete a demo checkout (BILLING_DEMO=1
 * ONLY — guarded first, so production can never activate Pro without a
 * real payment).
 *
 * Body: { subscriptionId: string }.
 *
 * Marks the pending subscription active (periodEnd = now + plan days),
 * flips the newest "created" Payment to "paid", sets users.plan = "pro"
 * and re-issues the session cookie so the refreshed SafeUser carries the
 * new plan immediately. Audit: "billing.demo_confirm".
 */

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  subscriptionId: z.string().min(1).max(80),
});

export async function POST(request: Request) {
  /* Demo-only route: in production it does not exist functionally. */
  if (!billingDemoMode()) {
    return NextResponse.json({ error: "billingNotConfigured" }, { status: 503 });
  }

  const gate = await gateUser(request);
  if (gate.reject) return gate.reject;
  const session = gate.user;

  const limit = rateLimit(`billing-confirm:${clientIp(request)}`, 10, 10 * 60 * 1000);
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
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const subscription = await db.subscription.findUnique({
      where: { id: parsed.data.subscriptionId },
    });
    if (!subscription || subscription.userId !== session.id) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (subscription.status !== "pending" || !isProPlanId(subscription.plan)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const plan = PRO_PLANS[subscription.plan];
    const periodEnd = new Date(Date.now() + plan.periodDays * 24 * 60 * 60 * 1000);

    await db.subscription.update({
      where: { id: subscription.id },
      data: {
        status: "active",
        providerSubId: `demo_${subscription.id.slice(0, 8)}`,
        periodEnd,
      },
    });

    /* Flip the newest created payment of this user to paid. */
    const created = await db.payment.findFirst({
      where: { userId: session.id, status: "created" },
      orderBy: { createdAt: "desc" },
    });
    if (created) {
      await db.payment.update({
        where: { id: created.id },
        data: { status: "paid", invoiceNo: `INV-${created.id.slice(0, 8).toUpperCase()}` },
      });
    }

    const user = await db.user.update({
      where: { id: session.id },
      data: { plan: "pro" },
    });

    await audit(session.email, "billing.demo_confirm", {
      userId: session.id,
      plan: subscription.plan,
      subscriptionId: subscription.id,
    });

    return NextResponse.json(
      {
        ok: true,
        plan: user.plan,
        periodEnd: periodEnd.toISOString(),
      },
      { headers: { "set-cookie": sessionCookieHeader(signSessionJwt(user)) } }
    );
  } catch (err) {
    console.error("[api/billing/confirm] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
