"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Boxes,
  FileStack,
  Layers,
  Loader2,
  PackageCheck,
  Recycle,
  ShieldCheck,
  TriangleAlert,
  Zap,
} from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { getPdfDocInfo, getPdfPageCount } from "@/lib/pdf/thumbnails";
import { formatBytes } from "@/lib/storage/recent-files";
import { cn } from "@/lib/utils";
import { PreviewFileHeader } from "../stamp-common/preview-parts";
import { type DocInfoRead } from "../meta-common/meta";

/**
 * Web optimize PDF surface (RB3-b): the honest BEFORE report — file size,
 * pages, compressed-stream count, whether the file already uses object
 * streams, and the metadata actually present (XMP + app Producer/Creator)
 * each tagged Kept / Will be stripped by the switch — plus the plan card
 * that says exactly what the run will do. No fake numbers: the exact
 * before/after stats come from the worker after the run (result view).
 * On-device, reads via the shared cached pdf.js document + one byte scan.
 */

/** Option ids — mirrors config.ts (kept local so the engine's pdf-lib
 *  + fflate graph never loads on the main thread). */
const OPT = {
  objectStreams: "objectStreams",
  recompress: "recompress",
  stripMetadata: "stripMetadata",
} as const;

interface ScanState {
  file: File;
  read: DocInfoRead;
  pageCount: number;
  flateStreams: number;
  hasObjStm: boolean;
  error: boolean;
}

/** Counts a literal ASCII pattern in the file bytes (the smoke's oracle). */
function countPattern(bytes: Uint8Array, pattern: string): number {
  const m = pattern.length;
  let count = 0;
  outer: for (let i = 0; i + m <= bytes.length; i += 1) {
    for (let j = 0; j < m; j += 1) {
      if (bytes[i + j] !== pattern.charCodeAt(j)) continue outer;
    }
    count += 1;
  }
  return count;
}

function KeepStripChip({ strip }: { strip: boolean }): React.JSX.Element {
  const { t } = useI18n();
  return strip ? (
    <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-300">
      {t("wopt.willStrip")}
    </span>
  ) : (
    <span className="rounded-full border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
      {t("wopt.kept")}
    </span>
  );
}

/** One report row (label / value / trailing chip). */
function ReportRow({
  label,
  value,
  chip,
  dimmed,
}: {
  label: string;
  value: React.ReactNode;
  chip?: React.ReactNode;
  dimmed?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "grid grid-cols-[7rem_minmax(0,1fr)_auto] items-start gap-3 px-4 py-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)_auto]",
        dimmed && "opacity-60"
      )}
    >
      <dt className="pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-sm text-foreground">{value}</dd>
      <dd className="pt-0.5">{chip}</dd>
    </div>
  );
}

export function WebOptimizeSurface({
  files,
  values,
  setFileOrder,
  setRunBlocked,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const fileMeta = files[0];
  const file = fileMeta?.file ?? null;

  const objStmOn = values[OPT.objectStreams] !== false;
  const recompressOn = values[OPT.recompress] !== false;
  const stripMeta = values[OPT.stripMetadata] === true;

  const [snap, setSnap] = useState<ScanState | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      try {
        const [read, pageCount, bytes] = await Promise.all([
          getPdfDocInfo(file),
          getPdfPageCount(file),
          file.arrayBuffer(),
        ]);
        if (cancelled) return;
        const raw = new Uint8Array(bytes);
        setSnap({
          file,
          read,
          pageCount,
          flateStreams: countPattern(raw, "/FlateDecode"),
          hasObjStm: countPattern(raw, "/ObjStm") > 0,
          error: false,
        });
      } catch {
        if (!cancelled)
          setSnap({
            file,
            read: {
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
            },
            pageCount: 0,
            flateStreams: 0,
            hasObjStm: false,
            error: true,
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  const active = snap !== null && snap.file === file ? snap : null;
  const reading = active === null;
  const readError = active?.error === true;

  // CTA gating: blocked only while reading / after a read failure — a
  // structural tune-up always has something to do, never a "nothing here"
  // state (the numbers simply come after the run).
  const blockedKey = !file
    ? null
    : reading
      ? "wopt.ctaReading"
      : readError
        ? "wopt.readError"
        : null;

  useEffect(() => {
    setRunBlocked(blockedKey);
    return () => setRunBlocked(null);
  }, [blockedKey, setRunBlocked]);

  const removeFile = useCallback((): void => {
    setFileOrder([]);
  }, [setFileOrder]);

  if (!file) return null;

  const report = active && !readError ? active : null;
  const hasXmp = report?.read.hasXmp === true;
  const hasAppTags =
    report !== null &&
    (report.read.producer !== "" || report.read.creator !== "");

  const planRows: { icon: typeof Zap; text: string; dimmed: boolean }[] = [
    {
      icon: Boxes,
      text: objStmOn ? t("wopt.planObjStm") : t("wopt.planObjStmOff"),
      dimmed: !objStmOn,
    },
    {
      icon: Layers,
      text: recompressOn
        ? t("wopt.planRecompress", { count: report?.flateStreams ?? 0 })
        : t("wopt.planRecompressOff"),
      dimmed: !recompressOn,
    },
    {
      icon: ShieldCheck,
      text: stripMeta ? t("wopt.planMetaOn") : t("wopt.planMetaOff"),
      dimmed: !stripMeta,
    },
    { icon: Recycle, text: t("wopt.planGarbage"), dimmed: false },
  ];

  return (
    <div className="flex flex-col gap-3">
      <PreviewFileHeader
        file={file}
        pageCount={report?.pageCount ?? 0}
        onRemove={removeFile}
      />

      {reading ? (
        <div
          className="flex items-center gap-3 rounded-card border border-border bg-card px-4 py-8 text-sm text-muted-foreground"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("wopt.loading")}
        </div>
      ) : readError ? (
        <div
          className="flex items-center gap-3 rounded-card border border-border bg-card px-4 py-8 text-sm text-muted-foreground"
          role="alert"
        >
          <TriangleAlert
            className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          {t("wopt.readError")}
        </div>
      ) : report !== null ? (
        <>
          {/* BEFORE report — size, pages, compressed streams */}
          <div className="overflow-hidden rounded-card border border-border bg-card">
            <p className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
              <FileStack className="size-3.5" aria-hidden="true" />
              {t("wopt.reportTitle")}
            </p>
            <dl className="flex flex-col divide-y divide-border/60">
              <ReportRow
                label={t("wopt.statSize")}
                value={
                  <span className="font-semibold">
                    {formatBytes(file.size)}
                  </span>
                }
              />
              <ReportRow
                label={t("wopt.statPages")}
                value={report.pageCount}
              />
              <ReportRow
                label={t("wopt.statFlate")}
                value={report.flateStreams}
              />
              {report.hasObjStm ? (
                <ReportRow
                  dimmed
                  label={t("wopt.statObjStm")}
                  value={t("wopt.alreadyPacked")}
                />
              ) : null}
            </dl>
          </div>

          {/* Metadata actually present (Kept / Will be stripped chips) */}
          {hasXmp || hasAppTags ? (
            <div className="overflow-hidden rounded-card border border-border bg-card">
              <p className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
                <ShieldCheck className="size-3.5" aria-hidden="true" />
                {t("wopt.metaTitle")}
              </p>
              <dl className="flex flex-col divide-y divide-border/60">
                {hasXmp ? (
                  <ReportRow
                    dimmed={!stripMeta}
                    label={t("wopt.rowXmp")}
                    value={
                      <span className="text-muted-foreground">x:xmpmeta</span>
                    }
                    chip={<KeepStripChip strip={stripMeta} />}
                  />
                ) : null}
                {hasAppTags ? (
                  <ReportRow
                    dimmed={!stripMeta}
                    label={t("wopt.rowProducer")}
                    value={t("wopt.producerValue")}
                    chip={<KeepStripChip strip={stripMeta} />}
                  />
                ) : null}
                <ReportRow
                  label={t("wopt.rowTitleAuthor")}
                  value={t("wopt.titleAuthorValue")}
                />
              </dl>
            </div>
          ) : null}

          {/* The plan — exactly what this run will do */}
          <div className="overflow-hidden rounded-card border border-border bg-card">
            <p className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
              <PackageCheck className="size-3.5" aria-hidden="true" />
              {t("wopt.planTitle")}
            </p>
            <ul className="flex flex-col divide-y divide-border/60">
              {planRows.map(({ icon: Icon, text, dimmed }) => (
                <li
                  key={text}
                  className={cn(
                    "flex items-start gap-3 px-4 py-2.5",
                    dimmed && "opacity-60"
                  )}
                >
                  <Icon
                    className="mt-0.5 size-4 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  <span className="text-sm leading-relaxed text-foreground">
                    {text}
                  </span>
                </li>
              ))}
            </ul>
            <p className="border-t border-border/60 px-4 py-2 text-[11px] leading-relaxed text-muted-foreground">
              {t("wopt.afterRunNote")}
            </p>
          </div>

          {/* Web optimization vs compression — the honest distinction */}
          <div className="rounded-card border border-border bg-card p-4">
            <p className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <Zap className="size-3.5 text-primary" aria-hidden="true" />
              {t("wopt.vsTitle")}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t("wopt.vsBody")}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t("wopt.vsCompress")}
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}
