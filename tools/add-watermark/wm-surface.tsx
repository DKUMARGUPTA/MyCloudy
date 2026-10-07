"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  ScanSearch,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { formatBytes } from "@/lib/storage/recent-files";
import {
  getPdfPagePixelSize,
  renderPdfThumbnail,
} from "@/lib/pdf/thumbnails";
import { cn } from "@/lib/utils";
import {
  positionCenter,
  resolveWmOptions,
  rotatedStartPoint,
  targetIndices,
  tileSteps,
  wmCssFontFor,
} from "./wm-options";
import { getLogoFile, subscribeToLogo } from "./logo-store";

/**
 * Watermark preview surface (PRD §8.2 "Preview: live canvas preview on the
 * selected sample page; thumbnails strip"): renders the chosen page with
 * pdf.js, then paints the watermark on a canvas with EXACTLY the placement
 * math the worker uses — what you see is what the PDF gets. The strip
 * below picks the preview page; marked pages carry a small dot.
 */

const STRIP_MAX = 12;
const PREVIEW_MAX_DIM = 560;

interface BasePreview {
  file: File;
  pageIndex: number;
  bitmap: ImageBitmap;
  pdfW: number;
  pdfH: number;
}

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

export function WatermarkSurface({
  files,
  values,
  setFileOrder,
  setRunBlocked,
}: ToolSurfaceProps) {
  const { t } = useI18n();
  const file = files.length > 0 ? files[0].file : null;
  const fileMeta = files[0];

  const wm = useMemo(() => resolveWmOptions(values), [values]);
  const [pageCount, setPageCount] = useState(0);
  const [selectedPage, setSelectedPage] = useState(0);
  const [base, setBase] = useState<BasePreview | null>(null);
  const [failure, setFailure] = useState<{ file: File; pageIndex: number } | null>(
    null
  );
  const [logoBitmap, setLogoBitmap] = useState<ImageBitmap | null>(null);
  const [stripUrls, setStripUrls] = useState<{ page: number; url: string }[]>(
    []
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stripUrlsRef = useRef<{ page: number; url: string }[]>([]);

  const targets = useMemo(
    () => (pageCount > 0 ? targetIndices(wm, pageCount) : []),
    [wm, pageCount]
  );
  const markedSet = useMemo(() => new Set(targets ?? []), [targets]);

  // Page count for the selected file (reset the preview when it changes).
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      const { getPdfPageCount } = await import("@/lib/pdf/thumbnails");
      const count = await getPdfPageCount(file);
      if (cancelled) return;
      setPageCount(count);
      setSelectedPage((page) => Math.min(page, Math.max(0, count - 1)));
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [file]);

  // Base render for the selected page (pdf.js via the shared queue).
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      const [thumb, pixel] = await Promise.all([
        renderPdfThumbnail(file, {
          pageIndex: selectedPage,
          maxDim: PREVIEW_MAX_DIM,
        }),
        getPdfPagePixelSize(file, 1, selectedPage),
      ]);
      if (cancelled) return;
      const bitmap = await createImageBitmap(thumb.blob);
      if (cancelled) return;
      setFailure(null);
      setBase({ file, pageIndex: selectedPage, bitmap, pdfW: pixel.width, pdfH: pixel.height });
    })().catch(() => {
      if (!cancelled) {
        setFailure({ file, pageIndex: selectedPage });
        setBase(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [file, selectedPage]);

  // Logo sync: the panel pushes into the store; the surface mirrors it for
  // the preview + CTA gating. The listener callback is event context.
  useEffect(() => {
    return subscribeToLogo(() => {
      const logo = getLogoFile();
      if (logo) {
        void createImageBitmap(logo)
          .then((bitmap) => setLogoBitmap(bitmap))
          .catch(() => setLogoBitmap(null));
      } else {
        setLogoBitmap(null);
      }
    });
  }, []);
  useEffect(() => {
    const logo = getLogoFile();
    if (!logo) return;
    let cancelled = false;
    void createImageBitmap(logo)
      .then((bitmap) => {
        if (!cancelled) setLogoBitmap(bitmap);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Thumbnails strip for the visible window.
  useEffect(() => {
    if (!file || pageCount === 0) return;
    let cancelled = false;
    const indices = stripWindow(selectedPage, pageCount);
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
  }, [file, pageCount, selectedPage]);

  // Revoke strip URLs on unmount.
  useEffect(() => {
    return () => {
      for (const old of stripUrlsRef.current) URL.revokeObjectURL(old.url);
    };
  }, []);

  // CTA gating (amber reason in the sticky bar): no text / no logo /
  // an invalid page range (the worker would reject it anyway).
  const blockedKey =
    wm.type === "text"
      ? wm.text.trim().length === 0
        ? "wm.ctaNoText"
        : null
      : logoBitmap === null
        ? "wm.ctaNoLogo"
        : null;
  const gatedKey =
    blockedKey ?? (targets === null ? "wm.rangeInvalid" : null);
  useEffect(() => {
    setRunBlocked(gatedKey);
  }, [gatedKey, setRunBlocked]);

  // THE overlay painter — same math as the worker.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !base) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = base.bitmap.width;
    const h = base.bitmap.height;
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(base.bitmap, 0, 0);

    const s = w / base.pdfW; // px per PDF point
    const pageW = base.pdfW;
    const pageH = base.pdfH;
    const rad = (wm.rotation * Math.PI) / 180;

    ctx.globalAlpha = wm.opacity;
    ctx.fillStyle = wm.color;

    const drawTextMark = (cx: number, cy: number): void => {
      // cy is PDF coords (y UP); canvas is y DOWN.
      ctx.save();
      ctx.translate(cx * s, (pageH - cy) * s);
      ctx.rotate(-rad);
      ctx.font = wmCssFontFor(wm.text.trim(), wm.font, wm.size * s);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(wm.text.trim(), 0, 0);
      ctx.restore();
    };

    const drawImageMark = (cx: number, cy: number, bw: number, bh: number): void => {
      if (!logoBitmap) return;
      ctx.save();
      ctx.translate(cx * s, (pageH - cy) * s);
      ctx.rotate(-rad);
      ctx.drawImage(logoBitmap, (-bw / 2) * s, (-bh / 2) * s, bw * s, bh * s);
      ctx.restore();
    };

    if (wm.type === "text" && wm.text.trim().length > 0) {
      ctx.font = wmCssFontFor(wm.text.trim(), wm.font, wm.size * s);
      const textW = ctx.measureText(wm.text.trim()).width / s; // PDF units
      const boxH = wm.size;
      if (wm.tile) {
        const { stepX, stepY } = tileSteps(textW, wm.size, wm.tileGap);
        for (let y = -stepY; y < pageH + stepY; y += stepY) {
          for (let x = -stepX; x < pageW + stepX; x += stepX) {
            const { sx, sy } = rotatedStartPoint(
              x + textW / 2,
              y + boxH / 2,
              textW,
              boxH,
              wm.rotation
            );
            drawTextMark(sx, sy);
          }
        }
      } else {
        const { cx, cy } = positionCenter(
          wm.position,
          pageW,
          pageH,
          textW,
          boxH,
          wm.margin
        );
        drawTextMark(cx, cy);
      }
    } else if (wm.type === "image" && logoBitmap) {
      const boxW = (pageW * wm.logoScale) / 100;
      const boxH = boxW * (logoBitmap.height / logoBitmap.width);
      if (wm.tile) {
        const { stepX, stepY } = tileSteps(boxW, boxH, wm.tileGap);
        for (let y = -stepY; y < pageH + stepY; y += stepY) {
          for (let x = -stepX; x < pageW + stepX; x += stepX) {
            drawImageMark(x + boxW / 2, y + boxH / 2, boxW, boxH);
          }
        }
      } else {
        const { cx, cy } = positionCenter(
          wm.position,
          pageW,
          pageH,
          boxW,
          boxH,
          wm.margin
        );
        drawImageMark(cx, cy, boxW, boxH);
      }
    }
  }, [base, wm, logoBitmap]);

  const removeFile = useCallback(() => {
    setFileOrder([]);
  }, [setFileOrder]);

  if (!file || !fileMeta) return null;

  const current =
    base !== null && base.file === file && base.pageIndex === selectedPage
      ? base
      : null;
  const invalidRange = targets === null;
  const failed =
    failure !== null &&
    failure.file === file &&
    failure.pageIndex === selectedPage &&
    current === null;

  return (
    <div className="flex flex-col gap-4">
      {/* File header */}
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
          onClick={removeFile}
          aria-label={t("wm.removeFile")}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {/* Live preview card */}
      <div className="overflow-hidden rounded-card border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <ScanSearch className="size-3.5 text-primary" aria-hidden="true" />
            {t("wm.previewTitle")}
          </p>
          <div className="flex items-center gap-1.5">
            {invalidRange ? (
              <span className="flex items-center gap-1 rounded-chip bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                <TriangleAlert className="size-3" aria-hidden="true" />
                {t("wm.rangeInvalid")}
              </span>
            ) : (
              <span className="rounded-chip bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                {t("wm.markedCount", {
                  count: targets?.length ?? 0,
                  pages: pageCount,
                })}
              </span>
            )}
            <span
              className={cn(
                "rounded-chip px-2 py-0.5 text-[10px] font-semibold",
                wm.behind
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                  : "bg-muted text-muted-foreground"
              )}
            >
              {wm.behind ? t("wm.behindChip") : t("wm.overChip")}
            </span>
          </div>
        </div>

        <div className="relative flex items-center justify-center bg-muted/30 px-4 py-5">
          {failed ? (
            <div className="flex items-start gap-2.5 px-3 py-6 text-xs leading-relaxed text-muted-foreground">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden="true" />
              {t("wm.previewFailed")}
            </div>
          ) : current ? (
            <canvas
              ref={canvasRef}
              className="h-auto max-h-[62vh] w-auto max-w-full rounded-md border border-border/60 shadow-sm"
              aria-label={t("wm.previewTitle")}
              role="img"
            />
          ) : (
            <div className="flex h-72 w-52 items-center justify-center rounded-md border border-dashed border-border">
              <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
            </div>
          )}
        </div>

        <p className="border-t border-border/60 px-4 py-2 text-[10px] text-muted-foreground">
          {t("wm.previewNote")}
        </p>
      </div>

      {/* Page strip */}
      {pageCount > 1 ? (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-9 shrink-0 rounded-btn"
            disabled={selectedPage === 0}
            onClick={() => setSelectedPage((page) => Math.max(0, page - 1))}
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
              const isSelected = item.page === selectedPage;
              const isMarked = markedSet.has(item.page);
              return (
                <button
                  key={item.page}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  aria-label={t("wm.stripPageLabel", { page: item.page + 1 })}
                  onClick={() => setSelectedPage(item.page)}
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
            disabled={selectedPage >= pageCount - 1}
            onClick={() =>
              setSelectedPage((page) => Math.min(pageCount - 1, page + 1))
            }
            aria-label={t("wm.nextPage")}
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
