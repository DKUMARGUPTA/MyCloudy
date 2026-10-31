"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  BarChart3,
  CheckCircle2,
  Eye,
  ExternalLink,
  Gauge,
  Globe,
  Laptop,
  MonitorSmartphone,
  Smartphone,
  Tablet,
  Timer,
  TrendingUp,
  Users,
  Wrench,
} from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/doco/empty-state";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { fetchAnalytics, type AdminAnalyticsDto } from "@/lib/admin-client";
import { StatCard } from "@/components/doco/admin/shared";

/**
 * AnalyticsTab — the owner's first-party visitor + behavior console
 * (R42). Everything here is aggregate, anonymous metadata collected by
 * /api/analytics/view (PageView rows) and /api/usage (UsageEvent rows):
 * views, unique visitors, traffic sources, devices, locales, top pages
 * and per-tool health — the "what do people do" half of product
 * improvement, without any IP / UA / cross-site tracking.
 */

const REFERRER_LABEL_KEY: Record<string, string> = {
  direct: "admin.analytics.refDirect",
  search: "admin.analytics.refSearch",
  social: "admin.analytics.refSocial",
  internal: "admin.analytics.refInternal",
  other: "admin.analytics.refOther",
};

const DEVICE_ICON: Record<string, typeof Laptop> = {
  desktop: MonitorSmartphone,
  mobile: Smartphone,
  tablet: Tablet,
};

function fmtNum(n: number, locale: string): string {
  return n.toLocaleString(locale === "hi" ? "hi-IN" : "en-IN");
}

export function AnalyticsTab() {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [data, setData] = useState<AdminAnalyticsDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    void fetchAnalytics().then((res) => {
      if (!active) return;
      if (res) {
        setData(res);
        setFailed(false);
      } else {
        setFailed(true);
        toast({ title: t("admin.toast.failed"), variant: "destructive" });
      }
    });
    return () => {
      active = false;
    };
  }, [reloadKey, toast, t]);

  if (!data) {
    if (failed) {
      return <EmptyState icon={<Gauge />} title={t("admin.loadFailed")} />;
    }
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-card" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-card" />
      </div>
    );
  }

  const num = (n: number) => fmtNum(n, locale);
  const totalDevice = data.devices.reduce((sum, d) => sum + d.count, 0) || 1;
  const totalLocale = data.locales.reduce((sum, d) => sum + d.count, 0) || 1;
  const maxPage = data.topPages[0]?.count ?? 1;
  const maxRef = data.referrers.reduce((m, r) => Math.max(m, r.count), 1);
  const maxViews = Math.max(1, ...data.series.map((s) => s.views));
  const total30 = data.views30d || 1;

  return (
    <div className="space-y-6">
      {/* Headline stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label={t("admin.analytics.viewsToday")}
          value={num(data.viewsToday)}
          icon={Eye}
          tone="primary"
        />
        <StatCard
          label={t("admin.analytics.visitorsToday")}
          value={num(data.visitorsToday)}
          icon={Users}
          tone="primary"
        />
        <StatCard
          label={t("admin.analytics.views7d")}
          value={num(data.views7d)}
          icon={TrendingUp}
          tone="success"
        />
        <StatCard
          label={t("admin.analytics.visitors7d")}
          value={num(data.visitors7d)}
          icon={Users}
          tone="success"
        />
        <StatCard
          label={t("admin.analytics.toolRuns30d")}
          value={num(data.tools.runs30d)}
          icon={Wrench}
          tone="accent"
        />
        <StatCard
          label={t("admin.analytics.successRate30d")}
          value={`${num(data.tools.successRate30d)}%`}
          icon={CheckCircle2}
          tone="accent"
        />
      </div>

      {/* 30-day trend chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="size-4 text-primary" aria-hidden="true" />
            {t("admin.analytics.trendTitle")}
          </CardTitle>
          <CardDescription>
            {t("admin.analytics.trendDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            className="flex h-44 items-end gap-[3px] sm:gap-1.5"
            role="img"
            aria-label={t("admin.analytics.trendAria")}
          >
            {data.series.map((point) => {
              const pct = (point.views / maxViews) * 100;
              return (
                <div
                  key={point.day}
                  className="group relative flex h-full flex-1 items-end"
                  title={`${point.day} · ${point.views} views · ${point.visitors} visitors`}
                >
                  <div
                    className="w-full rounded-t-sm bg-primary/70 transition-colors group-hover:bg-primary"
                    style={{ height: `${Math.max(point.views > 0 ? 4 : 1, pct)}%` }}
                  />
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
            <span>{data.series[0]?.day.slice(5)}</span>
            <span>{data.series[Math.floor(data.series.length / 2)]?.day.slice(5)}</span>
            <span>{data.series[data.series.length - 1]?.day.slice(5)}</span>
          </div>
          <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-primary/70" aria-hidden="true" />
              {t("admin.analytics.legendViews", {
                count: data.views30d,
              })}
            </span>
            <span className="flex items-center gap-1.5">
              <Users className="size-3.5" aria-hidden="true" />
              {t("admin.analytics.legendVisitors", {
                count: data.visitors30d,
              })}
            </span>
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Top pages */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="size-4 text-primary" aria-hidden="true" />
              {t("admin.analytics.topPagesTitle")}
            </CardTitle>
            <CardDescription>
              {t("admin.analytics.topPagesDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.topPages.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("admin.analytics.empty")}
              </p>
            ) : (
              <ul className="space-y-3">
                {data.topPages.map((page) => (
                  <li key={page.label} className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate font-medium text-foreground">
                        {page.label}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {num(page.count)}
                      </span>
                    </div>
                    <div
                      className="h-2 overflow-hidden rounded-full bg-muted"
                      role="img"
                      aria-label={`${page.label}: ${page.count}`}
                    >
                      <div
                        className="h-full rounded-full bg-primary/70"
                        style={{
                          width: `${Math.max(6, (page.count / maxPage) * 100)}%`,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Traffic sources */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ExternalLink className="size-4 text-primary" aria-hidden="true" />
              {t("admin.analytics.refTitle")}
            </CardTitle>
            <CardDescription>
              {t("admin.analytics.refDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.referrers.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("admin.analytics.empty")}
              </p>
            ) : (
              <ul className="space-y-3">
                {data.referrers.map((ref) => (
                  <li key={ref.label} className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="font-medium text-foreground">
                        {t(REFERRER_LABEL_KEY[ref.label] ?? "admin.analytics.refOther")}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {num(ref.count)} · {Math.round((ref.count / (data.views30d || 1)) * 100)}%
                      </span>
                    </div>
                    <div
                      className="h-2 overflow-hidden rounded-full bg-muted"
                      role="img"
                      aria-label={`${ref.label}: ${ref.count}`}
                    >
                      <div
                        className="h-full rounded-full bg-cat-optimize/70"
                        style={{
                          width: `${Math.max(6, (ref.count / maxRef) * 100)}%`,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Devices + locales */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Laptop className="size-4 text-primary" aria-hidden="true" />
              {t("admin.analytics.deviceTitle")}
            </CardTitle>
            <CardDescription>
              {t("admin.analytics.deviceDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.devices.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("admin.analytics.empty")}
              </p>
            ) : (
              <ul className="space-y-3">
                {data.devices.map((device) => {
                  const Icon = DEVICE_ICON[device.label] ?? Laptop;
                  const pct = Math.round((device.count / totalDevice) * 100);
                  return (
                    <li key={device.label} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="flex items-center gap-2 font-medium text-foreground">
                          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                          {t(`admin.analytics.device_${device.label}`)}
                        </span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {pct}%
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary/60"
                          style={{ width: `${Math.max(4, pct)}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="border-t border-border pt-4">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <Globe className="size-4 text-primary" aria-hidden="true" />
                {t("admin.analytics.localeTitle")}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {data.locales.map((loc) => (
                  <span
                    key={loc.label}
                    className="rounded-chip border border-border bg-muted/50 px-2.5 py-1 text-xs font-medium text-foreground"
                  >
                    {loc.label === "hi" ? "हिंदी" : "English"} ·{" "}
                    {Math.round((loc.count / totalLocale) * 100)}%
                  </span>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Tool health */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Timer className="size-4 text-primary" aria-hidden="true" />
              {t("admin.analytics.toolsTitle")}
            </CardTitle>
            <CardDescription>
              {t("admin.analytics.toolsDesc", {
                avg: (data.tools.avgDurationMs / 1000).toFixed(1),
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.tools.top.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("admin.analytics.empty")}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {data.tools.top.map((tool) => (
                  <li
                    key={tool.toolId}
                    className="flex items-center justify-between gap-3 py-2.5"
                  >
                    <span className="min-w-0 truncate text-sm font-medium text-foreground">
                      {tool.toolId}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
                      <span>{num(tool.runs)}</span>
                      <span
                        className={
                          tool.successRate >= 90
                            ? "rounded-chip bg-success/10 px-1.5 py-0.5 font-semibold text-success"
                            : tool.successRate >= 70
                              ? "rounded-chip bg-amber-500/10 px-1.5 py-0.5 font-semibold text-amber-600"
                              : "rounded-chip bg-destructive/10 px-1.5 py-0.5 font-semibold text-destructive"
                        }
                      >
                        {tool.successRate}%
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Privacy note */}
      <p className="text-xs text-muted-foreground">
        {t("admin.analytics.privacyNote")} · {t("admin.analytics.shareNote", {
          count: data.views30d,
          percent: Math.round((data.tools.runs30d / total30) * 100),
        })}
      </p>
    </div>
  );
}
