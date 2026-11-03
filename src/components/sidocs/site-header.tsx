"use client";

import { useCallback, useEffect, useState } from "react";
import { LogOut, Menu, Search, ShieldCheck, UserRound } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Logo } from "@/components/sidocs/logo";
import { LanguageSwitch } from "@/components/sidocs/language-switch";
import { ThemeToggle } from "@/components/sidocs/theme-toggle";
import { MegaMenu } from "@/components/sidocs/mega-menu";
import { AuthModal } from "@/components/sidocs/account/auth-modal";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import {
  bootstrapAuth,
  logout,
  openAuthModal,
  useAuth,
  type SafeUser,
} from "@/lib/auth-client";
import {
  categoryChipClass,
  CATEGORIES,
} from "@/lib/tools/registry";
import { ROUTES, type HashRoute } from "@/hooks/use-hash-route";
import { cn } from "@/lib/utils";

interface SiteHeaderProps {
  onGetPro: () => void;
  onOpenSearch: () => void;
  route: HashRoute;
}

/** Initials (or first letter) for the signed-in avatar. */
function initialsFor(user: SafeUser): string {
  const name = (user.name ?? "").trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
    if (parts.length > 0) {
      return parts.map((part) => part.charAt(0).toUpperCase()).join("");
    }
  }
  return user.email.charAt(0).toUpperCase();
}

/**
 * Sticky site header (PRD §5.1): logo, mega-menu, All Tools link,
 * Ctrl+K search trigger, language switch, theme toggle, Get Pro.
 * Mobile: logo + search + hamburger; categories and settings live in the
 * sheet. Bottom tab bar handles primary mobile navigation.
 */
export function SiteHeader({ onGetPro, onOpenSearch, route }: SiteHeaderProps) {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const { toast } = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  // P12: fetch the session once per page load (idempotent module guard).
  useEffect(() => {
    bootstrapAuth();
  }, []);

  // P11 polish: intensify the sticky bar (stronger bg + shadow-sm) once
  // the page scrolls past 8px; keep the airy look while at the top.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const handleLogout = useCallback(() => {
    setMenuOpen(false);
    void logout();
    toast({ title: t("auth.signedOut") });
  }, [t, toast]);

  return (
    <header
      className={cn(
        "sticky top-0 z-40 w-full border-b border-border backdrop-blur-md transition-[background-color,box-shadow] duration-200",
        scrolled
          ? "bg-background/95 shadow-sm"
          : "bg-background/85 supports-[backdrop-filter]:bg-background/70",
      )}
    >
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-2 px-4">
        <a
          href="#/"
          aria-label={t("a11y.logoLabel")}
          className="rounded-btn outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Logo />
        </a>

        <div className="ml-2 hidden items-center gap-1 md:flex">
          <MegaMenu />
          <a
            href={ROUTES.tools}
            aria-current={route.view === "tools" ? "page" : undefined}
            className="flex min-h-11 items-center rounded-btn px-3 text-sm font-medium outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-[current=page]:text-primary"
          >
            {t("tools.title")}
          </a>
          <a
            href="#why"
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
            className="hidden gap-2 rounded-btn px-3 text-muted-foreground hover:border-primary/40 sm:inline-flex"
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

          {user ? (
            <div className="hidden md:block">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("account.title")}
                    className="flex size-11 items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <Avatar className="size-8 border border-border">
                      <AvatarFallback className="bg-primary text-sm font-semibold text-primary-foreground">
                        {initialsFor(user)}
                      </AvatarFallback>
                    </Avatar>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel className="min-w-0 py-2">
                    <span className="block truncate text-sm font-semibold">
                      {user.name ?? user.email}
                    </span>
                    <span className="block truncate text-xs font-normal text-muted-foreground">
                      {user.email}
                    </span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild className="min-h-11 py-2">
                    <a
                      href={ROUTES.account}
                      className="flex items-center gap-2"
                    >
                      <UserRound className="size-4" aria-hidden="true" />
                      {t("account.title")}
                    </a>
                  </DropdownMenuItem>
                  {user.role === "admin" ? (
                    <DropdownMenuItem asChild className="min-h-11 py-2">
                      <a
                        href={ROUTES.admin()}
                        className="flex items-center gap-2"
                      >
                        <ShieldCheck className="size-4" aria-hidden="true" />
                        {t("account.adminConsole")}
                      </a>
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    className="min-h-11 py-2"
                    onClick={handleLogout}
                  >
                    <LogOut className="size-4" aria-hidden="true" />
                    {t("auth.logout")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="touch"
              className="hidden gap-1.5 rounded-btn text-muted-foreground hover:text-foreground sm:inline-flex"
              onClick={() => openAuthModal("login")}
            >
              <UserRound className="size-4" aria-hidden="true" />
              {t("account.signInCta")}
            </Button>
          )}

          <Button
            type="button"
            variant="cta"
            size="touch"
            className="hidden rounded-btn bg-gradient-to-r from-primary to-cta text-white shadow-md hover:-translate-y-0.5 hover:shadow-lg hover:brightness-110 xl:inline-flex"
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
            aria-label="Mobile categories"
            className="flex flex-col gap-1 p-4"
          >
            <a
              href={ROUTES.tools}
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
                  href={ROUTES.category(category.id)}
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
              onClick={() => setMenuOpen(false)}
              className="flex min-h-11 items-center rounded-btn px-3 text-base font-medium text-muted-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {t("header.why")}
            </a>
          </nav>

          <div className="mt-auto space-y-4 border-t border-border p-4">
            {user ? (
              <div className="space-y-1">
                <div className="flex items-center gap-3 px-1 pb-2">
                  <Avatar className="size-10 shrink-0">
                    <AvatarFallback className="bg-primary text-sm font-semibold text-primary-foreground">
                      {initialsFor(user)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {user.name ?? user.email}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {user.email}
                    </p>
                  </div>
                </div>
                <a
                  href={ROUTES.account}
                  onClick={() => setMenuOpen(false)}
                  className="flex min-h-11 items-center gap-3 rounded-btn px-3 text-base font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <UserRound className="size-5 text-primary" aria-hidden="true" />
                  {t("account.title")}
                </a>
                {user.role === "admin" ? (
                  <a
                    href={ROUTES.admin()}
                    onClick={() => setMenuOpen(false)}
                    className="flex min-h-11 items-center gap-3 rounded-btn px-3 text-base font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <ShieldCheck
                      className="size-5 text-primary"
                      aria-hidden="true"
                    />
                    {t("account.adminConsole")}
                  </a>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  className="w-full rounded-btn"
                  onClick={handleLogout}
                >
                  <LogOut className="size-4" aria-hidden="true" />
                  {t("auth.logout")}
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="cta"
                size="touch"
                className="w-full rounded-btn bg-gradient-to-r from-primary to-cta text-white shadow-md hover:-translate-y-0.5 hover:shadow-lg hover:brightness-110"
                onClick={() => {
                  setMenuOpen(false);
                  openAuthModal("login");
                }}
              >
                <UserRound className="size-4" aria-hidden="true" />
                {t("account.signInCta")}
              </Button>
            )}
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
              className="w-full rounded-btn bg-gradient-to-r from-primary to-cta text-white shadow-md hover:-translate-y-0.5 hover:shadow-lg hover:brightness-110"
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

      <AuthModal />
    </header>
  );
}
