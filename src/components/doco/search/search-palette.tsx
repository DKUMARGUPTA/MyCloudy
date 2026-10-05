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
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import { searchTools } from "@/lib/search/fuzzy";
import {
  PHASE_LABELS,
  popularTools,
  type ToolDef,
} from "@/lib/tools/registry";
import { useFavoriteTools } from "@/lib/tools/favorites";
import { ROUTES, navigateToHash } from "@/hooks/use-hash-route";

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

  const handleOpenChange = (next: boolean) => {
    // Clear the query on close via the event handler (not an effect).
    if (!next) setQuery("");
    onOpenChange(next);
  };

  const openTool = (tool: ToolDef) => {
    handleOpenChange(false);
    if (tool.enabled) {
      navigateToHash(`#/?tool=${tool.id}`);
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
          <CommandGroup heading={t("palette.results")}>
            {results.slice(0, 10).map((match) => renderToolItem(match.tool))}
            <CommandItem onSelect={seeAll} className="justify-center">
              <span className="text-primary">
                {t("palette.seeAll")} — {t("tools.resultsCount", { count: results.length })}
              </span>
            </CommandItem>
          </CommandGroup>
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
