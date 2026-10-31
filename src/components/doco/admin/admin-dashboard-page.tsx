"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  BookOpenCheck,
  Bug,
  Crown,
  Inbox,
  Landmark,
  LayoutDashboard,
  Loader2,
  LogIn,
  MessageSquareHeart,
  RefreshCw,
  ScrollText,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  UserRound,
  Users,
  Wrench,
  Zap,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/doco/empty-state";
import { PageShell } from "@/components/doco/page/page-shell";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { navigateToHash } from "@/hooks/use-hash-route";
import { track } from "@/lib/analytics/ga4";
import { openAuthModal, useAuth } from "@/lib/auth-client";
import { fetchStats, type AdminStatsDto } from "@/lib/admin-client";
import { fmtDate, StatCard } from "@/components/doco/admin/shared";
import { UsersTab } from "@/components/doco/admin/users-tab";
import { BugsTab } from "@/components/doco/admin/bugs-tab";
import { MessagesTab } from "@/components/doco/admin/messages-tab";
import { FeedbackTab } from "@/components/doco/admin/feedback-tab";
import { AnalyticsTab } from "@/components/doco/admin/analytics-tab";
import { AuditTab } from "@/components/doco/admin/audit-tab";
import { SettingsTab } from "@/components/doco/admin/settings-tab";

/**
 * AdminDashboardPage — the owner console (single-admin site: Deepak Kumar,
 * araj.dkg@gmail.com). Gate: loading → sign-in prompt → forbidden → console.
 * The admin APIs re-check the role on every call, so this gate is UX only.
 */
export function AdminDashboardPage() {
  const { t, locale } = useI18n();
  const { user, status } = useAuth();

  useEffect(() => {
    if (user?.role === "admin") track("admin_dashboard_view", { locale });
  }, [user, locale]);

  if (status === "loading") {
    return (
      <div className="mx-auto flex w-full max-w-6xl items-center justify-center gap-2 px-4 py-24">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">{t("account.loading")}</span>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto flex w-full max-w-xl justify-center px-4 py-20">
        <EmptyState
          icon={<LogIn />}
          title={t("admin.signInTitle")}
          description={t("admin.signInDesc")}
          action={
            <Button
              type="button"
              size="touch"
              className="rounded-btn"
              onClick={() => openAuthModal("login")}
            >
              {t("auth.tabLogin")}
            </Button>
          }
        />
      </div>
    );
  }

  if (user.role !== "admin") {
    return (
      <div className="mx-auto flex w-full max-w-xl justify-center px-4 py-20">
        <EmptyState
          icon={<ShieldAlert />}
          title={t("admin.forbiddenTitle")}
          description={t("admin.forbiddenDesc")}
        />
      </div>
    );
  }

  return (
    <PageShell
      icon={LayoutDashboard}
      badge={t("admin.badge")}
      title={t("admin.title")}
      lede={t("admin.lede")}
      wide
    >
      <OwnerIdentityCard />
      <Console />
    </PageShell>
  );
}

/* ------------------------------------------------------------------ */
/* Owner identity — the single-admin banner                            */
/*                                                                     */
/* R46 logical audit: the owner IS the site owner — no "Pro"/"Free"    */
/* plan badge belongs here. One "Owner" identity badge plus the        */
/* full-access chip says everything the plan ladder would, without     */
/* selling the owner their own product.                                */
/* ------------------------------------------------------------------ */

function OwnerIdentityCard() {
  const { t } = useI18n();
  const { user } = useAuth();
  if (!user) return null;

  const initials = (user.name?.trim() || user.email)
    .split(/[\s._@-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();

  return (
    <Card className="overflow-hidden border-primary/25 bg-gradient-to-br from-primary/[0.08] via-surface to-surface">
      <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <div className="relative">
            <Avatar className="size-14 border-2 border-primary/30">
              <AvatarFallback className="bg-primary/15 text-base font-bold text-primary">
                {initials || "DK"}
              </AvatarFallback>
            </Avatar>
            <span
              className="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full border-2 border-surface bg-primary text-primary-foreground"
              aria-hidden="true"
            >
              <Crown className="size-3" />
            </span>
          </div>
          <div className="min-w-0">
            <p className="truncate text-lg font-bold tracking-tight text-foreground">
              {user.name?.trim() || user.email}
            </p>
            <p className="truncate text-sm text-muted-foreground">{user.email}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge
                variant="default"
                className="rounded-chip border-primary/30 bg-primary/15 text-primary"
              >
                <Crown className="size-3" aria-hidden="true" />
                {t("admin.ownerBadge")}
              </Badge>
              <Badge variant="outline" className="rounded-chip text-muted-foreground">
                {t("admin.ownerAccessChip")}
              </Badge>
            </div>
          </div>
        </div>
        <p className="flex items-center gap-2 text-xs text-muted-foreground sm:max-w-52 sm:text-right">
          <ShieldCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
          {t("admin.identityNote")}
        </p>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Console shell — refresh + tabs                                      */
/* ------------------------------------------------------------------ */

function Console() {
  const { t } = useI18n();
  const [stats, setStats] = useState<AdminStatsDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [tab, setTab] = useState("overview");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    let active = true;
    void fetchStats().then((data) => {
      if (!active) return;
      if (data) {
        setStats(data);
        setFailed(false);
        setUpdatedAt(new Date());
      } else {
        setFailed(true);
      }
      setRefreshing(false);
    });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const handleRefresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    setReloadKey((k) => k + 1);
  };

  const reloadStats = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
        {updatedAt && !refreshing ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("admin.lastUpdated", {
              time: updatedAt.toLocaleTimeString(
                undefined,
                { hour: "2-digit", minute: "2-digit" }
              ),
            })}
          </span>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="rounded-btn"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          {refreshing ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="size-4" aria-hidden="true" />
          )}
          {refreshing ? t("admin.refreshing") : t("admin.refresh")}
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="gap-6">
        <TabsList className="h-auto w-full justify-start overflow-x-auto rounded-card p-1">
          <TabsTrigger value="overview" className="gap-1.5 rounded-btn">
            <LayoutDashboard className="size-4" aria-hidden="true" />
            {t("admin.tab.overview")}
          </TabsTrigger>
          <TabsTrigger value="users" className="gap-1.5 rounded-btn">
            <Users className="size-4" aria-hidden="true" />
            {t("admin.tab.users")}
          </TabsTrigger>
          <TabsTrigger value="bugs" className="gap-1.5 rounded-btn">
            <Bug className="size-4" aria-hidden="true" />
            {t("admin.tab.bugs")}
            {stats && stats.bugsNew > 0 ? (
              <Badge variant="new" className="ml-0.5 rounded-chip px-1.5">
                {stats.bugsNew}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="messages" className="gap-1.5 rounded-btn">
            <Inbox className="size-4" aria-hidden="true" />
            {t("admin.tab.messages")}
            {stats && stats.messagesNew > 0 ? (
              <Badge variant="new" className="ml-0.5 rounded-chip px-1.5">
                {stats.messagesNew}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="feedback" className="gap-1.5 rounded-btn">
            <MessageSquareHeart className="size-4" aria-hidden="true" />
            {t("admin.tab.feedback")}
          </TabsTrigger>
          <TabsTrigger value="analytics" className="gap-1.5 rounded-btn">
            <Activity className="size-4" aria-hidden="true" />
            {t("admin.tab.analytics")}
          </TabsTrigger>
          <TabsTrigger value="audit" className="gap-1.5 rounded-btn">
            <ScrollText className="size-4" aria-hidden="true" />
            {t("admin.tab.audit")}
          </TabsTrigger>
          <TabsTrigger value="settings" className="gap-1.5 rounded-btn">
            <Settings2 className="size-4" aria-hidden="true" />
            {t("admin.tab.settings")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab stats={stats} failed={failed} onOpenTab={setTab} />
        </TabsContent>
        <TabsContent value="users">
          <UsersTab onChanged={reloadStats} />
        </TabsContent>
        <TabsContent value="bugs">
          <BugsTab onChanged={reloadStats} />
        </TabsContent>
        <TabsContent value="messages">
          <MessagesTab onChanged={reloadStats} />
        </TabsContent>
        <TabsContent value="feedback">
          <FeedbackTab />
        </TabsContent>
        <TabsContent value="analytics">
          <AnalyticsTab />
        </TabsContent>
        <TabsContent value="audit">
          <AuditTab />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview tab                                                        */
/* ------------------------------------------------------------------ */

function OverviewTab({
  stats,
  failed,
  onOpenTab,
}: {
  stats: AdminStatsDto | null;
  failed: boolean;
  onOpenTab: (tab: string) => void;
}) {
  const { t, locale } = useI18n();

  if (!stats) {
    if (failed) {
      return (
        <EmptyState
          icon={<ShieldAlert />}
          title={t("admin.loadFailed")}
        />
      );
    }
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-card" />
        ))}
      </div>
    );
  }

  const cards = [
    { label: t("admin.overview.users"), value: stats.users, icon: UserRound, tone: "primary" as const },
    { label: t("admin.overview.bugsNew"), value: stats.bugsNew, icon: Bug, tone: "accent" as const },
    { label: t("admin.overview.bugsOpen"), value: stats.bugsOpen, icon: Wrench, tone: "accent" as const },
    { label: t("admin.overview.messagesNew"), value: stats.messagesNew, icon: Inbox, tone: "primary" as const },
    { label: t("admin.overview.feedbackCount"), value: stats.feedbackCount, icon: MessageSquareHeart, tone: "muted" as const },
    { label: t("admin.overview.usageToday"), value: stats.usageToday, icon: Zap, tone: "success" as const },
  ];

  const maxCount = stats.topTools[0]?.count ?? 1;

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <StatCard
            key={c.label}
            label={c.label}
            value={c.value.toLocaleString(locale === "hi" ? "hi-IN" : "en-IN")}
            icon={c.icon}
            tone={c.tone}
          />
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Top tools */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="size-4 text-primary" aria-hidden="true" />
              {t("admin.overview.topToolsTitle")}
            </CardTitle>
            <CardDescription>{t("admin.overview.topToolsDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {stats.topTools.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("admin.overview.topToolsEmpty")}
              </p>
            ) : (
              <ul className="space-y-3">
                {stats.topTools.map((tool) => (
                  <li key={tool.toolId} className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate font-medium text-foreground">
                        {tool.toolId}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {tool.count.toLocaleString(locale === "hi" ? "hi-IN" : "en-IN")}
                      </span>
                    </div>
                    <div
                      className="h-2 overflow-hidden rounded-full bg-muted"
                      role="img"
                      aria-label={`${tool.toolId}: ${tool.count}`}
                    >
                      <div
                        className="h-full rounded-full bg-primary/70"
                        style={{ width: `${Math.max(6, (tool.count / maxCount) * 100)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Recent signups */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="size-4 text-primary" aria-hidden="true" />
              {t("admin.overview.recentTitle")}
            </CardTitle>
            <CardDescription>{t("admin.overview.recentDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {stats.recentSignups.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("admin.overview.recentEmpty")}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {stats.recentSignups.map((u, i) => (
                  <li key={`${u.email}-${i}`} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary" aria-hidden="true">
                        {(u.name?.trim() || u.email)[0]?.toUpperCase() ?? "·"}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {u.name?.trim() || u.email}
                        </p>
                        {u.name ? (
                          <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                        ) : null}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {fmtDate(u.createdAt, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick links */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Zap className="size-4 text-primary" aria-hidden="true" />
            {t("admin.overview.quickTitle")}
          </CardTitle>
          <CardDescription>{t("admin.overview.quickDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <QuickLink
            icon={Landmark}
            label={t("admin.overview.quickAccounting")}
            desc={t("admin.overview.quickAccountingDesc")}
            onClick={() => navigateToHash("/accounting")}
          />
          <QuickLink
            icon={Users}
            label={t("admin.overview.quickUsers")}
            desc={t("admin.overview.quickUsersDesc")}
            onClick={() => onOpenTab("users")}
          />
          <QuickLink
            icon={BookOpenCheck}
            label={t("admin.overview.quickSettings")}
            desc={t("admin.overview.quickSettingsDesc")}
            onClick={() => onOpenTab("settings")}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function QuickLink({
  icon: Icon,
  label,
  desc,
  onClick,
}: {
  icon: typeof Users;
  label: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-11 flex-col items-start gap-1.5 rounded-card border border-border bg-background p-4 text-left outline-none transition-colors hover:border-primary/30 hover:bg-primary/5 focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <span className="flex size-8 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary" aria-hidden="true">
          <Icon className="size-4" />
        </span>
        {label}
      </span>
      <span className="text-xs text-muted-foreground">{desc}</span>
    </button>
  );
}
