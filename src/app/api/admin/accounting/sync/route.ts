import { NextResponse } from "next/server";

import { audit } from "@/lib/auth";
import { gateAdmin } from "@/lib/api-auth";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { runAccountingSync } from "@/lib/accounting/sync";

/**
 * POST /api/admin/accounting/sync — run the idempotent sweep that turns
 * billing rows into books: receipt entries + invoices for new paid
 * payments, catch-up revenue recognition, refund reversals. Safe to run
 * repeatedly; designed for on-demand use and (in production) the payment
 * webhook.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const gate = await gateAdmin(request);
  if (gate.reject) return gate.reject;
  const admin = gate.user;

  const limit = rateLimit(`acct-sync:${clientIp(request)}`, 10, 5 * 60 * 1000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } }
    );
  }

  try {
    const result = await runAccountingSync();
    await audit(admin.email, "accounting.sync", { ...result });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error("[api/admin/accounting/sync] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
