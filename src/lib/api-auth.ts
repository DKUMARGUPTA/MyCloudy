import { NextResponse } from "next/server";

import { getAdminUser, getSessionUser, type AuthUser } from "@/lib/auth";

/**
 * API-route auth gates (R19 audit P2-4).
 *
 * Every route used to resolve its session/admin BEFORE the try/catch
 * guarding the rest of the handler, so a transient DB failure (or a
 * missing AUTH_SECRET in production) escaped the handler and Next.js
 * answered with its default HTML 500 page — breaking the JSON error
 * contract those routes otherwise keep. The gates fold resolution into
 * the same { error: "server_error" } JSON 500 the route bodies already
 * return, while keeping the existing 401/403 "forbidden" semantics
 * byte-identical.
 */

export type AuthGate =
  | { user: AuthUser; reject: null }
  | { user: null; reject: NextResponse };

/** Signed-in user, or a ready-to-return 401 (unauthenticated) / 500
 * (resolution itself failed — DB down, bad env) JSON response. */
export async function gateUser(request: Request): Promise<AuthGate> {
  try {
    const user = await getSessionUser(request);
    if (user) return { user, reject: null };
    return {
      user: null,
      reject: NextResponse.json({ error: "forbidden" }, { status: 401 }),
    };
  } catch (err) {
    console.error("[api-auth] session resolution failed", err);
    return {
      user: null,
      reject: NextResponse.json({ error: "server_error" }, { status: 500 }),
    };
  }
}

/** Admin-only guard, or a ready-to-return 403 (not admin) / 500
 * (resolution itself failed) JSON response. */
export async function gateAdmin(request: Request): Promise<AuthGate> {
  try {
    const user = await getAdminUser(request);
    if (user) return { user, reject: null };
    return {
      user: null,
      reject: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    };
  } catch (err) {
    console.error("[api-auth] admin resolution failed", err);
    return {
      user: null,
      reject: NextResponse.json({ error: "server_error" }, { status: 500 }),
    };
  }
}
