"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Braces,
  FileClock,
  Loader2,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { getPdfDocInfo, getPdfPageCount } from "@/lib/pdf/thumbnails";
import { cn } from "@/lib/utils";
import { PreviewFileHeader } from "../stamp-common/preview-parts";
import {
  type DocInfoRead,
  afterValue,
  docInfoHasChanges,
  formatMetaDate,
  resolveDocInfoEdits,
} from "../meta-common/meta";

/**
 * Doc info live surface (PRD §8.2 "Change document information"): a
 * before/after preview of the file's document information. The BEFORE card
 * shows what pdf.js found in the file; the AFTER card shows exactly what the
 * worker will write for every field the form touched (the panel owns the
 * editing). Runs fully on-device — metadata reads use the shared cached
 * pdf.js document, nothing is ever uploaded.
 */

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

type FieldKey =
  | "title"
  | "author"
  | "subject"
  | "keywords"
  | "creator"
  | "producer";

const FIELD_LABEL_KEYS: Record<FieldKey, string> = {
  title: "meta.fTitle",
  author: "meta.fAuthor",
  subject: "meta.fSubject",
  keywords: "meta.fKeywords",
  creator: "meta.fCreator",
  producer: "meta.fProducer",
};

const FIELD_KEYS: FieldKey[] = [
  "title",
  "author",
  "subject",
  "keywords",
  "creator",
  "producer",
];

function CardShell({
  icon,
  title,
  accent,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  accent: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-card border bg-card",
        accent
          ? "border-primary/40 shadow-[0_1px_10px_-4px_rgb(var(--color-primary)/0.25)]"
          : "border-border"
      )}
    >
      <p
        className={cn(
          "flex items-center gap-2 border-b px-4 py-2.5 text-xs font-semibold",
          accent
            ? "border-primary/25 bg-primary/[0.06] text-primary"
            : "border-border/60 bg-muted/40 text-muted-foreground"
        )}
      >
        <span aria-hidden="true">{icon}</span>
        {title}
      </p>
      <dl className="flex flex-col divide-y divide-border/60">{children}</dl>
    </div>
  );
}

function Row({
  label,
  children,
  muted,
}: {
  label: string;
  children: React.ReactNode;
  muted?: boolean;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-3 px-4 py-2.5 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
      <dt
        className={cn(
          "pt-0.5 text-[11px] font-semibold uppercase tracking-wide",
          muted ? "text-muted-foreground/70" : "text-muted-foreground"
        )}
      >
        {label}
      </dt>
      <dd className="min-w-0 text-sm break-words text-foreground">
        {children}
      </dd>
    </div>
  );
}

function EmptyValue({ t }: { t: (key: string) => string }): React.JSX.Element {
  return <span className="text-muted-foreground/60">{t("meta.empty")}</span>;
}

function RemovedChip({ t }: { t: (key: string) => string }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-muted-foreground/50 line-through decoration-muted-foreground/40">
        —
      </span>
      <span className="rounded-full border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
        {t("meta.willRemove")}
      </span>
    </span>
  );
}

export function DocInfoSurface({
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

  const edits = useMemo(() => resolveDocInfoEdits(values), [values]);

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
      if (!cancelled) setSnap({ file, read: EMPTY_READ, pageCount: 0, error: true });
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const active = snap !== null && snap.file === file ? snap : null;
  const snapshot = active?.read ?? null;
  const snapError = active?.error === true;
  const pageCount = active?.pageCount ?? 0;

  // CTA gating (amber reason in the sticky bar): blocked while the
  // document is being read, after a read failure, or until something
  // actually changes.
  const blockedKey = !file
    ? null
    : snapError
      ? "meta.readError"
      : snapshot === null
        ? "meta.ctaReading"
        : docInfoHasChanges(edits, snapshot)
          ? null
          : "meta.ctaNoChanges";
  useEffect(() => {
    setRunBlocked(blockedKey);
    return () => setRunBlocked(null);
  }, [blockedKey, setRunBlocked]);

  const removeFile = useCallback((): void => {
    setFileOrder([]);
  }, [setFileOrder]);

  if (!file) return null;

  const loading = snapshot === null && !snapError;
  const read = snapshot ?? EMPTY_READ;

  const changedCount = FIELD_KEYS.filter(
    (key) => afterValue(edits[key], read[key]).changed
  ).length;
  const removedCount = FIELD_KEYS.filter(
    (key) => edits[key] === "" && read[key] !== ""
  ).length;

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
          {t("meta.loading")}
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
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* BEFORE */}
            <CardShell
              icon={<FileClock className="size-3.5" />}
              title={t("meta.beforeCard")}
              accent={false}
            >
              {FIELD_KEYS.map((key) => (
                <Row key={key} label={t(FIELD_LABEL_KEYS[key])}>
                  {read[key] !== "" ? read[key] : <EmptyValue t={t} />}
                </Row>
              ))}
              <Row label={t("meta.fCreated")}>
                {formatMetaDate(read.creationDate, locale) || (
                  <EmptyValue t={t} />
                )}
              </Row>
              <Row label={t("meta.fModified")}>
                {formatMetaDate(read.modificationDate, locale) || (
                  <EmptyValue t={t} />
                )}
              </Row>
              {read.custom.map((entry) => (
                <Row key={entry.key} label={entry.key} muted>
                  {entry.value}
                </Row>
              ))}
              <Row label={t("meta.fXmp")}>
                {read.hasXmp ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Braces
                      className="size-3.5 text-muted-foreground"
                      aria-hidden="true"
                    />
                    {t("meta.xmpPresent")}
                  </span>
                ) : (
                  <EmptyValue t={t} />
                )}
              </Row>
            </CardShell>

            {/* AFTER */}
            <CardShell
              icon={<Sparkles className="size-3.5" />}
              title={t("meta.afterCard")}
              accent
            >
              {FIELD_KEYS.map((key) => {
                const after = afterValue(edits[key], read[key]);
                return (
                  <Row key={key} label={t(FIELD_LABEL_KEYS[key])}>
                    {after.value !== "" ? (
                      <span
                        className={cn(
                          after.changed &&
                            "font-medium text-primary underline decoration-primary/30 decoration-dotted underline-offset-4"
                        )}
                      >
                        {after.value}
                      </span>
                    ) : after.changed ? (
                      <RemovedChip t={t} />
                    ) : (
                      <EmptyValue t={t} />
                    )}
                  </Row>
                );
              })}
              <Row label={t("meta.fCreated")}>
                {edits.creationMode === "remove" ? (
                  <RemovedChip t={t} />
                ) : edits.creationMode === "now" ? (
                  <span className="font-medium text-primary">
                    {t("meta.dateNow")}
                  </span>
                ) : (
                  formatMetaDate(read.creationDate, locale) || <EmptyValue t={t} />
                )}
              </Row>
              <Row label={t("meta.fModified")}>
                {edits.modMode === "remove" ? (
                  <RemovedChip t={t} />
                ) : edits.modMode === "now" ? (
                  <span className="font-medium text-primary">
                    {t("meta.dateNow")}
                  </span>
                ) : (
                  formatMetaDate(read.modificationDate, locale) || <EmptyValue t={t} />
                )}
              </Row>
              {read.custom.length > 0 ? (
                <Row label={t("meta.customKept")} muted>
                  {edits.stripCustom ? (
                    <RemovedChip t={t} />
                  ) : (
                    <span className="text-muted-foreground/70">
                      {t("meta.unchangedCount", { count: read.custom.length })}
                    </span>
                  )}
                </Row>
              ) : null}
              <Row label={t("meta.fXmp")}>
                {read.hasXmp && edits.stripXmp ? (
                  <RemovedChip t={t} />
                ) : read.hasXmp ? (
                  t("meta.xmpPresent")
                ) : (
                  <EmptyValue t={t} />
                )}
              </Row>
            </CardShell>
          </div>

          {/* Change summary chips */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-chip border border-border bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              {changedCount > 0
                ? t("meta.chipChanged", { count: changedCount })
                : t("meta.chipNoChanges")}
            </span>
            {removedCount > 0 ? (
              <span className="rounded-chip border border-border bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                {t("meta.chipRemoved", { count: removedCount })}
              </span>
            ) : null}
            {read.hasXmp && edits.stripXmp ? (
              <span className="rounded-chip border border-border bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                {t("meta.chipXmp")}
              </span>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
