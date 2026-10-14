"use client";

import { useId } from "react";
import {
  CaseSensitive,
  Files,
  Regex as RegexIcon,
  Search,
  TriangleAlert,
  Type,
  WholeWord,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import {
  BadRegexError,
  buildMatcher,
  CONTEXT_DEFAULT,
  CONTEXT_MAX,
  CONTEXT_MIN,
  resolveSearchOptions,
  SEARCH_IDS,
} from "./engine";

/**
 * Search PDFs custom panel (PRD §8.5 options) — the split-pdf precedent:
 * the panel owns every interactive value (the schema options array is
 * empty) and writes them as plain options the worker reads through
 * resolveSearchOptions:
 *
 *   query  mode  caseSensitive  wholeWord  context
 *
 * The empty-query / bad-regex run gating happens in the workspace surface
 * (surfaces own setRunBlocked; panels never had it) — this panel focuses
 * on the inputs plus an inline regex-validity echo.
 */
export function SearchPanel({
  files,
  values,
  onChange,
}: ToolPanelProps) {
  const { t } = useI18n();
  // Instance-unique ids: this panel is mounted in BOTH the desktop aside
  // and the mobile bottom sheet, so hardcoded ids would collide.
  const uid = useId();
  const ids = {
    query: `${uid}-search-query`,
    case: `${uid}-search-case`,
    wholeWord: `${uid}-search-whole-word`,
    context: `${uid}-search-context`,
  } as const;

  const { query, mode, caseSensitive, wholeWord, context } =
    resolveSearchOptions(values);

  // Pure compile check for the inline echo (the surface re-checks for the
  // CTA gate; the worker re-checks before touching any file).
  let regexBad = false;
  if (mode === "regex" && query.trim() !== "") {
    try {
      buildMatcher(query, { mode, caseSensitive, wholeWord });
    } catch (error) {
      regexBad = error instanceof BadRegexError;
    }
  }

  const setQuery = (next: string) => {
    onChange(SEARCH_IDS.query, next);
  };
  const setMode = (next: string) => {
    if (next !== "") onChange(SEARCH_IDS.mode, next);
  };
  const setCaseSensitive = (next: boolean) => {
    onChange(SEARCH_IDS.caseSensitive, next);
  };
  const setWholeWord = (next: boolean) => {
    onChange(SEARCH_IDS.wholeWord, next);
  };
  const setContext = (next: string) => {
    const parsed = Number(next);
    onChange(
      SEARCH_IDS.context,
      Number.isFinite(parsed) ? Math.trunc(parsed) : CONTEXT_DEFAULT
    );
  };
  const normalizeContext = () => {
    onChange(
      SEARCH_IDS.context,
      Math.min(CONTEXT_MAX, Math.max(CONTEXT_MIN, context))
    );
  };

  return (
    <section
      aria-label={t("search.panelTitle")}
      className="flex flex-col gap-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Search className="size-3.5" aria-hidden="true" />
          {t("search.panelTitle")}
        </h3>
        {files.length > 0 ? (
          <span className="text-[11px] text-muted-foreground">
            {files.length === 1
              ? t("search.filesQueuedOne")
              : t("search.filesQueued", { count: files.length })}
          </span>
        ) : null}
      </div>

      {/* Query */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.query} className="text-xs font-medium">
          {t("search.queryLabel")}
        </Label>
        <Input
          id={ids.query}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("search.queryPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          aria-required="true"
          className="h-11 rounded-btn text-sm"
        />
        {regexBad ? (
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
            <TriangleAlert
              className="mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />
            {t("search.regexInvalid")}
          </p>
        ) : null}
      </div>

      {/* Match type */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-foreground">
          {t("search.modeLabel")}
        </span>
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={setMode}
          aria-label={t("search.modeLabel")}
          className="w-full justify-stretch gap-1"
        >
          <ToggleGroupItem
            value="text"
            aria-label={t("search.modeText")}
            className="min-h-11 flex-1 rounded-btn px-2.5 text-xs"
          >
            <Type className="size-3.5" aria-hidden="true" />
            {t("search.modeText")}
          </ToggleGroupItem>
          <ToggleGroupItem
            value="regex"
            aria-label={t("search.modeRegex")}
            className="min-h-11 flex-1 rounded-btn px-2.5 text-xs"
          >
            <RegexIcon className="size-3.5" aria-hidden="true" />
            {t("search.modeRegex")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Case sensitive */}
      <div className="flex min-h-11 items-center justify-between gap-3 rounded-btn border border-border bg-background px-3 py-2">
        <Label
          htmlFor={ids.case}
          className="flex items-center gap-1.5 text-xs font-medium"
        >
          <CaseSensitive className="size-3.5" aria-hidden="true" />
          {t("search.caseLabel")}
        </Label>
        <Switch
          id={ids.case}
          checked={caseSensitive}
          onCheckedChange={setCaseSensitive}
        />
      </div>

      {/* Whole words — text mode only (a regex writes its own boundaries). */}
      {mode === "text" ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex min-h-11 items-center justify-between gap-3 rounded-btn border border-border bg-background px-3 py-2">
            <Label
              htmlFor={ids.wholeWord}
              className="flex items-center gap-1.5 text-xs font-medium"
            >
              <WholeWord className="size-3.5" aria-hidden="true" />
              {t("search.wholeWordLabel")}
            </Label>
            <Switch
              id={ids.wholeWord}
              checked={wholeWord}
              onCheckedChange={setWholeWord}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("search.wholeWordHint")}
          </p>
        </div>
      ) : null}

      {/* Context size */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.context} className="text-xs font-medium">
          {t("search.contextLabel")}
        </Label>
        <Input
          id={ids.context}
          type="number"
          inputMode="numeric"
          min={CONTEXT_MIN}
          max={CONTEXT_MAX}
          step={5}
          value={context}
          onChange={(event) => setContext(event.target.value)}
          onBlur={normalizeContext}
          className="h-11 rounded-btn text-sm tabular-nums"
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("search.contextHint")}
        </p>
      </div>

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Files className="size-3 shrink-0" aria-hidden="true" />
        {files.length > 0
          ? t("search.otherFilesNote", { count: files.length })
          : t("search.filesQueued", { count: 0 })}
      </p>
    </section>
  );
}

export default SearchPanel;
