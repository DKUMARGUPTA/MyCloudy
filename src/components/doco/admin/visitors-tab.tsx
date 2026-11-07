"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  CalendarDays,
  Clock,
  Eye,
  Flag,
  Globe2,
  Languages,
  Laptop,
  MapPin,
  MonitorSmartphone,
  MousePointerClick,
  Percent,
  RefreshCw,
  Search,
  Smartphone,
  Tablet,
  Users,
  UserRound,
  UserRoundCheck,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/doco/empty-state";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import {
  fetchVisitors,
  type AdminVisitorsDto,
  type VisitorsFilter,
} from "@/lib/admin-client";
import { StatCard } from "@/components/doco/admin/shared";

/**
 * VisitorsTab (R60) — the advanced visitor analytics console.
 *
 * Everything the owner asked for in one surface: WHO visited (logged-in
 * user or guest, age when known), WHERE from (country/region/city +
 * flag), ON WHAT (device/browser/OS/screen/language), WHEN (today /
 * yesterday / 7d / 30d / 90d / all / custom range) and HOW DEEP
 * (pageviews, bounce, duration) — with live filters on every dimension
 * and a searchable recent-sessions table.
 */

type RangeKey = NonNullable<VisitorsFilter["range"]>;

const RANGE_OPTIONS: RangeKey[] = [
  "today",
  "yesterday",
  "7d",
  "30d",
  "90d",
  "all",
  "custom",
];

const DEVICE_ICON: Record<string, typeof Laptop> = {
  desktop: MonitorSmartphone,
  mobile: Smartphone,
  tablet: Tablet,
};

/** ISO alpha-2 → flag emoji (client-side, no dependency). */
function countryFlag(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return "🌐";
  return String.fromCodePoint(
    ...code
      .toUpperCase()
      .split("")
      .map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  );
}

function fmtNum(n: number, locale: string): string {
  return n.toLocaleString(locale === "hi" ? "hi-IN" : "en-IN");
}

function fmtTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale === "hi" ? "hi-IN" : "en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const REFERRER_LABEL: Record<string, string> = {
  direct: "Direct",
  search: "Search",
  social: "Social",
  internal: "Internal",
  other: "Other",
};

export function VisitorsTab() {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  /* ── Filter state (drives every query) ─────────────────────────────── */
  const [range, setRange] = useState<RangeKey>("today");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [country, setCountry] = useState("all");
  const [city, setCity] = useState("all");
  const [device, setDevice] = useState("all");
  const [browser, setBrowser] = useState("all");
  const [os, setOs] = useState("all");
  const [userType, setUserType] = useState<"all" | "known" | "anon">("all");
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");

  const [data, setData] = useState<AdminVisitorsDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const filter: VisitorsFilter = useMemo(
    () => ({
      range,
      from: range === "custom" ? from : undefined,
      to: range === "custom" ? to : undefined,
      country: country !== "all" ? country : undefined,
      city: city !== "all" ? city : undefined,
      device: device !== "all" ? device : undefined,
      browser: browser !== "all" ? browser : undefined,
      os: os !== "all" ? os : undefined,
      userType,
      q: q || undefined,
    }),
    [range, from, to, country, city, device, browser, os, userType, q]
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    void fetchVisitors(filter).then((res) => {
      if (!active) return;
      setLoading(false);
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
  }, [filter, reloadKey, toast, t]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const num = (n: number) => fmtNum(n, locale);

  /* ── Loading / failure states ──────────────────────────────────────── */
  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 rounded-card" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-card" />
          ))}
        </div>
        <Skeleton className="h-56 rounded-card" />
      </div>
    );
  }
  if (!data) {
    return <EmptyState icon={<Globe2 />} title={t("admin.loadFailed")} />;
  }

  const k = data.kpis;
  const maxSeries = Math.max(1, ...data.series.map((s) => s.views));
  const totalCountry = data.countries.reduce((s, c) => s + c.count, 0) || 1;
  const totalDevice = data.devices.reduce((s, d) => s + d.count, 0) || 1;
  const totalAge =
    data.ageGroups.reduce((s, a) => s + a.count, 0) || 1;
  const hasFilters =
    country !== "all" ||
    city !== "all" ||
    device !== "all" ||
    browser !== "all" ||
    os !== "all" ||
    userType !== "all" ||
    q !== "";

  return (
    <div className="space-y-6">
      {/* ── Filter bar ─────────────────────────────────────────────────── */}
      <Card className="static z-10 border-border/80 shadow-sm backdrop-blur lg:sticky lg:top-2">
        <CardContent className="grid gap-3 p-4 md:grid-cols-3 xl:grid-cols-6">
          <div className="space-y-1">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" htmlFor="vt-range">
              {t("admin.visitors.fRange")}
            </label>
            <Select value={range} onValueChange={(v) => setRange(v as RangeKey)}>
              <SelectTrigger id="vt-range" className="h-9 text-sm">
                <CalendarDays className="mr-1.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGE_OPTIONS.map((r) => (
                  <SelectItem key={r} value={r} className="text-sm">
                    {t(`admin.visitors.range_${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {range === "custom" && (
            <>
              <div className="space-y-1">
                <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" htmlFor="vt-from">
                  {t("admin.visitors.fFrom")}
                </label>
                <Input
                  id="vt-from"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" htmlFor="vt-to">
                  {t("admin.visitors.fTo")}
                </label>
                <Input
                  id="vt-to"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
            </>
          )}

          <div className="space-y-1">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" htmlFor="vt-country">
              {t("admin.visitors.fCountry")}
            </label>
            <Select value={country} onValueChange={setCountry}>
              <SelectTrigger id="vt-country" className="h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="all" className="text-sm">
                  {t("admin.visitors.allCountries")}
                </SelectItem>
                {data.filters.countries.map((c) => (
                  <SelectItem key={c.code} value={c.code} className="text-sm">
                    {countryFlag(c.code)} {c.name} ({c.code})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" htmlFor="vt-city">
              {t("admin.visitors.fCity")}
            </label>
            <Select value={city} onValueChange={setCity}>
              <SelectTrigger id="vt-city" className="h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="all" className="text-sm">
                  {t("admin.visitors.allCities")}
                </SelectItem>
                {data.filters.cities.slice(0, 60).map((c) => (
                  <SelectItem key={c} value={c} className="text-sm">
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" htmlFor="vt-device">
              {t("admin.visitors.fDevice")}
            </label>
            <Select value={device} onValueChange={setDevice}>
              <SelectTrigger id="vt-device" className="h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-sm">{t("admin.visitors.allDevices")}</SelectItem>
                <SelectItem value="mobile" className="text-sm">📱 Mobile</SelectItem>
                <SelectItem value="tablet" className="text-sm">📲 Tablet</SelectItem>
                <SelectItem value="desktop" className="text-sm">💻 Desktop</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" htmlFor="vt-user">
              {t("admin.visitors.fUserType")}
            </label>
            <Select value={userType} onValueChange={(v) => setUserType(v as typeof userType)}>
              <SelectTrigger id="vt-user" className="h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-sm">{t("admin.visitors.utAll")}</SelectItem>
                <SelectItem value="known" className="text-sm">{t("admin.visitors.utKnown")}</SelectItem>
                <SelectItem value="anon" className="text-sm">{t("admin.visitors.utAnon")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" htmlFor="vt-browser">
              {t("admin.visitors.fBrowser")}
            </label>
            <Select value={browser} onValueChange={setBrowser}>
              <SelectTrigger id="vt-browser" className="h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="all" className="text-sm">{t("admin.visitors.allBrowsers")}</SelectItem>
                {data.filters.browsers.map((b) => (
                  <SelectItem key={b} value={b} className="text-sm capitalize">
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" htmlFor="vt-os">
              {t("admin.visitors.fOs")}
            </label>
            <Select value={os} onValueChange={setOs}>
              <SelectTrigger id="vt-os" className="h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="all" className="text-sm">{t("admin.visitors.allOs")}</SelectItem>
                {data.filters.os.map((o) => (
                  <SelectItem key={o} value={o} className="text-sm capitalize">
                    {o}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1 md:col-span-2">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" htmlFor="vt-q">
              {t("admin.visitors.fSearch")}
            </label>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setQ(qInput.trim());
              }}
            >
              <div className="relative flex-1">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="vt-q"
                  value={qInput}
                  onChange={(e) => setQInput(e.target.value)}
                  placeholder={t("admin.visitors.searchPh")}
                  className="h-9 pl-8 text-sm"
                />
              </div>
              <Button type="submit" size="sm" variant="secondary" className="h-9 shrink-0">
                {t("admin.visitors.searchBtn")}
              </Button>
            </form>
          </div>

          <div className="flex items-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9"
              onClick={refresh}
              disabled={loading}
            >
              <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
              <span className="ml-1.5">{t("admin.visitors.refresh")}</span>
            </Button>
            {hasFilters && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9"
                onClick={() => {
                  setCountry("all");
                  setCity("all");
                  setDevice("all");
                  setBrowser("all");
                  setOs("all");
                  setUserType("all");
                  setQ("");
                  setQInput("");
                }}
              >
                {t("admin.visitors.clear")}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── KPI cards ──────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t("admin.visitors.kVisitors")} value={num(k.visitors)} icon={Users} tone="primary" />
        <StatCard label={t("admin.visitors.kSessions")} value={num(k.sessions)} icon={MousePointerClick} tone="primary" />
        <StatCard label={t("admin.visitors.kViews")} value={num(k.pageviews)} icon={Eye} tone="accent" />
        <StatCard label={t("admin.visitors.kCountries")} value={num(k.countries)} icon={Flag} tone="accent" />
        <StatCard
          label={t("admin.visitors.kAvgPages")}
          value={num(k.avgPagesPerSession)}
          icon={BarChart3}
          tone="success"
        />
        <StatCard
          label={t("admin.visitors.kBounce")}
          value={`${num(k.bounceRate)}%`}
          icon={Percent}
          tone={k.bounceRate > 60 ? "muted" : "success"}
        />
        <StatCard
          label={t("admin.visitors.kAvgTime")}
          value={k.avgSessionMin >= 1 ? `${num(k.avgSessionMin)}m` : `<1m`}
          icon={Clock}
          tone="success"
        />
        <StatCard
          label={t("admin.visitors.kKnown")}
          value={num(k.knownSessions)}
          icon={UserRoundCheck}
          tone="muted"
        />
      </div>

      {/* ── Daily trend ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="size-4 text-primary" aria-hidden="true" />
            {t("admin.visitors.trendTitle")}
          </CardTitle>
          <CardDescription>
            {t("admin.visitors.trendDesc", { from: data.range.from, to: data.range.to })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.series.every((s) => s.views === 0) ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("admin.visitors.empty")}
            </p>
          ) : (
            <>
              <div
                className="flex h-44 items-end gap-[3px] sm:gap-1.5"
                role="img"
                aria-label={t("admin.visitors.trendAria")}
              >
                {data.series.map((point) => {
                  const pct = (point.views / maxSeries) * 100;
                  return (
                    <div
                      key={point.day}
                      className="group relative flex h-full flex-1 items-end"
                      title={`${point.day} · ${point.views} views · ${point.sessions} sessions`}
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
                <span>
                  {data.series[Math.floor(data.series.length / 2)]?.day.slice(5)}
                </span>
                <span>{data.series[data.series.length - 1]?.day.slice(5)}</span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Breakdowns grid ────────────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Countries */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Flag className="size-4 text-primary" aria-hidden="true" />
              {t("admin.visitors.countriesTitle")}
            </CardTitle>
            <CardDescription>{t("admin.visitors.countriesDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {data.countries.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("admin.visitors.empty")}
              </p>
            ) : (
              <ul className="max-h-80 space-y-3 overflow-y-auto pr-1">
                {data.countries.map((c) => (
                  <li key={c.label} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <button
                        type="button"
                        className="flex min-w-0 items-center gap-2 font-medium text-foreground hover:text-primary"
                        onClick={() => setCountry(c.label)}
                        title={t("admin.visitors.filterBy")}
                      >
                        <span aria-hidden="true">{countryFlag(c.label)}</span>
                        <span className="truncate">{c.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{c.label}</span>
                      </button>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {num(c.count)} · {Math.round((c.count / totalCountry) * 100)}%
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary/70"
                        style={{ width: `${Math.max(4, (c.count / (data.countries[0]?.count || 1)) * 100)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Cities */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MapPin className="size-4 text-primary" aria-hidden="true" />
              {t("admin.visitors.citiesTitle")}
            </CardTitle>
            <CardDescription>{t("admin.visitors.citiesDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {data.cities.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("admin.visitors.empty")}
              </p>
            ) : (
              <ul className="max-h-80 space-y-3 overflow-y-auto pr-1">
                {data.cities.map((c) => (
                  <li key={c.label} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <button
                        type="button"
                        className="min-w-0 truncate font-medium text-foreground hover:text-primary"
                        onClick={() => setCity(c.label)}
                        title={t("admin.visitors.filterBy")}
                      >
                        {c.label}
                      </button>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {num(c.count)}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-cat-optimize/70"
                        style={{ width: `${Math.max(4, (c.count / (data.cities[0]?.count || 1)) * 100)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Devices */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Laptop className="size-4 text-primary" aria-hidden="true" />
              {t("admin.visitors.devicesTitle")}
            </CardTitle>
            <CardDescription>{t("admin.visitors.devicesDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {data.devices.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("admin.visitors.empty")}
              </p>
            ) : (
              <ul className="space-y-3">
                {data.devices.map((d) => {
                  const Icon = DEVICE_ICON[d.label] ?? Laptop;
                  const pct = Math.round((d.count / totalDevice) * 100);
                  return (
                    <li key={d.label} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="flex items-center gap-2 font-medium text-foreground">
                          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                          {t(`admin.analytics.device_${d.label}`)}
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
          </CardContent>
        </Card>

        {/* Browsers + OS */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe2 className="size-4 text-primary" aria-hidden="true" />
              {t("admin.visitors.browsersTitle")}
            </CardTitle>
            <CardDescription>{t("admin.visitors.browsersDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.browsers.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("admin.visitors.empty")}
              </p>
            ) : (
              <ul className="space-y-2.5">
                {data.browsers.slice(0, 6).map((b) => (
                  <li key={b.label} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate font-medium text-foreground">{b.label}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{num(b.count)}</span>
                  </li>
                ))}
              </ul>
            )}
            {data.osList.length > 0 && (
              <div className="border-t border-border pt-4">
                <p className="text-sm font-semibold">
                  {t("admin.visitors.osTitle")}
                </p>
                <ul className="mt-2 space-y-2.5">
                  {data.osList.slice(0, 5).map((o) => (
                    <li key={o.label} className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate font-medium text-foreground">{o.label}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">{num(o.count)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Age groups */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="size-4 text-primary" aria-hidden="true" />
              {t("admin.visitors.ageTitle")}
            </CardTitle>
            <CardDescription>{t("admin.visitors.ageDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {data.ageGroups.length === 0 || totalAge === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("admin.visitors.ageEmpty")}
              </p>
            ) : (
              <ul className="space-y-3">
                {data.ageGroups.map((a) => (
                  <li key={a.label} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="font-medium text-foreground">
                        {a.label === "unknown"
                          ? t("admin.visitors.ageUnknown")
                          : `${a.label} ${t("admin.visitors.ageYears")}`}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {num(a.count)} · {Math.round((a.count / totalAge) * 100)}%
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-cat-secure/70"
                        style={{
                          width: `${Math.max(4, (a.count / Math.max(...data.ageGroups.map((x) => x.count), 1)) * 100)}%`,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Top entry pages + referrers */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="size-4 text-primary" aria-hidden="true" />
              {t("admin.visitors.pagesTitle")}
            </CardTitle>
            <CardDescription>{t("admin.visitors.pagesDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.topPages.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("admin.visitors.empty")}
              </p>
            ) : (
              <ul className="space-y-2.5">
                {data.topPages.slice(0, 8).map((p) => (
                  <li key={p.label} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate font-medium text-foreground">{p.label}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{num(p.count)}</span>
                  </li>
                ))}
              </ul>
            )}
            {data.referrers.length > 0 && (
              <div className="border-t border-border pt-4">
                <p className="text-sm font-semibold">{t("admin.visitors.refTitle")}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {data.referrers.map((r) => (
                    <button
                      key={r.label}
                      type="button"
                      onClick={() => {
                        /* referrer filter not in bar; countries/cities cover the main flows */
                      }}
                      className="rounded-chip border border-border bg-muted/50 px-2.5 py-1 text-xs font-medium text-foreground hover:border-primary/40"
                      title={t("admin.visitors.refCount", { count: r.count })}
                    >
                      {REFERRER_LABEL[r.label] ?? r.label} · {num(r.count)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Recent sessions table ──────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="size-4 text-primary" aria-hidden="true" />
            {t("admin.visitors.tableTitle")}
          </CardTitle>
          <CardDescription>{t("admin.visitors.tableDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.sessions.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("admin.visitors.empty")}
            </p>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="pb-2 pr-3 font-semibold">{t("admin.visitors.cVisitor")}</th>
                      <th className="pb-2 pr-3 font-semibold">{t("admin.visitors.cLocation")}</th>
                      <th className="pb-2 pr-3 font-semibold">{t("admin.visitors.cDevice")}</th>
                      <th className="pb-2 pr-3 font-semibold">{t("admin.visitors.cEntry")}</th>
                      <th className="pb-2 pr-3 text-right font-semibold">{t("admin.visitors.cViews")}</th>
                      <th className="pb-2 pr-3 text-right font-semibold">{t("admin.visitors.cTime")}</th>
                      <th className="pb-2 text-right font-semibold">{t("admin.visitors.cLast")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.sessions.map((s) => (
                      <tr key={s.id} className="align-middle hover:bg-muted/40">
                        <td className="py-2.5 pr-3">
                          <div className="flex items-center gap-2">
                            {s.visitor ? (
                              <UserRoundCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
                            ) : (
                              <UserRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                            )}
                            <div className="min-w-0">
                              <p className="truncate font-medium text-foreground">
                                {s.visitor?.name || s.visitor?.email || t("admin.visitors.guest")}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {s.visitor?.email ?? `${s.visitorId.slice(0, 14)}…`}
                                {s.visitor?.age != null && (
                                  <span className="ml-1.5 rounded-chip bg-muted px-1.5 py-0.5">
                                    {s.visitor.age} {t("admin.visitors.ageYears")}
                                  </span>
                                )}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 pr-3">
                          <p className="flex items-center gap-1.5 font-medium text-foreground">
                            <span aria-hidden="true">{countryFlag(s.country)}</span>
                            {s.countryName}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {[s.city, s.region].filter(Boolean).join(", ") || "—"}
                          </p>
                        </td>
                        <td className="py-2.5 pr-3">
                          <p className="font-medium text-foreground">
                            {s.device === "mobile" ? "📱" : s.device === "tablet" ? "📲" : "💻"}{" "}
                            {s.browser}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {s.os}
                            {s.screen ? ` · ${s.screen}` : ""}
                          </p>
                        </td>
                        <td className="max-w-[160px] py-2.5 pr-3">
                          <p className="truncate text-foreground">{s.landingPath}</p>
                          <p className="text-xs text-muted-foreground">
                            {REFERRER_LABEL[s.referrer] ?? s.referrer}
                            {s.referrerHost ? ` · ${s.referrerHost}` : ""}
                          </p>
                        </td>
                        <td className="py-2.5 pr-3 text-right tabular-nums text-foreground">
                          {num(s.pageviews)}
                          {s.isBounce && (
                            <Badge variant="outline" className="ml-1.5 border-muted-foreground/30 text-[10px] text-muted-foreground">
                              {t("admin.visitors.bounce")}
                            </Badge>
                          )}
                        </td>
                        <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">
                          {s.durationMin >= 1 ? `${s.durationMin}m` : "<1m"}
                        </td>
                        <td className="py-2.5 text-right text-xs text-muted-foreground">
                          {fmtTime(s.lastSeen, locale)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <ul className="space-y-3 md:hidden">
                {data.sessions.map((s) => (
                  <li key={s.id} className="rounded-card border border-border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">
                          {s.visitor?.name || s.visitor?.email || t("admin.visitors.guest")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {s.visitor?.email ?? `${s.visitorId.slice(0, 14)}…`}
                          {s.visitor?.age != null && ` · ${s.visitor.age} ${t("admin.visitors.ageYears")}`}
                        </p>
                      </div>
                      <span className="shrink-0 text-xl" aria-hidden="true">
                        {countryFlag(s.country)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm text-foreground">
                      {s.countryName}
                      {s.city ? ` · ${s.city}` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {s.browser} · {s.os} · {s.device}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {s.landingPath} · {REFERRER_LABEL[s.referrer] ?? s.referrer}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="tabular-nums">
                        {t("admin.visitors.cViews")}: {num(s.pageviews)}
                      </span>
                      <span className="tabular-nums">
                        {s.durationMin >= 1 ? `${s.durationMin}m` : "<1m"}
                      </span>
                      <span>{fmtTime(s.lastSeen, locale)}</span>
                      {s.isBounce && (
                        <Badge variant="outline" className="border-muted-foreground/30 text-[10px] text-muted-foreground">
                          {t("admin.visitors.bounce")}
                        </Badge>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        <Languages className="mr-1 inline size-3" aria-hidden="true" />
        {t("admin.visitors.privacyNote")}
      </p>
    </div>
  );
}
