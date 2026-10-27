"use client";

import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  Bug,
  LayoutDashboard,
  Megaphone,
  MessageSquare,
  RefreshCw,
  ScrollText,
  Settings,
  ThumbsUp,
  Users,
  Wrench,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/locale-provider";
import { ROUTES } from "@/hooks/use-hash-route";
import { cn } from "@/lib/utils";
import type { AdminTab } from "./admin-view";
import type { AdminModuleProps } from "./admin-shared";
import { DashboardPanel } from "./dashboard";
import { ToolsManagerPanel } from "./tools-manager";
import { UsersPanel } from "./users";
import { BugsPanel } from "./bugs";
import { MessagesPanel } from "./messages";
import { FeedbackPanel } from "./feedback";
import { AnnouncementsPanel } from "./announcements";
import { AuditLogPanel } from "./audit-log";
import { SettingsPanel } from "./settings";

/**
 * Admin console chrome: sticky sub-header under the site header (title,
 * back-to-site link, refresh), desktop sidebar nav + mobile horizontal
 * tab strip, and the active module. The tab is hash-synced — nav links
 * are plain hash anchors so deep links (#/admin/users) and back/forward
 * always work.
 */

interface NavItem {
  id: AdminTab;
  labelKey: string;
  icon: LucideIcon;
}

const NAV: readonly NavItem[] = [
  { id: "dashboard", labelKey: "admin.nav.dashboard", icon: LayoutDashboard },
  { id: "tools", labelKey: "admin.nav.tools", icon: Wrench },
  { id: "users", labelKey: "admin.nav.users", icon: Users },
  { id: "bugs", labelKey: "admin.nav.bugs", icon: Bug },
  { id: "messages", labelKey: "admin.nav.messages", icon: MessageSquare },
  { id: "feedback", labelKey: "admin.nav.feedback", icon: ThumbsUp },
  { id: "announcements", labelKey: "admin.nav.announcements", icon: Megaphone },
  { id: "audit", labelKey: "admin.nav.audit", icon: ScrollText },
  { id: "settings", labelKey: "admin.nav.settings", icon: Settings },
];

interface AdminShellProps extends AdminModuleProps {
  tab: AdminTab;
  onRefresh: () => void;
}

export function AdminShell({
  tab,
  refreshToken,
  onRefresh,
  onForbidden,
}: AdminShellProps) {
  const { t } = useI18n();

  return (
    <div>
      {/* Sticky sub-header sits under the site header (sticky top-0 h-16). */}
      <div className="sticky top-16 z-30 border-b bg-background/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4">
          <h1 className="truncate text-sm font-semibold tracking-tight">
            {t("admin.title")}
          </h1>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="ghost" size="sm" asChild>
              <a href={ROUTES.home} aria-label={t("admin.backToSite")}>
                <ArrowLeft className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">
                  {t("admin.backToSite")}
                </span>
              </a>
            </Button>
            <Button variant="outline" size="sm" onClick={onRefresh}>
              <RefreshCw className="size-4" aria-hidden="true" />
              {t("common.refresh")}
            </Button>
          </div>
        </div>
        {/* Mobile: horizontal scrollable tab strip (house chip pattern). */}
        <nav aria-label={t("admin.title")} className="md:hidden">
          <ul className="scrollbar-thin flex gap-1.5 overflow-x-auto px-4 pb-2.5">
            {NAV.map((item) => (
              <li key={item.id}>
                <a
                  href={ROUTES.admin(item.id)}
                  aria-current={tab === item.id ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    tab === item.id
                      ? "border-primary/30 bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:text-foreground"
                  )}
                >
                  <item.icon className="size-3.5" aria-hidden="true" />
                  {t(item.labelKey)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 pb-16">
        <div className="mt-6 grid gap-8 md:grid-cols-[200px_minmax(0,1fr)]">
          {/* Desktop: sticky sidebar nav. */}
          <nav aria-label={t("admin.title")} className="hidden md:block">
            <ul className="sticky top-[8rem] flex flex-col gap-1">
              {NAV.map((item) => (
                <li key={item.id}>
                  <a
                    href={ROUTES.admin(item.id)}
                    aria-current={tab === item.id ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      tab === item.id
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    <item.icon className="size-4" aria-hidden="true" />
                    {t(item.labelKey)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <main className="min-w-0">
            <AdminModuleRouter
              tab={tab}
              refreshToken={refreshToken}
              onForbidden={onForbidden}
            />
          </main>
        </div>
      </div>
    </div>
  );
}

function AdminModuleRouter({
  tab,
  refreshToken,
  onForbidden,
}: AdminModuleProps & { tab: AdminTab }) {
  switch (tab) {
    case "tools":
      return <ToolsManagerPanel refreshToken={refreshToken} onForbidden={onForbidden} />;
    case "users":
      return <UsersPanel refreshToken={refreshToken} onForbidden={onForbidden} />;
    case "bugs":
      return <BugsPanel refreshToken={refreshToken} onForbidden={onForbidden} />;
    case "messages":
      return <MessagesPanel refreshToken={refreshToken} onForbidden={onForbidden} />;
    case "feedback":
      return <FeedbackPanel refreshToken={refreshToken} onForbidden={onForbidden} />;
    case "announcements":
      return <AnnouncementsPanel refreshToken={refreshToken} onForbidden={onForbidden} />;
    case "audit":
      return <AuditLogPanel refreshToken={refreshToken} onForbidden={onForbidden} />;
    case "settings":
      return <SettingsPanel refreshToken={refreshToken} onForbidden={onForbidden} />;
    default:
      return <DashboardPanel refreshToken={refreshToken} onForbidden={onForbidden} />;
  }
}
