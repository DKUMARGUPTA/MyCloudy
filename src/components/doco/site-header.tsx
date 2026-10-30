"use client";

import { useState } from "react";
import { LogOut, Menu, Search, UserRound } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Logo } from "@/components/doco/logo";
import { LanguageSwitch } from "@/components/doco/language-switch";
import { ThemeToggle } from "@/components/doco/theme-toggle";
import { MegaMenu } from "@/components/doco/mega-menu";
import { AccountMenu } from "@/components/doco/auth/account-menu";
import { useI18n } from "@/components/providers/locale-provider";
import { anchorClickHandler } from "@/lib/anchor";
import { logout, openAuthModal, useAuth } from "@/lib/auth-client";
import {
  categoryChipClass,
  CATEGORIES,
} from "@/lib/tools/registry";
import { useLocalizedRoutes, type HashRoute } from "@/hooks/use-hash-route";
import { cn } from "@/lib/utils";

interface SiteHeaderProps {
  onGetPro: () => void;
  onOpenSearch: () => void;
  route: HashRoute;
}

/**
 * Sticky site header (PRD §5.1): logo, mega-menu, All Tools link,
 * Ctrl+K search trigger, language switch, theme toggle, account menu,
 * Get Pro. Mobile: logo + search + hamburger; categories and settings
 * live in the sheet. Bottom tab bar handles primary mobile navigation.
 */
export function SiteHeader({ onGetPro, onOpenSearch, route }: SiteHeaderProps) {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const routes = useLocalizedRoutes();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background/85 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-2 px-4">
        <a
          href={routes.home}
          aria-label={t("a11y.logoLabel")}
          className="rounded-btn outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Logo />
        </a>

        <div className="ml-2 hidden items-center gap-1 md:flex">
          <MegaMenu />
          <a
            href={routes.tools}
            aria-current={route.view === "tools" ? "page" : undefined}
            className="flex min-h-11 items-center rounded-btn px-3 text-sm font-medium outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-[current=page]:text-primary"
          >
            {t("tools.title")}
          </a>
          <a
            href="#why"
            onClick={anchorClickHandler("why")}
            className="flex min-h-11 items-center rounded-btn px-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {t("header.why")}
          </a>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="hidden gap-2 rounded-btn px-3 text-muted-foreground sm:inline-flex"
            onClick={onOpenSearch}
          >
            <Search className="size-4" aria-hidden="true" />
            <span className="hidden text-sm lg:inline">
              {t("tools.searchLabel")}
            </span>
            <kbd className="pointer-events-none hidden rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground lg:inline-flex">
              {t("header.searchHint")}
            </kbd>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 rounded-btn sm:hidden"
            aria-label={t("header.openSearch")}
            onClick={onOpenSearch}
          >
            <Search className="size-5" aria-hidden="true" />
          </Button>
          <div className="hidden md:block">
            <LanguageSwitch />
          </div>
          <div className="hidden md:block">
            <ThemeToggle />
          </div>
          <AccountMenu />
          <Button
            type="button"
            variant="cta"
            size="touch"
            className="hidden rounded-btn xl:inline-flex"
            onClick={onGetPro}
          >
            {t("header.getPro")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 rounded-btn md:hidden"
            aria-label={t("common.openMenu")}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <Menu className="size-5" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent
          side="right"
          aria-describedby={undefined}
          className="w-[85vw] max-w-xs gap-0 overflow-y-auto scrollbar-thin"
        >
          <SheetHeader className="border-b border-border pb-4">
            <SheetTitle asChild>
              <div>
                <Logo />
              </div>
            </SheetTitle>
          </SheetHeader>

          <nav
            aria-label={t("common.a11yMobileCategories")}
            className="flex flex-col gap-1 p-4"
          >
            <a
              href={routes.tools}
              onClick={() => setMenuOpen(false)}
              className="flex min-h-11 items-center rounded-btn bg-primary/10 px-3 text-base font-semibold text-primary outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {t("tools.title")}
            </a>
            {CATEGORIES.map((category) => {
              const Icon = category.icon;
              return (
                <a
                  key={category.id}
                  href={routes.category(category.id)}
                  onClick={() => setMenuOpen(false)}
                  className="flex min-h-11 items-center gap-3 rounded-btn px-3 text-base font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <span
                    className={cn(
                      "flex size-8 items-center justify-center rounded-md",
                      categoryChipClass[category.color]
                    )}
                    aria-hidden="true"
                  >
                    <Icon className="size-4" />
                  </span>
                  {category.name[locale]}
                </a>
              );
            })}
            <a
              href="#why"
              onClick={(e) => {
                anchorClickHandler("why")(e);
                setMenuOpen(false);
              }}
              className="flex min-h-11 items-center rounded-btn px-3 text-base font-medium text-muted-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {t("header.why")}
            </a>
          </nav>

          <div className="mt-auto space-y-4 border-t border-border p-4">
            {/* Account (Phase-10): guests get a login entry, signed-in users
             * see their identity + logout — the sheet is the mobile surface. */}
            {user ? (
              <a
                href={routes.account}
                onClick={() => setMenuOpen(false)}
                className="flex min-h-11 items-center gap-3 rounded-btn px-1 py-1 outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Avatar className="size-9 border border-border">
                  <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                    {(user.name?.trim() || user.email).slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {user.name?.trim() || user.email}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {user.plan === "pro" ? t("auth.menuPlanPro") : t("auth.menuPlanFree")}{" — "}
                    {t("auth.menuSettings")}
                  </p>
                </div>
              </a>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="touch"
                className="w-full rounded-btn"
                onClick={() => {
                  setMenuOpen(false);
                  openAuthModal("login");
                }}
              >
                <UserRound className="size-4" aria-hidden="true" />
                {t("auth.tabLogin")}
              </Button>
            )}
            {user ? (
              <Button
                type="button"
                variant="ghost"
                size="touch"
                className="w-full rounded-btn text-muted-foreground"
                onClick={() => {
                  setMenuOpen(false);
                  void logout();
                }}
              >
                <LogOut className="size-4" aria-hidden="true" />
                {t("auth.menuLogout")}
              </Button>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-muted-foreground">
                {t("language.label")}
              </span>
              <LanguageSwitch />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-muted-foreground">
                {t("theme.label")}
              </span>
              <ThemeToggle />
            </div>
            <Button
              type="button"
              variant="cta"
              size="touch"
              className="w-full rounded-btn"
              onClick={() => {
                setMenuOpen(false);
                onGetPro();
              }}
            >
              {t("header.getPro")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </header>
  );
}
