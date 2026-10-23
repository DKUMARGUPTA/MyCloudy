"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Braces,
  CheckCircle2,
  FileDown,
  FileText,
  Hash,
  Link2,
  List,
  Loader2,
  Quote,
  Table,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { downloadBlob, sanitizeFileName } from "@/lib/files/output";
import { formatBytes } from "@/lib/storage/recent-files";
import { PDF_DOC_PARAMS, loadPdfjs } from "@/lib/pdf/pdfjs";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import type { WorkerResponse } from "@/lib/workers/protocol";
import type { PdfToMarkdownDetail } from "./model";

/**
 * PDF → Markdown surface (RB4-c — pdf-to-powerpoint precedent, landing
 * surface): the workspace owns the whole flow on the landing page —
 *
 *  - its own DropZone (the shared component sniffs %PDF magic bytes,
 *    never extensions);
 *  - a CHEAP main-thread probe: pdf.js opens the file (page count + the
 *    text of page 1 only, no render) — enough for an honest page-count
 *    preview and a scanned-pages warning. The heading count is NOT
 *    previewed (it needs the full-document extraction) — it lands in
 *    the run summary after the conversion, where it is real;
 *  - the honest explainer: what converts (headings by size rank,
 *    bold/italic, lists, quotes, links) and what doesn't (tables →
 *    PDF to Excel, images skipped, two-column approximate);
 *  - Convert spawns the worker with the shared option values (page
 *    range, per-page files, page rules, comment / front matter) and
 *    downloads the outputs; the shell CTA runs the same worker through
 *    the standard pipeline, where multiple outputs also get the ZIP.
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
  blob: Blob;
  files: number;
  pages: number;
  headings: number;
}

export function PdfToMarkdownSurface({
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
  const pageRules = values.pageRules === true;
  const metaComment = values.metaComment === true;
  const frontMatter = values.frontMatter === true;
  const busy = pct !== null;

  /* Localized values for the shell-CTA run (the schema panel never
   * carries locale strings — the pdf-to-powerpoint pattern). */
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      onChange("locale", locale === "hi" ? "hi" : "en");
      onChange("fileWord", t("pmd.fileWord"));
    });
    return () => {
      cancelled = true;
    };
  }, [onChange, locale, t]);

  /* -------- cheap probe: page count + scanned-pages warning ------- */

  useEffect(() => {
    if (!file) {
      setProbe(null);
      setRunBlocked("pmd.ctaNoFile");
      return;
    }
    setRunBlocked(null);
    let cancelled = false;
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        // Fresh copy — pdf.js DETACHES the buffer it receives.
        const data = new Uint8Array(await file.arrayBuffer());
        const doc = await pdfjs.getDocument({ data, ...PDF_DOC_PARAMS })
          .promise;
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
          setRunBlocked("pmd.probeFailTitle");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, setRunBlocked]);

  /* -------- Convert (surface-driven run, pdf-to-powerpoint pattern) -- */

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
          const detail = data.detail as PdfToMarkdownDetail | undefined;
          if (data.outputs.length > 0) {
            const names = data.outputs.map(
              (output) => output.name
            );
            for (const output of data.outputs) {
              downloadBlob(output.blob, sanitizeFileName(output.name, "md"));
            }
            setDone({
              names,
              blob: data.outputs[0]?.blob as Blob,
              files: data.outputs.length,
              pages: detail?.pages ?? 0,
              headings: detail?.headings ?? 0,
            });
            toast({
              title: t("pmd.doneTitle"),
              description:
                data.outputs.length > 1
                  ? t("pmd.doneDescMulti", {
                      count: data.outputs.length,
                    })
                  : t("pmd.doneDesc", { name: names[0] ?? "document.md" }),
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
      toolId: "pdf-to-markdown",
      options: {
        pages,
        perPage,
        pageRules,
        metaComment,
        frontMatter,
        locale: locale === "hi" ? "hi" : "en",
        fileWord: t("pmd.fileWord"),
      },
      files: [file],
    });
  }, [file, frontMatter, locale, metaComment, pageRules, pages, perPage, t, toast]);

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
        aria-labelledby="pmd-drop-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="pmd-drop-heading" className="sr-only">
          {t("pmd.surfaceLabel")}
        </h2>
        <DropZone
          labelKey="pmd.dropLabel"
          multiple={false}
          maxFiles={1}
          acceptKind="pdf"
          onAccept={addFiles}
          currentCount={files.length}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("pmd.dropHint")}
        </p>
      </section>
    );
  }

  const current = probe !== null && probe.file === file ? probe : null;

  return (
    <section
      aria-labelledby="pmd-workspace-heading"
      className="flex min-w-0 flex-col gap-4"
    >
      {/* ---------------- detected file card + page count ---------------- */}
      <div className="rounded-card border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="flex size-11 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <Braces className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p
              className="truncate text-sm font-semibold text-foreground"
              title={file.name}
            >
              {file.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatBytes(file.size)} · {t("pmd.fileCard")}
            </p>
          </div>
          {current?.kind === "ok" ? (
            <span className="shrink-0 rounded-chip bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
              {t("pmd.previewCount", { pages: current.pages })}
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
            {t("pmd.previewTitle")}
          </p>
        </div>
        {current === null ? (
          <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Loader2
              className="size-3.5 shrink-0 animate-spin"
              aria-hidden="true"
            />
            {t("pmd.probeWait")}
          </p>
        ) : current.kind === "ok" ? (
          <p className="px-3 py-3 text-xs font-medium text-foreground">
            {t("pmd.probeOk", { pages: current.pages })}
          </p>
        ) : current.kind === "scan" ? (
          <div className="flex items-start gap-2.5 px-3 py-3">
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0 text-amber-500"
              aria-hidden="true"
            />
            <div className="min-w-0 text-xs leading-relaxed">
              <p className="font-semibold text-foreground">
                {t("pmd.probeScanTitle")}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {t("pmd.probeScanBody")}
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
                {t("pmd.probeFailTitle")}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {t("pmd.probeFailBody")}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ---------------- honest explainer ---------------- */}
      <div className="rounded-card border border-border bg-card p-4 sm:p-5">
        <h2
          id="pmd-workspace-heading"
          className="text-sm font-semibold text-foreground"
        >
          {t("pmd.explainTitle")}
        </h2>
        <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <li className="flex min-w-0 items-start gap-2 rounded-btn bg-muted/60 px-3 py-2 text-[11px] leading-relaxed text-foreground">
            <Hash className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
            {t("pmd.explainHeadings")}
          </li>
          <li className="flex min-w-0 items-start gap-2 rounded-btn bg-muted/60 px-3 py-2 text-[11px] leading-relaxed text-foreground">
            <Braces className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
            {t("pmd.explainStyle")}
          </li>
          <li className="flex min-w-0 items-start gap-2 rounded-btn bg-muted/60 px-3 py-2 text-[11px] leading-relaxed text-foreground">
            <List className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
            {t("pmd.explainLists")}
          </li>
          <li className="flex min-w-0 items-start gap-2 rounded-btn bg-muted/60 px-3 py-2 text-[11px] leading-relaxed text-foreground">
            <Quote className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
            {t("pmd.explainQuotes")}
          </li>
          <li className="flex min-w-0 items-start gap-2 rounded-btn bg-muted/60 px-3 py-2 text-[11px] leading-relaxed text-foreground">
            <Link2 className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
            {t("pmd.explainLinks")}
          </li>
          <li className="flex min-w-0 items-start gap-2 rounded-btn bg-muted/60 px-3 py-2 text-[11px] leading-relaxed text-foreground">
            <Table className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
            {t("pmd.explainTables")}
          </li>
        </ul>
        <p className="mt-3 rounded-btn bg-muted/60 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          {t("pmd.honestNote")}
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
            ? t("pmd.converting", { pct: pct ?? 0 })
            : t("pmd.convertBtn")}
        </Button>

        {busy ? (
          <div
            className="flex items-center gap-2 rounded-card border border-border bg-card p-3 text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <Loader2
              className="size-4 shrink-0 animate-spin text-primary"
              aria-hidden="true"
            />
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="shrink-0">{t("pmd.working")}</span>
          </div>
        ) : null}

        {done && !busy ? (
          <div className="flex flex-col gap-2 rounded-card border border-border bg-muted/40 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <CheckCircle2
                className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {done.files > 1
                  ? t("pmd.doneMulti", { count: done.files })
                  : (done.names[0] ?? "document.md")}
              </span>
            </div>
            <ul className="flex flex-wrap gap-1.5">
              <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
                {t("pmd.summaryPages", { count: done.pages })}
              </li>
              <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
                {t("pmd.summaryHeadings", { count: done.headings })}
              </li>
              <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
                {t("pmd.summaryFiles", { count: done.files })}
              </li>
            </ul>
            <p className="min-w-0 break-all text-xs text-muted-foreground">
              {t("pmd.doneNote", {
                names: done.names.slice(0, 5).join(", "),
                extra: Math.max(0, done.files - 5),
              })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 rounded-btn"
                onClick={() => downloadBlob(done.blob, sanitizeFileName(done.names[0] ?? "document.md", "md"))}
              >
                <FileDown className="size-3.5" aria-hidden="true" />
                {done.files > 1
                  ? t("pmd.againFirst")
                  : t("pmd.again")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default PdfToMarkdownSurface;
