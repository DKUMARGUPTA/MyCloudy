"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Download,
  FileCode2,
  FileText,
  Info,
  ListChecks,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { downloadBlob } from "@/lib/files/output";
import { formatBytes } from "@/lib/storage/recent-files";
import type { WorkerResponse } from "@/lib/workers/protocol";
import { cn } from "@/lib/utils";
import { PreviewFileHeader } from "../stamp-common/preview-parts";
import { sniffInput } from "./model";
import type {
  Check,
  InputKind,
  ValidateDetail,
  Verdict,
} from "./types";

/**
 * Validate e-invoice surface (RB5-e) — the repair-pdf surface pattern: a
 * LOCAL magic-byte sniff (the SAME sniffInput the worker uses, imported
 * from the pure model — no heavy libs on the main thread) tells the user
 * what was detected, then a surface-driven worker run produces the full
 * verdict report: banner (green/amber/red), the checklist with chips +
 * expandable actual-vs-expected rows, the totals reconciliation mini-table
 * and the .txt report download. The whole validation — XML parse, checks,
 * report — happens in the Web Worker; the surface only renders the
 * structured report it posts back.
 */

/** Report label keys — every string the worker's .txt builder needs. */
const REPORT_KEYS = [
  "title", "file", "input", "inputXml", "inputPdf", "xmp",
  "vPass", "vWarn", "vFail", "cPassed", "cWarned", "cFailed",
  "checks", "expected", "actual", "note", "totals", "missing",
  "generatedBy", "honestyTitle", "honestyBody",
  "kRoot", "kContext", "kDocId", "kDate", "kType", "kSeller", "kBuyer",
  "kLines", "kSum", "kGrand", "kDue", "kTaxes", "kCurrency", "kConf",
  "nUbl", "nNoGuideline", "nIdSpace", "nDateIso", "nTypeUnknown",
  "nSellerMissing", "nBuyerMissing", "nNameless", "nLineNetBad",
  "nSumViaLt", "nNoParseableNets", "nBasisMissing", "nNoTaxEntries",
  "nDueMissing", "nTaxBad", "nCurrencyRare", "nConfMismatch",
  "nConfInsufficient", "nConfUnknown", "nConfLower",
] as const;

interface SniffState {
  key: string;
  kind: InputKind;
}

interface DoneState {
  key: string;
  name: string;
  blob: Blob;
  detail: ValidateDetail;
}

/* ------------------------------------------------------------------ */
/* Small presentational pieces (repair-pdf's ReportRow chip style)      */
/* ------------------------------------------------------------------ */

function statusChipClasses(status: Check["status"]): string {
  if (status === "pass") {
    return "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "warn") {
    return "border-amber-500/30 bg-amber-500/15 text-amber-800 dark:text-amber-300";
  }
  return "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300";
}

function StatusChip({
  status,
  label,
}: {
  status: Check["status"];
  label: string;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
        statusChipClasses(status)
      )}
    >
      {label}
    </span>
  );
}

function statusIconClasses(status: Check["status"]): string {
  if (status === "pass") return "text-emerald-600 dark:text-emerald-400";
  if (status === "warn") return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function StatusIcon({
  status,
}: {
  status: Check["status"];
}): React.JSX.Element {
  if (status === "pass") {
    return (
      <ShieldCheck
        className={cn("mt-0.5 size-4 shrink-0", statusIconClasses(status))}
        aria-hidden="true"
      />
    );
  }
  if (status === "warn") {
    return (
      <TriangleAlert
        className={cn("mt-0.5 size-4 shrink-0", statusIconClasses(status))}
        aria-hidden="true"
      />
    );
  }
  return (
    <ShieldAlert
      className={cn("mt-0.5 size-4 shrink-0", statusIconClasses(status))}
      aria-hidden="true"
    />
  );
}

/** One checklist row: label + chip + inline actual, expandable details. */
function CheckRow({
  check,
  open,
  onToggle,
}: {
  check: Check;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const hasDetails =
    (check.expected !== undefined && check.expected.length > 0) ||
    (check.actual !== undefined && check.actual.length > 0) ||
    check.note !== undefined;
  return (
    <li className="flex flex-col">
      <div className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left">
        <StatusIcon status={check.status} />
        <span className="min-w-0 flex-1 text-sm leading-relaxed text-foreground">
          {t(check.label)}
          {check.actual !== undefined && check.actual.length > 0 ? (
            <span className="ml-1.5 break-all font-mono text-xs text-muted-foreground">
              {check.actual}
            </span>
          ) : null}
          {check.note !== undefined && !open ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {t(check.note)}
            </span>
          ) : null}
        </span>
        <StatusChip status={check.status} label={t(`vei.st${check.status === "pass" ? "Pass" : check.status === "warn" ? "Warn" : "Fail"}`)} />
        {hasDetails ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 rounded-btn px-2 text-xs"
            aria-expanded={open}
            onClick={onToggle}
          >
            {open ? (
              <ChevronDown className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden="true" />
            )}
            {open ? t("vei.hideDetailsBtn") : t("vei.detailsBtn")}
          </Button>
        ) : (
          <span className="w-2 shrink-0" aria-hidden="true" />
        )}
      </div>
      {open && hasDetails ? (
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-border/50 bg-muted/30 px-4 py-2.5 text-xs sm:grid-cols-[7rem_minmax(0,1fr)]">
          {check.expected !== undefined && check.expected.length > 0 ? (
            <>
              <dt className="pt-0.5 font-semibold uppercase tracking-wide text-muted-foreground">
                {t("vei.expected")}
              </dt>
              <dd className="break-all font-mono text-foreground">
                {check.expected}
              </dd>
            </>
          ) : null}
          {check.actual !== undefined && check.actual.length > 0 ? (
            <>
              <dt className="pt-0.5 font-semibold uppercase tracking-wide text-muted-foreground">
                {t("vei.actual")}
              </dt>
              <dd className="break-all font-mono text-foreground">
                {check.actual}
              </dd>
            </>
          ) : null}
          {check.note !== undefined ? (
            <>
              <dt className="pt-0.5 font-semibold uppercase tracking-wide text-muted-foreground">
                {t("vei.note")}
              </dt>
              <dd className="leading-relaxed text-foreground">
                {t(check.note)}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </li>
  );
}

/** One reconciliation row: computed value vs the file's claim + chip. */
function ReconRow({
  label,
  computed,
  claim,
  chip,
}: {
  label: string;
  computed: string;
  claim: string;
  chip: React.ReactNode;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_auto]">
      <p className="min-w-0 truncate text-sm text-foreground" title={label}>
        {label}
      </p>
      <p
        className={cn(
          "text-right font-mono text-sm",
          computed.length > 0 ? "text-muted-foreground" : "text-muted-foreground/50"
        )}
      >
        {computed.length > 0 ? computed : t("vei.missing")}
      </p>
      <p
        className={cn(
          "text-right font-mono text-sm font-semibold",
          claim.length > 0 ? "text-foreground" : "text-muted-foreground/50"
        )}
      >
        {claim.length > 0 ? claim : t("vei.missing")}
      </p>
      <p className="col-span-2 flex justify-end sm:col-span-1">{chip}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The surface                                                          */
/* ------------------------------------------------------------------ */

export function ValidateEInvoiceSurface({
  files,
  values,
  onChange,
  setFileOrder,
  setRunBlocked,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const fileMeta = files[0];
  const file = fileMeta?.file ?? null;
  const fileKey = file
    ? `${file.name}:${file.size}:${file.lastModified}`
    : "";

  const [sniffState, setSniffState] = useState<SniffState | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [done, setDone] = useState<DoneState | null>(null);
  const [openChecks, setOpenChecks] = useState<Set<string>>(new Set());
  const workerRef = useRef<Worker | null>(null);

  /* ---- run payload sync (labels = the surface's resolved t()) ---- */
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      onChange("run", JSON.stringify({
        locale,
        fileWord: t("vei.fileWord"),
        labels: Object.fromEntries(
          REPORT_KEYS.map((k) => [`vei.${k}`, t(`vei.${k}`)])
        ),
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [locale, t, onChange]);

  /* ---- the local input sniff (same pure code the worker runs) ---- */
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      let kind: InputKind = "unknown";
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        kind = sniffInput(bytes);
      } catch {
        kind = "unknown";
      }
      if (!cancelled) setSniffState({ key: fileKey, kind });
    })();
    return () => {
      cancelled = true;
    };
  }, [file, fileKey]);

  const active = sniffState !== null && sniffState.key === fileKey ? sniffState : null;
  const reading = active === null;

  /* ---- CTA gating: only the truly hopeless stop the run ---- */
  const blockedKey = !file
    ? null
    : reading
      ? "vei.loading"
      : active.kind === "unknown"
        ? "vei.ctaUnknown"
        : null;

  useEffect(() => {
    setRunBlocked(blockedKey);
    return () => setRunBlocked(null);
  }, [blockedKey, setRunBlocked]);

  /* ---- the validation run (repair-pdf's surface-driven worker) ---- */
  const validate = useCallback((): void => {
    if (!file || workerRef.current || reading) return;
    setPct(0);
    setDone(null);
    setOpenChecks(new Set());
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
            setDone({
              key: fileKey,
              name: output.name,
              blob: output.blob,
              detail: (data.detail ?? {}) as ValidateDetail,
            });
            downloadBlob(output.blob, output.name);
            const verdictWord =
              (data.detail as ValidateDetail | undefined)?.verdict === "pass"
                ? t("vei.vPass")
                : (data.detail as ValidateDetail | undefined)?.verdict ===
                    "warnings"
                  ? t("vei.vWarn")
                  : t("vei.vFail");
            toast({
              title: t("vei.doneTitle"),
              description: t("vei.doneDesc", {
                name: output.name,
                verdict: verdictWord,
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
            description: t(data.code),
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
        description: t("tool.errorGeneric"),
        variant: "destructive",
      });
      cleanup();
    });
    worker.postMessage({
      type: "run",
      runId,
      toolId: "validate-e-invoice",
      options: {
        run: String(values.run ?? ""),
      },
      files: [file],
    });
  }, [file, fileKey, reading, t, toast, values.run]);

  // Never leave a worker spinning behind a remount.
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const removeFile = useCallback((): void => {
    setFileOrder([]);
  }, [setFileOrder]);

  if (!file) return null;

  const result = done !== null && done.key === fileKey ? done : null;
  const busy = pct !== null;
  const kind = active?.kind ?? "unknown";
  const report = result?.detail.report ?? null;
  const verdict: Verdict | undefined = report?.verdict;
  const d = result?.detail ?? null;

  const nPass = report?.checks.filter((c) => c.status === "pass").length ?? 0;
  const nWarn = report?.checks.filter((c) => c.status === "warn").length ?? 0;
  const nFail = report?.checks.filter((c) => c.status === "fail").length ?? 0;

  const checkStatus = (id: string): Check["status"] | undefined =>
    report?.checks.find((c) => c.id === id)?.status;

  const toggleCheck = (id: string): void => {
    setOpenChecks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** match / mismatch / not-present chip for a recon row. */
  const reconChip = (
    status: Check["status"] | undefined,
    present: boolean
  ): React.JSX.Element => {
    if (!present) {
      return (
        <span className="rounded-full border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
          {t("vei.chipNa")}
        </span>
      );
    }
    if (status === "fail") {
      return (
        <span className="rounded-full border border-red-500/30 bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold text-red-700 dark:text-red-300">
          {t("vei.chipMismatch")}
        </span>
      );
    }
    if (status === "warn") {
      return (
        <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-800 dark:text-amber-300">
          {t("vei.chipMismatch")}
        </span>
      );
    }
    return (
      <span className="rounded-full border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
        {t("vei.chipMatch")}
      </span>
    );
  };

  const totals = report?.totals ?? null;

  return (
    <div className="flex flex-col gap-3">
      <PreviewFileHeader file={file} pageCount={0} onRemove={removeFile} />

      {/* ---- what was detected (the honest local sniff) ---- */}
      {reading ? (
        <div
          className="flex items-center gap-3 rounded-card border border-border bg-card px-4 py-6 text-sm text-muted-foreground"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("vei.loading")}
        </div>
      ) : (
        <div
          className={cn(
            "flex items-start gap-3 rounded-card border px-4 py-3",
            kind === "xml"
              ? "border-border bg-card"
              : kind === "pdf"
                ? "border-border bg-card"
                : "border-red-500/30 bg-red-500/5"
          )}
        >
          {kind === "xml" ? (
            <FileCode2
              className="mt-0.5 size-5 shrink-0 text-primary"
              aria-hidden="true"
            />
          ) : kind === "pdf" ? (
            <FileText
              className="mt-0.5 size-5 shrink-0 text-primary"
              aria-hidden="true"
            />
          ) : (
            <CircleAlert
              className="mt-0.5 size-5 shrink-0 text-red-600 dark:text-red-400"
              aria-hidden="true"
            />
          )}
          <div className="min-w-0 text-xs leading-relaxed">
            {kind === "xml" ? (
              <>
                <p className="font-semibold text-foreground">
                  {t("vei.modeXmlTitle")}
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {t("vei.modeXmlBody")}
                </p>
              </>
            ) : kind === "pdf" ? (
              <>
                <p className="font-semibold text-foreground">
                  {t("vei.modePdfTitle")}
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {t("vei.modePdfBody")}
                </p>
              </>
            ) : (
              <>
                <p className="font-semibold text-foreground">
                  {t("vei.ctaUnknown")}
                </p>
              </>
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">
              {formatBytes(file.size)}
            </p>
          </div>
        </div>
      )}

      {/* ---- honest limits ---- */}
      <div className="rounded-card border border-border bg-card p-4">
        <p className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <Info
            className="size-3.5 text-amber-500"
            aria-hidden="true"
          />
          {t("vei.limitsTitle")}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {t("vei.limitsChecked")}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {t("vei.limitsNot")}
        </p>
      </div>

      {/* ---- the run ---- */}
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          size="touch"
          className="w-full rounded-btn font-semibold"
          onClick={validate}
          disabled={busy || reading || kind === "unknown"}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <BadgeCheck className="size-4" aria-hidden="true" />
          )}
          {busy
            ? t("vei.validating", { pct: pct ?? 0 })
            : t("vei.validateBtn")}
        </Button>
        {busy ? (
          <p
            role="status"
            className="text-center text-xs text-muted-foreground"
          >
            {t("vei.validating", { pct: pct ?? 0 })}
          </p>
        ) : null}
      </div>

      {/* ---- the verdict report ---- */}
      {report !== null && result !== null && !busy ? (
        <div className="flex flex-col gap-3" aria-live="polite">
          {/* verdict banner */}
          <div
            className={cn(
              "flex items-start gap-3 rounded-card border px-4 py-4",
              verdict === "pass"
                ? "border-emerald-500/30 bg-emerald-500/10"
                : verdict === "warnings"
                  ? "border-amber-500/30 bg-amber-500/10"
                  : "border-red-500/30 bg-red-500/10"
            )}
          >
            {verdict === "pass" ? (
              <ShieldCheck
                className="mt-0.5 size-6 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
            ) : verdict === "warnings" ? (
              <TriangleAlert
                className="mt-0.5 size-6 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
            ) : (
              <ShieldAlert
                className="mt-0.5 size-6 shrink-0 text-red-600 dark:text-red-400"
                aria-hidden="true"
              />
            )}
            <div className="min-w-0">
              <p
                className={cn(
                  "text-base font-bold",
                  verdict === "pass"
                    ? "text-emerald-700 dark:text-emerald-300"
                    : verdict === "warnings"
                      ? "text-amber-800 dark:text-amber-300"
                      : "text-red-700 dark:text-red-300"
                )}
              >
                {verdict === "pass"
                  ? t("vei.verdictPassTitle")
                  : verdict === "warnings"
                    ? t("vei.verdictWarnTitle")
                    : t("vei.verdictFailTitle")}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-foreground/80">
                {verdict === "pass"
                  ? t("vei.verdictPassBody")
                  : verdict === "warnings"
                    ? t("vei.verdictWarnBody")
                    : t("vei.verdictFailBody")}
              </p>
              <p className="mt-2 text-xs font-semibold text-foreground">
                {t("vei.countsLine", { pass: nPass, warn: nWarn, fail: nFail })}
              </p>
            </div>
          </div>

          {/* source info */}
          <div className="rounded-card border border-border bg-card px-4 py-3 text-xs">
            <p className="flex items-center gap-2 font-semibold text-foreground">
              <FileText className="size-3.5 text-muted-foreground" aria-hidden="true" />
              {d?.inputMode === "pdf"
                ? t("vei.sourcePdf", { name: d.attachmentName ?? "?" })
                : t("vei.sourceXml")}
            </p>
            {d?.xmpClaim ? (
              <p className="mt-1 text-muted-foreground">
                {t("vei.xmpClaimLine", { claim: d.xmpClaim })}
              </p>
            ) : null}
          </div>

          {/* the checklist */}
          <div className="overflow-hidden rounded-card border border-border bg-card">
            <p className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
              <ListChecks className="size-3.5" aria-hidden="true" />
              {t("vei.checklistTitle")}
            </p>
            <ul className="flex flex-col divide-y divide-border/60">
              {report.checks.map((check) => (
                <CheckRow
                  key={check.id}
                  check={check}
                  open={openChecks.has(check.id)}
                  onToggle={() => toggleCheck(check.id)}
                />
              ))}
            </ul>
          </div>

          {/* totals reconciliation mini-table */}
          {totals !== null ? (
            <div className="overflow-hidden rounded-card border border-border bg-card">
              <p className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
                <ListChecks className="size-3.5" aria-hidden="true" />
                {t("vei.totalsTitle")}
              </p>
              <div className="flex flex-col divide-y divide-border/60">
                <ReconRow
                  label={t("vei.totLineSum")}
                  computed={totals.lineSum}
                  claim={totals.taxBasis}
                  chip={reconChip(checkStatus("sumLines"), totals.taxBasis.length > 0)}
                />
                <ReconRow
                  label={t("vei.totBasisPlusTax")}
                  computed={totals.taxBasisPlusTax}
                  claim={totals.grandTotal}
                  chip={reconChip(checkStatus("grand"), totals.grandTotal.length > 0)}
                />
                <ReconRow
                  label={t("vei.totGrandMinus")}
                  computed={totals.grandMinusPrepaid}
                  claim={totals.due ?? ""}
                  chip={reconChip(
                    checkStatus("due"),
                    (totals.due ?? "").length > 0
                  )}
                />
              </div>
              {totals.currency !== null ? (
                <p className="border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">
                  {t("vei.totCurrency")}:{" "}
                  <span className="font-mono font-semibold text-foreground">
                    {totals.currency}
                  </span>
                </p>
              ) : null}
            </div>
          ) : null}

          {/* report download */}
          <div className="flex flex-col items-start gap-2 rounded-card border border-border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 break-all text-xs text-muted-foreground">
              {t("vei.doneDesc", {
                name: result.name,
                verdict:
                  verdict === "pass"
                    ? t("vei.vPass")
                    : verdict === "warnings"
                      ? t("vei.vWarn")
                      : t("vei.vFail"),
              })}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 rounded-btn"
              onClick={() => downloadBlob(result.blob, result.name)}
            >
              <Download className="size-3.5" aria-hidden="true" />
              {t("vei.again")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
