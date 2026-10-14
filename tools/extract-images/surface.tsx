"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCheck,
  ImageOff,
  Images,
  Loader2,
  SquareX,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { PDF_DOC_PARAMS, loadPdfjs } from "@/lib/pdf/pdfjs";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { formatBytes } from "@/lib/storage/recent-files";
import { cn } from "@/lib/utils";
import { PreviewFileHeader } from "../stamp-common/preview-parts";
import {
  EXI_IDS,
  expandToRGBA,
  MIN_SIZE_VALUES,
  passesMinSize,
  resolveExiOptions,
  serializeSelectedSet,
} from "./engine";
import { collectImages, type RawImage } from "./collect";

/**
 * Extract PDF images surface (PRD §8.1) — transparency before the run:
 * a read-only on-device probe (main-thread pdf.js, the unlock-pdf pattern)
 * walks the FIRST file cheaply (first 40 images / 30 pages) and shows the
 * embedded-image grid with dimensions, page chips and selection checkboxes.
 * The worker is the authority for the extraction itself.
 *
 * The minSize toggle writes the REAL option (single source of truth with
 * the options panel); the selection serializes to the "selected" option as
 * stable keys the worker honors for file #1. Every other file extracts in
 * full — stated plainly in the note under the grid.
 */

/** Probe budget: cheap preview, honest "+N more" note beyond it. */
const PROBE_MAX_IMAGES = 40;
const PROBE_MAX_PAGES = 30;
/** Thumbnail longer side (CSS px — data images too). */
const THUMB_MAX_DIM = 128;

/** Static i18n keys per minSize value (script-greppable, no templates). */
const MIN_SIZE_LABEL_KEYS: Record<number, string> = {
  0: "exi.minAll",
  128: "exi.min128",
  256: "exi.min256",
  512: "exi.min512",
};

interface ProbeImage {
  key: string;
  page: number;
  w: number;
  h: number;
  url: string;
}

type ProbeStatus = "working" | "done" | "none" | "error";

interface ProbeState {
  file: File;
  status: ProbeStatus;
  images: ProbeImage[];
  truncated: boolean;
  pageCount: number;
}

/** Render one detection to a small object-URL PNG (browser-only path). */
async function makeThumbUrl(image: RawImage): Promise<string> {
  const scale = Math.min(1, THUMB_MAX_DIM / Math.max(image.width, image.height));
  const tw = Math.max(1, Math.round(image.width * scale));
  const th = Math.max(1, Math.round(image.height * scale));
  const thumb = new OffscreenCanvas(tw, th);
  const ctx = thumb.getContext("2d");
  if (!ctx) throw new Error("canvas-2d-unavailable");
  if (image.bitmap) {
    ctx.drawImage(image.bitmap, 0, 0, tw, th);
    // NOTE: never close pdf.js-owned ImageBitmaps (see worker.ts note) —
    // closing breaks later pool resolutions in the same document.
  } else if (image.data) {
    const rgba = expandToRGBA(image.data, image.kind, image.width, image.height);
    if (!rgba) throw new Error("image-data-unavailable");
    const full = new OffscreenCanvas(image.width, image.height);
    const fctx = full.getContext("2d");
    if (!fctx) throw new Error("canvas-2d-unavailable");
    fctx.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
    ctx.drawImage(full, 0, 0, tw, th);
  } else {
    throw new Error("image-data-unavailable");
  }
  const blob = await thumb.convertToBlob({ type: "image/png" });
  return URL.createObjectURL(blob);
}

export function ExtractImagesSurface({
  files,
  values,
  onChange,
  setFileOrder,
  setRunBlocked,
  addFiles,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const fileMeta = files[0];
  const file = fileMeta?.file ?? null;
  const { minSize } = resolveExiOptions(values);

  const [probe, setProbe] = useState<ProbeState | null>(null);
  /** null = every visible image selected (the serialized "" default). */
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null);
  /** Object URLs currently owned by probe state (revoked on replace). */
  const stateUrlsRef = useRef<string[]>([]);

  /* ---------------- probe (read-only, unlock-pdf pattern) ---------------- */

  useEffect(() => {
    if (!file) return;
    let cancelled = false;

    void (async () => {
      // Reset first (microtask — never synchronously in the effect body).
      await Promise.resolve();
      if (cancelled) return;
      for (const url of stateUrlsRef.current) URL.revokeObjectURL(url);
      stateUrlsRef.current = [];
      setProbe({ file, status: "working", images: [], truncated: false, pageCount: 0 });
      setSelection(null);

      const pdfjs = await loadPdfjs();
      const data = new Uint8Array(await file.arrayBuffer());
      const doc = await pdfjs.getDocument({ data, ...PDF_DOC_PARAMS }).promise;
      if (cancelled) {
        void doc.destroy().catch(() => undefined);
        return;
      }
      const createdLocal: string[] = [];
      let pageCount = doc.numPages;
      const touch = (page: number): void => {
        pageCount = Math.max(pageCount, page);
      };
      const stats = await collectImages(pdfjs, doc, 0, {
        maxPages: PROBE_MAX_PAGES,
        maxImages: PROBE_MAX_IMAGES,
        shouldStop: () => cancelled,
        onPage: touch,
        onImage: async (image) => {
          const url = await makeThumbUrl(image);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          createdLocal.push(url);
          setProbe((prev) =>
            prev !== null && prev.file === file
              ? {
                  ...prev,
                  images: [
                    ...prev.images,
                    { key: image.key, page: image.page, w: image.width, h: image.height, url },
                  ],
                }
              : prev
          );
        },
      });
      await doc.destroy().catch(() => undefined);
      if (cancelled) {
        for (const url of createdLocal) URL.revokeObjectURL(url);
        return;
      }
      stateUrlsRef.current = createdLocal;
      setProbe((prev) =>
        prev !== null && prev.file === file
          ? {
              ...prev,
              status: stats.accepted === 0 ? "none" : "done",
              truncated: stats.truncated,
              pageCount,
            }
          : prev
      );
    })().catch(() => {
      if (cancelled) return;
      setProbe((prev) =>
        prev !== null && prev.file === file
          ? { ...prev, status: "error" }
          : prev
      );
    });

    return () => {
      cancelled = true;
    };
  }, [file]);

  // Revoke the state-owned URLs on unmount.
  useEffect(() => {
    return () => {
      for (const url of stateUrlsRef.current) URL.revokeObjectURL(url);
      stateUrlsRef.current = [];
    };
  }, []);

  const activeProbe = probe !== null && probe.file === file ? probe : null;
  const probeStatus: ProbeStatus | "none-yet" = activeProbe?.status ?? "none-yet";

  /* ---------------- visible grid + selection ---------------- */

  const visibleImages = useMemo(
    () =>
      (activeProbe?.images ?? []).filter((image) =>
        passesMinSize(image.w, image.h, minSize)
      ),
    [activeProbe, minSize]
  );
  const visibleKeys = useMemo(
    () => new Set(visibleImages.map((image) => image.key)),
    [visibleImages]
  );

  // A materialized selection only ever shrinks to the visible set (the
  // minSize filter may hide previously selected images).
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setSelection((prev) => {
        if (prev === null) return null;
        let changed = false;
        const next = new Set<string>();
        for (const key of prev) {
          if (visibleKeys.has(key)) next.add(key);
          else changed = true;
        }
        return changed ? next : prev;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [visibleKeys]);

  // Serialize the selection into the option the worker reads.
  useEffect(() => {
    onChange(
      EXI_IDS.selected,
      selection === null ? "" : serializeSelectedSet(selection)
    );
  }, [selection, onChange]);

  const selectedCount =
    selection === null ? visibleImages.length : selection.size;

  const blockedKey =
    probeStatus === "done" &&
    (visibleImages.length === 0 || selectedCount === 0)
      ? "exi.ctaNothingSelected"
      : null;
  useEffect(() => {
    setRunBlocked(blockedKey);
    return () => setRunBlocked(null);
  }, [blockedKey, setRunBlocked]);

  const toggleImage = useCallback(
    (key: string): void => {
      setSelection((prev) => {
        if (prev === null) {
          // Materialize "all selected" minus this one.
          const next = new Set(visibleKeys);
          next.delete(key);
          return next;
        }
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        // Back to the "" default when everything is on again.
        if (next.size === visibleKeys.size) return null;
        return next;
      });
    },
    [visibleKeys]
  );

  const selectAll = useCallback((): void => setSelection(null), []);
  const selectNone = useCallback((): void => {
    setSelection(new Set<string>());
  }, []);

  const removeFirst = useCallback((): void => {
    setFileOrder(files.slice(1));
  }, [files, setFileOrder]);

  const removeFile = useCallback(
    (id: string): void => {
      setFileOrder(files.filter((item) => item.id !== id));
    },
    [files, setFileOrder]
  );

  if (!file) return null;

  return (
    <section
      aria-label={t("exi.surfaceLabel")}
      className="flex flex-col gap-3"
    >
      {/* File header (page count arrives from the probe) */}
      <PreviewFileHeader
        file={file}
        pageCount={activeProbe?.pageCount ?? 0}
        onRemove={removeFirst}
      />

      {/* Other files as chips (the grid previews the first file only) */}
      {files.length > 1 ? (
        <ul className="flex flex-wrap gap-2" aria-label={t("exi.otherFiles")}>
          {files.slice(1).map((item) => (
            <li key={item.id}>
              <span className="flex max-w-[240px] items-center gap-1.5 rounded-chip border border-border bg-card px-2.5 py-1 text-xs text-foreground">
                <span className="truncate" title={item.file.name}>
                  {item.file.name}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {formatBytes(item.file.size)}
                </span>
                <button
                  type="button"
                  onClick={() => removeFile(item.id)}
                  aria-label={t("tool.removeFileLabel", { name: item.file.name })}
                  className="flex size-8 shrink-0 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Probe note (aria-live: the grid appears progressively) */}
      <div aria-live="polite">
        {probeStatus === "working" ? (
          <p
            role="status"
            className="flex items-center gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground"
          >
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            {t("exi.reading")}
          </p>
        ) : probeStatus === "none" ? (
          <p className="flex items-start gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
            <ImageOff className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t("exi.probeNone")}
          </p>
        ) : probeStatus === "error" ? (
          <p className="flex items-start gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t("exi.probeError")}
          </p>
        ) : null}
      </div>

      {/* Grid toolbar: minSize (writes the real option) + selection */}
      {visibleImages.length > 0 ? (
        <div className="flex flex-col gap-3 rounded-card border border-border bg-card p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-chip bg-cat-organize/10 px-2.5 py-1 text-[11px] font-semibold text-cat-organize">
              <Images className="size-3.5" aria-hidden="true" />
              {t("exi.selectedCount", {
                selected: selectedCount,
                total: visibleImages.length,
              })}
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                className="h-11 min-h-11 rounded-btn px-2.5 text-xs font-medium"
                onClick={selectAll}
                disabled={selectedCount === visibleImages.length}
                aria-label={t("exi.selectAll")}
              >
                <CheckCheck className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">{t("exi.selectAll")}</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-11 min-h-11 rounded-btn px-2.5 text-xs font-medium"
                onClick={selectNone}
                disabled={selectedCount === 0}
                aria-label={t("exi.selectNone")}
              >
                <SquareX className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">{t("exi.selectNone")}</span>
              </Button>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              id="exi-min-size-label"
              className="text-xs font-medium text-foreground"
            >
              {t("exi.minSizeLabel")}
            </span>
            <ToggleGroup
              type="single"
              value={String(minSize)}
              onValueChange={(next) => {
                if (next !== "") onChange(EXI_IDS.minSize, next);
              }}
              aria-labelledby="exi-min-size-label"
              className="gap-1"
            >
              {MIN_SIZE_VALUES.map((value) => (
                <ToggleGroupItem
                  key={value}
                  value={String(value)}
                  aria-label={t(MIN_SIZE_LABEL_KEYS[value] ?? "exi.minAll")}
                  className="min-h-9 rounded-btn px-2.5 text-xs"
                >
                  {t(MIN_SIZE_LABEL_KEYS[value] ?? "exi.minAll")}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("exi.minSizeHint")}
          </p>
        </div>
      ) : null}

      {/* The grid */}
      {visibleImages.length > 0 ? (
        <ul
          className="grid list-none grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
          aria-label={t("exi.gridLabel")}
        >
          {visibleImages.map((image, index) => (
            <ImageCard
              key={image.key}
              image={image}
              index={index}
              total={visibleImages.length}
              checked={selection === null || selection.has(image.key)}
              onToggle={() => toggleImage(image.key)}
            />
          ))}
        </ul>
      ) : null}

      {/* Honest truncation note */}
      {activeProbe?.truncated ? (
        <p className="text-xs text-muted-foreground">
          {t("exi.moreNotShown", { count: PROBE_MAX_IMAGES })}
        </p>
      ) : null}
      {files.length > 1 ? (
        <p className="text-xs text-muted-foreground">
          {t("exi.otherFilesNote", { count: files.length })}
        </p>
      ) : null}

      {/* Add more (compact) — same shell pipeline as the landing drop */}
      <DropZone
        labelKey="tool.addMoreFiles"
        multiple
        maxFiles={5}
        acceptKind="pdf"
        onAccept={addFiles}
        currentCount={files.length}
        className="py-2"
      />
    </section>
  );
}

export default ExtractImagesSurface;

/* ------------------------------ card ------------------------------ */

function ImageCard({
  image,
  index,
  total,
  checked,
  onToggle,
}: {
  image: ProbeImage;
  index: number;
  total: number;
  checked: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <li className="list-none">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={onToggle}
        aria-label={t("exi.toggleLabel", {
          index: index + 1,
          page: image.page,
          w: image.w,
          h: image.h,
        })}
        className={cn(
          "group relative block aspect-square w-full overflow-hidden rounded-card border bg-card outline-none transition-all duration-200",
          "focus-visible:ring-[3px] focus-visible:ring-ring/50",
          checked
            ? "border-primary/50"
            : "border-border opacity-60 hover:opacity-100 hover:border-primary/30"
        )}
      >
        <img
          src={image.url}
          alt={t("exi.thumbAlt", { page: image.page })}
          loading="lazy"
          decoding="async"
          className="size-full bg-muted/30 object-contain p-1"
        />
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-1.5 top-1.5 flex size-6 items-center justify-center rounded-btn border shadow-sm backdrop-blur transition-colors",
            checked
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background/85 text-transparent"
          )}
        >
          <Check className="size-3.5" aria-hidden="true" />
        </span>
        <span
          aria-hidden="true"
          className="absolute bottom-1.5 right-1.5 rounded-chip bg-background/85 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-foreground shadow-sm backdrop-blur"
        >
          {t("exi.chip", { page: image.page, w: image.w, h: image.h })}
        </span>
        <span className="sr-only">
          {t("exi.cardPosition", { index: index + 1, total })}
        </span>
      </button>
    </li>
  );
}
