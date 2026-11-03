"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock,
  Download,
  FilePenLine,
  Loader2,
  PenLine,
  RefreshCw,
  Server,
  TriangleAlert,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { downloadBlob } from "@/lib/files/output";
import {
  getPdfPageCount,
  getPdfPagePixelSize,
  renderPdfThumbnail,
} from "@/lib/pdf/thumbnails";
import { formatBytes } from "@/lib/storage/recent-files";
import { SignatureDialog } from "../sign-pdf/signature-dialog";
import type { StoredSignature } from "../sign-pdf/signature-store";
import {
  fetchMeta,
  fetchPdf,
  postSigned,
  RequestSignError,
  type SignRequestMeta,
} from "./api";

/**
 * Recipient signing view (P9-F6B, tool #96) — what opens at
 * "#/sign/<signToken>".
 *
 * The ONLY Mode S signature flow, honestly so: the request envelope (PDF +
 * expiry) waits on Sidocs's signing service so the link outlives the
 * requester's tab, but the actual signing — creating the signature
 * (SignatureDialog) and merging it into the PDF (pdf-lib, in this tab) —
 * happens 100% client-side. Only the finished signed PDF goes back to the
 * service for the sender to collect.
 */

type Phase =
  | "loading"
  | "ready"
  | "signing"
  | "done"
  | "already"
  | "gone"
  | "netError";
type GoneKind = "missing" | "expired" | "cancelled";
type Pos = "br" | "bl" | "cb";

/** Bottom margin from the page edge, in PDF points. */
const MARGIN_PT = 40;

/** Human "2 days 4 hours" style label for a millisecond span. */
export function rsignTimeLeft(
  ms: number,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return t("rsign.unitMinutes", { n: Math.max(1, mins) });
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  const hoursLabel = remMins > 0
    ? `${t("rsign.unitHours", { n: hours })} ${t("rsign.unitMinutes", { n: remMins })}`
    : t("rsign.unitHours", { n: hours });
  if (hours < 48) return hoursLabel;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0
    ? `${t("rsign.unitDays", { n: days })} ${t("rsign.unitHours", { n: remHours })}`
    : t("rsign.unitDays", { n: days });
}

/** Locale-aware absolute time ("20 Oct 2026, 4:45 pm"). */
export function rsignFormatWhen(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

/** pdf-lib user-space box (origin bottom-left) for the signature stamp. */
function placementBox(
  pageW: number,
  pageH: number,
  aspect: number,
  width: number,
  pos: Pos
): { x: number; y: number; w: number; h: number } {
  const w = width;
  const h = width * aspect;
  const x =
    pos === "br"
      ? pageW - w - MARGIN_PT
      : pos === "bl"
        ? MARGIN_PT
        : (pageW - w) / 2;
  return { x, y: MARGIN_PT, w, h };
}

function dataUrlToUint8(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function RecipientSignView({ token }: { token: string }): React.JSX.Element {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [phase, setPhase] = useState<Phase>("loading");
  const [goneKind, setGoneKind] = useState<GoneKind>("missing");
  const [meta, setMeta] = useState<SignRequestMeta | null>(null);
  const [signedBlob, setSignedBlob] = useState<Blob | null>(null);

  /* ---- countdown: one 1 s ticker while the request is live ---- */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (phase !== "ready" && phase !== "signing") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  /* ---- mount: read the envelope (microtask-first, cancellable) ---- */
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const m = await fetchMeta(token);
      if (cancelled) return;
      setMeta(m);
      if (m.status === "signed") setPhase("already");
      else if (m.status === "expired") {
        setGoneKind("expired");
        setPhase("gone");
      } else if (m.status === "cancelled") {
        setGoneKind("cancelled");
        setPhase("gone");
      } else setPhase("ready");
    })().catch((err: unknown) => {
      if (cancelled) return;
      if (err instanceof RequestSignError && err.status === 404) {
        setGoneKind("missing");
        setPhase("gone");
      } else {
        setPhase("netError");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token, reloadKey]);

  /* ---- signature + placement state ---- */
  const [sigOpen, setSigOpen] = useState(false);
  const [sig, setSig] = useState<StoredSignature | null>(null);
  const [pdf, setPdf] = useState<{ blob: Blob; pages: number } | null>(null);
  const [pdfError, setPdfError] = useState(false);
  const [pageNum, setPageNum] = useState(1);
  const [sigWidth, setSigWidth] = useState(150);
  const [pos, setPos] = useState<Pos>("br");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(
    null
  );
  const previewUrlRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (previewUrlRef.current !== null) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    },
    []
  );

  /* ---- once a signature exists: fetch the PDF once, count pages ---- */
  useEffect(() => {
    if (phase !== "ready" || sig === null || pdf !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const blob = await fetchPdf(token);
        const pages = await getPdfPageCount(blob);
        if (cancelled) return;
        setPageNum(1);
        setPdf({ blob, pages });
      } catch (err) {
        if (cancelled) return;
        if (
          err instanceof RequestSignError &&
          (err.status === 404 || err.status === 410)
        ) {
          setGoneKind(err.status === 410 ? "expired" : "missing");
          setPhase("gone");
        } else {
          setPdfError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, sig, pdf, token]);

  /* ---- live preview: render the chosen page (pdf.js thumbnail recipe) ---- */
  useEffect(() => {
    if (pdf === null || sig === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const [thumb, size] = await Promise.all([
          renderPdfThumbnail(pdf.blob, { pageIndex: pageNum - 1, maxDim: 620 }),
          getPdfPagePixelSize(pdf.blob, 1, pageNum - 1),
        ]);
        const url = URL.createObjectURL(thumb.blob);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        const prev = previewUrlRef.current;
        previewUrlRef.current = url;
        setPreviewUrl(url);
        setPageSize(size);
        if (prev !== null) URL.revokeObjectURL(prev);
      } catch {
        // Preview is a courtesy — a schematic box still shows the placement.
        if (!cancelled) setPreviewUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, sig, pageNum]);

  const expiredNow =
    phase === "ready" && meta !== null && now > meta.expiresAt;
  const leftLabel = useMemo(
    () => rsignTimeLeft(Math.max(0, (meta?.expiresAt ?? 0) - now), t),
    [meta, now, t]
  );

  /* ---- the overlay box (percent space of the rendered page) ---- */
  const overlay = useMemo(() => {
    if (pageSize === null || sig === null) return null;
    const box = placementBox(
      pageSize.width,
      pageSize.height,
      sig.h / sig.w,
      sigWidth,
      pos
    );
    return {
      left: `${(box.x / pageSize.width) * 100}%`,
      bottom: `${(box.y / pageSize.height) * 100}%`,
      width: `${(box.w / pageSize.width) * 100}%`,
      height: `${(box.h / pageSize.height) * 100}%`,
    };
  }, [pageSize, sig, sigWidth, pos]);

  /* ---- sign & submit: merge client-side (own engine), then one upload ---- */
  const submit = useCallback(async (): Promise<void> => {
    if (phase !== "ready" || sig === null || pdf === null) return;
    setPhase("signing");
    try {
      const { StampContext } = await import("@/lib/own/pdf");
      const ctx = StampContext.load(new Uint8Array(await pdf.blob.arrayBuffer()));
      const img = ctx.embedPng(dataUrlToUint8(sig.dataUrl));
      const pageIndex = Math.min(pageNum, pdf.pages) - 1;
      const page = ctx.pages[pageIndex]!;
      const pw = page.mediaBox[2] - page.mediaBox[0];
      const ph = page.mediaBox[3] - page.mediaBox[1];
      const box = placementBox(pw, ph, sig.h / sig.w, sigWidth, pos);
      ctx.stampRect(pageIndex, {
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        borderColor: { r: 0.55, g: 0.57, b: 0.6 },
        borderWidth: 0.75,
      });
      ctx.stampImage(pageIndex, img, {
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
      });
      const out = ctx.write();
      const blob = new Blob([out as unknown as BlobPart], {
        type: "application/pdf",
      });
      await postSigned(token, blob);
      setSignedBlob(blob);
      setPhase("done");
    } catch (err) {
      if (err instanceof RequestSignError) {
        if (err.status === 409) {
          setPhase("already");
          return;
        }
        if (err.status === 410) {
          setGoneKind(err.code === "rsign.cancelled" ? "cancelled" : "expired");
          setPhase("gone");
          return;
        }
      }
      toast({ title: t("rsign.errSign") });
      setPhase("ready");
    }
  }, [phase, sig, pdf, pageNum, sigWidth, pos, token, toast, t]);

  const downloadSignedCopy = useCallback((): void => {
    if (signedBlob === null || meta === null) return;
    downloadBlob(
      signedBlob,
      `${meta.fileName.replace(/\.pdf$/i, "")}-signed.pdf`
    );
  }, [signedBlob, meta]);

  const retryMeta = useCallback((): void => {
    setPhase("loading");
    setReloadKey((n) => n + 1);
  }, []);

  const retryPdf = useCallback((): void => {
    setPdf(null);
    setPdfError(false);
  }, []);

  /* ---------------------------------------------------------------- */

  const backHome = (
    <Button asChild variant="outline" className="rounded-btn">
      <a href="#/">{t("rsign.backHome")}</a>
    </Button>
  );

  return (
    <section
      aria-labelledby="rsign-rv-title"
      className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12"
    >
      <div className="flex flex-col gap-4">
        <header className="flex flex-wrap items-center gap-2.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary">
            <FilePenLine className="size-5" aria-hidden="true" />
          </span>
          <h1
            id="rsign-rv-title"
            className="min-w-0 flex-1 text-xl font-bold tracking-tight text-foreground sm:text-2xl"
          >
            {t("rsign.rvTitle")}
          </h1>
          <Badge variant="server" className="rounded-chip">
            <Server className="size-3" aria-hidden="true" />
            {t("tools.serverBadge")}
          </Badge>
        </header>

        {/* ---- loading ---- */}
        {phase === "loading" ? (
          <div
            className="flex items-center gap-3 rounded-card border border-border bg-card p-6 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="size-5 animate-spin text-primary" aria-hidden="true" />
            {t("rsign.rvLoading")}
          </div>
        ) : null}

        {/* ---- network error (retryable) ---- */}
        {phase === "netError" ? (
          <div
            className="flex flex-col items-start gap-3 rounded-card border border-amber-500/40 bg-amber-500/10 p-6"
            role="alert"
          >
            <p className="flex items-start gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {t("rsign.errStatus")}
            </p>
            <Button
              type="button"
              variant="outline"
              className="rounded-btn"
              onClick={retryMeta}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {t("rsign.retry")}
            </Button>
          </div>
        ) : null}

        {/* ---- gone: missing / expired / cancelled ---- */}
        {phase === "gone" || expiredNow ? (
          <div className="flex flex-col items-start gap-3 rounded-card border border-border bg-card p-6">
            {goneKind === "cancelled" ? (
              <XCircle className="size-8 text-rose-500" aria-hidden="true" />
            ) : (
              <Clock className="size-8 text-amber-500" aria-hidden="true" />
            )}
            <h2 className="text-base font-semibold text-foreground">
              {expiredNow || goneKind === "expired"
                ? t("rsign.rvExpiredTitle")
                : goneKind === "cancelled"
                  ? t("rsign.rvCancelledTitle")
                  : t("rsign.rvMissingTitle")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {expiredNow || goneKind === "expired"
                ? t("rsign.rvExpiredHint")
                : goneKind === "cancelled"
                  ? t("rsign.rvCancelledHint")
                  : t("rsign.rvMissingHint")}
            </p>
            {backHome}
          </div>
        ) : null}

        {/* ---- already signed ---- */}
        {phase === "already" ? (
          <div className="flex flex-col items-start gap-3 rounded-card border border-emerald-500/40 bg-emerald-500/10 p-6">
            <CheckCircle2 className="size-8 text-emerald-500" aria-hidden="true" />
            <h2 className="text-base font-semibold text-foreground">
              {t("rsign.rvDoneTitle")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("rsign.rvDoneHint")}
            </p>
            {backHome}
          </div>
        ) : null}

        {/* ---- done ---- */}
        {phase === "done" && signedBlob !== null ? (
          <div className="flex flex-col items-start gap-3 rounded-card border border-emerald-500/40 bg-emerald-500/10 p-6">
            <CheckCircle2 className="size-8 text-emerald-500" aria-hidden="true" />
            <h2 className="text-base font-semibold text-foreground">
              {t("rsign.successTitle")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("rsign.successHint")}</p>
            <Button type="button" onClick={downloadSignedCopy} className="rounded-btn">
              <Download className="size-4" aria-hidden="true" />
              {t("rsign.downloadCopy")}
            </Button>
            {backHome}
          </div>
        ) : null}

        {/* ---- the live signing flow (kept mounted while submitting) ---- */}
        {(phase === "ready" || phase === "signing") && !expiredNow && meta !== null ? (
          <>
            {/* honest Mode S note — the envelope waits server-side */}
            <p className="flex items-start gap-2 rounded-card bg-muted/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
              <Server
                className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
              {t("rsign.serverNote")}
            </p>

            {/* file card */}
            <div className="rounded-card border border-border bg-card p-4 shadow-sm sm:p-6">
              <div className="flex items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-btn bg-primary/10 text-primary">
                  <FilePenLine className="size-5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {meta.fileName}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {formatBytes(meta.bytes)} · {t("rsign.rowFrom")}: {meta.from}
                  </p>
                </div>
              </div>
              {meta.message.length > 0 ? (
                <div className="mt-3 rounded-btn bg-muted/50 p-3">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("rsign.rvMessage")}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
                    {meta.message}
                  </p>
                </div>
              ) : null}
              <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
                {t("rsign.expiresIn", { time: leftLabel })}
              </p>
            </div>

            {/* step 1 — the signature (existing SignatureDialog) */}
            <div className="rounded-card border border-border bg-card p-4 shadow-sm sm:p-6">
              <h2 className="text-sm font-semibold text-foreground">
                {t("rsign.rvStep1")}
              </h2>
              {sig === null ? (
                <Button
                  type="button"
                  className="mt-3 rounded-btn"
                  onClick={() => setSigOpen(true)}
                >
                  <PenLine className="size-4" aria-hidden="true" />
                  {t("rsign.placeSig")}
                </Button>
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <div className="flex min-h-16 max-w-xs items-center justify-center rounded-btn border border-border bg-checker p-2">
                    <img
                      src={sig.dataUrl}
                      alt={t("rsign.rvStep1")}
                      className="max-h-14 max-w-[240px] object-contain"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-btn"
                    onClick={() => setSigOpen(true)}
                  >
                    {t("rsign.changeSig")}
                  </Button>
                </div>
              )}
            </div>

            {/* step 2 — placement (only with a signature) */}
            {sig !== null ? (
              <div className="rounded-card border border-border bg-card p-4 shadow-sm sm:p-6">
                <h2 className="text-sm font-semibold text-foreground">
                  {t("rsign.rvStep2")}
                </h2>

                {pdfError ? (
                  <div
                    className="mt-3 flex flex-col items-start gap-3 rounded-btn border border-amber-500/40 bg-amber-500/10 p-3"
                    role="alert"
                  >
                    <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                      {t("rsign.errPdf")}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="rounded-btn"
                      onClick={retryPdf}
                    >
                      <RefreshCw className="size-3.5" aria-hidden="true" />
                      {t("rsign.retry")}
                    </Button>
                  </div>
                ) : pdf === null ? (
                  <p
                    className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"
                    role="status"
                  >
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    {t("rsign.loadingPdf")}
                  </p>
                ) : (
                  <>
                    <div className="mt-3 grid gap-4 sm:grid-cols-3">
                      <div className="min-w-0">
                        <Label htmlFor="rsign-page" className="text-xs font-medium">
                          {t("rsign.pageLabel")}
                        </Label>
                        <select
                          id="rsign-page"
                          className="mt-1.5 h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                          value={pageNum}
                          onChange={(e) => setPageNum(Number(e.target.value))}
                        >
                          {Array.from(
                            { length: pdf.pages },
                            (_, i) => i + 1
                          ).map((n) => (
                            <option key={n} value={n}>
                              {n} / {pdf.pages}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="min-w-0">
                        <Label htmlFor="rsign-pos" className="text-xs font-medium">
                          {t("rsign.posLabel")}
                        </Label>
                        <select
                          id="rsign-pos"
                          className="mt-1.5 h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                          value={pos}
                          onChange={(e) => setPos(e.target.value as Pos)}
                        >
                          <option value="br">{t("rsign.posBr")}</option>
                          <option value="bl">{t("rsign.posBl")}</option>
                          <option value="cb">{t("rsign.posCb")}</option>
                        </select>
                      </div>
                      <div className="min-w-0">
                        <span className="text-xs font-medium">
                          {t("rsign.sizeLabel")}
                        </span>
                        <div className="mt-3 flex items-center gap-3 px-1">
                          <Slider
                            value={[sigWidth]}
                            min={80}
                            max={240}
                            step={5}
                            onValueChange={([v]) => setSigWidth(v)}
                            aria-label={t("rsign.sizeLabel")}
                          />
                          <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                            {sigWidth} pt
                          </span>
                        </div>
                        <span className="sr-only">
                          {t("rsign.sizeHint", { n: sigWidth })}
                        </span>
                      </div>
                    </div>

                    {/* live preview — the real page + placement overlay */}
                    <div className="mt-4">
                      <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                        {t("rsign.previewLabel")}
                      </p>
                      <div className="relative mx-auto w-full max-w-sm overflow-hidden rounded-btn border border-border bg-muted/40 sm:max-w-md">
                        {previewUrl !== null ? (
                          <img
                            src={previewUrl}
                            alt={t("rsign.previewAlt")}
                            className="block w-full"
                          />
                        ) : (
                          <div
                            className="flex aspect-[3/4] w-full items-center justify-center"
                            role="img"
                            aria-label={t("rsign.previewAlt")}
                          >
                            {pageSize === null ? (
                              <Loader2
                                className="size-5 animate-spin text-muted-foreground"
                                aria-hidden="true"
                              />
                            ) : (
                              <FilePenLine
                                className="size-6 text-muted-foreground/60"
                                aria-hidden="true"
                              />
                            )}
                          </div>
                        )}
                        {overlay !== null ? (
                          <div
                            className="pointer-events-none absolute border-2 border-dashed border-emerald-500 bg-emerald-500/10"
                            style={overlay}
                            aria-hidden="true"
                          />
                        ) : null}
                      </div>
                    </div>

                    <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
                      {t("rsign.submitHint")}
                    </p>
                    <Button
                      type="button"
                      className="mt-3 w-full rounded-btn sm:w-auto"
                      disabled={phase === "signing"}
                      onClick={() => void submit()}
                    >
                      {phase === "signing" ? (
                        <>
                          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                          {t("rsign.signing")}
                        </>
                      ) : (
                        <>
                          <PenLine className="size-4" aria-hidden="true" />
                          {t("rsign.signCta")}
                        </>
                      )}
                    </Button>
                  </>
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <SignatureDialog
        open={sigOpen}
        onOpenChange={setSigOpen}
        onCreated={(created) => setSig(created)}
      />
    </section>
  );
}
