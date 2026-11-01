"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckSquare, Loader2, Search, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { formatBytes } from "@/lib/storage/recent-files";
import { measureStdText } from "@/lib/own/pdf";
import { parseHexColor } from "../add-watermark/wm-options";
import type { HarvestPiece } from "../edit-pdf/model";
import { scanPagesText } from "../edit-pdf/text-layer";
import {
  buildEditOp,
  findLines,
  groupLines,
  type EditableLine,
} from "./engine";

/**
 * Edit PDF text surface (PHASE-7): the focused typo-fixer.
 *
 *  1. One file in → the editor's pdf.js text layer harvests every page
 *     (capped, progress-honest) into visual lines — cached per file.
 *  2. Search box filters lines live; each match card is a checkbox.
 *  3. The replacement + cover color + checked lines become the edits
 *     blob (the editor's option-value pattern) — the shell CTA bakes
 *     them with the worker.
 */

const MAX_PAGES = 100;
const MAX_MATCHES_SHOWN = 50;

export function EditTextSurface(props: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const { files, values, onChange, setRunBlocked } = props;
  const fileRef = files[0] ?? null;
  const file = fileRef?.file ?? null;

  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState(false);
  const [lines, setLines] = useState<EditableLine[] | null>(null);
  const [unchecked, setUnchecked] = useState<Set<number>>(new Set());

  // Reset per-file state during RENDER (the documented "adjust state
  // when a prop changes" pattern) — the effect below stays async-only,
  // per react-hooks/set-state-in-effect.
  const [prevFile, setPrevFile] = useState<File | null>(null);
  if (prevFile !== file) {
    setPrevFile(file);
    setScanning(file !== null);
    setScanError(false);
    setLines(null);
    setUnchecked(new Set());
  }

  // Async harvest when the file changes (cancellation-safe).
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    scanPagesText(file, MAX_PAGES)
      .then((pages) => {
        if (cancelled) return;
        const all: EditableLine[] = [];
        pages.forEach((pieces: HarvestPiece[], page: number) => {
          for (const line of groupLines(pieces, page)) all.push(line);
        });
        setLines(all);
      })
      .catch(() => {
        if (!cancelled) setScanError(true);
      })
      .finally(() => {
        if (!cancelled) setScanning(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const query = typeof values["query"] === "string" ? values["query"] : "";
  const replacement =
    typeof values["replacement"] === "string" ? values["replacement"] : "";
  const background =
    typeof values["background"] === "string" ? values["background"] : "#FFFFFF";

  const matches = useMemo(
    () => (lines ? findLines(lines, query) : []),
    [lines, query]
  );

  const keyOf = (m: EditableLine): number =>
    m.page * 100000 + Math.floor(m.baseline);

  // Derived checked state: matches start CHECKED; the user's UNchecks
  // live in a set that event handlers own (React-19 rule: no state
  // writes outside events).
  const shownMatches = useMemo(
    () => matches.slice(0, MAX_MATCHES_SHOWN),
    [matches]
  );
  const checkedCount = useMemo(
    () => shownMatches.filter((m) => !unchecked.has(keyOf(m))).length,
    [shownMatches, unchecked]
  );
  const isChecked = useCallback(
    (m: EditableLine): boolean => !unchecked.has(keyOf(m)),
    [unchecked]
  );

  // The edits blob is DERIVED: checked lines × replacement, auto-fitted.
  const editsBlob = useMemo(() => {
    if (matches.length === 0) return "";
    const bg = parseHexColor(background) ?? { r: 1, g: 1, b: 1 };
    const ops = shownMatches
      .filter((m) => !unchecked.has(keyOf(m)))
      .map((m) =>
        buildEditOp(m, replacement, (text, font, size) =>
          measureStdText(
            text,
            font.font === "times"
              ? "times"
              : font.font === "courier"
                ? "courier"
                : "helvetica",
            size
          ),
          bg
        )
      );
    return ops.length === 0 ? "" : JSON.stringify(ops);
  }, [shownMatches, unchecked, replacement, background, matches.length]);

  useEffect(() => {
    onChange("edits", editsBlob);
  }, [editsBlob, onChange]);

  // Gate the CTA: nothing to apply yet.
  useEffect(() => {
    if (!file || scanning || scanError) {
      setRunBlocked("ept.blockedScan");
      return;
    }
    if (checkedCount === 0 || replacement.trim().length === 0) {
      setRunBlocked("ept.blockedPick");
      return;
    }
    setRunBlocked(null);
    return () => setRunBlocked(null);
  }, [file, scanning, scanError, checkedCount, replacement, setRunBlocked]);

  const toggle = useCallback((key: number) => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (!file) {
    return (
      <div className="space-y-4">
        <DropZone
          labelKey="tool.selectPdfFiles"
          acceptKind="pdf"
          multiple={false}
          maxFiles={1}
          onAccept={props.addFiles}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {file.name} · {formatBytes(file.size)}
      </p>

      {scanning ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {t("ept.scanning")}
        </p>
      ) : scanError ? (
        <p className="text-sm text-destructive">{t("ept.scanError")}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1 text-sm">
            <span className="font-medium">{t("ept.find")}</span>
            <Input
              value={query}
              onChange={(e) => onChange("query", e.target.value)}
              placeholder={t("ept.findPlaceholder")}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">{t("ept.replace")}</span>
            <Input
              value={replacement}
              onChange={(e) => onChange("replacement", e.target.value)}
              placeholder={t("ept.replacePlaceholder")}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">{t("ept.cover")}</span>
            <Input
              value={background}
              onChange={(e) => onChange("background", e.target.value)}
              placeholder="#FFFFFF"
            />
          </label>
        </div>
      )}

      {lines && !scanning && (
        <>
          <p className="text-sm text-muted-foreground" role="status">
            {query.trim().length === 0
              ? t("ept.typeToSearch")
              : matches.length === 0
                ? t("ept.noMatches")
                : t("ept.matchCount", { n: matches.length })}
          </p>
          <ul className="max-h-96 overflow-y-auto rounded-chip border border-border bg-background p-2">
            {shownMatches.map((m) => {
              const key = m.page * 100000 + Math.floor(m.baseline);
              const thisChecked = isChecked(m);
              const lower = m.text.toLowerCase();
              const q = query.trim().toLowerCase();
              const at = q.length > 0 ? lower.indexOf(q) : -1;
              return (
                <li key={`${m.page}-${m.baseline}`}>
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    aria-pressed={thisChecked}
                    className="flex w-full items-start gap-2 rounded-chip px-2 py-1.5 text-left text-sm hover:bg-muted"
                  >
                    {thisChecked ? (
                      <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                    ) : (
                      <Square className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <span className="min-w-0">
                      <span className="mr-2 rounded-chip bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {t("ept.pageTag", { n: m.page + 1 })}
                      </span>
                      {at >= 0 ? (
                        <>
                          {m.text.slice(0, at)}
                          <mark className="rounded-chip bg-amber-500/20 px-0.5">
                            {m.text.slice(at, at + q.length)}
                          </mark>
                          {m.text.slice(at + q.length)}
                        </>
                      ) : (
                        m.text
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Search className="h-3.5 w-3.5" aria-hidden />
            {t("ept.readyHint", {
              n: checkedCount,
              replacement: replacement.trim().length > 0 ? replacement.trim() : "…",
            })}
          </p>
        </>
      )}
    </div>
  );
}
