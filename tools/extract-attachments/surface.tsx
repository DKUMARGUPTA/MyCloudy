"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Braces,
  FileArchive,
  FileSpreadsheet,
  FileText,
  FileType as FileTypeIcon,
  ImageIcon,
  Loader2,
  Paperclip,
  TriangleAlert,
} from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { formatBytes } from "@/lib/storage/recent-files";
import { cn } from "@/lib/utils";
import { PreviewFileHeader } from "../stamp-common/preview-parts";
import {
  probeAttachments,
  type ExtractedAttachment,
} from "./worker-lib";

/**
 * Extract attachments surface (R59) — the pre-run inventory card.
 *
 * The probe runs the worker's OWN pipeline (worker-lib probeAttach-
 * ments: same tree walk, same /F name preference, same /Filter decode)
 * on the main thread, so the preview IS the output: every embedded
 * file is listed with its real decoded size and sniffed type BEFORE
 * the run — a PDF with nothing inside gets an honest empty state and
 * a blocked CTA (no wasted run), and an unreadable preview keeps the
 * run enabled because the worker's parser may still succeed.
 *
 * Multi-file (up to 5 PDFs): each file gets its own inventory
 * section; ANY file with zero attachments blocks the run — exactly
 * where the worker would stop.
 */

/** Rows shown per file before the "+N more" fold. */
const ROWS_CAP = 50;

type ProbeStatus = "working" | "done" | "error";

interface FileProbe {
  file: File;
  status: ProbeStatus;
  pageCount: number;
  attachments: ExtractedAttachment[];
}

/** MIME family → (Lucide icon, i18n label key, tint classes). */
function mimeVisual(mime: string): {
  icon: typeof Paperclip;
  labelKey: string;
  tint: string;
} {
  if (mime === "application/pdf") {
    return {
      icon: FileTypeIcon,
      labelKey: "et.typePdf",
      tint: "bg-red-500/10 text-red-600 dark:text-red-400",
    };
  }
  if (
    mime === "text/csv" ||
    mime.startsWith("application/vnd.openxmlformats-officedocument.spreadsheetml") ||
    mime.startsWith("application/vnd.ms-excel") ||
    mime === "application/vnd.oasis.opendocument.spreadsheet"
  ) {
    return {
      icon: FileSpreadsheet,
      labelKey: "et.typeSheet",
      tint: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    };
  }
  if (mime.startsWith("image/")) {
    return {
      icon: ImageIcon,
      labelKey: "et.typeImage",
      tint: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    };
  }
  if (
    mime === "application/zip" ||
    mime === "application/gzip" ||
    mime === "application/x-7z-compressed" ||
    mime === "application/x-rar-compressed" ||
    mime === "application/epub+zip"
  ) {
    return {
      icon: FileArchive,
      labelKey: "et.typeArchive",
      tint: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    };
  }
  if (mime === "application/json" || mime === "application/xml") {
    return {
      icon: Braces,
      labelKey: "et.typeData",
      tint: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    };
  }
  if (mime.startsWith("text/")) {
    return {
      icon: FileText,
      labelKey: "et.typeText",
      tint: "bg-primary/10 text-primary",
    };
  }
  return {
    icon: Paperclip,
    labelKey: "et.typeFile",
    tint: "bg-muted text-muted-foreground",
  };
}

export function ExtractAttachmentsSurface({
  files,
  setFileOrder,
  setRunBlocked,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const [probes, setProbes] = useState<FileProbe[]>([]);
  const generationRef = useRef(0);

  /* ---------------- probe: the worker's own pipeline, main thread -- */

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    if (files.length === 0) {
      setProbes([]);
      return;
    }
    let cancelled = false;

    void (async () => {
      // Reset first (microtask — never synchronously in the effect body).
      await Promise.resolve();
      if (cancelled || generationRef.current !== generation) return;
      setProbes(
        files.map((meta) => ({
          file: meta.file,
          status: "working",
          pageCount: 0,
          attachments: [],
        }))
      );

      // Probe each file with the worker's own code (sequential — the
      // own parser is synchronous; a 5-file batch stays snappy).
      const results: FileProbe[] = [];
      for (const meta of files) {
        if (cancelled || generationRef.current !== generation) return;
        try {
          const bytes = new Uint8Array(await meta.file.arrayBuffer());
          const found = probeAttachments(bytes);
          results.push({
            file: meta.file,
            status: "done",
            pageCount: found.pageCount,
            attachments: found.attachments,
          });
        } catch {
          results.push({
            file: meta.file,
            status: "error",
            pageCount: 0,
            attachments: [],
          });
        }
        if (cancelled || generationRef.current !== generation) return;
        setProbes([...results]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [files]);

  const active =
    probes.length === files.length &&
    probes.every((p, i) => p.file === files[i]?.file)
      ? probes
      : [];
  const anyWorking = active.some((p) => p.status === "working");
  const emptyFile = active.find(
    (p) => p.status === "done" && p.attachments.length === 0
  );
  const allErrored =
    active.length > 0 &&
    active.every((p) => p.status === "error") &&
    !anyWorking;

  /* ---------------- run gating ------------------------------------- */

  const blockedKey = anyWorking
    ? null
    : emptyFile
      ? "et.ctaEmpty"
      : null;
  useEffect(() => {
    setRunBlocked(blockedKey);
    return () => setRunBlocked(null);
  }, [blockedKey, setRunBlocked]);

  /* ---------------- helpers ---------------------------------------- */

  const removeFile = useCallback(
    (target: File): void => {
      setFileOrder(
        files.filter((meta) => meta.file !== target).map((meta) => meta)
      );
    },
    [files, setFileOrder]
  );

  const totalAttachments = active.reduce(
    (sum, p) => sum + p.attachments.length,
    0
  );
  const totalBytes = active.reduce(
    (sum, p) => sum + p.attachments.reduce((s, a) => s + a.bytes.length, 0),
    0
  );

  if (files.length === 0) return null;

  /* ---------------- render ----------------------------------------- */

  return (
    <section
      aria-label={t("et.surfaceLabel")}
      className="space-y-4"
    >
      {/* Summary strip — the honest pre-run contract. */}
      {!anyWorking && !allErrored && totalAttachments > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="rounded-chip bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
            {t("et.countChip", { count: totalAttachments })}
          </p>
          <p className="rounded-chip bg-muted px-3 py-1 text-xs font-medium tabular-nums text-muted-foreground">
            {t("et.totalSize", { size: formatBytes(totalBytes) })}
          </p>
        </div>
      ) : null}

      {active.map((probe) => {
        const rows = probe.attachments.slice(0, ROWS_CAP);
        const more = probe.attachments.length - rows.length;
        return (
          <div key={probe.file.name + probe.file.size} className="space-y-3">
            <PreviewFileHeader
              file={probe.file}
              pageCount={probe.pageCount}
              onRemove={() => removeFile(probe.file)}
            />

            {probe.status === "working" ? (
              <div className="flex items-center gap-2 rounded-card border border-border bg-muted/40 px-4 py-6 text-sm text-muted-foreground">
                <Loader2
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
                {t("et.reading")}
              </div>
            ) : probe.status === "error" ? (
              <div className="flex items-start gap-2 rounded-card border border-border bg-muted/40 px-4 py-4 text-sm text-muted-foreground">
                <TriangleAlert
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                {t("et.probeError")}
              </div>
            ) : probe.attachments.length === 0 ? (
              <div className="flex items-start gap-2 rounded-card border border-border bg-muted/40 px-4 py-4 text-sm text-muted-foreground">
                <Paperclip
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                {t("et.emptyList")}
              </div>
            ) : (
              <ul className="max-h-96 space-y-2 overflow-y-auto pr-1 custom-scrollbar">
                {rows.map((att) => {
                  const visual = mimeVisual(att.mime);
                  const Icon = visual.icon;
                  return (
                    <li
                      key={att.name + att.bytes.length}
                      className="flex items-center gap-3 rounded-card border border-border bg-card p-3"
                    >
                      <span
                        className={cn(
                          "flex size-9 shrink-0 items-center justify-center rounded-btn",
                          visual.tint
                        )}
                        aria-hidden="true"
                      >
                        <Icon className="size-4.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs font-medium text-foreground">
                          {att.name}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {t(visual.labelKey)}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {formatBytes(att.bytes.length)}
                      </span>
                    </li>
                  );
                })}
                {more > 0 ? (
                  <li className="px-3 py-1 text-xs text-muted-foreground">
                    {t("et.moreRows", { n: more })}
                  </li>
                ) : null}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}
