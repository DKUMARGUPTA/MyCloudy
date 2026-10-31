"use client";

import {
  BookOpenCheck,
  Crown,
  LayoutDashboard,
  LogOut,
  Settings,
  Sparkles,
  UserRound,
} from "lucide-react";

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
import { cn } from "@/lib/utils";

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
 *
 * Logical plan/role contract (R46 audit — single-admin site, role "admin"
 * IS the owner): the owner never carries a "Free"/"Pro" plan badge. The
 * plan ladder only exists for customers; the owner sees a single "Owner"
 * identity badge with the full-access note. Non-admin users keep the
 * Free/Pro ladder exactly as before.
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

  const isOwner = user.role === "admin";
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
          className={cn(
            "flex size-11 items-center justify-center rounded-btn outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
            isOwner && "group"
          )}
        >
          <Avatar
            className={cn(
              "size-8 border border-border",
              isOwner && "border-primary/40 ring-2 ring-primary/15"
            )}
          >
            <AvatarFallback
              className={cn(
                "text-xs font-semibold",
                isOwner
                  ? "bg-primary/15 text-primary"
                  : "bg-primary/10 text-primary"
              )}
            >
              {initialsOf(user)}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 rounded-card">
        {/* Identity header — owner gets the crowned gradient treatment. */}
        <DropdownMenuLabel
          className={cn(
            "flex items-center gap-3 py-3",
            isOwner &&
              "border-b border-primary/15 bg-gradient-to-br from-primary/10 via-transparent to-transparent"
          )}
        >
          <Avatar
            className={cn(
              "size-10 border border-border",
              isOwner && "border-primary/30"
            )}
          >
            <AvatarFallback
              className={cn(
                "text-sm font-semibold",
                isOwner
                  ? "bg-primary/15 text-primary"
                  : "bg-primary/10 text-primary"
              )}
            >
              {initialsOf(user)}
            </AvatarFallback>
          </Avatar>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-sm font-semibold text-foreground">
              {user.name?.trim() || user.email}
            </span>
            <span className="truncate text-xs font-normal text-muted-foreground">
              {user.email}
            </span>
          </span>
        </DropdownMenuLabel>

        {/* Status line — the plan ladder for customers, Owner for the owner. */}
        <DropdownMenuLabel className="flex flex-col items-start gap-1.5 py-2">
          {isOwner ? (
            <>
              <Badge
                variant="default"
                className="rounded-chip border-primary/30 bg-primary/15 text-primary"
              >
                <Crown className="size-3" aria-hidden="true" />
                {t("auth.menuOwner")}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {t("auth.ownerNote")}
              </span>
            </>
          ) : isPro ? (
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
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={() => navigateToHash(ROUTES.account)}
          className="min-h-11 cursor-pointer rounded-btn"
        >
          <Settings className="size-4" aria-hidden="true" />
          {t("auth.menuSettings")}
        </DropdownMenuItem>
        {isOwner ? (
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
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleLogout}
          className="min-h-11 cursor-pointer rounded-btn text-muted-foreground focus:text-destructive"
        >
          <LogOut className="size-4" aria-hidden="true" />
          {t("auth.menuLogout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
