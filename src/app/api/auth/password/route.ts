import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  audit,
  getSessionUser,
  hashPassword,
  sessionCookieHeader,
  signSessionJwt,
  verifyPassword,
} from "@/lib/auth";

/**
 * POST /api/auth/password — change password for the signed-in user.
 *
 * Verifies the current password, bumps tokenVersion (force logout on every
 * device), then re-issues a fresh cookie for THIS device so the user stays
 * signed in here. Audit: "user.password_change".
 */

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});

export async function POST(request: Request) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    const pwIssue = parsed.error.issues.some(
      (i) => i.path.length === 1 && i.path[0] === "newPassword"
    );
    return NextResponse.json(
      { error: pwIssue ? "weak_password" : "bad_request" },
      { status: 400 }
    );
  }

  const { currentPassword, newPassword } = parsed.data;

  try {
    const user = await db.user.findUnique({ where: { id: session.id } });
    if (!user || !user.passwordHash) {
      return NextResponse.json({ error: "forbidden" }, { status: 401 });
    }

    if (!verifyPassword(currentPassword, user.passwordHash)) {
      return NextResponse.json(
        { error: "invalid_credentials" },
        { status: 401 }
      );
    }

    const updated = await db.user.update({
      where: { id: user.id },
      data: {
        passwordHash: hashPassword(newPassword),
        tokenVersion: { increment: 1 },
      },
    });

    await audit(session.email, "user.password_change", { userId: user.id });

    return NextResponse.json(
      { ok: true },
      {
        status: 200,
        headers: {
          "set-cookie": sessionCookieHeader(signSessionJwt(updated)),
        },
      }
    );
  } catch (err) {
    console.error("[api/auth/password] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
