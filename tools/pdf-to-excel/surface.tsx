"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlignLeft,
  FileDown,
  FileSpreadsheet,
  Grid3x3,
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
  axisSegmentsFromOperatorList,
  extractGrid,
  extractRuledGrid,
  gridItemsFromRaw,
  type GridTextItem,
  type LatticeOps,
} from "./model";

/**
 * PDF → Excel surface (RB1-d — the 70th tool, create-card precedent):
 * the workspace owns the whole flow on the landing page —
 *
 *  - its own DropZone (the shared component sniffs %PDF- magic bytes,
 *    never extensions);
 *  - a live page-1 probe: pdf.js reads the first page on the MAIN
 *    thread (text content + operator list, no render) and the SAME
 *    ruled-then-clustered pipeline the worker uses reports the detected
 *    rows × columns before you commit — scans and unreadable files warn
 *    honestly instead;
 *  - the sheet-mode, numeric-cell and ruled-table options, serialized
 *    into the worker's `excel` payload with pre-resolved labels (the UI
 *    language names the output file);
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
  /** Which detector won: true = ruled lattice (exact cells). */
  ruled: boolean;
  /** First rows of the detected grid for the live mini-preview. */
  sample: string[][];
}

interface ProbeBad {
  file: File;
  kind: "scan" | "fail";
}

type Probe = ProbeOk | ProbeBad | null;

/** Mini-preview caps — wider/taller grids scroll or fold with a note. */
const PROBE_SAMPLE_ROWS = 6;
const PROBE_SAMPLE_COLS = 8;
const PROBE_SAMPLE_CELL = 14;

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
  const [ruledTables, setRuledTables] = useState(true);
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
        const ops = (pdfjs as unknown as { OPS: LatticeOps }).OPS;
        // Fresh copy — pdf.js DETACHES the buffer it receives.
        const data = new Uint8Array(await file.arrayBuffer());
        const doc = await pdfjs.getDocument({
          data,
          ...PDF_DOC_PARAMS,
        }).promise;
        try {
          const page = await doc.getPage(1);
          let items: GridTextItem[] = [];
          let grid: string[][] | null = null;
          try {
            const content = await page.getTextContent();
            items = gridItemsFromRaw(content.items as unknown[]);
            // Same pipeline as the worker: ruled lattice first, then
            // position clustering — the preview IS the output.
            const opList = (await page
              .getOperatorList()
              .catch(() => null)) as {
              fnArray: ArrayLike<number>;
              argsArray: ArrayLike<unknown>;
            } | null;
            if (ruledTables && opList && items.length > 0) {
              grid = extractRuledGrid(
                items,
                axisSegmentsFromOperatorList(
                  opList.fnArray,
                  opList.argsArray,
                  ops
                )
              );
            }
          } finally {
            page.cleanup();
          }
          if (cancelled) return;
          if (items.length === 0) {
            setProbe({ file, kind: "scan" });
            return;
          }
          const finalGrid = grid ?? extractGrid(items);
          setProbe({
            file,
            kind: "ok",
            pages: doc.numPages,
            rows: finalGrid.length,
            // Honest column count: out-of-table prose rows above a ruled
            // table carry a single cell — the widest row names the grid.
            cols: finalGrid.reduce(
              (max, row) => Math.max(max, row.length),
              0
            ),
            ruled: grid !== null,
            sample: finalGrid
              .slice(0, PROBE_SAMPLE_ROWS)
              .map((row) => row.slice(0, PROBE_SAMPLE_COLS)),
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
  }, [file, ruledTables, setRunBlocked]);

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
          ruled: ruledTables,
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
  }, [file, locale, numericCells, ruledTables, sheetMode, t, toast]);

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
          <div className="flex flex-col gap-2.5 px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-foreground">
                {t("pdfxcel.probeGrid", {
                  rows: current.rows,
                  cols: current.cols,
                })}
              </p>
              <span
                className={
                  current.ruled
                    ? "inline-flex shrink-0 items-center gap-1 rounded-chip bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
                    : "inline-flex shrink-0 items-center gap-1 rounded-chip bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                }
              >
                {current.ruled ? (
                  <Grid3x3 className="size-3" aria-hidden="true" />
                ) : (
                  <AlignLeft className="size-3" aria-hidden="true" />
                )}
                {t(current.ruled ? "pdfxcel.probeRuled" : "pdfxcel.probeClustered")}
              </span>
            </div>
            {current.sample.length > 0 ? (
              <div className="overflow-x-auto rounded-btn border border-border/70 bg-background">
                <table className="w-full border-collapse text-[11px] leading-tight">
                  <caption className="sr-only">
                    {t("pdfxcel.probeSample")}
                  </caption>
                  <tbody>
                    {current.sample.map((row, r) => {
                      /* short rows span their last cell across the
                       * remaining columns — merged-cell look, like the
                       * prose lines above a ruled table really are */
                      const span = Math.max(
                        1,
                        Math.min(current.cols, PROBE_SAMPLE_COLS) - row.length + 1
                      );
                      return (
                        <tr
                          key={r}
                          className={
                            r === 0
                              ? "bg-muted/70 font-semibold"
                              : undefined
                          }
                        >
                          {row.map((cell, c) => (
                            <td
                              key={c}
                              colSpan={
                                c === row.length - 1 && span > 1 ? span : 1
                              }
                              title={cell}
                              className="max-w-[9rem] truncate border-r border-b border-border/50 px-2 py-1.5 text-foreground/90 last:border-r-0"
                            >
                              {cell.length > PROBE_SAMPLE_CELL
                                ? `${cell.slice(0, PROBE_SAMPLE_CELL - 1)}…`
                                : cell || "\u00A0"}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
            {current.rows > current.sample.length ||
            current.cols > PROBE_SAMPLE_COLS ? (
              <p className="text-[11px] text-muted-foreground">
                {current.rows > current.sample.length
                  ? t("pdfxcel.probeMoreRows", {
                      more: current.rows - current.sample.length,
                    })
                  : null}
                {current.rows > current.sample.length &&
                current.cols > PROBE_SAMPLE_COLS
                  ? " · "
                  : null}
                {current.cols > PROBE_SAMPLE_COLS
                  ? t("pdfxcel.probeMoreCols", {
                      more: current.cols - PROBE_SAMPLE_COLS,
                    })
                  : null}
              </p>
            ) : null}
          </div>
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

        <div className="mt-4 flex items-start justify-between gap-3 border-t border-border pt-4">
          <div className="min-w-0">
            <Label
              htmlFor="pdfxcel-ruled"
              className="text-xs font-medium text-foreground"
            >
              {t("pdfxcel.ruledLabel")}
            </Label>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {t("pdfxcel.ruledHint")}
            </p>
          </div>
          <Switch
            id="pdfxcel-ruled"
            checked={ruledTables}
            onCheckedChange={setRuledTables}
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
