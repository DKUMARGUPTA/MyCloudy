"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileDown,
  FileSpreadsheet,
  Loader2,
  Table2,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { DropZone } from "@/components/doco/tool/drop-zone";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { downloadBlob, sanitizeFileName } from "@/lib/files/output";
import { formatBytes } from "@/lib/storage/recent-files";
import { PDF_DOC_PARAMS, loadPdfjs } from "@/lib/pdf/pdfjs";
import type { WorkerResponse } from "@/lib/workers/protocol";
import {
  extractGrid,
  gridItemsFromRaw,
  type GridTextItem,
} from "./model";

/**
 * PDF → Excel surface (RB1-d — the 70th tool, create-card precedent):
 * the workspace owns the whole flow on the landing page —
 *
 *  - its own DropZone (the shared component sniffs %PDF- magic bytes,
 *    never extensions);
 *  - a live page-1 probe: pdf.js reads the first page on the MAIN
 *    thread (text content only, no render) and the same extractGrid the
 *    worker uses reports the detected rows × columns before you commit
 *    — scans and unreadable files warn honestly instead;
 *  - the sheet-mode and numeric-cell options, serialized into the
 *    worker's `excel` payload with pre-resolved labels (the UI language
 *    names the output file);
 *  - Convert spawns the worker, streams real progress and downloads +
 *    toasts. Device-only, like every tool here.
 */

type SheetMode = "single" | "perPage";

interface ProbeOk {
  file: File;
  kind: "ok";
  pages: number;
  rows: number;
  cols: number;
}

interface ProbeBad {
  file: File;
  kind: "scan" | "fail";
}

type Probe = ProbeOk | ProbeBad | null;

export function PdfToExcelSurface({
  files,
  setRunBlocked,
  addFiles,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const file = files[0]?.file ?? null;

  const [sheetMode, setSheetMode] = useState<SheetMode>("perPage");
  const [numericCells, setNumericCells] = useState(true);
  const [probe, setProbe] = useState<Probe>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [done, setDone] = useState<{ name: string; blob: Blob } | null>(null);
  const workerRef = useRef<Worker | null>(null);

  /* -------- page-1 probe (main-thread pdf.js, text content only) ------ */

  useEffect(() => {
    if (!file) {
      setProbe(null);
      setRunBlocked(null);
      return;
    }
    setRunBlocked(null);
    let cancelled = false;
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        // Fresh copy — pdf.js DETACHES the buffer it receives.
        const data = new Uint8Array(await file.arrayBuffer());
        const doc = await pdfjs.getDocument({
          data,
          ...PDF_DOC_PARAMS,
        }).promise;
        try {
          const page = await doc.getPage(1);
          let items: GridTextItem[] = [];
          try {
            const content = await page.getTextContent();
            items = gridItemsFromRaw(content.items as unknown[]);
          } finally {
            page.cleanup();
          }
          if (cancelled) return;
          if (items.length === 0) {
            setProbe({ file, kind: "scan" });
            return;
          }
          const grid = extractGrid(items);
          setProbe({
            file,
            kind: "ok",
            pages: doc.numPages,
            rows: grid.length,
            cols: grid[0]?.length ?? 0,
          });
        } finally {
          await doc.destroy().catch(() => undefined);
        }
      } catch {
        if (!cancelled) {
          setProbe({ file, kind: "fail" });
          setRunBlocked("pdfxcel.probeFailTitle");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, setRunBlocked]);

  /* -------- Convert (surface-driven run, create-card pattern) -------- */

  const convert = useCallback((): void => {
    if (!file || workerRef.current) return;
    setPct(0);
    setDone(null);
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    const runId = Date.now();
    const cleanup = (): void => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
    worker.addEventListener(
      "message",
      (event: MessageEvent<WorkerResponse>) => {
        const data = event.data;
        if (!data || data.runId !== runId) return;
        if (data.type === "progress") {
          setPct(data.pct);
          return;
        }
        if (data.type === "result") {
          setPct(null);
          const output = data.outputs[0];
          if (output) {
            setDone({ name: output.name, blob: output.blob });
            downloadBlob(output.blob, sanitizeFileName(output.name, "xlsx"));
            toast({
              title: t("pdfxcel.doneTitle"),
              description: t("pdfxcel.doneDesc", { name: output.name }),
            });
          }
          cleanup();
          return;
        }
        if (data.type === "error") {
          setPct(null);
          toast({
            title: t("tool.errorTitle"),
            description: t(data.code, { detail: data.detail ?? "" }),
            variant: "destructive",
          });
          cleanup();
        }
      }
    );
    worker.addEventListener("error", () => {
      setPct(null);
      toast({
        title: t("tool.errorTitle"),
        description: t("tool.errorGeneric", { detail: "" }),
        variant: "destructive",
      });
      cleanup();
    });
    worker.postMessage({
      type: "run",
      runId,
      toolId: "pdf-to-excel",
      options: {
        excel: JSON.stringify({
          sheetMode,
          numericCells,
          locale,
          labels: {
            fileWord: t("pdfxcel.fileWord"),
            pageWord: t("pdfxcel.pageWord"),
            sheetWord: t("pdfxcel.sheetWord"),
          },
        }),
      },
      files: [file],
    });
  }, [file, locale, numericCells, sheetMode, t, toast]);

  // Never leave a worker spinning behind a remount (phase changes).
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  /* ------------------------------ render ------------------------------ */

  if (!file) {
    return (
      <section
        aria-labelledby="pdfxcel-drop-heading"
        className="flex flex-col gap-3"
      >
        <DropZone
          labelKey="pdfxcel.dropLabel"
          multiple={false}
          maxFiles={1}
          acceptKind="pdf"
          onAccept={addFiles}
          currentCount={files.length}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("pdfxcel.dropHint")}
        </p>
      </section>
    );
  }

  // Stale probe (file swapped while reading) renders as loading.
  const current =
    probe !== null && probe.file === file ? probe : null;
  const busy = pct !== null;

  return (
    <section
      aria-labelledby="pdfxcel-workspace-heading"
      className="flex min-w-0 flex-col gap-4"
    >
      {/* ---------------- detected file card ---------------- */}
      <div className="rounded-card border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="flex size-11 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <FileSpreadsheet className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p
              className="truncate text-sm font-semibold text-foreground"
              title={file.name}
            >
              {file.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatBytes(file.size)} · {t("pdfxcel.fileCard")}
            </p>
          </div>
          {current?.kind === "ok" ? (
            <span className="shrink-0 rounded-chip bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
              {t("pdfxcel.probePages", { pages: current.pages })}
            </span>
          ) : null}
        </div>
      </div>

      {/* ---------------- layout probe ---------------- */}
      <div
        aria-live="polite"
        className="rounded-card border border-border bg-muted/40"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <p className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-foreground">
            <Table2
              className="size-3.5 shrink-0 text-primary"
              aria-hidden="true"
            />
            {t("pdfxcel.probeTitle")}
          </p>
        </div>
        {current === null ? (
          <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Loader2
              className="size-3.5 shrink-0 animate-spin"
              aria-hidden="true"
            />
            {t("pdfxcel.probeWait")}
          </p>
        ) : current.kind === "ok" ? (
          <p className="px-3 py-3 text-xs font-medium text-foreground">
            {t("pdfxcel.probeGrid", {
              rows: current.rows,
              cols: current.cols,
            })}
          </p>
        ) : (
          <div className="flex items-start gap-2.5 px-3 py-3">
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0 text-amber-500"
              aria-hidden="true"
            />
            <div className="min-w-0 text-xs leading-relaxed">
              <p className="font-semibold text-foreground">
                {t(
                  current.kind === "scan"
                    ? "pdfxcel.probeScanTitle"
                    : "pdfxcel.probeFailTitle"
                )}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {t(
                  current.kind === "scan"
                    ? "pdfxcel.probeScanBody"
                    : "pdfxcel.probeFailBody"
                )}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ---------------- options ---------------- */}
      <div className="rounded-card border border-border bg-card p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-foreground">
          {t("pdfxcel.optTitle")}
        </h2>

        <div className="mt-3">
          <p
            id="pdfxcel-mode-label"
            className="text-xs font-medium text-foreground"
          >
            {t("pdfxcel.modeLabel")}
          </p>
          <div
            role="group"
            aria-labelledby="pdfxcel-mode-label"
            className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            <button
              type="button"
              aria-pressed={sheetMode === "perPage"}
              onClick={() => setSheetMode("perPage")}
              className={[
                "min-h-11 rounded-btn border px-3 py-2 text-left text-xs font-semibold outline-none transition-colors",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                sheetMode === "perPage"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-foreground hover:border-primary/40",
              ].join(" ")}
            >
              {t("pdfxcel.modePerPage")}
            </button>
            <button
              type="button"
              aria-pressed={sheetMode === "single"}
              onClick={() => setSheetMode("single")}
              className={[
                "min-h-11 rounded-btn border px-3 py-2 text-left text-xs font-semibold outline-none transition-colors",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                sheetMode === "single"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-foreground hover:border-primary/40",
              ].join(" ")}
            >
              {t("pdfxcel.modeSingle")}
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {t(
              sheetMode === "perPage"
                ? "pdfxcel.modePerPageHint"
                : "pdfxcel.modeSingleHint"
            )}
          </p>
        </div>

        <div className="mt-4 flex items-start justify-between gap-3 border-t border-border pt-4">
          <div className="min-w-0">
            <Label
              htmlFor="pdfxcel-numeric"
              className="text-xs font-medium text-foreground"
            >
              {t("pdfxcel.numericLabel")}
            </Label>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {t("pdfxcel.numericHint")}
            </p>
          </div>
          <Switch
            id="pdfxcel-numeric"
            checked={numericCells}
            onCheckedChange={setNumericCells}
            disabled={busy}
            className="mt-0.5 shrink-0"
          />
        </div>

        <p className="mt-4 rounded-btn bg-muted/60 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          {t("pdfxcel.ruleNote")} {t("pdfxcel.limitsNote")}
        </p>
      </div>

      {/* ---------------- convert + progress ---------------- */}
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          size="touch"
          className="w-full rounded-btn font-semibold"
          onClick={convert}
          disabled={busy || current?.kind === "fail"}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <FileDown className="size-4" aria-hidden="true" />
          )}
          {busy ? t("pdfxcel.converting", { pct }) : t("pdfxcel.convertBtn")}
        </Button>

        {busy ? (
          <p
            role="status"
            className="text-center text-xs text-muted-foreground"
          >
            {t("pdfxcel.converting", { pct })}
          </p>
        ) : null}

        {done && !busy ? (
          <div className="flex flex-col items-start gap-2 rounded-card border border-border bg-muted/40 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 break-all text-xs text-muted-foreground">
              {t("pdfxcel.doneDesc", { name: done.name })}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 rounded-btn"
              onClick={() => downloadBlob(done.blob, done.name)}
            >
              <FileDown className="size-3.5" aria-hidden="true" />
              {t("pdfxcel.again")}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default PdfToExcelSurface;
