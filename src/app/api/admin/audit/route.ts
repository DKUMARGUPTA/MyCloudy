import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { gateAdmin } from "@/lib/api-auth";

/**
 * GET /api/admin/audit — compliance trail (audit_log), newest first,
 * max 200. metaJson stays a raw JSON string (the console pretty-prints it).
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await gateAdmin(request);
  if (gate.reject) return gate.reject;
  const admin = gate.user;

  try {
    const rows = await db.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    return NextResponse.json({
      entries: rows.map((e) => ({
        id: e.id,
        actor: e.actor,
        action: e.action,
        metaJson: e.metaJson,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error("[api/admin/audit] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
