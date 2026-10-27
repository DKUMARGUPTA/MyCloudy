import { NextResponse } from "next/server";

import { clearSessionCookieHeader } from "@/lib/auth";

/**
 * POST /api/auth/logout — clear the session cookie.
 *
 * Stateless JWT → logout is purely cookie removal. Works signed-out too
 * (idempotent): always 200 `{ok:true}`.
 */

export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    { ok: true },
    { headers: { "set-cookie": clearSessionCookieHeader() } }
  );
}
