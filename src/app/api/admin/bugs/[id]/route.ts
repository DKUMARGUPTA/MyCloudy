import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { audit } from "@/lib/auth";
import { gateAdmin } from "@/lib/api-auth";

/**
 * PATCH /api/admin/bugs/[id] — triage a bug report (status / severity /
 * adminNote). Audit: "admin.bug_update" with meta {id, status?}. Returns the
 * updated report in the same shape as GET /api/admin/bugs.
 */

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  status: z
    .enum(["new", "confirmed", "in_progress", "fixed", "wontfix"])
    .optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  adminNote: z.string().max(2000).optional(),
});

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

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  const gate = await gateAdmin(request);
  if (gate.reject) return gate.reject;
  const admin = gate.user;

  const { id } = await ctx.params;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const existing = await db.bugReport.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const { status, severity, adminNote } = parsed.data;

    const updated = await db.bugReport.update({
      where: { id },
      data: {
        ...(status !== undefined ? { status } : {}),
        ...(severity !== undefined ? { severity } : {}),
        ...(adminNote !== undefined ? { adminNote: adminNote || null } : {}),
      },
      include: { user: { select: { email: true } } },
    });

    await audit(admin.email, "admin.bug_update", {
      id,
      ...(status !== undefined ? { status } : {}),
    });

    return NextResponse.json({ report: toAdminBugRow(updated) });
  } catch (err) {
    console.error("[api/admin/bugs/[id]] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
