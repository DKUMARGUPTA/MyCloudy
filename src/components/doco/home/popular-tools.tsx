"use client";

import { getTool, categoryChipClass, categoryHoverClass } from "@/lib/tools/registry";
import { useI18n } from "@/components/providers/locale-provider";
import { useLocalizedRoutes } from "@/hooks/use-hash-route";
import { cn } from "@/lib/utils";

/**
 * Popular PDF tools (SEO keyword surface): the highest-search-intent live
 * tools as keyword-anchored links — "JPG to PDF", "PDF to JPG", "Merge
 * PDF", "Compress PDF", "Edit PDF", "Sign PDF", "PDF OCR", "Create PDF".
 * Names/descriptions/icons come straight from the registry (always in
 * sync, i18n'd) — only the section copy lives in i18n ("popular.*").
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
  const routes = useLocalizedRoutes();

  const tools = POPULAR_TOOL_IDS.map((id) => getTool(id)).filter(
    (tool): tool is NonNullable<typeof tool> => Boolean(tool?.enabled)
  );
  if (tools.length === 0) return null;

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

        <ul className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {tools.map((tool) => {
            const Icon = tool.icon;
            return (
              <li key={tool.id}>
                <a
                  href={routes.tool(tool.id)}
                  className={cn(
                    "group flex h-full min-h-22 flex-col gap-2.5 rounded-card border border-border bg-card p-4 shadow-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    categoryHoverClass[tool.category]
                  )}
                >
                  <span className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        "flex size-9 shrink-0 items-center justify-center rounded-btn",
                        categoryChipClass[tool.category]
                      )}
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
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
