"use client";

import { useMemo } from "react";
import { ArrowDownAZ, ArrowUpAZ, CalendarClock, Files } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import { cn } from "@/lib/utils";

/**
 * Merge PDF custom panel (PRD §8.1 options):
 * - sort buttons: A→Z / Z→A / by date (reorders the workspace file list)
 * - per-file page ranges ("all" by default; e.g. 1-3, 5)
 *
 * Range values are stored as ONE option ("fileRanges": JSON map of
 * workspace-file id -> range string) so they travel to the worker inside
 * the standard options payload — no protocol special-casing.
 */
export function MergePanel({
  files,
  values,
  onChange,
  setFileOrder,
}: ToolPanelProps) {
  const { t } = useI18n();

  const ranges = useMemo(() => {
    const raw = values.fileRanges;
    if (typeof raw !== "string" || raw.length === 0) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object") return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>
      )) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }, [values.fileRanges]);

  const setRange = (id: string, value: string) => {
    onChange("fileRanges", JSON.stringify({ ...ranges, [id]: value }));
  };

  const sortBy = (compare: (a: File, b: File) => number) => {
    setFileOrder(
      [...files].sort((a, b) => compare(a.file, b.file))
    );
  };

  const sortButtons = [
    {
      key: "az" as const,
      icon: ArrowDownAZ,
      label: t("merge.sortAZ"),
      onClick: () =>
        sortBy((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    },
    {
      key: "za" as const,
      icon: ArrowUpAZ,
      label: t("merge.sortZA"),
      onClick: () =>
        sortBy((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })),
    },
    {
      key: "date" as const,
      icon: CalendarClock,
      label: t("merge.sortDate"),
      onClick: () => sortBy((a, b) => b.lastModified - a.lastModified),
    },
  ];

  return (
    <section aria-label={t("merge.panelTitle")} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Files className="size-3.5" aria-hidden="true" />
          {t("merge.panelTitle")}
        </h3>
        <span className="text-[11px] text-muted-foreground">
          {t("merge.fileCount", { count: files.length })}
        </span>
      </div>

      {files.length === 0 ? (
        <p className="rounded-btn border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          {t("merge.emptyHint")}
        </p>
      ) : (
        <>
          <div
            role="group"
            aria-label={t("merge.sortLabel")}
            className="flex flex-wrap gap-1.5"
          >
            {sortButtons.map(({ key, icon: Icon, label, onClick }) => (
              <Button
                key={key}
                type="button"
                variant="outline"
                size="sm"
                onClick={onClick}
                className="h-9 rounded-btn px-2.5 text-xs"
              >
                <Icon className="size-3.5" aria-hidden="true" />
                {label}
              </Button>
            ))}
          </div>

          <ul className="scrollbar-thin flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-1">
            {files.map((item, index) => (
              <li
                key={item.id}
                className="flex items-center gap-2 rounded-btn border border-border bg-background px-2 py-1.5 transition-colors hover:border-primary/30"
              >
                <span
                  aria-hidden="true"
                  className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary"
                >
                  {index + 1}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-xs text-foreground"
                  title={item.file.name}
                >
                  {item.file.name}
                </span>
                <Input
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  inputMode="text"
                  value={ranges[item.id] ?? ""}
                  placeholder={t("merge.rangePlaceholder")}
                  onChange={(event) => setRange(item.id, event.target.value)}
                  aria-label={t("merge.rangeLabel", { name: item.file.name })}
                  className={cn(
                    "h-9 w-24 shrink-0 rounded-btn px-2 text-xs font-medium"
                  )}
                />
              </li>
            ))}
          </ul>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("merge.rangeHint")}
          </p>
        </>
      )}
    </section>
  );
}
