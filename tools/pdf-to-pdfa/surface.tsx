"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CircleAlert,
  FileCheck2,
  FileText,
  Info,
  Loader2,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import { getPdfPageCount } from "@/lib/pdf/thumbnails";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { cn } from "@/lib/utils";
import { PreviewFileHeader } from "../stamp-common/preview-parts";
import { DEFAULT_PDFA_TARGET } from "./types";
import type { PdfaTarget } from "./types";

/**
 * PDF to PDF/A surface (RB7-a, split-tool pattern): this surface owns
 * every value — the conformance target radio (1b/2b/3b) and the localized
 * report labels that ride the run payload. The shell drives the worker
 * (config.createWorker): processing + result phases and both downloads
 * (converted PDF + change report) come from the shared pipeline.
 *
 * The input check is a LOCAL byte sniff (deliberately not the model — the
 * model's module graph carries @pdf-lib/standard-fonts, and that must stay
 * worker-only), same rule as validate-pdfa's surface.
 */

/** Report label keys — every string the worker's .txt builder needs. */
const REPORT_KEYS = [
  "title", "fFile", "fTarget", "fPages", "fSize",
  "secChanges", "cColors", "cScanned", "cRewritten", "cSkipped", "cToRgb",
  "fFonts", "fEmbedded", "fStdKept", "fStdEmb",
  "fActions", "fActionsItems", "fTreeGone", "fGone", "fAnnotActions",
  "fMmAnnots", "fEmbDropped", "fEmbKept",
  "fMetadata", "fWritten", "fNotWritten", "fOi", "fOiHand", "fOiNone",
  "fTrailer", "fEnsured",
  "secPages", "pagesNone", "noAp", "secLimits",
  "limNone1b", "limTrans", "limTransOk", "limSkip", "limSh",
  "tagging", "footer", "pageWord",
] as const;

const TARGETS: { value: PdfaTarget; labelKey: string; hintKey: string }[] = [
  { value: "1b", labelKey: "pa.t1b", hintKey: "pa.t1bHint" },
  { value: "2b", labelKey: "pa.t2b", hintKey: "pa.t2bHint" },
  { value: "3b", labelKey: "pa.t3b", hintKey: "pa.t3bHint" },
];

interface SniffState {
  key: string;
  isPdf: boolean;
  encrypted: boolean;
  javaScript: boolean;
  transparency: boolean;
  embeddedFiles: boolean;
}

/* ------------------------------------------------------------------ */
/* Local magic-byte + risk sniff (no model import — the heavy graph    */
/* stays in the worker; same rule as the validate-pdfa surface)        */
/* ------------------------------------------------------------------ */

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

export function PdfToPdfaSurface({
  files,
  onChange,
  setFileOrder,
  setRunBlocked,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t, locale } = useI18n();
  const fileMeta = files[0];
  const file = fileMeta?.file ?? null;
  const fileKey = file ? `${file.name}:${file.size}:${file.lastModified}` : "";

  const [target, setTarget] = useState<PdfaTarget>(DEFAULT_PDFA_TARGET);
  const [sniffState, setSniffState] = useState<SniffState | null>(null);

  /* --- page census (the header's page count) -------------------------- */
  const [pageCount, setPageCount] = useState(0);
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void getPdfPageCount(file)
      .then((count) => {
        if (!cancelled) setPageCount(count);
      })
      .catch(() => {
        if (!cancelled) setPageCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  /* --- the local input sniff (tiny byte scan — never the model) -------- */
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      let isPdf = false;
      let encrypted = false;
      let javaScript = false;
      let transparency = false;
      let embeddedFiles = false;
      try {
        const buf = await file.slice(0, 2048).arrayBuffer();
        isPdf = localPdfSniff(new Uint8Array(buf));
        if (isPdf) {
          // cheap risk peek over the first 2 MB (the model's honest
          // heuristics inlined — no model import on the main thread)
          const peek = new Uint8Array(
            await file.slice(0, Math.min(file.size, 2 * 1024 * 1024)).arrayBuffer()
          );
          let latin = "";
          const CHUNK = 8192;
          for (let i = 0; i < peek.length; i += CHUNK) {
            latin += String.fromCharCode(
              ...peek.subarray(i, Math.min(i + CHUNK, peek.length))
            );
          }
          encrypted = /\/Encrypt\b/.test(latin);
          javaScript = /\/JavaScript\b|\/JS\b|\/OpenAction\b|\/AA\b/.test(latin);
          transparency = /\/SMask\b/.test(latin);
          embeddedFiles = /\/EmbeddedFiles\b|\/Filespec\b/.test(latin);
        }
      } catch {
        isPdf = false;
      }
      if (!cancelled) {
        setSniffState({
          key: fileKey,
          isPdf,
          encrypted,
          javaScript,
          transparency,
          embeddedFiles,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, fileKey]);

  const active = sniffState !== null && sniffState.key === fileKey ? sniffState : null;
  const reading = active === null;

  /* --- run payload: target + labels ------------------------------------ */
  const labels = useMemo(
    () =>
      Object.fromEntries(
        REPORT_KEYS.map((key) => [`pa.${key}`, t(`pa.${key}`)])
      ) as Record<string, string>,
    [t]
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      onChange("run", JSON.stringify({ locale, labels }));
    });
    return () => {
      cancelled = true;
    };
  }, [locale, labels, onChange]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) onChange("target", target);
    });
    return () => {
      cancelled = true;
    };
  }, [target, onChange]);

  /* --- CTA gating: only the truly hopeless stop the run ---------------- */
  const blockedKey = !file
    ? null
    : reading
      ? "pa.loading"
      : active.isPdf
        ? null
        : "pa.ctaUnknown";

  useEffect(() => {
    setRunBlocked(blockedKey);
    return () => setRunBlocked(null);
  }, [blockedKey, setRunBlocked]);

  if (!file || !fileMeta) return null;

  const isPdf = active?.isPdf ?? false;
  const risks: { key: string; tone: "danger" | "warn" }[] = [];
  if (active?.encrypted) {
    risks.push({ key: "pa.riskEncrypted", tone: "danger" });
  }
  if (active?.javaScript) risks.push({ key: "pa.riskJs", tone: "warn" });
  if (active?.transparency) {
    risks.push({ key: "pa.riskTransparency", tone: "warn" });
  }
  if (active?.embeddedFiles) {
    risks.push({ key: "pa.riskEmbedded", tone: "warn" });
  }

  return (
    <div className="flex flex-col gap-3">
      <PreviewFileHeader
        file={file}
        pageCount={pageCount}
        onRemove={() => setFileOrder([])}
      />

      {/* --- what was detected (the honest local sniff) ------------------ */}
      {reading ? (
        <div
          className="flex items-center gap-3 rounded-card border border-border bg-card px-4 py-6 text-sm text-muted-foreground"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("pa.loading")}
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
                  {t("pa.modePdfTitle")}
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {t("pa.modePdfBody")}
                </p>
              </>
            ) : (
              <p className="font-semibold text-foreground">
                {t("pa.ctaUnknown")}
              </p>
            )}
          </div>
        </div>
      )}

      {/* --- honest heads-up chips --------------------------------------- */}
      {!reading && isPdf && risks.length > 0 ? (
        <div className="rounded-card border border-border bg-card p-4">
          <p className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <TriangleAlert
              className="size-3.5 text-amber-500"
              aria-hidden="true"
            />
            {t("pa.riskTitle")}
          </p>
          <ul className="mt-2.5 flex flex-col gap-1.5">
            {risks.map((risk) => (
              <li
                key={risk.key}
                className={cn(
                  "flex items-center gap-2 rounded-btn border px-2.5 py-1.5 text-xs",
                  risk.tone === "danger"
                    ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300"
                )}
              >
                {risk.tone === "danger" ? (
                  <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                )}
                <span className="min-w-0">{t(risk.key)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {t("pa.riskNote")}
          </p>
        </div>
      ) : null}

      {/* --- the conformance target -------------------------------------- */}
      <div className="rounded-card border border-border bg-card p-4">
        <p className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <FileCheck2 className="size-3.5 text-primary" aria-hidden="true" />
          {t("pa.targetLabel")}
        </p>
        <div
          className="mt-2.5 grid gap-2 sm:grid-cols-3"
          role="radiogroup"
          aria-label={t("pa.targetLabel")}
        >
          {TARGETS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={target === opt.value}
              onClick={() => setTarget(opt.value)}
              className={cn(
                "flex min-h-11 flex-col gap-1 rounded-btn border px-3 py-2 text-left transition-colors",
                target === opt.value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:bg-muted/50"
              )}
            >
              <span className="text-xs font-semibold">{t(opt.labelKey)}</span>
              <span className="text-[10px] leading-relaxed">
                {t(opt.hintKey)}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {t("pa.targetHint")}
        </p>
      </div>

      {/* --- honest limits ------------------------------------------------ */}
      <div className="rounded-card border border-border bg-card p-4">
        <p className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <Info className="size-3.5 text-amber-500" aria-hidden="true" />
          {t("pa.limitsTitle")}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {t("pa.limitsBody")}
        </p>
      </div>

      {/* --- privacy line -------------------------------------------------- */}
      <p className="flex items-start gap-2 px-1 text-[11px] leading-relaxed text-muted-foreground">
        <ShieldCheck
          className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
        {t("pa.privacyLine")}
      </p>
    </div>
  );
}
