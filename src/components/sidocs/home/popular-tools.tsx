"use client";

import type { CSSProperties } from "react";

import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";

import {
  categoryChipClass,
  categoryHoverClass,
  getCategory,
  getTool,
} from "@/lib/tools/registry";
import { useI18n } from "@/components/providers/locale-provider";
import { ROUTES } from "@/hooks/use-hash-route";
import { cn } from "@/lib/utils";

/**
 * Popular PDF tools (SEO keyword surface): the highest-search-intent live
 * tools as keyword-anchored links — "JPG to PDF", "PDF to JPG", "Merge
 * PDF", "Compress PDF", "Edit PDF", "Sign PDF", "PDF OCR", "Create PDF".
 * Names/descriptions/icons come straight from the registry (always in
 * sync, i18n'd) — only the section copy lives in i18n ("popular.*").
 *
 * P11 polish: per-category accent line + gradient icon chip that springs
 * on hover, a corner ArrowUpRight affordance, hover lift, and a staggered
 * fade-up entrance (skipped entirely under prefers-reduced-motion).
 */
const POPULAR_TOOL_IDS = [
  "jpg-to-pdf",
  "pdf-to-jpg",
  "merge-pdf",
  "compress-pdf",
  "edit-pdf",
  "sign-pdf",
  "ocr-pdf",
  "create-pdf",
] as const;

export function PopularTools() {
  const { t, locale } = useI18n();
  const reduceMotion = useReducedMotion();

  const tools = POPULAR_TOOL_IDS.map((id) => getTool(id)).filter(
    (tool): tool is NonNullable<typeof tool> => Boolean(tool?.enabled)
  );
  if (tools.length === 0) return null;

  const gridClassName =
    "mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4";

  const cards = tools.map((tool, index) => {
    const Icon = tool.icon;
    const color = getCategory(tool.category).color;
    const card = (
      <a
        href={ROUTES.tool(tool.id)}
        style={{ "--cat-accent": `var(--cat-${color})` } as CSSProperties}
        className={cn(
          "group relative flex h-full min-h-22 flex-col gap-2.5 rounded-card border border-border bg-card p-4 shadow-xs outline-none transition-all duration-300 hover:-translate-y-1 hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/50",
          categoryHoverClass[color]
        )}
      >
        <span className="card-accent-line" aria-hidden="true" />
        <ArrowUpRight
          className="pointer-events-none absolute right-3 top-3 size-4 -translate-x-1 translate-y-1 text-muted-foreground opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100"
          aria-hidden="true"
        />
        <span className="flex min-w-0 items-center gap-2.5 pr-7">
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-xl shadow-sm transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:scale-110",
              categoryChipClass[color]
            )}
            style={{
              backgroundImage:
                "linear-gradient(135deg, color-mix(in oklab, var(--cat-accent) 20%, transparent), transparent 72%)",
            }}
            aria-hidden="true"
          >
            <Icon className="size-4.5" />
          </span>
          <span className="font-semibold">{tool.name[locale]}</span>
        </span>
        <span className="text-sm text-muted-foreground">
          {tool.description[locale]}
        </span>
      </a>
    );

    return reduceMotion ? (
      <li key={tool.id}>{card}</li>
    ) : (
      <motion.li
        key={tool.id}
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
      id="popular-tools"
      aria-labelledby="popular-title"
      className="scroll-mt-20"
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2
            id="popular-title"
            className="text-2xl font-bold tracking-tight sm:text-3xl"
          >
            {t("popular.title")}
          </h2>
          <p className="mt-2 text-muted-foreground">
            {t("popular.subtitle")}
          </p>
        </div>

        {reduceMotion ? (
          <ul className={gridClassName}>{cards}</ul>
        ) : (
          <motion.ul className={gridClassName}>{cards}</motion.ul>
        )}
      </div>
    </section>
  );
}
