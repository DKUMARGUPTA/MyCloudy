"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BadgeCheck,
  CircleAlert,
  Clock,
  Download,
  FileSignature,
  FileText,
  Fingerprint,
  Hash,
  Info,
  ListChecks,
  Loader2,
  MapPin,
  PenLine,
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
import type {
  SignatureCard,
  VerifyDetail,
} from "./types";

/**
 * Verify PDF signatures surface (RB6) — the validate-e-invoice pattern:
 * a LOCAL %PDF- magic sniff (deliberately NOT the model — the repair-pdf
 * surface rule, so the fflate graph never loads on the main thread) tells
 * the user what was detected, then a surface-driven worker run produces
 * the full verification report: a summary banner (green/amber/red), one
 * verdict card per signature (signer, certificate, crypto, integrity,
 * modified-after-signing), the unsigned-field note and the .txt report
 * download. The whole analysis — raw PDF walk, DER/CMS parse, digest,
 * crypto — happens in the Web Worker; the surface only renders the
 * structured report it posts back.
 */

/** Report label keys — every string the worker's .txt builder needs. */
const REPORT_KEYS = [
  "title", "file", "docLine", "pages", "rFields", "xref", "recovery",
  "rSummary", "rSignature", "rUnsigned", "rField", "rPage", "rPageUnknown",
  "rVerdict", "rSigner", "rOrg", "rSerial", "rIssuer", "rValidity",
  "rSignTime", "rMTime", "rReason", "rLocation", "rFormat", "rDigest",
  "rCrypto", "rIntegrity", "rModified", "rTrailing", "rNotes",
  "vValid", "vAttention", "vInvalid", "vNone",
  "cPass", "cFail", "cNotVerified",
  "iIntact", "iTampered", "iUnknown", "iOk", "iBad", "iUnk",
  "yYes", "yNo",
  "wValidNow", "wExpired", "wNotYet", "wSelfSigned", "wUnsigned",
  "cValid", "cAttention", "cInvalid", "cSigned", "cUnsigned",
  "empty",
  "nByteRangeBad", "nRangeBounds", "nContentsBad", "nCmsBad", "nNoSigner",
  "nNoSidCert", "nUnsupportedDigest", "nModified", "nSelfSigned",
  "nExpired", "nNotYetValid", "nWeakDigest", "nSignTimeOutside",
  "nTimeMismatch", "nGapMismatch", "nFrontGap", "nAttached",
  "nNoSignedAttrs", "nVerifyError",
  "generatedBy", "honestyTitle", "honestyBody",
] as const;

interface SniffState {
  key: string;
  isPdf: boolean;
}

interface DoneState {
  key: string;
  name: string;
  blob: Blob;
  detail: VerifyDetail;
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
/* Small presentational pieces (repair-pdf ReportRow chip style)        */
/* ------------------------------------------------------------------ */

function toneChipClasses(tone: "green" | "amber" | "red"): string {
  if (tone === "green") {
    return "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  }
  if (tone === "amber") {
    return "border-amber-500/30 bg-amber-500/15 text-amber-800 dark:text-amber-300";
  }
  return "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300";
}

function ToneChip({
  tone,
  label,
}: {
  tone: "green" | "amber" | "red";
  label: string;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
        toneChipClasses(tone)
      )}
    >
      {label}
    </span>
  );
}

/** One card row: icon + label + value (+ optional trailing chip). */
function Row({
  icon,
  label,
  value,
  chip,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  chip?: React.ReactNode;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-2 sm:grid-cols-[9.5rem_minmax(0,1fr)_auto]">
      <p className="flex min-w-0 items-center gap-1.5 pt-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        <span className="truncate" title={label}>
          {label}
        </span>
      </p>
      <p
        className={cn(
          "min-w-0 col-span-1 text-sm leading-relaxed text-foreground sm:col-span-1",
          mono && "break-all font-mono text-xs"
        )}
      >
        {value}
      </p>
      <p className="col-span-2 flex justify-end sm:col-span-1">{chip}</p>
    </div>
  );
}

function RowIconWrap({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="shrink-0 text-muted-foreground/70">{children}</span>;
}

/* ------------------------------------------------------------------ */
/* The per-signature verdict card                                      */
/* ------------------------------------------------------------------ */

function SignatureCardView({
  card,
}: {
  card: SignatureCard;
}): React.JSX.Element {
  const { t } = useI18n();
  const p = card.signers[0];
  const cert = p?.cert ?? null;

  const statusWord =
    card.status === "valid"
      ? t("vps.vValid")
      : card.status === "attention"
        ? t("vps.vAttention")
        : t("vps.vInvalid");

  const validityChip = cert?.validityNow === "valid" ? (
    <ToneChip tone="green" label={t("vps.wValidNow")} />
  ) : cert?.validityNow === "expired" ? (
    <ToneChip tone="amber" label={t("vps.wExpired")} />
  ) : cert?.validityNow === "not-yet-valid" ? (
    <ToneChip tone="amber" label={t("vps.wNotYet")} />
  ) : null;

  const cryptoChip =
    p?.cryptoVerified === true ? (
      <ToneChip tone="green" label={t("vps.cPass")} />
    ) : p?.cryptoVerified === false ? (
      <ToneChip tone="red" label={t("vps.cFail")} />
    ) : (
      <ToneChip tone="amber" label={t("vps.cNotVerified")} />
    );

  const integrityChip =
    p?.integrity === "intact" ? (
      <ToneChip tone="green" label={t("vps.iOk")} />
    ) : p?.integrity === "tampered" ? (
      <ToneChip tone="red" label={t("vps.iBad")} />
    ) : (
      <ToneChip tone="amber" label={t("vps.iUnk")} />
    );

  const modifiedChip = card.modifiedAfterSigning === true
    ? <ToneChip tone="amber" label={t("vps.yYes")} />
    : <ToneChip tone="green" label={t("vps.yNo")} />;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-card border bg-card",
        card.tone === "green"
          ? "border-emerald-500/30"
          : card.tone === "amber"
            ? "border-amber-500/30"
            : "border-red-500/30"
      )}
    >
      {/* card header */}
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3",
          card.tone === "green"
            ? "border-emerald-500/20 bg-emerald-500/5"
            : card.tone === "amber"
              ? "border-amber-500/20 bg-amber-500/5"
              : "border-red-500/20 bg-red-500/5"
        )}
      >
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-btn",
            card.tone === "green"
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : card.tone === "amber"
                ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                : "bg-red-500/15 text-red-600 dark:text-red-400"
          )}
        >
          {card.tone === "green" ? (
            <ShieldCheck className="size-5" aria-hidden="true" />
          ) : card.tone === "amber" ? (
            <TriangleAlert className="size-5" aria-hidden="true" />
          ) : (
            <ShieldAlert className="size-5" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {t("vps.cardTitle", { index: card.index })}
            {card.fieldName !== null ? ` — ${card.fieldName}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            {card.page !== null
              ? t("vps.onPage", { page: card.page })
              : t("vps.rPageUnknown")}
            {card.subFilter !== null ? ` · ${card.subFilter}` : ""}
          </p>
        </div>
        <ToneChip tone={card.tone} label={statusWord} />
      </div>

      {/* rows */}
      <div className="flex flex-col divide-y divide-border/60">
        {cert !== null ? (
          <>
            <Row
              icon={<RowIconWrap><PenLine className="size-3.5" aria-hidden="true" /></RowIconWrap>}
              label={t("vps.rSigner")}
              value={
                <>
                  <span className="font-semibold">{cert.commonName ?? t("vps.unknown")}</span>
                  {cert.organization !== null ? (
                    <span className="text-muted-foreground"> · {cert.organization}</span>
                  ) : null}
                </>
              }
            />
            <Row
              icon={<RowIconWrap><Hash className="size-3.5" aria-hidden="true" /></RowIconWrap>}
              label={t("vps.rSerial")}
              value={cert.serialHex}
              mono
              chip={
                cert.selfSigned === true ? (
                  <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-300">
                    {t("vps.selfSignedChip")}
                  </span>
                ) : undefined
              }
            />
            <Row
              icon={<RowIconWrap><Clock className="size-3.5" aria-hidden="true" /></RowIconWrap>}
              label={t("vps.rValidity")}
              value={
                cert.notBeforeIso !== null && cert.notAfterIso !== null
                  ? `${cert.notBeforeIso} → ${cert.notAfterIso}`
                  : t("vps.unknown")
              }
              chip={validityChip}
            />
          </>
        ) : null}
        <Row
          icon={<RowIconWrap><Clock className="size-3.5" aria-hidden="true" /></RowIconWrap>}
          label={t("vps.rSignTime")}
          value={
            p?.signingTimeIso !== null && p !== undefined && p.signingTimeIso !== null
              ? p.signingTimeIso
              : card.pdfMTimeIso !== null
                ? card.pdfMTimeIso
                : t("vps.unknown")
          }
          chip={
            p?.signingTimeIso != null && card.pdfMTimeIso != null && p.signingTimeIso !== card.pdfMTimeIso ? (
              <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                /M ≠
              </span>
            ) : undefined
          }
        />
        {card.reason !== null && card.reason.length > 0 ? (
          <Row
            icon={<RowIconWrap><FileText className="size-3.5" aria-hidden="true" /></RowIconWrap>}
            label={t("vps.rReason")}
            value={card.reason}
          />
        ) : null}
        {card.location !== null && card.location.length > 0 ? (
          <Row
            icon={<RowIconWrap><MapPin className="size-3.5" aria-hidden="true" /></RowIconWrap>}
            label={t("vps.rLocation")}
            value={card.location}
          />
        ) : null}
        <Row
          icon={<RowIconWrap><FileSignature className="size-3.5" aria-hidden="true" /></RowIconWrap>}
          label={t("vps.rDigest")}
          value={`${p?.digestAlgo ?? "?"}${p?.signatureAlgo != null ? ` · ${p.signatureAlgo}` : ""}`}
        />
        <Row
          icon={<RowIconWrap><Fingerprint className="size-3.5" aria-hidden="true" /></RowIconWrap>}
          label={t("vps.rCrypto")}
          value={p?.cryptoVerified == null && p?.cryptoNoteKey != null ? t(p.cryptoNoteKey) : ""}
          chip={cryptoChip}
        />
        <Row
          icon={<RowIconWrap><ShieldCheck className="size-3.5" aria-hidden="true" /></RowIconWrap>}
          label={t("vps.rIntegrity")}
          value={
            p?.integrity === "tampered"
              ? t("vps.iTampered")
              : p?.integrity === "intact"
                ? t("vps.iIntact")
                : t("vps.iUnknown")
          }
          chip={integrityChip}
        />
        <Row
          icon={<RowIconWrap><CircleAlert className="size-3.5" aria-hidden="true" /></RowIconWrap>}
          label={t("vps.rModified")}
          value={`${t("vps.rTrailing")}: ${card.trailingBytes ?? 0}`}
          chip={modifiedChip}
        />
      </div>

      {/* notes */}
      {card.noteKeys.length > 0 ? (
        <div className="border-t border-border/60 bg-muted/30 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("vps.rNotes")}
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {card.noteKeys.map((key) => (
              <li key={key} className="flex items-start gap-2 text-xs leading-relaxed text-foreground/85">
                <Info className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
                {t(key)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* technical evidence */}
      {card.byteRange !== null ? (
        <p className="break-all border-t border-border/60 px-4 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
          /ByteRange [{card.byteRange.join(" ")}] · /Contents {card.cmsSize ?? 0} B
          {card.signers.length > 1
            ? ` · +${card.signers.length - 1} ${t("vps.moreSigners", { count: card.signers.length - 1 })}`
            : ""}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The surface                                                        */
/* ------------------------------------------------------------------ */

export function VerifyPdfSignaturesSurface({
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
        fileWord: t("vps.fileWord"),
        labels: Object.fromEntries(
          REPORT_KEYS.map((k) => [`vps.${k}`, t(`vps.${k}`)])
        ),
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [locale, t, onChange]);

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
      ? "vps.loading"
      : active.isPdf
        ? null
        : "vps.ctaUnknown";

  useEffect(() => {
    setRunBlocked(blockedKey);
    return () => setRunBlocked(null);
  }, [blockedKey, setRunBlocked]);

  /* ---- the verification run (validate-e-invoice's worker drive) ---- */
  const verify = useCallback((): void => {
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
              detail: (data.detail ?? {}) as VerifyDetail,
            });
            downloadBlob(output.blob, output.name);
            const d = data.detail as VerifyDetail | undefined;
            const toneWord =
              (d?.invalidCount ?? 0) > 0
                ? t("vps.vInvalid")
                : (d?.validCount ?? 0) === (d?.signatureCount ?? 0) && (d?.signatureCount ?? 0) > 0
                  ? t("vps.vValid")
                  : (d?.signatureCount ?? 0) > 0
                    ? t("vps.vAttention")
                    : t("vps.vNone");
            toast({
              title: t("vps.doneTitle"),
              description: t("vps.doneDesc", {
                name: output.name,
                tone: toneWord,
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
      toolId: "verify-pdf-signatures",
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
  const isPdf = active?.isPdf ?? false;
  const report = result?.detail.report ?? null;

  const nValid = report?.signatures.filter((s) => s.status === "valid").length ?? 0;
  const nAttention = report?.signatures.filter((s) => s.status === "attention").length ?? 0;
  const nInvalid = report?.signatures.filter((s) => s.status === "invalid").length ?? 0;
  const nUnsigned = report?.unsignedFields.length ?? 0;

  const worstTone: "green" | "amber" | "red" | null =
    report === null
      ? null
      : report.signatures.length === 0
        ? null
        : nInvalid > 0
          ? "red"
          : nAttention > 0
            ? "amber"
            : "green";

  return (
    <div className="flex flex-col gap-3">
      <PreviewFileHeader file={file} pageCount={report?.pageCount ?? 0} onRemove={removeFile} />

      {/* ---- what was detected (the honest local sniff) ---- */}
      {reading ? (
        <div
          className="flex items-center gap-3 rounded-card border border-border bg-card px-4 py-6 text-sm text-muted-foreground"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("vps.loading")}
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
                  {t("vps.modePdfTitle")}
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {t("vps.modePdfBody")}
                </p>
              </>
            ) : (
              <>
                <p className="font-semibold text-foreground">
                  {t("vps.ctaUnknown")}
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
          {t("vps.limitsTitle")}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {t("vps.limitsBody")}
        </p>
      </div>

      {/* ---- the run ---- */}
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          size="touch"
          className="w-full rounded-btn font-semibold"
          onClick={verify}
          disabled={busy || reading || !isPdf}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <BadgeCheck className="size-4" aria-hidden="true" />
          )}
          {busy
            ? t("vps.verifying", { pct: pct ?? 0 })
            : t("vps.verifyBtn")}
        </Button>
        {busy ? (
          <p
            role="status"
            className="text-center text-xs text-muted-foreground"
          >
            {t("vps.verifying", { pct: pct ?? 0 })}
          </p>
        ) : null}
      </div>

      {/* ---- the verification report ---- */}
      {report !== null && result !== null && !busy ? (
        <div className="flex flex-col gap-3" aria-live="polite">
          {/* summary banner */}
          {worstTone !== null ? (
            <div
              className={cn(
                "flex items-start gap-3 rounded-card border px-4 py-4",
                worstTone === "green"
                  ? "border-emerald-500/30 bg-emerald-500/10"
                  : worstTone === "amber"
                    ? "border-amber-500/30 bg-amber-500/10"
                    : "border-red-500/30 bg-red-500/10"
              )}
            >
              {worstTone === "green" ? (
                <ShieldCheck
                  className="mt-0.5 size-6 shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
              ) : worstTone === "amber" ? (
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
                    worstTone === "green"
                      ? "text-emerald-700 dark:text-emerald-300"
                      : worstTone === "amber"
                        ? "text-amber-800 dark:text-amber-300"
                        : "text-red-700 dark:text-red-300"
                  )}
                >
                  {worstTone === "green"
                    ? t("vps.toneValidTitle")
                    : worstTone === "amber"
                      ? t("vps.toneAttentionTitle")
                      : t("vps.toneInvalidTitle")}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-foreground/80">
                  {worstTone === "green"
                    ? t("vps.toneValidBody")
                    : worstTone === "amber"
                      ? t("vps.toneAttentionBody")
                      : t("vps.toneInvalidBody")}
                </p>
                <p className="mt-2 text-xs font-semibold text-foreground">
                  {t("vps.countsLine", {
                    valid: nValid,
                    attention: nAttention,
                    invalid: nInvalid,
                  })}
                </p>
              </div>
            </div>
          ) : null}

          {/* empty state — honestly NOT an error */}
          {report.signatures.length === 0 ? (
            <div className="flex items-start gap-3 rounded-card border border-border bg-card px-4 py-4">
              <FileSignature
                className="mt-0.5 size-6 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">
                  {t("vps.emptyTitle")}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t("vps.emptyBody")}
                </p>
              </div>
            </div>
          ) : (
            <p className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <ListChecks className="size-3.5" aria-hidden="true" />
              {t("vps.summaryTitle")}
            </p>
          )}

          {/* per-signature cards */}
          {report.signatures.map((card) => (
            <SignatureCardView key={card.index} card={card} />
          ))}

          {/* unsigned fields */}
          {report.unsignedFields.length > 0 ? (
            <div className="rounded-card border border-amber-500/30 bg-amber-500/5 px-4 py-3">
              <p className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <TriangleAlert
                  className="size-3.5 text-amber-500"
                  aria-hidden="true"
                />
                {t("vps.unsignedTitle")}
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {report.unsignedFields.map((f, i) => (
                  <li
                    key={`${f.fieldName ?? "f"}-${i}`}
                    className="text-xs text-muted-foreground"
                  >
                    {f.fieldName ?? t("vps.unknown")}
                    {f.page !== null ? ` · ${t("vps.onPage", { page: f.page })}` : ""} —{" "}
                    {t("vps.wUnsigned")}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* recovery note */}
          {report.recoveryUsed ? (
            <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
              {t("vps.recoveryLine")}
              {report.recoveryReason !== null ? ` (${report.recoveryReason})` : ""}
            </p>
          ) : null}

          {/* report download */}
          <div className="flex flex-col items-start gap-2 rounded-card border border-border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 break-all text-xs text-muted-foreground">
              {t("vps.doneDesc", {
                name: result.name,
                tone:
                  worstTone === "green"
                    ? t("vps.vValid")
                    : worstTone === "amber"
                      ? t("vps.vAttention")
                      : worstTone === "red"
                        ? t("vps.vInvalid")
                        : t("vps.vNone"),
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
              {t("vps.again")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
