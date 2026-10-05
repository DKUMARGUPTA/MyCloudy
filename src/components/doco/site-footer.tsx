"use client";

import { Lock } from "lucide-react";

import { Logo } from "@/components/doco/logo";
import { useI18n } from "@/components/providers/locale-provider";
import { categories } from "@/data/catalog-summary";

/**
 * Site footer (PRD §5.2, Phase 0 scope).
 * Full link columns (Company/Legal/Help) arrive with Phase 1/6 pages.
 * The trust line is live from day one.
 */
export function SiteFooter() {
  const { t } = useI18n();
  const year = new Date().getFullYear();

  return (
    <footer className="mt-auto border-t border-border bg-surface">
      <div className="mx-auto w-full max-w-6xl space-y-8 px-4 py-10">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <Logo />
            <p className="text-sm text-muted-foreground">
              {t("footer.tagline")}
            </p>
          </div>
          <p className="flex max-w-sm items-start gap-2 text-sm text-muted-foreground">
            <Lock className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
            {t("footer.trust")}
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("footer.categoriesLabel")}
          </p>
          <ul className="flex flex-wrap gap-2">
            {categories.map((category) => (
              <li
                key={category.id}
                className="rounded-chip border border-border bg-background px-3 py-1 text-xs text-muted-foreground"
              >
                {t(category.nameKey)}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>{t("footer.rights", { year })}</p>
          <p>{t("footer.phaseNote")}</p>
        </div>
      </div>
    </footer>
  );
}
