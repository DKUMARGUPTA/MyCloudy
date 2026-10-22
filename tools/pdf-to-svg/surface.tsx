"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Info,
  Loader2,
  PenTool,
  Ruler,
  ScanText,
  Shapes,
  TriangleAlert,
} from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { getPdfPageCount, getPdfPagePixelSize } from "@/lib/pdf/thumbnails";
import { cn } from "@/lib/utils";
import { PreviewFileHeader } from "../stamp-common/preview-parts";

/**
 * PDF to SVG surface (RB4-a): the honest BEFORE report — page count,
 * page 1's exact point size (the viewBox every page's SVG will carry)
 * and the page-range read-back — plus the vector-vs-raster explainer
 * that says exactly what converts and what is approximated. Everything
 * is read on-device through the shared cached pdf.js document.
 */

interface ScanState {
  file: File;
  pageCount: number;
  pageWidth: number;
  pageHeight: number;
  error: boolean;
}

export function PdfToSvgSurface({
  files,
  values,
  setFileOrder,
  setRunBlocked,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const fileMeta = files[0];
  const file = fileMeta?.file ?? null;

  const pagesSpec =
    typeof values.pages === "string" && values.pages.trim().length > 0
      ? values.pages.trim()
      : "all";
  const includeImages = values.includeImages !== false;

  const [snap, setSnap] = useState<ScanState | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      try {
        const [pageCount, size] = await Promise.all([
          getPdfPageCount(file),
          getPdfPagePixelSize(file, 1),
        ]);
        if (cancelled) return;
        setSnap({
          file,
          pageCount,
          pageWidth: size.width,
          pageHeight: size.height,
          error: false,
        });
      } catch {
        if (!cancelled) {
          setSnap({
            file,
            pageCount: 0,
            pageWidth: 0,
            pageHeight: 0,
            error: true,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  const active = snap !== null && snap.file === file ? snap : null;
  const reading = active === null;
  const readError = active?.error === true;

  // CTA gating: blocked only while reading / after a read failure — a
  // vector export always has something to do (the numbers are honest
  // even when the PDF has no text at all).
  const blockedKey = !file
    ? null
    : reading
      ? "psvg.ctaReading"
      : readError
        ? "psvg.readError"
        : null;

  useEffect(() => {
    setRunBlocked(blockedKey);
    return () => setRunBlocked(null);
  }, [blockedKey, setRunBlocked]);

  const removeFile = useCallback((): void => {
    setFileOrder([]);
  }, [setFileOrder]);

  if (!file) return null;

  const report = active && !readError ? active : null;

  return (
    <div className="flex flex-col gap-3">
      <PreviewFileHeader
        file={file}
        pageCount={report?.pageCount ?? 0}
        onRemove={removeFile}
      />

      {reading ? (
        <div
          className="flex items-center gap-3 rounded-card border border-border bg-card px-4 py-8 text-sm text-muted-foreground"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("psvg.loading")}
        </div>
      ) : readError ? (
        <div
          className="flex items-center gap-3 rounded-card border border-border bg-card px-4 py-8 text-sm text-muted-foreground"
          role="alert"
        >
          <TriangleAlert
            className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          {t("psvg.readError")}
        </div>
      ) : report !== null ? (
        <>
          {/* BEFORE report — pages + the exact viewBox page 1 will get */}
          <div className="overflow-hidden rounded-card border border-border bg-card">
            <p className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
              <Ruler className="size-3.5" aria-hidden="true" />
              {t("psvg.reportTitle")}
            </p>
            <dl className="flex flex-col divide-y divide-border/60">
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-3 px-4 py-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
                <dt className="pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("psvg.statPages")}
                </dt>
                <dd className="min-w-0 break-words text-sm text-foreground">
                  <span className="font-semibold">{report.pageCount}</span>
                  {pagesSpec !== "all" ? (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t("psvg.pagesSpec", { spec: pagesSpec })}
                    </span>
                  ) : null}
                </dd>
              </div>
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-3 px-4 py-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
                <dt className="pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("psvg.statSize")}
                </dt>
                <dd className="min-w-0 break-words text-sm text-foreground">
                  <span className="font-semibold">
                    {report.pageWidth} × {report.pageHeight} pt
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t("psvg.statSizeNote")}
                  </span>
                </dd>
              </div>
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-3 px-4 py-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
                <dt className="pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("psvg.statImages")}
                </dt>
                <dd
                  className={cn(
                    "min-w-0 break-words text-sm",
                    includeImages ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {includeImages
                    ? t("psvg.imagesOn")
                    : t("psvg.imagesOff")}
                </dd>
              </div>
            </dl>
          </div>

          {/* What converts — the honest element map */}
          <div className="overflow-hidden rounded-card border border-border bg-card">
            <p className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
              <Shapes className="size-3.5" aria-hidden="true" />
              {t("psvg.elementsTitle")}
            </p>
            <ul className="flex flex-col divide-y divide-border/60">
              {[
                {
                  icon: ScanText,
                  text: t("psvg.elementText"),
                },
                {
                  icon: PenTool,
                  text: t("psvg.elementShapes"),
                },
                {
                  icon: Shapes,
                  text: includeImages
                    ? t("psvg.elementImagesOn")
                    : t("psvg.elementImagesOff"),
                  dimmed: !includeImages,
                },
              ].map(({ icon: Icon, text, dimmed }) => (
                <li
                  key={text}
                  className={cn(
                    "flex items-start gap-3 px-4 py-2.5",
                    dimmed && "opacity-60"
                  )}
                >
                  <Icon
                    className="mt-0.5 size-4 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  <span className="text-sm leading-relaxed text-foreground">
                    {text}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Honest vector-vs-raster explainer */}
          <div className="rounded-card border border-border bg-card p-4">
            <p className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <Info className="size-3.5 text-primary" aria-hidden="true" />
              {t("psvg.honestTitle")}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t("psvg.honestBody")}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t("psvg.honestFonts")}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t("psvg.honestRaster")}
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}
