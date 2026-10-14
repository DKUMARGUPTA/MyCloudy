"use client";

import { useEffect, useMemo, useState } from "react";
import { Scissors, TriangleAlert } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import { getPdfPageCount } from "@/lib/pdf/thumbnails";
import { parsePageSpec } from "@/lib/workers/protocol";
import { cn } from "@/lib/utils";
import { resolveHalveOptions } from "./engine";

/**
 * Halve PDF pages — visual cut explainer (PRD §8.1 "Cut scanned book
 * spreads"). A page diagram with the live cut line: the halves, their
 * output order (1st / 2nd), the cut position and the reverse flag all
 * update straight from the current option values — the same resolve*
 * the worker uses, so the diagram can never disagree with the output.
 * A full thumbnail preview would duplicate the N-up panel's machinery;
 * this explainer stays tiny, instant and works before any file is added.
 */

export function HalvePanel({ files, values }: ToolPanelProps) {
  const { t } = useI18n();
  const file = files.length > 0 ? files[0].file : null;

  const opts = useMemo(() => resolveHalveOptions(values), [values]);
  const vertical = opts.cut === "vertical";

  const [pageCountState, setPageCountState] = useState<{
    file: File;
    count: number;
  } | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void getPdfPageCount(file)
      .then((count) => {
        if (!cancelled) setPageCountState({ file, count });
      })
      .catch(() => {
        if (!cancelled) setPageCountState({ file, count: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const countReady =
    file !== null && pageCountState !== null && pageCountState.file === file;
  const indices = useMemo(() => {
    if (!countReady || pageCountState === null || pageCountState.count < 1) {
      return null;
    }
    return parsePageSpec(opts.pages, pageCountState.count);
  }, [countReady, pageCountState, opts.pages]);
  const rangeInvalid = countReady && indices === null;

  // Which displayed half is output first (drives both labels + the a11y text).
  const firstIsLeft = vertical ? opts.verticalOrder === "left" : false;
  const firstIsTop = !vertical ? opts.horizontalOrder === "top" : false;
  const whichFirst = vertical
    ? opts.verticalOrder === "left"
      ? t("halve.whichLeft")
      : t("halve.whichRight")
    : opts.horizontalOrder === "top"
      ? t("halve.whichTop")
      : t("halve.whichBottom");

  const desc = vertical
    ? t("halve.descVertical", { pos: opts.positionPct, which: whichFirst })
    : t("halve.descHorizontal", { pos: opts.positionPct, which: whichFirst });

  const pos = `${opts.positionPct}%`;

  const firstChip = (
    <span className="flex size-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground shadow-sm">
      1
    </span>
  );
  const secondChip = (
    <span className="flex size-6 items-center justify-center rounded-full border border-border bg-background text-xs font-bold text-muted-foreground">
      2
    </span>
  );

  return (
    <section
      aria-label={t("halve.previewTitle")}
      className="flex flex-col gap-2.5 rounded-card border border-border bg-card p-3"
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="text-primary" aria-hidden="true">
          <Scissors className="size-3.5" />
        </span>
        {t("halve.previewTitle")}
      </p>

      {/* The page diagram — one img for assistive tech, described by `desc`. */}
      <div
        role="img"
        aria-label={desc}
        className="relative w-full overflow-hidden rounded-btn border border-border bg-muted/30"
      >
        <div
          className={cn(
            "flex",
            vertical ? "aspect-[3/2] flex-row" : "aspect-[2/3] flex-col"
          )}
        >
          {/* First displayed half (left / top). */}
          <div
            style={vertical ? { width: pos } : { height: pos }}
            className={cn(
              "relative flex items-center justify-center transition-[width,height] duration-200 motion-reduce:transition-none",
              firstIsLeft || firstIsTop
                ? "border-primary/40 bg-primary/10"
                : "border-border bg-muted/50"
            )}
          >
            {firstIsLeft || firstIsTop ? firstChip : secondChip}
          </div>
          {/* Second displayed half (right / bottom). */}
          <div
            className={cn(
              "relative flex min-w-0 flex-1 items-center justify-center",
              firstIsLeft || firstIsTop
                ? "border-border bg-muted/50"
                : "border-primary/40 bg-primary/10"
            )}
          >
            {firstIsLeft || firstIsTop ? secondChip : firstChip}
          </div>
        </div>
        {/* The cut line, following the live position. */}
        <div
          aria-hidden="true"
          style={vertical ? { left: pos } : { top: pos }}
          className={cn(
            "absolute transition-[left,top] duration-200 motion-reduce:transition-none",
            vertical
              ? "top-0 bottom-0 -translate-x-1/2 border-l-2 border-dashed border-primary"
              : "left-0 right-0 -translate-y-1/2 border-t-2 border-dashed border-primary"
          )}
        />
        <span
          aria-hidden="true"
          style={vertical ? { left: pos } : { top: pos }}
          className={cn(
            "absolute flex size-6 items-center justify-center rounded-full border border-primary/50 bg-background text-primary shadow-sm transition-[left,top] duration-200 motion-reduce:transition-none",
            vertical ? "top-1/2 -translate-x-1/2 -translate-y-1/2" : "left-1/2 -translate-x-1/2 -translate-y-1/2"
          )}
        >
          <Scissors
            className={cn("size-3", !vertical && "rotate-90")}
            aria-hidden="true"
          />
        </span>
      </div>

      {/* Legend + live output count. */}
      <ul className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        <li className="flex items-center gap-1.5">
          {firstChip}
          <span>
            {t("halve.legendFirst")} —{" "}
            {vertical
              ? opts.verticalOrder === "left"
                ? t("halve.whichLeft")
                : t("halve.whichRight")
              : opts.horizontalOrder === "top"
                ? t("halve.whichTop")
                : t("halve.whichBottom")}
          </span>
        </li>
        <li className="flex items-center gap-1.5">
          {secondChip}
          <span>
            {t("halve.legendSecond")} —{" "}
            {vertical
              ? opts.verticalOrder === "left"
                ? t("halve.whichRight")
                : t("halve.whichLeft")
              : opts.horizontalOrder === "top"
                ? t("halve.whichBottom")
                : t("halve.whichTop")}
          </span>
        </li>
      </ul>

      {opts.reverse ? (
        <p className="rounded-btn border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-[11px] font-medium text-primary">
          {t("halve.reverseNote")}
        </p>
      ) : null}

      {rangeInvalid ? (
        <p className="flex items-start gap-2 rounded-btn border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {t("wm.rangeInvalid")}
        </p>
      ) : null}

      {indices !== null ? (
        <p className="text-[11px] font-medium text-muted-foreground">
          {t("halve.count", {
            before: indices.length,
            after: indices.length * 2,
          })}
        </p>
      ) : null}
    </section>
  );
}
