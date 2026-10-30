import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { gateAdmin } from "@/lib/api-auth";

/**
 * GET /api/admin/stats — dashboard overview for the admin console.
 *
 * Counts: live users, new/open bugs, new contact messages, feedback rows,
 * today's tool usage; plus 7-day top tools and the 5 latest signups.
 */

export const dynamic = "force-dynamic";

function dayString(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export async function GET(request: Request) {
  const gate = await gateAdmin(request);
  if (gate.reject) return gate.reject;
  const admin = gate.user;

  try {
    const today = dayString(0);

    const [
      users,
      bugsNew,
      bugsOpen,
      messagesNew,
      feedbackCount,
      usageToday,
      grouped,
      recent,
    ] = await Promise.all([
      db.user.count({ where: { deletedAt: null } }),
      db.bugReport.count({ where: { status: "new" } }),
      db.bugReport.count({
        where: { status: { in: ["new", "confirmed", "in_progress"] } },
      }),
      db.contactMessage.count({ where: { status: "new" } }),
      db.feedback.count(),
      db.usageEvent.count({ where: { day: today } }),
      db.usageEvent.groupBy({
        by: ["toolId"],
        where: { day: { gte: dayString(7) } },
        _count: { toolId: true },
      }),
      db.user.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { email: true, name: true, createdAt: true },
      }),
    ]);

    const topTools = grouped
      .map((g) => ({ toolId: g.toolId, count: Number(g._count.toolId) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    return NextResponse.json({
      users: Number(users),
      bugsNew: Number(bugsNew),
      bugsOpen: Number(bugsOpen),
      messagesNew: Number(messagesNew),
      feedbackCount: Number(feedbackCount),
      usageToday: Number(usageToday),
      topTools,
      recentSignups: recent.map((u) => ({
        email: u.email ?? "—",
        name: u.name,
        createdAt: u.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error("[api/admin/stats] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
