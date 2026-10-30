"use client";

import { useMemo } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import { useLocalizedRoutes } from "@/hooks/use-hash-route";
import { ToolCard } from "@/components/doco/tools/tool-card";
import {
  categoryChipClass,
  CATEGORIES,
  getCategory,
  toolsByCategory,
  type ToolCategoryId,
} from "@/lib/tools/registry";
import { cn } from "@/lib/utils";

/**
 * Category view (PRD §6.2 "category pages par detailed intro"): colored
 * header with the registry intro text, Private/Server counts, the tool grid,
 * and cross-links to related categories.
 */
export function CategoryView({
  categoryId,
}: {
  categoryId: ToolCategoryId;
}) {
  const { t, locale } = useI18n();
  const routes = useLocalizedRoutes();
  const category = getCategory(categoryId);
  const tools = useMemo(() => toolsByCategory(categoryId), [categoryId]);

  const Icon = category.icon;
  const privateCount = tools.filter((tool) => tool.mode === "D").length;
  const serverCount = tools.filter((tool) => tool.mode === "S").length;
  const related = CATEGORIES.filter((item) => item.id !== categoryId).slice(
    0,
    5
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-8 sm:pt-10">
      <nav aria-label={t("common.a11yBreadcrumb")} className="flex items-center gap-1.5 text-sm">
        <a
          href={routes.home}
          className="flex min-h-11 items-center gap-1 rounded-btn px-2 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t("common.backToTools")}
        </a>
      </nav>

      <header className="mt-4 rounded-card border border-border bg-card p-6 shadow-xs sm:p-8">
        <div className="flex flex-wrap items-center gap-4">
          <span
            className={cn(
              "flex size-14 items-center justify-center rounded-btn",
              categoryChipClass[category.color]
            )}
            aria-hidden="true"
          >
            <Icon className="size-7" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
              {category.name[locale]}
            </h1>
            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>{t("tools.categoryTools", { count: tools.length })}</span>
              <span aria-hidden="true">·</span>
              <span>{t("tools.privateCount", { count: privateCount })}</span>
              <span aria-hidden="true">·</span>
              <span>{t("tools.serverCount", { count: serverCount })}</span>
            </p>
          </div>
        </div>
        <p className="mt-5 max-w-3xl text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
          {category.intro[locale]}
        </p>
      </header>

      <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {tools.map((tool) => (
          <li key={tool.id} className="flex">
            <div className="w-full">
              <ToolCard tool={tool} />
            </div>
          </li>
        ))}
      </ul>

      <section
        aria-labelledby="related-categories"
        className="mt-12 border-t border-border pt-6"
      >
        <h2
          id="related-categories"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          {t("header.moreCategories")}
        </h2>
        <ul className="mt-3 flex flex-wrap gap-2">
          {related.map((item) => {
            const RelatedIcon = item.icon;
            return (
              <li key={item.id}>
                <a
                  href={routes.category(item.id)}
                  className="flex min-h-11 items-center gap-2 rounded-chip border border-border bg-background px-4 text-sm font-medium text-muted-foreground outline-none transition-colors hover:border-foreground/20 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <RelatedIcon className="size-4" aria-hidden="true" />
                  {item.name[locale]}
                  <ChevronRight className="size-3.5" aria-hidden="true" />
                </a>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
