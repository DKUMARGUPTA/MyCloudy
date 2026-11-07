import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { gateAdmin } from "@/lib/api-auth";

/**
 * GET /api/admin/visitors — the advanced visitor analytics feed (R60).
 *
 * Data source: VisitorSession rows (one per 30-min visit) joined with
 * User for identity + age. Supports the full filter grammar the owner
 * console needs:
 *   range=today|yesterday|7d|30d|90d|all|custom (from=YYYY-MM-DD&to=…)
 *   country=IN | city=… | device=mobile/tablet/desktop | browser=chrome
 *   os=android | userType=all|known|anon | referrer=search | locale=en|hi
 *   q=<search user email/name/visitorId> | minViews=<n>
 *
 * Returns: KPIs (visitors, sessions, views, bounce, avg duration), a daily
 * series, every breakdown (country/city/device/browser/os/age/referrer/
 * pages), the filter option lists, and a "recent sessions" table with the
 * visitor's identity + age when known.
 */

export const dynamic = "force-dynamic";

type Range = "today" | "yesterday" | "7d" | "30d" | "90d" | "all" | "custom";

function dayString(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Range → {fromDay, toDay} (inclusive, UTC YYYY-MM-DD). */
function rangeDays(
  range: Range,
  from?: string,
  to?: string
): { from: string; to: string } {
  const today = dayString(0);
  switch (range) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = dayString(1);
      return { from: y, to: y };
    }
    case "7d":
      return { from: dayString(6), to: today };
    case "30d":
      return { from: dayString(29), to: today };
    case "90d":
      return { from: dayString(89), to: today };
    case "all":
      return { from: "2000-01-01", to: today };
    case "custom":
      return {
        from: /^\d{4}-\d{2}-\d{2}$/.test(from ?? "") ? from! : dayString(29),
        to: /^\d{4}-\d{2}-\d{2}$/.test(to ?? "") ? to! : today,
      };
  }
}

const CURRENT_YEAR = new Date().getUTCFullYear();

/** Birth year → age bracket label (for the age-groups chart). */
function ageGroup(birthYear: number | null | undefined): string {
  if (!birthYear || birthYear < 1900 || birthYear > CURRENT_YEAR) return "unknown";
  const age = CURRENT_YEAR - birthYear;
  if (age < 13) return "0-12";
  if (age < 18) return "13-17";
  if (age < 25) return "18-24";
  if (age < 35) return "25-34";
  if (age < 45) return "35-44";
  if (age < 55) return "45-54";
  if (age < 65) return "55-64";
  return "65+";
}

const NUM = (v: string | null): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const STR = (v: string | null): string | undefined =>
  v && v.length > 0 && v !== "all" ? v.slice(0, 100) : undefined;

export async function GET(request: Request) {
  const gate = await gateAdmin(request);
  if (gate.reject) return gate.reject;

  const url = new URL(request.url);
  const range = (url.searchParams.get("range") ?? "30d") as Range;
  const { from, to } = rangeDays(
    range,
    url.searchParams.get("from") ?? undefined,
    url.searchParams.get("to") ?? undefined
  );

  const country = STR(url.searchParams.get("country"));
  const city = STR(url.searchParams.get("city"));
  const device = STR(url.searchParams.get("device"));
  const browser = STR(url.searchParams.get("browser"));
  const os = STR(url.searchParams.get("os"));
  const referrer = STR(url.searchParams.get("referrer"));
  const userType = url.searchParams.get("userType") ?? "all"; // all|known|anon
  const q = STR(url.searchParams.get("q"));
  const minViews = NUM(url.searchParams.get("minViews"));

  try {
    /* ── Base session where-clause from the filters ────────────────────── */
    const where: Prisma.VisitorSessionWhereInput = {
      day: { gte: from, lte: to },
    };
    if (country) where.country = country;
    if (city) where.city = city;
    if (device) where.device = device;
    if (browser) where.browserName = browser;
    if (os) where.osName = os;
    if (referrer) where.referrer = referrer;
    if (userType === "known") where.userId = { not: null };
    if (userType === "anon") where.userId = null;
    if (minViews != null) where.pageviews = { gte: minViews };
    if (q) {
      where.OR = [
        { user: { email: { contains: q } } },
        { user: { name: { contains: q } } },
        { visitorId: { contains: q } },
        { city: { contains: q } },
        { landingPath: { contains: q } },
      ];
    }

    const [
      agg,
      bounceCount,
      byDay,
      byCountry,
      byCity,
      byDevice,
      byBrowser,
      byOs,
      byReferrer,
      byLanguage,
      topPaths,
      recent,
      uniqueVisitors,
      knownSessions,
      optCountries,
      optCities,
      optBrowsers,
      optOs,
    ] = await Promise.all([
      db.visitorSession.aggregate({
        where,
        _count: { _all: true },
        _sum: { pageviews: true },
      }),
      db.visitorSession.count({ where: { ...where, isBounce: true } }),
      db.visitorSession.groupBy({
        by: ["day"],
        where,
        _count: { _all: true },
        _sum: { pageviews: true },
      }),
      db.visitorSession.groupBy({
        by: ["country", "countryName"],
        where,
        _count: { _all: true },
      }),
      db.visitorSession.groupBy({
        by: ["city"],
        where: { ...where, city: { not: null } },
        _count: { _all: true },
      }),
      db.visitorSession.groupBy({ by: ["device"], where, _count: { _all: true } }),
      db.visitorSession.groupBy({
        by: ["browserName", "browser"],
        where,
        _count: { _all: true },
      }),
      db.visitorSession.groupBy({
        by: ["osName", "os"],
        where,
        _count: { _all: true },
      }),
      db.visitorSession.groupBy({ by: ["referrer"], where, _count: { _all: true } }),
      db.visitorSession.groupBy({
        by: ["language"],
        where,
        _count: { _all: true },
      }),
      db.visitorSession.groupBy({
        by: ["landingPath"],
        where,
        _count: { _all: true },
      }),
      /* Recent sessions (newest first) with identity + age */
      db.visitorSession.findMany({
        where,
        orderBy: { lastSeen: "desc" },
        take: 25,
        include: {
          user: { select: { email: true, name: true, birthYear: true, plan: true } },
        },
      }),
      /* Distinct visitors (unique visitorId) among filtered sessions */
      db.visitorSession.groupBy({ by: ["visitorId"], where }),
      /* Known-user sessions (capped) → age-group tally */
      db.visitorSession.findMany({
        where: { ...where, userId: { not: null } },
        select: { userId: true },
        take: 2000,
      }),
      /* Option lists for the filter dropdowns (all-time, stable UI) */
      db.visitorSession.groupBy({
        by: ["country", "countryName"],
        orderBy: { _count: { country: "desc" } },
        take: 60,
      }),
      db.visitorSession.groupBy({
        by: ["city"],
        where: { city: { not: null } },
        orderBy: { _count: { city: "desc" } },
        take: 100,
      }),
      db.visitorSession.groupBy({
        by: ["browserName"],
        orderBy: { _count: { browserName: "desc" } },
        take: 20,
      }),
      db.visitorSession.groupBy({
        by: ["osName"],
        orderBy: { _count: { osName: "desc" } },
        take: 20,
      }),
    ]);

    /* ── Age groups from known users ─────────────────────────────────── */
    const userIds = [...new Set(knownSessions.map((s) => s.userId!))];
    const users = await db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, birthYear: true },
    });
    const birthYearById = new Map(users.map((u) => [u.id, u.birthYear]));
    const ageTally = new Map<string, number>();
    for (const s of knownSessions) {
      const g = ageGroup(birthYearById.get(s.userId!));
      ageTally.set(g, (ageTally.get(g) ?? 0) + 1);
    }

    /* ── Daily series (zero-filled, oldest → newest, capped at 90 days) ─ */
    const sessionsByDay = new Map(byDay.map((g) => [g.day, Number(g._count._all)]));
    const viewsByDay = new Map(byDay.map((g) => [g.day, Number(g._sum.pageviews ?? 0)]));
    const series: Array<{ day: string; sessions: number; views: number }> = [];
    const daysSpan = Math.min(
      90,
      Math.max(
        1,
        Math.round(
          (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000
        ) + 1
      )
    );
    for (let i = daysSpan - 1; i >= 0; i--) {
      const day = new Date(Date.parse(to + "T00:00:00Z") - i * 86_400_000)
        .toISOString()
        .slice(0, 10);
      series.push({
        day,
        sessions: sessionsByDay.get(day) ?? 0,
        views: viewsByDay.get(day) ?? 0,
      });
    }

    /* ── Avg session duration (minutes, from recent rows, capped 24h) ── */
    let durationSumMs = 0;
    let durationCount = 0;
    for (const s of recent) {
      const ms = s.lastSeen.getTime() - s.firstSeen.getTime();
      if (ms > 0 && ms < 24 * 3600_000) {
        durationSumMs += ms;
        durationCount++;
      }
    }
    const avgSessionMin =
      durationCount > 0 ? Number((durationSumMs / durationCount / 60_000).toFixed(1)) : 0;

    const sessionsTotal = Number(agg._count._all) || 0;
    const viewsTotal = Number(agg._sum.pageviews ?? 0);
    const knownSessionsCount = knownSessions.length;

    return NextResponse.json({
      range: { kind: range, from, to },
      kpis: {
        visitors: uniqueVisitors.length,
        sessions: sessionsTotal,
        pageviews: viewsTotal,
        avgPagesPerSession:
          sessionsTotal > 0 ? Number((viewsTotal / sessionsTotal).toFixed(1)) : 0,
        bounceRate:
          sessionsTotal > 0 ? Math.round((bounceCount / sessionsTotal) * 100) : 0,
        knownSessions: knownSessionsCount,
        avgSessionMin,
        countries: byCountry.length,
      },
      series,
      countries: byCountry
        .map((g) => ({
          label: String(g.country),
          name: String(g.countryName),
          count: Number(g._count._all),
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 15),
      cities: byCity
        .map((g) => ({ label: String(g.city), count: Number(g._count._all) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 15),
      devices: byDevice
        .map((g) => ({ label: String(g.device), count: Number(g._count._all) }))
        .sort((a, b) => b.count - a.count),
      browsers: byBrowser
        .map((g) => ({
          label: String(g.browser),
          name: String(g.browserName),
          count: Number(g._count._all),
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      osList: byOs
        .map((g) => ({
          label: String(g.os),
          name: String(g.osName),
          count: Number(g._count._all),
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      referrers: byReferrer
        .map((g) => ({ label: String(g.referrer), count: Number(g._count._all) }))
        .sort((a, b) => b.count - a.count),
      languages: byLanguage
        .map((g) => ({
          label: String(g.language ?? "unknown"),
          count: Number(g._count._all),
        }))
        .sort((a, b) => b.count - a.count),
      topPages: topPaths
        .map((g) => ({ label: String(g.landingPath), count: Number(g._count._all) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      ageGroups: [...ageTally.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      sessions: recent.map((s) => ({
        id: s.id,
        visitor: s.user
          ? {
              email: s.user.email,
              name: s.user.name,
              plan: s.user.plan,
              age: s.user.birthYear ? CURRENT_YEAR - s.user.birthYear : null,
            }
          : null,
        visitorId: s.visitorId,
        country: s.country,
        countryName: s.countryName,
        region: s.region,
        city: s.city,
        timezone: s.timezone,
        browser: s.browser,
        os: s.os,
        device: s.device,
        deviceBrand: s.deviceBrand,
        screen: s.screen,
        language: s.language,
        referrer: s.referrer,
        referrerHost: s.referrerHost,
        landingPath: s.landingPath,
        pageviews: s.pageviews,
        isBounce: s.isBounce,
        firstSeen: s.firstSeen.toISOString(),
        lastSeen: s.lastSeen.toISOString(),
        durationMin: Number(
          Math.min(
            (s.lastSeen.getTime() - s.firstSeen.getTime()) / 60_000,
            1440
          ).toFixed(1)
        ),
      })),
      filters: {
        countries: optCountries.map((g) => ({
          code: String(g.country),
          name: String(g.countryName),
        })),
        cities: optCities.map((g) => String(g.city)),
        browsers: optBrowsers.map((g) => String(g.browserName)),
        os: optOs.map((g) => String(g.osName)),
      },
    });
  } catch (err) {
    console.error("[api/admin/visitors] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
