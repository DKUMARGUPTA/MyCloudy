"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Paperclip, RotateCcw, TriangleAlert } from "lucide-react";

import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { PDF_DOC_PARAMS, loadPdfjs } from "@/lib/pdf/pdfjs";
import { cn } from "@/lib/utils";
import { PreviewFileHeader } from "../stamp-common/preview-parts";

/**
 * Edit attachments surface (PHASE-3 batch 2) — the attachment list editor.
 *
 * A read-only pdf.js probe (the bookmark-pdf pattern) loads the file's
 * embedded files; each row renames in place or toggles deletion; the rows
 * serialize to the "ops" option and the worker is the authority (it
 * re-walks the tree and applies ops by position).
 *
 * State writes follow the codebase rules: form controls write from event
 * handlers; the probe writes inside promise callbacks; the serialization
 * and run-gating effects mirror the bookmark surface.
 */

const EDAT_IDS = { ops: "ops" } as const;
/** Import cap — a portfolio with hundreds of files is uneditable as rows. */
const IMPORT_MAX_ATTACHMENTS = 200;
const MAX_NAME_LENGTH = 150;

type ProbeStatus = "working" | "done" | "error";

interface ProbeState {
  file: File;
  status: ProbeStatus;
  pageCount: number;
}

interface RowState {
  id: string;
  original: string;
  name: string;
  deleted: boolean;
}

export function EditAttachmentsSurface({
  files,
  onChange,
  setFileOrder,
  setRunBlocked,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const fileMeta = files[0];
  const file = fileMeta?.file ?? null;

  const [probe, setProbe] = useState<ProbeState | null>(null);
  const [rows, setRows] = useState<RowState[]>([]);
  const nextIdRef = useRef(1);

  /* ---------------- probe: list embedded files ---------------- */

  useEffect(() => {
    if (!file) return;
    let cancelled = false;

    void (async () => {
      // Reset first (microtask — never synchronously in the effect body).
      await Promise.resolve();
      if (cancelled) return;
      setProbe({ file, status: "working", pageCount: 0 });
      setRows([]);
      try {
        const pdfjs = await loadPdfjs();
        const data = new Uint8Array(await file.arrayBuffer());
        const doc = await pdfjs.getDocument({ data, ...PDF_DOC_PARAMS }).promise;
        if (cancelled) {
          void doc.destroy().catch(() => undefined);
          return;
        }
        const pageCount = doc.numPages;
        let found: Array<{ filename: string }> = [];
        try {
          const attachments = (await doc.getAttachments()) ?? {};
          found = Object.values(
            attachments as Record<string, { filename: string }>
          ).map((a) => ({
            filename: a.filename,
          }));
        } catch {
          found = [];
        }
        await doc.destroy().catch(() => undefined);
        if (cancelled) return;

        const capped = found.slice(0, IMPORT_MAX_ATTACHMENTS);
        nextIdRef.current = capped.length + 1;
        setRows(
          capped.map((a, index) => ({
            id: `i${index + 1}`,
            original: a.filename,
            name: a.filename,
            deleted: false,
          }))
        );
        setProbe({ file, status: "done", pageCount });
      } catch {
        if (cancelled) return;
        setProbe({ file, status: "error", pageCount: 0 });
        // The worker's parser is laxer than pdf.js's preview — leave the
        // run enabled with an honest empty list.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file]);

  const activeProbe = probe !== null && probe.file === file ? probe : null;
  const busy = activeProbe?.status === "working";
  const pageCount = activeProbe?.pageCount ?? 0;
  const probeError = activeProbe?.status === "error";
  const empty = activeProbe?.status === "done" && rows.length === 0;

  /* ---------------- serialization + run gating ---------------- */

  const dirty = useMemo(
    () =>
      rows.some((row) => row.deleted || row.name.trim() !== row.original),
    [rows]
  );

  useEffect(() => {
    if (!dirty) {
      onChange(EDAT_IDS.ops, "");
      return;
    }
    const ops = rows.flatMap((row, index): Array<{ i: number; del?: boolean; name?: string }> => {
      if (row.deleted) return [{ i: index, del: true }];
      const name = row.name.trim().slice(0, MAX_NAME_LENGTH);
      if (name.length > 0 && name !== row.original) return [{ i: index, name }];
      return [];
    });
    onChange(EDAT_IDS.ops, JSON.stringify({ v: 1, ops }));
  }, [rows, dirty, onChange]);

  const blockedKey =
    activeProbe === null || probeError
      ? null
      : empty
        ? "edat.ctaEmpty"
        : !dirty
          ? "edat.ctaNothing"
          : null;
  useEffect(() => {
    setRunBlocked(blockedKey);
    return () => setRunBlocked(null);
  }, [blockedKey, setRunBlocked]);

  /* ---------------- row operations ---------------- */

  const rename = (id: string, name: string): void => {
    setRows((prev) =>
      prev.map((row) =>
        row.id === id ? { ...row, name: name.slice(0, MAX_NAME_LENGTH) } : row
      )
    );
  };

  const toggleDelete = (id: string): void => {
    setRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, deleted: !row.deleted } : row))
    );
  };

  const restoreAll = (): void => {
    setRows((prev) =>
      prev.map((row) => ({ ...row, name: row.original, deleted: false }))
    );
  };

  const kept = rows.filter((row) => !row.deleted).length;
  const deletedCount = rows.length - kept;

  const removeFile = useCallback((): void => {
    setFileOrder([]);
  }, [setFileOrder]);

  /* ---------------- render ---------------- */

  if (!file) return null;

  return (
    <section aria-label={t("edat.surfaceLabel")} className="space-y-3">
      <PreviewFileHeader file={file} pageCount={pageCount} onRemove={removeFile} />

      {busy ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-4 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("edat.reading")}
        </div>
      ) : probeError ? (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-4 py-4 text-sm text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("edat.probeError")}
        </div>
      ) : empty ? (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-4 py-4 text-sm text-muted-foreground">
          <Paperclip className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("edat.emptyList")}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t("edat.countChip", {
                count: String(rows.length),
                kept: String(kept),
                deleted: String(deletedCount),
              })}
            </p>
            <button
              type="button"
              onClick={restoreAll}
              disabled={!dirty}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t("edat.restoreAll")}
            </button>
          </div>

          <ul className="max-h-96 space-y-2 overflow-y-auto pr-1">
            {rows.map((row) => (
              <li
                key={row.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg border border-border bg-background p-2.5 transition-opacity",
                  row.deleted && "opacity-50"
                )}
              >
                <Paperclip
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={row.name}
                  onChange={(event) => rename(row.id, event.target.value)}
                  onFocus={(event) => event.target.select()}
                  disabled={row.deleted}
                  aria-label={t("edat.renameLabel", { name: row.original })}
                  className="h-8 flex-1 font-mono text-xs"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => toggleDelete(row.id)}
                  aria-pressed={row.deleted}
                  className={cn(
                    "h-8 shrink-0 rounded-md border px-2.5 text-xs font-medium transition-colors",
                    row.deleted
                      ? "border-border bg-muted text-foreground"
                      : "border-transparent bg-destructive/10 text-destructive hover:bg-destructive/20"
                  )}
                >
                  {row.deleted ? t("edat.keep") : t("edat.delete")}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
