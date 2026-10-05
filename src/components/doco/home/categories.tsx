"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { BottomSheet } from "@/components/doco/bottom-sheet";
import { useI18n } from "@/components/providers/locale-provider";
import {
  categories,
  categoryChipClass,
  categoryHoverClass,
  totalPlannedTools,
  type CategorySummary,
} from "@/data/catalog-summary";
import { cn } from "@/lib/utils";

/**
 * Category grid (PRD §6.1 "Tool grid" preview, Phase 0 scope).
 * Every card opens a bottom sheet listing the planned tools with their
 * honest Private/Server mode badge (PRD §2.2).
 * Interactive tool cards + filtering arrive with Phase 1's registry.
 */
export function Categories() {
  const { t } = useI18n();
  const [active, setActive] = useState<CategorySummary | null>(null);

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
            {t("categories.subtitle", { count: totalPlannedTools })}
          </p>
        </div>

        <ul className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map((category) => {
            const Icon = category.icon;
            const name = t(category.nameKey);
            return (
              <li key={category.id}>
                <button
                  type="button"
                  onClick={() => setActive(category)}
                  aria-haspopup="dialog"
                  aria-label={t("categories.openCategory", { category: name })}
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
                      {name}
                    </span>
                    <span className="mt-0.5 block text-sm text-muted-foreground">
                      {t("categories.plannedCount", {
                        count: category.tools.length,
                      })}
                    </span>
                  </span>
                  <ChevronRight
                    className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <BottomSheet
        open={active !== null}
        onOpenChange={(open) => {
          if (!open) setActive(null);
        }}
        title={
          active
            ? t("categories.sheetTitle", { category: t(active.nameKey) })
            : ""
        }
        description={t("categories.sheetSubtitle")}
      >
        {active ? (
          <>
            <ul className="-mx-1 max-h-[55vh] space-y-1 overflow-y-auto scrollbar-thin px-1">
              {active.tools.map((tool) => (
                <li
                  key={tool.name}
                  className="flex min-h-11 items-center justify-between gap-3 rounded-btn px-3 py-2 transition-colors hover:bg-accent"
                >
                  <span className="text-sm text-foreground">{tool.name}</span>
                  <Badge
                    variant={tool.mode === "D" ? "private" : "server"}
                    className="rounded-chip px-2.5 py-0.5"
                  >
                    {tool.mode === "D"
                      ? t("categories.badgePrivate")
                      : t("categories.badgeServer")}
                  </Badge>
                </li>
              ))}
            </ul>
            <p className="mt-3 px-3 text-xs text-muted-foreground">
              {t("categories.phaseNote")}
            </p>
          </>
        ) : null}
      </BottomSheet>
    </section>
  );
}
