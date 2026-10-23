"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Loader2,
  Mail,
  MousePointerClick,
  PenLine,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { getPdfPageCount, renderPdfThumbnail } from "@/lib/pdf/thumbnails";
import { cn } from "@/lib/utils";
import { PreviewFileHeader, PreviewPageStrip } from "../stamp-common/preview-parts";
import {
  MAX_SPOTS,
  NOTE_KEYS,
  clamp01,
  formatDueDate,
  isValidEmail,
  mailtoHref,
} from "./model";
import type { RequestDetails, SignatureSpot } from "./types";

/**
 * Request signature surface (RB6-b) — the multi-step prepare form.
 *
 * Step 1 "Details": the request itself (recipient name/email, sender,
 * subject, message, due date). Step 2 "Placement": the rendered page
 * preview (pdf.js thumbnails, the fill-out-pdf pattern) — every click
 * drops a numbered sign-here spot at that position; the spot list below
 * shows page + position with per-spot remove. The "Send it yourself" card
 * carries the honest mailto: button — it opens the USER'S OWN mail client
 * with the draft; browsers cannot attach files to a mail program, so the
 * copy says plainly that the downloaded pack is attached by hand.
 *
 * Everything the worker needs (details + spots + localized note labels)
 * is serialized into the shared `request` option, defensive-parsed on the
 * other side (parseRequestRun). No file, no spot or no name blocks the
 * run CTA with an honest reason.
 */

const PREVIEW_MAX_DIM = 520;

const EMPTY_DETAILS: RequestDetails = {
  recipientName: "",
  senderName: "",
  recipientEmail: "",
  subject: "",
  message: "",
  dueDate: "",
};

/** Display-space box (same geometry the worker draws). */
const SPOT_W_PCT = 0.22;
const SPOT_H_PCT = 0.055;

export function RequestSignatureSurface({
  files,
  onChange,
  setFileOrder,
  setRunBlocked,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t, locale } = useI18n();
  const fileMeta = files[0];
  const file = fileMeta?.file ?? null;
  const fileKey = fileMeta?.id ?? "";

  /* --- request details (step 1) ---------------------------------- */
  const [details, setDetails] = useState<RequestDetails>({ ...EMPTY_DETAILS });
  const [step, setStep] = useState<1 | 2>(1);
  const setDetail = useCallback(
    (key: keyof RequestDetails, value: string): void => {
      setDetails((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  /* --- spots (step 2), keyed by file so a replaced document can
   *     never inherit stale placements ---------------------------------- */
  const [spotState, setSpotState] = useState<{
    fileKey: string;
    spots: SignatureSpot[];
  } | null>(null);
  const spots =
    spotState !== null && spotState.fileKey === fileKey ? spotState.spots : [];
  const setSpots = useCallback(
    (next: SignatureSpot[]): void => {
      setSpotState({ fileKey, spots: next });
    },
    [fileKey]
  );

  /* --- page census + preview (fill-out-pdf pattern) ------------------ */
  const [pageCount, setPageCount] = useState(0);
  const [selectedPage, setSelectedPage] = useState(0);
  const [base, setBase] = useState<{
    file: File;
    pageIndex: number;
    bitmap: ImageBitmap;
  } | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

  useEffect(() => {
    if (!file || pageCount === 0) return;
    let cancelled = false;
    void (async () => {
      const thumb = await renderPdfThumbnail(file, {
        pageIndex: selectedPage,
        maxDim: PREVIEW_MAX_DIM,
      });
      if (cancelled) return;
      const bitmap = await createImageBitmap(thumb.blob);
      if (cancelled) return;
      setPreviewError(false);
      setBase({ file, pageIndex: selectedPage, bitmap });
    })().catch(() => {
      if (!cancelled) {
        setPreviewError(true);
        setBase(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [file, pageCount, selectedPage]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !base) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = base.bitmap.width;
    canvas.height = base.bitmap.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base.bitmap, 0, 0);
  }, [base]);

  const current =
    base !== null && base.file === file && base.pageIndex === selectedPage
      ? base
      : null;

  /* --- localized note labels + the serialized run payload ------------ */
  const labels = useMemo(
    () =>
      Object.fromEntries(
        NOTE_KEYS.map((key) => [`reqsig.${key}`, t(`reqsig.${key}`)])
      ) as Record<string, string>,
    [t]
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      onChange(
        "request",
        JSON.stringify({ locale, details, spots, labels })
      );
    });
    return () => {
      cancelled = true;
    };
  }, [locale, details, spots, labels, onChange]);

  /* --- CTA gating ------------------------------------------------------ */
  const nameMissing = details.recipientName.trim() === "";
  const blockedKey = nameMissing
    ? "reqsig.ctaNoName"
    : spots.length === 0
      ? "reqsig.ctaNoSpots"
      : null;
  useEffect(() => {
    setRunBlocked(blockedKey);
  }, [blockedKey, setRunBlocked]);

  /* --- interactions ----------------------------------------------------- */
  const addSpot = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (spots.length >= MAX_SPOTS) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = clamp01((event.clientX - bounds.left) / bounds.width);
      const y = clamp01((event.clientY - bounds.top) / bounds.height);
      setSpots([...spots, { page: selectedPage, x, y }]);
    },
    [spots, selectedPage, setSpots]
  );

  const removeSpot = useCallback(
    (index: number): void => {
      setSpots(spots.filter((_, i) => i !== index));
    },
    [spots, setSpots]
  );

  const mailHref = useMemo(
    () => mailtoHref({ locale, details, spots, labels }, file?.name ?? "document.pdf"),
    [locale, details, spots, labels, file]
  );

  const emailBad =
    details.recipientEmail.trim() !== "" &&
    !isValidEmail(details.recipientEmail);

  const spotPages = useMemo(() => {
    const set = new Set<number>();
    for (const spot of spots) set.add(spot.page);
    return set;
  }, [spots]);

  if (!file || !fileMeta) return null;

  return (
    <div className="flex flex-col gap-4">
      <PreviewFileHeader
        file={file}
        pageCount={pageCount}
        onRemove={() => setFileOrder([])}
      />

      {/* --- step chips ------------------------------------------------- */}
      <ol className="flex flex-wrap items-center gap-2" aria-label={t("reqsig.formTitle")}>
        {(
          [
            [1, "reqsig.step1"],
            [2, "reqsig.step2"],
          ] as const
        ).map(([n, key]) => (
          <li key={n}>
            <button
              type="button"
              aria-current={step === n ? "step" : undefined}
              onClick={() => setStep(n as 1 | 2)}
              className={cn(
                "flex min-h-9 items-center gap-2 rounded-chip border px-3 text-sm font-medium outline-none transition-colors",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                step === n
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:border-primary/30"
              )}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full text-[11px] font-bold",
                  step === n ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                )}
                aria-hidden="true"
              >
                {n}
              </span>
              {t(key)}
            </button>
          </li>
        ))}
      </ol>

      {/* --- step 1: request details ------------------------------------- */}
      {step === 1 ? (
        <section
          className="flex flex-col gap-5 rounded-card border border-border bg-card p-5 sm:p-6"
          aria-labelledby="reqsig-form-title"
        >
          <header className="flex flex-wrap items-center gap-3">
            <span
              className="flex size-10 items-center justify-center rounded-btn bg-cat-security/10 text-cat-security"
              aria-hidden="true"
            >
              <PenLine className="size-5" />
            </span>
            <div className="min-w-0">
              <h2 id="reqsig-form-title" className="text-base font-semibold text-foreground">
                {t("reqsig.formTitle")}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t("reqsig.formSubtitle")}
              </p>
            </div>
          </header>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="reqsig-name" className="text-sm">
                {t("reqsig.recipientName")} *
              </Label>
              <Input
                id="reqsig-name"
                value={details.recipientName}
                onChange={(e) => setDetail("recipientName", e.target.value)}
                autoComplete="off"
                maxLength={80}
                aria-required="true"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="reqsig-email" className="text-sm">
                {t("reqsig.recipientEmail")}
              </Label>
              <Input
                id="reqsig-email"
                type="email"
                value={details.recipientEmail}
                onChange={(e) => setDetail("recipientEmail", e.target.value)}
                autoComplete="off"
                maxLength={120}
                aria-invalid={emailBad || undefined}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t("reqsig.recipientEmailHint")}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="reqsig-sender" className="text-sm">
                {t("reqsig.senderName")}
              </Label>
              <Input
                id="reqsig-sender"
                value={details.senderName}
                onChange={(e) => setDetail("senderName", e.target.value)}
                autoComplete="off"
                maxLength={80}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="reqsig-due" className="text-sm">
                {t("reqsig.dueDateLabel")}
              </Label>
              <Input
                id="reqsig-due"
                type="date"
                value={details.dueDate}
                onChange={(e) => setDetail("dueDate", e.target.value)}
              />
              {details.dueDate !== "" ? (
                <p className="text-[11px] text-muted-foreground">
                  {formatDueDate(details.dueDate)}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="reqsig-subject" className="text-sm">
                {t("reqsig.subjectLabel")}
              </Label>
              <Input
                id="reqsig-subject"
                value={details.subject}
                onChange={(e) => setDetail("subject", e.target.value)}
                placeholder={t("reqsig.subjectPlaceholder")}
                maxLength={120}
              />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="reqsig-message" className="text-sm">
                {t("reqsig.messageLabel")}
              </Label>
              <Textarea
                id="reqsig-message"
                value={details.message}
                onChange={(e) => setDetail("message", e.target.value)}
                placeholder={t("reqsig.messagePlaceholder")}
                rows={4}
                maxLength={1200}
                className="resize-y"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              type="button"
              className="rounded-btn"
              disabled={nameMissing}
              onClick={() => setStep(2)}
            >
              {t("reqsig.continueBtn")}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </section>
      ) : (
        /* --- step 2: spot placement ------------------------------------ */
        <>
          <section
            className="overflow-hidden rounded-card border border-border bg-card"
            aria-labelledby="reqsig-place-title"
          >
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <MousePointerClick
                  className="size-4 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <h2 id="reqsig-place-title" className="text-sm font-semibold text-foreground">
                    {t("reqsig.placementTitle")}
                  </h2>
                  <p className="text-[11px] text-muted-foreground">
                    {t("reqsig.placementSubtitle")}
                  </p>
                </div>
              </div>
              <span className="rounded-chip border border-border bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                {t("reqsig.spotsCount", { count: spots.length })}
              </span>
            </header>

            <div className="flex flex-col items-center gap-3 px-4 py-4">
              {current !== null ? (
                <div
                  className="relative w-fit cursor-crosshair select-none"
                  onClick={addSpot}
                  role="application"
                  aria-label={t("reqsig.placeHint")}
                >
                  <canvas
                    ref={canvasRef}
                    className="block h-auto max-h-[62vh] w-auto max-w-full rounded-md border border-border/60 shadow-sm"
                  />
                  {/* Placed spots — percent-positioned, the exact geometry
                      the worker draws (center + fixed display box). */}
                  {spots.map((spot, i) =>
                    spot.page === selectedPage ? (
                      <div
                        key={`${i}-${spot.x.toFixed(3)}-${spot.y.toFixed(3)}`}
                        className="pointer-events-none absolute rounded-sm border-2 border-dashed border-amber-600 bg-amber-500/10"
                        style={{
                          left: `${(spot.x - SPOT_W_PCT / 2) * 100}%`,
                          top: `${(spot.y - SPOT_H_PCT / 2) * 100}%`,
                          width: `${SPOT_W_PCT * 100}%`,
                          height: `${SPOT_H_PCT * 100}%`,
                        }}
                        aria-hidden="true"
                      >
                        <span className="absolute left-1 top-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-400">
                          {i + 1}
                        </span>
                      </div>
                    ) : null
                  )}
                </div>
              ) : (
                <div
                  className="flex h-72 w-52 items-center justify-center rounded-md border border-dashed border-border"
                  role="status"
                >
                  {previewError ? (
                    <TriangleAlert
                      className="size-5 text-amber-600 dark:text-amber-400"
                      aria-hidden="true"
                    />
                  ) : (
                    <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
                  )}
                </div>
              )}
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t("reqsig.placeHint")}
              </p>
            </div>
          </section>

          <PreviewPageStrip
            file={file}
            pageCount={pageCount}
            selected={selectedPage}
            onSelect={setSelectedPage}
            markedSet={spotPages}
          />

          {/* --- spot list ------------------------------------------------ */}
          <section className="rounded-card border border-border bg-card">
            <p className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-4 py-2.5 text-xs font-semibold text-foreground">
              <span>{t("reqsig.spotsTitle")}</span>
              <span className="font-normal text-muted-foreground">
                {t("reqsig.pageOf", { n: selectedPage + 1 })}
              </span>
            </p>
            {spots.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                {t("reqsig.noSpots")}
              </p>
            ) : (
              <ul className="max-h-64 divide-y divide-border/60 overflow-y-auto scrollbar-thin">
                {spots.map((spot, i) => (
                  <li
                    key={`${i}-${spot.page}-${spot.x.toFixed(3)}-${spot.y.toFixed(3)}`}
                    className="flex min-h-11 items-center gap-3 px-4 py-2"
                  >
                    <span
                      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-[11px] font-bold text-amber-700 dark:text-amber-400"
                      aria-hidden="true"
                    >
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 text-sm text-foreground">
                      {t("reqsig.pageOf", { n: spot.page + 1 })}
                      <span className="ml-2 text-muted-foreground">
                        {Math.round(spot.x * 100)}% {t("reqsig.whereLeft")} ·{" "}
                        {Math.round(spot.y * 100)}% {t("reqsig.whereTop")}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 shrink-0 rounded-btn px-2 text-muted-foreground hover:text-destructive"
                      onClick={() => removeSpot(i)}
                      aria-label={t("reqsig.removeSpot")}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* --- send it yourself (the honest mailto card) ---------------- */}
          <section className="rounded-card border border-border bg-card p-5">
            <div className="flex flex-wrap items-start gap-3">
              <span
                className="flex size-10 shrink-0 items-center justify-center rounded-btn bg-cat-security/10 text-cat-security"
                aria-hidden="true"
              >
                <Mail className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold text-foreground">
                  {t("reqsig.sendTitle")}
                </h2>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {t("reqsig.sendBody")}
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {mailHref !== "" ? (
                <Button
                  type="button"
                  className="rounded-btn"
                  onClick={() => {
                    window.location.href = mailHref;
                  }}
                >
                  <Mail className="size-4" aria-hidden="true" />
                  {t("reqsig.openMail")}
                </Button>
              ) : (
                <p className="flex items-center gap-1.5 rounded-btn border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground">
                  <X className="size-3.5 shrink-0" aria-hidden="true" />
                  {t("reqsig.mailNoEmail")}
                </p>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 rounded-btn text-muted-foreground"
                onClick={() => setStep(1)}
              >
                {t("reqsig.backBtn")}
              </Button>
            </div>
            <p className="mt-3 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
              {t("reqsig.privacyLine")}
            </p>
          </section>
        </>
      )}
    </div>
  );
}
