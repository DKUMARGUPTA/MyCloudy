import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { getSessionUser } from "@/lib/auth";
import { parseUserAgent } from "@/lib/analytics/ua";
import { clientIpFromHeaders, hashIp, resolveGeo } from "@/lib/analytics/geo";

/**
 * POST /api/analytics/view — first-party page-view tracking (R42, R60).
 *
 * Best-effort by contract (mirrors /api/usage): ALWAYS 202 `{ok:true}` —
 * invalid bodies, rate-limit overflow (60/min per visitor) and database
 * errors are swallowed silently; analytics must never break navigation.
 *
 * R60 upgrade — advanced visitor analytics for the owner console:
 *  - UA is parsed server-side into browser / OS / device / brand labels.
 *  - IP is geolocated (Vercel headers → cache → ipwho.is → ip-api.com)
 *    to coarse country/region/city; only a salted hash of the IP is kept.
 *  - Logged-in users are linked via the session cookie (optional).
 *  - A VisitorSession row is upserted per 30-minute activity window, so
 *    the admin console can show sessions, bounce rate and duration.
 * Owner-only surfaces (/admin, /accounting) are still rejected.
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
  /* R60 optional enrichments — old clients still validate fine. */
  screen: z.string().max(20).optional(),
  language: z.string().max(16).optional(),
  referrerHost: z.string().max(100).optional(),
});

/** Owner-only paths — never tracked, defense in depth (client skips too). */
function isOwnerSurface(path: string): boolean {
  return path === "/admin" || path === "/accounting";
}

/** Re-bucket the client referrer using the raw host when available. */
function referrerLabel(
  bucket: "direct" | "search" | "social" | "internal" | "other",
  host: string | undefined
): "direct" | "search" | "social" | "internal" | "other" {
  if (!host || bucket === "direct") return bucket;
  const h = host.replace(/^www\./, "").toLowerCase();
  if (/google|bing|duckduckgo|yahoo|ecosia|brave|yandex|baidu/.test(h)) return "search";
  if (/facebook|instagram|twitter|x\.com|linkedin|reddit|pinterest|t\.co|whatsapp|telegram|youtube|quora|threads/.test(h))
    return "social";
  return "other";
}

const SESSION_WINDOW_MS = 30 * 60_000; // 30-minute activity window

export async function POST(request: Request) {
  let sessionCreated = false;
  try {
    const json: unknown = await request.json();
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success || isOwnerSurface(parsed.data.path)) {
      return NextResponse.json({ ok: true }, { status: 202 });
    }

    const { path, locale, device, visitorId, screen, language, referrerHost } =
      parsed.data;
    const referrer = referrerLabel(parsed.data.referrer, referrerHost);

    // 60 page views / minute / visitor — overflow dropped, not reported.
    if (!rateLimit(`pv:${visitorId}`, 60, 60_000).ok) {
      return NextResponse.json({ ok: true }, { status: 202 });
    }

    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const now = new Date();

    /* Parallel best-effort enrichments — each has its own fallback. */
    const [user, geo] = await Promise.all([
      getSessionUser(request).catch(() => null),
      (async () => {
        try {
          const ip = clientIpFromHeaders(request.headers);
          if (!ip) return null;
          const g = await resolveGeo(ip);
          return { ...g, ipHash: hashIp(ip) };
        } catch {
          return null;
        }
      })(),
    ]);

    const ua = parseUserAgent(request.headers.get("user-agent"));
    // Client matchMedia class is the source of truth (iPads in "desktop site"
    // mode report as Mac in UA); the UA class only backs it up for bots.
    const deviceClass = device === "desktop" && ua.device !== "desktop" ? ua.device : device;

    /* Session upsert: reuse the visitor's open session (≤30 min since last
       activity), else start a new one. Geo + UA are resolved once per
       session; subsequent page views only bump lastSeen/pageviews. */
    let sessionId: string | null = null;
    let sessionCountry: string | null = null;
    let sessionCity: string | null = null;
    try {
      const recent = await db.visitorSession.findFirst({
        where: {
          visitorId,
          lastSeen: { gte: new Date(now.getTime() - SESSION_WINDOW_MS) },
        },
        orderBy: { lastSeen: "desc" },
      });

      if (recent) {
        await db.visitorSession.update({
          where: { id: recent.id },
          data: {
            lastSeen: now,
            pageviews: { increment: 1 },
            isBounce: false,
            userId: user?.id ?? recent.userId,
          },
        });
        sessionId = recent.id;
        sessionCountry = recent.country;
        sessionCity = recent.city;
      } else {
        const created = await db.visitorSession.create({
          data: {
            visitorId,
            userId: user?.id ?? null,
            ipHash: geo?.ipHash ?? "unknown",
            country: geo?.country ?? "unknown",
            countryName: geo?.countryName ?? "Unknown",
            region: geo?.region ?? null,
            city: geo?.city ?? null,
            timezone: geo?.timezone ?? null,
            browser: ua.browser,
            browserName: ua.browserName,
            os: ua.os,
            osName: ua.osName,
            device: deviceClass,
            deviceBrand: ua.deviceBrand,
            screen: screen ?? null,
            language: language ?? null,
            referrer,
            referrerHost: referrerHost ?? null,
            landingPath: path,
            pageviews: 1,
            isBounce: true,
            firstSeen: now,
            lastSeen: now,
            day,
          },
        });
        sessionId = created.id;
        sessionCountry = created.country;
        sessionCity = created.city;
        sessionCreated = true;
      }
    } catch {
      // Session bookkeeping failing must not block the page-view row.
    }

    try {
      await db.pageView.create({
        data: {
          path,
          locale,
          device: deviceClass,
          referrer,
          visitorId,
          day,
          sessionId,
          userId: user?.id ?? null,
          country: sessionCountry,
          city: sessionCity,
        },
      });
    } catch {
      // Swallow: page-view analytics are never worth a client-visible error.
    }
  } catch {
    // Even unparseable bodies succeed — this endpoint cannot fail.
  }
  return NextResponse.json({ ok: true, s: sessionCreated }, { status: 202 });
}
