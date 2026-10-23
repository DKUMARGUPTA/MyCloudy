"use client";

import { useCallback, useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  FileText,
  Loader2,
  Lock,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/locale-provider";
import { ROUTES } from "@/hooks/use-hash-route";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { getTool, type ToolDef } from "@/lib/tools/registry";
import { formatBytes } from "@/lib/storage/recent-files";
import { sniffKind, type SniffResult } from "../convert-to-pdf/detect";

/**
 * Universal "Convert from PDF" surface (PRD §7.9): the mirrored twin of
 * the convert-to-pdf hub. The workspace file is verified by magic bytes
 * (the DropZone already enforces PDF, but chain handoffs can carry
 * anything — the sniff keeps the hub honest), then a target grid routes
 * to the exact tool with the file in hand (onChain). Every target
 * converts on the device. The only file read is a 512-byte slice, in
 * memory.
 */

/** Curated from-PDF targets — ids verified against the registry
 *  (read-only import); all twelve are live, on-device tools. */
const FROM_PDF_TARGETS: readonly string[] = [
  "pdf-to-jpg",
  "pdf-to-png",
  "pdf-to-txt",
  "pdf-to-webp",
  "pdf-to-tiff",
  "pdf-to-svg",
  "pdf-to-word",
  "pdf-to-powerpoint",
  "pdf-to-excel",
  "pdf-to-html",
  "pdf-to-markdown",
  "pdf-to-odt",
];

/** One route card: registry name + description + honest badges. Clicking
 *  always fires onChain — the shell navigates to the target tool with the
 *  file in hand. */
function TargetCard({
  tool,
  onChain,
}: {
  tool: ToolDef;
  onChain: (targetToolId: string) => void;
}): React.JSX.Element {
  const { t, locale } = useI18n();
  const Icon: LucideIcon = tool.icon;
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

export function ConvertFromPdfSurface({
  files,
  onChain,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const file = files[0]?.file ?? null;

  /* Magic-byte verification of the single workspace file — state is only
   * ever set inside the async callback, tagged with the file it belongs
   * to so a swapped file never renders a stale result. */
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
        <p className="text-sm text-muted-foreground">{t("convFrom.reading")}</p>
      </div>
    );
  }

  /* Defensive honesty: a chained-in non-PDF gets a clear card, not a
   * broken conversion. */
  if (current.kind !== "pdf") {
    return (
      <section aria-labelledby="convfrom-notpdf-heading">
        <div className="rounded-card border border-amber-500/40 bg-amber-500/10 p-4 sm:p-5">
          <h2
            id="convfrom-notpdf-heading"
            className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200"
          >
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            {t("convFrom.notPdfTitle")}
          </h2>
          <p className="mt-2 break-words text-xs leading-relaxed text-amber-900/80 dark:text-amber-200/80">
            {t("convFrom.notPdfDesc")}
          </p>
          <Button asChild variant="outline" size="touch" className="mt-3 rounded-btn">
            <a href={ROUTES.tool("convert-to-pdf")}>{t("convFrom.notPdfAction")}</a>
          </Button>
        </div>
      </section>
    );
  }

  const targets = FROM_PDF_TARGETS.map((id) => getTool(id)).filter(
    (tool): tool is ToolDef => tool !== undefined
  );
  const hasServerTool = targets.some((tool) => tool.mode === "S");

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      {/* ---------------- detected file card ---------------- */}
      <section aria-labelledby="convfrom-file-heading">
        <h2
          id="convfrom-file-heading"
          className="text-sm font-semibold text-foreground"
        >
          {t("convFrom.yourFile")}
        </h2>
        <div className="mt-3 rounded-card border border-border bg-card p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="flex size-11 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary"
              aria-hidden="true"
            >
              <FileText className="size-5" />
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
            <span className="shrink-0 rounded-chip bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
              {t("convFrom.fileIsPdf")}
            </span>
          </div>
        </div>
      </section>

      {/* ---------------- target grid ---------------- */}
      <section aria-labelledby="convfrom-targets-heading">
        <h2
          id="convfrom-targets-heading"
          className="text-sm font-semibold text-foreground"
        >
          {t("convFrom.targetsTitle")}
        </h2>
        <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {targets.map((tool) => (
            <TargetCard key={tool.id} tool={tool} onChain={chain} />
          ))}
        </ul>
        {hasServerTool ? (
          <p className="mt-3 rounded-btn bg-muted/60 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
            {t("convFrom.serverNote")}
          </p>
        ) : null}
      </section>
    </div>
  );
}
