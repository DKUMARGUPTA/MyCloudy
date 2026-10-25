"use client";

import { Lock, ShieldCheck } from "lucide-react";

import { Logo } from "@/components/doco/logo";
import { openConsentSettings } from "@/components/doco/cookie-banner";
import { useI18n } from "@/components/providers/locale-provider";
import {
  categoryChipClass,
  CATEGORIES,
  totalToolCount,
} from "@/lib/tools/registry";
import { ROUTES } from "@/hooks/use-hash-route";
import { cn } from "@/lib/utils";

/**
 * Site footer (PRD §5.2): tagline, trust line, category links, privacy
 * settings (re-opens the consent banner). Company/Legal link columns
 * arrive with the Phase 6 static pages.
 */
export function SiteFooter() {
  const { t, locale } = useI18n();
  const year = new Date().getFullYear();

  return (
    <footer className="mt-auto border-t border-border bg-surface">
      <div className="mx-auto w-full max-w-6xl space-y-8 px-4 py-10 pb-24 md:pb-10">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <Logo />
            <p className="text-sm text-muted-foreground">
              {t("footer.tagline")}
            </p>
            <a
              href={ROUTES.tools}
              className="inline-flex min-h-11 items-center rounded-btn text-sm font-medium text-primary outline-none transition-colors hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {t("header.seeAllTools", { count: totalToolCount })}
            </a>
          </div>
          <div className="max-w-sm space-y-3">
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <Lock
                className="mt-0.5 size-4 shrink-0 text-success"
                aria-hidden="true"
              />
              {t("footer.trust")}
            </p>
            <button
              type="button"
              onClick={openConsentSettings}
              className="inline-flex min-h-11 items-center gap-2 rounded-btn text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <ShieldCheck className="size-4" aria-hidden="true" />
              {t("consent.settings")}
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("footer.categoriesLabel")}
          </p>
          <ul className="flex flex-wrap gap-2">
            {CATEGORIES.map((category) => {
              const Icon = category.icon;
              return (
                <li key={category.id}>
                  <a
                    href={ROUTES.category(category.id)}
                    className="flex min-h-11 items-center gap-2 rounded-chip border border-border bg-background px-3 text-xs text-muted-foreground outline-none transition-colors hover:border-foreground/20 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <span
                      className={cn(
                        "flex size-5 items-center justify-center rounded-full",
                        categoryChipClass[category.color]
                      )}
                      aria-hidden="true"
                    >
                      <Icon className="size-3" />
                    </span>
                    {category.name[locale]}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="flex flex-col gap-3 border-t border-border pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <p className="font-medium text-foreground/70">
            {t("footer.rights", { year })}
          </p>
          <p className="leading-relaxed sm:text-right">
            {t("footer.phaseNote", { count: totalToolCount })}
          </p>
        </div>
      </div>
    </footer>
  );
}
