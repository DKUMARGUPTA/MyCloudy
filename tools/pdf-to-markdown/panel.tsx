"use client";

import { useEffect, useState } from "react";
import { FileText, ScanSearch, TriangleAlert } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import { getPdfPageTextPreview } from "@/lib/pdf/thumbnails";

/**
 * PDF → Markdown preview panel (PRD §8.6): before running anything, shows
 * the first page's selectable text — the raw material the converter will
 * turn into Markdown. No text found → the honest scan warning (OCR is the
 * separate tool for those).
 */
export function PdfToMarkdownPanel({ files }: ToolPanelProps) {
  const { t } = useI18n();
  const file = files.length > 0 ? files[0].file : null;

  const [preview, setPreview] = useState<
    { file: File; text: string; truncated: boolean } | null
  >(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void getPdfPageTextPreview(file, 240)
      .then((text) => {
        if (!cancelled) {
          setPreview({ file, text, truncated: text.length >= 240 });
        }
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  if (!file) return null;

  // Stale preview (file changed while loading) renders as loading.
  const current = preview !== null && preview.file === file ? preview : null;
  const words =
    current && current.text.length > 0
      ? current.text.split(/\s+/).filter(Boolean).length
      : 0;

  return (
    <div className="rounded-card border border-border bg-muted/40">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <p className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-foreground">
          <FileText
            className="size-3.5 shrink-0 text-primary"
            aria-hidden="true"
          />
          {t("mdOut.previewTitle")}
        </p>
        {preview && words > 0 ? (
          <p className="shrink-0 rounded-chip bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
            {t("mdOut.previewWords", { count: words })}
          </p>
        ) : null}
      </div>

      {current === null ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          {t("mdOut.previewLoading")}
        </p>
      ) : current.text.length === 0 ? (
        <div className="flex items-start gap-2.5 px-3 py-3">
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0 text-amber-500"
            aria-hidden="true"
          />
          <div className="min-w-0 text-xs leading-relaxed">
            <p className="font-semibold text-foreground">
              {t("mdOut.scanTitle")}
            </p>
            <p className="mt-0.5 text-muted-foreground">
              {t("mdOut.scanBody")}
            </p>
          </div>
        </div>
      ) : (
        <div className="relative px-3 py-2.5">
          <pre className="max-h-32 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/90 scrollbar-thin">
            {current.text}
          </pre>
          {current.truncated ? (
            <>
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-muted/95 to-transparent"
                aria-hidden="true"
              />
              <p className="pt-1 text-[10px] text-muted-foreground">
                {t("mdOut.previewTruncated")}
              </p>
            </>
          ) : null}
        </div>
      )}

      <p className="flex items-center gap-1.5 border-t border-border/60 px-3 py-2 text-[10px] text-muted-foreground">
        <ScanSearch className="size-3 shrink-0" aria-hidden="true" />
        {t("mdOut.previewNote")}
      </p>
    </div>
  );
}
