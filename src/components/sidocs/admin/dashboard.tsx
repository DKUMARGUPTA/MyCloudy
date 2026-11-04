"use client";

import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bug,
  MessageSquare,
  RefreshCw,
  ThumbsUp,
  TriangleAlert,
  Users,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/components/providers/locale-provider";
import { getTool } from "@/lib/tools/registry";
import { adminErrorCode, fetchAdminStats, type AdminStats } from "./admin-api";
import {
  AdminEmpty,
  AdminErrorCard,
  AdminModuleProps,
  formatAdminDate,
  isAdminLoading,
  type AdminLoad,
} from "./admin-shared";

/**
 * Admin dashboard (#/admin/dashboard): stat cards, top tools (7 days)
 * with relative bars, recent signups and an "updated" footnote.
 */
export function DashboardPanel({
  refreshToken,
  onForbidden,
}: AdminModuleProps) {
  const { t, locale } = useI18n();
  const [load, setLoad] = useState<AdminLoad<AdminStats>>({
    data: null,
    error: null,
  });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetchAdminStats(controller.signal)
      .then((stats) => {
        if (active) setLoad({ data: stats, error: null });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const code = adminErrorCode(error);
        if (code === "forbidden") onForbidden();
        else setLoad({ data: null, error: code });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [refreshToken, reloadKey, onForbidden]);

  if (load.error !== null) {
    return (
      <AdminErrorCard
        code={load.error}
        onRetry={() => setReloadKey((key) => key + 1)}
      />
    );
  }

  if (isAdminLoading(load) || load.data === null) {
    return <DashboardSkeleton />;
  }

  const stats = load.data;
  const statCards: { key: string; value: number; icon: LucideIcon }[] = [
    { key: "admin.dash.users", value: stats.users, icon: Users },
    { key: "admin.dash.bugsNew", value: stats.bugsNew, icon: Bug },
    { key: "admin.dash.bugsOpen", value: stats.bugsOpen, icon: TriangleAlert },
    {
      key: "admin.dash.messagesNew",
      value: stats.messagesNew,
      icon: MessageSquare,
    },
    { key: "admin.dash.feedback", value: stats.feedbackCount, icon: ThumbsUp },
    {
      key: "admin.dash.usageToday",
      value: stats.usageToday,
      icon: Activity,
    },
  ];

  const topTools = stats.topTools.slice(0, 8);
  const maxCount = topTools.reduce(
    (max, entry) => Math.max(max, entry.count),
    1
  );

  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight">
        {t("admin.dash.title")}
      </h2>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {statCards.map((card) => (
          <StatCard
            key={card.key}
            icon={card.icon}
            label={t(card.key)}
            value={card.value}
          />
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card className="rounded-xl py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">
              {t("admin.dash.topTools")}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            {topTools.length === 0 ? (
              <AdminEmpty />
            ) : (
              <ul className="space-y-3">
                {topTools.map((entry) => {
                  const tool = getTool(entry.toolId);
                  return (
                    <li key={entry.toolId} className="flex items-center gap-3">
                      <span className="w-28 shrink-0 truncate text-sm sm:w-40">
                        {tool ? tool.name[locale] : entry.toolId}
                      </span>
                      <span
                        className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
                        aria-hidden="true"
                      >
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{
                            width: `${Math.max(
                              6,
                              Math.round((entry.count / maxCount) * 100)
                            )}%`,
                          }}
                        />
                      </span>
                      <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {entry.count}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-xl py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">
              {t("admin.dash.recentSignups")}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            {stats.recentSignups.length === 0 ? (
              <AdminEmpty />
            ) : (
              <ul className="divide-y">
                {stats.recentSignups.map((signup) => (
                  <li
                    key={`${signup.email}-${signup.createdAt}`}
                    className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {signup.name ?? signup.email}
                      </span>
                      {signup.name ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {signup.email}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatAdminDate(signup.createdAt, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
        <RefreshCw className="size-3" aria-hidden="true" />
        {t("admin.dash.updated")}
      </p>
    </section>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
}) {
  return (
    <Card className="gap-0 rounded-xl py-4">
      <CardContent className="px-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span
            className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <Icon className="size-4" />
          </span>
          <span className="text-xs font-medium leading-tight">{label}</span>
        </div>
        <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="h-7 w-36" />
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}
