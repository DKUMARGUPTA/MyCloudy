"use client";

import { useMemo } from "react";
import { Keyboard, LayoutGrid } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import { cn } from "@/lib/utils";
import {
  gridStats,
  parseGridOption,
  parseNumberListOption,
  type GridPreset,
} from "./model";

/**
 * PageGrid aside summary (PRD §6.3 workspace sidebar): live stats computed
 * from the same serialized grid the worker will execute, plus the keyboard
 * shortcut cheat sheet. Rendered by the shared ToolShell options area on
 * desktop and inside the mobile bottom sheet.
 */

interface SummaryRow {
  label: string;
  value: string;
  className?: string;
}

export function GridSummaryPanel({
  preset,
  values,
}: ToolPanelProps & { preset: GridPreset }) {
  const { t } = useI18n();

  const stats = useMemo(() => {
    const pages = parseGridOption(values.grid);
    if (pages === null) return null;
    const original =
      typeof values.originalCount === "number"
        ? values.originalCount
        : pages.length;
    const selectedCount =
      preset === "extract" ? parseNumberListOption(values.selected).length : 0;
    return { ...gridStats(pages, original), selectedCount };
  }, [values.grid, values.originalCount, values.selected, preset]);

  const rows: SummaryRow[] = useMemo(() => {
    if (stats === null) return [];
    const out: SummaryRow[] = [
      {
        label: t("grid.summaryOutLabel"),
        value:
          stats.total === 1
            ? t("grid.summaryOutOne")
            : t("grid.summaryOut", { count: stats.total }),
      },
    ];
    if (stats.removed > 0) {
      out.push({
        label: t("grid.summaryRemovedLabel"),
        value: t("grid.summaryRemoved", { count: stats.removed }),
        className: "text-destructive",
      });
    }
    if (stats.rotated > 0) {
      out.push({
        label: t("grid.summaryRotatedLabel"),
        value: t("grid.summaryRotated", { count: stats.rotated }),
        className: "text-amber-600 dark:text-amber-400",
      });
    }
    if (stats.blanks > 0) {
      out.push({
        label: t("grid.summaryBlankLabel"),
        value: t("grid.summaryBlank", { count: stats.blanks }),
        className: "text-emerald-600 dark:text-emerald-400",
      });
    }
    if (preset === "extract") {
      out.push({
        label: t("grid.summarySelectedLabel"),
        value: t("grid.summarySelected", { count: stats.selectedCount }),
        className: "text-primary",
      });
    }
    return out;
  }, [stats, preset, t]);

  return (
    <section aria-label={t("grid.panelTitle")} className="flex flex-col gap-3">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <LayoutGrid className="size-3.5" aria-hidden="true" />
        {t("grid.panelTitle")}
      </h3>

      {stats === null ? (
        <p className="rounded-btn border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          {t("grid.summaryWaiting")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <li
              key={row.label}
              className={cn(
                "flex items-center justify-between gap-2 rounded-btn border border-border bg-background px-2.5 py-1.5 text-xs",
                row.className
              )}
            >
              <span className="text-muted-foreground">{row.label}</span>
              <span className="font-semibold text-foreground">{row.value}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-btn border border-border bg-muted/30 p-2.5">
        <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Keyboard className="size-3.5" aria-hidden="true" />
          {t("grid.shortcutsTitle")}
        </h4>
        <ul className="mt-2 flex flex-col gap-1 text-[11px] leading-relaxed text-muted-foreground">
          {[
            { keys: "Ctrl + A", key: "grid.shortcutSelectAll" },
            { keys: "Shift + Click", key: "grid.shortcutShift" },
            { keys: "Ctrl + Z", key: "grid.shortcutUndo" },
            { keys: "Ctrl + Shift + Z", key: "grid.shortcutRedo" },
            { keys: "Del", key: "grid.shortcutDelete" },
            { keys: "Esc", key: "grid.shortcutEsc" },
          ].map((item) => (
            <li
              key={item.key}
              className="flex items-center justify-between gap-2"
            >
              <span>{t(item.key)}</span>
              <kbd className="rounded-chip border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] font-semibold text-foreground">
                {item.keys}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
