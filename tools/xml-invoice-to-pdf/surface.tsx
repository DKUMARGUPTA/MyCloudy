"use client";

/**
 * XML e-invoice to PDF surface (RB5-d — the 87th tool). CII + UBL 2.1
 * XML → PDF, 100% on-device, EN + हिंदी.
 *
 * Landing (landingSurface — powerpoint-to-pdf precedent): the drop zone
 * is owned by the surface and sniffs the XML shape itself (leading "<" +
 * tag-ish char, then the REAL parse in a live report) so a renamed
 * non-XML file can never enter the pipeline. The 10 MB cap is enforced
 * before any read.
 *
 * Workspace: the file card (with a chip that names the detected dialect —
 * CII or UBL 2.1), the PRE-RENDER PARSE REPORT — found/missing chips for
 * invoice number, dates, currency, parties, items, taxes and totals +
 * the parser's plain-language notes — computed by the exact same
 * parseInvoice the worker runs, so the chips can never disagree with the
 * PDF; the A4/Letter toggle bound to the shared option values (the
 * aside/bottom-sheet chips and these buttons write through one source
 * of truth); and the Convert button that spawns the worker
 * (create-invoice pattern) → download + toast + the honest result
 * summary (pages, line items rendered, font path, issues). The shell CTA
 * runs the same worker through the standard pipeline — gated via
 * setRunBlocked while no file is present.
 *
 * Mobile-safe: min-w-0 on every text wrapper, wrapped chip rows, touch
 * CTA. Everything is real DOM text — no canvas.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  Check,
  CheckCircle2,
  FileCode2,
  FileDown,
  FileUp,
  Loader2,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { downloadBlob, sanitizeFileName } from "@/lib/files/output";
import { formatBytes } from "@/lib/storage/recent-files";
import type { WorkerResponse } from "@/lib/workers/protocol";
import { cn } from "@/lib/utils";
import {
  MAX_XML_BYTES,
  classifyRoot,
  currencyFmt,
  invoiceIsEmpty,
  invoiceTypeLabel,
  knownTypeCode,
  looksLikeXml,
  parseInvoice,
  parseXmlText,
} from "./model";
import type { InvoiceDialect, InvoiceLabelMap, ParsedInvoice } from "./types";

/* ------------------------------------------------------------------ */
/* Local shapes                                                         */
/* ------------------------------------------------------------------ */

/** The live parse report (key = the file it belongs to, stale-guarded). */
type BadCode = "TooLarge" | "NotXml" | "Malformed" | "NotCii" | "Empty";

interface ReportBase {
  key: string;
}
interface ReportOk extends ReportBase {
  kind: "ok";
  inv: ParsedInvoice;
  /** which dialect was detected — the file card chip speaks it. */
  dialect: InvoiceDialect;
}
interface ReportBad extends ReportBase {
  kind: "bad";
  code: BadCode;
}
interface ReportReading extends ReportBase {
  kind: "reading";
}
type Report = ReportOk | ReportBad | ReportReading | null;

/** Result summary (worker detail mirrored for the download card). */
interface Done {
  name: string;
  blob: Blob;
  pages: number;
  lines: number;
  totalLines: number;
  truncated: boolean;
  fontPath: "standard" | "devanagari";
  issueKeys: string[];
}

/**
 * Every label the PDF paints, resolved through t() at run time so the
 * sheet speaks the UI language (the create-invoice recipe; the worker
 * receives them pre-resolved through the `labels` option).
 */
const PDF_LABEL_KEYS: readonly string[] = [
  "ttl",
  "ttl380",
  "ttl381",
  "ttl382",
  "ttl383",
  "ttl384",
  "docType",
  "no",
  "date",
  "dueDate",
  "deliveryDate",
  "billTo",
  "yourRef",
  "currency",
  "taxId",
  "regNo",
  "colNo",
  "colItem",
  "colQty",
  "colTax",
  "colAmount",
  "sub",
  "charges",
  "allowances",
  "taxBasis",
  "tax",
  "taxTotal",
  "total",
  "paid",
  "due",
  "payment",
  "payRef",
  "iban",
  "account",
  "bic",
  "means",
  "notes",
  "page",
  "noItems",
  "truncA",
  "truncOf",
  "truncC",
];

/** Worker error code → toast keys (the honest per-code explanations). */
const ERROR_TOASTS: Record<
  string,
  { titleKey: string; descKey: string; sizeParam?: boolean }
> = {
  "xinv.errNoFile": { titleKey: "tool.errorTitle", descKey: "xinv.errNoFile" },
  "xinv.errTooLarge": {
    titleKey: "xinv.errTooLargeTitle",
    descKey: "xinv.errTooLargeDesc",
    sizeParam: true,
  },
  "xinv.errNotXml": {
    titleKey: "xinv.errNotXmlTitle",
    descKey: "xinv.errNotXmlDesc",
  },
  "xinv.errMalformed": {
    titleKey: "xinv.errMalformedTitle",
    descKey: "xinv.errMalformedDesc",
  },
  "xinv.errNotCii": {
    titleKey: "xinv.errNotCiiTitle",
    descKey: "xinv.errNotCiiDesc",
  },
  "xinv.errEmpty": {
    titleKey: "xinv.errEmptyTitle",
    descKey: "xinv.errEmptyDesc",
  },
};

const SIZE_LIMIT_LABEL = "10 MB";

/* ------------------------------------------------------------------ */
/* Surface                                                              */
/* ------------------------------------------------------------------ */

export function XmlInvoiceToPdfSurface({
  files,
  values,
  onChange,
  setFileOrder,
  setRunBlocked,
  addFiles,
}: ToolSurfaceProps): React.JSX.Element {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const file = files.length > 0 ? (files[files.length - 1]?.file ?? null) : null;
  const fileKey = file ? `${file.name}:${file.size}:${file.lastModified}` : "";

  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  const inputId = useId();

  const [report, setReport] = useState<Report>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const workerRef = useRef<Worker | null>(null);

  /* ---------- the PDF label map (pre-resolved for the worker) -------- */

  const labelMap: InvoiceLabelMap = useMemo(() => {
    const out: Record<string, string> = {};
    for (const key of PDF_LABEL_KEYS) out[key] = t(`xinv.${key}`);
    return out;
  }, [t]);

  /** Localized values for the shell-CTA run (the panel never carries
   *  locale strings — the powerpoint-to-pdf pattern). */
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      onChange("labels", JSON.stringify(labelMap));
      onChange("fileWord", t("xinv.fileWord"));
    });
    return () => {
      cancelled = true;
    };
  }, [onChange, labelMap, t]);

  /* ---------- live parse report: the SAME parser the worker uses ------ */

  useEffect(() => {
    if (!file) {
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (cancelled) return;
        setReport(null);
        setDone(null);
      });
      return () => {
        cancelled = true;
      };
    }
    let cancelled = false;
    // deferred microtask — the pinned no-sync-setState-in-effect rule
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setDone(null);
      setReport({ key: fileKey, kind: "reading" });
    });
    void (async () => {
      let next: Report;
      try {
        if (file.size > MAX_XML_BYTES) {
          next = { key: fileKey, kind: "bad", code: "TooLarge" };
        } else {
          const text = await file.text();
          if (!looksLikeXml(text)) {
            next = { key: fileKey, kind: "bad", code: "NotXml" };
          } else {
            const parsed = parseXmlText(text);
            if (!parsed.ok) {
              next = {
                key: fileKey,
                kind: "bad",
                code: parsed.reason === "not-xml" ? "NotXml" : "Malformed",
              };
            } else {
              const dialect = classifyRoot(parsed.root);
              if (dialect === null) {
                next = { key: fileKey, kind: "bad", code: "NotCii" };
              } else {
                const inv = parseInvoice(parsed.root);
                next = invoiceIsEmpty(inv)
                  ? { key: fileKey, kind: "bad", code: "Empty" }
                  : { key: fileKey, kind: "ok", inv, dialect };
              }
            }
          }
        }
      } catch {
        next = { key: fileKey, kind: "bad", code: "Malformed" };
      }
      if (!cancelled) setReport(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [file, fileKey]);

  const current =
    report !== null && report.key === fileKey && file ? report : null;
  const reportOk = current?.kind === "ok" ? current : null;

  /* ---------- CTA gate (scan-pdf pattern) ---------------------------- */

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setRunBlocked(
        !file
          ? "xinv.ctaNoFile"
          : current === null
            ? "xinv.ctaReading"
            : current.kind === "bad"
              ? "xinv.ctaBadFile"
              : null
      );
    });
    return () => {
      cancelled = true;
    };
  }, [file, current, setRunBlocked]);

  /* ---------- input pipeline (XML sniff + size limit) ---------------- */

  const acceptFile = useCallback(
    (incoming: File[]): void => {
      if (incoming.length === 0 || files.length > 0) return;
      const f = incoming[0];
      if (!f) return;
      if (f.size > MAX_XML_BYTES) {
        toast({
          title: t("xinv.errTooLargeTitle"),
          description: t("xinv.errTooLargeDesc", { size: SIZE_LIMIT_LABEL }),
          variant: "destructive",
        });
        return;
      }
      // Sniff the head ourselves (the shared DropZone sniffs PDF/image
      // magics — XML is this tool's own responsibility).
      void f
        .slice(0, 512)
        .text()
        .then((head) => {
          if (!looksLikeXml(head)) {
            toast({
              title: t("xinv.errNotXmlTitle"),
              description: t("xinv.errNotXmlDesc"),
              variant: "destructive",
            });
            return;
          }
          addFiles([f]);
        })
        .catch(() => {
          toast({
            title: t("tool.errorTitle"),
            description: t("tool.errorGeneric", { detail: "" }),
            variant: "destructive",
          });
        });
    },
    [addFiles, files.length, t, toast]
  );

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      acceptFile([...(event.target.files ?? [])]);
      event.target.value = ""; // allow re-selecting the same file
    },
    [acceptFile]
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);
      acceptFile([...event.dataTransfer.files]);
    },
    [acceptFile]
  );

  // Ctrl+V of a file from the desktop (house DropZone behaviour).
  useEffect(() => {
    const onPaste = (event: globalThis.ClipboardEvent): void => {
      const pasted = [...(event.clipboardData?.files ?? [])];
      if (pasted.length === 0) return;
      event.preventDefault();
      acceptFile(pasted);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [acceptFile]);

  const removeFile = useCallback((): void => {
    setFileOrder([]);
  }, [setFileOrder]);

  /* ---------- Convert → worker spawn (create-invoice pattern) -------- */

  const pageSize =
    String(values.pageSize ?? "a4") === "letter" ? "letter" : "a4";
  const busy = pct !== null;

  const convert = useCallback((): void => {
    if (!file || workerRef.current || !reportOk) return;
    setPct(0);
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
          const detail = data.detail as
            | {
                pages?: number;
                lines?: number;
                totalLines?: number;
                truncated?: boolean;
                fontPath?: "standard" | "devanagari";
                issueKeys?: string[];
              }
            | undefined;
          if (output) {
            const safeName = sanitizeFileName(output.name, "pdf");
            downloadBlob(output.blob, safeName);
            const pages = detail?.pages ?? 1;
            const lines = detail?.lines ?? 0;
            setDone({
              name: safeName,
              blob: output.blob,
              pages,
              lines,
              totalLines: detail?.totalLines ?? lines,
              truncated: detail?.truncated === true,
              fontPath: detail?.fontPath === "devanagari" ? "devanagari" : "standard",
              issueKeys: detail?.issueKeys ?? [],
            });
            toast({
              title: t("xinv.doneTitle"),
              description: t("xinv.doneDesc", { name: safeName, pages, lines }),
            });
          }
          cleanup();
          return;
        }
        if (data.type === "error") {
          setPct(null);
          const entry = ERROR_TOASTS[data.code];
          toast({
            title: entry ? t(entry.titleKey) : t("tool.errorTitle"),
            description: entry
              ? t(
                  entry.descKey,
                  entry.sizeParam ? { size: SIZE_LIMIT_LABEL } : undefined
                )
              : t(data.code, { detail: data.detail ?? "" }),
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
      toolId: "xml-invoice-to-pdf",
      options: {
        pageSize,
        labels: JSON.stringify(labelMap),
        fileWord: t("xinv.fileWord"),
      },
      files: [file],
    });
  }, [file, labelMap, pageSize, reportOk, t, toast]);

  // Kill a stuck worker if the surface unmounts mid-run.
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  /* ---------- found/missing chips ------------------------------------ */

  const inv = reportOk?.inv;

  const chips: { key: string; ok: boolean; value: string; title?: string }[] = inv
    ? [
        {
          key: "fNumber",
          ok: inv.meta.number !== "",
          value: inv.meta.number !== "" ? inv.meta.number : t("xinv.missing"),
          title: inv.meta.number,
        },
        {
          key: "fDate",
          ok: inv.meta.issueDate !== "",
          value: inv.meta.issueDate !== "" ? inv.meta.issueDate : t("xinv.missing"),
        },
        {
          key: "fType",
          ok: inv.meta.typeCode !== "",
          value:
            inv.meta.typeCode !== ""
              ? knownTypeCode(inv.meta.typeCode)
                ? `${inv.meta.typeCode} · ${invoiceTypeLabel(inv.meta.typeCode)}`
                : inv.meta.typeCode
              : t("xinv.missing"),
        },
        {
          key: "fCurrency",
          ok: inv.meta.currency !== "",
          value: inv.meta.currency !== "" ? inv.meta.currency : t("xinv.missing"),
        },
        {
          key: "fSeller",
          ok: inv.seller.name !== "" || inv.seller.tradingName !== "",
          value:
            inv.seller.name || inv.seller.tradingName || t("xinv.missing"),
          title: inv.seller.name || inv.seller.tradingName,
        },
        {
          key: "fBuyer",
          ok: inv.buyer.name !== "",
          value: inv.buyer.name !== "" ? inv.buyer.name : t("xinv.missing"),
          title: inv.buyer.name,
        },
        {
          key: "fLines",
          ok: inv.lines.length > 0,
          value:
            inv.lines.length > 0
              ? String(inv.lines.length)
              : t("xinv.missing"),
        },
        {
          key: "fTaxes",
          ok: inv.taxes.length > 0,
          value:
            inv.taxes.length > 0 ? String(inv.taxes.length) : t("xinv.missing"),
        },
        {
          key: "fTotal",
          ok: inv.totals.grandTotal !== null,
          value:
            inv.totals.grandTotal !== null
              ? currencyFmt(inv.totals.grandTotal, inv.meta.currency)
              : t("xinv.missing"),
        },
        {
          key: "fPayment",
          ok: inv.payment.reference !== "" || inv.payment.iban !== "",
          value:
            inv.payment.reference || inv.payment.iban || t("xinv.missing"),
          title: inv.payment.reference || inv.payment.iban,
        },
      ]
    : [];

  /* ---------------------------------------------------------------- */

  /* ------------------------------ render ------------------------------ */

  if (!file) {
    return (
      <section
        aria-labelledby="xinv-drop-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="xinv-drop-heading" className="sr-only">
          {t("xinv.selectFile")}
        </h2>
        <div
          onDragEnter={(event) => {
            event.preventDefault();
            dragCounter.current += 1;
            setDragOver(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            event.preventDefault();
            dragCounter.current = Math.max(0, dragCounter.current - 1);
            if (dragCounter.current === 0) setDragOver(false);
          }}
          onDrop={handleDrop}
          className={cn(
            "relative rounded-card border-2 border-dashed transition-all duration-200",
            dragOver
              ? "scale-[1.01] border-primary bg-primary/5 ring-4 ring-primary/10"
              : "border-border bg-card hover:border-primary/40"
          )}
        >
          <label
            htmlFor={inputId}
            className="flex min-h-44 cursor-pointer flex-col items-center justify-center gap-3 px-6 py-8 text-center"
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-14 items-center justify-center rounded-full border transition-all duration-200",
                dragOver
                  ? "scale-110 border-primary bg-primary/10 text-primary"
                  : "border-border bg-muted/50 text-muted-foreground"
              )}
            >
              {dragOver ? (
                <FileUp className="size-6 animate-in fade-in-50 zoom-in-75" />
              ) : (
                <FileCode2 className="size-6" />
              )}
            </span>
            <span className="text-sm font-semibold text-foreground">
              {t("xinv.selectFile")}
            </span>
            <span className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>{t("xinv.dropHint")}</span>
              <span aria-hidden="true">·</span>
              <span className="font-medium">
                <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-sans text-[10px]">
                  Ctrl
                </kbd>
                <span> + </span>
                <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-sans text-[10px]">
                  V
                </kbd>
                <span className="sr-only"> </span>
                <span> {t("xinv.pasteHint")}</span>
              </span>
            </span>
            <span className="text-[11px] text-muted-foreground">
              {t("xinv.limits", { size: SIZE_LIMIT_LABEL })}
            </span>
          </label>
          <input
            id={inputId}
            type="file"
            accept=".xml,text/xml,application/xml"
            className="sr-only"
            onChange={handleInputChange}
            aria-label={t("xinv.selectFile")}
          />
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="xinv-workspace-heading"
      className="flex min-w-0 flex-col gap-4"
    >
      {/* ---------------- file card ---------------- */}
      <div className="rounded-card border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="flex size-11 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <FileCode2 className="size-5" />
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
          {reportOk ? (
            <span className="shrink-0 rounded-chip bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
              {t(reportOk.dialect === "ubl" ? "xinv.ublChip" : "xinv.xmlChip")}
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-btn"
            onClick={removeFile}
            aria-label={t("xinv.removeFile")}
          >
            <X className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{t("xinv.removeFile")}</span>
          </Button>
        </div>
      </div>

      {/* ---------------- pre-render parse report ---------------- */}
      <div
        aria-live="polite"
        className="rounded-card border border-border bg-muted/40"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <p className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-foreground">
            <FileCode2
              className="size-3.5 shrink-0 text-primary"
              aria-hidden="true"
            />
            {t("xinv.reportTitle")}
          </p>
        </div>

        {current === null || current.kind === "reading" ? (
          <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Loader2
              className="size-3.5 shrink-0 animate-spin"
              aria-hidden="true"
            />
            {t("xinv.ctaReading")}
          </p>
        ) : current.kind === "bad" ? (
          <div className="flex items-start gap-2.5 px-3 py-3">
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0 text-amber-500"
              aria-hidden="true"
            />
            <div className="min-w-0 text-xs leading-relaxed">
              <p className="font-semibold text-foreground">
                {current.code === "TooLarge"
                  ? t("xinv.errTooLargeTitle")
                  : current.code === "NotXml"
                    ? t("xinv.errNotXmlTitle")
                    : current.code === "Malformed"
                      ? t("xinv.errMalformedTitle")
                      : current.code === "NotCii"
                        ? t("xinv.errNotCiiTitle")
                        : t("xinv.errEmptyTitle")}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {current.code === "TooLarge"
                  ? t("xinv.errTooLargeDesc", { size: SIZE_LIMIT_LABEL })
                  : current.code === "NotXml"
                    ? t("xinv.errNotXmlDesc")
                    : current.code === "Malformed"
                      ? t("xinv.errMalformedDesc")
                      : current.code === "NotCii"
                        ? t("xinv.errNotCiiDesc")
                        : t("xinv.errEmptyDesc")}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 px-3 py-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("xinv.reportOk")}
            </p>

            {/* found / missing chips */}
            <ul className="flex flex-wrap gap-1.5" aria-label={t("xinv.reportTitle")}>
              {chips.map((chip) => (
                <li
                  key={chip.key}
                  title={chip.title ?? chip.value}
                  className={cn(
                    "flex min-w-0 max-w-full items-center gap-1.5 rounded-chip px-2.5 py-1 text-[11px] font-medium",
                    chip.ok
                      ? "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
                      : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                  )}
                >
                  {chip.ok ? (
                    <Check className="size-3 shrink-0" aria-hidden="true" />
                  ) : (
                    <TriangleAlert
                      className="size-3 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <span className="shrink-0">
                    {t(`xinv.${chip.key}`)}
                    <span aria-hidden="true">: </span>
                  </span>
                  <span className="min-w-0 truncate">{chip.value}</span>
                </li>
              ))}
            </ul>

            {/* parser notes (issues) */}
            {current.inv.issues.length > 0 ? (
              <div className="min-w-0">
                <p className="text-xs font-semibold text-foreground">
                  {t("xinv.issuesTitle")}
                </p>
                <ul className="mt-1.5 max-h-40 space-y-1 overflow-y-auto pr-1 text-[11px] leading-relaxed text-muted-foreground">
                  {current.inv.issues.map((issue, i) => (
                    <li key={`${issue.code}-${i}`}>{t(`xinv.${issue.code}`)}</li>
                  ))}
                </ul>
                {current.inv.truncated ? (
                  <p className="mt-2 rounded-btn bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                    {t("xinv.truncatedNote")}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t("xinv.noIssues")}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ---------------- layout ---------------- */}
      <div className="rounded-card border border-border bg-card p-4 sm:p-5">
        <h2
          id="xinv-workspace-heading"
          className="text-sm font-semibold text-foreground"
        >
          {t("xinv.layoutTitle")}
        </h2>
        <div className="mt-3">
          <p className="text-xs font-medium text-foreground" aria-hidden="true">
            {t("xinv.pageSizeLbl")}
          </p>
          <div
            className="mt-2 inline-flex overflow-hidden rounded-btn border border-border"
            role="group"
            aria-label={t("xinv.pageSizeLbl")}
          >
            {(
              [
                { value: "a4", labelKey: "xinv.pageA4" },
                { value: "letter", labelKey: "xinv.pageLetter" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                disabled={busy}
                aria-pressed={pageSize === opt.value}
                onClick={() => onChange("pageSize", opt.value)}
                className={cn(
                  "min-h-11 px-4 text-xs font-medium transition-colors",
                  pageSize === opt.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-foreground hover:bg-muted"
                )}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-4 rounded-btn bg-muted/60 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          {t("xinv.honestNote")}
        </p>
      </div>

      {/* ---------------- convert + progress ---------------- */}
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          size="touch"
          className="w-full rounded-btn font-semibold"
          onClick={convert}
          disabled={busy || reportOk === null}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <FileDown className="size-4" aria-hidden="true" />
          )}
          {busy ? t("xinv.converting") : t("xinv.convert")}
        </Button>
      </div>

      {/* ---------------- result summary ---------------- */}
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
              {t("xinv.resultTitle")} — {done.name}
            </span>
          </div>
          <ul className="flex flex-wrap gap-1.5">
            <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
              {t("xinv.resultPages")}: {done.pages}
            </li>
            <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
              {t("xinv.resultLines")}: {done.lines}
              {done.totalLines > done.lines
                ? ` / ${done.totalLines}`
                : ""}
            </li>
            <li className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
              {t("xinv.resultFont")}:{" "}
              {done.fontPath === "devanagari"
                ? t("xinv.resultFontDeva")
                : t("xinv.resultFontStd")}
            </li>
          </ul>
          {done.truncated ? (
            <p className="rounded-btn bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
              {t("xinv.truncatedNote")}
            </p>
          ) : null}
          {done.issueKeys.length > 0 ? (
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground">
                {t("xinv.resultIssuesTitle")}
              </p>
              <ul className="mt-1.5 max-h-40 space-y-1 overflow-y-auto pr-1 text-[11px] leading-relaxed text-muted-foreground">
                {done.issueKeys.map((key, i) => (
                  <li key={`${key}-${i}`}>{t(key)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 self-start rounded-btn"
              onClick={() => downloadBlob(done.blob, done.name)}
            >
              <FileDown className="size-3.5" aria-hidden="true" />
              {t("xinv.resultAgain")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default XmlInvoiceToPdfSurface;
