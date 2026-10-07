"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Braces,
  Loader2,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { getPdfDocInfo, getPdfPageCount } from "@/lib/pdf/thumbnails";
import { cn } from "@/lib/utils";
import { PreviewFileHeader } from "../stamp-common/preview-parts";
import {
  type DocInfoRead,
  RM_IDS,
  formatMetaDate,
} from "../meta-common/meta";

/**
 * Remove metadata live surface (PRD §8.3 "Preview of found metadata"):
 * the honest report of everything the file carries — the six standard
 * fields, both dates, custom entries and the XMP block — each with its
 * "will be removed" state, plus the after-picture ("All N fields removed").
 * On-device, metadata reads via the shared cached pdf.js document.
 */

const FIELD_LABEL_KEYS: { key: keyof DocInfoRead; label: string }[] = [
  { key: "title", label: "meta.fTitle" },
  { key: "author", label: "meta.fAuthor" },
  { key: "subject", label: "meta.fSubject" },
  { key: "keywords", label: "meta.fKeywords" },
  { key: "creator", label: "meta.fCreator" },
  { key: "producer", label: "meta.fProducer" },
];

const EMPTY_READ: DocInfoRead = {
  title: "",
  author: "",
  subject: "",
  keywords: "",
  creator: "",
  producer: "",
  creationDate: null,
  modificationDate: null,
  custom: [],
  hasXmp: false,
};

/** The "will be removed" tag — same style as the doc-info AFTER card. */
function WillRemoveChip({ t }: { t: (key: string) => string }): React.JSX.Element {
  return (
    <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-300">
      {t("rmeta.willRemove")}
    </span>
  );
}

/** One report row (field / date / custom / XMP) with its trailing tag. */
function ReportRow({
  label,
  value,
  tag,
  dimmed,
}: {
  label: string;
  value: React.ReactNode;
  tag: React.ReactNode;
  dimmed?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-start gap-3 px-4 py-2.5 sm:grid-cols-[7.5rem_minmax(0,1fr)_auto]",
        dimmed && "opacity-60"
      )}
    >
      <dt className="pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-sm text-foreground">{value}</dd>
      <dd className="pt-0.5">{tag}</dd>
    </div>
  );
}

function textOf(snapshot: DocInfoRead, key: keyof DocInfoRead): string {
  const value = snapshot[key];
  return typeof value === "string" ? value : "";
}

export function RemoveMetaSurface({
  files,
  values,
  setFileOrder,
  setRunBlocked,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t, locale } = useI18n();
  const fileMeta = files[0];
  const file = fileMeta?.file ?? null;

  // Snapshot + page count, tagged with the file they belong to — the file
  // identity replaces any "reset on file change" (lint-clean, and stale
  // data for a swapped file never renders).
  const [snap, setSnap] = useState<
    { file: File; read: DocInfoRead; pageCount: number; error: boolean } | null
  >(null);

  const alsoXmp = values[RM_IDS.alsoXmp] !== false;

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      const [read, count] = await Promise.all([
        getPdfDocInfo(file),
        getPdfPageCount(file),
      ]);
      if (cancelled) return;
      setSnap({ file, read, pageCount: count, error: false });
    })().catch(() => {
      if (!cancelled)
        setSnap({ file, read: EMPTY_READ, pageCount: 0, error: true });
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const active = snap !== null && snap.file === file ? snap : null;
  const snapshot = active?.read ?? null;
  const snapError = active?.error === true;
  const pageCount = active?.pageCount ?? 0;

  // What the run will remove (drives the summary + CTA gating).
  const found = useMemo(() => {
    if (!snapshot) return null;
    const fields: string[] = [];
    for (const { key, label } of FIELD_LABEL_KEYS) {
      if (textOf(snapshot, key) !== "") fields.push(t(label));
    }
    const dates: string[] = [];
    if (snapshot.creationDate !== null) dates.push(t("meta.fCreated"));
    if (snapshot.modificationDate !== null) dates.push(t("meta.fModified"));
    const customCount = snapshot.custom.length;
    const xmpWanted = snapshot.hasXmp && alsoXmp;
    const total =
      fields.length +
      dates.length +
      customCount +
      (xmpWanted ? 1 : 0);
    return { fields, dates, customCount, xmpWanted, total };
  }, [snapshot, alsoXmp, t]);

  // CTA gating: blocked while reading, after a read failure, or when there
  // is genuinely nothing to remove (the honest "already clean" state).
  const blockedKey = !file
    ? null
    : snapError
      ? "meta.readError"
      : snapshot === null
        ? "meta.ctaReading"
        : found !== null && found.total === 0
          ? "rmeta.ctaNothing"
          : null;

  useEffect(() => {
    setRunBlocked(blockedKey);
    return () => setRunBlocked(null);
  }, [blockedKey, setRunBlocked]);

  const removeFile = useCallback((): void => {
    setFileOrder([]);
  }, [setFileOrder]);

  if (!file) return null;

  const loading = snapshot === null && !snapError;

  return (
    <div className="flex flex-col gap-3">
      <PreviewFileHeader
        file={file}
        pageCount={pageCount}
        onRemove={removeFile}
      />

      {loading ? (
        <div
          className="flex items-center gap-3 rounded-card border border-border bg-card px-4 py-8 text-sm text-muted-foreground"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("rmeta.loading")}
        </div>
      ) : snapError ? (
        <div
          className="flex items-center gap-3 rounded-card border border-border bg-card px-4 py-8 text-sm text-muted-foreground"
          role="alert"
        >
          <TriangleAlert
            className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          {t("meta.readError")}
        </div>
      ) : found !== null && found.total === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-card border border-border bg-card px-4 py-10 text-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </span>
          <p className="text-sm font-semibold text-foreground">
            {t("rmeta.empty")}
          </p>
          <p className="max-w-sm text-xs text-muted-foreground">
            {t("rmeta.emptyHint")}
          </p>
        </div>
      ) : snapshot !== null && found !== null ? (
        <>
          {/* Found-fields report */}
          <div className="overflow-hidden rounded-card border border-border bg-card">
            <p className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
              <Trash2 className="size-3.5" aria-hidden="true" />
              {t("rmeta.foundCard")}
            </p>
            <dl className="flex flex-col divide-y divide-border/60">
              {FIELD_LABEL_KEYS.filter(({ key }) => textOf(snapshot, key) !== "").map(
                ({ key, label }) => (
                  <ReportRow
                    key={key}
                    label={t(label)}
                    value={textOf(snapshot, key)}
                    tag={<WillRemoveChip t={t} />}
                  />
                )
              )}
              {snapshot.creationDate !== null ? (
                <ReportRow
                  label={t("meta.fCreated")}
                  value={formatMetaDate(snapshot.creationDate, locale)}
                  tag={<WillRemoveChip t={t} />}
                />
              ) : null}
              {snapshot.modificationDate !== null ? (
                <ReportRow
                  label={t("meta.fModified")}
                  value={formatMetaDate(snapshot.modificationDate, locale)}
                  tag={<WillRemoveChip t={t} />}
                />
              ) : null}
              {snapshot.custom.map((entry) => (
                <ReportRow
                  key={entry.key}
                  label={entry.key}
                  value={entry.value}
                  tag={<WillRemoveChip t={t} />}
                />
              ))}
              {snapshot.hasXmp ? (
                <ReportRow
                  dimmed={!alsoXmp}
                  label={t("meta.fXmp")}
                  value={
                    <span className="inline-flex items-center gap-1.5">
                      <Braces className="size-3.5 text-muted-foreground" aria-hidden="true" />
                      {t("rmeta.xmpRow")}
                    </span>
                  }
                  tag={
                    alsoXmp ? (
                      <WillRemoveChip t={t} />
                    ) : (
                      <span className="rounded-full border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                        {t("rmeta.kept")}
                      </span>
                    )
                  }
                />
              ) : null}
            </dl>
          </div>

          {/* After summary */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-chip border border-primary/30 bg-primary/[0.06] px-2.5 py-1 text-[11px] font-semibold text-primary">
              {t("rmeta.afterLine", { count: found.total })}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {t("rmeta.untouched")}
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}
