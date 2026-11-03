"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Barcode as BarcodeIcon,
  Check,
  Copy,
  Download,
  FileDown,
  ImageDown,
  Loader2,
  Minus,
  Plus,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { downloadBlob, sanitizeFileName } from "@/lib/files/output";
import { cn } from "@/lib/utils";
import {
  BARCODE_FORMATS,
  DIGIT_ONLY_FORMATS,
  barcodeToPngDataUrl,
  barcodeToSvg,
  barGeometry,
  encodeBarcode,
  type BarcodeEncodeOk,
  type BarcodeFormat,
} from "@/lib/own/barcode";

/**
 * Generate barcode surface — the entire product.
 *
 * Six symbologies with honest per-format validation, a live SVG preview
 * that re-renders as you type, print controls (bar height, module width,
 * human text, colors) and direct PNG/SVG/PDF downloads. The PDF draws
 * vector rectangles + real Helvetica text — sharper than any raster
 * embed. No files, no run phase, zero network.
 */

/* ------------------------------ state ------------------------------ */

interface BarcodeFormState {
  format: BarcodeFormat;
  data: string;
  height: number; // px
  modulePx: number; // px per module
  showText: boolean;
  fg: string;
  bg: string;
}

const INITIAL: BarcodeFormState = {
  format: "code128",
  data: "DocoPDF-2025",
  height: 90,
  modulePx: 3,
  showText: true,
  fg: "#000000",
  bg: "#ffffff",
};

const HEIGHT_MIN = 40;
const HEIGHT_MAX = 180;
const MODULE_MIN = 2;
const MODULE_MAX = 6;

const FORMAT_LABEL_KEYS: Record<BarcodeFormat, string> = {
  code128: "barcode.fmtCode128",
  ean13: "barcode.fmtEan13",
  ean8: "barcode.fmtEan8",
  upca: "barcode.fmtUpca",
  code39: "barcode.fmtCode39",
  itf: "barcode.fmtItf",
};

const FORMAT_HINT_KEYS: Record<BarcodeFormat, string> = {
  code128: "barcode.hintCode128",
  ean13: "barcode.hintEan13",
  ean8: "barcode.hintEan8",
  upca: "barcode.hintUpca",
  code39: "barcode.hintCode39",
  itf: "barcode.hintItf",
};

const PLACEHOLDERS: Record<BarcodeFormat, string> = {
  code128: "SHIP-2025-0042",
  ean13: "400638133393",
  ean8: "9638507",
  upca: "03600029145",
  code39: "ASSET-0042",
  itf: "12345670",
};

/* --------------------------- component --------------------------- */

export function GenerateBarcodeSurface(_props: ToolSurfaceProps) {
  void _props;
  const { t } = useI18n();
  const { toast } = useToast();
  const [state, setState] = useState<BarcodeFormState>(INITIAL);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<"png" | "svg" | "pdf" | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  /** Always mirrors previewUrl for unmount revocation (updaters stay pure). */
  const previewUrlRef = useRef<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const patch = useCallback((partial: Partial<BarcodeFormState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  /* ---- encode (pure, live) ---- */

  const encode = useMemo(
    () => encodeBarcode(state.format, state.data),
    [state.format, state.data]
  );
  const ok = encode.ok;

  const errorKey = useMemo(() => {
    if (encode.ok) return null;
    switch (encode.code) {
      case "empty":
        return "barcode.errEmpty";
      case "charset":
        return state.format === "itf"
          ? "barcode.errDigitsOnly"
          : state.format === "code128"
            ? "barcode.errAscii"
            : "barcode.errCharset";
      case "length":
        return "barcode.errLength";
      case "checkDigit":
        return "barcode.errCheckDigit";
      case "oddDigits":
        return "barcode.errOddDigits";
    }
  }, [encode, state.format]);

  const errorParams = useMemo((): Record<string, string | number> | undefined => {
    if (encode.ok) return undefined;
    if (encode.code === "length") return { max: encode.max };
    if (encode.code === "checkDigit")
      return { expected: encode.expected, got: encode.got };
    return undefined;
  }, [encode]);

  /* ---- preview SVG (thumbnail pattern: effect owns the blob URL) ---- */

  const svg = useMemo(() => {
    if (!ok) return null;
    return barcodeToSvg(encode, {
      height: state.height,
      modulePx: state.modulePx,
      showText: state.showText,
      color: { dark: state.fg, light: state.bg },
    });
  }, [ok, encode, state.height, state.modulePx, state.showText, state.fg, state.bg]);

  useEffect(() => {
    if (svg === null) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const previous = previewUrlRef.current;
    previewUrlRef.current = url;
    setPreviewUrl(url);
    if (previous) URL.revokeObjectURL(previous);
  }, [svg]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    };
  }, []);

  /* ---- copy ---- */

  const copyText = useCallback(async () => {
    if (!ok) return;
    try {
      await navigator.clipboard.writeText(encode.humanText);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      toast({
        title: t("tool.errorGeneric", { detail: "" }),
        variant: "destructive",
      });
    }
  }, [ok, encode, t, toast]);

  /* ---- downloads ---- */

  const fileBase = useCallback((): string => {
    if (!ok) return "barcode";
    return sanitizeFileName(
      `barcode-${state.format}-${encode.humanText}`.slice(0, 60),
      state.format
    );
  }, [ok, encode, state.format]);

  const downloadPng = useCallback(async (): Promise<void> => {
    if (!ok) return;
    setBusy("png");
    try {
      const dataUrl = barcodeToPngDataUrl(encode, {
        height: state.height,
        modulePx: state.modulePx,
        color: { dark: state.fg, light: state.bg },
      });
      const blob = await (await fetch(dataUrl)).blob();
      downloadBlob(blob, `${fileBase()}.png`);
    } catch {
      toast({
        title: t("tool.errorGeneric", { detail: "" }),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }, [ok, encode, state.height, state.modulePx, state.fg, state.bg, fileBase, t, toast]);

  const downloadSvg = useCallback((): void => {
    if (svg === null) return;
    downloadBlob(
      new Blob([svg], { type: "image/svg+xml" }),
      `${fileBase()}.svg`
    );
  }, [svg, fileBase]);

  const downloadPdf = useCallback(async (): Promise<void> => {
    if (!ok) return;
    setBusy("pdf");
    try {
      const { CreateContext } = await import("@/lib/own/pdf");
      const doc = CreateContext.create();
      const quietUnits = encode.quiet;
      const modulePt = Math.max(1.2, state.modulePx); // px→pt 1:1, floor 1.2
      const barHeight = Math.max(24, state.height);
      const textPt = 9;
      const textGap = 3;
      const pageW = (encode.total + quietUnits * 2) * modulePt;
      const pageH = barHeight + (state.showText ? textGap + textPt * 1.35 : 0) + 8;
      const page = doc.addPage(pageW, pageH);
      const hex = (v: string): { r: number; g: number; b: number } => {
        const n = parseInt(v.replace("#", ""), 16);
        return {
          r: ((n >> 16) & 0xff) / 255,
          g: ((n >> 8) & 0xff) / 255,
          b: (n & 0xff) / 255,
        };
      };
      const fg = hex(state.fg);
      const bg = hex(state.bg);
      const { bars } = barGeometry(encode);
      // background
      page.drawRectangle({
        x: 0,
        y: 0,
        width: pageW,
        height: pageH,
        color: bg,
      });
      const barsBottom = pageH - 4 - barHeight;
      for (const b of bars) {
        page.drawRectangle({
          x: (b.x + quietUnits) * modulePt,
          y: barsBottom,
          width: b.w * modulePt,
          height: barHeight,
          color: fg,
        });
      }
      if (state.showText) {
        const baseline = barsBottom - textGap - textPt * 0.08;
        if (encode.textAnchors.length > 0) {
          for (const anchor of encode.textAnchors) {
            const xUnits = anchor.x + quietUnits;
            // Helvetica digits ≈ 0.556 em each (AFM widths).
            const textW = anchor.text.length * 0.556 * textPt;
            const x =
              anchor.align === "center"
                ? xUnits * modulePt - textW / 2
                : anchor.align === "right"
                  ? xUnits * modulePt - textW
                  : xUnits * modulePt;
            page.drawText({
              x: Math.max(1, x),
              y: baseline,
              text: anchor.text,
              size: textPt,
              font: "helvetica",
              color: fg,
            });
          }
        } else {
          const textW = encode.humanText.length * 0.5 * textPt;
          page.drawText({
            x: Math.max(1, pageW / 2 - textW / 2),
            y: baseline,
            text: encode.humanText,
            size: textPt,
            font: "helvetica",
            color: fg,
          });
        }
      }
      const bytes = doc.write();
      downloadBlob(
        new Blob([bytes as unknown as BlobPart], { type: "application/pdf" }),
        `${fileBase()}.pdf`
      );
    } catch {
      toast({
        title: t("tool.errorGeneric", { detail: "" }),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }, [ok, encode, state.height, state.modulePx, state.showText, state.fg, state.bg, fileBase, t, toast]);

  /* ---- format switch keeps the data if it still validates ---- */

  const onFormatChange = useCallback(
    (format: BarcodeFormat) => {
      setState((prev) => {
        const next = { ...prev, format };
        // Friendly defaults per format family.
        if (format !== "code128" && format !== "code39") {
          if (!/^\d+$/.test(prev.data)) next.data = PLACEHOLDERS[format];
        }
        return next;
      });
    },
    []
  );

  const digitOnly = DIGIT_ONLY_FORMATS.includes(state.format);

  /* ------------------------------ render ------------------------------ */

  return (
    <section
      aria-label={t("barcode.surfaceLabel")}
      className="flex flex-col gap-6"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* LEFT: format + data + controls */}
        <div className="flex flex-col gap-4">
          <div>
            <span
              id="barcode-format-label"
              className="text-xs font-medium text-foreground"
            >
              {t("barcode.formatLabel")}
            </span>
            <div
              role="radiogroup"
              aria-labelledby="barcode-format-label"
              className="mt-2 grid grid-cols-3 gap-2"
            >
              {BARCODE_FORMATS.map((format) => {
                const active = state.format === format;
                return (
                  <button
                    key={format}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onFormatChange(format)}
                    className={cn(
                      "flex min-h-11 items-center justify-center rounded-btn border px-2 text-[11px] font-medium outline-none transition-colors",
                      "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      active
                        ? "border-primary/60 bg-primary/10 text-primary"
                        : "border-border bg-card text-muted-foreground hover:border-primary/30 hover:text-foreground"
                    )}
                  >
                    {t(FORMAT_LABEL_KEYS[format])}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {t(FORMAT_HINT_KEYS[state.format])}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="barcode-data" className="text-xs font-medium text-foreground">
              {t(digitOnly ? "barcode.dataLabelDigits" : "barcode.dataLabel")}
            </Label>
            <Input
              id="barcode-data"
              value={state.data}
              onChange={(e) => patch({ data: e.target.value })}
              placeholder={PLACEHOLDERS[state.format]}
              inputMode={digitOnly ? "numeric" : "text"}
              autoComplete="off"
              spellCheck={false}
              className="h-11 min-h-11 rounded-btn font-mono"
              aria-invalid={!ok && state.data.trim().length > 0}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("barcode.dataHint", { max: 48 })}
            </p>
          </div>

          {/* height + module width */}
          <div className="flex flex-col gap-4 rounded-card border border-border bg-card p-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="barcode-height" className="text-xs font-medium text-foreground">
                  {t("barcode.heightLabel")}
                </Label>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {state.height}px
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-8 shrink-0 rounded-btn"
                  aria-label={t("barcode.heightDown")}
                  onClick={() =>
                    patch({ height: Math.max(HEIGHT_MIN, state.height - 10) })
                  }
                >
                  <Minus className="size-3.5" aria-hidden="true" />
                </Button>
                <Slider
                  id="barcode-height"
                  value={[state.height]}
                  min={HEIGHT_MIN}
                  max={HEIGHT_MAX}
                  step={10}
                  onValueChange={(v) => patch({ height: v[0] ?? state.height })}
                  aria-label={t("barcode.heightLabel")}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-8 shrink-0 rounded-btn"
                  aria-label={t("barcode.heightUp")}
                  onClick={() =>
                    patch({ height: Math.min(HEIGHT_MAX, state.height + 10) })
                  }
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="barcode-module" className="text-xs font-medium text-foreground">
                  {t("barcode.moduleLabel")}
                </Label>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {state.modulePx}px
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-8 shrink-0 rounded-btn"
                  aria-label={t("barcode.moduleDown")}
                  onClick={() =>
                    patch({ modulePx: Math.max(MODULE_MIN, state.modulePx - 1) })
                  }
                >
                  <Minus className="size-3.5" aria-hidden="true" />
                </Button>
                <Slider
                  id="barcode-module"
                  value={[state.modulePx]}
                  min={MODULE_MIN}
                  max={MODULE_MAX}
                  step={1}
                  onValueChange={(v) => patch({ modulePx: v[0] ?? state.modulePx })}
                  aria-label={t("barcode.moduleLabel")}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-8 shrink-0 rounded-btn"
                  aria-label={t("barcode.moduleUp")}
                  onClick={() =>
                    patch({ modulePx: Math.min(MODULE_MAX, state.modulePx + 1) })
                  }
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="barcode-text" className="text-xs font-medium text-foreground">
                {t("barcode.showTextLabel")}
              </Label>
              <Switch
                id="barcode-text"
                checked={state.showText}
                onCheckedChange={(checked) => patch({ showText: checked })}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="barcode-fg" className="text-xs font-medium text-foreground">
                  {t("barcode.fgLabel")}
                </Label>
                <input
                  id="barcode-fg"
                  type="color"
                  value={state.fg}
                  onChange={(e) => patch({ fg: e.target.value })}
                  className="h-10 w-full cursor-pointer rounded-btn border border-border bg-card p-1"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="barcode-bg" className="text-xs font-medium text-foreground">
                  {t("barcode.bgLabel")}
                </Label>
                <input
                  id="barcode-bg"
                  type="color"
                  value={state.bg}
                  onChange={(e) => patch({ bg: e.target.value })}
                  className="h-10 w-full cursor-pointer rounded-btn border border-border bg-card p-1"
                />
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT: preview + downloads */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col items-center gap-3 rounded-card border border-border bg-card p-5">
            <div
              className="flex w-full items-center justify-center overflow-hidden rounded-card border border-border bg-muted/30 p-3"
              aria-live="polite"
            >
              {previewUrl !== null ? (
                <img
                  src={previewUrl}
                  alt={t("barcode.previewAlt")}
                  className="max-h-56 w-auto max-w-full bg-card object-contain"
                />
              ) : (
                <div className="flex flex-col items-center gap-2 p-6 text-center">
                  <BarcodeIcon
                    className="size-8 text-muted-foreground/50"
                    aria-hidden="true"
                  />
                  <p className="text-xs text-muted-foreground">
                    {errorKey !== null ? t(errorKey, errorParams) : t("barcode.rendering")}
                  </p>
                </div>
              )}
            </div>

            {ok ? (
              <div className="flex w-full flex-wrap items-center justify-center gap-2">
                <span className="rounded-chip bg-muted px-2.5 py-1 font-mono text-[11px] font-medium text-foreground">
                  {encode.humanText.length > 32
                    ? `${encode.humanText.slice(0, 32)}…`
                    : encode.humanText}
                </span>
                {encode.addedCheckDigit ? (
                  <span className="rounded-chip bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
                    {t("barcode.checkAdded")}
                  </span>
                ) : null}
                <span className="rounded-chip bg-muted/60 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                  {t("barcode.modulesChip", { count: encode.total })}
                </span>
              </div>
            ) : null}

            {ok ? (
              <Button
                type="button"
                variant="outline"
                className="h-11 min-h-11 w-full max-w-[280px] rounded-btn text-xs font-medium"
                onClick={() => void copyText()}
                aria-label={t("barcode.copyText")}
              >
                {copied ? (
                  <Check className="size-4" aria-hidden="true" />
                ) : (
                  <Copy className="size-4" aria-hidden="true" />
                )}
                {copied ? t("barcode.copied") : t("barcode.copyText")}
              </Button>
            ) : null}
          </div>

          {errorKey !== null && state.data.trim().length > 0 ? (
            <p
              className="flex items-start gap-2 rounded-card border border-amber-300/60 bg-amber-500/10 px-4 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-400"
              role="status"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t(errorKey, errorParams)}
            </p>
          ) : null}

          <div className="grid grid-cols-3 gap-2">
            <Button
              type="button"
              className="h-12 min-h-12 rounded-btn text-xs font-semibold"
              disabled={!ok || busy !== null}
              onClick={() => void downloadPng()}
            >
              {busy === "png" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <ImageDown className="size-4" aria-hidden="true" />
              )}
              {t("barcode.downloadPng")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-12 min-h-12 rounded-btn text-xs font-semibold"
              disabled={!ok || busy !== null}
              onClick={downloadSvg}
            >
              <Download className="size-4" aria-hidden="true" />
              {t("barcode.downloadSvg")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-12 min-h-12 rounded-btn text-xs font-semibold"
              disabled={!ok || busy !== null}
              onClick={() => void downloadPdf()}
            >
              {busy === "pdf" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <FileDown className="size-4" aria-hidden="true" />
              )}
              {t("barcode.downloadPdf")}
            </Button>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {ok ? t("barcode.printNote") : t("barcode.fixFirst")}
          </p>
        </div>
      </div>
    </section>
  );
}
