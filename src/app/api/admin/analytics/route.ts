import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { gateAdmin } from "@/lib/api-auth";

/**
 * GET /api/admin/analytics — the owner's first-party analytics feed (R42).
 *
 * Two data sources, both privacy-first (no IP, no raw UA, no cross-site
 * identifiers — see the PageView / UsageEvent models):
 *  - PageView rows: page views + unique visitors (per anonymous
 *    per-browser id), top pages, referrer buckets, device classes, locales.
 *  - UsageEvent rows: tool runs, success rate, average duration, per-tool
 *    health — the "what do people actually DO" half of behavior analysis.
 *
 * Windows: today + 7d + 30d for the headline cards; 30d for every
 * breakdown; daily series (views + unique visitors) for the trend chart.
 */

export const dynamic = "force-dynamic";

function dayString(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export async function GET(request: Request) {
  const gate = await gateAdmin(request);
  if (gate.reject) return gate.reject;

  try {
    const today = dayString(0);
    const d7 = dayString(7);
    const d30 = dayString(30);

    const [
      viewsToday,
      visitorsToday,
      views7,
      views30,
      visitors7,
      visitors30,
      byDay,
      byDayVisitor,
      byPath,
      byReferrer,
      byDevice,
      byLocale,
      usage30,
      usageSuccess30,
      usageDuration30,
      usageByTool,
      usageByToolSuccess,
    ] = await Promise.all([
      db.pageView.count({ where: { day: today } }),
      db.pageView.groupBy({
        by: ["visitorId"],
        where: { day: today },
        _count: { visitorId: true },
      }),
      db.pageView.count({ where: { day: { gte: d7 } } }),
      db.pageView.count({ where: { day: { gte: d30 } } }),
      db.pageView.groupBy({
        by: ["visitorId"],
        where: { day: { gte: d7 } },
        _count: { visitorId: true },
      }),
      db.pageView.groupBy({
        by: ["visitorId"],
        where: { day: { gte: d30 } },
        _count: { visitorId: true },
      }),
      db.pageView.groupBy({
        by: ["day"],
        where: { day: { gte: d30 } },
        _count: { day: true },
      }),
      db.pageView.groupBy({
        by: ["day", "visitorId"],
        where: { day: { gte: d30 } },
        _count: { _all: true },
      }),
      db.pageView.groupBy({
        by: ["path"],
        where: { day: { gte: d30 } },
        _count: { path: true },
      }),
      db.pageView.groupBy({
        by: ["referrer"],
        where: { day: { gte: d30 } },
        _count: { referrer: true },
      }),
      db.pageView.groupBy({
        by: ["device"],
        where: { day: { gte: d30 } },
        _count: { device: true },
      }),
      db.pageView.groupBy({
        by: ["locale"],
        where: { day: { gte: d30 } },
        _count: { locale: true },
      }),
      db.usageEvent.count({ where: { day: { gte: d30 } } }),
      db.usageEvent.count({
        where: { day: { gte: d30 }, success: true },
      }),
      db.usageEvent.aggregate({
        where: { day: { gte: d30 } },
        _avg: { durationMs: true },
      }),
      db.usageEvent.groupBy({
        by: ["toolId"],
        where: { day: { gte: d30 } },
        _count: { toolId: true },
      }),
      db.usageEvent.groupBy({
        by: ["toolId"],
        where: { day: { gte: d30 }, success: true },
        _count: { toolId: true },
      }),
    ]);

    /* Daily series with zero-filled last 30 days (oldest → newest). */
    const viewsByDay = new Map(byDay.map((g) => [g.day, Number(g._count.day)]));
    const uniqueByDay = new Map<string, Set<string>>();
    for (const row of byDayVisitor) {
      const set = uniqueByDay.get(row.day) ?? new Set<string>();
      set.add(row.visitorId);
      uniqueByDay.set(row.day, set);
    }
    const series: Array<{ day: string; views: number; visitors: number }> = [];
    for (let i = 29; i >= 0; i--) {
      const day = dayString(i);
      series.push({
        day,
        views: viewsByDay.get(day) ?? 0,
        visitors: uniqueByDay.get(day)?.size ?? 0,
      });
    }

    const successByTool = new Map(
      usageByToolSuccess.map((g) => [g.toolId, Number(g._count.toolId)])
    );
    const topTools = usageByTool
      .map((g) => {
        const runs = Number(g._count.toolId);
        const ok = successByTool.get(g.toolId) ?? 0;
        return {
          toolId: g.toolId,
          runs,
          successRate: runs > 0 ? Math.round((ok / runs) * 100) : 0,
        };
      })
      .sort((a, b) => b.runs - a.runs)
      .slice(0, 8);

    const labelCounts = (
      rows: Array<Record<string, unknown>>,
      key: string
    ): Array<{ label: string; count: number }> =>
      rows.map((g) => ({
        label: String(g[key]),
        count: Number(
          (g as { _count: Record<string, number> })._count[key] ?? 0
        ),
      }));

    return NextResponse.json({
      viewsToday: Number(viewsToday),
      visitorsToday: visitorsToday.length,
      views7d: Number(views7),
      visitors7d: visitors7.length,
      views30d: Number(views30),
      visitors30d: visitors30.length,
      series,
      topPages: labelCounts(byPath, "path")
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      referrers: labelCounts(byReferrer, "referrer").sort(
        (a, b) => b.count - a.count
      ),
      devices: labelCounts(byDevice, "device").sort(
        (a, b) => b.count - a.count
      ),
      locales: labelCounts(byLocale, "locale").sort(
        (a, b) => b.count - a.count
      ),
      tools: {
        runs30d: Number(usage30),
        successRate30d:
          usage30 > 0 ? Math.round((usageSuccess30 / usage30) * 100) : 0,
        avgDurationMs: Math.round(usageDuration30._avg.durationMs ?? 0),
        top: topTools,
      },
    });
  } catch (err) {
    console.error("[api/admin/analytics] failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
