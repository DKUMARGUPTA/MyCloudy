"use client";

import { useMemo } from "react";
import { EyeOff, TriangleAlert } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import { parseRedactMarks, type RedactMark } from "./engine";

/**
 * Redact PDF aside panel — read-only summary (the bookmark precedent):
 * the marks live in the surface state, serialize into the shared option
 * values under per-file "m:<fileId>" keys, and this panel reads them back
 * through the same parser the worker uses — so the summary can never
 * disagree with the run.
 *
 * The interactive review list (check/uncheck + delete) lives in the
 * surface's main column where the marks are owned.
 */
export function RedactPanel({ files, values }: ToolPanelProps): React.JSX.Element {
  const { t } = useI18n();

  const marks = useMemo<RedactMark[]>(() => {
    const all: RedactMark[] = [];
    for (const [key, raw] of Object.entries(values)) {
      if (!key.startsWith("m:")) continue;
      all.push(...parseRedactMarks(raw));
    }
    return all;
  }, [values]);

  const enabledCount = marks.filter((m) => m.enabled).length;
  const affectedPages = new Set(
    marks.filter((m) => m.enabled).map((m) => m.page)
  ).size;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <EyeOff className="size-4 text-primary" aria-hidden="true" />
          {t("redact.panelTitle")}
        </h3>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className="rounded-chip bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
            {t("redact.marksChip", { count: enabledCount })}
          </span>
          <span className="rounded-chip bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {t("redact.pagesChip", { count: affectedPages })}
          </span>
        </div>
      </div>

      {/* PRD warning, short form (the surface carries the full copy) */}
      <div className="flex items-start gap-2 rounded-card border border-destructive/30 bg-destructive/5 px-3 py-2.5">
        <TriangleAlert
          className="mt-0.5 size-3.5 shrink-0 text-destructive"
          aria-hidden="true"
        />
        <p className="text-[11px] leading-relaxed text-foreground">
          {t("redact.warningShort")}
        </p>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t("redact.panelNote")}
      </p>
    </div>
  );
}
