"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  X,
  ZoomIn,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/locale-provider";
import { formatBytes } from "@/lib/storage/recent-files";
import { renderPdfThumbnail } from "@/lib/pdf/thumbnails";
import { cn } from "@/lib/utils";

/**
 * Shared preview-surface chrome (PRD §8.2 "Preview: live canvas preview on
 * selected sample page; thumbnails strip"): the file header card, the page
 * thumbnail strip and the zoom segmented control. Extracted from the stamp
 * surface so the Crop surface (and future visual tools) reuse the exact
 * same pieces — no copy-paste per tool.
 */

const STRIP_MAX = 12;

function stripWindow(selected: number, pageCount: number): number[] {
  if (pageCount <= STRIP_MAX) {
    return Array.from({ length: pageCount }, (_, i) => i);
  }
  const start = Math.min(
    Math.max(0, selected - Math.floor(STRIP_MAX / 2)),
    pageCount - STRIP_MAX
  );
  return Array.from({ length: STRIP_MAX }, (_, i) => start + i);
}

/** File name + page count + remove button above every preview surface. */
export function PreviewFileHeader({
  file,
  pageCount,
  onRemove,
}: {
  file: File;
  pageCount: number;
  onRemove: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3 rounded-card border border-border bg-card px-4 py-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary">
        <FileText className="size-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground">
          {file.name}
        </p>
        <p className="text-xs text-muted-foreground">
          {pageCount > 0
            ? t("wm.filePages", {
                count: pageCount,
                size: formatBytes(file.size),
              })
            : formatBytes(file.size)}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-9 shrink-0"
        onClick={onRemove}
        aria-label={t("wm.removeFile")}
      >
        <X className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

/**
 * Page thumbnail strip with prev/next buttons. `markedSet` dots the pages a
 * tool will touch (stamp targets, crop targets, …).
 */
export function PreviewPageStrip({
  file,
  pageCount,
  selected,
  onSelect,
  markedSet,
}: {
  file: File;
  pageCount: number;
  selected: number;
  onSelect: (pageIndex: number) => void;
  markedSet: ReadonlySet<number>;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [stripUrls, setStripUrls] = useState<{ page: number; url: string }[]>(
    []
  );
  const stripUrlsRef = useRef<{ page: number; url: string }[]>([]);

  // Thumbnails for the visible window (12 max, centered on the selection).
  useEffect(() => {
    if (pageCount === 0) return;
    let cancelled = false;
    const indices = stripWindow(selected, pageCount);
    void (async () => {
      const next: { page: number; url: string }[] = [];
      for (const index of indices) {
        const thumb = await renderPdfThumbnail(file, {
          pageIndex: index,
          maxDim: 72,
        });
        if (cancelled) return;
        next.push({ page: index, url: URL.createObjectURL(thumb.blob) });
      }
      for (const old of stripUrlsRef.current) URL.revokeObjectURL(old.url);
      stripUrlsRef.current = next;
      setStripUrls(next);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [file, pageCount, selected]);

  // Revoke strip URLs on unmount.
  useEffect(() => {
    return () => {
      for (const old of stripUrlsRef.current) URL.revokeObjectURL(old.url);
    };
  }, []);

  if (pageCount <= 1) return null;

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-9 shrink-0 rounded-btn"
        disabled={selected === 0}
        onClick={() => onSelect(Math.max(0, selected - 1))}
        aria-label={t("wm.prevPage")}
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
      </Button>
      <div
        className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1 scrollbar-thin"
        role="listbox"
        aria-label={t("wm.stripLabel")}
      >
        {stripUrls.map((item) => {
          const isSelected = item.page === selected;
          const isMarked = markedSet.has(item.page);
          return (
            <button
              key={item.page}
              type="button"
              role="option"
              aria-selected={isSelected}
              aria-label={t("wm.stripPageLabel", { page: item.page + 1 })}
              onClick={() => onSelect(item.page)}
              className={cn(
                "relative shrink-0 overflow-hidden rounded-md border transition-all",
                isSelected
                  ? "border-primary ring-2 ring-primary/30 scale-105"
                  : "border-border opacity-80 hover:opacity-100"
              )}
            >
              <img
                src={item.url}
                alt=""
                className="h-16 w-auto"
                loading="lazy"
              />
              <span
                className={cn(
                  "absolute bottom-0.5 right-0.5 rounded bg-background/85 px-1 text-[9px] font-semibold tabular-nums text-foreground",
                  isMarked && "text-primary"
                )}
              >
                {item.page + 1}
              </span>
              {isMarked ? (
                <span
                  className="absolute left-0.5 top-0.5 size-1.5 rounded-full bg-primary"
                  aria-hidden="true"
                />
              ) : null}
            </button>
          );
        })}
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-9 shrink-0 rounded-btn"
        disabled={selected >= pageCount - 1}
        onClick={() => onSelect(Math.min(pageCount - 1, selected + 1))}
        aria-label={t("wm.nextPage")}
      >
        <ChevronRight className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

/** Segmented zoom control (1× / 1.5× / 2× …) shared by preview surfaces. */
export function PreviewZoomControl<T extends number>({
  steps,
  value,
  onChange,
}: {
  steps: readonly T[];
  value: T;
  onChange: (next: T) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t("wm.zoomLabel")}
      className="ml-1 flex items-center gap-0.5 rounded-btn border border-border bg-background p-0.5"
    >
      <ZoomIn className="ml-1 size-3 text-muted-foreground" aria-hidden="true" />
      {steps.map((step) => (
        <button
          key={step}
          type="button"
          onClick={() => onChange(step)}
          aria-pressed={value === step}
          aria-label={t("wm.zoomStep", { step })}
          className={cn(
            "min-h-6 min-w-8 rounded-md px-1.5 text-[10px] font-semibold tabular-nums transition-colors",
            value === step
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {step}×
        </button>
      ))}
    </div>
  );
}
