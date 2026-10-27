import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getAdminUser } from "@/lib/auth";

/**
 * GET /api/admin/users?q=&page=&pageSize= — paginated user list for the
 * admin console. `q` matches email OR name (SQLite LIKE is ASCII
 * case-insensitive). Soft-deleted users are excluded. page is 1-based,
 * pageSize defaults to 20 and is capped at 50.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await getAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim();

    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
    const rawSize = Number.parseInt(url.searchParams.get("pageSize") ?? "20", 10) || 20;
    const pageSize = Math.min(50, Math.max(1, rawSize));

    const where = {
      deletedAt: null,
      ...(q ? { OR: [{ email: { contains: q } }, { name: { contains: q } }] } : {}),
    };

    const [rows, total] = await Promise.all([
      db.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: pageSize,
        skip: (page - 1) * pageSize,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          plan: true,
          bannedAt: true,
          createdAt: true,
        },
      }),
      db.user.count({ where }),
    ]);

    return NextResponse.json({
      users: rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        plan: u.plan,
        bannedAt: u.bannedAt ? u.bannedAt.toISOString() : null,
        createdAt: u.createdAt.toISOString(),
      })),
      total: Number(total),
      page,
      pageSize,
    });
  } catch (err) {
    console.error("[api/admin/users] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
