import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { gateUser } from "@/lib/api-auth";

/**
 * GET /api/billing/status — the signed-in user's billing snapshot:
 * current plan, the active/pending subscription summary (plan, status,
 * periodEnd) and the last 10 payment rows (billing history, PRD
 * /account/billing). Metadata only — amounts/currencies/status, never
 * card or file data.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await gateUser(request);
  if (gate.reject) return gate.reject;
  const session = gate.user;

  try {
    const [subscription, payments, user] = await Promise.all([
      db.subscription.findFirst({
        where: { userId: session.id, status: { in: ["active", "pending"] } },
        orderBy: { createdAt: "desc" },
      }),
      db.payment.findMany({
        where: { userId: session.id },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
      db.user.findUnique({
        where: { id: session.id },
        select: { plan: true },
      }),
    ]);

    return NextResponse.json({
      plan: user?.plan ?? session.plan,
      subscription: subscription
        ? {
            id: subscription.id,
            plan: subscription.plan,
            status: subscription.status,
            periodEnd: subscription.periodEnd?.toISOString() ?? null,
          }
        : null,
      payments: payments.map((p) => ({
        id: p.id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        invoiceNo: p.invoiceNo,
        createdAt: p.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error("[api/billing/status] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
