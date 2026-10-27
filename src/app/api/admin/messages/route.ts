import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getAdminUser } from "@/lib/auth";

/**
 * GET /api/admin/messages — contact-form inbox for the admin console.
 *
 * Newest first, max 200. The row id IS the ticket reference (SDC-XXXX).
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await getAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const rows = await db.contactMessage.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    return NextResponse.json({
      messages: rows.map((m) => ({
        id: m.id,
        name: m.name,
        email: m.email,
        category: m.category,
        message: m.message,
        status: m.status,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error("[api/admin/messages] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
