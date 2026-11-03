import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { gateAdmin } from "@/lib/api-auth";

/**
 * GET /api/admin/accounting/invoices?limit=&offset= — paginated tax
 * invoices (newest first).
 */

export const dynamic = "force-dynamic";

const MAX_PAGE = 50;

export async function GET(request: Request) {
  const gate = await gateAdmin(request);
  if (gate.reject) return gate.reject;

  try {
    const url = new URL(request.url);
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit")) || 20, 1),
      MAX_PAGE
    );
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

    const [total, invoices] = await Promise.all([
      db.invoice.count(),
      db.invoice.findMany({
        orderBy: { issuedAt: "desc" },
        take: limit,
        skip: offset,
      }),
    ]);

    return NextResponse.json({
      total,
      invoices: invoices.map((inv) => ({
        id: inv.id,
        invoiceNo: inv.invoiceNo,
        issuedAt: inv.issuedAt.toISOString(),
        customerEmail: inv.customerEmail,
        customerName: inv.customerName,
        customerGstin: inv.customerGstin,
        itemCode: inv.itemCode,
        taxType: inv.taxType,
        taxableAmount: inv.taxableAmount,
        taxAmount: inv.taxAmount,
        totalAmount: inv.totalAmount,
        currency: inv.currency,
        status: inv.status,
      })),
    });
  } catch (err) {
    console.error("[api/admin/accounting/invoices] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
