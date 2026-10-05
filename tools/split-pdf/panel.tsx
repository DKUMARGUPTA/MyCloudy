"use client";

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  Bookmark,
  Files,
  Loader2,
  Scissors,
  TriangleAlert,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import {
  detectBlankPages,
  getPdfPageCount,
  getPdfTopLevelOutline,
  renderPdfThumbnail,
  type PdfOutlineEntry,
} from "@/lib/pdf/thumbnails";
import {
  computeSplitPlan,
  fileKey,
  parseNumberListOption,
  parseRangeList,
  rangesOverlap,
  type SplitMode,
  type SplitPart,
} from "./plan";
import { cn } from "@/lib/utils";

/**
 * Split PDF custom panel (PRD §8.1): mode tabs (7 modes), per-mode inputs
 * and the LIVE preview strip — cut markers, color-coded parts and the
 * "N files banengi" count — all computed with the same pure plan module the
 * worker executes. Bookmark + blank-page detection run on the main thread
 * with the self-hosted pdf.js and reach the worker as plain options.
 */

const MODE_IDS: { id: SplitMode; labelKey: string }[] = [
  { id: "range", labelKey: "split.modeRange" },
  { id: "everyN", labelKey: "split.modeEveryN" },
  { id: "bookmarks", labelKey: "split.modeBookmarks" },
  { id: "size", labelKey: "split.modeSize" },
  { id: "visual", labelKey: "split.modeVisual" },
  { id: "oddEven", labelKey: "split.modeOddEven" },
  { id: "blanks", labelKey: "split.modeBlanks" },
];

const PART_STYLES = [
  "border-primary/30 bg-primary/10 text-primary dark:text-primary",
  "border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-400",
  "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
];

function partStyle(index: number): string {
  return PART_STYLES[index % PART_STYLES.length];
}

export function SplitPanel({
  files,
  values,
  onChange,
}: ToolPanelProps) {
  const { t } = useI18n();
  const file = files.length > 0 ? files[0].file : null;
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const mode: SplitMode = useMemo(() => {
    const raw = values.mode;
    return typeof raw === "string" &&
      MODE_IDS.some((entry) => entry.id === raw)
      ? (raw as SplitMode)
      : "range";
  }, [values.mode]);

  const ranges = typeof values.ranges === "string" ? values.ranges : "";
  const oneFilePerRange = values.oneFilePerRange !== false;
  const everyN = typeof values.everyN === "number" ? values.everyN : 5;
  const maxSizeMb =
    typeof values.maxSizeMb === "number" ? values.maxSizeMb : 5;
  const cutAfter = useMemo(
    () => parseNumberListOption(values.cutAfter),
    [values.cutAfter]
  );

  /* ---------------- Page count + outline detection ---------------- */
  // Async results are keyed by their File and only applied to state inside
  // promise callbacks (never synchronously in the effect body).

  const [pageCountState, setPageCountState] = useState<{
    file: File;
    count: number;
  } | null>(null);
  const pageCount =
    pageCountState !== null && pageCountState.file === file
      ? pageCountState.count
      : null;

  const [outlineState, setOutlineState] = useState<{
    file: File;
    entries: PdfOutlineEntry[];
  } | null>(null);
  const outline =
    outlineState !== null && outlineState.file === file
      ? outlineState.entries
      : null;

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void getPdfPageCount(file)
      .then((count) => {
        if (!cancelled) setPageCountState({ file, count });
      })
      .catch(() => {
        if (!cancelled) setPageCountState({ file, count: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  // Outline runs for every file (it decides whether the bookmarks tab is
  // usable) and mirrors its result into options for the worker.
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    const key = fileKey(file.name, file.size);
    void getPdfTopLevelOutline(file)
      .then((entries) => {
        if (cancelled) return;
        setOutlineState({ file, entries });
        onChange("bookmarkStatus", "done");
        onChange("bookmarkFileKey", key);
        onChange(
          "bookmarkCuts",
          JSON.stringify([...new Set(entries.map((entry) => entry.page))].sort((a, b) => a - b))
        );
      })
      .catch(() => {
        if (cancelled) return;
        setOutlineState({ file, entries: [] });
        onChange("bookmarkStatus", "done");
        onChange("bookmarkFileKey", key);
        onChange("bookmarkCuts", "[]");
      });
    return () => {
      cancelled = true;
    };
  }, [file, onChange]);

  /* ---------------- Blank-page detection (mode 7) ---------------- */

  const [blankProgress, setBlankProgress] = useState<{
    file: File;
    done: number;
    total: number;
  } | null>(null);

  const blankDetectionDone =
    file !== null &&
    values.blankStatus === "done" &&
    values.blankFileKey === fileKey(file.name, file.size);
  const blankPages = blankDetectionDone
    ? parseNumberListOption(values.blankPages)
    : [];
  const blanksDetecting =
    file !== null && mode === "blanks" && !blankDetectionDone;

  useEffect(() => {
    if (!file || mode !== "blanks") return;
    if (
      values.blankStatus === "done" &&
      values.blankFileKey === fileKey(file.name, file.size)
    ) {
      return; // already detected for this exact file
    }
    let cancelled = false;
    void detectBlankPages(file, (progress) => {
      if (!cancelled) {
        setBlankProgress({ file, done: progress.done, total: progress.total });
      }
    })
      .then((pages) => {
        if (cancelled) return;
        setBlankProgress(null);
        onChange("blankStatus", "done");
        onChange("blankFileKey", fileKey(file.name, file.size));
        onChange("blankPages", JSON.stringify(pages));
      })
      .catch(() => {
        if (cancelled) return;
        setBlankProgress(null);
        onChange("blankStatus", "done");
        onChange("blankFileKey", fileKey(file.name, file.size));
        onChange("blankPages", "[]");
      });
    return () => {
      cancelled = true;
    };
  }, [file, mode, onChange, values.blankStatus, values.blankFileKey]);

  /* ---------------- Live plan preview ---------------- */

  const rangeItems =
    mode === "range" && pageCount !== null
      ? parseRangeList(ranges, pageCount)
      : null;
  const rangesValid = mode !== "range" || rangeItems !== null;
  const overlapping =
    rangeItems !== null && rangesOverlap(rangeItems) ? true : false;

  const plan = useMemo(() => {
    if (!file || pageCount === null || pageCount < 1) return null;
    return computeSplitPlan({
      mode,
      pageCount,
      fileSize: file.size,
      ranges,
      oneFilePerRange,
      everyN,
      maxSizeMb,
      cutAfter,
      bookmarkCuts: outline ? [...new Set(outline.map((e) => e.page))] : [],
      blankPages,
    });
  }, [
    file,
    pageCount,
    mode,
    ranges,
    oneFilePerRange,
    everyN,
    maxSizeMb,
    cutAfter,
    outline,
    blankPages,
  ]);

  const bookmarkTabDisabled = outline !== null && outline.length === 0;
  const canShowCount =
    plan !== null && !(mode === "blanks" && blankDetectionDone && blankPages.length === 0);

  const toggleCut = (page: number) => {
    const next = cutAfter.includes(page)
      ? cutAfter.filter((item) => item !== page)
      : [...cutAfter, page].sort((a, b) => a - b);
    onChange("cutAfter", JSON.stringify(next));
  };

  const selectMode = (next: SplitMode) => {
    if (next === "bookmarks" && bookmarkTabDisabled) return;
    onChange("mode", next);
  };

  const onTablistKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const enabledIndexes = MODE_IDS.map((entry, index) => ({
      entry,
      index,
    }))
      .filter(({ entry }) => !(entry.id === "bookmarks" && bookmarkTabDisabled))
      .map(({ index }) => index);
    if (enabledIndexes.length === 0) return;
    const currentIndex = MODE_IDS.findIndex((entry) => entry.id === mode);
    const position = enabledIndexes.indexOf(currentIndex);
    const nextPosition =
      (position === -1 ? 0 : position + direction + enabledIndexes.length) %
      enabledIndexes.length;
    const nextIndex = enabledIndexes[nextPosition];
    const nextEntry = MODE_IDS[nextIndex];
    tabRefs.current[nextIndex]?.focus();
    selectMode(nextEntry.id);
  };

  /* ---------------- Render ---------------- */

  return (
    <section
      aria-label={t("split.panelTitle")}
      className="flex flex-col gap-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Scissors className="size-3.5" aria-hidden="true" />
          {t("split.panelTitle")}
        </h3>
        {file ? (
          <span className="text-[11px] text-muted-foreground">
            {pageCount !== null
              ? t("split.pagesInFile", { count: pageCount })
              : t("split.detecting")}
          </span>
        ) : null}
      </div>

      {!file ? (
        <p className="rounded-btn border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          {t("split.emptyHint")}
        </p>
      ) : (
        <>
          {/* Mode tabs (PRD §8.1 "Modes (tabs)") */}
          <div
            role="tablist"
            aria-label={t("split.modeLabel")}
            className="flex flex-wrap gap-1.5"
            onKeyDown={onTablistKeyDown}
          >
            {MODE_IDS.map((entry, index) => {
              const disabled = entry.id === "bookmarks" && bookmarkTabDisabled;
              const selected = mode === entry.id;
              return (
                <button
                  key={entry.id}
                  ref={(node) => {
                    tabRefs.current[index] = node;
                  }}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-disabled={disabled}
                  disabled={disabled}
                  title={
                    disabled ? t("split.bookmarksDisabled") : undefined
                  }
                  onClick={() => selectMode(entry.id)}
                  className={cn(
                    "min-h-9 rounded-btn border px-2.5 text-xs font-medium outline-none transition-colors",
                    selected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-foreground hover:border-primary/40 hover:bg-accent",
                    disabled && "cursor-not-allowed opacity-50",
                    "focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  )}
                >
                  {t(entry.labelKey)}
                </button>
              );
            })}
          </div>

          {/* Per-mode controls */}
          {mode === "range" ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="split-ranges" className="text-xs font-medium">
                  {t("split.rangeLabel")}
                </Label>
                <Input
                  id="split-ranges"
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  value={ranges}
                  placeholder={t("split.rangePlaceholder")}
                  onChange={(event) => onChange("ranges", event.target.value)}
                  aria-invalid={!rangesValid && ranges.trim() !== ""}
                  className={cn(
                    "h-10 rounded-btn text-xs font-medium",
                    !rangesValid &&
                      ranges.trim() !== "" &&
                      "border-destructive focus-visible:ring-destructive/30"
                  )}
                />
                {ranges.trim() === "" ? (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {t("split.rangeHint")}
                  </p>
                ) : rangesValid ? (
                  overlapping ? (
                    <p className="flex items-start gap-1.5 rounded-btn border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] font-medium leading-relaxed text-amber-600 dark:text-amber-400">
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                      {t("split.overlapWarning")}
                    </p>
                  ) : (
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {t("split.rangeHint")}
                    </p>
                  )
                ) : (
                  <p className="text-[11px] font-medium leading-relaxed text-destructive">
                    {t("split.invalidRanges")}
                  </p>
                )}
              </div>
              <div className="flex items-center justify-between gap-3 rounded-btn border border-border bg-background px-2.5 py-2">
                <Label
                  htmlFor="split-one-per-range"
                  className="text-xs font-medium leading-snug"
                >
                  {t("split.oneFilePerRangeLabel")}
                  <span className="block text-[11px] font-normal text-muted-foreground">
                    {t("split.oneFilePerRangeHint")}
                  </span>
                </Label>
                <Switch
                  id="split-one-per-range"
                  checked={oneFilePerRange}
                  onCheckedChange={(next) => onChange("oneFilePerRange", next)}
                  aria-label={t("split.oneFilePerRangeLabel")}
                />
              </div>
            </div>
          ) : null}

          {mode === "everyN" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="split-every-n" className="text-xs font-medium">
                {t("split.everyNLabel")}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="split-every-n"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={pageCount ?? 9999}
                  step={1}
                  value={everyN}
                  onChange={(event) =>
                    onChange("everyN", event.target.valueAsNumber || 1)
                  }
                  className="h-10 w-24 rounded-btn text-xs font-medium"
                />
                <span className="text-xs text-muted-foreground">
                  {t("split.pagesSuffix")}
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t("split.everyNHint")}
              </p>
            </div>
          ) : null}

          {mode === "bookmarks" ? (
            outline === null ? (
              <p className="flex items-center gap-2 rounded-btn border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                <Loader2
                  className="size-3.5 animate-spin"
                  aria-hidden="true"
                />
                {t("split.detecting")}
              </p>
            ) : outline.length === 0 ? (
              <p className="flex items-start gap-1.5 rounded-btn border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                <Bookmark className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {t("split.bookmarksNone")}
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                <p className="text-[11px] text-muted-foreground">
                  {t("split.bookmarksCount", { count: outline.length })} —{" "}
                  {t("split.bookmarksList")}
                </p>
                <ul className="scrollbar-thin flex max-h-36 flex-col gap-1 overflow-y-auto pr-1">
                  {outline.map((entry, index) => (
                    <li
                      key={`${entry.page}-${index}`}
                      className="flex items-center gap-2 rounded-btn border border-border bg-background px-2 py-1.5"
                    >
                      <span
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                          partStyle(index)
                        )}
                        aria-hidden="true"
                      >
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={entry.title}>
                        {entry.title}
                      </span>
                      <span className="shrink-0 rounded-chip bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                        {t("split.pageChipLabel", { page: entry.page })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : null}

          {mode === "size" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="split-max-size" className="text-xs font-medium">
                {t("split.sizeLabel")}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="split-max-size"
                  type="number"
                  inputMode="decimal"
                  min={0.1}
                  max={2000}
                  step={0.5}
                  value={maxSizeMb}
                  onChange={(event) =>
                    onChange(
                      "maxSizeMb",
                      event.target.valueAsNumber > 0
                        ? event.target.valueAsNumber
                        : 0.1
                    )
                  }
                  className="h-10 w-24 rounded-btn text-xs font-medium"
                />
                <span className="text-xs text-muted-foreground">MB</span>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t("split.sizeHint")}
              </p>
            </div>
          ) : null}

          {mode === "visual" ? (
            <div className="flex flex-col gap-2">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t("split.visualHint")}
              </p>
              {cutAfter.length > 0 ? (
                <button
                  type="button"
                  onClick={() => onChange("cutAfter", "[]")}
                  className="flex min-h-9 w-fit items-center gap-1.5 rounded-btn border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:border-destructive/40 hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <Scissors className="size-3.5" aria-hidden="true" />
                  {t("split.visualClear", { count: cutAfter.length })}
                </button>
              ) : null}
            </div>
          ) : null}

          {mode === "oddEven" ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("split.oddEvenHint")}
            </p>
          ) : null}

          {mode === "blanks" ? (
            blanksDetecting ? (
              <p className="flex items-center gap-2 rounded-btn border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                {blankProgress !== null && blankProgress.file === file
                  ? t("split.blanksDetectingPct", {
                      percent: Math.round(
                        (blankProgress.done / Math.max(1, blankProgress.total)) * 100
                      ),
                    })
                  : t("split.blanksDetecting")}
              </p>
            ) : blankPages.length === 0 ? (
              <p className="flex items-start gap-1.5 rounded-btn border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {t("split.blanksNone")}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] font-medium leading-relaxed text-foreground">
                  {t("split.blanksFound", { count: blankPages.length })}
                </p>
                <div className="flex flex-wrap gap-1" aria-label={t("split.blanksChipLabel")}>
                  {blankPages.map((page) => (
                    <span
                      key={page}
                      className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground line-through"
                    >
                      {page}
                    </span>
                  ))}
                </div>
              </div>
            )
          ) : null}

          {/* Live preview (PRD §8.1: cut markers + color-coded parts +
              live count) */}
          <div className="flex flex-col gap-2.5 rounded-card border border-border bg-background p-3">
            <div className="flex items-center justify-between gap-2">
              <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <Files className="size-3.5" aria-hidden="true" />
                {t("split.previewTitle")}
              </h4>
              <div className="flex items-center gap-1.5">
                {plan?.estimated ? (
                  <span
                    className="rounded-chip border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
                    title={t("split.sizeHint")}
                  >
                    ≈ {t("split.estimated")}
                  </span>
                ) : null}
                {canShowCount && plan !== null ? (
                  <span className="rounded-chip bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                    {plan.parts.length === 1
                      ? t("split.willCreateOne")
                      : t("split.willCreate", { count: plan.parts.length })}
                  </span>
                ) : null}
              </div>
            </div>

            {mode === "visual" && pageCount !== null ? (
              <VisualStrip
                file={file}
                pageCount={pageCount}
                cutAfter={cutAfter}
                parts={plan?.parts ?? []}
                onToggleCut={toggleCut}
              />
            ) : pageCount === null ? (
              <p className="flex items-center gap-2 px-1 py-2 text-[11px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                {t("split.detecting")}
              </p>
            ) : plan === null ? (
              ranges.trim() === "" ? (
                <p className="px-1 py-2 text-[11px] text-muted-foreground">
                  {t("split.rangePrompt")}
                </p>
              ) : (
                <p className="px-1 py-2 text-[11px] font-medium text-destructive">
                  {t("split.invalidRanges")}
                </p>
              )
            ) : plan.parts.length === 0 ? (
              <p className="px-1 py-2 text-[11px] text-muted-foreground">
                {t("split.noParts")}
              </p>
            ) : (
              <CompactStrip parts={plan.parts} />
            )}
          </div>
        </>
      )}
    </section>
  );
}

/* ---------------- Preview strips ---------------- */

/** Grouped chips: one row per part, cut markers between parts. */
function CompactStrip({ parts }: { parts: SplitPart[] }) {
  const { t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t("split.stripLabel")}
      className="scrollbar-thin flex max-h-56 flex-col gap-2 overflow-y-auto pr-1"
    >
      {parts.map((part, partIndex) => (
        <Fragment key={partIndex}>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  "rounded-chip border px-1.5 py-0.5 text-[10px] font-bold",
                  partStyle(partIndex)
                )}
              >
                {part.label === "odd" || part.label === "even"
                  ? t(part.label === "odd" ? "split.oddLabel" : "split.evenLabel")
                  : t("split.partBadge", { index: partIndex + 1 })}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {t("split.partPages", { count: part.pages.length })}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {part.pages.map((pageIndex) => (
                <span
                  key={pageIndex}
                  className={cn(
                    "flex h-7 min-w-7 items-center justify-center rounded-md border px-1 text-[11px] font-semibold",
                    partStyle(partIndex)
                  )}
                >
                  {pageIndex + 1}
                </span>
              ))}
            </div>
          </div>
          {partIndex < parts.length - 1 ? (
            <div
              aria-hidden="true"
              className="flex items-center gap-1.5 text-muted-foreground"
            >
              <span className="h-px flex-1 border-t border-dashed border-border" />
              <Scissors className="size-3" />
              <span className="h-px flex-1 border-t border-dashed border-border" />
            </div>
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

/** Thumbnail picker: real page thumbs + scissors buttons between pages. */
function VisualStrip({
  file,
  pageCount,
  cutAfter,
  parts,
  onToggleCut,
}: {
  file: File;
  pageCount: number;
  cutAfter: number[];
  parts: SplitPart[];
  onToggleCut: (page: number) => void;
}) {
  const { t } = useI18n();
  const partIndexOf = new Map<number, number>();
  parts.forEach((part, partIndex) => {
    for (const pageIndex of part.pages) partIndexOf.set(pageIndex, partIndex);
  });

  return (
    <div
      role="group"
      aria-label={t("split.stripLabel")}
      className="scrollbar-thin flex max-h-72 flex-wrap items-center gap-1 overflow-y-auto pr-1"
    >
      {Array.from({ length: pageCount }, (_, index) => index + 1).map(
        (pageNumber) => {
          const partIndex = partIndexOf.get(pageNumber - 1) ?? 0;
          const cut = cutAfter.includes(pageNumber);
          return (
            <Fragment key={pageNumber}>
              <div className="flex w-14 flex-col items-center gap-1">
                <VisualThumb file={file} pageIndex={pageNumber - 1} />
                <span
                  className={cn(
                    "rounded-md border px-1 text-[10px] font-bold",
                    partStyle(partIndex)
                  )}
                >
                  {pageNumber}
                </span>
              </div>
              {pageNumber < pageCount ? (
                <button
                  type="button"
                  aria-pressed={cut}
                  aria-label={t("split.cutAfter", { page: pageNumber })}
                  title={t("split.cutAfter", { page: pageNumber })}
                  onClick={() => onToggleCut(pageNumber)}
                  className={cn(
                    "flex size-11 shrink-0 items-center justify-center rounded-full border outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    cut
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-dashed border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-primary"
                  )}
                >
                  <Scissors className="size-4" aria-hidden="true" />
                </button>
              ) : null}
            </Fragment>
          );
        }
      )}
    </div>
  );
}

/** One queued thumbnail (render queue caps concurrency at 2). */
function VisualThumb({
  file,
  pageIndex,
}: {
  file: File;
  pageIndex: number;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    void renderPdfThumbnail(file, { pageIndex, maxDim: 112 })
      .then((result) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(result.blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file, pageIndex]);

  return (
    <div className="relative flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40">
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-contain"
        />
      ) : (
        <div
          aria-hidden="true"
          className="size-full animate-pulse bg-gradient-to-br from-muted to-muted/40"
        />
      )}
    </div>
  );
}
