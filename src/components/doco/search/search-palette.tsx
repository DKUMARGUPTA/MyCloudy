"use client";

import { useEffect, useMemo, useState } from "react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Route as RouteIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import { searchTools } from "@/lib/search/fuzzy";
import {
  parseRouteQuery,
  findRoutes,
  hasDirectRoute,
  routeStepLabel,
} from "@/lib/tools/router";
import {
  PHASE_LABELS,
  popularTools,
  type ToolDef,
} from "@/lib/tools/registry";
import { useFavoriteTools } from "@/lib/tools/favorites";
import { ROUTES, navigateToHash } from "@/hooks/use-hash-route";
import { ALL_TOOLS } from "@/lib/tools/registry";

const ALL_TOOLS_BY_ID = new Map(ALL_TOOLS.map((tool) => [tool.id, tool]));

/**
 * Ctrl+K / "/" tool search palette (PRD §5.1).
 * Fuzzy search over the registry with popular suggestions and favorites;
 * Enter navigates to the tool's home (category view) — tools that are not
 * live yet explain their roadmap phase via toast. "See all results" opens
 * the All Tools view with the query pre-filled.
 */
export function SearchPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const favoriteTools = useFavoriteTools();

  // Global shortcuts: Ctrl/Cmd+K and "/" (ignored while typing in fields).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;

      if ((event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        onOpenChange(true);
      } else if (event.key === "/" && !typing) {
        event.preventDefault();
        onOpenChange(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange]);

  const results = useMemo(
    () => (query.trim() ? searchTools(query.trim(), locale) : []),
    [query, locale]
  );
  const popular = useMemo(() => popularTools(8), []);

  // Smart format routes (P3): "docx to png" style queries where no single
  // tool covers the pair get multi-hop chain suggestions from our router.
  const routeSuggestion = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    const parsed = parseRouteQuery(q);
    if (!parsed) return null;
    const { from, to } = parsed;
    const direct = hasDirectRoute(from, to);
    const routes = findRoutes(from, to, 3);
    if (direct && routes.length === 0) return null;
    // Only surface chains when they add value: either no direct tool, or
    // the route offers an alternative path (still lead with the direct one).
    const chainRoutes = routes.filter((r) => r.steps.length > 1 || !direct);
    if (chainRoutes.length === 0 && !direct) return null;
    return { from, to, direct, routes: chainRoutes.slice(0, 2) };
  }, [query]);

  const handleOpenChange = (next: boolean) => {
    // Clear the query on close via the event handler (not an effect).
    if (!next) setQuery("");
    onOpenChange(next);
  };

  const openTool = (tool: ToolDef) => {
    handleOpenChange(false);
    if (tool.enabled) {
      navigateToHash(ROUTES.tool(tool.id));
      return;
    }
    toast({
      title: t("tools.comingToastTitle", { tool: tool.name[locale] }),
      description: t("tools.comingToastDesc", {
        phase: PHASE_LABELS[tool.phase][locale],
      }),
    });
    // Route through the hash-navigation helper so the hashchange event
    // fires and the route store re-renders the view.
    navigateToHash(ROUTES.category(tool.category));
  };

  const seeAll = () => {
    handleOpenChange(false);
    navigateToHash(ROUTES.toolsWithQuery(query.trim()));
  };

  const renderToolItem = (tool: ToolDef) => {
    const Icon = tool.icon;
    return (
      <CommandItem
        key={tool.id}
        value={`${tool.id} ${tool.name.en} ${tool.name.hi} ${tool.tags.en.join(" ")} ${tool.tags.hi.join(" ")}`}
        onSelect={() => openTool(tool)}
      >
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{tool.name[locale]}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {tool.enabled ? (
            <span className="hidden sm:inline">{t("palette.openHint")}</span>
          ) : (
            <span>{t("palette.soonHint", { phase: tool.phase })}</span>
          )}
        </span>
      </CommandItem>
    );
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t("palette.title")}
      description={t("palette.description")}
      className="sm:max-w-lg"
      commandProps={{ shouldFilter: false }}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t("palette.placeholder")}
      />
      <CommandList>
        <CommandEmpty>{t("palette.noResults")}</CommandEmpty>

        {query.trim() ? (
          <>
            {routeSuggestion ? (
              <CommandGroup heading={t("palette.routeHeading")}>
                {routeSuggestion.direct ? null : null}
                {routeSuggestion.routes.map((route) => (
                  <CommandItem
                    key={route.steps.map((s) => s.toolId).join(">")}
                    value={`route-${route.steps.map((s) => s.toolId).join("-")}`}
                    onSelect={() => {
                      const first =
                        ALL_TOOLS_BY_ID.get(route.steps[0].toolId);
                      if (first) openTool(first);
                    }}
                  >
                    <RouteIcon className="size-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-left">
                      <span className="font-medium">{routeSuggestion.from}</span>
                      <span className="text-muted-foreground"> → </span>
                      <span className="font-medium">{routeSuggestion.to}</span>
                      <span className="text-muted-foreground">
                        {" · "}
                        {route.steps
                          .map((s) => routeStepLabel(s, locale))
                          .join(" → ")}
                      </span>
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                      {t("palette.routeSteps", {
                        count: route.steps.length,
                      })}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            <CommandGroup heading={t("palette.results")}>
              {results.slice(0, 10).map((match) => renderToolItem(match.tool))}
              <CommandItem onSelect={seeAll} className="justify-center">
                <span className="text-primary">
                  {t("palette.seeAll")} — {t("tools.resultsCount", { count: results.length })}
                </span>
              </CommandItem>
            </CommandGroup>
          </>
        ) : (
          <>
            {favoriteTools.length > 0 ? (
              <CommandGroup heading={t("palette.favorites")}>
                {favoriteTools.slice(0, 5).map(renderToolItem)}
              </CommandGroup>
            ) : null}
            <CommandGroup heading={t("palette.popular")}>
              {popular.map(renderToolItem)}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
