import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { gateAdmin } from "@/lib/api-auth";
import { ensureChartSeeded } from "@/lib/accounting/chart";

/**
 * GET /api/admin/accounting/accounts — the chart of accounts with live
 * balances (all-time, natural direction). Seeds on first touch.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await gateAdmin(request);
  if (gate.reject) return gate.reject;

  try {
    await ensureChartSeeded();

    const [accounts, lines] = await Promise.all([
      db.account.findMany({ orderBy: { code: "asc" } }),
      db.journalLine.findMany({
        select: { accountId: true, debit: true, credit: true },
      }),
    ]);

    const sums = new Map<string, { debit: number; credit: number }>();
    for (const line of lines) {
      const cur = sums.get(line.accountId) ?? { debit: 0, credit: 0 };
      cur.debit += line.debit;
      cur.credit += line.credit;
      sums.set(line.accountId, cur);
    }

    return NextResponse.json({
      accounts: accounts.map((account) => {
        const s = sums.get(account.id) ?? { debit: 0, credit: 0 };
        const naturalDebit = account.type === "asset" || account.type === "expense";
        return {
          id: account.id,
          code: account.code,
          name: account.name,
          type: account.type,
          subtype: account.subtype,
          isSystem: account.isSystem,
          debit: s.debit,
          credit: s.credit,
          balance: naturalDebit ? s.debit - s.credit : s.credit - s.debit,
        };
      }),
    });
  } catch (err) {
    console.error("[api/admin/accounting/accounts] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
