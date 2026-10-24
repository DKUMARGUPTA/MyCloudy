"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  FileText,
  Loader2,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { downloadBlob } from "@/lib/files/output";
import { formatBytes } from "@/lib/storage/recent-files";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import type { WorkerResponse } from "@/lib/workers/protocol";
import type { PdfToWordDetail } from "./model";

/**
 * PDF → Word surface (RB1-b, the 68th tool) — create-pdf pattern: the
 * surface IS the whole product (noFile), rendered on the landing page in
 * place of the shell DropZone. It owns the file intake (shared DropZone,
 * magic-%PDF sniffed), the three conversion switches (heading
 * detection, table detection — default on, with automatic paragraph
 * fallback for anything it cannot confidently read — and page breaks),
 * the Convert CTA that spawns the real Web Worker, the progress bar,
 * the on-device download + success toast, and the
 * pages/paragraphs/headings/tables summary card.
 *
 * Honest by design: the summary and the standing note say text +
 * structure only (images and multi-column layouts become a text flow;
 * tables are only ever DETECTED, never fabricated), and a scanned PDF
 * surfaces the worker's tool.errorNoText instead of an empty file. A
 * file chained in from another tool (convert-from-pdf hub) is picked up
 * automatically; picking a new file always wins.
 */

interface DoneSummary {
  name: string;
  pages: number;
  paragraphs: number;
  headings: number;
  tables: number;
}

export function PdfToWordSurface({
  files,
}: ToolSurfaceProps): React.JSX.Element {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [picked, setPicked] = useState<File | null>(null);
  const [headings, setHeadings] = useState(true);
  const [pageBreaks, setPageBreaks] = useState(true);
  const [tables, setTables] = useState(true);
  const [pct, setPct] = useState<number | null>(null);
  const [stage, setStage] = useState<"reading" | "processing" | "saving">(
    "reading"
  );
  const [done, setDone] = useState<DoneSummary | null>(null);
  const workerRef = useRef<Worker | null>(null);

  /* A chained-in file is the default; a fresh pick always wins. */
  const active =
    picked ?? (files.length > 0 ? (files[0].file as File) : null);
  const busy = pct !== null;

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  /* ---------------------- convert (surface-driven run) --------------- */

  const convert = useCallback((): void => {
    if (workerRef.current || active === null) return;
    setPct(0);
    setStage("reading");
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
          setStage(data.stage);
          return;
        }
        if (data.type === "result") {
          const output = data.outputs[0];
          const detail = data.detail as PdfToWordDetail | undefined;
          setPct(null);
          if (output) {
            downloadBlob(output.blob, output.name);
            setDone({
              name: output.name,
              pages: detail?.pages ?? 0,
              paragraphs: detail?.paragraphs ?? 0,
              headings: detail?.headings ?? 0,
              tables: detail?.tables ?? 0,
            });
            toast({
              title: t("p2w.doneTitle"),
              description: t("p2w.doneDesc", { name: output.name }),
            });
          }
          cleanup();
          return;
        }
        if (data.type === "error") {
          setPct(null);
          setDone(null);
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
      toolId: "pdf-to-word",
      options: {
        run: JSON.stringify({
          headings,
          pageBreaks,
          tables,
          locale,
          fileWord: t("p2w.fileWord"),
        }),
      },
      files: [active],
    });
  }, [active, headings, locale, pageBreaks, tables, t, toast]);

  const onAccept = useCallback((incoming: File[]): void => {
    const file = incoming[0];
    if (file) {
      setPicked(file);
      setDone(null);
      setPct(null);
    }
  }, []);

  const stageLabel =
    stage === "reading"
      ? t("p2w.stageReading")
      : stage === "saving"
        ? t("p2w.stageSaving")
        : t("p2w.stageProcessing");

  /* ---------------------- render ------------------------------------ */

  return (
    <section
      aria-label={t("p2w.surfaceLabel")}
      className="flex flex-col gap-4"
    >
      {/* ---------------- file intake ---------------- */}
      {active === null ? (
        <DropZone
          labelKey="p2w.dropLabel"
          multiple={false}
          maxFiles={1}
          acceptKind="pdf"
          onAccept={onAccept}
        />
      ) : (
        <div className="rounded-card border border-border bg-card p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="flex size-11 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary"
              aria-hidden="true"
            >
              <FileText className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p
                className="truncate text-sm font-semibold text-foreground"
                title={active.name}
              >
                {active.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatBytes(active.size)}
              </p>
            </div>
            <Badge variant="private" className="shrink-0 rounded-chip text-[10px]">
              {t("p2w.pdfVerified")}
            </Badge>
          </div>
        </div>
      )}

      {/* ---------------- options ---------------- */}
      <fieldset className="flex flex-col gap-4 rounded-card border border-border bg-card p-4">
        <legend className="px-1 text-sm font-semibold text-foreground">
          {t("p2w.optionsTitle")}
        </legend>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="p2w-headings" className="text-sm">
              {t("p2w.headingsLabel")}
            </Label>
            <Switch
              id="p2w-headings"
              checked={headings}
              onCheckedChange={(checked) => setHeadings(checked)}
              aria-label={t("p2w.headingsLabel")}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("p2w.headingsHint")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="p2w-tables" className="text-sm">
              {t("p2w.tablesLabel")}
            </Label>
            <Switch
              id="p2w-tables"
              checked={tables}
              onCheckedChange={(checked) => setTables(checked)}
              aria-label={t("p2w.tablesLabel")}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("p2w.tablesHint")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="p2w-breaks" className="text-sm">
              {t("p2w.breaksLabel")}
            </Label>
            <Switch
              id="p2w-breaks"
              checked={pageBreaks}
              onCheckedChange={(checked) => setPageBreaks(checked)}
              aria-label={t("p2w.breaksLabel")}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("p2w.breaksHint")}
          </p>
        </div>
      </fieldset>

      {/* ---------------- CTA ---------------- */}
      <div className="flex flex-col items-center gap-2">
        <Button
          type="button"
          size="touch"
          onClick={convert}
          disabled={busy || active === null}
          className="w-full max-w-sm rounded-btn font-semibold"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="size-4" aria-hidden="true" />
          )}
          {busy ? t("p2w.working") : t("p2w.cta")}
        </Button>
        <p className="flex min-w-0 items-center gap-1.5 text-center text-xs leading-relaxed text-muted-foreground">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {t("p2w.qualityNote")}
        </p>
      </div>

      {/* ---------------- progress ---------------- */}
      {busy ? (
        <div
          className="flex items-center gap-2 rounded-card border border-border bg-card p-3 text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="shrink-0">{stageLabel}</span>
        </div>
      ) : null}

      {/* ---------------- summary ---------------- */}
      {done ? (
        <div
          className="flex flex-col gap-2 rounded-card border border-border bg-card p-3 sm:p-4"
          role="status"
        >
          <div className="flex flex-wrap items-center gap-2">
            <CheckCircle2
              className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {done.name}
            </span>
          </div>
          <ul className="flex flex-wrap gap-1.5">
            <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
              {t("p2w.summaryPages", { count: done.pages })}
            </li>
            <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
              {t("p2w.summaryParagraphs", { count: done.paragraphs })}
            </li>
            <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
              {t("p2w.summaryHeadings", { count: done.headings })}
            </li>
            <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
              {t("p2w.summaryTables", { count: done.tables })}
            </li>
          </ul>
        </div>
      ) : null}

      {/* ---------------- replace file (compact) ---------------- */}
      {active !== null && !busy ? (
        <DropZone
          labelKey="p2w.changeFile"
          multiple={false}
          maxFiles={1}
          acceptKind="pdf"
          onAccept={onAccept}
          className="py-2"
        />
      ) : null}
    </section>
  );
}

export default PdfToWordSurface;
