"use client";

import { BookOpenCheck, LayoutDashboard, LogOut, Settings, ShieldCheck, Sparkles, UserRound } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { track } from "@/lib/analytics/ga4";
import { logout, openAuthModal, useAuth, type SafeUser } from "@/lib/auth-client";
import { navigateToHash, ROUTES } from "@/hooks/use-hash-route";

/** Two-letter avatar initials from the name, falling back to the email. */
function initialsOf(user: SafeUser): string {
  const source = user.name?.trim() || user.email;
  const parts = source.split(/[\s._@-]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return "·";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * AccountMenu (Phase-10 foundation) — the header's session surface.
 * Guests get a Log in button (opens the store-driven AuthModal); signed-in
 * users get an avatar dropdown with their identity, plan badge and logout.
 * The menu is intentionally account-scoped: tool settings stay on the
 * device, the account only carries preferences (PRD: no signup wall).
 */
export function AccountMenu() {
  const { t } = useI18n();
  const { toast } = useToast();
  const { user } = useAuth();

  if (!user) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="touch"
        className="gap-2 rounded-btn px-2.5"
        aria-label={t("auth.accountLabel")}
        onClick={() => openAuthModal("login")}
      >
        <UserRound className="size-5" aria-hidden="true" />
        <span className="hidden text-sm xl:inline">{t("auth.tabLogin")}</span>
      </Button>
    );
  }

  const isPro = user.plan === "pro";

  const handleLogout = async () => {
    track("logout");
    await logout();
    toast({ title: t("auth.signedOut") });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("auth.openMenuLabel")}
          className="flex size-11 items-center justify-center rounded-btn outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Avatar className="size-8 border border-border">
            <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
              {initialsOf(user)}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 rounded-card">
        <DropdownMenuLabel className="flex flex-col gap-1">
          <span className="truncate text-sm font-semibold text-foreground">
            {user.name?.trim() || user.email}
          </span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {user.email}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex flex-wrap items-center gap-2 py-1.5">
          {isPro ? (
            <>
              <Badge variant="pro" className="rounded-chip">
                <Sparkles className="size-3" aria-hidden="true" />
                {t("auth.menuPlanPro")}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {t("auth.proThanks")}
              </span>
            </>
          ) : (
            <Badge variant="outline" className="rounded-chip">
              {t("auth.menuPlanFree")}
            </Badge>
          )}
          {user.role === "admin" ? (
            <Badge variant="secondary" className="rounded-chip">
              <ShieldCheck className="size-3" aria-hidden="true" />
              {t("auth.menuAdmin")}
            </Badge>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => navigateToHash(ROUTES.account)}
          className="min-h-11 cursor-pointer rounded-btn"
        >
          <Settings className="size-4" aria-hidden="true" />
          {t("auth.menuSettings")}
        </DropdownMenuItem>
        {user.role === "admin" ? (
          <>
            <DropdownMenuItem
              onClick={() => navigateToHash(ROUTES.admin)}
              className="min-h-11 cursor-pointer rounded-btn"
            >
              <LayoutDashboard className="size-4" aria-hidden="true" />
              {t("auth.menuAdminDash")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => navigateToHash(ROUTES.accounting)}
              className="min-h-11 cursor-pointer rounded-btn"
            >
              <BookOpenCheck className="size-4" aria-hidden="true" />
              {t("auth.menuAccounting")}
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuItem
          onClick={handleLogout}
          className="min-h-11 cursor-pointer rounded-btn"
        >
          <LogOut className="size-4" aria-hidden="true" />
          {t("auth.menuLogout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
