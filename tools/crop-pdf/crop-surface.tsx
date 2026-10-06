"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Crop as CropIcon,
  Loader2,
  ScanSearch,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import {
  getPdfPageCount,
  getPdfPagePixelSize,
  renderPdfThumbnail,
} from "@/lib/pdf/thumbnails";
import { cn } from "@/lib/utils";
import {
  PreviewFileHeader,
  PreviewPageStrip,
  PreviewZoomControl,
} from "../stamp-common/preview-parts";
import {
  CROP_IDS,
  type CropOptions,
  MIN_CROP_PT,
  clampedRectYDown,
  cropIsNoOp,
  cropTargets,
  formatPtInUnit,
  resolveCropOptions,
} from "./crop-options";

/**
 * Crop PDF live surface (PRD §8.2 "Crop": "Visual crop box drag; margins
 * numeric; apply to all / selected; auto-detect margins; shows
 * before/after"). Renders the page with pdf.js (rotation applied) and lets
 * the user drag an 8-handle crop box on top — the exact margins the worker
 * will set, thanks to the shared display-space geometry in crop-options.
 */

const PREVIEW_MAX_DIM = 560;
const ZOOM_STEPS = [1, 1.5, 2] as const;
/** Small breathing room auto-detect leaves around found content (pt). */
const AUTO_PAD_PT = 6;

type DragMode = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

interface BasePreview {
  file: File;
  pageIndex: number;
  bitmap: ImageBitmap;
  /** Display-space page dims in points (pdf.js scale 1, rotation applied). */
  dispW: number;
  dispH: number;
}

/** Drag rect in display points, y down (x1 > x0, y1 > y0). */
interface LiveRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface DragState {
  mode: DragMode;
  rect: LiveRect;
  /** Pointer offset inside the rect when a "move" drag starts (pt). */
  grabX: number;
  grabY: number;
}

/**
 * The 8 resize handles (corners + edges). Pointer-only (mouse/touch) — the
 * rect itself is keyboard-nudgeable and the panel inputs are the precise
 * keyboard path, so handles can stay aria-hidden.
 */
const HANDLES: { mode: DragMode; x: number; y: number; cursor: string }[] = [
  { mode: "nw", x: 0, y: 0, cursor: "nwse-resize" },
  { mode: "n", x: 50, y: 0, cursor: "ns-resize" },
  { mode: "ne", x: 100, y: 0, cursor: "nesw-resize" },
  { mode: "e", x: 100, y: 50, cursor: "ew-resize" },
  { mode: "se", x: 100, y: 100, cursor: "nwse-resize" },
  { mode: "s", x: 50, y: 100, cursor: "ns-resize" },
  { mode: "sw", x: 0, y: 100, cursor: "nesw-resize" },
  { mode: "w", x: 0, y: 50, cursor: "ew-resize" },
];

function clampN(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Margins → the clamped live rect the overlay shows (display points). */
function rectFromCrop(
  crop: CropOptions,
  base: BasePreview
): LiveRect {
  const r = clampedRectYDown(crop, base.dispW, base.dispH, MIN_CROP_PT);
  return { x0: r.left, y0: r.top, x1: r.left + r.width, y1: r.top + r.height };
}

/** Bitmap-pixel source rect of the cropped region (for the "after" render). */
function afterSrcRect(
  base: BasePreview,
  crop: CropOptions
): { x: number; y: number; w: number; h: number } {
  const r = clampedRectYDown(crop, base.dispW, base.dispH, MIN_CROP_PT);
  const pxPerPt = base.bitmap.width / base.dispW;
  return {
    x: r.left * pxPerPt,
    y: r.top * pxPerPt,
    w: Math.max(1, r.width * pxPerPt),
    h: Math.max(1, r.height * pxPerPt),
  };
}

export function CropSurface({
  files,
  values,
  onChange,
  setFileOrder,
  setRunBlocked,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const file = files.length > 0 ? files[0].file : null;
  const fileMeta = files[0];

  const crop = useMemo(() => resolveCropOptions(values), [values]);
  const [pageCount, setPageCount] = useState(0);
  const [selectedPage, setSelectedPage] = useState(0);
  const [base, setBase] = useState<BasePreview | null>(null);
  const [failure, setFailure] = useState<{ file: File; pageIndex: number } | null>(
    null
  );
  const [zoom, setZoom] = useState<(typeof ZOOM_STEPS)[number]>(1);
  const [view, setView] = useState<"before" | "after">("before");
  const [drag, setDrag] = useState<DragState | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoFlash, setAutoFlash] = useState<"done" | "empty" | null>(null);
  /** Measured canvas CSS box (px, relative to the wrapper) — the overlay
   *  tracks this instead of the wrapper so max-height clamping (tall pages
   *  on short viewports) never misaligns the crop box. */
  const [canvasBox, setCanvasBox] = useState<{
    left: number;
    top: number;
    w: number;
    h: number;
  } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const flashTimer = useRef<number | null>(null);

  const targets = useMemo(
    () => (pageCount > 0 ? cropTargets(crop, pageCount) : []),
    [crop, pageCount]
  );
  const targetSet = useMemo(() => new Set(targets ?? []), [targets]);

  // Page count for the selected file.
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      const count = await getPdfPageCount(file);
      if (cancelled) return;
      setPageCount(count);
      setSelectedPage((page) => Math.min(page, Math.max(0, count - 1)));
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [file]);

  // Base render for the selected page (pdf.js via the shared queue) at the
  // page's DISPLAYED orientation — the crop box lives in that space.
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
      // A new page/file cancels any in-flight drag.
      setDrag(null);
      setBase({ file, pageIndex: selectedPage, bitmap, dispW: pixel.width, dispH: pixel.height });
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

  // CTA gating (amber reason in the sticky bar).
  const blockedKey =
    targets === null
      ? "wm.rangeInvalid"
      : targets.length === 0
        ? "crop.ctaNoPages"
        : cropIsNoOp(crop)
          ? "crop.ctaNoCrop"
          : null;
  useEffect(() => {
    setRunBlocked(blockedKey);
  }, [blockedKey, setRunBlocked]);

  // THE painter — "before" draws the full page, "after" draws exactly the
  // cropped region (what the output page will look like). After painting it
  // measures the canvas's rendered box (rAF, post-layout) so the overlay
  // can track it precisely.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !base) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (view === "after") {
      const src = afterSrcRect(base, crop);
      canvas.width = Math.max(1, Math.round(src.w));
      canvas.height = Math.max(1, Math.round(src.h));
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(base.bitmap, src.x, src.y, src.w, src.h, 0, 0, src.w, src.h);
    } else {
      canvas.width = base.bitmap.width;
      canvas.height = base.bitmap.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(base.bitmap, 0, 0);
    }
    const raf = requestAnimationFrame(() => {
      const el = canvasRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      const parent = el.parentElement;
      const pr = parent
        ? parent.getBoundingClientRect()
        : { left: r.left, top: r.top };
      setCanvasBox({
        left: r.left - pr.left,
        top: r.top - pr.top,
        w: r.width,
        h: r.height,
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [base, view, crop]);

  // Transient auto-detect feedback chip (cleared on unmount).
  useEffect(() => {
    return () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    };
  }, []);

  const flash = useCallback((kind: "done" | "empty"): void => {
    setAutoFlash(kind);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setAutoFlash(null), 2600);
  }, []);

  const removeFile = useCallback((): void => {
    setFileOrder([]);
  }, [setFileOrder]);

  // --- Drag machinery -------------------------------------------------
  const beginDrag = (mode: DragMode) => {
    return (event: React.PointerEvent<HTMLDivElement>): void => {
      if (!base || view !== "before" || event.button !== 0) return;
      const overlay = overlayRef.current;
      if (!overlay) return;
      const box = overlay.getBoundingClientRect();
      const px = ((event.clientX - box.left) / box.width) * base.dispW;
      const py = ((event.clientY - box.top) / box.height) * base.dispH;
      const start = rectFromCrop(crop, base);
      try {
        overlay.setPointerCapture(event.pointerId);
      } catch {
        // Some pointer ids can't be captured (synthetic events, exotic
        // browsers) — the overlay-level move/up handlers still drive the
        // drag as long as the pointer stays over the canvas.
      }
      setDrag({ mode, rect: start, grabX: px - start.x0, grabY: py - start.y0 });
      event.preventDefault();
    };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!drag || !base || !overlayRef.current) return;
    const box = overlayRef.current.getBoundingClientRect();
    const px = clampN(((event.clientX - box.left) / box.width) * base.dispW, 0, base.dispW);
    const py = clampN(((event.clientY - box.top) / box.height) * base.dispH, 0, base.dispH);
    const min = MIN_CROP_PT;
    let { x0, y0, x1, y1 } = drag.rect;
    switch (drag.mode) {
      case "move": {
        const w = x1 - x0;
        const h = y1 - y0;
        x0 = clampN(px - drag.grabX, 0, base.dispW - w);
        y0 = clampN(py - drag.grabY, 0, base.dispH - h);
        x1 = x0 + w;
        y1 = y0 + h;
        break;
      }
      case "nw":
        x0 = clampN(px, 0, x1 - min);
        y0 = clampN(py, 0, y1 - min);
        break;
      case "n":
        y0 = clampN(py, 0, y1 - min);
        break;
      case "ne":
        x1 = clampN(px, x0 + min, base.dispW);
        y0 = clampN(py, 0, y1 - min);
        break;
      case "e":
        x1 = clampN(px, x0 + min, base.dispW);
        break;
      case "se":
        x1 = clampN(px, x0 + min, base.dispW);
        y1 = clampN(py, y0 + min, base.dispH);
        break;
      case "s":
        y1 = clampN(py, y0 + min, base.dispH);
        break;
      case "sw":
        x0 = clampN(px, 0, x1 - min);
        y1 = clampN(py, y0 + min, base.dispH);
        break;
      case "w":
        x0 = clampN(px, 0, x1 - min);
        break;
    }
    setDrag({ ...drag, rect: { x0, y0, x1, y1 } });
  };

  const commitDrag = useCallback((): void => {
    if (!drag || !base) return;
    const { x0, y0, x1, y1 } = drag.rect;
    onChange(CROP_IDS.left, round1(x0));
    onChange(CROP_IDS.top, round1(y0));
    onChange(CROP_IDS.right, round1(base.dispW - x1));
    onChange(CROP_IDS.bottom, round1(base.dispH - y1));
    setDrag(null);
  }, [base, drag, onChange]);

  const cancelDrag = useCallback((): void => {
    setDrag(null);
  }, []);

  // Keyboard nudge: arrows move the box 1 pt (Shift = 10 pt).
  const handleRectKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!base) return;
    const step = event.shiftKey ? 10 : 1;
    let dx = 0;
    let dy = 0;
    switch (event.key) {
      case "ArrowLeft":
        dx = -step;
        break;
      case "ArrowRight":
        dx = step;
        break;
      case "ArrowUp":
        dy = -step;
        break;
      case "ArrowDown":
        dy = step;
        break;
      default:
        return;
    }
    event.preventDefault();
    const r = rectFromCrop(crop, base);
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    const x0 = clampN(r.x0 + dx, 0, base.dispW - w);
    const y0 = clampN(r.y0 + dy, 0, base.dispH - h);
    onChange(CROP_IDS.left, round1(x0));
    onChange(CROP_IDS.top, round1(y0));
    onChange(CROP_IDS.right, round1(base.dispW - (x0 + w)));
    onChange(CROP_IDS.bottom, round1(base.dispH - (y0 + h)));
  };

  // --- Auto-detect margins --------------------------------------------
  const runAutoDetect = (): void => {
    if (!base || autoBusy) return;
    setAutoBusy(true);
    void (async () => {
      // Let the busy spinner paint before the synchronous pixel scan.
      await new Promise((resolve) => setTimeout(resolve, 30));
      try {
        const scan = document.createElement("canvas");
        scan.width = base.bitmap.width;
        scan.height = base.bitmap.height;
        const sctx = scan.getContext("2d", { willReadFrequently: true });
        if (!sctx) return;
        sctx.drawImage(base.bitmap, 0, 0);
        const img = sctx.getImageData(0, 0, scan.width, scan.height);
        const { data, width, height } = img;
        let minX = 0;
        let minY = 0;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const i = (y * width + x) * 4;
            const alpha = data[i + 3];
            // Ink = visibly non-white OR not fully opaque (soft edges,
            // transparent regions where the page shows through).
            const ink =
              (alpha < 250 && alpha > 8) ||
              (alpha >= 250 &&
                (data[i] < 246 || data[i + 1] < 246 || data[i + 2] < 246));
            if (!ink) continue;
            if (maxX < 0) {
              minX = x;
              minY = y;
              maxX = x;
              maxY = y;
            } else {
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0) {
          flash("empty");
          return;
        }
        const pxPerPt = width / base.dispW;
        onChange(CROP_IDS.left, Math.max(0, round1(minX / pxPerPt - AUTO_PAD_PT)));
        onChange(CROP_IDS.top, Math.max(0, round1(minY / pxPerPt - AUTO_PAD_PT)));
        onChange(
          CROP_IDS.right,
          Math.max(0, round1(base.dispW - (maxX + 1) / pxPerPt - AUTO_PAD_PT))
        );
        onChange(
          CROP_IDS.bottom,
          Math.max(0, round1(base.dispH - (maxY + 1) / pxPerPt - AUTO_PAD_PT))
        );
        flash("done");
      } finally {
        setAutoBusy(false);
      }
    })();
  };

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

  // The overlay rect (percent-positioned so zoom never breaks it).
  const live = drag !== null && current !== null ? drag.rect : null;
  const overlayRect = current
    ? (live ?? rectFromCrop(crop, current))
    : null;

  const afterPx =
    current !== null && view === "after" ? afterSrcRect(current, crop) : null;
  const canvasW = afterPx ? afterPx.w : (current?.bitmap.width ?? 0);
  const croppedSize =
    current !== null
      ? clampedRectYDown(crop, current.dispW, current.dispH, MIN_CROP_PT)
      : null;

  return (
    <div className="flex flex-col gap-4">
      <PreviewFileHeader
        file={file}
        pageCount={pageCount}
        onRemove={removeFile}
      />

      {/* Live preview card */}
      <div className="overflow-hidden rounded-card border border-border bg-card">
        <div className="flex flex-col gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <CropIcon className="size-3.5 text-primary" aria-hidden="true" />
              {t("crop.previewTitle")}
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Auto-detect: snap the box to the page's content. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 rounded-btn px-2 text-[11px]"
                onClick={runAutoDetect}
                disabled={current === null || autoBusy}
                aria-label={t("crop.autoDetect")}
              >
                {autoBusy ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <ScanSearch className="size-3.5" aria-hidden="true" />
                )}
                {t("crop.autoDetect")}
              </Button>
              {/* Before / after — PRD §8.2 "shows before/after". */}
              <div
                role="group"
                aria-label={t("crop.beforeAfterLabel")}
                className="flex items-center gap-0.5 rounded-btn border border-border bg-background p-0.5"
              >
                {(["before", "after"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setView(mode)}
                    aria-pressed={view === mode}
                    className={cn(
                      "min-h-6 rounded-md px-2 text-[10px] font-semibold transition-colors",
                      view === mode
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {t(mode === "before" ? "crop.before" : "crop.after")}
                  </button>
                ))}
              </div>
              <PreviewZoomControl
                steps={ZOOM_STEPS}
                value={zoom}
                onChange={setZoom}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {autoFlash !== null ? (
              <span
                className={cn(
                  "flex items-center gap-1 rounded-chip px-2 py-0.5 text-[10px] font-semibold",
                  autoFlash === "done"
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                    : "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                )}
              >
                {autoFlash === "done" ? (
                  t("crop.autoDone", { page: selectedPage + 1 })
                ) : (
                  <>
                    <TriangleAlert className="size-3" aria-hidden="true" />
                    {t("crop.autoEmpty")}
                  </>
                )}
              </span>
            ) : null}
            {invalidRange ? (
              <span className="flex items-center gap-1 rounded-chip bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                <TriangleAlert className="size-3" aria-hidden="true" />
                {t("wm.rangeInvalid")}
              </span>
            ) : (
              <>
                {croppedSize !== null ? (
                  <span className="rounded-chip bg-primary/10 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-primary">
                    {t("crop.chipSize", {
                      w: formatPtInUnit(croppedSize.width, crop.unit),
                      h: formatPtInUnit(croppedSize.height, crop.unit),
                      unit: crop.unit,
                    })}
                  </span>
                ) : null}
                <span className="rounded-chip bg-primary/10 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-primary">
                  {t("wm.markedCount", {
                    count: targets?.length ?? 0,
                    pages: pageCount,
                  })}
                </span>
              </>
            )}
          </div>
        </div>

        <div
          className={cn(
            "relative flex max-w-full justify-center bg-muted/30 px-4 py-5",
            zoom > 1
              ? "overflow-x-auto overflow-y-hidden scrollbar-thin"
              : "items-center overflow-hidden"
          )}
        >
          {failed ? (
            <div className="flex items-start gap-2.5 px-3 py-6 text-xs leading-relaxed text-muted-foreground">
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0 text-amber-500"
                aria-hidden="true"
              />
              {t("wm.previewFailed")}
            </div>
          ) : current ? (
            <div
              className={cn(
                "relative inline-block max-w-full",
                zoom > 1 && "max-w-none shrink-0"
              )}
            >
              <canvas
                ref={canvasRef}
                style={
                  zoom > 1
                    ? { width: `${Math.round(canvasW * zoom)}px` }
                    : undefined
                }
                className={cn(
                  "block h-auto w-auto max-h-[62vh] max-w-full rounded-md border border-border/60 shadow-sm",
                  view === "after"
                    ? "bg-background ring-1 ring-emerald-300/70 dark:ring-emerald-500/40"
                    : ""
                )}
                aria-label={t("crop.previewTitle")}
                role="img"
              />
              {view === "before" && overlayRect !== null && canvasBox !== null ? (
                <div
                  ref={overlayRef}
                  className="absolute select-none"
                  style={{
                    left: `${canvasBox.left}px`,
                    top: `${canvasBox.top}px`,
                    width: `${canvasBox.w}px`,
                    height: `${canvasBox.h}px`,
                    touchAction: "none",
                  }}
                  onPointerMove={handlePointerMove}
                  onPointerUp={commitDrag}
                  onPointerCancel={cancelDrag}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && drag !== null) {
                      event.preventDefault();
                      cancelDrag();
                    }
                  }}
                >
                  {/* The crop box: dims everything outside, thirds inside. */}
                  <div
                    role="group"
                    tabIndex={0}
                    aria-label={t("crop.rectLabel")}
                    aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
                    onKeyDown={handleRectKeyDown}
                    onPointerDown={beginDrag("move")}
                    className="absolute cursor-move outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
                    style={{
                      left: `${(overlayRect.x0 / current.dispW) * 100}%`,
                      top: `${(overlayRect.y0 / current.dispH) * 100}%`,
                      width: `${((overlayRect.x1 - overlayRect.x0) / current.dispW) * 100}%`,
                      height: `${((overlayRect.y1 - overlayRect.y0) / current.dispH) * 100}%`,
                      boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.45)",
                      border: "1.5px solid var(--primary)",
                    }}
                  >
                    {/* Rule-of-thirds guides. */}
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-white/30"
                    />
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-y-0 left-2/3 w-px bg-white/30"
                    />
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-white/30"
                    />
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-white/30"
                    />
                    <span className="sr-only">{t("crop.rectHint")}</span>
                    {/* Live size label while dragging. */}
                    {drag !== null ? (
                      <span className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-chip bg-primary px-2 py-0.5 text-[10px] font-semibold tabular-nums text-primary-foreground shadow-sm">
                        {formatPtInUnit(overlayRect.x1 - overlayRect.x0, crop.unit)}{" "}
                        ×{" "}
                        {formatPtInUnit(overlayRect.y1 - overlayRect.y0, crop.unit)}{" "}
                        {crop.unit}
                      </span>
                    ) : null}
                    {/* 8 resize handles (pointer; the panel inputs are the
                        keyboard-precise path). */}
                    {HANDLES.map((handle) => (
                      <div
                        key={handle.mode}
                        aria-hidden="true"
                        onPointerDown={beginDrag(handle.mode)}
                        className="absolute flex size-7 items-center justify-center"
                        style={{
                          left: `${handle.x}%`,
                          top: `${handle.y}%`,
                          transform: "translate(-50%, -50%)",
                          cursor: handle.cursor,
                          touchAction: "none",
                        }}
                      >
                        <span className="pointer-events-none size-3 rounded-[3px] border-2 border-primary bg-background shadow-sm" />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex h-72 w-52 items-center justify-center rounded-md border border-dashed border-border">
              <Loader2
                className="size-5 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
            </div>
          )}
        </div>

        <p className="border-t border-border/60 px-4 py-2 text-[10px] text-muted-foreground">
          {view === "after" ? t("crop.afterNote") : t("crop.previewNote")}
        </p>
      </div>

      {/* Page strip */}
      <PreviewPageStrip
        file={file}
        pageCount={pageCount}
        selected={selectedPage}
        onSelect={setSelectedPage}
        markedSet={targetSet}
      />
    </div>
  );
}
