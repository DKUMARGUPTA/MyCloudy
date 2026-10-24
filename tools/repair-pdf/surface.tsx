"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ClipboardCheck,
  FileDown,
  FileSearch,
  FileWarning,
  ListChecks,
  Loader2,
  ShieldCheck,
  TriangleAlert,
  Wrench,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { downloadBlob } from "@/lib/files/output";
import { formatBytes } from "@/lib/storage/recent-files";
import type { RunDetail, WorkerResponse } from "@/lib/workers/protocol";
import { cn } from "@/lib/utils";
import { PreviewFileHeader } from "../stamp-common/preview-parts";

/**
 * Repair PDF surface (RB3-c): the honest damage report + the surface-
 * driven repair run (pdf-to-excel's create-card pattern) so the FULL
 * repair report can be shown right here — the standard result phase
 * only knows "N pages"; what was actually fixed (xref rebuilt, header
 * re-anchored, stream lengths corrected, duplicates resolved,
 * truncation) lives in this panel.
 *
 * The damage scan is a LOCAL byte scan — deliberately NOT the model,
 * so the salvage engine's pdf-lib + fflate graph never loads on the
 * main thread (web-optimize surface rule). It shows: header position,
 * startxref/xref presence, %%EOF, recovered object count, duplicate
 * object numbers and the /Encrypt signature — the same signals the
 * worker's salvage acts on, so preview and run can never disagree about
 * the file's overall shape.
 *
 * On-device end to end: bytes are read with FileReader only.
 */

/** Option ids — mirrors config.ts (values flow through the shell). */
const OPT = {
  alsoRebuildValid: "alsoRebuildValid",
} as const;

/** Local damage scan (main-thread byte patterns, no model import). */
interface DamageScan {
  headerAtStart: boolean;
  /** -1 when no %PDF- appears anywhere. */
  headerOffset: number;
  startxref: boolean;
  /** startxref present AND pointing at a real "xref" table. */
  xrefPresent: boolean;
  eof: boolean;
  objects: number;
  duplicateObjNums: number;
  encrypted: boolean;
}

interface ScanState {
  key: string;
  scan: DamageScan;
}

/** The worker's repair report (protocol RunDetail repair fields). */
interface DoneState {
  key: string;
  name: string;
  blob: Blob;
  detail: RunDetail;
}

/* iOS-safe: no lookbehind (house rule), digit-tail guarded. */
const OBJ_RE = /([0-9]{1,9})[ \t\r\n\f\x00]+([0-9]{1,3})[ \t\r\n\f\x00]+obj(?=[ \t\r\n\f\x00])/g;

/** Byte-faithful latin1 (windows-1252 would corrupt 0x80–0x9F). */
function toLatin(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(
      null,
      Array.prototype.slice.call(bytes.subarray(i, i + CHUNK)) as number[]
    );
  }
  return out;
}

/** The light damage scan the report renders before any run. */
function scanDamage(bytes: Uint8Array): DamageScan {
  const s = toLatin(bytes);

  const headerOffset = s.indexOf("%PDF-");
  const startxrefIdx = s.lastIndexOf("startxref");
  let xrefPresent = false;
  if (startxrefIdx >= 0) {
    const numAt = startxrefIdx + 9;
    const num = /^[0-9]{1,10}/.exec(s.slice(numAt, numAt + 12));
    if (num) {
      const off = Number.parseInt(num[0], 10);
      xrefPresent =
        s.startsWith("xref", off) ||
        /^([0-9]{1,9})[ \t\r\n\f\x00]+([0-9]{1,3})[ \t\r\n\f\x00]+obj/.test(
          s.slice(off, off + 40)
        );
    }
  }

  const seen = new Set<number>();
  const dup = new Set<number>();
  let objects = 0;
  OBJ_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OBJ_RE.exec(s)) !== null) {
    const prev = m.index > 0 ? s[m.index - 1] : "";
    if (prev >= "0" && prev <= "9") continue;
    objects += 1;
    const num = Number.parseInt(m[1], 10);
    if (seen.has(num)) dup.add(num);
    else seen.add(num);
  }

  const eofIdx = s.lastIndexOf("%%EOF");
  return {
    headerAtStart: headerOffset === 0,
    headerOffset,
    startxref: startxrefIdx >= 0,
    xrefPresent,
    eof: eofIdx >= 0 && eofIdx >= s.length - 64,
    objects,
    duplicateObjNums: dup.size,
    encrypted:
      /\/Encrypt[ \t\r\n\f\x00]+[0-9]{1,9}[ \t\r\n\f\x00]+[0-9]{1,3}[ \t\r\n\f\x00]+R/.test(
        s
      ) || /\/Filter[ \t\r\n\f\x00]*\/Standard(?![a-zA-Z])/.test(s),
  };
}

/** One report row (label / value / trailing chip) — web-optimize style. */
function ReportRow({
  label,
  value,
  chip,
  dimmed,
}: {
  label: string;
  value: React.ReactNode;
  chip?: React.ReactNode;
  dimmed?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "grid grid-cols-[7rem_minmax(0,1fr)_auto] items-start gap-3 px-4 py-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)_auto]",
        dimmed && "opacity-60"
      )}
    >
      <dt className="pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-sm text-foreground">{value}</dd>
      <dd className="pt-0.5">{chip}</dd>
    </div>
  );
}

/** OK / Damage chip pair. */
function StateChip({
  ok,
  okText,
  badText,
}: {
  ok: boolean;
  okText: string;
  badText: string;
}): React.JSX.Element {
  return ok ? (
    <span className="rounded-full border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
      {okText}
    </span>
  ) : (
    <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-300">
      {badText}
    </span>
  );
}

/** One "what was fixed" row with its honest check / dash state. */
function FixRow({
  label,
  done,
  note,
}: {
  label: string;
  done: boolean;
  note?: string;
}): React.JSX.Element {
  return (
    <li
      className={cn(
        "flex items-start gap-2.5 px-4 py-2.5",
        !done && "opacity-60"
      )}
    >
      {done ? (
        <span
          className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        >
          <svg viewBox="0 0 12 12" className="size-3" fill="none">
            <path
              d="M2.5 6.5 5 9l4.5-6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      ) : (
        <span
          className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border text-[9px] font-bold text-muted-foreground"
          aria-hidden="true"
        >
          —
        </span>
      )}
      <span className="min-w-0 text-sm leading-relaxed text-foreground">
        {label}
        {note ? (
          <span className="ml-1.5 text-xs text-muted-foreground">{note}</span>
        ) : null}
      </span>
    </li>
  );
}

export function RepairSurface({
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

  const alsoRebuild = values[OPT.alsoRebuildValid] !== false;

  const [scanState, setScanState] = useState<ScanState | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [done, setDone] = useState<DoneState | null>(null);
  const workerRef = useRef<Worker | null>(null);

  /* ---- run payload sync (the worker reads options.run) ---- */
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      onChange("run", JSON.stringify({
        alsoRebuildValid: alsoRebuild,
        locale,
        fileWord: t("rep.fileWord"),
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [alsoRebuild, locale, t, onChange]);

  /* ---- the damage scan (local byte patterns, no pdf.js) ---- */
  /* Stale scans are masked at render time: `active` below only matches
     the scan keyed to the CURRENT fileKey, so removing the file needs
     no synchronous state clear here. */
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (cancelled) return;
        setScanState({ key: fileKey, scan: scanDamage(bytes) });
      } catch {
        if (!cancelled)
          setScanState({
            key: fileKey,
            scan: {
              headerAtStart: false,
              headerOffset: -1,
              startxref: false,
              xrefPresent: false,
              eof: false,
              objects: 0,
              duplicateObjNums: 0,
              encrypted: false,
            },
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, fileKey]);

  const active = scanState !== null && scanState.key === fileKey ? scanState : null;
  const reading = active === null;

  /* ---- CTA gating: honest hopelessness only. A damaged file is the
   * REASON to run, never a block; only "nothing to salvage" and
   * "password-protected" stop the run with their reason in the CTA. ---- */
  const blockedKey = !file
    ? null
    : reading
      ? "rep.ctaScanning"
      : active.scan.encrypted
        ? "rep.ctaEncrypted"
        : active.scan.objects === 0
          ? "rep.ctaNoObjects"
          : null;

  useEffect(() => {
    setRunBlocked(blockedKey);
    return () => setRunBlocked(null);
  }, [blockedKey, setRunBlocked]);

  /* ---- the repair run (pdf-to-excel's surface-driven worker) ---- */
  const repair = useCallback((): void => {
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
              name: output.name,
              blob: output.blob,
              detail: data.detail ?? {},
            });
            downloadBlob(output.blob, output.name);
            toast({
              title: t("rep.doneTitle"),
              description: t("rep.doneDesc", {
                name: output.name,
                pages: data.detail?.pages ?? 0,
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
      toolId: "repair-pdf",
      options: {
        run: JSON.stringify({
          alsoRebuildValid: alsoRebuild,
          locale,
          fileWord: t("rep.fileWord"),
        }),
      },
      files: [file],
    });
  }, [alsoRebuild, file, fileKey, locale, reading, t, toast]);

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

  const report = done !== null && done.key === fileKey ? done : null;
  const busy = pct !== null;
  const hopeless = active !== null && (active.scan.encrypted || active.scan.objects === 0);
  const d = active?.scan ?? null;
  const r = report?.detail ?? null;

  return (
    <div className="flex flex-col gap-3">
      <PreviewFileHeader file={file} pageCount={0} onRemove={removeFile} />

      {reading ? (
        <div
          className="flex items-center gap-3 rounded-card border border-border bg-card px-4 py-8 text-sm text-muted-foreground"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("rep.loading")}
        </div>
      ) : d !== null ? (
        <>
          {/* ---- the damage report (before) ---- */}
          <div className="overflow-hidden rounded-card border border-border bg-card">
            <p className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
              <FileSearch className="size-3.5" aria-hidden="true" />
              {t("rep.reportTitle")}
            </p>
            <dl className="flex flex-col divide-y divide-border/60">
              <ReportRow
                label={t("rep.statSize")}
                value={
                  <span className="font-semibold">{formatBytes(file.size)}</span>
                }
              />
              <ReportRow
                label={t("rep.statObjects")}
                value={t("rep.valObjects", { count: d.objects })}
              />
              <ReportRow
                label={t("rep.statHeader")}
                value={
                  d.headerOffset < 0
                    ? t("rep.valHeaderMissing")
                    : d.headerAtStart
                      ? t("rep.valHeaderOk")
                      : t("rep.valHeaderAt", { offset: d.headerOffset })
                }
                chip={
                  <StateChip
                    ok={d.headerAtStart}
                    okText={t("rep.chipOk")}
                    badText={d.headerOffset < 0 ? t("rep.chipMissing") : t("rep.chipOff")}
                  />
                }
              />
              <ReportRow
                label={t("rep.statXref")}
                value={
                  d.xrefPresent
                    ? t("rep.valXrefOk")
                    : d.startxref
                      ? t("rep.valXrefBad")
                      : t("rep.valXrefMissing")
                }
                chip={
                  <StateChip
                    ok={d.xrefPresent}
                    okText={t("rep.chipOk")}
                    badText={t("rep.chipWillRebuild")}
                  />
                }
              />
              <ReportRow
                label={t("rep.statEof")}
                value={d.eof ? t("rep.valEofOk") : t("rep.valEofMissing")}
                chip={
                  <StateChip
                    ok={d.eof}
                    okText={t("rep.chipOk")}
                    badText={t("rep.chipWillRebuild")}
                  />
                }
              />
              <ReportRow
                dimmed={d.duplicateObjNums === 0}
                label={t("rep.statDups")}
                value={
                  d.duplicateObjNums > 0
                    ? t("rep.valDups", { count: d.duplicateObjNums })
                    : t("rep.valNoDups")
                }
              />
            </dl>
          </div>

          {/* ---- encrypted / nothing-to-salvage: honest stoppers ---- */}
          {d.encrypted ? (
            <div
              className="flex items-start gap-3 rounded-card border border-amber-500/30 bg-amber-500/10 px-4 py-3"
              role="alert"
            >
              <FileWarning
                className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
              <div className="min-w-0 text-xs leading-relaxed">
                <p className="font-semibold text-foreground">
                  {t("rep.encTitle")}
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {t("rep.encBody")}
                </p>
              </div>
            </div>
          ) : null}
          {d.objects === 0 ? (
            <div
              className="flex items-start gap-3 rounded-card border border-amber-500/30 bg-amber-500/10 px-4 py-3"
              role="alert"
            >
              <FileWarning
                className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
              <div className="min-w-0 text-xs leading-relaxed">
                <p className="font-semibold text-foreground">
                  {t("rep.noObjectsTitle")}
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {t("rep.noObjectsBody")}
                </p>
              </div>
            </div>
          ) : null}

          {/* ---- what the run will do ---- */}
          {!hopeless ? (
            <div className="overflow-hidden rounded-card border border-border bg-card">
              <p className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
                <ListChecks className="size-3.5" aria-hidden="true" />
                {t("rep.planTitle")}
              </p>
              <ul className="flex flex-col divide-y divide-border/60 text-sm leading-relaxed text-foreground">
                <li className="flex items-start gap-3 px-4 py-2.5">
                  <Wrench
                    className="mt-0.5 size-4 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  {t("rep.planScan")}
                </li>
                <li className="flex items-start gap-3 px-4 py-2.5">
                  <Wrench
                    className="mt-0.5 size-4 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  {t("rep.planRebuild")}
                </li>
                <li
                  className={cn(
                    "flex items-start gap-3 px-4 py-2.5",
                    !alsoRebuild && "opacity-60"
                  )}
                >
                  <Wrench
                    className="mt-0.5 size-4 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  {alsoRebuild
                    ? t("rep.planRebuildValidOn")
                    : t("rep.planRebuildValidOff")}
                </li>
                <li className="flex items-start gap-3 px-4 py-2.5">
                  <ShieldCheck
                    className="mt-0.5 size-4 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  {t("rep.planVerify")}
                </li>
              </ul>
            </div>
          ) : null}

          {/* ---- honest limits ---- */}
          <div className="rounded-card border border-border bg-card p-4">
            <p className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <TriangleAlert
                className="size-3.5 text-amber-500"
                aria-hidden="true"
              />
              {t("rep.limitsTitle")}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t("rep.limitsBody")}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t("rep.limitsTruncated")}
            </p>
          </div>

          {/* ---- repair run + progress ---- */}
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              size="touch"
              className="w-full rounded-btn font-semibold"
              onClick={repair}
              disabled={busy || reading || hopeless}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Wrench className="size-4" aria-hidden="true" />
              )}
              {busy
                ? t("rep.repairing", { pct: pct ?? 0 })
                : t("rep.repairBtn")}
            </Button>
            {busy ? (
              <p
                role="status"
                className="text-center text-xs text-muted-foreground"
              >
                {t("rep.repairing", { pct: pct ?? 0 })}
              </p>
            ) : null}
          </div>

          {/* ---- the repair report (after) ---- */}
          {r !== null && !busy ? (
            <div
              className="overflow-hidden rounded-card border border-border bg-card"
              aria-live="polite"
            >
              <p className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
                <ClipboardCheck
                  className="size-3.5 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
                {t("rep.resultTitle")}
              </p>
              <dl className="flex flex-col divide-y divide-border/60">
                <ReportRow
                  label={t("rep.resPages")}
                  value={
                    <span className="font-semibold">
                      {t("rep.resPagesValue", {
                        count: r.pages ?? 0,
                      })}
                    </span>
                  }
                />
                <ReportRow
                  label={t("rep.resObjects")}
                  value={t("rep.resObjectsValue", {
                    count: r.objectsRecovered ?? 0,
                  })}
                />
                <ReportRow
                  label={t("rep.resBytes")}
                  value={t("rep.resBytesValue", {
                    before: formatBytes(r.beforeBytes ?? 0),
                    after: formatBytes(r.afterBytes ?? 0),
                  })}
                />
              </dl>
              <ul className="flex flex-col divide-y divide-border/60 border-t border-border/60">
                <FixRow
                  done={r.xrefRebuilt === true}
                  label={t("rep.fixXref")}
                />
                <FixRow
                  done={r.xrefStreamSalvaged === true}
                  label={t("rep.fixXrefStream")}
                  note={
                    r.xrefStreamSalvaged === true
                      ? t("rep.fixCount", { count: r.xrefStreamEntries ?? 0 })
                      : undefined
                  }
                />
                <FixRow
                  done={r.headerFixed === true}
                  label={t("rep.fixHeader")}
                />
                <FixRow
                  done={r.eofMissing === true}
                  label={t("rep.fixEof")}
                />
                <FixRow
                  done={(r.streamLengthsFixed ?? 0) > 0}
                  label={t("rep.fixLengths")}
                  note={
                    (r.streamLengthsFixed ?? 0) > 0
                      ? t("rep.fixCount", { count: r.streamLengthsFixed ?? 0 })
                      : undefined
                  }
                />
                <FixRow
                  done={(r.duplicatesResolved ?? 0) > 0}
                  label={t("rep.fixDups")}
                  note={
                    (r.duplicatesResolved ?? 0) > 0
                      ? t("rep.fixCount", { count: r.duplicatesResolved ?? 0 })
                      : undefined
                  }
                />
              </ul>
              {r.truncationDetected === true ? (
                <div className="flex items-start gap-2.5 border-t border-border/60 bg-amber-500/5 px-4 py-3">
                  <TriangleAlert
                    className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                    aria-hidden="true"
                  />
                  <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
                    {t("rep.resTruncated")}
                  </p>
                </div>
              ) : null}
              {r.structureWasValid === true ? (
                <p className="border-t border-border/60 px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                  {r.unchanged === true
                    ? t("rep.resUnchanged")
                    : t("rep.resValidRebuilt")}
                </p>
              ) : null}
              {report !== null ? (
                <div className="flex flex-col items-start gap-2 border-t border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="min-w-0 break-all text-xs text-muted-foreground">
                    {t("rep.doneDesc", {
                      name: report.name,
                      pages: r.pages ?? 0,
                    })}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 rounded-btn"
                    onClick={() => downloadBlob(report.blob, report.name)}
                  >
                    <FileDown className="size-3.5" aria-hidden="true" />
                    {t("rep.again")}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
