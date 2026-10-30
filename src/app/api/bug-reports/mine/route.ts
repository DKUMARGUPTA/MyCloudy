import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { gateUser } from "@/lib/api-auth";

/**
 * GET /api/bug-reports/mine — the signed-in user's own reports, newest
 * first, max 100. `adminNote` is included only when non-empty (users see
 * admin replies, not empty placeholders).
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await gateUser(request);
  if (gate.reject) return gate.reject;
  const session = gate.user;

  try {
    const rows = await db.bugReport.findMany({
      where: { userId: session.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    const reports = rows.map((r) => ({
      id: r.id,
      title: r.title,
      message: r.message,
      category: r.category,
      severity: r.severity,
      status: r.status,
      toolId: r.toolId,
      ...(r.adminNote ? { adminNote: r.adminNote } : {}),
      createdAt: r.createdAt.toISOString(),
    }));

    return NextResponse.json({ reports });
  } catch (err) {
    console.error("[api/bug-reports/mine] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
