"use client";

import { Home, Search, UserRound, Wrench } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { HashRoute } from "@/hooks/use-hash-route";
import { ROUTES } from "@/hooks/use-hash-route";
import { cn } from "@/lib/utils";

/**
 * Mobile bottom tab bar (PRD §5.1). Home / Tools / Search / Account —
 * the account tab (P12) opens #/account, which works signed-out too
 * (sign-in card inside, never a wall). Fixed above the safe area,
 * hidden on md+ screens.
 */

interface TabDef {
  id: "home" | "tools" | "account";
  href: string;
  label: string;
  icon: typeof Home;
  active: boolean;
}

function TabLink({ tab }: { tab: TabDef }) {
  const Icon = tab.icon;
  return (
    <a
      href={tab.href}
      aria-current={tab.active ? "page" : undefined}
      className={cn(
        "relative flex min-h-14 flex-col items-center justify-center gap-0.5 px-2 py-1.5 text-[11px] font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
        tab.active ? "text-primary" : "text-muted-foreground"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-x-0 top-0 mx-auto h-[3px] w-4 rounded-full bg-primary transition-all duration-200",
          tab.active ? "scale-x-100 opacity-100" : "scale-x-0 opacity-0"
        )}
      />
      <Icon
        className={cn(
          "size-5 transition-transform duration-200",
          tab.active ? "scale-110" : "scale-100"
        )}
        aria-hidden="true"
      />
      {tab.label}
    </a>
  );
}

export function BottomTabBar({
  route,
  onOpenSearch,
}: {
  route: HashRoute;
  onOpenSearch: () => void;
}) {
  const { t } = useI18n();

  const tabs: TabDef[] = [
    {
      id: "home",
      href: ROUTES.home,
      label: t("tabs.home"),
      icon: Home,
      active: route.view === "home",
    },
    {
      id: "tools",
      href: ROUTES.tools,
      label: t("tabs.tools"),
      icon: Wrench,
      active: route.view === "tools",
    },
    {
      id: "account",
      href: ROUTES.account,
      label: t("account.nav"),
      icon: UserRound,
      active: route.view === "account",
    },
  ];

  return (
    <nav
      aria-label={t("tabs.tools")}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/92 backdrop-blur-md md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="grid grid-cols-4">
        {tabs.slice(0, 2).map((tab) => (
          <li key={tab.id}>
            <TabLink tab={tab} />
          </li>
        ))}
        <li>
          <button
            type="button"
            onClick={onOpenSearch}
            className="flex min-h-14 w-full flex-col items-center justify-center gap-0.5 px-2 py-1.5 text-[11px] font-medium text-muted-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <Search className="size-5" aria-hidden="true" />
            {t("tabs.search")}
          </button>
        </li>
        {tabs.slice(2).map((tab) => (
          <li key={tab.id}>
            <TabLink tab={tab} />
          </li>
        ))}
      </ul>
    </nav>
  );
}
