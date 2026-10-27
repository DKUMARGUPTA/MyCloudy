import { NextResponse } from "next/server";

import { getSessionUser, type SafeUser } from "@/lib/auth";

/**
 * GET /api/auth/me — resolve the signed-in user from the session cookie.
 *
 * Always 200 (never throws): `{ user: SafeUser | null }`. The client store
 * (auth-client.ts) bootstraps from this on every page load. Banned / deleted
 * / tokenVersion-stale cookies all resolve to `user: null` via getSessionUser.
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
        }
      : null;
    return NextResponse.json({ user });
  } catch (err) {
    console.error("[api/auth/me] failed", err);
    return NextResponse.json({ user: null });
  }
}
