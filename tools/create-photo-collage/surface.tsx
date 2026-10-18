"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import { decodeHeicToBitmap } from "@/lib/heic/heic-decode";
import {
  ArrowDownAZ,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  GripVertical,
  Images,
  ImageDown,
  Loader2,
  RotateCcw,
  RotateCw,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { formatBytes } from "@/lib/storage/recent-files";
import { downloadBlob, sanitizeFileName } from "@/lib/files/output";
import { cn } from "@/lib/utils";
import {
  BACKGROUND_COLORS,
  DEFAULT_STYLE,
  LAYOUTS,
  MAX_CAPTION_CHARS,
  MAX_TITLE_CHARS,
  computePages,
  defaultCaptionFor,
  outputBaseName,
  pagePtSize,
  pagePixelSize,
  serializeCollage,
  type CollageFormat,
  type CollagePhoto,
  type CollageStyle,
  type ExportFormat,
} from "./model";
import {
  drawCollagePage,
  orientedSource,
  type CollageSource,
} from "./render";

/**
 * Create photo collage surface (PRD "Photo collage") — the WYSIWYG
 * workspace. Photo cards (reorder / rotate / remove / polaroid
 * captions) plus the full recipe panel, with a live preview painted by
 * the SAME render.ts the export worker uses.
 *
 * State flows one way: every mutation (card action, style control)
 * rewrites the "collage" option via the shell's onChange, so the Run
 * CTA always ships the exact previewed recipe. JPG/PNG quick downloads
 * render page 1 on the main thread (canvas.toBlob) — the run worker
 * owns the PDF path.
 */

const TOOL_BTN =
  "h-11 min-h-11 gap-1.5 rounded-btn px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50";

/* ------------------------------ state ------------------------------ */

interface CollageEntry {
  uid: string;
  /** Index into the workspace `files` array. */
  source: number;
  /** Cumulative quarter-turn rotation (0/90/180/270, clockwise). */
  rotation: number;
  /** Polaroid caption (defaults to the file stem). */
  caption: string;
}

interface SurfaceState {
  entries: CollageEntry[];
  style: CollageStyle;
  exportFormat: ExportFormat;
}

let uidSeq = 0;
function nextUid(): string {
  uidSeq += 1;
  return `pc-${Date.now().toString(36)}-${uidSeq}`;
}

function normalizeRotation(rotation: number): number {
  return ((rotation % 360) + 360) % 360;
}

/** Keeps the edited list aligned with the live workspace files. */
function reconcileEntries(
  entries: CollageEntry[],
  files: ToolSurfaceProps["files"],
  previousCount: number
): CollageEntry[] {
  const count = files.length;
  if (count === previousCount) return entries;
  const next: CollageEntry[] = [];
  const seen = new Set<number>();
  if (count < previousCount) {
    for (const entry of entries) {
      if (entry.source < count && !seen.has(entry.source)) {
        next.push(entry);
        seen.add(entry.source);
      }
    }
  } else {
    for (const entry of entries) {
      if (!seen.has(entry.source)) {
        next.push(entry);
        seen.add(entry.source);
      }
    }
  }
  for (let source = 0; source < count; source += 1) {
    if (!seen.has(source)) {
      next.push({
        uid: nextUid(),
        source,
        rotation: 0,
        caption: defaultCaptionFor(files[source].file.name),
      });
    }
  }
  return next;
}

/* --------------------------- decode helpers --------------------------- */

/** Cheap TIFF check without reading bytes (type or extension). */
function looksTiff(file: File): boolean {
  return file.type === "image/tiff" || /\.(tif|tiff)$/i.test(file.name);
}

/** Full-resolution first page of a TIFF (clean-room reader, main thread). */
async function tiffBitmap(file: File): Promise<ImageBitmap | null> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { TiffFile } = await import("../imgconv/tiff");
    const tiff = TiffFile.parse(bytes);
    if (tiff.pageCount === 0) return null;
    const page = tiff.decodePage(0);
    const canvas = document.createElement("canvas");
    canvas.width = page.width;
    canvas.height = page.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.putImageData(
      new ImageData(page.rgba, page.width, page.height) as unknown as ImageData,
      0,
      0
    );
    return await createImageBitmap(canvas);
  } catch {
    return null;
  }
}

/** PNG blob-URL card preview for TIFF first pages. */
async function tiffPreviewUrl(
  file: File
): Promise<{ url: string; width: number; height: number } | null> {
  const bitmap = await tiffBitmap(file);
  if (!bitmap) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png")
    );
    if (!blob) return null;
    return {
      url: URL.createObjectURL(blob),
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    bitmap.close();
  }
}

/** Small capped preview source for the live canvas (HEIC uses the queued thumbnail). */
async function decodePreviewSource(
  file: File,
  rotation: number
): Promise<CollageSource> {
  let bitmap: ImageBitmap | null = null;
  if (looksHeic(file)) {
    const preview = await resolveHeicPreview(file);
    if (preview) {
      try {
        bitmap = await createImageBitmap(preview.blob);
      } catch {
        bitmap = null;
      }
    }
  }
  if (bitmap === null && looksTiff(file)) {
    bitmap = await tiffBitmap(file);
  }
  if (bitmap === null) {
    bitmap = await createImageBitmap(file);
  }
  const oriented = orientedSource(bitmap, rotation, (w, h) => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas-2d-unavailable");
    return { canvas, ctx };
  });
  if (oriented !== bitmap) bitmap.close();
  return oriented;
}

/** Full-resolution source for the quick downloads (HEIC via libheif). */
async function decodeExportSource(
  file: File,
  rotation: number
): Promise<CollageSource> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    bitmap = null;
  }
  if (bitmap === null && looksHeic(file)) {
    bitmap = await decodeHeicToBitmap(new Uint8Array(await file.arrayBuffer()));
  }
  if (bitmap === null && looksTiff(file)) {
    bitmap = await tiffBitmap(file);
  }
  if (bitmap === null) {
    throw new Error("decode-failed");
  }
  const oriented = orientedSource(bitmap, rotation, (w, h) => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas-2d-unavailable");
    return { canvas, ctx };
  });
  if (oriented !== bitmap) bitmap.close();
  return oriented;
}

/* ------------------------------ surface ------------------------------ */

export function CollageSurface({
  files,
  onChange,
  addFiles,
  setRunBlocked,
}: ToolSurfaceProps) {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [state, setState] = useState<SurfaceState>(() => ({
    // Cards start from the files already in the workspace (the surface
    // can mount with photos present — a chain handoff or a re-entry),
    // with captions defaulting to the file stems.
    entries: files.map((ref, source) => ({
      uid: nextUid(),
      source,
      rotation: 0,
      caption: defaultCaptionFor(ref.file.name),
    })),
    style: { ...DEFAULT_STYLE, captions: [] },
    exportFormat: "pdf",
  }));
  const [prevFileCount, setPrevFileCount] = useState(files.length);
  const [previewPage, setPreviewPage] = useState(0);
  const [quickBusy, setQuickBusy] = useState<"jpg" | "png" | null>(null);

  const { entries, style, exportFormat } = state;
  const pages = useMemo(
    () => computePages(entries.length, style.layout),
    [entries.length, style.layout]
  );
  const page = Math.min(previewPage, Math.max(0, pages.length - 1));

  const fileNameOf = useCallback(
    (source: number): string => files[source]?.file.name ?? "",
    [files]
  );

  /* ---------------- option sync (event-context only) ---------------- */

  const syncOption = useCallback(
    (next: SurfaceState): void => {
      onChange(
        "collage",
        serializeCollage({
          photos: next.entries.map(
            (entry): CollagePhoto => [entry.source, entry.rotation]
          ),
          style: {
            ...next.style,
            captions: next.entries.map((entry) => entry.caption),
          },
          exportFormat: next.exportFormat,
          locale,
        })
      );
    },
    [locale, onChange]
  );

  const apply = useCallback(
    (partial: Partial<SurfaceState>): void => {
      const next = { ...state, ...partial };
      setState(next);
      syncOption(next);
      setRunBlocked(next.entries.length === 0 ? "collage.ctaNoPhotos" : null);
    },
    [state, setRunBlocked, syncOption]
  );

  const patchStyle = useCallback(
    (partial: Partial<CollageStyle>): void => {
      apply({ style: { ...style, ...partial } });
    },
    [apply, style]
  );

  // Mount sync: the serialized option always mirrors the freshly
  // initialized state (a remount from the result view resets edits — the
  // worker must never receive a stale recipe). Microtask, like the
  // reconcile path — never a synchronous write inside the effect body.
  const initialSync = useRef(false);
  useEffect(() => {
    if (initialSync.current) return;
    initialSync.current = true;
    void Promise.resolve().then(() => {
      syncOption(state);
      setRunBlocked(state.entries.length === 0 ? "collage.ctaNoPhotos" : null);
    });
    // Mount-only by design (state is the lazy initializer's value).
  }, []);

  // Language switch re-sync: `locale` rides inside the serialized option
  // (it names the output file), so switching EN ↔ HI after the last edit
  // must re-serialize — otherwise a Hindi UI exports with the English name
  // (and vice versa). Microtask, like the paths above.
  const stateRef = useRef(state);
  stateRef.current = state;
  const localeSeen = useRef(locale);
  useEffect(() => {
    if (localeSeen.current === locale) return;
    localeSeen.current = locale;
    void Promise.resolve().then(() => {
      syncOption(stateRef.current);
    });
  }, [locale, syncOption]);

  /* ---------------- reconcile with the shell file list ---------------- */

  useEffect(() => {
    if (files.length === prevFileCount) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      const next: SurfaceState = {
        ...state,
        entries: reconcileEntries(state.entries, files, prevFileCount),
      };
      setState(next);
      setPrevFileCount(files.length);
      syncOption(next);
      setRunBlocked(next.entries.length === 0 ? "collage.ctaNoPhotos" : null);
    });
    return () => {
      cancelled = true;
    };
  }, [files, prevFileCount, state, setRunBlocked, syncOption]);

  // Card mutations
  const rotateAll = (delta: number) => {
    apply({
      entries: entries.map((entry) => ({
        ...entry,
        rotation: normalizeRotation(entry.rotation + delta),
      })),
    });
  };

  const sortAz = () => {
    apply({
      entries: [...entries].sort((a, b) =>
        fileNameOf(a.source).localeCompare(fileNameOf(b.source), undefined, {
          numeric: true,
          sensitivity: "base",
        })
      ),
    });
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
    const next = [...entries];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    apply({ entries: next });
  };

  /* ---------------- live preview (shared engine) ---------------- */

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [previewW, setPreviewW] = useState(0);
  const bitmapCache = useRef(new Map<string, CollageSource>());
  const renderToken = useRef(0);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver((observed) => {
      const width = observed[0]?.contentRect.width ?? 0;
      if (width > 0) setPreviewW(Math.round(Math.min(560, width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const styleAll = useMemo<CollageStyle>(
    () => ({ ...style, captions: entries.map((entry) => entry.caption) }),
    [style, entries]
  );

  useEffect(() => {
    if (entries.length === 0 || previewW === 0 || pages.length === 0) return;
    const token = renderToken.current + 1;
    renderToken.current = token;
    const timer = setTimeout(() => {
      void (async () => {
        const canvas = canvasRef.current;
        if (!canvas || renderToken.current !== token) return;
        const plan = pages[page];
        if (!plan) return;
        const pt = pagePtSize(style);
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const width = Math.round(previewW * dpr);
        const height = Math.round((previewW * pt.h) / pt.w * dpr);
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${previewW}px`;
        canvas.style.height = `${Math.round((previewW * pt.h) / pt.w)}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        // Skeleton first (background + polaroid frames + captions), so
        // the layout is visible while the photos decode.
        drawCollagePage(ctx, plan, [], styleAll, page, pages.length);

        const images: CollageSource[] = [];
        const missing: Array<{ key: string; file: File; rotation: number; slot: number }> = [];
        const needed = new Set<string>();
        for (const cell of plan.cells) {
          if (cell.photo === null) continue;
          const entry = entries[cell.photo];
          const ref = files[entry.source];
          if (!ref) continue;
          const key = `${ref.id}#${entry.rotation}`;
          needed.add(key);
          const cached = bitmapCache.current.get(key);
          if (cached) images[cell.photo] = cached;
          else missing.push({ key, file: ref.file, rotation: entry.rotation, slot: cell.photo });
        }
        // Keep the cache bounded to what the preview needs (+slack).
        for (const key of [...bitmapCache.current.keys()]) {
          if (bitmapCache.current.size <= 18) break;
          if (!needed.has(key)) {
            const dropped = bitmapCache.current.get(key);
            bitmapCache.current.delete(key);
            if (dropped && "close" in dropped && typeof dropped.close === "function") {
              dropped.close();
            }
          }
        }
        // Decode the misses (an empty list resolves immediately), then
        // ALWAYS repaint with whatever `images` holds — the skeleton draw
        // above only ran with [] and a fully-cached warm pass must still
        // paint the photos, not leave the frames empty.
        if (missing.length > 0) {
          await Promise.all(
            missing.map(async (item) => {
              try {
                const source = await decodePreviewSource(item.file, item.rotation);
                if (renderToken.current !== token) {
                  if ("close" in source && typeof source.close === "function") source.close();
                  return;
                }
                bitmapCache.current.set(item.key, source);
                images[item.slot] = source;
              } catch {
                // The card keeps its placeholder; the run raises the
                // honest decode error for this file.
              }
            })
          );
          if (renderToken.current !== token) return;
        }
        drawCollagePage(ctx, plan, images, styleAll, page, pages.length);
      })().catch(() => undefined);
    }, 140);
    return () => clearTimeout(timer);
  }, [entries, files, page, pages, previewW, styleAll]);

  // Release cached bitmaps on unmount.
  useEffect(() => {
    const cache = bitmapCache.current;
    return () => {
      for (const source of cache.values()) {
        if ("close" in source && typeof source.close === "function") source.close();
      }
      cache.clear();
    };
  }, []);

  /* ---------------- quick downloads (page 1, main thread) ---------------- */

  const downloadImage = useCallback(
    async (format: "jpg" | "png"): Promise<void> => {
      if (entries.length === 0 || pages.length === 0) return;
      setQuickBusy(format);
      try {
        const plan = pages[0];
        const images: CollageSource[] = [];
        await Promise.all(
          plan.cells
            .filter((cell) => cell.photo !== null)
            .map(async (cell) => {
              const entry = entries[cell.photo as number];
              const ref = files[entry.source];
              if (!ref) return;
              images[cell.photo as number] = await decodeExportSource(
                ref.file,
                entry.rotation
              );
            })
        );
        const px = pagePixelSize(style);
        const canvas = document.createElement("canvas");
        canvas.width = px.w;
        canvas.height = px.h;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas-2d-unavailable");
        drawCollagePage(ctx, plan, images, styleAll, 0, pages.length);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(
            resolve,
            format === "png" ? "image/png" : "image/jpeg",
            0.92
          )
        );
        if (!blob) throw new Error("encode-failed");
        downloadBlob(
          blob,
          sanitizeFileName(outputBaseName(locale, format), format)
        );
      } catch {
        toast({ title: t("collage.quickFailed"), variant: "destructive" });
      } finally {
        setQuickBusy(null);
      }
    },
    [entries, files, locale, pages, style, styleAll, t, toast]
  );

  /* ---------------- derived ---------------- */

  const rotatedCount = entries.filter((entry) => entry.rotation !== 0).length;
  const totalBytes = files.reduce((sum, item) => sum + item.file.size, 0);
  const square = style.format === "square";

  /* ---------------- render ---------------- */

  return (
    <section aria-label={t("collage.surfaceLabel")} className="flex flex-col gap-3">
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
            {t("collage.photoCount", { count: entries.length })}
          </span>
          <span className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            {t("collage.pagesNote", { count: pages.length })}
          </span>
          {entries.length > 0 ? (
            <span className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              {formatBytes(totalBytes)}
            </span>
          ) : null}
          {rotatedCount > 0 ? (
            <span className="rounded-chip bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
              {t("collage.rotatedCount", { count: rotatedCount })}
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              className={TOOL_BTN}
              onClick={sortAz}
              disabled={entries.length < 2}
              aria-label={t("collage.sortAzLabel")}
            >
              <ArrowDownAZ className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t("collage.sortAz")}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              className={cn(TOOL_BTN, "px-2")}
              onClick={() => rotateAll(-90)}
              disabled={entries.length === 0}
              aria-label={t("collage.rotateAllLeft")}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              className={cn(TOOL_BTN, "px-2")}
              onClick={() => rotateAll(90)}
              disabled={entries.length === 0}
              aria-label={t("collage.rotateAllRight")}
            >
              <RotateCw className="size-4" aria-hidden="true" />
            </Button>
          </span>
        </div>
        {entries.length === 0 ? (
          <p className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            {t("collage.emptyHint")}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">{t("collage.hint")}</p>
        )}
      </div>

      {/* Live preview — the SAME engine the worker paints with */}
      <div className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("collage.previewLabel")}
          </h3>
          {pages.length > 1 ? (
            <span className="ml-auto flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                className="size-9 min-h-9 p-0"
                onClick={() => setPreviewPage(Math.max(0, page - 1))}
                disabled={page === 0}
                aria-label={t("collage.prevPage")}
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
              </Button>
              <span className="min-w-16 text-center text-xs font-medium text-foreground">
                {t("collage.pageOf", { page: page + 1, pages: pages.length })}
              </span>
              <Button
                type="button"
                variant="outline"
                className="size-9 min-h-9 p-0"
                onClick={() =>
                  setPreviewPage(Math.min(pages.length - 1, page + 1))
                }
                disabled={page >= pages.length - 1}
                aria-label={t("collage.nextPage")}
              >
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </span>
          ) : null}
        </div>
        <div ref={wrapRef} className="flex w-full justify-center">
          {entries.length > 0 ? (
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={t("collage.previewAlt", {
                page: page + 1,
                pages: pages.length,
              })}
              className="max-w-full rounded-btn border border-border bg-card shadow-sm"
            />
          ) : (
            <p className="w-full rounded-btn border border-dashed border-border bg-muted/30 px-6 py-10 text-center text-xs text-muted-foreground">
              {t("collage.previewEmpty")}
            </p>
          )}
        </div>
      </div>

      {/* Recipe controls */}
      <div className="grid gap-5 rounded-card border border-border bg-card p-4 sm:grid-cols-2">
        {/* Layout picker — visual mini previews of each template */}
        <div className="sm:col-span-2">
          <span className="text-xs font-medium text-foreground">
            {t("collage.layoutLabel")}
          </span>
          <div
            role="radiogroup"
            aria-label={t("collage.layoutLabel")}
            className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5"
          >
            {LAYOUTS.map((layout) => {
              const active = style.layout === layout.id;
              return (
                <button
                  key={layout.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => patchStyle({ layout: layout.id })}
                  className={cn(
                    "flex min-h-11 flex-col items-center gap-1.5 rounded-btn border p-2 outline-none transition-colors",
                    "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    active
                      ? "border-cat-create/60 bg-cat-create/10"
                      : "border-border bg-card hover:border-cat-create/40"
                  )}
                >
                  <span className="relative aspect-square w-full max-w-12 overflow-hidden rounded-sm bg-muted/70 p-0.5">
                    {layout.cells.map((cell, index) => (
                      <span
                        key={index}
                        aria-hidden="true"
                        className="absolute rounded-[2px] bg-cat-create/70"
                        style={{
                          left: `calc(${cell.x * 100}% + 1px)`,
                          top: `calc(${cell.y * 100}% + 1px)`,
                          width: `calc(${cell.w * 100}% - 2px)`,
                          height: `calc(${cell.h * 100}% - 2px)`,
                        }}
                      />
                    ))}
                  </span>
                  <span className="text-center text-[10px] leading-tight text-muted-foreground">
                    {layout.label[locale]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Page size */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="collage-format" className="text-xs">
            {t("collage.formatLabel")}
          </Label>
          <Select
            value={style.format}
            onValueChange={(value) => {
              if (value === "a4" || value === "letter" || value === "square" || value === "photo4x6") {
                patchStyle({ format: value as CollageFormat });
              }
            }}
          >
            <SelectTrigger id="collage-format" className="h-10 min-h-10 w-full rounded-btn text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="a4">{t("collage.formatA4")}</SelectItem>
              <SelectItem value="letter">{t("collage.formatLetter")}</SelectItem>
              <SelectItem value="square">{t("collage.formatSquare")}</SelectItem>
              <SelectItem value="photo4x6">{t("collage.formatPhoto4x6")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Orientation */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-foreground">
            {t("collage.orientationLabel")}
          </span>
          <ToggleGroup
            type="single"
            value={style.orientation}
            onValueChange={(value) => {
              if (value === "portrait" || value === "landscape") {
                patchStyle({ orientation: value });
              }
            }}
            className="min-h-10"
            disabled={square}
          >
            <ToggleGroupItem value="portrait" className="min-h-9 flex-1 rounded-btn px-3 text-xs">
              {t("collage.orientationPortrait")}
            </ToggleGroupItem>
            <ToggleGroupItem value="landscape" className="min-h-9 flex-1 rounded-btn px-3 text-xs">
              {t("collage.orientationLandscape")}
            </ToggleGroupItem>
          </ToggleGroup>
          {square ? (
            <p className="text-[10px] text-muted-foreground">
              {t("collage.orientationSquareHint")}
            </p>
          ) : null}
        </div>

        {/* Background */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-foreground">
            {t("collage.backgroundLabel")}
          </span>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(BACKGROUND_COLORS) as Array<"white" | "soft" | "dark">).map(
              (preset) => (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={style.background === preset}
                  onClick={() => patchStyle({ background: preset })}
                  title={t(`collage.bg${preset.charAt(0).toUpperCase()}${preset.slice(1)}`)}
                  className={cn(
                    "flex size-10 items-center justify-center rounded-btn border-2 outline-none transition-colors",
                    "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    style.background === preset
                      ? "border-cat-create"
                      : "border-border hover:border-cat-create/40"
                  )}
                  style={{ backgroundColor: BACKGROUND_COLORS[preset] }}
                >
                  {style.background === preset ? (
                    <span
                      className="size-2 rounded-full"
                      style={{
                        backgroundColor:
                          preset === "dark" ? "#faf9f7" : "#1c1917",
                      }}
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className="sr-only">
                    {t(`collage.bg${preset.charAt(0).toUpperCase()}${preset.slice(1)}`)}
                  </span>
                </button>
              )
            )}
            <button
              type="button"
              aria-pressed={style.background === "custom"}
              onClick={() => patchStyle({ background: "custom" })}
              className={cn(
                "flex h-10 min-h-10 items-center justify-center gap-1.5 rounded-btn border-2 px-3 text-xs font-medium outline-none transition-colors",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                style.background === "custom"
                  ? "border-cat-create text-foreground"
                  : "border-border text-muted-foreground hover:border-cat-create/40 hover:text-foreground"
              )}
            >
              <span
                aria-hidden="true"
                className="size-3.5 rounded-sm border border-border"
                style={{ backgroundColor: style.customColor }}
              />
              {t("collage.bgCustom")}
            </button>
          </div>
          {style.background === "custom" ? (
            <label className="mt-1 flex items-center gap-2">
              <span className="sr-only">{t("collage.customColorLabel")}</span>
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(style.customColor) ? style.customColor : "#f5f1ea"}
                onChange={(event) => patchStyle({ customColor: event.target.value })}
                aria-label={t("collage.customColorLabel")}
                className="size-9 shrink-0 cursor-pointer rounded-btn border border-border bg-card p-0.5"
              />
              <Input
                value={style.customColor}
                onChange={(event) => patchStyle({ customColor: event.target.value })}
                maxLength={7}
                aria-label={t("collage.customColorLabel")}
                className="h-9 min-h-9 w-24 rounded-btn font-mono text-xs"
              />
            </label>
          ) : null}
        </div>

        {/* Corners */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-foreground">
            {t("collage.radiusLabel")}
          </span>
          <ToggleGroup
            type="single"
            value={style.radius}
            onValueChange={(value) => {
              if (value === "none" || value === "soft" || value === "round") {
                patchStyle({ radius: value });
              }
            }}
            className="min-h-10"
          >
            <ToggleGroupItem value="none" className="min-h-9 flex-1 rounded-btn px-2 text-xs">
              {t("collage.radiusNone")}
            </ToggleGroupItem>
            <ToggleGroupItem value="soft" className="min-h-9 flex-1 rounded-btn px-2 text-xs">
              {t("collage.radiusSoft")}
            </ToggleGroupItem>
            <ToggleGroupItem value="round" className="min-h-9 flex-1 rounded-btn px-2 text-xs">
              {t("collage.radiusRound")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {/* Gap */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-foreground">
            {t("collage.gapLabel")}
          </span>
          <ToggleGroup
            type="single"
            value={style.gap}
            onValueChange={(value) => {
              if (value === "none" || value === "thin" || value === "cozy") {
                patchStyle({ gap: value });
              }
            }}
            className="min-h-10"
          >
            <ToggleGroupItem value="none" className="min-h-9 flex-1 rounded-btn px-2 text-xs">
              {t("collage.gapNone")}
            </ToggleGroupItem>
            <ToggleGroupItem value="thin" className="min-h-9 flex-1 rounded-btn px-2 text-xs">
              {t("collage.gapThin")}
            </ToggleGroupItem>
            <ToggleGroupItem value="cozy" className="min-h-9 flex-1 rounded-btn px-2 text-xs">
              {t("collage.gapCozy")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {/* Margin */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-foreground">
            {t("collage.marginLabel")}
          </span>
          <ToggleGroup
            type="single"
            value={style.margin}
            onValueChange={(value) => {
              if (value === "none" || value === "thin" || value === "cozy") {
                patchStyle({ margin: value });
              }
            }}
            className="min-h-10"
          >
            <ToggleGroupItem value="none" className="min-h-9 flex-1 rounded-btn px-2 text-xs">
              {t("collage.marginNone")}
            </ToggleGroupItem>
            <ToggleGroupItem value="thin" className="min-h-9 flex-1 rounded-btn px-2 text-xs">
              {t("collage.marginThin")}
            </ToggleGroupItem>
            <ToggleGroupItem value="cozy" className="min-h-9 flex-1 rounded-btn px-2 text-xs">
              {t("collage.marginCozy")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {/* Fit */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-foreground">
            {t("collage.fitLabel")}
          </span>
          <ToggleGroup
            type="single"
            value={style.fit}
            onValueChange={(value) => {
              if (value === "cover" || value === "contain") {
                patchStyle({ fit: value });
              }
            }}
            className="min-h-10"
          >
            <ToggleGroupItem value="cover" className="min-h-9 flex-1 rounded-btn px-2 text-xs">
              {t("collage.fitCover")}
            </ToggleGroupItem>
            <ToggleGroupItem value="contain" className="min-h-9 flex-1 rounded-btn px-2 text-xs">
              {t("collage.fitContain")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {/* Polaroid + title */}
        <div className="flex flex-col gap-3 sm:col-span-2 sm:flex-row sm:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="collage-polaroid" className="text-xs">
                {t("collage.polaroidLabel")}
              </Label>
              <Switch
                id="collage-polaroid"
                checked={style.polaroid}
                onCheckedChange={(checked) => patchStyle({ polaroid: checked })}
              />
            </div>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {t("collage.polaroidHint")}
            </p>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="collage-title" className="text-xs">
              {t("collage.titleLabel")}
            </Label>
            <Input
              id="collage-title"
              value={style.title}
              maxLength={MAX_TITLE_CHARS}
              placeholder={t("collage.titlePlaceholder")}
              onChange={(event) => patchStyle({ title: event.target.value })}
              className="h-10 min-h-10 rounded-btn text-xs"
            />
          </div>
        </div>

        {/* Export format + quick downloads */}
        <div className="flex flex-col gap-3 sm:col-span-2 sm:flex-row sm:items-end">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">
              {t("collage.exportLabel")}
            </span>
            <ToggleGroup
              type="single"
              value={exportFormat}
              onValueChange={(value) => {
                if (value === "pdf" || value === "jpg" || value === "png") {
                  apply({ exportFormat: value });
                }
              }}
              className="min-h-10"
            >
              <ToggleGroupItem value="pdf" className="min-h-9 flex-1 rounded-btn px-3 text-xs">
                {t("collage.exportPdf")}
              </ToggleGroupItem>
              <ToggleGroupItem value="jpg" className="min-h-9 flex-1 rounded-btn px-3 text-xs">
                {t("collage.exportJpg")}
              </ToggleGroupItem>
              <ToggleGroupItem value="png" className="min-h-9 flex-1 rounded-btn px-3 text-xs">
                {t("collage.exportPng")}
              </ToggleGroupItem>
            </ToggleGroup>
            <p className="text-[10px] text-muted-foreground">
              {exportFormat === "pdf"
                ? t("collage.qualityNote")
                : t("collage.exportImageNote")}
            </p>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">
              {t("collage.quickLabel")}
            </span>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-11 min-h-11 rounded-btn text-xs font-semibold"
                disabled={entries.length === 0 || quickBusy !== null}
                onClick={() => void downloadImage("jpg")}
              >
                {quickBusy === "jpg" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <ImageDown className="size-4" aria-hidden="true" />
                )}
                {t("collage.quickJpg")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-11 min-h-11 rounded-btn text-xs font-semibold"
                disabled={entries.length === 0 || quickBusy !== null}
                onClick={() => void downloadImage("png")}
              >
                {quickBusy === "png" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <ImageDown className="size-4" aria-hidden="true" />
                )}
                {t("collage.quickPng")}
              </Button>
            </div>
          </div>
        </div>
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
              <CollageCard
                key={entry.uid}
                entry={entry}
                index={index}
                total={entries.length}
                file={files[entry.source]?.file ?? null}
                polaroid={style.polaroid}
                onRotate={(delta) =>
                  apply({
                    entries: entries.map((item, i) =>
                      i === index
                        ? { ...item, rotation: normalizeRotation(item.rotation + delta) }
                        : item
                    ),
                  })
                }
                onRemove={() =>
                  apply({ entries: entries.filter((_, i) => i !== index) })
                }
                onMove={(from, to) => {
                  if (from === to || from < 0 || to < 0 || from >= entries.length || to >= entries.length) return;
                  const next = [...entries];
                  const [moved] = next.splice(from, 1);
                  next.splice(to, 0, moved);
                  apply({ entries: next });
                }}
                onCaption={(caption) =>
                  apply({
                    entries: entries.map((item, i) =>
                      i === index ? { ...item, caption } : item
                    ),
                  })
                }
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      {/* Add more (compact) — same shell pipeline as the landing drop */}
      <DropZone
        labelKey="collage.addMore"
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

export default CollageSurface;

/* ------------------------------ card ------------------------------ */

function CollageCard({
  entry,
  index,
  total,
  file,
  polaroid,
  onRotate,
  onRemove,
  onMove,
  onCaption,
}: {
  entry: CollageEntry;
  index: number;
  total: number;
  file: File | null;
  polaroid: boolean;
  onRotate: (delta: number) => void;
  onRemove: () => void;
  onMove: (from: number, to: number) => void;
  onCaption: (caption: string) => void;
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
  const [url, setUrl] = useState<string | null>(null);

  // Card preview (imagegrid pattern): object URL for regular images, a
  // queued libheif preview for HEIC (cache-owned URL), a first-page PNG
  // for TIFF. Promise callbacks only — never sync setState in effects.
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
        const preview = await tiffPreviewUrl(file);
        if (cancelled) {
          if (preview) URL.revokeObjectURL(preview.url);
          return;
        }
        if (preview) {
          objectUrl = preview.url;
          setUrl(preview.url);
          setDims({ w: preview.width, h: preview.height });
          return;
        }
        // Unreadable TIFF — keep the pulse placeholder; the run gives
        // the honest error.
        return;
      }
      objectUrl = URL.createObjectURL(file);
      setUrl(objectUrl);
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
          {entry.rotation !== 0 ? (
            <span className="pointer-events-none absolute right-1.5 top-1.5 rounded-chip bg-amber-500/95 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm">
              {entry.rotation}°
            </span>
          ) : null}
          <span className="sr-only">
            {t("collage.cardPosition", { index: index + 1, total })}
          </span>
        </div>

        {/* Meta + actions */}
        <div className="flex flex-col gap-1.5 p-2.5">
          <p className="truncate text-xs font-semibold text-foreground" title={file?.name}>
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
          {polaroid ? (
            <label className="mt-0.5 flex flex-col gap-1">
              <span className="text-[10px] font-medium text-muted-foreground">
                {t("collage.captionLabel")}
              </span>
              <Input
                value={entry.caption}
                maxLength={MAX_CAPTION_CHARS}
                placeholder={t("collage.captionPlaceholder")}
                onChange={(event) => onCaption(event.target.value)}
                aria-label={t("collage.captionLabel")}
                className="h-8 min-h-8 rounded-btn text-xs"
              />
            </label>
          ) : null}
          <div className="mt-0.5 flex items-center gap-1">
            <button
              type="button"
              onClick={() => onRotate(-90)}
              aria-label={t("collage.rotateLeftLabel", { name: file?.name ?? "" })}
              className="flex size-8 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onRotate(90)}
              aria-label={t("collage.rotateRightLabel", { name: file?.name ?? "" })}
              className="flex size-8 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <RotateCw className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onMove(index, index - 1)}
              disabled={index === 0}
              aria-label={t("collage.moveEarlierLabel", { name: file?.name ?? "" })}
              className="flex size-8 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronUp className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onMove(index, index + 1)}
              disabled={index === total - 1}
              aria-label={t("collage.moveLaterLabel", { name: file?.name ?? "" })}
              className="flex size-8 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronDown className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onRemove}
              aria-label={t("collage.removeLabel", { name: file?.name ?? "" })}
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
          aria-label={t("collage.dragLabel", { name: file?.name ?? "" })}
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
