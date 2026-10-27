import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getAdminUser } from "@/lib/auth";

/**
 * GET /api/admin/bugs?status= — triage list for the admin console.
 *
 * Newest first, max 200. Reporter email resolves from the linked account,
 * falling back to the anonymous contact email, then "—". `status` is
 * optional; when present it must be a valid status (else 400).
 */

export const dynamic = "force-dynamic";

const STATUSES = ["new", "confirmed", "in_progress", "fixed", "wontfix"];

function toAdminBugRow(r: {
  id: string;
  title: string;
  message: string;
  category: string;
  severity: string;
  status: string;
  toolId: string | null;
  adminNote: string | null;
  browserInfo: string | null;
  createdAt: Date;
  updatedAt: Date;
  email?: string | null;
  user?: { email: string | null } | null;
}) {
  return {
    id: r.id,
    title: r.title,
    message: r.message,
    category: r.category,
    severity: r.severity,
    status: r.status,
    toolId: r.toolId,
    adminNote: r.adminNote,
    browserInfo: r.browserInfo,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    email: r.user?.email ?? r.email ?? "—",
  };
}

export async function GET(request: Request) {
  const admin = await getAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const url = new URL(request.url);
    const status = (url.searchParams.get("status") ?? "").trim();

    let where: { status?: { in: string[] } } = {};
    if (status) {
      if (!STATUSES.includes(status)) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      where = { status: { in: [status] } };
    }

    const rows = await db.bugReport.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { user: { select: { email: true } } },
    });

    return NextResponse.json({
      reports: rows.map((r) => toAdminBugRow(r)),
    });
  } catch (err) {
    console.error("[api/admin/bugs] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
