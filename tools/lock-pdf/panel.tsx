"use client";

import { Info, ShieldCheck, TriangleAlert } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";

/**
 * Protect PDF aside panel (PRD §6.3 honest-scope notes): what encryption
 * changes, what it can never promise, and the open-before-share reminder.
 * All interactive values live in the surface (main column).
 */

function Note({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p className="flex items-start gap-2 rounded-card border border-border bg-muted/30 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
      <span className="mt-0.5 shrink-0 text-primary" aria-hidden="true">
        {icon}
      </span>
      <span>{children}</span>
    </p>
  );
}

export function LockPanel({
  values,
}: ToolPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const algorithm = values.lockAlgorithm === "aes128" ? "AES-128" : "AES-256";
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-card border border-border bg-muted/30 px-3 py-2.5">
        <p className="text-xs font-semibold text-foreground">
          {t("lock.panelTitle")}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {t("lock.panelLine", { algo: algorithm })}
        </p>
      </div>

      <Note icon={<ShieldCheck className="size-3.5" />}>
        {t("lock.notePages")}
      </Note>
      <Note icon={<Info className="size-3.5" />}>
        {t("lock.noteTestOpen")}
      </Note>
      <Note icon={<TriangleAlert className="size-3.5" />}>
        {t("lock.noteNoRecover")}
      </Note>
    </div>
  );
}
