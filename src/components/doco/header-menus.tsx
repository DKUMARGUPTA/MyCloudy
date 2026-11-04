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
  CATEGORIES,
  categoryChipClass,
  getCategory,
  PHASE_LABELS,
  toolsByCategory,
  totalToolCount,
  type ToolCategoryId,
} from "@/lib/tools/registry";
import { useLocalizedRoutes } from "@/hooks/use-hash-route";
import { anchorClickHandler } from "@/lib/anchor";
import { cn } from "@/lib/utils";

/**
 * Header navigation (R51b — multi-menu redesign).
 *
 * The old single "Tools" mega-menu showed ~36 links in one 5-column wall
 * with truncated labels. It is now split into focused surfaces:
 *
 * - Desktop (lg+): six small dropdowns — Organize, Edit, Convert,
 *   Secure, Create and a standalone QR & Barcodes menu — each listing a
 *   category's most popular tools with FULL, untruncated names.
 * - Tablet (md–lg): one compact "Tools ▾" browse panel with all 11
 *   category chips (icon + name + count) and a catalog footer.
 *
 * Every panel keeps the honest-coming-soon toast for disabled tools and
 * a per-group "See all {category} tools" escape hatch. The full catalog
 * always lives one click away on the All Tools page.
 */

/* ------------------------------------------------------------------ */
/* Shared plumbing                                                     */
/* ------------------------------------------------------------------ */

/** Coming-soon toast for disabled tools (same UX as the old mega-menu). */
function useToolClickHandler() {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  return (
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
}

const TOOL_LINK_CLASS =
  "flex min-h-9 items-center gap-2 rounded-md px-2 py-1 text-[13px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50";

const SEE_ALL_CLASS =
  "inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-xs font-medium text-primary outline-none transition-colors hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50";

/* ------------------------------------------------------------------ */
/* Group column (one category inside a dropdown)                       */
/* ------------------------------------------------------------------ */

interface MenuGroupSpec {
  category: ToolCategoryId;
  /** How many popular tools to list (0 = every tool). */
  limit: number;
  /** Split this group's tools over two columns (single-group panels). */
  columns?: 1 | 2;
}

function MenuGroup({ category, limit, columns = 1 }: MenuGroupSpec) {
  const { t, locale } = useI18n();
  const routes = useLocalizedRoutes();
  const onToolClick = useToolClickHandler();

  const info = getCategory(category);
  const CategoryIcon = info.icon;
  const all = toolsByCategory(category);
  const tools = limit > 0 ? all.slice(0, limit) : all;

  return (
    <div className="min-w-0">
      <a
        href={routes.category(category)}
        className="flex min-h-10 items-center gap-2 rounded-md px-2 text-sm font-semibold text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md",
            categoryChipClass[info.color]
          )}
          aria-hidden="true"
        >
          <CategoryIcon className="size-3.5" />
        </span>
        <span className="min-w-0 whitespace-nowrap">{info.name[locale]}</span>
        <span
          className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground"
          aria-hidden="true"
        >
          {t("header.toolsCount", { count: all.length })}
        </span>
      </a>
      <ul
        className={cn(
          "mt-0.5 grid gap-y-0.5",
          columns === 2 ? "grid-cols-2 gap-x-3" : "grid-cols-1"
        )}
      >
        {tools.map((tool) => {
          const ToolIcon = tool.icon;
          return (
            <li key={tool.id}>
              <a
                href={
                  tool.enabled
                    ? routes.tool(tool.id)
                    : routes.category(category)
                }
                onClick={(event) =>
                  onToolClick(
                    event,
                    tool.enabled,
                    tool.name[locale],
                    tool.phase
                  )
                }
                className={TOOL_LINK_CLASS}
              >
                <ToolIcon
                  className="size-3.5 shrink-0 opacity-70"
                  aria-hidden="true"
                />
                <span className="whitespace-nowrap">{tool.name[locale]}</span>
              </a>
            </li>
          );
        })}
      </ul>
      <a href={routes.category(category)} className={SEE_ALL_CLASS}>
        {t("header.seeCategory", { category: info.name[locale] })}
        <ChevronRight className="size-3" aria-hidden="true" />
      </a>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Desktop: six focused dropdowns (lg+)                                */
/* ------------------------------------------------------------------ */

interface HeaderMenuSpec {
  id: string;
  /** Short trigger label — either an i18n key or a category's own name. */
  labelKey?: string;
  labelCategory?: ToolCategoryId;
  panelClass: string;
  groupsClass: string;
  groups: MenuGroupSpec[];
}

/**
 * All 11 categories stay reachable: organize/edit/qr surface directly,
 * while convert-to + convert-from + images, security + optimize and
 * create + invoices + view share a menu as labelled columns.
 */
const MENUS: HeaderMenuSpec[] = [
  {
    id: "organize",
    labelCategory: "organize",
    /* NB: shadcn's NavigationMenuContent base carries `md:w-auto`, which
     * out-cascades an un-prefixed width — panel widths MUST use md: too. */
    panelClass: "md:w-[26rem]",
    groupsClass: "grid-cols-1",
    groups: [{ category: "organize", limit: 12, columns: 2 }],
  },
  {
    id: "edit",
    labelCategory: "edit",
    panelClass: "md:w-[26rem]",
    groupsClass: "grid-cols-1",
    groups: [{ category: "edit", limit: 12, columns: 2 }],
  },
  {
    id: "convert",
    labelKey: "header.menuConvert",
    panelClass: "md:w-[48rem]",
    groupsClass: "grid-cols-3",
    groups: [
      { category: "convert-to", limit: 6 },
      { category: "convert-from", limit: 6 },
      { category: "images", limit: 6 },
    ],
  },
  {
    id: "secure",
    labelKey: "header.menuSecure",
    panelClass: "md:w-[32rem]",
    groupsClass: "grid-cols-2",
    groups: [
      { category: "security", limit: 8 },
      { category: "optimize", limit: 8 },
    ],
  },
  {
    id: "create",
    labelKey: "header.menuCreate",
    panelClass: "md:w-[48rem]",
    groupsClass: "grid-cols-3",
    groups: [
      { category: "create", limit: 6 },
      { category: "invoices", limit: 6 },
      { category: "view", limit: 6 },
    ],
  },
  {
    id: "qr",
    labelCategory: "qr",
    panelClass: "md:w-[21rem]",
    groupsClass: "grid-cols-1",
    groups: [{ category: "qr", limit: 0 }],
  },
];

export function HeaderMenus() {
  const { t, locale } = useI18n();

  return (
    <NavigationMenu
      viewport={false}
      aria-label={t("common.a11yMainNav")}
      className="hidden lg:flex"
    >
      <NavigationMenuList className="gap-0.5">
        {MENUS.map((menu) => {
          const label = menu.labelKey
            ? t(menu.labelKey)
            : getCategory(menu.labelCategory ?? "organize").name[locale];
          return (
            <NavigationMenuItem key={menu.id}>
              <NavigationMenuTrigger className="h-9 rounded-btn px-2 text-sm font-medium">
                {label}
              </NavigationMenuTrigger>
              <NavigationMenuContent className={cn(menu.panelClass, "p-3")}>
                <div className={cn("grid gap-4", menu.groupsClass)}>
                  {menu.groups.map((group) => (
                    <MenuGroup key={group.category} {...group} />
                  ))}
                </div>
              </NavigationMenuContent>
            </NavigationMenuItem>
          );
        })}
      </NavigationMenuList>
    </NavigationMenu>
  );
}

/* ------------------------------------------------------------------ */
/* Tablet: compact category browse (md–lg)                             */
/* ------------------------------------------------------------------ */

export function CategoryBrowseMenu() {
  const { t, locale } = useI18n();
  const routes = useLocalizedRoutes();

  return (
    <NavigationMenu
      viewport={false}
      aria-label={t("common.a11yMainNav")}
      className="lg:hidden"
    >
      <NavigationMenuList>
        <NavigationMenuItem>
          <NavigationMenuTrigger className="h-9 rounded-btn px-2.5 text-sm font-medium">
            {t("header.tools")}
          </NavigationMenuTrigger>
          <NavigationMenuContent className="md:w-[24rem] p-3">
            <ul className="grid grid-cols-2 gap-1">
              {CATEGORIES.map((category, index) => {
                const Icon = category.icon;
                /* Odd tail: the last chip goes full-width so an 11-category
                 * list doesn't leave one lonely item on its own row. */
                const isOddTail =
                  CATEGORIES.length % 2 === 1 && index === CATEGORIES.length - 1;
                return (
                  <li key={category.id} className={isOddTail ? "col-span-2" : undefined}>
                    <NavigationMenuLink
                      href={routes.category(category.id)}
                      className="flex min-h-11 items-center gap-2.5 rounded-md px-2 py-1.5"
                    >
                      <span
                        className={cn(
                          "flex size-8 shrink-0 items-center justify-center rounded-md",
                          categoryChipClass[category.color]
                        )}
                        aria-hidden="true"
                      >
                        <Icon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {category.name[locale]}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          {t("header.toolsCount", {
                            count: toolsByCategory(category.id).length,
                          })}
                        </span>
                      </span>
                    </NavigationMenuLink>
                  </li>
                );
              })}
            </ul>
            <div className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-2">
              <a
                href={routes.tools}
                className={cn(SEE_ALL_CLASS, "text-xs")}
              >
                {t("header.seeAllTools", { count: totalToolCount })}
                <ChevronRight className="size-3" aria-hidden="true" />
              </a>
              <a
                href="#why"
                onClick={anchorClickHandler("why")}
                className="inline-flex min-h-9 items-center rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {t("header.why")}
              </a>
            </div>
          </NavigationMenuContent>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  );
}
