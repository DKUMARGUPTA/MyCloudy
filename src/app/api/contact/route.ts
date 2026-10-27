import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";

/**
 * POST /api/contact — contact form (PRD §5.4 contact_messages table).
 *
 * Privacy rules: name, email, category and message only. No IP storage,
 * no user agent — the rate limiter keeps request timestamps in memory
 * (never persisted) and the honeypot field must stay empty (bots fill
 * it). The submitted message text is the only free-form data and it is
 * stored solely to answer the enquiry (DPDP purpose limitation).
 */

const bodySchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "name too short")
    .max(100, "name too long"),
  email: z
    .string()
    .trim()
    .email("invalid email")
    .max(254, "email too long"),
  category: z
    .enum(["bug", "feature", "billing", "business", "legal", "other"])
    .optional()
    .default("other"),
  message: z
    .string()
    .trim()
    .min(10, "message too short")
    .max(5000, "message too long"),
  /** Consent checkbox state — must be true to store the message. */
  consent: z.literal(true),
  /** Honeypot — must be absent or empty. */
  hp: z.string().max(0).optional(),
});

/** In-memory sliding-window rate limiter: 5 posts / minute / IP. */
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter(
    (time) => now - time < RATE_WINDOW_MS
  );
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 1000) {
    // Trim stale entries so the map never grows unbounded.
    for (const [key, times] of hits) {
      if (times.every((time) => now - time >= RATE_WINDOW_MS)) {
        hits.delete(key);
      }
    }
  }
  return false;
}

/** Ticket id like "SDC-7F3A9C21" — reference it in follow-up emails. */
function makeTicketId(): string {
  return `SDC-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid-json" },
      { status: 400 }
    );
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid-body" },
      { status: 400 }
    );
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (rateLimited(ip)) {
    return NextResponse.json(
      { ok: false, error: "rate-limited" },
      { status: 429 }
    );
  }

  const { name, email, category, message } = parsed.data;

  try {
    const ticket = makeTicketId();
    await db.contactMessage.create({
      data: {
        id: ticket,
        name,
        email,
        category,
        message,
      },
    });
    return NextResponse.json({ ok: true, ticket });
  } catch {
    // Best-effort endpoint: never leak database errors to the client.
    return NextResponse.json(
      { ok: false, error: "store-failed" },
      { status: 500 }
    );
  }
}

export function GET() {
  return NextResponse.json(
    { ok: false, error: "method-not-allowed" },
    { status: 405 }
  );
}
