"use client";

import { useEffect, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Check,
  GripHorizontal,
  FilePlus2,
  RotateCcw,
  RotateCw,
  Trash2,
} from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import { renderPdfThumbnail } from "@/lib/pdf/thumbnails";
import { cn } from "@/lib/utils";
import { normalizeRotation, type GridPage } from "./model";

/**
 * One PageGrid cell: lazily-rendered thumbnail with LIVE rotation
 * (PRD §8.1 rotate preset), current position badge, selection state and
 * per-cell actions (rotate L/R, delete) for the selected pages. Drag handle
 * activates dnd-kit sortable when the grid is fully mounted.
 */

export interface GridCellProps {
  entry: GridPage;
  /** Current position in the grid (0-based; badge shows index+1). */
  index: number;
  file: File | null;
  aspect: number;
  selected: boolean;
  focusable: boolean;
  sortable: boolean;
  thumbDim: number;
  onToggle: (
    index: number,
    event: React.MouseEvent<HTMLButtonElement>
  ) => void;
  onFocusCell: (index: number) => void;
  onRotate: (index: number, delta: number) => void;
  onDelete: (index: number) => void;
}

export function GridCell({
  entry,
  index,
  file,
  aspect,
  selected,
  focusable,
  sortable,
  thumbDim,
  onToggle,
  onFocusCell,
  onRotate,
  onDelete,
}: GridCellProps) {
  const { t } = useI18n();
  const rotation = normalizeRotation(entry.rotation);
  const isBlank = entry.source === -1;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: entry.uid, disabled: !sortable });

  const pageState = selected ? ", selected" : "";
  const rotationState =
    rotation !== 0 ? `, ${t("grid.rotatedBy", { deg: rotation })}` : "";
  const blankState = isBlank ? `, ${t("grid.pageBlank")}` : "";
  // Position + provenance: after a reorder the badge still shows where the
  // page came from ("Page 3 · from page 1") — real ground truth for the
  // rearrange preset and honest labeling for screen readers.
  const fromState =
    !isBlank && entry.source !== index ? `, ${t("grid.fromPage", { page: entry.source + 1 })}` : "";
  const label = `${t("grid.pageLabel", { page: index + 1 })}${pageState}${rotationState}${blankState}${fromState}`;

  return (
    <div
      ref={setNodeRef}
      role="gridcell"
      data-cell-index={index}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "relative flex w-full flex-col",
        isDragging && "z-20 scale-[1.03]"
      )}
    >
      <div
        className={cn(
          "group relative w-full overflow-hidden rounded-lg border transition-all duration-150 motion-reduce:transition-none",
          selected
            ? "border-primary/60 ring-2 ring-primary/30 shadow-sm"
            : "border-border bg-background hover:border-primary/40 hover:ring-1 hover:ring-primary/20",
          isDragging && "shadow-xl ring-2 ring-primary/40",
          isOver && !isDragging && "border-primary/60 ring-2 ring-primary/30"
        )}
        style={{ aspectRatio: aspect }}
      >
        <CellThumb
          file={file}
          entry={entry}
          thumbDim={thumbDim}
          rotation={rotation}
        />

        {/* Position badge — shows the source page too once the order
            changes, so rearranged grids stay readable at a glance */}
        <span
          className={cn(
            "absolute left-1.5 top-1.5 flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-[10px] font-bold shadow-sm",
            selected
              ? "bg-primary text-primary-foreground"
              : "bg-background/90 text-foreground/80 backdrop-blur-sm"
          )}
          title={
            !isBlank && entry.source !== index
              ? t("grid.fromPage", { page: entry.source + 1 })
              : undefined
          }
        >
          {index + 1}
        </span>

        {/* Rotation badge */}
        {rotation !== 0 ? (
          <span className="absolute right-1.5 top-1.5 flex h-6 items-center gap-0.5 rounded-full bg-amber-500/95 px-1.5 text-[10px] font-bold text-white shadow-sm">
            <RotateCw className="size-3" aria-hidden="true" />
            {rotation}°
          </span>
        ) : null}

        {/* Selected check — zooms in; reduced-motion respected globally */}
        {selected ? (
          <span
            className="animate-in zoom-in-50 absolute bottom-1.5 left-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm motion-reduce:animate-none"
            aria-hidden="true"
          >
            <Check className="size-3.5" />
          </span>
        ) : null}

        {/* Full-cell select button (44px+ target) */}
        <button
          type="button"
          tabIndex={focusable ? 0 : -1}
          aria-pressed={selected}
          aria-label={label}
          onClick={(event) => onToggle(index, event)}
          onFocus={() => onFocusCell(index)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
              return;
            }
            event.preventDefault();
            const delta = event.key === "ArrowRight" ? 1 : -1;
            const next = index + delta;
            const target = document.querySelector<HTMLButtonElement>(
              `[data-cell-index="${next}"] [data-cell-select]`
            );
            target?.focus();
          }}
          data-cell-select
          className="absolute inset-0 z-10 rounded-lg outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/60"
        />

        {/* Per-cell actions (visible on selected cells — keyboard reachable) */}
        {selected ? (
          <div className="animate-in fade-in slide-in-from-bottom-1 absolute inset-x-1.5 bottom-1.5 z-20 flex items-center justify-end gap-1 motion-reduce:animate-none">
            <CellAction
              label={t("grid.cellRotateLeft", { page: index + 1 })}
              onClick={() => onRotate(index, -90)}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
            </CellAction>
            <CellAction
              label={t("grid.cellRotateRight", { page: index + 1 })}
              onClick={() => onRotate(index, 90)}
            >
              <RotateCw className="size-3.5" aria-hidden="true" />
            </CellAction>
            <CellAction
              label={t("grid.cellDelete", { page: index + 1 })}
              danger
              onClick={() => onDelete(index)}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </CellAction>
          </div>
        ) : null}

        {/* Drag handle (mounted grids only) */}
        {sortable ? (
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={t("grid.cellDragHandle", { page: index + 1 })}
            className={cn(
              "absolute right-1.5 top-1.5 z-20 flex size-8 items-center justify-center rounded-btn text-foreground/50 outline-none transition-colors",
              "cursor-grab touch-none hover:bg-background/80 hover:text-foreground active:cursor-grabbing",
              "focus-visible:ring-[3px] focus-visible:ring-ring/60",
              rotation !== 0 && "top-9",
              isDragging && "bg-background/80 text-foreground"
            )}
          >
            <GripHorizontal className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 44px keyboard-accessible mini action inside a selected cell. */
function CellAction({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-full border shadow-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/60",
        danger
          ? "border-destructive/30 bg-destructive text-destructive-foreground hover:bg-destructive/90"
          : "border-border bg-background/95 text-foreground/80 backdrop-blur-sm hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

/** Lazy thumbnail: renders only while near the viewport (IO). */
function CellThumb({
  file,
  entry,
  thumbDim,
  rotation,
}: {
  file: File | null;
  entry: GridPage;
  thumbDim: number;
  rotation: number;
}) {
  const { t } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file || entry.source < 0) return;
    const box = boxRef.current;
    if (box === null) return;

    let cancelled = false;
    let objectUrl: string | null = null;
    let observer: IntersectionObserver | null = null;

    const load = () => {
      void renderPdfThumbnail(file, {
        pageIndex: entry.source,
        maxDim: thumbDim,
      })
        .then((result) => {
          if (cancelled) return;
          objectUrl = URL.createObjectURL(result.blob);
          setUrl(objectUrl);
        })
        .catch(() => undefined);
    };

    observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          if (record.isIntersecting) {
            observer?.disconnect();
            load();
          }
        }
      },
      { rootMargin: "300px" }
    );
    observer.observe(box);

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file, entry.source, thumbDim]);

  if (entry.source < 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 border-2 border-dashed border-emerald-500/40 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400">
        <FilePlus2 className="size-5" aria-hidden="true" />
        <span className="text-[10px] font-semibold">
          {t("grid.pageBlank")}
        </span>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="h-full w-full bg-muted/40">
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="size-full object-contain transition-transform duration-200 motion-reduce:transition-none"
          style={{ transform: `rotate(${rotation}deg)` }}
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
