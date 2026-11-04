"use client";

import { FileCheck2, Info, ShieldOff } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";

/**
 * Unlock PDF aside panel (PRD §6.3 + §8.3 policy): the two honest scopes —
 * what stays identical, and the no-cracking policy. All interactive state
 * lives in the surface (main column).
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

export function UnlockPanel(): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-card border border-border bg-muted/30 px-3 py-2.5">
        <p className="text-xs font-semibold text-foreground">
          {t("unlock.panelTitle")}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {t("unlock.panelLine")}
        </p>
      </div>

      <Note icon={<FileCheck2 className="size-3.5" />}>
        {t("unlock.noteIdentical")}
      </Note>
      <Note icon={<Info className="size-3.5" />}>
        {t("unlock.noteEngine")}
      </Note>
      <Note icon={<ShieldOff className="size-3.5" />}>
        {t("unlock.policyNote")}
      </Note>
    </div>
  );
}
