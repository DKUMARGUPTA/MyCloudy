"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Ruler,
  TriangleAlert,
} from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import { getPdfPageCount, getPdfPagePixelSize, renderPdfThumbnail } from "@/lib/pdf/thumbnails";
import {
  buildSizeInventory,
  pageNeedsChange,
  resizeScale,
  resolvePageSizeOptions,
  sizeLabelPt,
  targetSizePt,
} from "./engine";

/**
 * Change PDF page size — LIVE PREVIEW panel (PRD §8.3 "unify mixed sizes").
 *
 * 1. Scans the document's pages (cap 200) and lists every DISTINCT page
 *    size with counts — the mixed-size overview the run unifies.
 * 2. Draws page 1 on the target paper exactly the way the worker will emit
 *    it: the bitmap placed with the same fit/fill/none scale math, centered,
 *    with a dashed outline of the page's ORIGINAL size for context.
 *
 * Read-only with respect to options: every control is the schema-driven
 * OptionsPanel below this panel — values arrive through ToolPanelProps.
 */

/** Long-side pixel budget of the preview canvas (CSS scales it down). */
const PREVIEW_MAX_PX = 560;
/** Page-size scan cap (viewport-only reads; honest "+N more" beyond). */
const SCAN_CAP = 200;
/** Distinct-size rows shown before the honest "+N more sizes" line. */
const INVENTORY_ROWS = 6;
/** Thumbnail render size for the preview page (pdf.js queue). */
const THUMB_MAX_DIM = 480;
/** Option-change debounce (ms). */
const REBUILD_DEBOUNCE_MS = 150;

/** Dashed outline of the original page size on the new paper. */
const OUTLINE_COLOR = "rgba(125, 125, 135, 0.55)";

interface SizeScan {
  file: File;
  /** Display dims (pt, /Rotate applied) per scanned page. */
  sizes: { w: number; h: number }[];
  pageCount: number;
}

interface PagePreview {
  file: File;
  target: { w: number; h: number };
  display: { w: number; h: number };
  scale: number;
  bitmap: ImageBitmap;
}

export function PageSizePanel({ files, values }: ToolPanelProps) {
  const { t } = useI18n();
  const file = files.length > 0 ? files[0].file : null;

  const opts = useMemo(() => resolvePageSizeOptions(values), [values]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prevPreviewRef = useRef<PagePreview | null>(null);

  const [scan, setScan] = useState<SizeScan | null>(null);
  const [preview, setPreview] = useState<PagePreview | null>(null);
  const [failed, setFailed] = useState(false);

  /* Release the previous preview bitmap the moment a new one replaces it. */
  useEffect(() => {
    const previous = prevPreviewRef.current;
    prevPreviewRef.current = preview;
    if (previous !== null && previous !== preview) {
      previous.bitmap.close();
    }
  }, [preview]);

  /* ---------------- Real scan: every page's display size ---------------- */

  useEffect(() => {
    // No synchronous setState here (react-hooks/set-state-in-effect):
    // stale scan/preview state is invisible without a file (render returns
    // null) and every later read is identity-guarded on `file`.
    if (!file) return;
    let cancelled = false;
    void (async () => {
      try {
        const pageCount = await getPdfPageCount(file);
        if (pageCount < 1) {
          if (!cancelled) setFailed(true);
          return;
        }
        const sizes: { w: number; h: number }[] = [];
        const limit = Math.min(pageCount, SCAN_CAP);
        for (let i = 0; i < limit; i += 1) {
          const size = await getPdfPagePixelSize(file, 1, i);
          sizes.push({ w: size.width, h: size.height });
          if (cancelled) return;
        }
        setScan({ file, sizes, pageCount });
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  /* ---------------- Debounced page-1 preview rebuild ---------------- */

  const display1 =
    scan !== null && scan.file === file && scan.sizes.length > 0
      ? scan.sizes[0]
      : null;

  useEffect(() => {
    if (!file || display1 === null) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        let bitmap: ImageBitmap | null = null;
        try {
          const thumb = await renderPdfThumbnail(file, {
            pageIndex: 0,
            maxDim: THUMB_MAX_DIM,
          });
          if (cancelled) return;
          bitmap = await createImageBitmap(thumb.blob);
          if (cancelled) {
            bitmap.close();
            return;
          }
          setPreview({
            file,
            target: targetSizePt(opts, display1),
            display: display1,
            scale: resizeScale(opts.scale, targetSizePt(opts, display1), display1),
            bitmap,
          });
          setFailed(false);
        } catch {
          bitmap?.close();
          if (!cancelled) setFailed(true);
        }
      })();
    }, REBUILD_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
     
  }, [file, display1, opts.size, opts.orientation, opts.scale, opts.customW, opts.customH]);

  /* ---------------- Canvas painter ---------------- */

  const livePreview =
    preview !== null && preview.file === file ? preview : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || livePreview === null) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { target, display, bitmap, scale } = livePreview;
    const px = Math.min(PREVIEW_MAX_PX / Math.max(target.w, target.h), 1);
    canvas.width = Math.max(1, Math.round(target.w * px));
    canvas.height = Math.max(1, Math.round(target.h * px));
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Dashed outline: the page's ORIGINAL size, centered on the new paper
    // (skipped when it would sit within 2px of the paper edge itself).
    const ow = display.w * px;
    const oh = display.h * px;
    const oLeft = (canvas.width - ow) / 2;
    const oTop = (canvas.height - oh) / 2;
    if (
      Math.abs(ow - canvas.width) > 2 ||
      Math.abs(oh - canvas.height) > 2
    ) {
      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(oLeft + 0.5, oTop + 0.5, ow - 1, oh - 1);
      ctx.setLineDash([]);
    }

    // The page bitmap, placed with the worker's exact scale mode.
    const bw = display.w * scale * px;
    const bh = display.h * scale * px;
    ctx.drawImage(bitmap, (canvas.width - bw) / 2, (canvas.height - bh) / 2, bw, bh);
  }, [livePreview]);

  /* ---------------- Derived summary ---------------- */

  const inventory = useMemo(
    () => (scan !== null && scan.file === file ? buildSizeInventory(scan.sizes) : []),
    [scan, file]
  );

  const keptCount = useMemo(() => {
    // Per-page targets (the worker's exact semantics — "auto" gives every
    // page its own orientation, so a landscape page is compared against the
    // landscape target, not page 1's).
    if (scan === null || scan.file !== file) return 0;
    let kept = 0;
    for (const size of scan.sizes) {
      if (!pageNeedsChange(size, targetSizePt(opts, size))) kept += 1;
    }
    return kept;
  }, [scan, file, opts.size, opts.orientation, opts.customW, opts.customH]);

  // Page 1's target + label (plain derived consts — trivial arithmetic,
  // auto-memoized by the compiler; repeated engine calls confuse the
  // preserve-manual-memoization rule).
  const target1 = display1 === null ? null : targetSizePt(opts, display1);
  const targetLabel =
    target1 === null ? null : sizeLabelPt(target1.w, target1.h);

  if (!file) return null;

  const loading = livePreview === null && !failed && display1 !== null;

  return (
    <section
      aria-label={t("pgsz.previewTitle")}
      className="flex flex-col gap-2.5 rounded-card border border-border bg-card p-3"
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="text-primary" aria-hidden="true">
          <Ruler className="size-3.5" />
        </span>
        {t("pgsz.previewTitle")}
      </p>

      {failed ? (
        <p className="flex items-start gap-2 rounded-btn border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {t("pgsz.renderFailed")}
        </p>
      ) : null}

      {inventory.length > 0 ? (
        <div className="rounded-btn bg-muted/40 px-2.5 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("pgsz.inventoryTitle")}
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {inventory.slice(0, INVENTORY_ROWS).map((row) => (
              <li
                key={row.label}
                className="flex items-baseline justify-between gap-2 text-xs text-foreground"
              >
                <span className="font-mono text-[11px]">{row.label}</span>
                <span className="shrink-0 font-medium text-muted-foreground">
                  {t("pgsz.inventoryCount", { count: row.count })}
                </span>
              </li>
            ))}
            {inventory.length > INVENTORY_ROWS ? (
              <li className="text-[11px] text-muted-foreground">
                {t("pgsz.inventoryMore", {
                  n: inventory.length - INVENTORY_ROWS,
                })}
              </li>
            ) : null}
          </ul>
          {scan !== null && scan.pageCount > SCAN_CAP ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("pgsz.scanNote", { n: SCAN_CAP, total: scan.pageCount })}
            </p>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <div className="flex min-h-40 items-center justify-center gap-2 rounded-btn border border-dashed border-border text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("pgsz.loading")}
        </div>
      ) : null}

      {livePreview !== null && display1 !== null ? (
        <div className="flex flex-col items-center gap-2">
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={t("pgsz.canvasAria")}
            className="h-auto w-full max-w-[380px] rounded-btn border border-border bg-white shadow-sm"
          />
          <p className="text-center text-[11px] font-medium leading-relaxed text-muted-foreground">
            {t("pgsz.caption", {
              from: sizeLabelPt(display1.w, display1.h),
              to: targetLabel ?? "",
            })}
            <span className="mx-1" aria-hidden="true">
              ·
            </span>
            {t("pgsz.scaleNote", {
              pct: Math.round(livePreview.scale * 100),
            })}
          </p>
          {keptCount > 0 ? (
            <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
              {t("pgsz.keptNote", { n: keptCount })}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
