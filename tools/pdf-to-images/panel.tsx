"use client";

import { useEffect, useState } from "react";
import { Ruler } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import { getPdfPagePixelSize } from "@/lib/pdf/thumbnails";

/**
 * PDF → images preview panel (PRD §8.6): shows what page 1 will look like
 * as pixels at the chosen DPI — before spending time on a full render.
 * Viewport-only math (no canvas render) + the real first-page thumbnail.
 */
export function PdfToImagesPanel({ files, values }: ToolPanelProps) {
  const { t } = useI18n();
  const file = files.length > 0 ? files[0].file : null;

  const [pixelSize, setPixelSize] = useState<{
    w: number;
    h: number;
  } | null>(null);

  const dpi = Number(values.dpi ?? 150);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void getPdfPagePixelSize(file, dpi / 72)
      .then((size) => {
        if (!cancelled) setPixelSize({ w: size.width, h: size.height });
      })
      .catch(() => {
        if (!cancelled) setPixelSize(null);
      });
    return () => {
      cancelled = true;
    };
  }, [file, dpi]);

  if (!file) return null;

  return (
    <div className="flex items-start gap-2.5 rounded-card border border-border bg-muted/40 p-3">
      <Ruler
        className="mt-0.5 size-4 shrink-0 text-primary"
        aria-hidden="true"
      />
      <div className="min-w-0 text-xs leading-relaxed text-muted-foreground">
        {pixelSize ? (
          <>
            <p className="font-semibold text-foreground">
              {t("pdfimg.previewTitle")}
            </p>
            <p className="mt-0.5">
              {t("pdfimg.previewSize", {
                dpi,
                w: pixelSize.w,
                h: pixelSize.h,
              })}
            </p>
            <p className="mt-0.5 text-[11px]">
              {t("pdfimg.previewNote")}
            </p>
          </>
        ) : (
          <p>{t("pdfimg.previewLoading")}</p>
        )}
      </div>
    </div>
  );
}
