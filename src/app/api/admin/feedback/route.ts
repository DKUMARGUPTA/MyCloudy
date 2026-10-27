import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getAdminUser } from "@/lib/auth";

/**
 * GET /api/admin/feedback — thumbs feedback browser for the admin console.
 *
 * Newest first, max 200 items. The public POST stores reason + free text as
 * a single "reason · message" note; the known reason enums are split back
 * out here so the UI can badge them. upCount/downCount are whole-table
 * totals (dashboard overview), independent of the 200-item window.
 */

export const dynamic = "force-dynamic";

const REASONS = ["slow", "wrong", "confusing", "other"] as const;

function splitNote(
  note: string | null
): { reason: string | null; message: string | null } {
  if (!note) return { reason: null, message: null };
  for (const r of REASONS) {
    if (note === r) return { reason: r, message: null };
    const prefix = `${r} · `;
    if (note.startsWith(prefix)) {
      return { reason: r, message: note.slice(prefix.length) || null };
    }
  }
  return { reason: null, message: note };
}

export async function GET(request: Request) {
  const admin = await getAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const [rows, upCount, downCount] = await Promise.all([
      db.feedback.findMany({
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      db.feedback.count({ where: { rating: { gt: 0 } } }),
      db.feedback.count({ where: { rating: { lt: 0 } } }),
    ]);

    return NextResponse.json({
      items: rows.map((f) => {
        const { reason, message } = splitNote(f.message);
        return {
          id: f.id,
          toolId: f.toolId,
          rating: f.rating,
          reason,
          message,
          createdAt: f.createdAt.toISOString(),
        };
      }),
      upCount: Number(upCount),
      downCount: Number(downCount),
    });
  } catch (err) {
    console.error("[api/admin/feedback] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
