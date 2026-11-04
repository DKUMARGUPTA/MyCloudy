"use client";

import { Check } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { RunStage } from "@/lib/workers/protocol";
import { cn } from "@/lib/utils";

/**
 * Stage stepper for the processing state (PRD §6.3):
 * Reading → Processing → Saving, with the active stage highlighted.
 */

const STAGES: RunStage[] = ["reading", "processing", "saving"];

export function StageStepper({ stage }: { stage: RunStage }) {
  const { t } = useI18n();
  const activeIndex = STAGES.indexOf(stage);

  return (
    <ol className="flex w-full max-w-md items-center gap-1" aria-label={t("tool.stagesLabel")}>
      {STAGES.map((item, index) => {
        const done = index < activeIndex;
        const active = index === activeIndex;
        return (
          <li key={item} className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors",
                done && "border-primary bg-primary text-primary-foreground",
                active && "border-primary bg-primary/10 text-primary",
                !done && !active && "border-border bg-muted/50 text-muted-foreground"
              )}
            >
              {done ? <Check className="size-3.5" aria-hidden="true" /> : index + 1}
            </span>
            <span
              className={cn(
                "truncate text-xs",
                active
                  ? "font-semibold text-foreground"
                  : "text-muted-foreground"
              )}
            >
              {t(`tool.stage.${item}`)}
            </span>
            {index < STAGES.length - 1 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "h-px flex-1 transition-colors",
                  done ? "bg-primary/60" : "bg-border"
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
