"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  CircleAlert,
  Download,
  FileText,
  FileCheck2,
  Info,
  ListChecks,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  Type,
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
import type {
  CheckGroup,
  DeclaredLevel,
  PdfaCheck,
  ValidatePdfaDetail,
} from "./types";

/**
 * Validate PDF/A surface (RB7-b) — the verify-pdf-signatures pattern:
 * a LOCAL %PDF- magic sniff (deliberately NOT the model — the
 * repair-pdf surface rule, so the fflate graph never loads on the main
 * thread), a level picker (Auto / 1b / 2b / 3b), then a surface-driven
 * worker run that produces the full conformance report: a verdict
 * banner, the auto-detect honesty lines, grouped check cards
 * (pass/warning/fail/not-required) with page references, the unembedded
 * fonts list, the advisory PDF/UA hints group and the .txt report
 * download. The whole walk + check pipeline happens in the Web Worker.
 */

/** Report label keys — every string the worker's .txt builder needs. */
const REPORT_KEYS = [
  "title", "file", "docLine", "pages", "level", "declared", "detected",
  "assumed", "xref", "recovery",
  "rSummary", "rVerdict", "rPassed", "rWarnings", "rFailed",
  "rPages", "rFonts", "rUnembedded",
  "vPass", "vWarn", "vFail", "cPass", "cWarn", "cFail", "cSkip",
  "gIdentify", "gFonts", "gColor", "gForbidden", "gStructure", "gMeta", "gUa",
  "kXmp", "kTitle", "kFonts", "kCmyk", "kTransparency", "kPsfunc",
  "kEncrypt", "kJs", "kLaunch", "kOpenaction", "kEmbfiles", "kMultimedia",
  "kOi", "kStructInfo", "kMirror", "kUaMarked", "kUaLang", "kUaAlt",
  "nXmpNone", "nXmpNoPart", "nXmpMismatch", "nXmpConfMismatch", "nXmpOk",
  "nTitleSkip", "nTitleOk", "nTitleWarn",
  "nFontsNone", "nFontsOk", "nFontsStd14", "nFontsFail",
  "nCmykOk", "nCmykOps", "nCmykRes",
  "nTransOk1b", "nTransFail1b", "nTransOk2b", "nTransOkNone", "nPsOk", "nPsFail",
  "nEncOk", "nEncFail", "nJsOk", "nJsFail", "nLaunchOk", "nLaunchFail",
  "nOaOk", "nOaNone", "nOaFail",
  "nEmbOk12", "nEmbFail12", "nEmbOk3", "nMmOk", "nMmFail", "nOiOk", "nOiWarn",
  "nStructAOk", "nStructAFail", "nStructSkip",
  "nMirrorNoInfo", "nMirrorSkip", "nMirrorOk", "nMirrorWarn",
  "nUaMarkedOk", "nUaMarkedFail", "nUaLangOk", "nUaLangWarn",
  "nUaAltOk", "nUaAltWarn", "nUaAltFail",
  "generatedBy", "honestyTitle", "honestyBody",
] as const;

const GROUPS: CheckGroup[] = [
  "identify",
  "fonts",
  "color",
  "forbidden",
  "structure",
  "meta",
  "ua",
];

const GROUP_TITLES: Record<CheckGroup, string> = {
  identify: "vpa.gIdentify",
  fonts: "vpa.gFonts",
  color: "vpa.gColor",
  forbidden: "vpa.gForbidden",
  structure: "vpa.gStructure",
  meta: "vpa.gMeta",
  ua: "vpa.gUa",
};

const LEVELS: { value: DeclaredLevel; key: string }[] = [
  { value: "auto", key: "vpa.levelAuto" },
  { value: "1b", key: "vpa.level1b" },
  { value: "2b", key: "vpa.level2b" },
  { value: "3b", key: "vpa.level3b" },
];

interface SniffState {
  key: string;
  isPdf: boolean;
}

interface DoneState {
  key: string;
  level: DeclaredLevel;
  name: string;
  blob: Blob;
  detail: ValidatePdfaDetail;
}

/* ------------------------------------------------------------------ */
/* Local magic-byte sniff (no model import — fflate stays worker-only)  */
/* ------------------------------------------------------------------ */

/** %PDF- anywhere in the first 2 KB (a garbage prefix still smells). */
function localPdfSniff(head: Uint8Array): boolean {
  for (let i = 0; i + 4 < head.length; i += 1) {
    if (
      head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 &&
      head[i + 3] === 0x46 && head[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Small presentational pieces                                          */
/* ------------------------------------------------------------------ */

function toneChipClasses(status: "pass" | "warn" | "fail" | "skip"): string {
  if (status === "pass") {
    return "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "warn") {
    return "border-amber-500/30 bg-amber-500/15 text-amber-800 dark:text-amber-300";
  }
  if (status === "fail") {
    return "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300";
  }
  return "border-border bg-muted/60 text-muted-foreground";
}

const STATUS_WORD_KEY: Record<"pass" | "warn" | "fail" | "skip", string> = {
  pass: "vpa.cPass",
  warn: "vpa.cWarn",
  fail: "vpa.cFail",
  skip: "vpa.cSkip",
};

function StatusChip({
  status,
  label,
}: {
  status: "pass" | "warn" | "fail" | "skip";
  label: string;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
        toneChipClasses(status)
      )}
    >
      {label}
    </span>
  );
}

/** One check card: label + chip + note + technical detail + page refs. */
function CheckCard({
  check,
  t,
}: {
  check: PdfaCheck;
  t: (key: string) => string;
}): React.JSX.Element {
  const status = check.status;
  return (
    <div
      className={cn(
        "overflow-hidden rounded-card border bg-card",
        status === "pass"
          ? "border-emerald-500/25"
          : status === "warn"
            ? "border-amber-500/30"
            : status === "fail"
              ? "border-red-500/30"
              : "border-border"
      )}
    >
      <div
        className={cn(
          "flex items-start gap-3 px-4 py-3",
          status === "pass"
            ? "bg-emerald-500/5"
            : status === "warn"
              ? "bg-amber-500/5"
              : status === "fail"
                ? "bg-red-500/5"
                : "bg-muted/30"
        )}
      >
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-btn",
            status === "pass"
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : status === "warn"
                ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                : status === "fail"
                  ? "bg-red-500/15 text-red-600 dark:text-red-400"
                  : "bg-muted text-muted-foreground"
          )}
        >
          {status === "pass" ? (
            <ShieldCheck className="size-4" aria-hidden="true" />
          ) : status === "warn" ? (
            <TriangleAlert className="size-4" aria-hidden="true" />
          ) : status === "fail" ? (
            <ShieldAlert className="size-4" aria-hidden="true" />
          ) : (
            <Info className="size-4" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="min-w-0 text-sm font-semibold text-foreground">
              {t(check.label)}
            </p>
            {check.advisory === true ? (
              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                {t("vpa.advisoryChip")}
              </span>
            ) : null}
            <span className="ml-auto">
              <StatusChip status={status} label={t(STATUS_WORD_KEY[status])} />
            </span>
          </div>
          {check.note !== undefined ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t(check.note)}
            </p>
          ) : null}
          {check.detail !== undefined && check.detail.length > 0 ? (
            <p className="mt-1.5 break-all font-mono text-[10px] leading-relaxed text-muted-foreground/80">
              {check.detail}
            </p>
          ) : null}
          {check.pages.length > 0 ? (
            <p className="mt-1 text-[11px] font-medium text-muted-foreground">
              {t("vpa.pagesWord")}: {check.pages.join(", ")}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The surface                                                          */
/* ------------------------------------------------------------------ */

export function ValidatePdfaSurface({
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
  const fileKey = file ? `${file.name}:${file.size}:${file.lastModified}` : "";

  const [level, setLevel] = useState<DeclaredLevel>("auto");
  const [sniffState, setSniffState] = useState<SniffState | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [done, setDone] = useState<DoneState | null>(null);
  const workerRef = useRef<Worker | null>(null);

  /* ---- run payload sync (labels = the surface's resolved t()) ---- */
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      onChange("run", JSON.stringify({
        locale,
        level,
        fileWord: t("vpa.fileWord"),
        labels: Object.fromEntries(
          REPORT_KEYS.map((k) => [`vpa.${k}`, t(`vpa.${k}`)])
        ),
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [locale, level, t, onChange]);

  /* ---- the local input sniff (tiny byte scan — never the model) ---- */
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      let isPdf = false;
      try {
        const buf = await file.slice(0, 2048).arrayBuffer();
        isPdf = localPdfSniff(new Uint8Array(buf));
      } catch {
        isPdf = false;
      }
      if (!cancelled) setSniffState({ key: fileKey, isPdf });
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
      ? "vpa.loading"
      : active.isPdf
        ? null
        : "vpa.ctaUnknown";

  useEffect(() => {
    setRunBlocked(blockedKey);
    return () => setRunBlocked(null);
  }, [blockedKey, setRunBlocked]);

  /* ---- the validation run (verify-pdf-signatures' worker drive) ---- */
  const runCheck = useCallback((): void => {
    if (!file || workerRef.current || reading) return;
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
            setDone({
              key: fileKey,
              level,
              name: output.name,
              blob: output.blob,
              detail: (data.detail ?? {}) as ValidatePdfaDetail,
            });
            downloadBlob(output.blob, output.name);
            const d = data.detail as ValidatePdfaDetail | undefined;
            const verdictWord =
              d?.verdict === "pass"
                ? t("vpa.vPass")
                : d?.verdict === "warnings"
                  ? t("vpa.vWarn")
                  : t("vpa.vFail");
            toast({
              title: t("vpa.doneTitle"),
              description: t("vpa.doneDesc", {
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
      toolId: "validate-pdfa",
      options: {
        run: String(values.run ?? ""),
      },
      files: [file],
    });
  }, [file, fileKey, level, reading, t, toast, values.run]);

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

  /* ---- the report (only for the same file AND level) ---- */
  const result = done !== null && done.key === fileKey && done.level === level ? done : null;
  const report = result?.detail.report ?? null;

  const nPass = report?.checks.filter((c) => c.status === "pass").length ?? 0;
  const nWarn = report?.checks.filter((c) => c.status === "warn").length ?? 0;
  const nFail = report?.checks.filter((c) => c.status === "fail").length ?? 0;

  const grouped = useMemo(() => {
    const map = new Map<CheckGroup, PdfaCheck[]>();
    for (const g of GROUPS) map.set(g, []);
    for (const c of report?.checks ?? []) {
      const list = map.get(c.group);
      if (list !== undefined) list.push(c);
    }
    return map;
  }, [report]);

  const unembedded = useMemo(
    () => (report?.fonts ?? []).filter((f) => !f.embedded),
    [report]
  );

  if (!file) return null;

  const busy = pct !== null;
  const isPdf = active?.isPdf ?? false;
  const mismatch =
    report !== null &&
    report.detectedLevel !== null &&
    report.detectedLevel !== report.effectiveLevel;

  return (
    <div className="flex flex-col gap-3">
      <PreviewFileHeader
        file={file}
        pageCount={report?.pageCount ?? 0}
        onRemove={removeFile}
      />

      {/* ---- what was detected (the honest local sniff) ---- */}
      {reading ? (
        <div
          className="flex items-center gap-3 rounded-card border border-border bg-card px-4 py-6 text-sm text-muted-foreground"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("vpa.loading")}
        </div>
      ) : (
        <div
          className={cn(
            "flex items-start gap-3 rounded-card border px-4 py-3",
            isPdf ? "border-border bg-card" : "border-red-500/30 bg-red-500/5"
          )}
        >
          {isPdf ? (
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
            {isPdf ? (
              <>
                <p className="font-semibold text-foreground">
                  {t("vpa.modePdfTitle")}
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {t("vpa.modePdfBody")}
                </p>
              </>
            ) : (
              <>
                <p className="font-semibold text-foreground">
                  {t("vpa.ctaUnknown")}
                </p>
              </>
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">
              {formatBytes(file?.size ?? 0)}
            </p>
          </div>
        </div>
      )}

      {/* ---- the level picker ---- */}
      <div className="rounded-card border border-border bg-card p-4">
        <p className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <FileCheck2 className="size-3.5 text-primary" aria-hidden="true" />
          {t("vpa.levelLabel")}
        </p>
        <div
          className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4"
          role="radiogroup"
          aria-label={t("vpa.levelLabel")}
        >
          {LEVELS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={level === opt.value}
              disabled={busy}
              onClick={() => setLevel(opt.value)}
              className={cn(
                "min-h-11 rounded-btn border px-3 py-2 text-xs font-semibold transition-colors",
                level === opt.value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:bg-muted/50"
              )}
            >
              {t(opt.key)}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {t("vpa.levelHint")}
        </p>
      </div>

      {/* ---- honest limits ---- */}
      <div className="rounded-card border border-border bg-card p-4">
        <p className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <Info
            className="size-3.5 text-amber-500"
            aria-hidden="true"
          />
          {t("vpa.limitsTitle")}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {t("vpa.limitsBody")}
        </p>
      </div>

      {/* ---- the run ---- */}
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          size="touch"
          className="w-full rounded-btn font-semibold"
          onClick={runCheck}
          disabled={busy || reading || !isPdf}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <BadgeCheck className="size-4" aria-hidden="true" />
          )}
          {busy
            ? t("vpa.running", { pct: pct ?? 0 })
            : t("vpa.runBtn")}
        </Button>
        {busy ? (
          <p
            role="status"
            className="text-center text-xs text-muted-foreground"
          >
            {t("vpa.running", { pct: pct ?? 0 })}
          </p>
        ) : null}
      </div>

      {/* ---- the conformance report ---- */}
      {report !== null && result !== null && !busy ? (
        <div className="flex flex-col gap-3" aria-live="polite">
          {/* verdict banner */}
          <div
            className={cn(
              "flex items-start gap-3 rounded-card border px-4 py-4",
              report.verdict === "pass"
                ? "border-emerald-500/30 bg-emerald-500/10"
                : report.verdict === "warnings"
                  ? "border-amber-500/30 bg-amber-500/10"
                  : "border-red-500/30 bg-red-500/10"
            )}
          >
            {report.verdict === "pass" ? (
              <ShieldCheck
                className="mt-0.5 size-6 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
            ) : report.verdict === "warnings" ? (
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
                  report.verdict === "pass"
                    ? "text-emerald-700 dark:text-emerald-300"
                    : report.verdict === "warnings"
                      ? "text-amber-800 dark:text-amber-300"
                      : "text-red-700 dark:text-red-300"
                )}
              >
                {report.verdict === "pass"
                  ? t("vpa.tonePassTitle")
                  : report.verdict === "warnings"
                    ? t("vpa.toneWarnTitle")
                    : t("vpa.toneFailTitle")}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-foreground/80">
                {report.verdict === "pass"
                  ? t("vpa.tonePassBody")
                  : report.verdict === "warnings"
                    ? t("vpa.toneWarnBody")
                    : t("vpa.toneFailBody")}
              </p>
              <p className="mt-2 text-xs font-semibold text-foreground">
                {t("vpa.countsLine", {
                  pass: nPass,
                  warn: nWarn,
                  fail: nFail,
                })}
              </p>
            </div>
          </div>

          {/* the level honesty lines */}
          <div className="rounded-card border border-border bg-card px-4 py-3 text-xs leading-relaxed">
            <p className="font-semibold text-foreground">
              {t("vpa.levelLabel")}: PDF/A-{report.effectiveLevel.toUpperCase()}
              {report.pageCount !== null && report.pageCount > 0
                ? ` · ${report.pageCount} ${t("vpa.pages")}`
                : ""}
            </p>
            {report.declaredLevel === "auto" ? (
              report.detectedLevel !== null ? (
                <p className="mt-1 text-muted-foreground">
                  {t("vpa.detectedLine", {
                    level: `PDF/A-${report.detectedLevel.toUpperCase()}`,
                  })}
                </p>
              ) : (
                <p className="mt-1 text-muted-foreground">
                  {t("vpa.assumedLine", { level: report.effectiveLevel.toUpperCase() })}
                </p>
              )
            ) : mismatch ? (
              <p className="mt-1 font-medium text-amber-700 dark:text-amber-300">
                {t("vpa.mismatchLine", {
                  claim: report.xmpClaim ?? "?",
                  level: `PDF/A-${report.effectiveLevel.toUpperCase()}`,
                })}
              </p>
            ) : null}
            {report.recoveryUsed ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("vpa.recoveryLine")}
                {report.recoveryReason !== null
                  ? ` (${report.recoveryReason})`
                  : ""}
              </p>
            ) : null}
          </div>

          {/* the grouped check cards */}
          <p className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <ListChecks className="size-3.5" aria-hidden="true" />
            {t("vpa.rSummary")}: {report.checks.length}
          </p>
          {GROUPS.map((g) => {
            const rows = grouped.get(g) ?? [];
            if (rows.length === 0) return null;
            return (
              <section key={g} className="flex flex-col gap-2">
                <h3 className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-foreground/80">
                  {g === "fonts" ? (
                    <Type className="size-3.5 text-primary" aria-hidden="true" />
                  ) : (
                    <FileText className="size-3.5 text-primary" aria-hidden="true" />
                  )}
                  {t(GROUP_TITLES[g])}
                  <span className="text-[10px] font-normal text-muted-foreground">
                    ({rows.length})
                  </span>
                </h3>
                <div className="flex flex-col gap-2">
                  {rows.map((c) => (
                    <CheckCard key={c.id} check={c} t={t} />
                  ))}
                </div>
                {g === "ua" ? (
                  <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
                    <Info
                      className="mr-1 inline size-3 text-amber-500"
                      aria-hidden="true"
                    />
                    {t("vpa.uaHonesty")}
                  </p>
                ) : null}
              </section>
            );
          })}

          {/* the fonts table */}
          {report.fonts.length > 0 ? (
            <div className="overflow-hidden rounded-card border border-border bg-card">
              <p className="border-b border-border/60 bg-muted/30 px-4 py-2 text-xs font-semibold text-foreground">
                {t("vpa.fontsTitle")} ({report.fonts.length})
              </p>
              <div className="max-h-64 overflow-y-auto p-2">
                <ul className="flex flex-col gap-1">
                  {report.fonts.map((f) => (
                    <li
                      key={`${f.name}#${f.subtype}`}
                      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-btn px-2 py-1.5 text-xs"
                    >
                      <span className="min-w-0 break-all font-mono font-semibold text-foreground">
                        {f.name}
                      </span>
                      <span className="text-muted-foreground">({f.subtype})</span>
                      <span className="text-muted-foreground">
                        · {t("vpa.pagesWord")}: {f.pages.join(", ") || "?"}
                      </span>
                      <span
                        className={cn(
                          "ml-auto shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase",
                          f.embedded
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                            : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
                        )}
                      >
                        {f.embedded ? t("vpa.fEmbedded") : t("vpa.fNotEmbedded")}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              {unembedded.length > 0 ? (
                <p className="border-t border-border/60 px-4 py-2 text-[11px] font-medium text-red-700 dark:text-red-300">
                  {t("vpa.rUnembedded")}: {unembedded.length}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* report download */}
          <div className="flex flex-col items-start gap-2 rounded-card border border-border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 break-all text-xs text-muted-foreground">
              {t("vpa.doneDesc", {
                name: result.name,
                verdict:
                  report.verdict === "pass"
                    ? t("vpa.vPass")
                    : report.verdict === "warnings"
                      ? t("vpa.vWarn")
                      : t("vpa.vFail"),
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
              {t("vpa.again")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
