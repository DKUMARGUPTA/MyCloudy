import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { audit, clearSessionCookieHeader, verifyPassword } from "@/lib/auth";
import { gateUser } from "@/lib/api-auth";

/**
 * POST /api/auth/delete — self-service account deletion (soft delete).
 *
 * Requires the current password. Sets deletedAt (account hidden from lists,
 * login and session resolution) and bumps tokenVersion so every live JWT
 * dies immediately; cookie is cleared. Audit: "user.self_delete".
 */

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  password: z.string().min(1).max(200),
});

export async function POST(request: Request) {
  const gate = await gateUser(request);
  if (gate.reject) return gate.reject;
  const session = gate.user;

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
    const user = await db.user.findUnique({ where: { id: session.id } });
    if (!user || !user.passwordHash) {
      return NextResponse.json({ error: "forbidden" }, { status: 401 });
    }

    if (!verifyPassword(parsed.data.password, user.passwordHash)) {
      return NextResponse.json(
        { error: "invalid_credentials" },
        { status: 401 }
      );
    }

    await db.user.update({
      where: { id: user.id },
      data: { deletedAt: new Date(), tokenVersion: { increment: 1 } },
    });

    await audit(session.email, "user.self_delete", { userId: user.id });

    return NextResponse.json(
      { ok: true },
      { headers: { "set-cookie": clearSessionCookieHeader() } }
    );
  } catch (err) {
    console.error("[api/auth/delete] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
