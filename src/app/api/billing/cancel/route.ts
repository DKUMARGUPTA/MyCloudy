import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { audit, signSessionJwt, sessionCookieHeader } from "@/lib/auth";
import { gateUser } from "@/lib/api-auth";

/**
 * POST /api/billing/cancel — cancel Pro and return to the Free plan.
 *
 * Marks every active/pending subscription of the signed-in user
 * "cancelled" and sets users.plan = "free" (at period end a real
 * integration would keep access until periodEnd; without live providers
 * the honest immediate downgrade is correct). Audit:
 * "billing.cancel". No body required.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const gate = await gateUser(request);
  if (gate.reject) return gate.reject;
  const session = gate.user;

  try {
    const changed = await db.subscription.updateMany({
      where: { userId: session.id, status: { in: ["active", "pending"] } },
      data: { status: "cancelled" },
    });

    const user = await db.user.update({
      where: { id: session.id },
      data: { plan: "free" },
    });

    await audit(session.email, "billing.cancel", {
      userId: session.id,
      subscriptions: changed.count,
    });

    return NextResponse.json(
      { ok: true, plan: user.plan },
      { headers: { "set-cookie": sessionCookieHeader(signSessionJwt(user)) } }
    );
  } catch (err) {
    console.error("[api/billing/cancel] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
