"use client";

import { useCallback, useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlignLeft,
  BookOpen,
  Code,
  Files,
  FileQuestion,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Info,
  Loader2,
  Lock,
  Presentation,
  Shapes,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/locale-provider";
import { ROUTES } from "@/hooks/use-hash-route";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { getTool, type ToolDef } from "@/lib/tools/registry";
import { formatBytes } from "@/lib/storage/recent-files";
import { cn } from "@/lib/utils";
import { sniffKind, type SniffKind, type SniffResult } from "./detect";

/**
 * Universal "Convert to PDF" surface (PRD §7.8): the single workspace file
 * is sniffed by magic bytes (detect.ts), shown as a detected-type card and
 * routed through a target grid — every sensible target for that input,
 * with live tools navigating with the file in hand (onChain) and not-yet-
 * live ones showing honest Soon / Server badges. Everything stays local:
 * the only file read is a 512-byte slice, in memory.
 */

const KIND_ICONS: Record<SniffKind, LucideIcon> = {
  pdf: FileText,
  jpg: ImageIcon,
  png: ImageIcon,
  webp: ImageIcon,
  heic: ImageIcon,
  gif: ImageIcon,
  bmp: ImageIcon,
  tiff: ImageIcon,
  svg: Shapes,
  rtf: FileText,
  txt: AlignLeft,
  html: Code,
  docx: FileText,
  xlsx: FileSpreadsheet,
  pptx: Presentation,
  office: Files,
  epub: BookOpen,
  unknown: FileQuestion,
};

/** Curated targets per detected kind — ids verified against the registry
 *  (read-only import); disabled ones still render, with honest badges. */
const TARGETS_BY_KIND: Record<SniffKind, readonly string[]> = {
  pdf: [
    "view-pdf",
    "pdf-to-jpg",
    "pdf-to-png",
    "pdf-to-txt",
    "pdf-to-word",
    "pdf-to-excel",
    "pdf-to-powerpoint",
  ],
  jpg: ["images-to-pdf", "resize-image-kb"],
  png: ["images-to-pdf", "png-to-pdf", "resize-image-kb"],
  webp: ["images-to-pdf", "webp-to-pdf", "webp-to-jpg", "webp-to-png"],
  heic: ["images-to-pdf", "heic-to-pdf", "heic-to-jpg", "heic-to-png"],
  gif: ["images-to-pdf", "resize-image-kb"],
  bmp: ["images-to-pdf", "resize-image-kb"],
  tiff: ["tiff-to-pdf"],
  svg: ["svg-to-pdf"],
  rtf: ["rtf-to-pdf"],
  txt: ["txt-to-pdf", "markdown-to-pdf"],
  html: ["html-to-pdf", "txt-to-pdf"],
  docx: ["word-to-pdf"],
  xlsx: ["excel-to-pdf"],
  pptx: ["powerpoint-to-pdf"],
  office: ["odt-to-pdf"],
  epub: ["epub-to-pdf"],
  unknown: [],
};

/** One route card: registry name + description + honest badges. Clicking
 *  always fires onChain — the shell navigates for live tools and shows
 *  the coming-soon toast for the rest. */
function TargetCard({
  tool,
  onChain,
}: {
  tool: ToolDef;
  onChain: (targetToolId: string) => void;
}): React.JSX.Element {
  const { t, locale } = useI18n();
  const Icon = tool.icon;
  return (
    <li>
      <button
        type="button"
        onClick={() => onChain(tool.id)}
        className="flex w-full flex-col gap-2 rounded-card border border-border bg-background p-3 text-left outline-none transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:p-4"
      >
        <span className="flex w-full items-start justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2.5">
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary"
              aria-hidden="true"
            >
              <Icon className="size-4" />
            </span>
            <span className="min-w-0 text-sm font-semibold text-foreground">
              {tool.name[locale]}
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-end gap-1">
            {tool.enabled ? (
              <Badge variant="private" className="rounded-chip text-[10px]">
                <Lock className="size-3" aria-hidden="true" />
                {t("conv.onDevice")}
              </Badge>
            ) : (
              <Badge variant="outline" className="rounded-chip text-[10px] text-muted-foreground">
                {t("tools.soonBadge")}
              </Badge>
            )}
            {tool.mode === "S" ? (
              <Badge variant="server" className="rounded-chip text-[10px]">
                {t("tools.serverBadge")}
              </Badge>
            ) : null}
          </span>
        </span>
        <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {tool.description[locale]}
        </span>
      </button>
    </li>
  );
}

export function ConvertToPdfSurface({
  files,
  onChain,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const file = files[0]?.file ?? null;

  /* Type sniff of the file head — state is only ever set inside the async
   * callback, and the snapshot is tagged with the file it belongs to so a
   * swapped file never renders a stale kind. */
  const [sniff, setSniff] = useState<{ file: File; result: SniffResult } | null>(
    null
  );

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
      if (cancelled) return;
      setSniff({ file, result: sniffKind(head, file.name) });
    })().catch(() => {
      if (!cancelled) {
        setSniff({ file, result: { kind: "unknown", labelKey: "conv.kindUnknown" } });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const chain = useCallback(
    (targetToolId: string) => {
      onChain?.(targetToolId);
    },
    [onChain]
  );

  if (!file) return null;

  const current: SniffResult | null =
    sniff && sniff.file === file ? sniff.result : null;

  /* Reading the head… */
  if (current === null) {
    return (
      <div
        className="flex min-h-44 flex-col items-center justify-center gap-3 rounded-card border border-border bg-card p-6 text-center"
        aria-live="polite"
      >
        <Loader2 className="size-7 animate-spin text-primary" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{t("conv.reading")}</p>
      </div>
    );
  }

  const KindIcon = KIND_ICONS[current.kind];
  const targets = TARGETS_BY_KIND[current.kind]
    .map((id) => getTool(id))
    .filter((tool): tool is ToolDef => tool !== undefined);
  const hasServerTool = targets.some((tool) => tool.mode === "S");

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      {/* ---------------- detected file card ---------------- */}
      <section aria-labelledby="conv-file-heading">
        <h2
          id="conv-file-heading"
          className="text-sm font-semibold text-foreground"
        >
          {t("conv.yourFile")}
        </h2>
        <div className="mt-3 rounded-card border border-border bg-card p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="flex size-11 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary"
              aria-hidden="true"
            >
              <KindIcon className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p
                className="truncate text-sm font-semibold text-foreground"
                title={file.name}
              >
                {file.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatBytes(file.size)}
              </p>
            </div>
            {current.kind !== "unknown" ? (
              <span className="shrink-0 rounded-chip bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
                {t(current.labelKey)}
              </span>
            ) : null}
          </div>

          {current.kind === "pdf" ? (
            <div
              className={cn(
                "mt-4 flex items-start gap-2 rounded-btn border border-primary/30 bg-primary/5 px-3 py-2.5",
                "text-xs leading-relaxed text-foreground"
              )}
            >
              <Info
                className="mt-0.5 size-3.5 shrink-0 text-primary"
                aria-hidden="true"
              />
              <span>
                <strong className="font-semibold">
                  {t("conv.alreadyPdfTitle")}.
                </strong>{" "}
                {t("conv.alreadyPdfDesc")}
              </span>
            </div>
          ) : null}
        </div>
      </section>

      {/* ---------------- target grid / unknown note ---------------- */}
      {current.kind === "unknown" ? (
        <section aria-labelledby="conv-unknown-heading">
          <div className="rounded-card border border-amber-500/40 bg-amber-500/10 p-4 sm:p-5">
            <h2
              id="conv-unknown-heading"
              className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200"
            >
              <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
              {t("conv.unknownTitle")}
            </h2>
            <p className="mt-2 break-words text-xs leading-relaxed text-amber-900/80 dark:text-amber-200/80">
              {t("conv.unknownDesc", { name: file.name })}
            </p>
            <Button asChild variant="outline" size="touch" className="mt-3 rounded-btn">
              <a href={ROUTES.tools}>{t("conv.unknownAction")}</a>
            </Button>
          </div>
        </section>
      ) : (
        <section aria-labelledby="conv-targets-heading">
          <h2
            id="conv-targets-heading"
            className="text-sm font-semibold text-foreground"
          >
            {current.kind === "pdf"
              ? t("conv.pdfTargetsTitle")
              : t("conv.targetsTitle")}
          </h2>
          <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {targets.map((tool) => (
              <TargetCard key={tool.id} tool={tool} onChain={chain} />
            ))}
          </ul>
          {hasServerTool ? (
            <p className="mt-3 rounded-btn bg-muted/60 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
              {t("conv.serverNote")}
            </p>
          ) : null}
        </section>
      )}
    </div>
  );
}
