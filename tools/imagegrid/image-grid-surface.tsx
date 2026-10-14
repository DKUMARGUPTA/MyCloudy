"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement } from "@dnd-kit/modifiers";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { looksHeic, resolveHeicPreview } from "@/lib/heic/heic-preview";
import {
  looksSvg,
  rasterizeSvgFile,
  setSvgRasterOrder,
  subscribeSvgPending,
  svgRastersPending,
} from "./svg-raster";
import {
  ArrowDownAZ,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Images,
  RotateCcw,
  RotateCw,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { formatBytes } from "@/lib/storage/recent-files";
import { cn } from "@/lib/utils";
import {
  createInitialImageGrid,
  deleteImageEntries,
  imageGridStats,
  moveImageEntry,
  reconcileImageGrid,
  rotateImageEntries,
  serializeImageGrid,
  sortEntriesByFileName,
  type ImageEntry,
} from "./model";

/** Cheap TIFF check without reading bytes (type or extension). */
function looksTiff(file: File): boolean {
  return file.type === "image/tiff" || /\.(tif|tiff)$/i.test(file.name);
}

/** Downscaled first-page preview for TIFF cards (pure-TS reader, main thread). */
async function tiffPreview(
  file: File
): Promise<{ url: string; width: number; height: number; pages: number } | null> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { TiffFile } = await import("../imgconv/tiff");
    const tiff = TiffFile.parse(bytes);
    if (tiff.pageCount === 0) return null;
    const page = tiff.decodePage(0);
    // Full-resolution page canvas, then one downscaled draw for the card.
    const full = document.createElement("canvas");
    full.width = page.width;
    full.height = page.height;
    const fullCtx = full.getContext("2d");
    if (!fullCtx) return null;
    fullCtx.putImageData(
      new ImageData(page.rgba, page.width, page.height) as unknown as ImageData,
      0,
      0
    );
    const scale = Math.min(1, 512 / Math.max(page.width, page.height));
    const width = Math.max(1, Math.round(page.width * scale));
    const height = Math.max(1, Math.round(page.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(full, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png")
    );
    if (!blob) return null;
    return {
      url: URL.createObjectURL(blob),
      width: page.width,
      height: page.height,
      pages: tiff.pageCount,
    };
  } catch {
    return null;
  }
}

/**
 * ImageGrid surface (PRD §8.6 "Images to PDF") — the image sibling of the
 * PageGrid: one shared interactive card grid powering images-to-pdf and its
 * jpg/png/webp presets.
 *
 * - drag reorder (mouse / touch long-press / keyboard) + move buttons
 * - per-card rotate 90° L/R with LIVE thumbnail rotation + rotate-all
 * - remove cards, sort A→Z (the IMG_101/IMG_100 fixer), add-more drop zone
 * - the edited list is serialized into the "images" option after every
 *   action, so the shared worker always sees the exact state
 * - all-removed safety gates the CTA (same honest pattern as PageGrid)
 */

const TOOL_BTN =
  "h-11 min-h-11 gap-1.5 rounded-btn px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function ImageGridSurface({
  files,
  onChange,
  addFiles,
  setRunBlocked,
}: ToolSurfaceProps) {
  const { t } = useI18n();

  const [entries, setEntries] = useState<ImageEntry[]>(() =>
    createInitialImageGrid(files.length)
  );
  const [prevFileCount, setPrevFileCount] = useState(files.length);
  // SVG rasters are prepared on the main thread while card previews load —
  // the CTA stays blocked (honest reason) until every one has landed.
  const svgPending = useSyncExternalStore(subscribeSvgPending, svgRastersPending);

  /* ---------------- state sync (promise callbacks only) ---------------- */

  const syncBlocked = useCallback(
    (next: ImageEntry[]) => {
      setRunBlocked(
        svgPending > 0
          ? "igrid.svgRasterizing"
          : next.length === 0
            ? "igrid.ctaNoImages"
            : null
      );
    },
    [setRunBlocked, svgPending]
  );

  // Keep the SVG raster bridge in sync with the workspace file order, and
  // re-evaluate the CTA gate when rasterisation state changes.
  useEffect(() => {
    setSvgRasterOrder(files.map((item) => item.file));
  }, [files]);

  useEffect(() => {
    syncBlocked(entries);
  }, [entries, syncBlocked]);

  // Reconcile when the shell file list changes (add-more / chain). Runs in
  // a microtask callback — never synchronously inside the effect body.
  useEffect(() => {
    if (files.length === prevFileCount) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      const next = reconcileImageGrid(entries, files.length, prevFileCount);
      setEntries(next);
      setPrevFileCount(files.length);
      onChange("images", serializeImageGrid(next));
      syncBlocked(next);
    });
    return () => {
      cancelled = true;
    };
  }, [files.length, entries, prevFileCount, onChange, syncBlocked]);

  /* ---------------- mutations ---------------- */

  const apply = useCallback(
    (next: ImageEntry[]) => {
      setEntries(next);
      onChange("images", serializeImageGrid(next));
      syncBlocked(next);
    },
    [onChange, syncBlocked]
  );

  const rotateAll = (delta: number) => {
    apply(
      rotateImageEntries(
        entries,
        entries.map((_, index) => index),
        delta
      )
    );
  };

  const sortAz = () => {
    apply(sortEntriesByFileName(entries, (source) => files[source]?.file.name ?? ""));
  };

  /* ---------------- drag reorder ---------------- */

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = entries.findIndex((entry) => entry.uid === active.id);
    const to = entries.findIndex((entry) => entry.uid === over.id);
    if (from < 0 || to < 0) return;
    apply(moveImageEntry(entries, from, to));
  };

  const stats = useMemo(() => imageGridStats(entries), [entries]);
  const totalBytes = useMemo(
    () => files.reduce((sum, item) => sum + item.file.size, 0),
    [files]
  );

  /* ---------------- render ---------------- */

  return (
    <section aria-label={t("igrid.surfaceLabel")} className="flex flex-col gap-3">
      {/* Header — stats + quick actions */}
      <div className="flex flex-col gap-3 rounded-card border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-chip px-2.5 py-1 text-[11px] font-semibold",
              entries.length > 0
                ? "bg-cat-create/10 text-cat-create"
                : "bg-muted text-muted-foreground"
            )}
          >
            <Images className="size-3.5" aria-hidden="true" />
            {t("igrid.imageCount", { count: stats.images })}
          </span>
          <span className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            {formatBytes(totalBytes)}
          </span>
          {stats.rotated > 0 ? (
            <span className="rounded-chip bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
              {t("igrid.rotatedCount", { count: stats.rotated })}
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              className={TOOL_BTN}
              onClick={sortAz}
              disabled={entries.length < 2}
              aria-label={t("igrid.sortAzLabel")}
            >
              <ArrowDownAZ className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t("igrid.sortAz")}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              className={cn(TOOL_BTN, "px-2")}
              onClick={() => rotateAll(-90)}
              disabled={entries.length === 0}
              aria-label={t("igrid.rotateAllLeft")}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              className={cn(TOOL_BTN, "px-2")}
              onClick={() => rotateAll(90)}
              disabled={entries.length === 0}
              aria-label={t("igrid.rotateAllRight")}
            >
              <RotateCw className="size-4" aria-hidden="true" />
            </Button>
          </span>
        </div>
        {entries.length === 0 ? (
          <p className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            {t("igrid.emptyHint")}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">{t("igrid.hint")}</p>
        )}
      </div>

      {/* Card grid */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={entries.map((entry) => entry.uid)}
          strategy={rectSortingStrategy}
        >
          <ul className="grid list-none grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {entries.map((entry, index) => (
              <ImageCard
                key={entry.uid}
                entry={entry}
                index={index}
                file={files[entry.source]?.file ?? null}
                onRotate={(delta) =>
                  apply(rotateImageEntries(entries, [index], delta))
                }
                onRemove={() => apply(deleteImageEntries(entries, [index]))}
                onMove={(from, to) => apply(moveImageEntry(entries, from, to))}
                total={entries.length}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      {/* Add more (compact) — same shell pipeline as the landing drop */}
      <DropZone
        labelKey="igrid.addMore"
        multiple
        maxFiles={50}
        acceptKind="image"
        onAccept={addFiles}
        currentCount={files.length}
        className="py-2"
      />
    </section>
  );
}

/* ------------------------------ card ------------------------------ */

function ImageCard({
  entry,
  index,
  total,
  file,
  onRotate,
  onRemove,
  onMove,
}: {
  entry: ImageEntry;
  index: number;
  total: number;
  file: File | null;
  onRotate: (delta: number) => void;
  onRemove: () => void;
  onMove: (from: number, to: number) => void;
}) {
  const { t } = useI18n();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: entry.uid });

  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [pages, setPages] = useState<number | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  // Object URL + natural size for the preview (promise callbacks only —
  // never setState synchronously in the effect body). HEIC inputs get a
  // queued libheif preview (Safari's native <img> path is kept for itself);
  // TIFF cards get a first-page PNG from the clean-room reader (no browser
  // shows TIFF in <img> outside Safari); SVG files rasterise into the
  // main-thread store on load so collectAssets can hand them to the worker.
  // Preview URLs from the HEIC cache are NOT revoked here — the cache owns
  // them, unlike the object URLs this card creates for other inputs.
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      if (looksHeic(file)) {
        const preview = await resolveHeicPreview(file);
        if (cancelled) return;
        if (preview) {
          setUrl(preview.url);
          setDims({ w: preview.width, h: preview.height });
          return;
        }
        // Byte-sniff says not HEIC after all — fall through to <img>.
      }
      if (looksTiff(file)) {
        const preview = await tiffPreview(file);
        if (cancelled) {
          if (preview) URL.revokeObjectURL(preview.url);
          return;
        }
        if (preview) {
          objectUrl = preview.url;
          setUrl(preview.url);
          setDims({ w: preview.width, h: preview.height });
          setPages(preview.pages);
          return;
        }
        // Unreadable TIFF — keep the pulse placeholder and let the honest
        // worker error explain (tiff-to-pdf config copy covers it).
        return;
      }
      objectUrl = URL.createObjectURL(file);
      setUrl(objectUrl);
      if (looksSvg(file)) {
        // Rasterise for the run while the <img> preview loads itself.
        void rasterizeSvgFile(file).catch(() => undefined);
      }
      const img = new Image();
      img.onload = () => {
        if (!cancelled) setDims({ w: img.naturalWidth, h: img.naturalHeight });
      };
      img.src = objectUrl;
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "relative list-none",
        isDragging && "z-20",
        isOver && !isDragging && "rounded-card ring-2 ring-primary/40"
      )}
    >
      <div
        className={cn(
          "group relative flex flex-col overflow-hidden rounded-card border border-border bg-card transition-all duration-200",
          "hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md focus-within:ring-[3px] focus-within:ring-ring/50",
          isDragging && "shadow-lg ring-2 ring-primary/30"
        )}
      >
        {/* Preview with LIVE CSS rotation */}
        <div className="relative aspect-square w-full overflow-hidden bg-muted/40">
          {url ? (
            <img
              src={url}
              alt={file?.name ?? ""}
              loading="lazy"
              decoding="async"
              className="size-full object-cover transition-transform duration-300 group-hover:[--s:1.04]"
              style={{
                transform: `rotate(${entry.rotation}deg) scale(var(--s,1))`,
              }}
            />
          ) : (
            <div
              aria-hidden="true"
              className="size-full animate-pulse bg-gradient-to-br from-muted to-muted/40"
            />
          )}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-1.5 top-1.5 rounded-chip bg-background/85 px-1.5 py-0.5 text-[10px] font-bold text-foreground shadow-sm backdrop-blur"
          >
            {index + 1}
          </span>
          {pages !== null && pages > 1 ? (
            <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-chip bg-cat-create/95 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm">
              {t("igrid.tiffPages", { count: pages })}
            </span>
          ) : null}
          {entry.rotation !== 0 ? (
            <span className="pointer-events-none absolute right-1.5 top-1.5 rounded-chip bg-amber-500/95 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm">
              {entry.rotation}°
            </span>
          ) : null}
          <span className="sr-only">
            {t("igrid.cardPosition", { index: index + 1, total })}
          </span>
        </div>

        {/* Meta + actions */}
        <div className="flex flex-col gap-1.5 p-2.5">
          <p
            className="truncate text-xs font-semibold text-foreground"
            title={file?.name}
          >
            {file?.name}
          </p>
          <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span>{file ? formatBytes(file.size) : ""}</span>
            {dims ? (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {dims.w}×{dims.h}
                </span>
              </>
            ) : null}
          </p>
          <div className="mt-0.5 flex items-center gap-1">
            <button
              type="button"
              onClick={() => onRotate(-90)}
              aria-label={t("igrid.rotateLeftLabel", { name: file?.name ?? "" })}
              className="flex size-8 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onRotate(90)}
              aria-label={t("igrid.rotateRightLabel", { name: file?.name ?? "" })}
              className="flex size-8 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <RotateCw className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onMove(index, index - 1)}
              disabled={index === 0}
              aria-label={t("igrid.moveEarlierLabel", { name: file?.name ?? "" })}
              className="flex size-8 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronUp className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onMove(index, index + 1)}
              disabled={index === total - 1}
              aria-label={t("igrid.moveLaterLabel", { name: file?.name ?? "" })}
              className="flex size-8 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronDown className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onRemove}
              aria-label={t("igrid.removeLabel", { name: file?.name ?? "" })}
              className="ml-auto flex size-8 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Drag grip — always visible on touch devices (no hover),
            hover-revealed on pointer devices */}
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t("igrid.dragLabel", { name: file?.name ?? "" })}
          className={cn(
            "absolute bottom-1.5 right-1.5 z-10 flex size-8 items-center justify-center rounded-btn bg-background/80 text-muted-foreground/70 opacity-0 outline-none backdrop-blur transition-all",
            "cursor-grab touch-none hover:text-foreground active:cursor-grabbing focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "focus-visible:opacity-100 group-hover:opacity-100",
            "max-lg:opacity-90",
            isDragging && "opacity-100 bg-accent text-foreground"
          )}
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}
