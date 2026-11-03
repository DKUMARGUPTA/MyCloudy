"use client";

import { Lock, ShieldCheck } from "lucide-react";

import { Logo } from "@/components/sidocs/logo";
import { openConsentSettings } from "@/components/sidocs/cookie-banner";
import { PwaStatus } from "@/components/sidocs/pwa/pwa-status";
import { useI18n } from "@/components/providers/locale-provider";
import {
  CATEGORIES,
  popularTools,
  totalToolCount,
} from "@/lib/tools/registry";
import { ROUTES } from "@/hooks/use-hash-route";

/**
 * Site footer (PRD §5.2): brand column with the trust line + privacy
 * settings, Popular tools / Categories / Company / Legal link columns,
 * and the bottom rights bar.
 */

const footerLinkClass =
  "inline-flex min-h-9 items-center rounded-btn text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function SiteFooter() {
  const { t, locale } = useI18n();
  const year = new Date().getFullYear();
  const popular = popularTools(6);

  return (
    <footer className="mt-auto border-t border-border bg-surface">
      <div className="mx-auto w-full max-w-6xl space-y-10 px-4 py-10 pb-24 md:pb-10">
        {/* Brand column + link columns */}
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <div className="space-y-3">
            <Logo />
            <p className="text-sm text-muted-foreground">
              {t("footer.tagline")}
            </p>
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
            <PwaStatus />
          </div>

          <nav aria-label={t("footer.popularLabel")} className="space-y-2">
            <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <span
                className="inline-block h-[3px] w-1 rounded-full bg-primary/60"
                aria-hidden="true"
              />
              {t("footer.popularLabel")}
            </p>
            <ul className="space-y-0.5">
              {popular.map((tool) => (
                <li key={tool.id}>
                  <a href={ROUTES.tool(tool.id)} className={footerLinkClass}>
                    {tool.name[locale]}
                  </a>
                </li>
              ))}
              <li>
                <a
                  href={ROUTES.tools}
                  className="inline-flex min-h-9 items-center rounded-btn text-sm font-medium text-primary outline-none transition-colors hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {t("header.seeAllTools", { count: totalToolCount })}
                </a>
              </li>
            </ul>
          </nav>

          <nav aria-label={t("footer.categoriesLabel")} className="space-y-2">
            <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <span
                className="inline-block h-[3px] w-1 rounded-full bg-primary/60"
                aria-hidden="true"
              />
              {t("footer.categoriesLabel")}
            </p>
            <ul className="space-y-0.5">
              {CATEGORIES.map((category) => (
                <li key={category.id}>
                  <a
                    href={ROUTES.category(category.id)}
                    className={footerLinkClass}
                  >
                    {category.name[locale]}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="grid grid-cols-2 gap-6 sm:grid-cols-1">
            <nav
              aria-label={t("footer.companyLabel")}
              className="space-y-2"
            >
              <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <span
                  className="inline-block h-[3px] w-1 rounded-full bg-primary/60"
                  aria-hidden="true"
                />
                {t("footer.companyLabel")}
              </p>
              <ul className="space-y-0.5">
                <li>
                  <a
                    href={ROUTES.page("about")}
                    className={footerLinkClass}
                  >
                    {t("footer.about")}
                  </a>
                </li>
                <li>
                  <a
                    href={ROUTES.page("contact")}
                    className={footerLinkClass}
                  >
                    {t("footer.contact")}
                  </a>
                </li>
              </ul>
            </nav>

            <nav aria-label={t("footer.legalLabel")} className="space-y-2">
              <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <span
                  className="inline-block h-[3px] w-1 rounded-full bg-primary/60"
                  aria-hidden="true"
                />
                {t("footer.legalLabel")}
              </p>
              <ul className="space-y-0.5">
                <li>
                  <a
                    href={ROUTES.page("privacy")}
                    className={footerLinkClass}
                  >
                    {t("footer.privacy")}
                  </a>
                </li>
                <li>
                  <a
                    href={ROUTES.page("terms")}
                    className={footerLinkClass}
                  >
                    {t("footer.terms")}
                  </a>
                </li>
              </ul>
            </nav>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-border pt-6 text-xs text-muted-foreground">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p>{t("footer.rights", { year })}</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <p className="flex items-center gap-1.5">
                <span aria-hidden="true">🇮🇳</span>
                {t("footer.madeIn")}
              </p>
              <span className="rounded-chip border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                <span className="sr-only">{t("footer.versionLabel")}: </span>v1.0.0
              </span>
            </div>
          </div>
          <p>{t("footer.phaseNote")}</p>
        </div>
      </div>
    </footer>
  );
}
