"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BadgeCheck,
  CheckCircle2,
  Coins,
  FileCode2,
  FileDown,
  FileJson2,
  FileSearch,
  List,
  ListOrdered,
  Loader2,
  Receipt,
  ScanText,
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
import type {
  Confidence,
  InvoiceSummary,
  PdfToEInvoiceDetail,
} from "./types";

/**
 * PDF invoice → e-invoice surface (RB5-c — pdf-to-markdown +
 * repair-pdf precedent): the workspace owns the whole flow —
 *
 *  - its own DropZone (the shared component sniffs %PDF magic
 *    bytes, never extensions);
 *  - a CHEAP main-thread probe: pdf.js opens the file (page count,
 *    the attachments map, page-1 text) — enough for the honest
 *    pre-flight banner: green "embedded Factur-X XML found" vs
 *    amber "no XML embedded — layout extraction (best-effort)";
 *  - Convert spawns the worker (on-device), which extracts the
 *    embedded XML (Path A) or sniffs the layout (Path B);
 *  - the result panel renders the DETECTED-PATH banner, the field
 *    summary with confidence chips + monospace source snippets, the
 *    tax blocks, the line items, the not-found list (never
 *    fabricated), and the download (invoice.xml / invoice.json).
 */

interface ProbeState {
  file: File;
  kind: "xml" | "text" | "scan" | "fail";
  pages: number;
  attachmentName?: string;
}

interface DoneState {
  key: string;
  name: string;
  blob: Blob;
  detail: PdfToEInvoiceDetail;
}

/** Field display order (matches the model's FIELD_KEYS). */
const FIELD_ORDER = [
  "invoiceNumber",
  "issueDate",
  "dueDate",
  "currency",
  "sellerName",
  "buyerName",
  "sellerTaxId",
  "buyerTaxId",
  "lineCount",
  "lineTotal",
  "taxBasisTotal",
  "grandTotal",
] as const;

/** One confidence chip (the honest High/Medium/Low grading). */
function ConfidenceChip({ level }: { level: Confidence }): React.JSX.Element {
  const style =
    level === "high"
      ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : level === "medium"
        ? "border-amber-500/30 bg-amber-500/15 text-amber-800 dark:text-amber-300"
        : "border-border bg-muted/50 text-muted-foreground";
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${style}`}
    >
      {level}
    </span>
  );
}

export function PdfToEInvoiceSurface({
  files,
  values,
  onChange,
  setRunBlocked,
  addFiles,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const file = files[0]?.file ?? null;
  const fileKey = file
    ? `${file.name}:${file.size}:${file.lastModified}`
    : "";

  const [probe, setProbe] = useState<ProbeState | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [done, setDone] = useState<DoneState | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const busy = pct !== null;

  /* Localized values for the shell-CTA run (the schema panel never
   * carries locale strings — the repair-pdf pattern). */
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      onChange(
        "run",
        JSON.stringify({
          locale: locale === "hi" ? "hi" : "en",
          fileWord: t("peinv.fileWord"),
        })
      );
    });
    return () => {
      cancelled = true;
    };
  }, [locale, t, onChange]);

  /* -------- cheap probe: attachments + page count + page-1 text --- */

  useEffect(() => {
    if (!file) {
      setProbe(null);
      setRunBlocked("peinv.ctaNoFile");
      return;
    }
    setRunBlocked(null);
    setDone(null);
    let cancelled = false;
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        // Fresh copy — pdf.js DETACHES the buffer it receives.
        const data = new Uint8Array(await file.arrayBuffer());
        const doc = await pdfjs.getDocument({ data, ...PDF_DOC_PARAMS })
          .promise;
        try {
          let attachmentName: string | undefined;
          try {
            const atts = await doc.getAttachments();
            if (atts !== null && typeof atts === "object") {
              const names = Object.keys(atts);
              attachmentName = names.find((n) => /\.xml$/i.test(n));
            }
          } catch {
            // attachments are optional — the worker re-checks anyway
          }
          let chars = 0;
          if (attachmentName === undefined) {
            const page = await doc.getPage(1);
            try {
              const content = await page.getTextContent();
              for (const item of content.items as unknown[]) {
                const str = (item as { str?: unknown }).str;
                if (typeof str === "string") chars += str.trim().length;
              }
            } finally {
              page.cleanup();
            }
          }
          if (cancelled) return;
          setProbe({
            file,
            kind:
              attachmentName !== undefined
                ? "xml"
                : chars > 0
                  ? "text"
                  : "scan",
            pages: doc.numPages,
            attachmentName,
          });
        } finally {
          await doc.destroy().catch(() => undefined);
        }
      } catch {
        if (!cancelled) {
          setProbe({ file, kind: "fail", pages: 0 });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, setRunBlocked]);

  /* -------- Extract (surface-driven run, repair-pdf pattern) ----- */

  const extract = useCallback((): void => {
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
            const detail = (data.detail ?? {}) as PdfToEInvoiceDetail;
            setDone({
              key: fileKey,
              name: output.name,
              blob: output.blob,
              detail,
            });
            downloadBlob(output.blob, sanitizeFileName(output.name, "xml"));
            const summary = detail.summary;
            toast({
              title: t("peinv.doneTitle"),
              description:
                summary?.path === "A"
                  ? t("peinv.doneDescA", { name: output.name })
                  : t("peinv.doneDescB", {
                      name: output.name,
                      count: detail.fieldsFound ?? 0,
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
      toolId: "pdf-to-e-invoice",
      options: {
        run: JSON.stringify({
          locale: locale === "hi" ? "hi" : "en",
          fileWord: t("peinv.fileWord"),
        }),
      },
      files: [file],
    });
  }, [file, fileKey, locale, t, toast]);

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
        aria-labelledby="peinv-drop-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="peinv-drop-heading" className="sr-only">
          {t("peinv.surfaceLabel")}
        </h2>
        <DropZone
          labelKey="peinv.dropLabel"
          multiple={false}
          maxFiles={1}
          acceptKind="pdf"
          onAccept={addFiles}
          currentCount={files.length}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("peinv.dropHint")}
        </p>
      </section>
    );
  }

  const current = probe !== null && probe.file === file ? probe : null;
  const report = done !== null && done.key === fileKey ? done : null;
  const summary: InvoiceSummary | undefined = report?.detail.summary;

  return (
    <section
      aria-labelledby="peinv-workspace-heading"
      className="flex min-w-0 flex-col gap-4"
    >
      {/* ---------------- detected file card ---------------- */}
      <div className="rounded-card border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="flex size-11 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <Receipt className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p
              className="truncate text-sm font-semibold text-foreground"
              title={file.name}
            >
              {file.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatBytes(file.size)} · {t("peinv.fileCard")}
            </p>
          </div>
          {current !== null && current.kind !== "fail" ? (
            <span className="shrink-0 rounded-chip bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
              {t("peinv.probeCount", { pages: current.pages })}
            </span>
          ) : null}
        </div>
      </div>

      {/* ---------------- pre-flight probe ---------------- */}
      <div
        aria-live="polite"
        className="rounded-card border border-border bg-muted/40"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <p className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-foreground">
            <FileSearch
              className="size-3.5 shrink-0 text-primary"
              aria-hidden="true"
            />
            {t("peinv.probeTitle")}
          </p>
        </div>
        {current === null ? (
          <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Loader2
              className="size-3.5 shrink-0 animate-spin"
              aria-hidden="true"
            />
            {t("peinv.probeWait")}
          </p>
        ) : current.kind === "xml" ? (
          <div className="flex items-start gap-2.5 px-3 py-3">
            <BadgeCheck
              className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            <div className="min-w-0 text-xs leading-relaxed">
              <p className="font-semibold text-foreground">
                {t("peinv.probeXmlFound")}
              </p>
              <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
                {current.attachmentName}
              </p>
            </div>
          </div>
        ) : current.kind === "scan" ? (
          <div className="flex items-start gap-2.5 px-3 py-3">
            <ScanText
              className="mt-0.5 size-4 shrink-0 text-amber-500"
              aria-hidden="true"
            />
            <div className="min-w-0 text-xs leading-relaxed">
              <p className="font-semibold text-foreground">
                {t("peinv.probeScan")}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {t("peinv.probeScanBody")}
              </p>
            </div>
          </div>
        ) : current.kind === "fail" ? (
          <div className="flex items-start gap-2.5 px-3 py-3">
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0 text-amber-500"
              aria-hidden="true"
            />
            <div className="min-w-0 text-xs leading-relaxed">
              <p className="font-semibold text-foreground">
                {t("peinv.probeFailTitle")}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {t("peinv.probeFailBody")}
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
                {t("peinv.probeNoXml")}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {t("peinv.probeNoXmlBody")}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ---------------- honest explainer ---------------- */}
      <div className="rounded-card border border-border bg-card p-4 sm:p-5">
        <h2
          id="peinv-workspace-heading"
          className="text-sm font-semibold text-foreground"
        >
          {t("peinv.explainTitle")}
        </h2>
        <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <li className="flex min-w-0 items-start gap-2 rounded-btn bg-muted/60 px-3 py-2 text-[11px] leading-relaxed text-foreground">
            <FileCode2
              className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            {t("peinv.explainA")}
          </li>
          <li className="flex min-w-0 items-start gap-2 rounded-btn bg-muted/60 px-3 py-2 text-[11px] leading-relaxed text-foreground">
            <FileJson2
              className="mt-0.5 size-3.5 shrink-0 text-amber-500"
              aria-hidden="true"
            />
            {t("peinv.explainB")}
          </li>
        </ul>
        <p className="mt-3 rounded-btn bg-muted/60 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          {t("peinv.honestNote")}
        </p>
      </div>

      {/* ---------------- extract + progress ---------------- */}
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          size="touch"
          className="w-full rounded-btn font-semibold"
          onClick={extract}
          disabled={busy || current?.kind === "fail"}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <FileDown className="size-4" aria-hidden="true" />
          )}
          {busy
            ? t("peinv.extracting", { pct: pct ?? 0 })
            : t("peinv.extractBtn")}
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
            <span className="shrink-0">{t("peinv.working")}</span>
          </div>
        ) : null}
      </div>

      {/* ---------------- result: path banner + fields ---------------- */}
      {report !== null && !busy && summary !== undefined ? (
        <div className="flex flex-col gap-3">
          {/* the detected-path banner */}
          <div
            className={
              summary.path === "A"
                ? "flex items-start gap-2.5 rounded-card border border-emerald-500/30 bg-emerald-500/10 px-3 py-3"
                : "flex items-start gap-2.5 rounded-card border border-amber-500/30 bg-amber-500/10 px-3 py-3"
            }
            role="status"
            aria-live="polite"
          >
            {summary.path === "A" ? (
              <BadgeCheck
                className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
            ) : (
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0 text-amber-500"
                aria-hidden="true"
              />
            )}
            <div className="min-w-0 text-xs leading-relaxed">
              <p className="font-semibold text-foreground">
                {summary.path === "A"
                  ? t("peinv.bannerA")
                  : t("peinv.bannerB")}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {summary.path === "A"
                  ? t("peinv.bannerANote", {
                      name: summary.attachmentName ?? "factur-x.xml",
                    })
                  : t("peinv.bannerBNote", {
                      count: summary.fields.length,
                    })}
              </p>
            </div>
          </div>

          {/* download row */}
          <div className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-muted/40 px-3 py-2.5">
            <CheckCircle2
              className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {report.name}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 rounded-btn"
              onClick={() =>
                downloadBlob(
                  report.blob,
                  sanitizeFileName(report.name, "xml")
                )
              }
            >
              <FileDown className="size-3.5" aria-hidden="true" />
              {t("peinv.again")}
            </Button>
          </div>

          {/* field summary */}
          <div className="overflow-hidden rounded-card border border-border bg-card">
            <p className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
              <List className="size-3.5 shrink-0" aria-hidden="true" />
              {t("peinv.fieldsTitle")}
            </p>
            <ul className="flex flex-col divide-y divide-border/60">
              {FIELD_ORDER.map((key) => {
                const field = summary.fields.find((f) => f.key === key);
                const found = field !== undefined;
                return (
                  <li
                    key={key}
                    className={`grid grid-cols-[minmax(0,1fr)] gap-1.5 px-4 py-2.5 sm:grid-cols-[9.5rem_minmax(0,1fr)_auto] sm:items-start sm:gap-3 ${
                      found ? "" : "opacity-60"
                    }`}
                  >
                    <dt className="pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {t(`peinv.field_${key}`)}
                    </dt>
                    <dd className="min-w-0">
                      {found ? (
                        <>
                          <p className="break-words text-sm font-semibold text-foreground">
                            {field.value}
                          </p>
                          <p className="mt-1 break-all rounded-btn bg-muted/70 px-2 py-1 font-mono text-[10px] leading-relaxed text-muted-foreground">
                            {field.sourceSnippet}
                          </p>
                          {field.span !== undefined ? (
                            <p className="mt-1 text-[10px] text-muted-foreground">
                              {t("peinv.sourcePage", { page: field.span.page })}
                            </p>
                          ) : null}
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {t("peinv.notFound")}
                        </p>
                      )}
                    </dd>
                    <dd className="pt-1">
                      {found ? (
                        <ConfidenceChip level={field.confidence} />
                      ) : null}
                    </dd>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* taxes */}
          {summary.taxes.length > 0 ? (
            <div className="overflow-hidden rounded-card border border-border bg-card">
              <p className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
                <Coins className="size-3.5 shrink-0" aria-hidden="true" />
                {t("peinv.taxesTitle")}
              </p>
              <ul className="flex flex-col divide-y divide-border/60">
                {summary.taxes.map((tax, i) => (
                  <li
                    key={`${tax.type}-${i}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm"
                  >
                    <span className="font-semibold text-foreground">
                      {tax.type}
                    </span>
                    {tax.rate.length > 0 ? (
                      <span className="rounded-chip bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground">
                        {tax.rate}%
                      </span>
                    ) : null}
                    {tax.amount.length > 0 ? (
                      <span className="text-foreground">{tax.amount}</span>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                      {tax.sourceSnippet}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* line items */}
          {summary.lineItems.length > 0 ? (
            <div className="overflow-hidden rounded-card border border-border bg-card">
              <p className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
                <ListOrdered className="size-3.5 shrink-0" aria-hidden="true" />
                {t("peinv.itemsTitle", { count: summary.lineItems.length })}
              </p>
              <ul className="flex max-h-96 flex-col divide-y divide-border/60 overflow-y-auto">
                {summary.lineItems.map((item, i) => (
                  <li
                    key={`${item.description}-${i}`}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm"
                  >
                    <span className="min-w-0 flex-1 break-words text-foreground">
                      {item.description}
                    </span>
                    {item.qty.length > 0 ? (
                      <span className="text-xs text-muted-foreground">
                        ×{item.qty}
                      </span>
                    ) : null}
                    {item.unitPrice.length > 0 ? (
                      <span className="text-xs text-muted-foreground">
                        @{item.unitPrice}
                      </span>
                    ) : null}
                    <span className="font-semibold text-foreground">
                      {item.amount}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* honesty footer */}
          <p className="rounded-card border border-border bg-muted/40 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
            {summary.path === "A"
              ? t("peinv.footerA")
              : t("peinv.footerB", {
                  pages: summary.pagesRead,
                  truncated: summary.truncated === true ? 1 : 0,
                })}
          </p>
        </div>
      ) : null}
    </section>
  );
}

export default PdfToEInvoiceSurface;
