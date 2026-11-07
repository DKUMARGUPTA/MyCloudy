import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getSessionUser, toSafeUser, type SafeUser } from "@/lib/auth";

/**
 * GET /api/auth/me — resolve the signed-in user from the session cookie.
 *
 * Always 200 (never throws): `{ user: SafeUser | null }`. The client store
 * (auth-client.ts) bootstraps from this on every page load. Banned / deleted
 * / tokenVersion-stale cookies all resolve to `user: null` via getSessionUser.
 *
 * PATCH /api/auth/me (R60) — update the optional profile birth year.
 * `{ birthYear: number | null }` (1900..currentYear, or null to clear).
 * The birth year powers the admin age-group analytics; it is optional,
 * never shown publicly, and can be removed at any time.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await getSessionUser(request);
    const user: SafeUser | null = session
      ? {
          id: session.id,
          email: session.email,
          name: session.name,
          role: session.role,
          plan: session.plan,
          locale: session.locale,
          createdAt: session.createdAt,
          birthYear: session.birthYear ?? null,
        }
      : null;
    return NextResponse.json({ user });
  } catch (err) {
    console.error("[api/auth/me] failed", err);
    return NextResponse.json({ user: null });
  }
}

const patchSchema = z.object({
  birthYear: z
    .number()
    .int()
    .min(1900)
    .max(new Date().getUTCFullYear())
    .nullable(),
});

export async function PATCH(request: Request) {
  try {
    const session = await getSessionUser(request);
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const json: unknown = await request.json().catch(() => null);
    const parsed = patchSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const updated = await db.user.update({
      where: { id: session.id },
      data: { birthYear: parsed.data.birthYear },
    });

    return NextResponse.json({
      user: toSafeUser({
        ...updated,
        createdAt: updated.createdAt,
      }),
    });
  } catch (err) {
    console.error("[api/auth/me PATCH] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
