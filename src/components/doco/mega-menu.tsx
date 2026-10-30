"use client";

import { ChevronRight } from "lucide-react";

import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@/components/ui/navigation-menu";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import {
  categoryChipClass,
  getCategory,
  PHASE_LABELS,
  toolsByCategory,
  totalToolCount,
  type ToolCategoryId,
} from "@/lib/tools/registry";
import { useLocalizedRoutes } from "@/hooks/use-hash-route";
import { cn } from "@/lib/utils";

/**
 * Header mega-menu (PRD §5.1): category columns with their tools, plus a
 * "See all tools" footer link. For usability each column lists the
 * category's top tools by popularity with a "See all" link — the complete
 * catalog lives on the All Tools page. Keyboard navigable via Radix.
 */

const COLUMN_CATEGORIES: ToolCategoryId[] = [
  "organize",
  "edit",
  "convert-to",
  "convert-from",
  "security",
];

const MORE_CATEGORIES: ToolCategoryId[] = [
  "optimize",
  "create",
  "invoices",
  "view",
  "images",
];

const TOOLS_PER_COLUMN = 6;

export function MegaMenu() {
  const { t, locale } = useI18n();
  const routes = useLocalizedRoutes();
  const { toast } = useToast();

  const onToolClick = (
    event: React.MouseEvent<HTMLAnchorElement>,
    enabled: boolean,
    toolName: string,
    phase: keyof typeof PHASE_LABELS
  ) => {
    if (enabled) return; // enabled tools navigate normally
    event.preventDefault();
    toast({
      title: t("tools.comingToastTitle", { tool: toolName }),
      description: t("tools.comingToastDesc", {
        phase: PHASE_LABELS[phase][locale],
      }),
    });
  };

  return (
    <NavigationMenu viewport={false} aria-label={t("common.a11yMainNav")}>
      <NavigationMenuList>
        <NavigationMenuItem>
          <NavigationMenuTrigger className="rounded-btn px-3">
            {t("header.tools")}
          </NavigationMenuTrigger>
          <NavigationMenuContent className="md:w-[46rem] lg:w-[52rem]">
            <div className="grid gap-3 p-4 md:grid-cols-3 lg:grid-cols-5">
              {COLUMN_CATEGORIES.map((categoryId) => {
                const category = getCategory(categoryId);
                const CategoryIcon = category.icon;
                const tools = toolsByCategory(categoryId).slice(
                  0,
                  TOOLS_PER_COLUMN
                );
                return (
                  <div key={categoryId} className="space-y-1.5">
                    <a
                      href={routes.category(categoryId)}
                      className={cn(
                        "flex min-h-10 items-center gap-2 rounded-btn px-2 text-sm font-semibold text-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-8 shrink-0 items-center justify-center rounded-md",
                          categoryChipClass[category.color]
                        )}
                        aria-hidden="true"
                      >
                        <CategoryIcon className="size-4" />
                      </span>
                      {category.name[locale]}
                    </a>
                    <ul className="space-y-0.5">
                      {tools.map((tool) => {
                        const ToolIcon = tool.icon;
                        return (
                          <li key={tool.id}>
                            <a
                              href={
                                tool.enabled
                                  ? routes.tool(tool.id)
                                  : routes.category(categoryId)
                              }
                              onClick={(event) =>
                                onToolClick(
                                  event,
                                  tool.enabled,
                                  tool.name[locale],
                                  tool.phase
                                )
                              }
                              className="flex min-h-9 items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                            >
                              <ToolIcon
                                className="size-3.5 shrink-0 opacity-70"
                                aria-hidden="true"
                              />
                              <span className="truncate">{tool.name[locale]}</span>
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                    <a
                      href={routes.category(categoryId)}
                      className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-xs font-medium text-primary outline-none transition-colors hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      {t("header.seeCategory", {
                        category: category.name[locale],
                      })}
                      <ChevronRight className="size-3" aria-hidden="true" />
                    </a>
                  </div>
                );
              })}

              {/* More categories column */}
              <div className="space-y-1.5">
                <p className="flex min-h-10 items-center px-2 text-sm font-semibold text-foreground">
                  {t("header.moreCategories")}
                </p>
                <ul className="space-y-0.5">
                  {MORE_CATEGORIES.map((categoryId) => {
                    const category = getCategory(categoryId);
                    const CategoryIcon = category.icon;
                    return (
                      <li key={categoryId}>
                        <NavigationMenuLink
                          href={routes.category(categoryId)}
                          className="flex min-h-9 flex-row items-center gap-2 px-2 py-1"
                        >
                          <span
                            className={cn(
                              "flex size-6 shrink-0 items-center justify-center rounded-md",
                              categoryChipClass[category.color]
                            )}
                            aria-hidden="true"
                          >
                            <CategoryIcon className="size-3.5" />
                          </span>
                          <span className="truncate text-sm text-muted-foreground">
                            {category.name[locale]}
                          </span>
                        </NavigationMenuLink>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>

            <div className="border-t border-border bg-muted/50 px-4 py-2.5">
              <a
                href={routes.tools}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-btn px-2 text-sm font-medium text-primary outline-none transition-colors hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {t("header.seeAllTools", { count: totalToolCount })}
                <ChevronRight className="size-4" aria-hidden="true" />
              </a>
            </div>
          </NavigationMenuContent>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  );
}
