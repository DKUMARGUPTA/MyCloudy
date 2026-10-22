"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  FileDown,
  FileText,
  Files,
  Loader2,
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
import type { RunDetail, WorkerResponse } from "@/lib/workers/protocol";
import { cn } from "@/lib/utils";

/**
 * PDF → OpenDocument Text surface (RB4-d — the pdf-to-powerpoint
 * workspace pattern, landing surface): the workspace owns the whole
 * flow on the landing page —
 *
 *  - its own DropZone (the shared component sniffs %PDF magic bytes,
 *    never extensions);
 *  - a live probe: pdf.js opens the file on the MAIN thread (text
 *    content of page 1 only, no render) and reports the page count
 *    before you commit; scanned pages warn honestly and point at the
 *    OCR tool;
 *  - the options: the page range and the one-file-per-page switch —
 *    bound to the shared option values (the aside chips and these
 *    controls write through one source of truth);
 *  - Convert spawns the worker, streams real progress, downloads +
 *    toasts, and shows the honest paragraph/heading counts. The
 *    standing explainer says it opens in Word/LibreOffice/Google Docs
 *    and that the layout REFLOWS — never a pixel-identical promise.
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
  names: string[];
  primary: { name: string; blob: Blob };
  pages: number;
  paragraphs: number;
  headings: number;
  files: number;
}

export function PdfToOdtSurface({
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

  const pages = typeof values.pages === "string" ? values.pages : "all";
  const perPage = values.perPage === true;
  const busy = pct !== null;

  /* Localized values for the shell-CTA run (the schema panel never
   * carries locale strings — the pdf-to-powerpoint pattern). */
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      onChange("locale", locale === "hi" ? "hi" : "en");
      onChange("fileWord", t("podt.fileWord"));
    });
    return () => {
      cancelled = true;
    };
  }, [onChange, locale, t]);

  /* -------- page-count probe (main-thread pdf.js, page 1 only) ----- */

  useEffect(() => {
    if (!file) {
      setProbe(null);
      setRunBlocked("podt.ctaNoFile");
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
          setRunBlocked("podt.probeFailTitle");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, setRunBlocked]);

  /* -------- Convert (surface-driven run, workspace pattern) --------- */

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
          const detail = data.detail as RunDetail | undefined;
          if (output) {
            const safeName = sanitizeFileName(output.name, "odt");
            downloadBlob(output.blob, safeName);
            setDone({
              names: data.outputs.map((o) => o.name),
              primary: { name: safeName, blob: output.blob },
              pages: detail?.pages ?? 0,
              paragraphs: detail?.paragraphs ?? 0,
              headings: detail?.headings ?? 0,
              files: data.outputs.length,
            });
            toast({
              title: t("podt.doneTitle"),
              description: t("podt.doneDesc", {
                name: safeName,
                pages: detail?.pages ?? 0,
                paragraphs: detail?.paragraphs ?? 0,
                headings: detail?.headings ?? 0,
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
      toolId: "pdf-to-odt",
      options: {
        pages,
        perPage,
        locale: locale === "hi" ? "hi" : "en",
        fileWord: t("podt.fileWord"),
      },
      files: [file],
    });
  }, [file, locale, pages, perPage, t, toast]);

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
        aria-labelledby="podt-drop-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="podt-drop-heading" className="sr-only">
          {t("podt.surfaceLabel")}
        </h2>
        <DropZone
          labelKey="podt.dropLabel"
          multiple={false}
          maxFiles={1}
          acceptKind="pdf"
          onAccept={addFiles}
          currentCount={files.length}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("podt.dropHint")}
        </p>
      </section>
    );
  }

  const current =
    probe !== null && probe.file === file ? probe : null;

  return (
    <section
      aria-labelledby="podt-workspace-heading"
      className="flex min-w-0 flex-col gap-4"
    >
      {/* ---------------- detected file card + preview count ---------------- */}
      <div className="rounded-card border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="flex size-11 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <Files className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p
              className="truncate text-sm font-semibold text-foreground"
              title={file.name}
            >
              {file.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatBytes(file.size)} · {t("podt.fileCard")}
            </p>
          </div>
          {current?.kind === "ok" ? (
            <span className="shrink-0 rounded-chip bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
              {t("podt.previewCount", { pages: current.pages })}
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
            {t("podt.previewTitle")}
          </p>
        </div>
        {current === null ? (
          <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Loader2
              className="size-3.5 shrink-0 animate-spin"
              aria-hidden="true"
            />
            {t("podt.probeWait")}
          </p>
        ) : current.kind === "ok" ? (
          <p className="px-3 py-3 text-xs font-medium text-foreground">
            {t("podt.probeOk", { pages: current.pages })}
          </p>
        ) : current.kind === "scan" ? (
          <div className="flex items-start gap-2.5 px-3 py-3">
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0 text-amber-500"
              aria-hidden="true"
            />
            <div className="min-w-0 text-xs leading-relaxed">
              <p className="font-semibold text-foreground">
                {t("podt.probeScanTitle")}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {t("podt.probeScanBody")}
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
                {t("podt.probeFailTitle")}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {t("podt.probeFailBody")}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ---------------- options ---------------- */}
      <div className="rounded-card border border-border bg-card p-4 sm:p-5">
        <h2
          id="podt-workspace-heading"
          className="text-sm font-semibold text-foreground"
        >
          {t("podt.optTitle")}
        </h2>

        {/* page range */}
        <div className="mt-3">
          <Label
            htmlFor="podt-pages"
            className="text-xs font-medium text-foreground"
          >
            {t("podt.pagesLabel")}
          </Label>
          <input
            id="podt-pages"
            type="text"
            value={pages}
            disabled={busy}
            onChange={(event) => onChange("pages", event.target.value)}
            placeholder={t("podt.pagesPlaceholder")}
            aria-describedby="podt-pages-hint"
            className="mt-2 h-10 w-full max-w-xs rounded-btn border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <p
            id="podt-pages-hint"
            className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground"
          >
            {t("podt.pagesHint")}
          </p>
        </div>

        {/* one file per page */}
        <div className="mt-4 border-t border-border pt-4">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="podt-perpage" className="text-xs font-medium">
              {t("podt.perPageLabel")}
            </Label>
            <Switch
              id="podt-perpage"
              checked={perPage}
              disabled={busy}
              onCheckedChange={(checked) => onChange("perPage", checked)}
              aria-label={t("podt.perPageLabel")}
            />
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {t("podt.perPageHint")}
          </p>
        </div>

        <p className="mt-4 rounded-btn bg-muted/60 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          {t("podt.honestNote")}
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
            ? t("podt.converting", { pct: pct ?? 0 })
            : t("podt.convertBtn")}
        </Button>
      </div>

      {/* ---------------- summary (blocks + headings) ---------------- */}
      {done && !busy ? (
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
              {done.primary.name}
            </span>
          </div>
          <ul className="flex flex-wrap gap-1.5">
            <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
              {t("podt.summaryPages", { count: done.pages })}
            </li>
            <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
              {t("podt.summaryParagraphs", { count: done.paragraphs })}
            </li>
            <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
              {t("podt.summaryHeadings", { count: done.headings })}
            </li>
          </ul>
          {done.files > 1 ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("podt.filesNote", { count: done.files })}
            </p>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn("shrink-0 self-start rounded-btn")}
              onClick={() =>
                downloadBlob(done.primary.blob, done.primary.name)
              }
            >
              <FileDown className="size-3.5" aria-hidden="true" />
              {t("podt.again")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default PdfToOdtSurface;
