"use client";

import { Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useI18n } from "@/components/providers/locale-provider";
import type { RunProgress } from "@/lib/workers/pool";
import { StageStepper } from "./stepper";

/**
 * Processing state (PRD §6.3 state 3): real worker progress, stage
 * stepper, page counter, cancel, and the "keep the tab open" tip.
 */
export function ProcessingView({
  toolName,
  progress,
  onCancel,
}: {
  toolName: string;
  progress: RunProgress;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const pct = Math.min(100, Math.max(0, Math.round(progress.pct)));

  return (
    <section
      aria-live="polite"
      className="mx-auto flex w-full max-w-xl flex-col items-center gap-6 px-4 py-16 text-center"
    >
      <div className="relative">
        <span
          aria-hidden="true"
          className="flex size-16 items-center justify-center rounded-full border border-primary/30 bg-primary/5"
        >
          <Loader2 className="size-7 animate-spin text-primary" />
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-foreground">
          {t("tool.processingTitle", { tool: toolName })}
        </h2>
        <p className="text-sm text-muted-foreground">{pct}%</p>
      </div>

      <Progress value={pct} className="h-2.5 w-full" aria-label={t("tool.progressLabel")} />

      <StageStepper stage={progress.stage} />

      {progress.detail?.pages !== undefined ? (
        <p className="text-xs text-muted-foreground">
          {progress.detail?.page !== undefined
            ? t("tool.pageOf", {
                page: progress.detail.page,
                pages: progress.detail.pages,
              })
            : t("tool.pagesCount", { count: progress.detail.pages })}
        </p>
      ) : null}

      <Button
        type="button"
        variant="outline"
        size="touch"
        onClick={onCancel}
        className="rounded-btn"
      >
        <X className="size-4" aria-hidden="true" />
        {t("tool.cancel")}
      </Button>

      <p className="text-xs text-muted-foreground">{t("tool.keepTabOpen")}</p>
    </section>
  );
}
