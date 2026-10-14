"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutGrid,
  Loader2,
  TriangleAlert,
} from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import {
  getPdfPageCount,
  getPdfPagePixelSize,
  renderPdfThumbnail,
} from "@/lib/pdf/thumbnails";
import { parsePageSpec } from "@/lib/workers/protocol";
import {
  type NupPlan,
  fitIntoCell,
  planSheets,
  resolveNupOptions,
} from "./engine";

/**
 * Pages per sheet — LIVE PREVIEW panel (PRD §8.1: "live preview of the
 * sheet"). Draws sheet 1 on a canvas exactly the way the worker will emit
 * it: real pdf.js thumbnails of the pages that land on the first sheet,
 * centered in their planned grid cells (the same fitIntoCell math), the
 * margin outline, and the optional hairline cell borders. Rebuilds are
 * debounced (150ms) so tweaking options stays smooth; page bitmaps are
 * closed the moment they stop being referenced.
 *
 * Read-only with respect to options: every control is the schema-driven
 * OptionsPanel below this panel — values arrive through ToolPanelProps.
 */

/** Long-side pixel budget of the preview canvas (CSS scales it down). */
const PREVIEW_MAX_PX = 640;
/** Thumbnail render size for the cell pages (pdf.js queue, 2 at a time). */
const THUMB_MAX_DIM = 200;
/** Option-change debounce (ms). */
const REBUILD_DEBOUNCE_MS = 150;

/** Cell border color — the same gray the worker strokes into the PDF. */
const BORDER_COLOR = "#8c8c9e";
/** Margin (printable-area) outline color. */
const MARGIN_COLOR = "rgba(125, 125, 135, 0.55)";

interface SheetPreview {
  file: File;
  plan: NupPlan;
  /** Bitmaps per cell slot, in the sheet's reading order. */
  cells: { slot: number; bitmap: ImageBitmap; w: number; h: number }[];
}

export function PagesPerSheetPanel({ files, values }: ToolPanelProps) {
  const { t } = useI18n();
  const file = files.length > 0 ? files[0].file : null;

  const opts = useMemo(() => resolveNupOptions(values), [values]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prevSheetRef = useRef<SheetPreview | null>(null);

  const [pageCountState, setPageCountState] = useState<{
    file: File;
    count: number;
  } | null>(null);
  const [sheetState, setSheetState] = useState<SheetPreview | null>(null);
  const [failed, setFailed] = useState(false);

  /* Release the previous sheet's bitmaps the moment a new one replaces it
   * (in an effect, never during render). The painter below only ever draws
   * the CURRENT state, so a closed bitmap is never referenced again — the
   * canvas keeps its pixels and bitmaps of a cancelled rebuild simply GC. */
  useEffect(() => {
    const previous = prevSheetRef.current;
    prevSheetRef.current = sheetState;
    if (previous !== null && previous !== sheetState) {
      for (const cell of previous.cells) cell.bitmap.close();
    }
  }, [sheetState]);

  /* ---------------- Page count of the selected file ---------------- */

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

  /* ---------------- Current page selection (pure, sync) ---------------- */

  const countReady =
    file !== null && pageCountState !== null && pageCountState.file === file;
  const indices = useMemo(() => {
    if (!countReady || pageCountState === null || pageCountState.count < 1) {
      return null;
    }
    return parsePageSpec(opts.pages, pageCountState.count);
  }, [countReady, pageCountState, opts.pages]);
  const rangeInvalid = countReady && indices === null;

  /* ---------------- Debounced sheet rebuild ---------------- */

  useEffect(() => {
    if (!file || indices === null || indices.length === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const created: ImageBitmap[] = [];
        const closeCreated = (): void => {
          for (const bitmap of created) bitmap.close();
        };
        try {
          // Display dims (pt) of the first SELECTED page — drives "match"
          // sizing and "auto" orientation, exactly like the worker.
          const firstSize = await getPdfPagePixelSize(file, 1, indices[0]);
          if (cancelled) {
            closeCreated();
            return;
          }
          const plan = planSheets(
            indices.length,
            opts,
            { w: firstSize.width, h: firstSize.height }
          );
          const cells: SheetPreview["cells"] = [];
          for (const cell of plan.sheets[0].cells) {
            const thumb = await renderPdfThumbnail(file, {
              pageIndex: indices[cell.pageIndex],
              maxDim: THUMB_MAX_DIM,
            });
            if (cancelled) {
              closeCreated();
              return;
            }
            const bitmap = await createImageBitmap(thumb.blob);
            created.push(bitmap);
            cells.push({
              slot: cell.slot,
              bitmap,
              w: thumb.width,
              h: thumb.height,
            });
          }
          if (cancelled) {
            closeCreated();
            return;
          }
          setSheetState({ file, plan, cells });
          setFailed(false);
        } catch {
          closeCreated();
          if (!cancelled) setFailed(true);
        }
      })();
    }, REBUILD_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [file, indices, opts]);

  /* ---------------- Canvas painter ---------------- */

  const plan =
    sheetState !== null && sheetState.file === file ? sheetState.plan : null;
  const borders = opts.borders;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || plan === null || sheetState === null) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const px = Math.min(PREVIEW_MAX_PX / Math.max(plan.sheetW, plan.sheetH), 1);
    canvas.width = Math.max(1, Math.round(plan.sheetW * px));
    canvas.height = Math.max(1, Math.round(plan.sheetH * px));
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Printable-area outline (the sheet margin).
    const m = plan.margin * px;
    ctx.strokeStyle = MARGIN_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(
      m + 0.5,
      m + 0.5,
      canvas.width - 2 * m - 1,
      canvas.height - 2 * m - 1
    );
    ctx.setLineDash([]);

    // Pages + borders, cell by cell — the worker's exact draw order.
    ctx.strokeStyle = BORDER_COLOR;
    const bySlot = new Map(sheetState.cells.map((c) => [c.slot, c]));
    for (const cell of plan.sheets[0].cells) {
      const entry = bySlot.get(cell.slot);
      if (entry) {
        const fit = fitIntoCell(cell, entry.w, entry.h);
        ctx.drawImage(
          entry.bitmap,
          fit.x * px,
          fit.y * px,
          fit.width * px,
          fit.height * px
        );
      }
      if (borders) {
        ctx.strokeRect(
          cell.x * px + 0.5,
          cell.y * px + 0.5,
          cell.w * px - 1,
          cell.h * px - 1
        );
      }
    }
  }, [sheetState, plan, borders]);

  /* ---------------- Render ---------------- */

  if (!file) return null;

  const sheetPages =
    plan !== null
      ? plan.sheets.reduce((sum, s) => sum + s.cells.length, 0)
      : 0;
  const caption =
    plan !== null
      ? t("nup.sheetAria", {
          index: 1,
          total: plan.sheets.length,
          layout: plan.perSheet,
          size:
            opts.sheetSize === "letter"
              ? t("nup.sizeLetter")
              : opts.sheetSize === "match"
                ? t("nup.sizeMatch")
                : t("nup.sizeA4"),
          orientation:
            plan.orientation === "landscape"
              ? t("nup.orientLandscape")
              : t("nup.orientPortrait"),
        })
      : "";

  const loading = plan === null && !failed && !rangeInvalid;

  return (
    <section
      aria-label={t("nup.previewTitle")}
      className="flex flex-col gap-2.5 rounded-card border border-border bg-card p-3"
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="text-primary" aria-hidden="true">
          <LayoutGrid className="size-3.5" />
        </span>
        {t("nup.previewTitle")}
      </p>

      {rangeInvalid ? (
        <p className="flex items-start gap-2 rounded-btn border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {t("wm.rangeInvalid")}
        </p>
      ) : null}

      {failed ? (
        <p className="flex items-start gap-2 rounded-btn border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {t("nup.renderFailed")}
        </p>
      ) : null}

      {loading ? (
        <div className="flex min-h-40 items-center justify-center gap-2 rounded-btn border border-dashed border-border text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("nup.loading")}
        </div>
      ) : null}

      {plan !== null ? (
        <div className="flex flex-col items-center gap-2">
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={caption}
            className="h-auto w-full max-w-[420px] rounded-btn border border-border bg-white shadow-sm"
          />
          <p className="text-center text-[11px] font-medium leading-relaxed text-muted-foreground">
            {caption}
            <span className="mx-1" aria-hidden="true">
              ·
            </span>
            {t("nup.planNote", {
              pages: sheetPages,
              sheets: plan.sheets.length,
            })}
          </p>
          <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
            {t("nup.hint")}
          </p>
        </div>
      ) : null}
    </section>
  );
}
