import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  hashPassword,
  sessionCookieHeader,
  signSessionJwt,
  toSafeUser,
  verifyPassword,
} from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/auth/login — email + password → session cookie (stateless JWT).
 *
 * House rules: never-throw, JSON always, error codes only (client maps them
 * to i18n keys). Password verification runs a dummy scrypt when the email is
 * unknown so response timing does not reveal account existence.
 */

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
});

/** Pre-computed hash so the not-found path burns the same scrypt cost. */
const DUMMY_HASH = hashPassword("sidocs-timing-equalizer");

export async function POST(request: Request) {
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

  const ip = clientIp(request);
  const rl = rateLimit(`login:${ip}`, 10, 5 * 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } }
    );
  }

  const email = parsed.data.email.toLowerCase();
  const password = parsed.data.password;

  try {
    const user = await db.user.findFirst({
      where: { email, deletedAt: null },
    });

    const stored = user?.passwordHash ?? DUMMY_HASH;
    const ok = verifyPassword(password, stored);
    if (!user || !user.passwordHash || !ok) {
      return NextResponse.json(
        { error: "invalid_credentials" },
        { status: 401 }
      );
    }

    if (user.bannedAt) {
      return NextResponse.json({ error: "banned" }, { status: 403 });
    }

    return NextResponse.json(
      { user: toSafeUser(user) },
      {
        status: 200,
        headers: { "set-cookie": sessionCookieHeader(signSessionJwt(user)) },
      }
    );
  } catch (err) {
    console.error("[api/auth/login] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
