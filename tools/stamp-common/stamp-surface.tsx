"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, ScanSearch, TriangleAlert } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import {
  getPdfMetadataTitle,
  getPdfPagePixelSize,
  renderPdfThumbnail,
} from "@/lib/pdf/thumbnails";
import { cn } from "@/lib/utils";
import {
  type StampFontId,
  type StampToolSpec,
  type TextMeasurer,
  fileBaseName,
} from "./layout";
import {
  PreviewFileHeader,
  PreviewPageStrip,
  PreviewZoomControl,
} from "./preview-parts";
import { cssFontFor, type WmFontId } from "../add-watermark/wm-options";

/**
 * Generic live-preview surface for computed text stamps (PRD §8.2 "Preview:
 * live canvas preview on selected sample page; thumbnails strip"). The exact
 * component serves Add page numbers and Header & footer: the per-tool SPEC
 * (pure functions) computes the marks, this surface renders the page with
 * pdf.js and paints the marks with the SAME center math the worker draws —
 * what you see is what the PDF gets.
 *
 * The canvas measurer mirrors pdf-lib's widthOfTextAtSize closely enough for
 * placement preview (same approach the watermark round proved end-to-end).
 */

const PREVIEW_MAX_DIM = 560;
/** Zoom presets for the preview — text stamps are small on full pages. */
const ZOOM_STEPS = [1, 1.5, 2] as const;

interface BasePreview {
  file: File;
  pageIndex: number;
  bitmap: ImageBitmap;
  pdfW: number;
  pdfH: number;
}

/** Devanagari-aware canvas font: the app's self-hosted Noto Sans Devanagari. */
function stampCssFont(fontId: StampFontId, sizePx: number): string {
  if (fontId !== "devanagari") {
    return cssFontFor(fontId as WmFontId, sizePx);
  }
  let family = "";
  if (typeof window !== "undefined") {
    family = getComputedStyle(document.body)
      .getPropertyValue("--font-noto-devanagari")
      .trim();
  }
  if (!family) family = "'Noto Sans Devanagari'";
  return `400 ${sizePx}px ${family}`;
}

export function StampSurface<TOptions>({
  files,
  values,
  setFileOrder,
  setRunBlocked,
  spec,
  previewTitleKey,
}: ToolSurfaceProps & {
  spec: StampToolSpec<TOptions>;
  previewTitleKey: string;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const file = files.length > 0 ? files[0].file : null;
  const fileMeta = files[0];

  const options = useMemo(() => spec.resolve(values), [spec, values]);
  const [pageCount, setPageCount] = useState(0);
  const [selectedPage, setSelectedPage] = useState(0);
  const [base, setBase] = useState<BasePreview | null>(null);
  const [failure, setFailure] = useState<{ file: File; pageIndex: number } | null>(
    null
  );
  const [docTitle, setDocTitle] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState<(typeof ZOOM_STEPS)[number]>(1);

  const targets = useMemo(
    () => (pageCount > 0 ? spec.targets(options, pageCount) : []),
    [spec, options, pageCount]
  );
  const markedSet = useMemo(() => new Set(targets ?? []), [targets]);

  // Page count + document title ({title} variable) for the selected file.
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      const { getPdfPageCount } = await import("@/lib/pdf/thumbnails");
      const [count, title] = await Promise.all([
        getPdfPageCount(file),
        getPdfMetadataTitle(file).catch(() => ""),
      ]);
      if (cancelled) return;
      setPageCount(count);
      setDocTitle(title);
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

  // Thumbnails strip + zoom live in the shared preview parts.

  // CTA gating (amber reason in the sticky bar) — the spec decides.
  const blockedKey = spec.runBlocked(options, targets, pageCount);
  useEffect(() => {
    setRunBlocked(blockedKey);
  }, [blockedKey, setRunBlocked]);

  // THE overlay painter — same math as the worker (spec.marks + center draw).
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

    // Canvas measurer: width in PDF points via a scaled font measurement.
    const measure: TextMeasurer = (text, fontId, size) => {
      ctx.font = stampCssFont(fontId, size * s);
      return ctx.measureText(text).width / s;
    };

    const marks = spec.marks(measure, options, {
      pageIndex: base.pageIndex,
      pageCount: Math.max(1, pageCount),
      pageW,
      pageH,
      fileName: base.file.name,
      fileBase: fileBaseName(base.file.name),
      title: docTitle,
    });

    for (const mark of marks) {
      ctx.save();
      ctx.globalAlpha = mark.opacity;
      ctx.fillStyle = mark.color;
      ctx.font = stampCssFont(mark.fontId, mark.size * s);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // cy is PDF coords (y UP); canvas is y DOWN.
      ctx.translate(mark.cx * s, (pageH - mark.cy) * s);
      ctx.fillText(mark.text, 0, 0);
      ctx.restore();
    }
  }, [base, options, spec, pageCount, docTitle]);

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
  const chips = spec.chips(options, targets, pageCount);

  return (
    <div className="flex flex-col gap-4">
      <PreviewFileHeader
        file={file}
        pageCount={pageCount}
        onRemove={removeFile}
      />

      {/* Live preview card */}
      <div className="overflow-hidden rounded-card border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <ScanSearch className="size-3.5 text-primary" aria-hidden="true" />
            {t(previewTitleKey)}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {invalidRange ? (
              <span className="flex items-center gap-1 rounded-chip bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                <TriangleAlert className="size-3" aria-hidden="true" />
                {t("wm.rangeInvalid")}
              </span>
            ) : (
              chips.map((chip, index) => (
                <span
                  key={`${chip.key}-${index}`}
                  className="rounded-chip bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary"
                >
                  {t(chip.key, chip.params ?? undefined)}
                </span>
              ))
            )}
            {/* Zoom control — small stamps need a closer look (styling pass) */}
            <PreviewZoomControl
              steps={ZOOM_STEPS}
              value={zoom}
              onChange={setZoom}
            />
          </div>
        </div>

        <div
          className={cn(
            "relative flex max-w-full justify-center bg-muted/30 px-4 py-5",
            zoom > 1
              ? "overflow-x-auto overflow-y-hidden scrollbar-thin"
              : "items-center"
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
            <canvas
              ref={canvasRef}
              style={
                zoom > 1
                  ? { width: `${Math.round(current.bitmap.width * zoom)}px` }
                  : undefined
              }
              className={cn(
                "h-auto w-auto rounded-md border border-border/60 shadow-sm",
                zoom > 1 ? "max-w-none shrink-0" : "max-h-[62vh] max-w-full"
              )}
              aria-label={t(previewTitleKey)}
              role="img"
            />
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
          {t("wm.previewNote")}
        </p>
      </div>

      {/* Page strip */}
      <PreviewPageStrip
        file={file}
        pageCount={pageCount}
        selected={selectedPage}
        onSelect={setSelectedPage}
        markedSet={markedSet}
      />
    </div>
  );
}
