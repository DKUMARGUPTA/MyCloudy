"use client";

import { useState } from "react";
import { Menu } from "lucide-react";

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
import { useI18n } from "@/components/providers/locale-provider";

interface SiteHeaderProps {
  onGetPro: () => void;
}

const NAV_ITEMS = [
  { href: "#categories", labelKey: "header.categories" },
  { href: "#how", labelKey: "header.tools" },
  { href: "#why", labelKey: "header.why" },
] as const;

/**
 * Sticky site header (PRD §5.1).
 * Desktop: logo, anchor nav, language switch, theme toggle, Get Pro.
 * Mobile: logo + hamburger; language/theme move into the sheet (PRD §5.1).
 * Search (Ctrl+K) and the full mega-menu arrive with Phase 1.
 */
export function SiteHeader({ onGetPro }: SiteHeaderProps) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background/85 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-2 px-4">
        <a
          href="#top"
          aria-label={t("a11y.logoLabel")}
          className="rounded-btn outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Logo />
        </a>

        <nav
          aria-label="Primary"
          className="ml-6 hidden items-center gap-1 md:flex"
        >
          {NAV_ITEMS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-btn px-3 py-2 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {t(item.labelKey)}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1.5">
          <div className="hidden md:block">
            <LanguageSwitch />
          </div>
          <div className="hidden md:block">
            <ThemeToggle />
          </div>
          <Button
            type="button"
            variant="cta"
            size="touch"
            className="hidden sm:inline-flex"
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
        <SheetContent side="right" className="w-[85vw] max-w-xs gap-0">
          <SheetHeader className="border-b border-border pb-4">
            <SheetTitle asChild>
              <div>
                <Logo />
              </div>
            </SheetTitle>
          </SheetHeader>

          <nav aria-label="Mobile" className="flex flex-col gap-1 p-4">
            {NAV_ITEMS.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={() => setMenuOpen(false)}
                className="flex min-h-11 items-center rounded-btn px-3 text-base font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {t(item.labelKey)}
              </a>
            ))}
          </nav>

          <div className="mt-auto space-y-4 border-t border-border p-4">
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
              className="w-full"
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
