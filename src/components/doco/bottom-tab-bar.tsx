"use client";

import { Home, Search, Wrench } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { HashRoute } from "@/hooks/use-hash-route";
import { ROUTES } from "@/hooks/use-hash-route";
import { cn } from "@/lib/utils";

/**
 * Mobile bottom tab bar (PRD §5.1). Home / Tools / Search are functional
 * today; "Recent" and "Account" join in Phase 2/10 when those features ship.
 * Fixed above the safe area, hidden on md+ screens.
 */
export function BottomTabBar({
  route,
  onOpenSearch,
}: {
  route: HashRoute;
  onOpenSearch: () => void;
}) {
  const { t } = useI18n();

  const tabs = [
    {
      id: "home" as const,
      href: ROUTES.home,
      label: t("tabs.home"),
      icon: Home,
      active: route.view === "home",
    },
    {
      id: "tools" as const,
      href: ROUTES.tools,
      label: t("tabs.tools"),
      icon: Wrench,
      active: route.view === "tools",
    },
  ];

  return (
    <nav
      aria-label={t("tabs.tools")}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/92 backdrop-blur-md md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="grid grid-cols-3">
        {tabs.map(({ id, href, label, icon: Icon, active }) => (
          <li key={id}>
            <a
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center gap-0.5 px-2 py-1.5 text-[11px] font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                active ? "text-primary" : "text-muted-foreground"
              )}
            >
              <Icon className="size-5" aria-hidden="true" />
              {label}
            </a>
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
      </ul>
    </nav>
  );
}
