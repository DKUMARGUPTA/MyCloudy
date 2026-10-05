"use client";

import { ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/components/providers/locale-provider";
import {
  categoryChipClass,
  categoryHoverClass,
  CATEGORIES,
  totalToolCount,
  toolsByCategory,
} from "@/lib/tools/registry";
import { ROUTES } from "@/hooks/use-hash-route";
import { cn } from "@/lib/utils";

/**
 * Home category grid (PRD §6.1). Cards navigate to the category view
 * (hash route) showing the registry tools with their mode badges.
 */
export function Categories() {
  const { t, locale } = useI18n();

  return (
    <section
      id="categories"
      aria-labelledby="categories-title"
      className="scroll-mt-20 bg-surface"
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:py-20">
        <div className="max-w-2xl">
          <h2
            id="categories-title"
            className="text-2xl font-bold tracking-tight sm:text-3xl"
          >
            {t("categories.title")}
          </h2>
          <p className="mt-2 text-muted-foreground">
            {t("categories.subtitle", {
              count: totalToolCount,
              categories: CATEGORIES.length,
            })}
          </p>
        </div>

        <ul className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CATEGORIES.map((category) => {
            const Icon = category.icon;
            const tools = toolsByCategory(category.id);
            return (
              <li key={category.id}>
                <a
                  href={ROUTES.category(category.id)}
                  aria-label={t("categories.openCategory", {
                    category: category.name[locale],
                  })}
                  className={cn(
                    "group flex w-full items-center gap-4 rounded-card border border-border bg-card p-4 text-left shadow-xs outline-none transition-all",
                    "hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    categoryHoverClass[category.color]
                  )}
                >
                  <span
                    className={cn(
                      "flex size-12 shrink-0 items-center justify-center rounded-btn",
                      categoryChipClass[category.color]
                    )}
                    aria-hidden="true"
                  >
                    <Icon className="size-6" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-foreground">
                      {category.name[locale]}
                    </span>
                    <span className="mt-0.5 block text-sm text-muted-foreground">
                      {t("categories.plannedCount", { count: tools.length })}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1.5">
                    <Badge
                      variant="outline"
                      className="rounded-chip border-border px-2 text-[10px] text-muted-foreground"
                    >
                      {tools.some((tool) => tool.mode === "S")
                        ? `${t("categories.badgePrivate")} + ${t("categories.badgeServer")}`
                        : t("categories.badgePrivate")}
                    </Badge>
                    <ChevronRight
                      className="size-5 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                      aria-hidden="true"
                    />
                  </span>
                </a>
              </li>
            );
          })}
        </ul>

        <p className="mt-4 text-xs text-muted-foreground">
          {t("categories.phaseNote")}
        </p>
      </div>
    </section>
  );
}
