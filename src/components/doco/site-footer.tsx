"use client";

import { Lock, ShieldCheck, Languages } from "lucide-react";

import { Logo } from "@/components/doco/logo";
import { openConsentSettings } from "@/components/doco/cookie-banner";
import { useI18n } from "@/components/providers/locale-provider";
import {
  categoryChipClass,
  CATEGORIES,
  totalToolCount,
} from "@/lib/tools/registry";
import {
  localizedRoutes,
  useUrlLocale,
  type HashRoute,
} from "@/hooks/use-hash-route";
import { cn } from "@/lib/utils";

/** Mirror of the current route in the OTHER locale ("/tool/x" ↔
 * "/hi/tool/x") — the crawlable cross-locale footer link (R19 Phase 5).
 * Computed from the route so it is correct in the RAW HTML: crawlers and
 * no-JS visitors get a real <a> to the opposite locale of THIS page. */
function mirroredRouteHref(route: HashRoute, urlLocale: "en" | "hi"): string {
  let base: string;
  switch (route.view) {
    case "tool":
      base = `/tool/${route.toolId ?? ""}`;
      break;
    case "page":
      base = `/${route.pageId ?? ""}`;
      break;
    case "tools":
      base = route.category ? `/tools/${route.category}` : "/tools";
      break;
    default:
      base = "/";
  }
  if (route.query) base += `?q=${encodeURIComponent(route.query)}`;
  if (urlLocale === "en") {
    return base === "/" ? "/hi" : `/hi${base}`;
  }
  return base;
}

/**
 * Site footer (PRD §5.2): tagline, trust line, category links, company
 * pages (about/contact/privacy/terms — Phase 6 static pages), privacy
 * settings (re-opens the consent banner), and the cross-locale link
 * (R19 Phase 5 — the only always-visible EN↔HI anchor on every page).
 */
export function SiteFooter({ route }: { route: HashRoute }) {
  const { t, locale } = useI18n();
  const urlLocale = useUrlLocale();
  const routes = localizedRoutes(urlLocale);
  const otherLocaleHref = mirroredRouteHref(route, urlLocale);
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
              href={routes.tools}
              className="inline-flex min-h-11 items-center rounded-btn text-sm font-medium text-primary outline-none transition-colors hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {t("header.seeAllTools", { count: totalToolCount })}
            </a>
            {/* Cross-locale link (R19 Phase 5): a REAL anchor to the
             * opposite-locale mirror of this page. Crawlable in the raw
             * HTML (hreflang <link>s alone left discovery blind without
             * JS); with JS the AppShell interceptor flips the locale and
             * mirrors the URL without a reload; middle-click / no-JS get
             * a full SSR load in the other language. */}
            <a
              href={otherLocaleHref}
              hrefLang={urlLocale === "en" ? "hi" : "en"}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-btn text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Languages className="size-4" aria-hidden="true" />
              {t("footer.readOther")}
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
                    href={routes.category(category.id)}
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

        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("footer.companyLabel")}
          </p>
          <nav aria-label={t("footer.companyLabel")}>
            <ul className="flex flex-wrap gap-x-5 gap-y-1">
              {(
                [
                  ["about", t("footer.linkAbout")],
                  ["contact", t("footer.linkContact")],
                  ["privacy", t("footer.linkPrivacy")],
                  ["terms", t("footer.linkTerms")],
                ] as const
              ).map(([id, label]) => (
                <li key={id}>
                  <a
                    href={routes.page(id)}
                    className="inline-flex min-h-11 items-center rounded-btn text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
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
