"use client";

import type { CSSProperties } from "react";

import { motion, useReducedMotion } from "framer-motion";
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
 *
 * P11 polish: per-category accent line + gradient icon chip that springs
 * on hover, a smoother corner chevron nudge, the tool count as a muted
 * chip, and a staggered fade-up entrance (skipped entirely under
 * prefers-reduced-motion).
 */
export function Categories() {
  const { t, locale } = useI18n();
  const reduceMotion = useReducedMotion();

  const gridClassName =
    "mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3";

  const cards = CATEGORIES.map((category, index) => {
    const Icon = category.icon;
    const tools = toolsByCategory(category.id);
    const card = (
      <a
        href={ROUTES.category(category.id)}
        aria-label={t("categories.openCategory", {
          category: category.name[locale],
        })}
        style={
          { "--cat-accent": `var(--cat-${category.color})` } as CSSProperties
        }
        className={cn(
          "group relative flex w-full items-center gap-4 rounded-card border border-border bg-card p-4 text-left shadow-xs outline-none transition-all duration-300",
          "hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/50",
          categoryHoverClass[category.color]
        )}
      >
        <span className="card-accent-line" aria-hidden="true" />
        <span
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-xl shadow-sm transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:scale-110",
            categoryChipClass[category.color]
          )}
          style={{
            backgroundImage:
              "linear-gradient(135deg, color-mix(in oklab, var(--cat-accent) 20%, transparent), transparent 72%)",
          }}
          aria-hidden="true"
        >
          <Icon className="size-6" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-foreground">
            {category.name[locale]}
          </span>
          <span className="mt-1 inline-flex items-center rounded-chip bg-muted px-2 py-0.5 text-xs text-muted-foreground">
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
            className="size-5 text-muted-foreground transition-transform duration-300 ease-out group-hover:translate-x-1"
            aria-hidden="true"
          />
        </span>
      </a>
    );

    return reduceMotion ? (
      <li key={category.id}>{card}</li>
    ) : (
      <motion.li
        key={category.id}
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.45, delay: index * 0.05 }}
      >
        {card}
      </motion.li>
    );
  });

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

        {reduceMotion ? (
          <ul className={gridClassName}>{cards}</ul>
        ) : (
          <motion.ul className={gridClassName}>{cards}</motion.ul>
        )}

        <p className="mt-4 text-xs text-muted-foreground">
          {t("categories.phaseNote")}
        </p>
      </div>
    </section>
  );
}
