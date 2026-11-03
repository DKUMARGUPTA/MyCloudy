"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
} from "react";
import jsQR from "jsqr";
import {
  Check,
  Copy,
  ExternalLink,
  ImagePlus,
  Loader2,
  QrCode as QrIcon,
  ScanBarcode,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { cn } from "@/lib/utils";
import { parseQrPayload, type ScanParsed } from "./engine";

/**
 * Scan QR code surface — the entire product.
 *
 * An embedded drop zone accepts an image, draws it to a canvas and runs
 * jsQR on the pixels (attemptBoth inversion for white-on-black codes).
 * The decoded payload is explained via the pure engine (WiFi/UPI/vCard/
 * links → labelled fields) with copy + explicit open-link actions.
 * Nothing is uploaded; the image lives in the page only.
 */

const FIELD_LABEL_KEYS: Record<string, string> = {
  ssid: "scanqr.fieldSsid",
  security: "scanqr.fieldSecurity",
  password: "scanqr.fieldPassword",
  hidden: "scanqr.fieldHidden",
  name: "scanqr.fieldName",
  org: "scanqr.fieldOrg",
  phone: "scanqr.fieldPhone",
  email: "scanqr.fieldEmail",
  website: "scanqr.fieldWebsite",
  upiId: "scanqr.fieldUpiId",
  payee: "scanqr.fieldPayee",
  amount: "scanqr.fieldAmount",
  note: "scanqr.fieldNote",
  to: "scanqr.fieldTo",
  subject: "scanqr.fieldSubject",
  body: "scanqr.fieldBody",
  message: "scanqr.fieldMessage",
  lat: "scanqr.fieldLat",
  lon: "scanqr.fieldLon",
  raw: "scanqr.fieldRaw",
};

const KIND_LABEL_KEYS: Record<ScanParsed["kind"], string> = {
  url: "scanqr.kindUrl",
  wifi: "scanqr.kindWifi",
  vcard: "scanqr.kindVcard",
  upi: "scanqr.kindUpi",
  email: "scanqr.kindEmail",
  phone: "scanqr.kindPhone",
  whatsapp: "scanqr.kindWhatsapp",
  geo: "scanqr.kindGeo",
  text: "scanqr.kindText",
};

/** Decode cap: images larger than this (per side) are downscaled. */
const MAX_SIDE = 2400;

interface ScanResult {
  data: string;
  parsed: ScanParsed;
  imageUrl: string;
}

export function ScanQrSurface(_props: ToolSurfaceProps) {
  void _props;
  const { t } = useI18n();
  const { toast } = useToast();
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const objectUrl = useRef<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (objectUrl.current !== null) URL.revokeObjectURL(objectUrl.current);
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const decodeFile = useCallback(
    async (file: File): Promise<void> => {
      if (!file.type.startsWith("image/") && !/\.(svg|heic|heif)$/i.test(file.name)) {
        toast({ title: t("scanqr.errImageType"), variant: "destructive" });
        return;
      }
      setBusy(true);
      setNotFound(false);
      setResult(null);
      try {
        const bitmapUrl = URL.createObjectURL(file);
        if (objectUrl.current !== null) URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = bitmapUrl;

        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = () => reject(new Error("decode"));
          el.src = bitmapUrl;
        });

        let w = img.naturalWidth;
        let h = img.naturalHeight;
        const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("canvas");
        ctx.drawImage(img, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);

        const code = jsQR(imageData.data, w, h, {
          inversionAttempts: "attemptBoth",
        });
        if (!code || code.data.length === 0) {
          setNotFound(true);
          return;
        }
        setResult({
          data: code.data,
          parsed: parseQrPayload(code.data),
          imageUrl: bitmapUrl,
        });
      } catch {
        toast({
          title: t("tool.errorGeneric", { detail: "" }),
          variant: "destructive",
        });
      } finally {
        setBusy(false);
      }
    },
    [t, toast]
  );

  const onPick = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void decodeFile(file);
      e.target.value = "";
    },
    [decodeFile]
  );

  const onDrop = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDrag(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void decodeFile(file);
    },
    [decodeFile]
  );

  const clear = useCallback(() => {
    setResult(null);
    setNotFound(false);
  }, []);

  const copyPayload = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.data);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      toast({
        title: t("tool.errorGeneric", { detail: "" }),
        variant: "destructive",
      });
    }
  }, [result, t, toast]);

  const openLink = useCallback(() => {
    if (result?.parsed.actionUrl) {
      window.open(result.parsed.actionUrl, "_blank", "noopener,noreferrer");
    }
  }, [result]);

  /* ------------------------------ render ------------------------------ */

  return (
    <section
      aria-label={t("scanqr.surfaceLabel")}
      className="flex flex-col gap-6"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* LEFT: drop zone / image preview */}
        <div className="flex flex-col gap-3">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            className={cn(
              "flex min-h-64 flex-col items-center justify-center gap-3 rounded-card border border-dashed p-6 text-center transition-colors",
              drag
                ? "border-primary bg-accent/40"
                : "border-border bg-background"
            )}
          >
            {busy ? (
              <>
                <Loader2
                  className="size-8 animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
                <p className="text-xs text-muted-foreground">
                  {t("scanqr.decoding")}
                </p>
              </>
            ) : result ? (
              <>
                <div className="flex w-full items-center justify-between">
                  <span className="flex items-center gap-2 text-xs font-semibold text-primary">
                    <QrIcon className="size-4" aria-hidden="true" />
                    {t("scanqr.decoded")}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 rounded-btn"
                    aria-label={t("scanqr.clear")}
                    onClick={clear}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                </div>
                <img
                  src={result.imageUrl}
                  alt={t("scanqr.scannedImageAlt")}
                  className="max-h-64 w-auto max-w-full rounded-card border border-border object-contain"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 min-h-10 rounded-btn text-xs font-medium"
                  onClick={() => inputRef.current?.click()}
                >
                  <ImagePlus className="size-4" aria-hidden="true" />
                  {t("scanqr.scanAnother")}
                </Button>
              </>
            ) : (
              <>
                <ScanBarcode
                  className="size-8 text-muted-foreground"
                  aria-hidden="true"
                />
                <p className="text-xs font-medium text-foreground">
                  {t("scanqr.drop")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 min-h-11 rounded-btn text-xs font-medium"
                  onClick={() => inputRef.current?.click()}
                >
                  <ImagePlus className="size-4" aria-hidden="true" />
                  {t("scanqr.pick")}
                </Button>
                <p className="max-w-sm text-[11px] leading-relaxed text-muted-foreground">
                  {t("scanqr.dropHint")}
                </p>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="image/*,.heic,.heif,.svg"
              onChange={onPick}
              className="sr-only"
              aria-label={t("scanqr.pick")}
            />
          </div>

          {notFound ? (
            <p
              className="flex items-start gap-2 rounded-card border border-amber-300/60 bg-amber-500/10 px-4 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-400"
              role="status"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t("scanqr.notFound")}
            </p>
          ) : null}
        </div>

        {/* RIGHT: decoded payload */}
        <div className="flex flex-col gap-3">
          {result ? (
            <div className="flex flex-col gap-4 rounded-card border border-border bg-card p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-chip bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
                  {t(KIND_LABEL_KEYS[result.parsed.kind])}
                </span>
                <span className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                  {t("scanqr.charCount", { count: result.data.length })}
                </span>
              </div>

              <div className="rounded-card bg-muted/40 px-3 py-2.5">
                <p className="break-all font-mono text-xs leading-relaxed text-foreground">
                  {result.data.length > 600
                    ? `${result.data.slice(0, 600)}…`
                    : result.data}
                </p>
              </div>

              {result.parsed.fields.length > 0 ? (
                <dl className="flex flex-col gap-2">
                  {result.parsed.fields.map((field) => (
                    <div
                      key={field.key}
                      className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/60 pb-2 last:border-0 last:pb-0"
                    >
                      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t(FIELD_LABEL_KEYS[field.key] ?? "scanqr.fieldRaw")}
                      </dt>
                      <dd className="max-w-full break-all text-xs font-medium text-foreground">
                        {field.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  className="h-11 min-h-11 flex-1 rounded-btn text-xs font-semibold"
                  onClick={() => void copyPayload()}
                >
                  {copied ? (
                    <Check className="size-4" aria-hidden="true" />
                  ) : (
                    <Copy className="size-4" aria-hidden="true" />
                  )}
                  {copied ? t("scanqr.copied") : t("scanqr.copyPayload")}
                </Button>
                {result.parsed.actionUrl ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 min-h-11 flex-1 rounded-btn text-xs font-semibold"
                    onClick={openLink}
                  >
                    <ExternalLink className="size-4" aria-hidden="true" />
                    {t("scanqr.openLink")}
                  </Button>
                ) : null}
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t("scanqr.linkSafety")}
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-card border border-border bg-card p-8 text-center">
              <QrIcon
                className="size-10 text-muted-foreground/40"
                aria-hidden="true"
              />
              <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                {t("scanqr.placeholder")}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
