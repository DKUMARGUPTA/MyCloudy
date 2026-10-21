"use client";

/**
 * Excel to PDF surface (RB1-c — the 69th MyCloudy tool). Owns the whole
 * flow (create-card / scan-pdf precedent — landingSurface, so this
 * renders on the landing page in place of the shared DropZone):
 *
 *  - Landing: hero + a DropZone whose acceptance is decided by the
 *    REAL OOXML sniff, never the extension: legacy .xls magic → the
 *    honest "convert first" toast; no PK magic → "not an Excel file";
 *    PK + a full parseXlsx (which requires [Content_Types].xml and a
 *    readable workbook) → the file is admitted and cached.
 *  - Workspace: live summary (sheets × rows × cols, truncation badges),
 *    the sheet picker (all / individual — rides the serialized option
 *    so it survives ToolShell phase remounts), orientation, page size,
 *    fit-to-width and zebra. Convert spawns the worker (create-resume
 *    protocol) → .pdf download + toast; the sticky Run CTA runs the
 *    same worker through the pool.
 *
 * The main thread parses with the SAME pure model the worker uses, so
 * the summary always matches the output. min-w-0 wrappers everywhere
 * (the pinned grid-blowout lesson); list caps with a scrollable
 * max-height + thin scrollbar.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Columns3,
  FileDown,
  FileSpreadsheet,
  Info,
  Layers,
  Loader2,
  Rows3,
  Table2,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { downloadBlob } from "@/lib/files/output";
import { formatBytes } from "@/lib/storage/recent-files";
import type { WorkerResponse } from "@/lib/workers/protocol";
import {
  OPT_IDS,
  XlsxParseError,
  isLegacyXlsBytes,
  isZipBytes,
  parseSheetSelection,
  parseXlsx,
  type ParsedWorkbook,
} from "./model";

/* ------------------------------------------------------------------ */
/* Error code → i18n keys (landing toasts + workspace card)            */
/* ------------------------------------------------------------------ */

const ERROR_UI: Record<string, { titleKey: string; descKey: string }> = {
  "xlsx-legacy": {
    titleKey: "xls.errLegacyTitle",
    descKey: "xls.errLegacyDesc",
  },
  "xlsx-not-zip": {
    titleKey: "xls.errNotXlsxTitle",
    descKey: "xls.errNotXlsxDesc",
  },
  "xlsx-not-ooxml": {
    titleKey: "xls.errNotXlsxTitle",
    descKey: "xls.errNotXlsxDesc",
  },
  "xlsx-corrupt": {
    titleKey: "xls.errCorruptTitle",
    descKey: "xls.errCorruptDesc",
  },
  "xlsx-empty": {
    titleKey: "xls.errEmptyTitle",
    descKey: "xls.errEmptyDesc",
  },
};

const FALLBACK_ERROR_UI = ERROR_UI["xlsx-corrupt"];

/** Parsed-workbook cache keyed by the File instance (drop → workspace). */
const parseCache = new Map<File, { wb: ParsedWorkbook | null; errCode: string }>();

/* ------------------------------------------------------------------ */
/* Surface                                                             */
/* ------------------------------------------------------------------ */

export function ExcelToPdfSurface({
  files,
  values,
  onChange,
  setRunBlocked,
  addFiles,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const { toast } = useToast();
  const file = files[0]?.file ?? null;

  /* ---------------- workbook parse (main thread, same model) -------- */

  const [parse, setParse] = useState<{
    file: File;
    wb: ParsedWorkbook | null;
    errCode: string;
  } | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      const cached = parseCache.get(file);
      if (cached) {
        setParse({ file, wb: cached.wb, errCode: cached.errCode });
        return;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const wb = parseXlsx(bytes);
        if (cancelled) return;
        if (parseCache.size > 3) parseCache.clear();
        parseCache.set(file, { wb, errCode: "" });
        setParse({ file, wb, errCode: "" });
      } catch (error) {
        if (cancelled) return;
        const errCode =
          error instanceof XlsxParseError ? error.code : "xlsx-corrupt";
        if (parseCache.size > 3) parseCache.clear();
        parseCache.set(file, { wb: null, errCode });
        setParse({ file, wb: null, errCode });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  // stale-guard: only the parse belonging to the CURRENT file renders
  const current = parse && parse.file === file ? parse : null;
  const wb = current?.wb ?? null;

  /* ---------------- derived option state (remount-safe) ------------- */

  const allNames = useMemo(
    () => (wb ? wb.sheets.map((s) => s.name) : []),
    [wb]
  );
  const selection = useMemo(
    () => parseSheetSelection(values[OPT_IDS.sheets], allNames),
    [values, allNames]
  );
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const allSelected =
    allNames.length > 0 && allNames.every((name) => selectedSet.has(name));
  const pageSize = values[OPT_IDS.pageSize] === "letter" ? "letter" : "a4";
  const orientation =
    values[OPT_IDS.orientation] === "landscape" ? "landscape" : "portrait";
  const fit = values[OPT_IDS.fit] !== false;
  const zebra = values[OPT_IDS.zebra] === true;

  const totals = useMemo(() => {
    let rows = 0;
    let cols = 0;
    let cells = 0;
    if (wb) {
      for (const sheet of wb.sheets) {
        rows += sheet.rows.length;
        for (const row of sheet.rows) {
          cols = Math.max(cols, row.length);
          for (const cell of row) {
            if (cell.v !== "") cells++;
          }
        }
      }
    }
    return { rows, cols, cells };
  }, [wb]);

  /* ---------------- CTA gating (sticky Run bar) --------------------- */

  const blockedKey =
    !file || current === null || current.errCode !== ""
      ? "xls.ctaBadFile"
      : selection.length === 0
        ? "xls.ctaNoSheets"
        : null;

  useEffect(() => {
    setRunBlocked(blockedKey);
    return () => setRunBlocked(null);
  }, [setRunBlocked, blockedKey]);

  /* ---------------- handlers ---------------------------------------- */

  const toggleSheet = useCallback(
    (name: string, checked: boolean): void => {
      const next = new Set(selectedSet);
      if (checked) next.add(name);
      else next.delete(name);
      onChange(OPT_IDS.sheets, JSON.stringify(allNames.filter((n) => next.has(n))));
    },
    [allNames, onChange, selectedSet]
  );

  const toggleAll = useCallback(
    (checked: boolean): void => {
      onChange(
        OPT_IDS.sheets,
        checked ? JSON.stringify(allNames) : "[]"
      );
    },
    [allNames, onChange]
  );

  const setOpt = useCallback(
    (id: string, value: string | number | boolean): void => {
      onChange(id, value);
    },
    [onChange]
  );

  /** Real OOXML sniff before the shell ever accepts the file. */
  const validateIncoming = useCallback(
    (incoming: File[]): void => {
      const candidate = incoming[0];
      if (!candidate) return;
      void (async () => {
        const head = new Uint8Array(await candidate.slice(0, 8).arrayBuffer());
        if (isLegacyXlsBytes(head)) {
          toast({
            title: t("xls.errLegacyTitle"),
            description: t("xls.errLegacyDesc", { detail: candidate.name }),
            variant: "destructive",
          });
          return;
        }
        if (!isZipBytes(head)) {
          toast({
            title: t("xls.errNotXlsxTitle"),
            description: t("xls.errNotXlsxDesc", { detail: candidate.name }),
            variant: "destructive",
          });
          return;
        }
        try {
          // full sniff: unzip + [Content_Types] + workbook + sheets
          const bytes = new Uint8Array(await candidate.arrayBuffer());
          const parsed = parseXlsx(bytes);
          if (parseCache.size > 3) parseCache.clear();
          parseCache.set(candidate, { wb: parsed, errCode: "" });
          addFiles([candidate]);
        } catch (error) {
          const errCode =
            error instanceof XlsxParseError ? error.code : "xlsx-corrupt";
          const ui = ERROR_UI[errCode] ?? FALLBACK_ERROR_UI;
          toast({
            title: t(ui.titleKey),
            description: t(ui.descKey, { detail: candidate.name }),
            variant: "destructive",
          });
        }
      })();
    },
    [addFiles, t, toast]
  );

  /* ---------------- worker spawn (create-resume protocol) ----------- */

  const workerRef = useRef<Worker | null>(null);
  const [pct, setPct] = useState<number | null>(null);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const convert = useCallback((): void => {
    if (!file || !wb || selection.length === 0 || workerRef.current) return;
    setPct(0);
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    const runId = Date.now();
    const cleanup = (): void => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
      setPct(null);
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
          const output = data.outputs[0];
          if (output) {
            downloadBlob(output.blob, output.name);
            toast({
              title: t("xls.doneTitle"),
              description: t("xls.doneDesc", {
                name: output.name,
                pages: data.detail?.pages ?? 0,
              }),
            });
          }
          cleanup();
          return;
        }
        if (data.type === "error") {
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
      toolId: "excel-to-pdf",
      options: {
        ...values,
        [OPT_IDS.sheets]: JSON.stringify(selection),
        [OPT_IDS.pageSize]: pageSize,
        [OPT_IDS.orientation]: orientation,
        [OPT_IDS.fit]: fit,
        [OPT_IDS.zebra]: zebra,
        [OPT_IDS.footer]: t("xls.footerFmt"),
        [OPT_IDS.fileWord]: t("xls.fileWord"),
      },
      files: [file],
    });
  }, [
    file,
    fit,
    orientation,
    pageSize,
    selection,
    t,
    toast,
    values,
    wb,
    zebra,
  ]);

  /* ================================================================= */
  /* LANDING — hero + sniffing DropZone                                 */
  /* ================================================================= */

  if (!file) {
    return (
      <section
        aria-label={t("xls.surfaceLabel")}
        className="flex flex-col gap-4"
      >
        <div className="overflow-hidden rounded-card border border-border bg-card">
          <div className="grid gap-0 md:grid-cols-[1.05fr_1fr]">
            <div className="flex flex-col gap-4 p-5 sm:p-6">
              <span
                className="flex size-12 items-center justify-center rounded-card bg-cat-organize/10 text-cat-organize"
                aria-hidden="true"
              >
                <FileSpreadsheet className="size-6" />
              </span>
              <div className="flex min-w-0 flex-col gap-1.5">
                <h2 className="text-base font-semibold text-foreground">
                  {t("xls.heroTitle")}
                </h2>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("xls.heroDesc")}
                </p>
              </div>
              <ul className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                <li className="flex items-center gap-2">
                  <Table2 className="size-3.5 shrink-0 text-cat-organize" aria-hidden="true" />
                  {t("xls.heroLimits")}
                </li>
                <li className="flex items-center gap-2">
                  <Rows3 className="size-3.5 shrink-0 text-cat-organize" aria-hidden="true" />
                  {t("xls.heroFormulas")}
                </li>
                <li className="flex items-center gap-2">
                  <Columns3 className="size-3.5 shrink-0 text-cat-organize" aria-hidden="true" />
                  {t("xls.heroHindi")}
                </li>
              </ul>
            </div>
            <div className="flex flex-col justify-center gap-2 border-t border-border p-4 sm:p-5 md:border-l md:border-t-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                .xlsx / .xlsm
              </p>
              <DropZone
                labelKey="xls.dropFile"
                multiple={false}
                maxFiles={1}
                acceptKind="any"
                onAccept={validateIncoming}
                currentCount={0}
                className="py-2"
              />
            </div>
          </div>
        </div>
      </section>
    );
  }

  /* ================================================================= */
  /* WORKSPACE — summary + options + convert                           */
  /* ================================================================= */

  const errCode = current?.errCode ?? "";
  const errorUi = ERROR_UI[errCode] ?? FALLBACK_ERROR_UI;
  const busy = pct !== null;

  return (
    <section
      aria-label={t("xls.surfaceLabel")}
      className="flex min-w-0 flex-col gap-4"
    >
      {/* ---------------- file card ---------------- */}
      <div className="rounded-card border border-border bg-card p-4 sm:p-5">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <span
            className="flex size-11 shrink-0 items-center justify-center rounded-btn bg-cat-organize/10 text-cat-organize"
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
              {formatBytes(file.size)}
            </p>
          </div>
          {wb ? (
            <Badge variant="outline" className="rounded-chip text-[11px]">
              {t("xls.sheetsChip", { count: wb.sheets.length })}
            </Badge>
          ) : null}
        </div>
      </div>

      {/* ---------------- reading ---------------- */}
      {current === null ? (
        <div
          className="flex min-h-44 flex-col items-center justify-center gap-3 rounded-card border border-border bg-card p-6 text-center"
          aria-live="polite"
        >
          <Loader2
            className="size-7 animate-spin text-primary"
            aria-hidden="true"
          />
          <p className="text-sm text-muted-foreground">{t("xls.reading")}</p>
        </div>
      ) : null}

      {/* ---------------- honest error ---------------- */}
      {current !== null && errCode !== "" ? (
        <div className="rounded-card border border-amber-500/40 bg-amber-500/10 p-4 sm:p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            {t(errorUi.titleKey)}
          </h2>
          <p className="mt-2 break-words text-xs leading-relaxed text-amber-900/80 dark:text-amber-200/80">
            {t(errorUi.descKey, { detail: file.name })}
          </p>
          <p className="mt-3 rounded-btn bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground">
            {t("xls.swapHint")}
          </p>
        </div>
      ) : null}

      {/* ---------------- summary + options ---------------- */}
      {wb ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="rounded-chip text-[11px]">
              <Layers className="size-3" aria-hidden="true" />
              {t("xls.sheetsChip", { count: wb.sheets.length })}
            </Badge>
            <Badge variant="outline" className="rounded-chip text-[11px]">
              <Rows3 className="size-3" aria-hidden="true" />
              {t("xls.rowsChip", { count: totals.rows })}
            </Badge>
            <Badge variant="outline" className="rounded-chip text-[11px]">
              <Columns3 className="size-3" aria-hidden="true" />
              {t("xls.colsChip", { count: totals.cols })}
            </Badge>
            <Badge variant="outline" className="rounded-chip text-[11px]">
              <Table2 className="size-3" aria-hidden="true" />
              {t("xls.cellChip", { count: totals.cells })}
            </Badge>
          </div>

          {(wb.sheetsTruncated || wb.rowsTruncated || wb.colsTruncated) && (
            <div className="flex flex-wrap gap-2">
              {wb.sheetsTruncated ? (
                <Badge
                  variant="outline"
                  className="rounded-chip border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-300"
                >
                  <TriangleAlert className="size-3" aria-hidden="true" />
                  {t("xls.truncSheets", { count: wb.totalSheetsSeen })}
                </Badge>
              ) : null}
              {wb.rowsTruncated ? (
                <Badge
                  variant="outline"
                  className="rounded-chip border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-300"
                >
                  <TriangleAlert className="size-3" aria-hidden="true" />
                  {t("xls.truncRows")}
                </Badge>
              ) : null}
              {wb.colsTruncated ? (
                <Badge
                  variant="outline"
                  className="rounded-chip border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-300"
                >
                  <TriangleAlert className="size-3" aria-hidden="true" />
                  {t("xls.truncCols")}
                </Badge>
              ) : null}
            </div>
          )}

          <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
            {/* ------- sheet picker ------- */}
            <div className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-4 sm:p-5">
              <h3 className="text-sm font-semibold text-foreground">
                {t("xls.sheetsTitle")}
              </h3>
              <div className="flex min-h-11 items-center gap-3 rounded-btn border border-border bg-background px-3">
                <Checkbox
                  id="xls-all-sheets"
                  checked={allSelected}
                  onCheckedChange={(checked) => toggleAll(checked === true)}
                  disabled={busy}
                />
                <Label
                  htmlFor="xls-all-sheets"
                  className="min-h-11 flex-1 cursor-pointer py-3 text-xs font-medium text-foreground"
                >
                  {t("xls.allSheets")}
                </Label>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {selection.length}/{allNames.length}
                </span>
              </div>
              <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto scrollbar-thin pr-1">
                {wb.sheets.map((sheet) => {
                  const id = `xls-sheet-${sheet.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
                  return (
                    <li key={sheet.name}>
                      <div className="flex min-h-11 items-center gap-3 rounded-btn border border-border bg-background px-3">
                        <Checkbox
                          id={id}
                          checked={selectedSet.has(sheet.name)}
                          onCheckedChange={(checked) =>
                            toggleSheet(sheet.name, checked === true)
                          }
                          disabled={busy}
                        />
                        <Label
                          htmlFor={id}
                          className="min-h-11 min-w-0 flex-1 cursor-pointer py-3"
                        >
                          <span className="block truncate text-xs font-medium text-foreground">
                            {sheet.name}
                          </span>
                        </Label>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {sheet.rows.length === 0 ? (
                            t("xls.emptySheet")
                          ) : (
                            <>
                              {sheet.rows.length} ×{" "}
                              {sheet.rows.reduce(
                                (m, row) => Math.max(m, row.length),
                                0
                              )}
                            </>
                          )}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* ------- layout options ------- */}
            <div className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-4 sm:p-5">
              <h3 className="text-sm font-semibold text-foreground">
                {t("xls.layoutTitle")}
              </h3>

              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-foreground">
                  {t("xls.orientationLbl")}
                </span>
                <ToggleGroup
                  type="single"
                  value={orientation}
                  onValueChange={(v) => {
                    if (v) setOpt(OPT_IDS.orientation, v);
                  }}
                  aria-label={t("xls.orientationLbl")}
                  className="w-full justify-stretch gap-1"
                  disabled={busy}
                >
                  <ToggleGroupItem
                    value="portrait"
                    aria-label={t("xls.portrait")}
                    className="min-h-11 flex-1 rounded-btn px-2.5 text-xs"
                  >
                    {t("xls.portrait")}
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="landscape"
                    aria-label={t("xls.landscape")}
                    className="min-h-11 flex-1 rounded-btn px-2.5 text-xs"
                  >
                    {t("xls.landscape")}
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-foreground">
                  {t("xls.pageSizeLbl")}
                </span>
                <ToggleGroup
                  type="single"
                  value={pageSize}
                  onValueChange={(v) => {
                    if (v) setOpt(OPT_IDS.pageSize, v);
                  }}
                  aria-label={t("xls.pageSizeLbl")}
                  className="w-full justify-stretch gap-1"
                  disabled={busy}
                >
                  <ToggleGroupItem
                    value="a4"
                    aria-label={t("xls.pageA4")}
                    className="min-h-11 flex-1 rounded-btn px-2.5 text-xs"
                  >
                    {t("xls.pageA4")}
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="letter"
                    aria-label={t("xls.pageLetter")}
                    className="min-h-11 flex-1 rounded-btn px-2.5 text-xs"
                  >
                    {t("xls.pageLetter")}
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>

              <div className="flex min-h-11 items-center justify-between gap-3 rounded-btn border border-border bg-background px-3">
                <Label
                  htmlFor="xls-fit"
                  className="min-h-11 flex-1 cursor-pointer py-3 text-xs font-medium text-foreground"
                >
                  {t("xls.fitLbl")}
                </Label>
                <Switch
                  id="xls-fit"
                  checked={fit}
                  onCheckedChange={(checked) =>
                    setOpt(OPT_IDS.fit, checked)
                  }
                  disabled={busy}
                />
              </div>
              <p className="-mt-2 px-1 text-[11px] leading-relaxed text-muted-foreground">
                {t("xls.fitHint")}
              </p>

              <div className="flex min-h-11 items-center justify-between gap-3 rounded-btn border border-border bg-background px-3">
                <Label
                  htmlFor="xls-zebra"
                  className="min-h-11 flex-1 cursor-pointer py-3 text-xs font-medium text-foreground"
                >
                  {t("xls.zebraLbl")}
                </Label>
                <Switch
                  id="xls-zebra"
                  checked={zebra}
                  onCheckedChange={(checked) =>
                    setOpt(OPT_IDS.zebra, checked)
                  }
                  disabled={busy}
                />
              </div>
              <p className="-mt-2 px-1 text-[11px] leading-relaxed text-muted-foreground">
                {t("xls.zebraHint")}
              </p>
            </div>
          </div>

          {/* ------- honest notes ------- */}
          <div className="rounded-card border border-border bg-card p-4">
            <h3 className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <Info className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
              {t("xls.noteTitle")}
            </h3>
            <ul className="mt-2 flex flex-col gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
              <li>{t("xls.noteFormulas")}</li>
              <li>{t("xls.noteDecor")}</li>
            </ul>
          </div>

          {/* ------- convert ------- */}
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              size="touch"
              className="w-full rounded-btn text-sm font-semibold sm:w-auto sm:self-start sm:px-8"
              onClick={convert}
              disabled={busy || selection.length === 0}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <FileDown className="size-4" aria-hidden="true" />
              )}
              {busy ? t("xls.converting") : t("xls.convert")}
            </Button>
            <p className="text-[11px] text-muted-foreground">
              {t("xls.swapHint")}
            </p>
          </div>
        </>
      ) : null}
    </section>
  );
}
