"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  Check,
  Copy,
  Download,
  FileDown,
  ImageDown,
  Link2,
  Loader2,
  MessageCircle,
  Minus,
  Phone,
  Plus,
  QrCode as QrIcon,
  TriangleAlert,
  Type,
  Wifi,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { downloadBlob, sanitizeFileName } from "@/lib/files/output";
import { cn } from "@/lib/utils";
import {
  AtSign,
  Contact,
  IndianRupee,
  Mail,
} from "lucide-react";
import {
  DEFAULT_MARGIN,
  DEFAULT_SIZE,
  EC_INFO,
  EC_LEVELS,
  MAX_MARGIN,
  MAX_TEXT_LENGTH,
  MIN_MARGIN,
  MIN_SCAN_CONTRAST,
  QR_KINDS,
  QR_SIZES,
  clampMargin,
  contrastRatio,
  ecFor,
  isEcLevel,
  normalizeQrColor,
  normalizeUrl,
  buildEmailPayload,
  buildTextPayload,
  buildVcardPayload,
  buildWifiPayload,
  buildWhatsappPayload,
  buildPhonePayload,
  buildUpiPayload,
  qrFileName,
  type EcLevel,
  type EmailInput,
  type QrKind,
  type QrSize,
  type UpiInput,
  type VcardInput,
  type WifiInput,
  type WhatsappInput,
} from "./engine";

/**
 * Generate QR code surface (PRD §7.7 / §8.7) — the entire product.
 *
 * Eight payload kinds with per-kind forms, a live preview that re-renders
 * debounced as you type, style controls (colors, quiet zone, error
 * correction, center logo) and direct PNG/SVG/PDF downloads. No files, no
 * run phase, zero network — the shell passes an empty file list.
 *
 * State updates follow the codebase rules: form controls write from event
 * handlers only; the ONE effect-driven write is the async preview render
 * inside its promise callback (the thumbnail pattern).
 */

/* ------------------------------ state ------------------------------ */

interface QrFormState {
  kind: QrKind;
  url: string;
  text: string;
  wifi: WifiInput;
  upi: UpiInput;
  vcard: VcardInput;
  email: EmailInput;
  phone: string;
  whatsapp: WhatsappInput;
  fg: string;
  bg: string;
  size: QrSize;
  margin: number;
  ec: EcLevel;
  logoDataUrl: string | null;
  logoName: string;
}

const INITIAL_STATE: QrFormState = {
  kind: "url",
  url: "",
  text: "",
  wifi: { ssid: "", password: "", encryption: "WPA", hidden: false },
  upi: { pa: "", pn: "", am: "", tn: "" },
  vcard: { first: "", last: "", org: "", phone: "", email: "", url: "", address: "", note: "" },
  email: { address: "", subject: "", body: "" },
  phone: "",
  whatsapp: { phone: "", message: "" },
  fg: "#000000",
  bg: "#ffffff",
  size: DEFAULT_SIZE,
  margin: DEFAULT_MARGIN,
  ec: "M",
  logoDataUrl: null,
  logoName: "",
};

const KIND_ICONS: Record<QrKind, typeof Link2> = {
  url: Link2,
  text: Type,
  wifi: Wifi,
  upi: IndianRupee,
  vcard: Contact,
  email: Mail,
  phone: Phone,
  whatsapp: MessageCircle,
};

const KIND_LABEL_KEYS: Record<QrKind, string> = {
  url: "qr.kindUrl",
  text: "qr.kindText",
  wifi: "qr.kindWifi",
  upi: "qr.kindUpi",
  vcard: "qr.kindVcard",
  email: "qr.kindEmail",
  phone: "qr.kindPhone",
  whatsapp: "qr.kindWhatsapp",
};

/* --------------------------- render helpers --------------------------- */

interface RenderOptions {
  dark: string;
  light: string;
  margin: number;
  ec: EcLevel;
  width: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image-load-failed"));
    img.src = src;
  });
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * PNG bytes for a QR at `size` px, optionally composited with the center
 * logo (white rounded pad + contained image). The qrcode lib renders the
 * matrix; the logo pass happens on a canvas afterwards.
 */
async function composeQrPng(
  payload: string,
  options: RenderOptions,
  logoDataUrl: string | null
): Promise<Blob> {
  const dataUrl = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: options.ec,
    margin: options.margin,
    width: options.width,
    color: { dark: options.dark, light: options.light },
  });
  const base = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.width;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas-2d-unavailable");
  ctx.drawImage(base, 0, 0, options.width, options.width);
  if (logoDataUrl) {
    const logo = await loadImage(logoDataUrl);
    const pad = Math.round(options.width * 0.24);
    const inner = Math.round(options.width * 0.17);
    ctx.fillStyle = options.light;
    roundRectPath(
      ctx,
      (options.width - pad) / 2,
      (options.width - pad) / 2,
      pad,
      pad,
      pad * 0.18
    );
    ctx.fill();
    const ratio = Math.min(inner / logo.width, inner / logo.height);
    const w = logo.width * ratio;
    const h = logo.height * ratio;
    ctx.drawImage(
      logo,
      (options.width - w) / 2,
      (options.width - h) / 2,
      w,
      h
    );
  }
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("png-encode-failed"))),
      "image/png"
    );
  });
}

/* ------------------------------ surface ------------------------------ */

export function GenerateQrSurface(_props: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const { toast } = useToast();
  const [state, setState] = useState<QrFormState>(INITIAL_STATE);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  /** Always mirrors previewUrl for unmount revocation (updaters stay pure). */
  const previewUrlRef = useRef<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(true);
  const [copied, setCopied] = useState(false);
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  /* ---- derived: payload + why it might be blocked ---- */

  const payload = useMemo<string | null>(() => {
    switch (state.kind) {
      case "url":
        return normalizeUrl(state.url);
      case "text":
        return buildTextPayload(state.text);
      case "wifi":
        return buildWifiPayload(state.wifi);
      case "upi":
        return buildUpiPayload(state.upi);
      case "vcard":
        return buildVcardPayload(state.vcard);
      case "email":
        return buildEmailPayload(state.email);
      case "phone":
        return buildPhonePayload(state.phone);
      case "whatsapp":
        return buildWhatsappPayload(state.whatsapp);
    }
  }, [state]);

  const fgNorm = normalizeQrColor(state.fg);
  const bgNorm = normalizeQrColor(state.bg);
  const colorsValid = fgNorm !== null && bgNorm !== null && fgNorm !== bgNorm;
  const contrast = colorsValid ? contrastRatio(fgNorm!, bgNorm!) : 0;
  const lowContrast = colorsValid && contrast < MIN_SCAN_CONTRAST;
  const effectiveEc = ecFor(state.logoDataUrl !== null, state.ec);
  const clampedMargin = clampMargin(state.margin);

  const blockedKey = !colorsValid
    ? "qr.badColors"
    : payload === null
      ? "qr.incomplete"
      : null;

  /* ---- live preview (debounced; writes inside promise callbacks) ----
   * The preview renders through the SAME compose path as the downloads
   * (canvas composite incl. the center logo) so it is WYSIWYG. */

  useEffect(() => {
    if (payload === null || fgNorm === null || bgNorm === null) {
      setPreviewBusy(false);
      return;
    }
    setPreviewBusy(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      composeQrPng(
        payload,
        {
          dark: fgNorm,
          light: bgNorm,
          margin: clampedMargin,
          ec: effectiveEc,
          width: Math.min(state.size, 512),
        },
        state.logoDataUrl
      )
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          const previous = previewUrlRef.current;
          previewUrlRef.current = url;
          if (previous) URL.revokeObjectURL(previous);
          setPreviewUrl(url);
          setPreviewBusy(false);
        })
        .catch(() => {
          if (cancelled) return;
          setPreviewBusy(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [payload, fgNorm, bgNorm, clampedMargin, effectiveEc, state.size, state.logoDataUrl]);

  // Revoke the preview object URL on unmount (ref, not an updater).
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    };
  }, []);

  /* ---- form helpers (event-handler state writes only) ---- */

  const patch = useCallback(
    (partial: Partial<QrFormState>): void => {
      setState((prev) => ({ ...prev, ...partial }));
    },
    []
  );

  const copyPayload = useCallback(async (): Promise<void> => {
    if (payload === null) return;
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: t("qr.copyFailed"),
        variant: "destructive",
      });
    }
  }, [payload, t, toast]);

  const onLogoChange = useCallback(
    (file: File | undefined): void => {
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        toast({ title: t("qr.logoNotImage"), variant: "destructive" });
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        toast({ title: t("qr.logoTooBig"), variant: "destructive" });
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setState((prev) => ({
          ...prev,
          logoDataUrl: typeof reader.result === "string" ? reader.result : null,
          logoName: file.name,
        }));
      };
      reader.readAsDataURL(file);
    },
    [t, toast]
  );

  const removeLogo = useCallback((): void => {
    setState((prev) => ({ ...prev, logoDataUrl: null, logoName: "" }));
    if (logoInputRef.current) logoInputRef.current.value = "";
  }, []);

  /* ---- downloads ---- */

  const baseRenderOptions = useMemo<RenderOptions>(
    () => ({
      dark: fgNorm ?? "#000000",
      light: bgNorm ?? "#ffffff",
      margin: clampedMargin,
      ec: effectiveEc,
      width: state.size,
    }),
    [fgNorm, bgNorm, clampedMargin, effectiveEc, state.size]
  );

  const downloadPng = useCallback(async (): Promise<void> => {
    if (payload === null) return;
    const blob = await composeQrPng(payload, baseRenderOptions, state.logoDataUrl);
    downloadBlob(blob, sanitizeFileName(qrFileName(state.kind, "png"), "png"));
  }, [payload, baseRenderOptions, state.logoDataUrl, state.kind]);

  const downloadSvg = useCallback(async (): Promise<void> => {
    if (payload === null) return;
    const svg = await QRCode.toString(payload, {
      type: "svg",
      errorCorrectionLevel: effectiveEc,
      margin: clampedMargin,
      color: { dark: baseRenderOptions.dark, light: baseRenderOptions.light },
    });
    downloadBlob(
      new Blob([svg], { type: "image/svg+xml" }),
      sanitizeFileName(qrFileName(state.kind, "svg"), "svg")
    );
  }, [payload, effectiveEc, clampedMargin, baseRenderOptions, state.kind]);

  const downloadPdf = useCallback(async (): Promise<void> => {
    if (payload === null) return;
    const { PDFDocument } = await import("pdf-lib");
    const png = await composeQrPng(payload, baseRenderOptions, state.logoDataUrl);
    const doc = await PDFDocument.create();
    const embedded = await doc.embedPng(await png.arrayBuffer());
    // 1 px → 1 pt: the page is exactly the QR (quiet zone included).
    const page = doc.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: embedded.width,
      height: embedded.height,
    });
    const bytes = await doc.save();
    downloadBlob(
      new Blob([bytes as unknown as BlobPart], { type: "application/pdf" }),
      sanitizeFileName(qrFileName(state.kind, "pdf"), "pdf")
    );
  }, [payload, baseRenderOptions, state.logoDataUrl, state.kind]);

  /* ------------------------------ render ------------------------------ */

  return (
    <section
      aria-label={t("qr.surfaceLabel")}
      className="flex flex-col gap-6"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* LEFT: kind + form */}
        <div className="flex flex-col gap-4">
          <div>
            <span id="qr-kind-label" className="text-xs font-medium text-foreground">
              {t("qr.kindLabel")}
            </span>
            <div
              role="radiogroup"
              aria-labelledby="qr-kind-label"
              className="mt-2 grid grid-cols-4 gap-2"
            >
              {QR_KINDS.map((kind) => {
                const Icon = KIND_ICONS[kind];
                const active = state.kind === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => patch({ kind })}
                    className={cn(
                      "flex min-h-11 flex-col items-center justify-center gap-1 rounded-btn border px-1 py-2 text-[11px] font-medium outline-none transition-colors",
                      "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      active
                        ? "border-primary/60 bg-primary/10 text-primary"
                        : "border-border bg-card text-muted-foreground hover:border-primary/30 hover:text-foreground"
                    )}
                  >
                    <Icon className="size-4" aria-hidden="true" />
                    {t(KIND_LABEL_KEYS[kind])}
                  </button>
                );
              })}
            </div>
          </div>

          <QrKindForm state={state} patch={patch} />
        </div>

        {/* RIGHT: preview + payload */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col items-center gap-3 rounded-card border border-border bg-card p-5">
            <div
              className="relative flex aspect-square w-full max-w-[280px] items-center justify-center overflow-hidden rounded-card border border-border bg-muted/30"
              aria-live="polite"
            >
              {previewUrl !== null && payload !== null ? (
                <img
                  src={previewUrl}
                  alt={t("qr.previewAlt")}
                  className={cn(
                    "size-full bg-card object-contain p-2 transition-opacity duration-200",
                    previewBusy ? "opacity-50" : "opacity-100"
                  )}
                />
              ) : (
                <div className="flex flex-col items-center gap-2 p-6 text-center">
                  <QrIcon className="size-8 text-muted-foreground/50" aria-hidden="true" />
                  <p className="text-xs text-muted-foreground">
                    {blockedKey !== null ? t(blockedKey) : t("qr.rendering")}
                  </p>
                </div>
              )}
              {previewBusy && payload !== null ? (
                <span className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-btn bg-background/85 backdrop-blur">
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
                </span>
              ) : null}
            </div>

            {/* Payload echo — exactly what will be encoded */}
            {payload !== null ? (
              <p className="w-full break-all rounded-card bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {payload.length > 220
                  ? `${payload.slice(0, 220)}…`
                  : payload}
              </p>
            ) : null}

            {payload !== null ? (
              <Button
                type="button"
                variant="outline"
                className="h-11 min-h-11 w-full max-w-[280px] rounded-btn text-xs font-medium"
                onClick={() => void copyPayload()}
                aria-label={t("qr.copyPayload")}
              >
                {copied ? (
                  <Check className="size-4" aria-hidden="true" />
                ) : (
                  <Copy className="size-4" aria-hidden="true" />
                )}
                {copied ? t("qr.copied") : t("qr.copyPayload")}
              </Button>
            ) : null}
          </div>

          {lowContrast ? (
            <p className="flex items-start gap-2 rounded-card border border-amber-300/60 bg-amber-500/10 px-4 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-400" role="status">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t("qr.lowContrast", { ratio: contrast.toFixed(1) })}
            </p>
          ) : null}
          {state.logoDataUrl !== null ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("qr.logoNotes")}
            </p>
          ) : null}
        </div>
      </div>

      {/* Style controls */}
      <QrStylePanel
        state={state}
        patch={patch}
        fgNorm={fgNorm}
        bgNorm={bgNorm}
        effectiveEc={effectiveEc}
        onLogoChange={onLogoChange}
        removeLogo={removeLogo}
        logoInputRef={logoInputRef}
      />

      {/* Downloads */}
      <div className="flex flex-col gap-2 rounded-card border border-border bg-card p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("qr.downloadLabel")}
        </h3>
        <div className="grid gap-2 sm:grid-cols-3">
          <Button
            type="button"
            className="h-12 min-h-12 rounded-btn text-sm font-semibold"
            disabled={blockedKey !== null}
            onClick={() => void downloadPng()}
          >
            <ImageDown className="size-4" aria-hidden="true" />
            {t("qr.downloadPng", { size: state.size })}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-12 min-h-12 rounded-btn text-sm font-semibold"
            disabled={blockedKey !== null}
            onClick={() => void downloadSvg()}
          >
            <Download className="size-4" aria-hidden="true" />
            {t("qr.downloadSvg")}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-12 min-h-12 rounded-btn text-sm font-semibold"
            disabled={blockedKey !== null}
            onClick={() => void downloadPdf()}
          >
            <FileDown className="size-4" aria-hidden="true" />
            {t("qr.downloadPdf")}
          </Button>
        </div>
        {blockedKey !== null ? (
          <p className="text-[11px] text-muted-foreground">{t(blockedKey)}</p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {t("qr.privacyNote")}
          </p>
        )}
      </div>
    </section>
  );
}

export default GenerateQrSurface;

/* --------------------------- kind forms --------------------------- */

interface KindFormProps {
  state: QrFormState;
  patch: (partial: Partial<QrFormState>) => void;
}

function QrKindForm({ state, patch }: KindFormProps): React.JSX.Element {
  const { t } = useI18n();

  switch (state.kind) {
    case "url":
      return (
        <Field label={t("qr.urlLabel")} hint={t("qr.urlHint")}>
          <Input
            value={state.url}
            onChange={(e) => patch({ url: e.target.value })}
            placeholder="https://example.com"
            inputMode="url"
            aria-label={t("qr.urlLabel")}
            className="h-11 min-h-11 rounded-btn"
          />
        </Field>
      );
    case "text":
      return (
        <Field
          label={t("qr.textLabel")}
          hint={t("qr.textHint", { count: MAX_TEXT_LENGTH })}
        >
          <Textarea
            value={state.text}
            onChange={(e) => patch({ text: e.target.value })}
            placeholder={t("qr.textPlaceholder")}
            aria-label={t("qr.textLabel")}
            maxLength={MAX_TEXT_LENGTH}
            className="min-h-28 rounded-btn"
          />
          <p className="text-[11px] tabular-nums text-muted-foreground" aria-live="polite">
            {t("qr.charCount", {
              count: state.text.length,
              max: MAX_TEXT_LENGTH,
            })}
          </p>
        </Field>
      );
    case "wifi":
      return (
        <>
          <Field label={t("qr.ssidLabel")}>
            <Input
              value={state.wifi.ssid}
              onChange={(e) =>
                patch({ wifi: { ...state.wifi, ssid: e.target.value } })
              }
              placeholder="HomeWiFi"
              aria-label={t("qr.ssidLabel")}
              className="h-11 min-h-11 rounded-btn"
            />
          </Field>
          {state.wifi.encryption !== "nopass" ? (
            <Field label={t("qr.wifiPasswordLabel")}>
              <Input
                type="password"
                value={state.wifi.password}
                onChange={(e) =>
                  patch({ wifi: { ...state.wifi, password: e.target.value } })
                }
                aria-label={t("qr.wifiPasswordLabel")}
                className="h-11 min-h-11 rounded-btn"
              />
            </Field>
          ) : null}
          <Field label={t("qr.encryptionLabel")}>
            <Select
              value={state.wifi.encryption}
              onValueChange={(value) =>
                patch({
                  wifi: {
                    ...state.wifi,
                    encryption:
                      value === "WEP" || value === "nopass" ? value : "WPA",
                  },
                })
              }
            >
              <SelectTrigger
                aria-label={t("qr.encryptionLabel")}
                className="h-11 min-h-11 w-full rounded-btn"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="WPA">WPA / WPA2 / WPA3</SelectItem>
                <SelectItem value="WEP">WEP</SelectItem>
                <SelectItem value="nopass">{t("qr.openNetwork")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="flex items-center justify-between gap-3 rounded-card border border-border bg-card p-3">
            <Label className="text-xs font-medium text-foreground">
              {t("qr.hiddenNetwork")}
            </Label>
            <Switch
              checked={state.wifi.hidden}
              onCheckedChange={(checked) =>
                patch({ wifi: { ...state.wifi, hidden: checked } })
              }
              aria-label={t("qr.hiddenNetwork")}
            />
          </div>
        </>
      );
    case "upi":
      return (
        <>
          <Field label={t("qr.upiIdLabel")} hint={t("qr.upiIdHint")}>
            <Input
              value={state.upi.pa}
              onChange={(e) => patch({ upi: { ...state.upi, pa: e.target.value } })}
              placeholder="name@bank"
              inputMode="email"
              aria-label={t("qr.upiIdLabel")}
              className="h-11 min-h-11 rounded-btn"
            />
          </Field>
          <Field label={t("qr.payeeNameLabel")}>
            <Input
              value={state.upi.pn}
              onChange={(e) => patch({ upi: { ...state.upi, pn: e.target.value } })}
              placeholder={t("qr.payeeNamePlaceholder")}
              aria-label={t("qr.payeeNameLabel")}
              className="h-11 min-h-11 rounded-btn"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("qr.amountLabel")}>
              <Input
                value={state.upi.am}
                onChange={(e) => patch({ upi: { ...state.upi, am: e.target.value } })}
                placeholder="100.00"
                inputMode="decimal"
                aria-label={t("qr.amountLabel")}
                className="h-11 min-h-11 rounded-btn"
              />
            </Field>
            <Field label={t("qr.noteLabel")}>
              <Input
                value={state.upi.tn}
                onChange={(e) => patch({ upi: { ...state.upi, tn: e.target.value } })}
                placeholder={t("qr.notePlaceholder")}
                aria-label={t("qr.noteLabel")}
                className="h-11 min-h-11 rounded-btn"
              />
            </Field>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("qr.upiNote")}
          </p>
        </>
      );
    case "vcard":
      return (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("qr.firstNameLabel")}>
              <Input
                value={state.vcard.first}
                onChange={(e) =>
                  patch({ vcard: { ...state.vcard, first: e.target.value } })
                }
                aria-label={t("qr.firstNameLabel")}
                className="h-11 min-h-11 rounded-btn"
              />
            </Field>
            <Field label={t("qr.lastNameLabel")}>
              <Input
                value={state.vcard.last}
                onChange={(e) =>
                  patch({ vcard: { ...state.vcard, last: e.target.value } })
                }
                aria-label={t("qr.lastNameLabel")}
                className="h-11 min-h-11 rounded-btn"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("qr.phoneLabel")}>
              <Input
                value={state.vcard.phone}
                onChange={(e) =>
                  patch({ vcard: { ...state.vcard, phone: e.target.value } })
                }
                placeholder="+91…"
                inputMode="tel"
                aria-label={t("qr.phoneLabel")}
                className="h-11 min-h-11 rounded-btn"
              />
            </Field>
            <Field label={t("qr.emailLabel")}>
              <Input
                value={state.vcard.email}
                onChange={(e) =>
                  patch({ vcard: { ...state.vcard, email: e.target.value } })
                }
                inputMode="email"
                aria-label={t("qr.emailLabel")}
                className="h-11 min-h-11 rounded-btn"
              />
            </Field>
          </div>
          <Field label={t("qr.orgLabel")}>
            <Input
              value={state.vcard.org}
              onChange={(e) =>
                patch({ vcard: { ...state.vcard, org: e.target.value } })
              }
              aria-label={t("qr.orgLabel")}
              className="h-11 min-h-11 rounded-btn"
            />
          </Field>
          <Field label={t("qr.addressLabel")}>
            <Input
              value={state.vcard.address}
              onChange={(e) =>
                patch({ vcard: { ...state.vcard, address: e.target.value } })
              }
              aria-label={t("qr.addressLabel")}
              className="h-11 min-h-11 rounded-btn"
            />
          </Field>
          <Field label={t("qr.noteLabel")}>
            <Textarea
              value={state.vcard.note}
              onChange={(e) =>
                patch({ vcard: { ...state.vcard, note: e.target.value } })
              }
              aria-label={t("qr.noteLabel")}
              className="min-h-20 rounded-btn"
            />
          </Field>
        </>
      );
    case "email":
      return (
        <>
          <Field label={t("qr.emailAddressLabel")}>
            <Input
              value={state.email.address}
              onChange={(e) =>
                patch({ email: { ...state.email, address: e.target.value } })
              }
              placeholder="hello@example.com"
              inputMode="email"
              aria-label={t("qr.emailAddressLabel")}
              className="h-11 min-h-11 rounded-btn"
            />
          </Field>
          <Field label={t("qr.subjectLabel")}>
            <Input
              value={state.email.subject}
              onChange={(e) =>
                patch({ email: { ...state.email, subject: e.target.value } })
              }
              aria-label={t("qr.subjectLabel")}
              className="h-11 min-h-11 rounded-btn"
            />
          </Field>
          <Field label={t("qr.bodyLabel")}>
            <Textarea
              value={state.email.body}
              onChange={(e) =>
                patch({ email: { ...state.email, body: e.target.value } })
              }
              aria-label={t("qr.bodyLabel")}
              className="min-h-24 rounded-btn"
            />
          </Field>
        </>
      );
    case "phone":
      return (
        <Field label={t("qr.phoneInputLabel")} hint={t("qr.phoneInputHint")}>
          <Input
            value={state.phone}
            onChange={(e) => patch({ phone: e.target.value })}
            placeholder="+91 98765 43210"
            inputMode="tel"
            aria-label={t("qr.phoneInputLabel")}
            className="h-11 min-h-11 rounded-btn"
          />
        </Field>
      );
    case "whatsapp":
      return (
        <>
          <Field label={t("qr.waPhoneLabel")} hint={t("qr.waPhoneHint")}>
            <Input
              value={state.whatsapp.phone}
              onChange={(e) =>
                patch({ whatsapp: { ...state.whatsapp, phone: e.target.value } })
              }
              placeholder="+91 98765 43210"
              inputMode="tel"
              aria-label={t("qr.waPhoneLabel")}
              className="h-11 min-h-11 rounded-btn"
            />
          </Field>
          <Field label={t("qr.waMessageLabel")}>
            <Textarea
              value={state.whatsapp.message}
              onChange={(e) =>
                patch({
                  whatsapp: { ...state.whatsapp, message: e.target.value },
                })
              }
              placeholder={t("qr.waMessagePlaceholder")}
              aria-label={t("qr.waMessageLabel")}
              className="min-h-24 rounded-btn"
            />
          </Field>
        </>
      );
  }
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium text-foreground">{label}</Label>
      {children}
      {hint ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/* --------------------------- style panel --------------------------- */

interface StylePanelProps {
  state: QrFormState;
  patch: (partial: Partial<QrFormState>) => void;
  fgNorm: string | null;
  bgNorm: string | null;
  effectiveEc: EcLevel;
  onLogoChange: (file: File | undefined) => void;
  removeLogo: () => void;
  logoInputRef: React.RefObject<HTMLInputElement | null>;
}

function QrStylePanel({
  state,
  patch,
  fgNorm,
  bgNorm,
  effectiveEc,
  onLogoChange,
  removeLogo,
  logoInputRef,
}: StylePanelProps): React.JSX.Element {
  const { t } = useI18n();
  const hasLogo = state.logoDataUrl !== null;

  return (
    <div className="grid gap-4 rounded-card border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
      {/* Colors */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-foreground">
          {t("qr.colorsLabel")}
        </span>
        <div className="flex items-center gap-2">
          <ColorControl
            label={t("qr.fgLabel")}
            value={state.fg}
            valid={fgNorm !== null}
            onChange={(value) => patch({ fg: value })}
          />
          <ColorControl
            label={t("qr.bgLabel")}
            value={state.bg}
            valid={bgNorm !== null}
            onChange={(value) => patch({ bg: value })}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESET_PAIRS.map(([fg, bg]) => (
            <button
              key={fg + bg}
              type="button"
              onClick={() => patch({ fg, bg })}
              aria-label={t("qr.presetLabel", { fg, bg })}
              className="flex size-7 items-center justify-center overflow-hidden rounded-btn border border-border outline-none transition-transform hover:scale-110 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <span className="block size-full" style={{ background: bg }}>
                <span
                  className="m-[5px] block size-[calc(100%-10px)] rounded-[2px]"
                  style={{ background: fg }}
                />
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Size */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-foreground">
          {t("qr.sizeLabel")}
        </span>
        <ToggleGroup
          type="single"
          value={String(state.size)}
          onValueChange={(value) => {
            const size = Number(value);
            if ((QR_SIZES as readonly number[]).includes(size)) {
              patch({ size: size as QrSize });
            }
          }}
          className="gap-1"
          aria-label={t("qr.sizeLabel")}
        >
          {QR_SIZES.map((size) => (
            <ToggleGroupItem
              key={size}
              value={String(size)}
              className="min-h-9 rounded-btn px-3 text-xs"
            >
              {size}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("qr.sizeHint")}
        </p>
      </div>

      {/* Margin + EC */}
      <div className="flex flex-col gap-2">
        <span className="flex items-center gap-1 text-xs font-medium text-foreground">
          {t("qr.marginLabel")}
          <span className="rounded-chip bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
            {clampMargin(state.margin)}
          </span>
        </span>
        <div className="flex items-center gap-1.5 px-0.5">
          <Minus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Slider
            value={[state.margin]}
            min={MIN_MARGIN}
            max={MAX_MARGIN}
            step={1}
            onValueChange={([value]) => patch({ margin: value })}
            aria-label={t("qr.marginLabel")}
            className="flex-1"
          />
          <Plus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </div>
        <span className="mt-1 text-xs font-medium text-foreground">
          {t("qr.ecLabel")}
        </span>
        <ToggleGroup
          type="single"
          value={state.ec}
          onValueChange={(value) => {
            if (isEcLevel(value)) patch({ ec: value });
          }}
          className="gap-1"
          aria-label={t("qr.ecLabel")}
        >
          {EC_LEVELS.map((level) => (
            <ToggleGroupItem
              key={level}
              value={level}
              aria-label={t("qr.ecLevel", {
                level,
                recover: EC_INFO[level].recover,
              })}
              className="min-h-9 rounded-btn px-2.5 text-xs"
            >
              {level}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {hasLogo
            ? t("qr.ecForcedH")
            : t("qr.ecHint", { recover: EC_INFO[effectiveEc].recover })}
        </p>
      </div>

      {/* Logo */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-foreground">
          {t("qr.logoLabel")}
        </span>
        <input
          ref={logoInputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          aria-label={t("qr.logoUpload")}
          onChange={(e) => {
            onLogoChange(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {hasLogo ? (
          <div className="flex items-center gap-2 rounded-btn border border-border bg-muted/30 p-2">
            <img
              src={state.logoDataUrl ?? ""}
              alt={t("qr.logoAlt")}
              className="size-9 rounded-btn border border-border bg-card object-contain p-0.5"
            />
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
              {state.logoName}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 rounded-btn"
              onClick={removeLogo}
              aria-label={t("qr.removeLogo")}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="h-11 min-h-11 rounded-btn text-xs font-medium"
            onClick={() => logoInputRef.current?.click()}
          >
            <AtSign className="size-4" aria-hidden="true" />
            {t("qr.logoUpload")}
          </Button>
        )}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("qr.logoHint")}
        </p>
      </div>
    </div>
  );
}

const PRESET_PAIRS: ReadonlyArray<[string, string]> = [
  ["#000000", "#ffffff"],
  ["#0f766e", "#ffffff"],
  ["#7c2d12", "#fef3c7"],
  ["#1e293b", "#e2e8f0"],
];

function ColorControl({
  label,
  value,
  valid,
  onChange,
}: {
  label: string;
  value: string;
  valid: boolean;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          type="color"
          value={valid ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          className="size-9 shrink-0 cursor-pointer rounded-btn border border-border bg-card p-0.5"
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          className={cn(
            "h-9 min-h-9 rounded-btn font-mono text-xs",
            !valid && "border-destructive focus-visible:ring-destructive/30"
          )}
        />
      </span>
    </label>
  );
}
