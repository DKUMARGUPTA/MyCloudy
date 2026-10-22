"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileDown,
  FileText,
  ImageIcon,
  Loader2,
  Presentation,
  Type,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { downloadBlob, sanitizeFileName } from "@/lib/files/output";
import { formatBytes } from "@/lib/storage/recent-files";
import { PDF_DOC_PARAMS, loadPdfjs } from "@/lib/pdf/pdfjs";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import type { WorkerResponse } from "@/lib/workers/protocol";
import { cn } from "@/lib/utils";
import type { PdfToPptDetail } from "./model";

/**
 * PDF → PowerPoint surface (RB3-d — create-card precedent, landing
 * surface): the workspace owns the whole flow on the landing page —
 *
 *  - its own DropZone (the shared component sniffs %PDF magic bytes,
 *    never extensions);
 *  - a live per-page preview count: pdf.js opens the file on the MAIN
 *    thread (text content of page 1 only, no render) and reports the
 *    page count → slide count before you commit; scanned pages warn
 *    honestly and point at the page-images mode instead;
 *  - the mode explainer: Editable text (real text boxes, positions
 *    approximate) vs Page images (pixel-exact look, not editable),
 *    the slide size (16:9 / 4:3 / match page) and the page range — all
 *    bound to the shared option values (the aside chips and these
 *    controls write through one source of truth);
 *  - Convert spawns the worker, streams real progress and downloads +
 *    toasts. Device-only, like every tool here.
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
  slides: number;
  emptySlides: number;
}

export function PdfToPowerpointSurface({
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

  const mode = values.mode === "images" ? "images" : "text";
  const slideSize =
    values.slideSize === "4-3" || values.slideSize === "match"
      ? (values.slideSize as "4-3" | "match")
      : "16-9";
  const pages = typeof values.pages === "string" ? values.pages : "all";
  const busy = pct !== null;

  /* Localized values for the shell-CTA run (powerpoint-to-pdf
   * pattern: the schema panel never carries locale strings). */
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      onChange("locale", locale === "hi" ? "hi" : "en");
      onChange("fileWord", t("p2ppt.fileWord"));
    });
    return () => {
      cancelled = true;
    };
  }, [onChange, locale, t]);

  /* -------- per-page preview count (main-thread pdf.js probe) ------ */

  useEffect(() => {
    if (!file) {
      setProbe(null);
      setRunBlocked("p2ppt.ctaNoFile");
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
          setRunBlocked("p2ppt.probeFailTitle");
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
          const detail = data.detail as PdfToPptDetail | undefined;
          if (output) {
            const safeName = sanitizeFileName(output.name, "pptx");
            downloadBlob(output.blob, safeName);
            setDone({
              name: safeName,
              blob: output.blob,
              slides: detail?.slides ?? 0,
              emptySlides: detail?.emptySlides ?? 0,
            });
            toast({
              title: t("p2ppt.doneTitle"),
              description:
                t("p2ppt.doneDesc", {
                  name: safeName,
                  slides: detail?.slides ?? 0,
                }) +
                ((detail?.emptySlides ?? 0) > 0
                  ? ` ${t("p2ppt.emptyNote", { count: detail?.emptySlides ?? 0 })}`
                  : ""),
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
      toolId: "pdf-to-powerpoint",
      options: {
        mode,
        slideSize,
        pages,
        locale: locale === "hi" ? "hi" : "en",
        fileWord: t("p2ppt.fileWord"),
      },
      files: [file],
    });
  }, [file, locale, mode, pages, slideSize, t, toast]);

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
        aria-labelledby="p2ppt-drop-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="p2ppt-drop-heading" className="sr-only">
          {t("p2ppt.surfaceLabel")}
        </h2>
        <DropZone
          labelKey="p2ppt.dropLabel"
          multiple={false}
          maxFiles={1}
          acceptKind="pdf"
          onAccept={addFiles}
          currentCount={files.length}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("p2ppt.dropHint")}
        </p>
      </section>
    );
  }

  const current =
    probe !== null && probe.file === file ? probe : null;

  return (
    <section
      aria-labelledby="p2ppt-workspace-heading"
      className="flex min-w-0 flex-col gap-4"
    >
      {/* ---------------- detected file card + preview count ---------------- */}
      <div className="rounded-card border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="flex size-11 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <Presentation className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p
              className="truncate text-sm font-semibold text-foreground"
              title={file.name}
            >
              {file.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatBytes(file.size)} · {t("p2ppt.fileCard")}
            </p>
          </div>
          {current?.kind === "ok" ? (
            <span className="shrink-0 rounded-chip bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
              {t("p2ppt.previewCount", { pages: current.pages })}
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
            {t("p2ppt.previewTitle")}
          </p>
        </div>
        {current === null ? (
          <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Loader2
              className="size-3.5 shrink-0 animate-spin"
              aria-hidden="true"
            />
            {t("p2ppt.probeWait")}
          </p>
        ) : current.kind === "ok" ? (
          <p className="px-3 py-3 text-xs font-medium text-foreground">
            {t("p2ppt.probeOk", { pages: current.pages })}
          </p>
        ) : current.kind === "scan" ? (
          <div className="flex items-start gap-2.5 px-3 py-3">
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0 text-amber-500"
              aria-hidden="true"
            />
            <div className="min-w-0 text-xs leading-relaxed">
              <p className="font-semibold text-foreground">
                {t("p2ppt.probeScanTitle")}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {t("p2ppt.probeScanBody")}
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
                {t("p2ppt.probeFailTitle")}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {t("p2ppt.probeFailBody")}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ---------------- options ---------------- */}
      <div className="rounded-card border border-border bg-card p-4 sm:p-5">
        <h2
          id="p2ppt-workspace-heading"
          className="text-sm font-semibold text-foreground"
        >
          {t("p2ppt.optTitle")}
        </h2>

        {/* mode + explainer */}
        <div className="mt-3">
          <p
            id="p2ppt-mode-label"
            className="text-xs font-medium text-foreground"
          >
            {t("p2ppt.modeLabel")}
          </p>
          <div
            role="group"
            aria-labelledby="p2ppt-mode-label"
            className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            <button
              type="button"
              aria-pressed={mode === "text"}
              onClick={() => onChange("mode", "text")}
              className={cn(
                "min-h-11 rounded-btn border px-3 py-2 text-left outline-none transition-colors",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                mode === "text"
                  ? "border-primary bg-primary/10"
                  : "border-border bg-background hover:border-primary/40"
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <Type className="size-3.5 shrink-0" aria-hidden="true" />
                {t("p2ppt.modeText")}
              </span>
              <span className="mt-1 block text-[11px] font-normal leading-relaxed text-muted-foreground">
                {t("p2ppt.modeTextHint")}
              </span>
            </button>
            <button
              type="button"
              aria-pressed={mode === "images"}
              onClick={() => onChange("mode", "images")}
              className={cn(
                "min-h-11 rounded-btn border px-3 py-2 text-left outline-none transition-colors",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                mode === "images"
                  ? "border-primary bg-primary/10"
                  : "border-border bg-background hover:border-primary/40"
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <ImageIcon className="size-3.5 shrink-0" aria-hidden="true" />
                {t("p2ppt.modeImages")}
              </span>
              <span className="mt-1 block text-[11px] font-normal leading-relaxed text-muted-foreground">
                {t("p2ppt.modeImagesHint")}
              </span>
            </button>
          </div>
        </div>

        {/* slide size */}
        <div className="mt-4">
          <p
            id="p2ppt-size-label"
            className="text-xs font-medium text-foreground"
          >
            {t("p2ppt.sizeLabel")}
          </p>
          <div
            role="group"
            aria-labelledby="p2ppt-size-label"
            className="mt-2 flex flex-wrap gap-2"
          >
            {(
              [
                ["16-9", "p2ppt.size169"],
                ["4-3", "p2ppt.size43"],
                ["match", "p2ppt.sizeMatch"],
              ] as const
            ).map(([value, key]) => (
              <button
                key={value}
                type="button"
                aria-pressed={slideSize === value}
                onClick={() => onChange("slideSize", value)}
                className={cn(
                  "h-9 rounded-btn px-4 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  slideSize === value
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground hover:bg-muted/80"
                )}
              >
                {t(key)}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {t("p2ppt.sizeHint")}
          </p>
        </div>

        {/* page range */}
        <div className="mt-4 border-t border-border pt-4">
          <Label
            htmlFor="p2ppt-pages"
            className="text-xs font-medium text-foreground"
          >
            {t("p2ppt.pagesLabel")}
          </Label>
          <input
            id="p2ppt-pages"
            type="text"
            value={pages}
            disabled={busy}
            onChange={(event) => onChange("pages", event.target.value)}
            placeholder={t("p2ppt.pagesPlaceholder")}
            aria-describedby="p2ppt-pages-hint"
            className="mt-2 h-10 w-full max-w-xs rounded-btn border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <p
            id="p2ppt-pages-hint"
            className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground"
          >
            {t("p2ppt.pagesHint")}
          </p>
        </div>

        <p className="mt-4 rounded-btn bg-muted/60 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          {t("p2ppt.honestNote")}
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
            ? t("p2ppt.converting", { pct: pct ?? 0 })
            : t("p2ppt.convertBtn")}
        </Button>

        {done && !busy ? (
          <div className="flex flex-col items-start gap-2 rounded-card border border-border bg-muted/40 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 break-all text-xs text-muted-foreground">
              {t("p2ppt.doneDesc", {
                name: done.name,
                slides: done.slides,
              })}
              {done.emptySlides > 0
                ? ` ${t("p2ppt.emptyNote", { count: done.emptySlides })}`
                : ""}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 rounded-btn"
              onClick={() => downloadBlob(done.blob, done.name)}
            >
              <FileDown className="size-3.5" aria-hidden="true" />
              {t("p2ppt.again")}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default PdfToPowerpointSurface;
