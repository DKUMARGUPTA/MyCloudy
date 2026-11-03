import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { gateAdmin } from "@/lib/api-auth";
import { ensureChartSeeded } from "@/lib/accounting/chart";
import { overviewMetrics } from "@/lib/accounting/reports";

/**
 * GET /api/admin/accounting/overview — the dashboard payload: cash
 * collected, recognized revenue, deferred balance, GST payable, MRR and
 * bookkeeping counters. Seeds the chart on first touch.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await gateAdmin(request);
  if (gate.reject) return gate.reject;

  try {
    await ensureChartSeeded();
    const [metrics, recentEntries] = await Promise.all([
      overviewMetrics(),
      db.journalEntry.findMany({
        orderBy: { createdAt: "desc" },
        take: 8,
        include: {
          lines: {
            include: { account: { select: { code: true, name: true } } },
            orderBy: { debit: "desc" },
          },
        },
      }),
    ]);

    return NextResponse.json({
      metrics,
      recentEntries: recentEntries.map((entry) => ({
        id: entry.id,
        entryNo: entry.entryNo,
        date: entry.date.toISOString(),
        memo: entry.memo,
        source: entry.source,
        sourceRef: entry.sourceRef,
        lines: entry.lines.map((line) => ({
          code: line.account.code,
          name: line.account.name,
          debit: line.debit,
          credit: line.credit,
        })),
      })),
    });
  } catch (err) {
    console.error("[api/admin/accounting/overview] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
