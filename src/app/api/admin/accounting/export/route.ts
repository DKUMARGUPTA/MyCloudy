import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { gateAdmin } from "@/lib/api-auth";
import { gstSummary, trialBalance } from "@/lib/accounting/reports";

/**
 * GET /api/admin/accounting/export?type=journal|invoices|trial_balance|gst
 * — CSV downloads for the accountant (Tally-friendly column order).
 * Comma-separated with a BOM so Excel opens UTF-8 correctly.
 */

export const dynamic = "force-dynamic";

function csvEscape(value: string | number | null | undefined): string {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  return "\uFEFF" + rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
}

export async function GET(request: Request) {
  const gate = await gateAdmin(request);
  if (gate.reject) return gate.reject;

  try {
    const url = new URL(request.url);
    const type = url.searchParams.get("type") ?? "journal";
    let csv: string;

    switch (type) {
      case "invoices": {
        const invoices = await db.invoice.findMany({
          orderBy: { issuedAt: "desc" },
        });
        csv = toCsv([
          ["Invoice No", "Date", "Customer", "Email", "GSTIN", "Item", "Tax Type", "Taxable", "Tax", "Total", "Currency", "Status"],
          ...invoices.map((inv) => [
            inv.invoiceNo,
            inv.issuedAt.toISOString().slice(0, 10),
            inv.customerName ?? inv.customerEmail,
            inv.customerEmail,
            inv.customerGstin ?? "",
            inv.itemCode,
            inv.taxType,
            (inv.taxableAmount / 100).toFixed(2),
            (inv.taxAmount / 100).toFixed(2),
            (inv.totalAmount / 100).toFixed(2),
            inv.currency,
            inv.status,
          ]),
        ]);
        break;
      }
      case "trial_balance": {
        const tb = await trialBalance();
        csv = toCsv([
          ["Code", "Account", "Type", "Debit", "Credit"],
          ...tb.accounts.map((a) => [
            a.code,
            a.name,
            a.type,
            (a.tbDebit / 100).toFixed(2),
            (a.tbCredit / 100).toFixed(2),
          ]),
          ["", "TOTAL", "", (tb.totalDebit / 100).toFixed(2), (tb.totalCredit / 100).toFixed(2)],
        ]);
        break;
      }
      case "gst": {
        const from = new Date(Date.now() - 365 * 86_400_000);
        const gst = await gstSummary(from, new Date());
        csv = toCsv([
          ["Invoice No", "Date", "Customer", "Email", "GSTIN", "Tax Type", "Taxable (minor)", "Tax (minor)", "Total (minor)", "Currency"],
          ...gst.invoices.map((inv) => [
            inv.invoiceNo,
            inv.issuedAt.slice(0, 10),
            inv.customerEmail,
            inv.customerEmail,
            inv.customerGstin ?? "",
            inv.taxType,
            inv.taxableAmount,
            inv.taxAmount,
            inv.totalAmount,
            inv.currency,
          ]),
        ]);
        break;
      }
      case "journal":
      default: {
        const entries = await db.journalEntry.findMany({
          orderBy: [{ date: "asc" }, { createdAt: "asc" }],
          include: { lines: { include: { account: true } } },
        });
        csv = toCsv([
          ["Entry No", "Date", "Source", "Reference", "Memo", "Account Code", "Account", "Debit", "Credit"],
          ...entries.flatMap((entry) =>
            entry.lines.map((line) => [
              entry.entryNo,
              entry.date.toISOString().slice(0, 10),
              entry.source,
              entry.sourceRef ?? "",
              line.memo ?? entry.memo,
              line.account.code,
              line.account.name,
              (line.debit / 100).toFixed(2),
              (line.credit / 100).toFixed(2),
            ])
          ),
        ]);
        break;
      }
    }

    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="docopdf-${type}-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (err) {
    console.error("[api/admin/accounting/export] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
