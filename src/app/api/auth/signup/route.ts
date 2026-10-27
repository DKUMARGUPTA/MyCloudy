import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  audit,
  hashPassword,
  isAdminEmail,
  sessionCookieHeader,
  signSessionJwt,
  toSafeUser,
} from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/auth/signup — create an account (name optional).
 *
 * Gates: registration flag (SiteSetting "site_flags"), unique email among
 * non-deleted users, password >= 8 chars. Whitelisted ADMIN_EMAILS are
 * auto-promoted to role "admin". Audit: "user.signup".
 */

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  name: z.string().trim().max(80).optional(),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(200),
});

async function registrationOpen(): Promise<boolean> {
  try {
    const row = await db.siteSetting.findUnique({ where: { key: "site_flags" } });
    if (!row) return true; // missing row = open (default)
    const flags = JSON.parse(row.valueJson) as { registrationOpen?: unknown };
    if (typeof flags.registrationOpen === "boolean") {
      return flags.registrationOpen;
    }
    return true;
  } catch {
    return true; // unparseable row = open (fail-open on purpose: signup gate)
  }
}

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    const pwIssue = parsed.error.issues.some(
      (i) => i.path.length === 1 && i.path[0] === "password"
    );
    if (pwIssue) {
      return NextResponse.json({ error: "weak_password" }, { status: 400 });
    }
    const emailIssue = parsed.error.issues.some(
      (i) => i.path.length === 1 && i.path[0] === "email"
    );
    if (emailIssue) {
      return NextResponse.json({ error: "invalid_email" }, { status: 400 });
    }
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const ip = clientIp(request);
  const rl = rateLimit(`signup:${ip}`, 5, 10 * 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } }
    );
  }

  const email = parsed.data.email.toLowerCase();

  try {
    if (!(await registrationOpen())) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const existing = await db.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json({ error: "email_taken" }, { status: 409 });
    }

    const user = await db.user.create({
      data: {
        email,
        name: parsed.data.name || null,
        passwordHash: hashPassword(parsed.data.password),
        role: isAdminEmail(email) ? "admin" : "user",
      },
    });

    await audit(email, "user.signup", { userId: user.id });

    return NextResponse.json(
      { user: toSafeUser(user) },
      {
        status: 201,
        headers: { "set-cookie": sessionCookieHeader(signSessionJwt(user)) },
      }
    );
  } catch (err) {
    // Unique-constraint race (concurrent signups / soft-deleted email reuse).
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json({ error: "email_taken" }, { status: 409 });
    }
    console.error("[api/auth/signup] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
