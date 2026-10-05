"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import { PageThumbnail } from "./page-thumbnail";
import { getPdfPageCount } from "@/lib/pdf/thumbnails";
import { formatBytes } from "@/lib/storage/recent-files";
import { cn } from "@/lib/utils";

/**
 * FileCard (PRD §6.3 workspace): thumbnail (page 1, queued render),
 * name, size + page count, keyboard-accessible reorder + remove.
 */

export interface WorkspaceFile {
  id: string;
  file: File;
}

export function FileCard({
  item,
  index,
  total,
  onRemove,
  onMove,
}: {
  item: WorkspaceFile;
  index: number;
  total: number;
  onRemove: (id: string) => void;
  onMove: (from: number, to: number) => void;
}) {
  const { t } = useI18n();
  const [pageCount, setPageCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPdfPageCount(item.file)
      .then((count) => {
        if (!cancelled) setPageCount(count);
      })
      .catch(() => {
        if (!cancelled) setPageCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [item.file]);

  return (
    <div
      className={cn(
        "group relative flex gap-3 rounded-card border border-border bg-card p-3 transition-colors",
        "hover:border-primary/30 focus-within:ring-[3px] focus-within:ring-ring/50"
      )}
    >
      <div className="w-14 shrink-0 sm:w-16">
        <PageThumbnail
          file={item.file}
          alt={t("tool.fileThumbnailAlt", { name: item.file.name })}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <p className="truncate text-sm font-semibold text-foreground" title={item.file.name}>
          {item.file.name}
        </p>
        <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
          <span>{formatBytes(item.file.size)}</span>
          {pageCount !== null ? (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {t("tool.pageCount", {
                  count: pageCount,
                })}
              </span>
            </>
          ) : null}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-center justify-center gap-1">
        <div className="flex">
          <button
            type="button"
            disabled={index === 0}
            onClick={() => onMove(index, index - 1)}
            aria-label={t("tool.moveUpLabel", { name: item.file.name })}
            className={cn(
              "flex size-8 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors",
              "hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
              "disabled:pointer-events-none disabled:opacity-30"
            )}
          >
            <ChevronUp className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={index === total - 1}
            onClick={() => onMove(index, index + 1)}
            aria-label={t("tool.moveDownLabel", { name: item.file.name })}
            className={cn(
              "flex size-8 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors",
              "hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
              "disabled:pointer-events-none disabled:opacity-30"
            )}
          >
            <ChevronDown className="size-4" aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => onRemove(item.id)}
          aria-label={t("tool.removeFileLabel", { name: item.file.name })}
          className={cn(
            "flex h-8 min-w-11 items-center justify-center gap-1 rounded-btn px-2 text-xs text-muted-foreground outline-none transition-colors",
            "hover:bg-destructive/10 hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/50"
          )}
        >
          <X className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">{t("tool.removeFile")}</span>
        </button>
      </div>

      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-2 top-2 rounded-chip bg-primary/10 px-1.5 text-[10px] font-semibold text-primary"
      >
        {index + 1}
      </span>
      <span className="sr-only">
        {t("tool.filePosition", { index: index + 1, total })}
      </span>
    </div>
  );
}
