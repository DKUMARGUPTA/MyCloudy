import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/analytics/view — first-party page-view tracking (R42).
 *
 * Best-effort by contract (mirrors /api/usage): ALWAYS 202 `{ok:true}` —
 * invalid bodies, rate-limit overflow (60/min per visitor) and database
 * errors are swallowed silently; analytics must never break navigation.
 *
 * Privacy (DPDP, mirrors the UsageEvent posture): aggregate metadata
 * only — no IP, no raw user agent, no cross-site identifiers. The
 * visitorId is the client-generated anonymous id already used by the
 * usage beacon + limit system; device is a coarse class; referrer is a
 * pre-bucketed label. Owner-only surfaces (/admin, /accounting) are
 * rejected server-side too, so the owner's own sessions never pollute
 * the data even if a stale client still sends them.
 */

export const dynamic = "force-dynamic";

const PATH_RE = /^\/[a-z0-9-]*(?:\/[a-z0-9-]+)*$/;

const bodySchema = z.object({
  /** Normalized app route: "/", "/tools", "/tool/merge-pdf", "/page/contact"… */
  path: z
    .string()
    .min(1)
    .max(120)
    .regex(PATH_RE, "path must be a normalized app route"),
  locale: z.enum(["en", "hi"]),
  device: z.enum(["mobile", "tablet", "desktop"]),
  referrer: z.enum(["direct", "search", "social", "internal", "other"]),
  visitorId: z.string().min(8).max(64),
});

/** Owner-only paths — never tracked, defense in depth (client skips too). */
function isOwnerSurface(path: string): boolean {
  return path === "/admin" || path === "/accounting";
}

export async function POST(request: Request) {
  try {
    const json: unknown = await request.json();
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success || isOwnerSurface(parsed.data.path)) {
      return NextResponse.json({ ok: true }, { status: 202 });
    }

    const { path, locale, device, referrer, visitorId } = parsed.data;

    // 60 page views / minute / visitor — overflow dropped, not reported.
    if (!rateLimit(`pv:${visitorId}`, 60, 60_000).ok) {
      return NextResponse.json({ ok: true }, { status: 202 });
    }

    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    try {
      await db.pageView.create({
        data: { path, locale, device, referrer, visitorId, day },
      });
    } catch {
      // Swallow: page-view analytics are never worth a client-visible error.
    }
  } catch {
    // Even unparseable bodies succeed — this endpoint cannot fail.
  }
  return NextResponse.json({ ok: true }, { status: 202 });
}
