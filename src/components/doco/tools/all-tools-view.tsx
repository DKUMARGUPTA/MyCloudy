"use client";

import { useMemo, useRef, useState } from "react";
import { Search, SearchX, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/doco/empty-state";
import { RequestToolModal } from "@/components/doco/tools/request-tool-modal";
import { ToolCard } from "@/components/doco/tools/tool-card";
import { useI18n } from "@/components/providers/locale-provider";
import { searchTools } from "@/lib/search/fuzzy";
import {
  ALL_TOOLS,
  categoryChipClass,
  CATEGORIES,
  totalToolCount,
  type Accepts,
  type ToolDef,
} from "@/lib/tools/registry";
import {
  useFavoriteTools,
  useLastUsedTools,
} from "@/lib/tools/favorites";
import { cn } from "@/lib/utils";

type Chip =
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "lastUsed" }
  | { kind: "category"; id: string };

type ModeFilter = "all" | "D" | "S";
type SortOrder = "popular" | "az";

const ACCEPT_OPTIONS: Accepts[] = [
  "pdf",
  "image",
  "word",
  "office",
  "text",
  "url",
];

/**
 * All Tools view (PRD §6.2): search, sticky category chips, favorites and
 * last-used from localStorage, mode/input filters, Popular/A–Z sort, and an
 * empty state with Request-a-tool. Everything renders from the registry.
 */
export function AllToolsView({
  initialQuery = "",
}: {
  initialQuery?: string;
}) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState(initialQuery);
  const [chip, setChip] = useState<Chip>({ kind: "all" });
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const [inputFilter, setInputFilter] = useState<Accepts | "all">("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("popular");
  const [requestOpen, setRequestOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const favoriteTools = useFavoriteTools();
  const lastUsedTools = useLastUsedTools();

  // Desktop autofocus (PRD §6.2); skip on touch devices so the on-screen
  // keyboard doesn't jump up on load.
  const [autoFocusSearch] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(pointer: fine)").matches
  );

  const visibleTools = useMemo<ToolDef[]>(() => {
    let pool: ToolDef[];
    switch (chip.kind) {
      case "favorites":
        pool = favoriteTools;
        break;
      case "lastUsed":
        pool = lastUsedTools;
        break;
      case "category":
        pool = ALL_TOOLS.filter((tool) => tool.category === chip.id);
        break;
      default:
        pool = ALL_TOOLS;
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery) {
      const resultIds = new Set(
        searchTools(trimmedQuery, locale).map((match) => match.tool.id)
      );
      pool = pool.filter((tool) => resultIds.has(tool.id));
    }

    if (modeFilter !== "all") {
      pool = pool.filter((tool) => tool.mode === modeFilter);
    }
    if (inputFilter !== "all") {
      pool = pool.filter((tool) => tool.accepts === inputFilter);
    }

    const sorted = [...pool];
    if (sortOrder === "popular") {
      sorted.sort((a, b) => b.popularity - a.popularity);
    } else {
      sorted.sort((a, b) => a.name[locale].localeCompare(b.name[locale]));
    }
    return sorted;
  }, [chip, favoriteTools, lastUsedTools, query, modeFilter, inputFilter, sortOrder, locale]);

  const hasAnyQuery =
    query.trim() !== "" ||
    chip.kind !== "all" ||
    modeFilter !== "all" ||
    inputFilter !== "all";

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-8 sm:pt-10">
      <header className="max-w-2xl">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          {t("tools.title")}
        </h1>
        <p className="mt-2 text-muted-foreground">
          {t("tools.subtitle", { count: totalToolCount })}
        </p>
      </header>

      {/* Search box (PRD §6.2: large search box, desktop autofocus) */}
      <div className="relative mt-6">
        <Search
          className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          ref={searchRef}
          type="search"
          value={query}
          autoFocus={autoFocusSearch}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("tools.searchPlaceholder")}
          aria-label={t("tools.searchLabel")}
          className="h-13 rounded-btn pl-12 pr-12 text-base shadow-xs"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label={t("tools.searchClear")}
            className="absolute right-2.5 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {t("tools.searchHint")}
      </p>

      {/* Sticky category chips (PRD §6.2) */}
      <div
        role="tablist"
        aria-label={t("header.categories")}
        className="sticky top-16 z-30 -mx-4 mt-4 border-y border-border bg-background/90 px-4 py-2.5 backdrop-blur-md"
      >
        <div className="flex gap-2 overflow-x-auto scrollbar-thin">
          {favoriteTools.length > 0 ? (
            <CategoryChip
              active={chip.kind === "favorites"}
              onClick={() => setChip({ kind: "favorites" })}
            >
              {t("tools.chipFavorites")} · {favoriteTools.length}
            </CategoryChip>
          ) : null}
          {lastUsedTools.length > 0 ? (
            <CategoryChip
              active={chip.kind === "lastUsed"}
              onClick={() => setChip({ kind: "lastUsed" })}
            >
              {t("tools.chipLastUsed")}
            </CategoryChip>
          ) : null}
          <CategoryChip
            active={chip.kind === "all"}
            onClick={() => setChip({ kind: "all" })}
          >
            {t("tools.chipAll")}
          </CategoryChip>
          {CATEGORIES.map((category) => (
            <CategoryChip
              key={category.id}
              active={chip.kind === "category" && chip.id === category.id}
              colorClass={categoryChipClass[category.color]}
              onClick={() => setChip({ kind: "category", id: category.id })}
            >
              {category.name[locale]}
            </CategoryChip>
          ))}
        </div>
      </div>

      {/* Filters + sort toolbar */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Select
          value={modeFilter}
          onValueChange={(value) => setModeFilter(value as ModeFilter)}
        >
          <SelectTrigger
            aria-label={t("tools.filterMode")}
            className="h-10 w-auto rounded-btn text-sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("tools.modeAll")}</SelectItem>
            <SelectItem value="D">{t("tools.modePrivate")}</SelectItem>
            <SelectItem value="S">{t("tools.modeServer")}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={inputFilter}
          onValueChange={(value) =>
            setInputFilter(value as Accepts | "all")
          }
        >
          <SelectTrigger
            aria-label={t("tools.filterInput")}
            className="h-10 w-auto rounded-btn text-sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("tools.inputAll")}</SelectItem>
            <SelectItem value="pdf">{t("tools.inputPdf")}</SelectItem>
            <SelectItem value="image">{t("tools.inputImage")}</SelectItem>
            <SelectItem value="word">{t("tools.inputWord")}</SelectItem>
            <SelectItem value="office">{t("tools.inputOffice")}</SelectItem>
            <SelectItem value="text">{t("tools.inputText")}</SelectItem>
            <SelectItem value="url">{t("tools.inputUrl")}</SelectItem>
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("tools.sortLabel")}
          </span>
          <div
            role="group"
            aria-label={t("tools.sortLabel")}
            className="inline-flex rounded-btn border border-border bg-background p-0.5"
          >
            {(
              [
                ["popular", t("tools.sortPopular")],
                ["az", t("tools.sortAZ")],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={sortOrder === value}
                onClick={() => setSortOrder(value)}
                className={cn(
                  "h-9 rounded-[calc(0.75rem-2px)] px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  sortOrder === value
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Result summary */}
      <p
        className="mt-5 text-sm font-medium text-muted-foreground"
        aria-live="polite"
      >
        {query.trim()
          ? t("tools.resultsFor", { query: query.trim() })
          : t("tools.resultsCount", { count: visibleTools.length })}
      </p>

      {/* Grid */}
      {visibleTools.length > 0 ? (
        <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visibleTools.map((tool) => (
            <li key={tool.id} className="flex">
              <div className="w-full">
                <ToolCard tool={tool} />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-6">
          <EmptyState
            icon={<SearchX />}
            title={
              query.trim()
                ? t("tools.noResultsTitle", { query: query.trim() })
                : t("tools.noResultsTitle", { query: "—" })
            }
            description={t("tools.noResultsDesc")}
            action={
              <Button
                type="button"
                variant="cta"
                size="touch"
                className="rounded-btn"
                onClick={() => setRequestOpen(true)}
              >
                {t("tools.requestTool")}
              </Button>
            }
            className="py-14"
          />
        </div>
      )}

      {/* Reset filters when nothing matched due to filters (not search) */}
      {visibleTools.length === 0 &&
      query.trim() === "" &&
      hasAnyQuery ? (
        <div className="mt-4 text-center">
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="rounded-btn"
            onClick={() => {
              setChip({ kind: "all" });
              setModeFilter("all");
              setInputFilter("all");
            }}
          >
            {t("tools.chipAll")}
          </Button>
        </div>
      ) : null}

      <RequestToolModal open={requestOpen} onOpenChange={setRequestOpen} />
    </div>
  );
}

function CategoryChip({
  active,
  onClick,
  colorClass,
  children,
}: {
  active: boolean;
  onClick: () => void;
  colorClass?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex h-10 shrink-0 items-center rounded-chip border px-4 text-sm font-medium outline-none transition-all focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active
          ? colorClass
            ? cn(colorClass, "border-transparent font-semibold")
            : "border-transparent bg-primary/10 text-primary font-semibold"
          : "border-border bg-background text-muted-foreground hover:border-foreground/20 hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
