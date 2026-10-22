"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileDown,
  FileText,
  LayoutTemplate,
  Loader2,
  Rows3,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { downloadBlob, sanitizeFileName } from "@/lib/files/output";
import { formatBytes } from "@/lib/storage/recent-files";
import { PDF_DOC_PARAMS, loadPdfjs } from "@/lib/pdf/pdfjs";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import type { WorkerResponse } from "@/lib/workers/protocol";
import { cn } from "@/lib/utils";
import type { PdfToHtmlDetail } from "./model";

/**
 * PDF → HTML surface (RB4-b — pdf-to-powerpoint precedent, landing
 * surface): the workspace owns the whole flow on the landing page —
 *
 *  - its own DropZone (the shared component sniffs %PDF magic bytes,
 *    never extensions);
 *  - a live page-count preview: pdf.js opens the file on the MAIN
 *    thread (text content of page 1 only, no render) and reports the
 *    page count before you commit; a textless page 1 warns honestly;
 *  - the mode explainer — Flow (clean readable reflow) vs Layout
 *    (looks like the pages) — plus the page-marker switch and the page
 *    range, all bound to the shared option values (the aside chips and
 *    these controls write through one source of truth);
 *  - Convert spawns the worker, streams real progress and downloads +
 *    toasts the single self-contained .html. Device-only, like every
 *    tool here.
 */

interface ProbeOk {
  file: File;
  kind: "ok" | "scan";
  pages: number;
}

interface ProbeFail {
  file: File;
  kind: "fail";
}

type Probe = ProbeOk | ProbeFail | null;

interface DoneSummary {
  name: string;
  blob: Blob;
  pages: number;
  blocks: number;
  headings: number;
  mode: "flow" | "layout";
}

export function PdfToHtmlSurface({
  files,
  values,
  onChange,
  setRunBlocked,
  addFiles,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const file = files[0]?.file ?? null;

  const [probe, setProbe] = useState<Probe>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [done, setDone] = useState<DoneSummary | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const mode = values.mode === "layout" ? "layout" : "flow";
  const pageNumbers = values.pageNumbers === true;
  const pages = typeof values.pages === "string" ? values.pages : "all";
  const busy = pct !== null;

  /* Localized words for the worker (the schema panel never carries
   * locale strings — the p2ppt pattern): the fallback file name, the
   * output's own "Page" marker word and its empty-page note. */
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      onChange("locale", locale === "hi" ? "hi" : "en");
      onChange("fileWord", t("phtml.fileWord"));
      onChange("pageWord", t("phtml.pageWord"));
      onChange("noTextWord", t("phtml.noTextWord"));
    });
    return () => {
      cancelled = true;
    };
  }, [onChange, locale, t]);

  /* -------- live page-count preview (main-thread pdf.js probe) ------ */

  useEffect(() => {
    if (!file) {
      setProbe(null);
      setRunBlocked("phtml.ctaNoFile");
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
          let chars = 0;
          try {
            const content = await page.getTextContent();
            for (const item of content.items as unknown[]) {
              const str = (item as { str?: unknown }).str;
              if (typeof str === "string") chars += str.trim().length;
            }
          } finally {
            page.cleanup();
          }
          if (cancelled) return;
          setProbe({
            file,
            kind: chars > 0 ? "ok" : "scan",
            pages: doc.numPages,
          });
        } finally {
          await doc.destroy().catch(() => undefined);
        }
      } catch {
        if (!cancelled) {
          setProbe({ file, kind: "fail" });
          setRunBlocked("phtml.probeFailTitle");
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
          const detail = data.detail as PdfToHtmlDetail | undefined;
          if (output) {
            const safeName = sanitizeFileName(output.name, "html");
            downloadBlob(output.blob, safeName);
            setDone({
              name: safeName,
              blob: output.blob,
              pages: detail?.pages ?? 0,
              blocks: detail?.paragraphs ?? 0,
              headings: detail?.headings ?? 0,
              mode,
            });
            toast({
              title: t("phtml.doneTitle"),
              description: t("phtml.doneDesc", {
                name: safeName,
                pages: detail?.pages ?? 0,
              }),
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
      toolId: "pdf-to-html",
      options: {
        mode,
        pageNumbers,
        pages,
        locale: locale === "hi" ? "hi" : "en",
        fileWord: t("phtml.fileWord"),
        pageWord: t("phtml.pageWord"),
        noTextWord: t("phtml.noTextWord"),
      },
      files: [file],
    });
  }, [file, locale, mode, pageNumbers, pages, t, toast]);

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
        aria-labelledby="phtml-drop-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="phtml-drop-heading" className="sr-only">
          {t("phtml.surfaceLabel")}
        </h2>
        <DropZone
          labelKey="phtml.dropLabel"
          multiple={false}
          maxFiles={1}
          acceptKind="pdf"
          onAccept={addFiles}
          currentCount={files.length}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("phtml.dropHint")}
        </p>
      </section>
    );
  }

  const current = probe !== null && probe.file === file ? probe : null;

  return (
    <section
      aria-labelledby="phtml-workspace-heading"
      className="flex min-w-0 flex-col gap-4"
    >
      {/* ---------------- detected file card + page count ---------------- */}
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
              title={file.name}
            >
              {file.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatBytes(file.size)} · {t("phtml.fileCard")}
            </p>
          </div>
          {current?.kind === "ok" ? (
            <span className="shrink-0 rounded-chip bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
              {t("phtml.previewCount", { pages: current.pages })}
            </span>
          ) : null}
        </div>
      </div>

      {/* ---------------- preview probe ---------------- */}
      <div
        aria-live="polite"
        className="rounded-card border border-border bg-muted/40"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <p className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-foreground">
            <FileText
              className="size-3.5 shrink-0 text-primary"
              aria-hidden="true"
            />
            {t("phtml.previewTitle")}
          </p>
        </div>
        {current === null ? (
          <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Loader2
              className="size-3.5 shrink-0 animate-spin"
              aria-hidden="true"
            />
            {t("phtml.probeWait")}
          </p>
        ) : current.kind === "ok" ? (
          <p className="px-3 py-3 text-xs font-medium text-foreground">
            {t("phtml.probeOk", { pages: current.pages })}
          </p>
        ) : current.kind === "scan" ? (
          <div className="flex items-start gap-2.5 px-3 py-3">
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0 text-amber-500"
              aria-hidden="true"
            />
            <div className="min-w-0 text-xs leading-relaxed">
              <p className="font-semibold text-foreground">
                {t("phtml.probeScanTitle")}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {t("phtml.probeScanBody")}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2.5 px-3 py-3">
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0 text-amber-500"
              aria-hidden="true"
            />
            <div className="min-w-0 text-xs leading-relaxed">
              <p className="font-semibold text-foreground">
                {t("phtml.probeFailTitle")}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {t("phtml.probeFailBody")}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ---------------- options ---------------- */}
      <div className="rounded-card border border-border bg-card p-4 sm:p-5">
        <h2
          id="phtml-workspace-heading"
          className="text-sm font-semibold text-foreground"
        >
          {t("phtml.optTitle")}
        </h2>

        {/* mode + explainer */}
        <div className="mt-3">
          <p
            id="phtml-mode-label"
            className="text-xs font-medium text-foreground"
          >
            {t("phtml.modeLabel")}
          </p>
          <div
            role="group"
            aria-labelledby="phtml-mode-label"
            className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            <button
              type="button"
              aria-pressed={mode === "flow"}
              onClick={() => onChange("mode", "flow")}
              className={cn(
                "min-h-11 rounded-btn border px-3 py-2 text-left outline-none transition-colors",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                mode === "flow"
                  ? "border-primary bg-primary/10"
                  : "border-border bg-background hover:border-primary/40"
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <Rows3 className="size-3.5 shrink-0" aria-hidden="true" />
                {t("phtml.modeFlow")}
              </span>
              <span className="mt-1 block text-[11px] font-normal leading-relaxed text-muted-foreground">
                {t("phtml.modeFlowHint")}
              </span>
            </button>
            <button
              type="button"
              aria-pressed={mode === "layout"}
              onClick={() => onChange("mode", "layout")}
              className={cn(
                "min-h-11 rounded-btn border px-3 py-2 text-left outline-none transition-colors",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                mode === "layout"
                  ? "border-primary bg-primary/10"
                  : "border-border bg-background hover:border-primary/40"
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <LayoutTemplate
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                {t("phtml.modeLayout")}
              </span>
              <span className="mt-1 block text-[11px] font-normal leading-relaxed text-muted-foreground">
                {t("phtml.modeLayoutHint")}
              </span>
            </button>
          </div>
        </div>

        {/* page markers switch */}
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
          <div className="min-w-0">
            <Label
              htmlFor="phtml-page-numbers"
              className="text-xs font-medium text-foreground"
            >
              {t("phtml.pageNumbersLabel")}
            </Label>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {t("phtml.pageNumbersHint")}
            </p>
          </div>
          <Switch
            id="phtml-page-numbers"
            checked={pageNumbers}
            onCheckedChange={(checked) => onChange("pageNumbers", checked)}
            aria-label={t("phtml.pageNumbersLabel")}
          />
        </div>

        {/* page range */}
        <div className="mt-4 border-t border-border pt-4">
          <Label
            htmlFor="phtml-pages"
            className="text-xs font-medium text-foreground"
          >
            {t("phtml.pagesLabel")}
          </Label>
          <input
            id="phtml-pages"
            type="text"
            value={pages}
            disabled={busy}
            onChange={(event) => onChange("pages", event.target.value)}
            placeholder={t("phtml.pagesPlaceholder")}
            aria-describedby="phtml-pages-hint"
            className="mt-2 h-10 w-full max-w-xs rounded-btn border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <p
            id="phtml-pages-hint"
            className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground"
          >
            {t("phtml.pagesHint")}
          </p>
        </div>

        <p className="mt-4 rounded-btn bg-muted/60 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          {t("phtml.honestNote")}
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
          {busy
            ? t("phtml.converting", { pct: pct ?? 0 })
            : t("phtml.convertBtn")}
        </Button>

        {done && !busy ? (
          <div className="flex flex-col gap-2 rounded-card border border-border bg-muted/40 px-3 py-2.5">
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-w-0 break-all text-xs text-muted-foreground">
                {t("phtml.doneDesc", {
                  name: done.name,
                  pages: done.pages,
                })}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 rounded-btn"
                onClick={() => downloadBlob(done.blob, done.name)}
              >
                <FileDown className="size-3.5" aria-hidden="true" />
                {t("phtml.again")}
              </Button>
            </div>
            <ul className="flex flex-wrap gap-1.5">
              <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
                {done.mode === "layout"
                  ? t("phtml.summaryLines", { count: done.blocks })
                  : t("phtml.summaryParagraphs", { count: done.blocks })}
              </li>
              {done.mode === "flow" ? (
                <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
                  {t("phtml.summaryHeadings", { count: done.headings })}
                </li>
              ) : null}
              <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
                {t("phtml.summarySelfContained")}
              </li>
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default PdfToHtmlSurface;
