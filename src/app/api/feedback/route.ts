import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";

/**
 * POST /api/feedback — result-page rating (PRD §2.5 feedback table).
 *
 * Privacy rules: tool id + rating + optional reason only. No file names,
 * no file contents, no user agent, no IP storage — the rate limiter keeps
 * request timestamps in memory (never persisted) and the honeypot field
 * must stay empty (bots fill it). Metadata-light by design (DPDP-friendly).
 */

const bodySchema = z.object({
  toolId: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/, "invalid tool id"),
  rating: z.union([z.literal(1), z.literal(-1)]),
  reason: z
    .enum(["slow", "wrong", "confusing", "other"])
    .optional(),
  message: z.string().max(500).optional(),
  /** Honeypot — must be absent or empty. */
  hp: z.string().max(0).optional(),
});

/** In-memory sliding-window rate limiter: 10 posts / minute / IP. */
const RATE_LIMIT = 10;
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

export async function POST(request: Request) {
  // R43 security order: throttle BEFORE parsing — every attempt counts
  // toward the window (DoS hardening; was: 400 short-circuited first).
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (rateLimited(ip)) {
    return NextResponse.json(
      { ok: false, error: "rate-limited" },
      { status: 429 }
    );
  }

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

  const { toolId, rating, reason, message } = parsed.data;
  const note =
    [reason, message].filter((part) => part !== undefined).join(" · ") || null;

  try {
    await db.feedback.create({
      data: {
        toolId,
        rating,
        message: note,
      },
    });
  } catch {
    // Best-effort endpoint: the UI never blocks the result flow on this.
    return NextResponse.json({ ok: true, stored: false });
  }

  return NextResponse.json({ ok: true, stored: true });
}

export function GET() {
  return NextResponse.json(
    { ok: false, error: "method-not-allowed" },
    { status: 405 }
  );
}
