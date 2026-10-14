"use client";

import { useId } from "react";
import { Bookmark, BookmarkMinus } from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import { countNodes, normalizeTree, treeDepth } from "./engine";

/**
 * Bookmark PDF options panel — a live summary of the tree the surface is
 * editing (the serialized "tree" option is the single source of truth):
 * item count, nesting depth and an honest "the run replaces the existing
 * outline" reminder. Every control lives in the surface.
 */
export function BookmarkPanel({ files, values }: ToolPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const uid = useId();

  // The tree rides the option payload the surface writes; the panel only
  // reads it. Page count for validation comes from the (single) file —
  // the probe wrote it into the serialized pages already, so a pure
  // recount here is honest without touching pdf.js again.
  const tree = normalizeTree(
    typeof values.tree === "string" ? values.tree : "",
    // pageCount unknown here — use a permissive bound; validity details
    // are owned by the surface + worker anyway.
    100000
  );
  const count = countNodes(tree);
  const depth = treeDepth(tree);
  const hasFile = files.length > 0;

  return (
    <section
      aria-labelledby={`${uid}-bm-title`}
      className="flex flex-col gap-3"
    >
      <h3
        id={`${uid}-bm-title`}
        className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        <Bookmark className="size-3.5" aria-hidden="true" />
        {t("bm.panelTitle")}
      </h3>

      {hasFile ? (
        <ul className="flex flex-col gap-1.5 text-xs">
          <li className="flex items-center justify-between gap-2 rounded-btn border border-border bg-card px-3 py-2">
            <span className="text-muted-foreground">{t("bm.countLabel")}</span>
            <span className="font-semibold tabular-nums text-foreground">{count}</span>
          </li>
          {count > 0 ? (
            <li className="flex items-center justify-between gap-2 rounded-btn border border-border bg-card px-3 py-2">
              <span className="text-muted-foreground">{t("bm.depthLabel")}</span>
              <span className="font-semibold tabular-nums text-foreground">{depth}</span>
            </li>
          ) : null}
          <li className="flex items-start gap-2 rounded-btn border border-dashed border-border bg-muted/20 px-3 py-2 leading-relaxed text-muted-foreground">
            <BookmarkMinus className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t("bm.replaceNote")}
          </li>
        </ul>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("bm.panelEmpty")}
        </p>
      )}
    </section>
  );
}

export default BookmarkPanel;
