import { NextResponse } from "next/server";

import { gateAdmin } from "@/lib/api-auth";
import {
  balanceSheet,
  gstSummary,
  profitAndLoss,
  trialBalance,
} from "@/lib/accounting/reports";

/**
 * GET /api/admin/accounting/reports?type=trial_balance|pnl|balance_sheet|gst
 *   &from=YYYY-MM-DD&to=YYYY-MM-DD (to is exclusive for pnl/gst; the
 *   balance sheet takes only &asOf=).
 *
 * All four reports derive from the journal lines (double-entry truth),
 * except GST which is invoice-derived (GSTR-1 style).
 */

export const dynamic = "force-dynamic";

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function GET(request: Request) {
  const gate = await gateAdmin(request);
  if (gate.reject) return gate.reject;

  try {
    const url = new URL(request.url);
    const type = url.searchParams.get("type") ?? "trial_balance";
    const from =
      parseDate(url.searchParams.get("from")) ??
      new Date(Date.now() - 365 * 86_400_000);
    const to = parseDate(url.searchParams.get("to")) ?? new Date();

    switch (type) {
      case "pnl":
        return NextResponse.json(await profitAndLoss(from, to));
      case "balance_sheet": {
        const asOf = parseDate(url.searchParams.get("asOf")) ?? new Date();
        return NextResponse.json(await balanceSheet(asOf));
      }
      case "gst":
        return NextResponse.json(await gstSummary(from, to));
      case "trial_balance":
      default:
        return NextResponse.json(await trialBalance(from, to));
    }
  } catch (err) {
    console.error("[api/admin/accounting/reports] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
