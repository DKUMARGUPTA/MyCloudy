"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileSignature,
  ImagePlus,
  Move,
  PenLine,
  Type as TypeIcon,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolPanelProps } from "@/lib/tools/panel-types";
import { cn } from "@/lib/utils";
import { SIGN_IDS, SIGN_DEFAULTS } from "./sign-options";
import { getSignatureFile, setSignatureFile, subscribeToSignature } from "./sign-store";

/**
 * Sign PDF panel (PRD §7.6): signature source (Draw / Type / Upload) +
 * placement controls (size, pages). Every path normalizes to a PNG File in
 * the signature store; the drag POSITION lives on the preview surface in
 * the shared option values, so panel, surface and worker never disagree.
 */

/* ------------------------- ink + style constants ------------------------ */

const INKS = [
  { id: "black", hex: "#111827", key: "sign.inkBlack" },
  { id: "blue", hex: "#1E3A8A", key: "sign.inkBlue" },
] as const;

const TYPE_STYLES = [
  { id: "script", key: "sign.styleScript", css: "italic 600 {size}px 'Brush Script MT', 'Segoe Script', 'Lucida Handwriting', cursive" },
  { id: "serif", key: "sign.styleSerif", css: "italic 500 {size}px Georgia, 'Times New Roman', serif" },
  { id: "sans", key: "sign.styleSans", css: "600 {size}px 'Helvetica Neue', Helvetica, Arial, sans-serif" },
] as const;

const DRAW_W = 640;
const DRAW_H = 220;
const EXPORT_SCALE = 2;

interface DrawStrokePoint {
  x: number;
  y: number;
}

function SectionTitle({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <span className="text-primary" aria-hidden="true">
        {icon}
      </span>
      {label}
    </p>
  );
}

/* ------------------------------ draw pad --------------------------------- */

function DrawPad({
  onReady,
}: {
  onReady: (file: File) => void;
}) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const pointsRef = useRef<DrawStrokePoint[]>([]);
  const bboxRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [ink, setInk] = useState<string>(INKS[0].hex);
  const [stroke, setStroke] = useState(3);

  const ctxOf = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    if (canvas.width !== DRAW_W * EXPORT_SCALE) {
      canvas.width = DRAW_W * EXPORT_SCALE;
      canvas.height = DRAW_H * EXPORT_SCALE;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(EXPORT_SCALE, 0, 0, EXPORT_SCALE, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    return ctx;
  }, []);

  const clear = useCallback(() => {
    const ctx = ctxOf();
    if (!ctx) return;
    ctx.clearRect(0, 0, DRAW_W, DRAW_H);
    pointsRef.current = [];
    bboxRef.current = null;
    setDirty(false);
  }, [ctxOf]);

  const toLogical = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * DRAW_W,
      y: ((e.clientY - rect.top) / rect.height) * DRAW_H,
    };
  }, []);

  const track = useCallback((p: DrawStrokePoint) => {
    const box = bboxRef.current;
    if (!box) {
      bboxRef.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    } else {
      box.x0 = Math.min(box.x0, p.x);
      box.y0 = Math.min(box.y0, p.y);
      box.x1 = Math.max(box.x1, p.x);
      box.y1 = Math.max(box.y1, p.y);
    }
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already released / synthetic — keep drawing anyway */
      }
      drawingRef.current = true;
      const p = toLogical(e);
      pointsRef.current = [p];
      track(p);
      const ctx = ctxOf();
      if (ctx) {
        ctx.strokeStyle = ink;
        ctx.lineWidth = stroke;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + 0.01, p.y);
        ctx.stroke();
      }
      setDirty(true);
    },
    [ctxOf, ink, stroke, toLogical, track]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current) return;
      const pts = pointsRef.current;
      if (pts.length === 0) return;
      const p = toLogical(e);
      const prev = pts[pts.length - 1];
      if (Math.abs(p.x - prev.x) < 0.8 && Math.abs(p.y - prev.y) < 0.8) return;
      pts.push(p);
      track(p);
      const ctx = ctxOf();
      if (ctx) {
        // Quadratic smoothing through midpoints — pen-like strokes.
        ctx.strokeStyle = ink;
        ctx.lineWidth = stroke;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.quadraticCurveTo(prev.x, prev.y, (prev.x + p.x) / 2, (prev.y + p.y) / 2);
        ctx.stroke();
      }
    },
    [ctxOf, ink, stroke, toLogical, track]
  );

  const endStroke = useCallback(() => {
    drawingRef.current = false;
    pointsRef.current = [];
  }, []);

  const use = useCallback(() => {
    const box = bboxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;
    // Trim to the drawn bbox + padding, keep the 2x backing for crispness.
    const pad = 10;
    const x0 = Math.max(0, Math.floor(box.x0) - pad);
    const y0 = Math.max(0, Math.floor(box.y0) - pad);
    const x1 = Math.min(DRAW_W, Math.ceil(box.x1) + pad);
    const y1 = Math.min(DRAW_H, Math.ceil(box.y1) + pad);
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    const out = document.createElement("canvas");
    out.width = w * EXPORT_SCALE;
    out.height = h * EXPORT_SCALE;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(
      canvas,
      x0 * EXPORT_SCALE,
      y0 * EXPORT_SCALE,
      w * EXPORT_SCALE,
      h * EXPORT_SCALE,
      0,
      0,
      w * EXPORT_SCALE,
      h * EXPORT_SCALE
    );
    out.toBlob((blob) => {
      if (!blob) return;
      onReady(
        new File([blob], "signature-drawn.png", { type: "image/png" })
      );
    }, "image/png");
  }, [onReady]);

  return (
    <div className="flex flex-col gap-3">
      <canvas
        ref={canvasRef}
        className="w-full touch-none rounded-btn border border-dashed border-border bg-[repeating-linear-gradient(45deg,transparent,transparent_8px,rgb(0_0_0/0.025)_8px,rgb(0_0_0/0.025)_16px)]"
        style={{ aspectRatio: `${DRAW_W} / ${DRAW_H}` }}
        role="img"
        aria-label={t("sign.drawArea")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
        onPointerLeave={endStroke}
      />
      <div className="flex flex-wrap items-center gap-2">
        {INKS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setInk(entry.hex)}
            aria-pressed={ink === entry.hex}
            aria-label={t(entry.key)}
            className={cn(
              "size-7 rounded-full border-2 outline-none transition-all",
              ink === entry.hex
                ? "border-primary ring-2 ring-primary/30 scale-110"
                : "border-border hover:scale-105"
            )}
            style={{ backgroundColor: entry.hex }}
          />
        ))}
        <div className="ml-2 flex min-w-36 flex-1 items-center gap-2">
          <Slider
            value={[stroke]}
            min={1}
            max={6}
            step={0.5}
            onValueChange={(next) => setStroke(next[0] ?? stroke)}
            aria-label={t("sign.strokeLabel")}
            className="flex-1"
          />
          <span className="w-8 shrink-0 text-right text-[10px] font-semibold tabular-nums text-muted-foreground">
            {stroke.toFixed(1)}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={clear}
          disabled={!dirty}
        >
          {t("sign.clear")}
        </Button>
        <Button type="button" size="sm" onClick={use} disabled={!dirty} className="ml-auto">
          {t("sign.useSignature")}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------ type tab --------------------------------- */

function TypeSignature({
  onReady,
}: {
  onReady: (file: File) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [style, setStyle] = useState<string>(TYPE_STYLES[0].id);
  const [ink, setInk] = useState<string>(INKS[0].hex);
  const previewRef = useRef<HTMLCanvasElement>(null);

  const trimmed = name.trim().slice(0, 40);

  const render = useCallback(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = 640;
    const H = 160;
    canvas.width = W * EXPORT_SCALE;
    canvas.height = H * EXPORT_SCALE;
    ctx.setTransform(EXPORT_SCALE, 0, 0, EXPORT_SCALE, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (trimmed.length === 0) {
      ctx.strokeStyle = "rgb(148 163 184 / 0.5)";
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(40, H / 2);
      ctx.lineTo(W - 40, H / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    const entry =
      TYPE_STYLES.find((s) => s.id === style) ?? TYPE_STYLES[0];
    let size = 96;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "center";
    // Shrink to fit the preview width.
    for (let i = 0; i < 8; i += 1) {
      ctx.font = entry.css.replace("{size}", String(size));
      if (ctx.measureText(trimmed).width <= W - 64) break;
      size = Math.max(24, size - 8);
    }
    const metrics = ctx.measureText(trimmed);
    const ascent = metrics.actualBoundingBoxAscent || size * 0.75;
    const descent = metrics.actualBoundingBoxDescent || size * 0.22;
    const y = (H + ascent - descent) / 2;
    ctx.fillStyle = ink;
    ctx.fillText(trimmed, W / 2, y);
  }, [ink, style, trimmed]);

  useEffect(() => {
    render();
  }, [render]);

  const use = useCallback(() => {
    const canvas = previewRef.current;
    if (!canvas || trimmed.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const entry =
      TYPE_STYLES.find((s) => s.id === style) ?? TYPE_STYLES[0];
    let size = 96;
    for (let i = 0; i < 8; i += 1) {
      ctx.font = entry.css.replace("{size}", String(size));
      if (ctx.measureText(trimmed).width <= 640 - 64) break;
      size = Math.max(24, size - 8);
    }
    const metrics = ctx.measureText(trimmed);
    const width = Math.ceil(metrics.width) + 16;
    const ascent = Math.ceil(metrics.actualBoundingBoxAscent || size * 0.75) + 8;
    const descent = Math.ceil(metrics.actualBoundingBoxDescent || size * 0.22) + 8;
    const height = ascent + descent;
    const out = document.createElement("canvas");
    out.width = Math.max(1, width) * EXPORT_SCALE;
    out.height = Math.max(1, height) * EXPORT_SCALE;
    const octx = out.getContext("2d");
    if (!octx) return;
    octx.setTransform(EXPORT_SCALE, 0, 0, EXPORT_SCALE, 0, 0);
    octx.font = entry.css.replace("{size}", String(size));
    octx.textAlign = "center";
    octx.textBaseline = "alphabetic";
    octx.fillStyle = ink;
    octx.fillText(trimmed, width / 2, ascent);
    out.toBlob((blob) => {
      if (!blob) return;
      onReady(
        new File([blob], "signature-typed.png", { type: "image/png" })
      );
    }, "image/png");
  }, [ink, onReady, style, trimmed]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sign-type-name" className="text-sm font-medium">
          {t("sign.typeName")}
        </Label>
        <Input
          id="sign-type-name"
          value={name}
          maxLength={40}
          placeholder={t("sign.typeNamePh")}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {TYPE_STYLES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setStyle(entry.id)}
            aria-pressed={style === entry.id}
            className={cn(
              "rounded-chip border px-2.5 py-1 text-xs outline-none transition-colors",
              style === entry.id
                ? "border-primary bg-primary/10 font-semibold text-primary"
                : "border-border text-muted-foreground hover:bg-accent"
            )}
          >
            {t(entry.key)}
          </button>
        ))}
        <span className="mx-1 h-6 w-px self-center bg-border" aria-hidden="true" />
        {INKS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setInk(entry.hex)}
            aria-pressed={ink === entry.hex}
            aria-label={t(entry.key)}
            className={cn(
              "size-6 rounded-full border-2 outline-none transition-all",
              ink === entry.hex
                ? "border-primary ring-2 ring-primary/30 scale-110"
                : "border-border hover:scale-105"
            )}
            style={{ backgroundColor: entry.hex }}
          />
        ))}
      </div>
      <canvas
        ref={previewRef}
        className="w-full rounded-btn border border-border bg-card"
        style={{ aspectRatio: "640 / 160" }}
        role="img"
        aria-label={t("sign.typePreview")}
      />
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={use}
          disabled={trimmed.length === 0}
        >
          {t("sign.useSignature")}
        </Button>
      </div>
    </div>
  );
}

/* ----------------------------- upload tab -------------------------------- */

function UploadSignature({
  onReady,
}: {
  onReady: (file: File) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      try {
        const bitmap = await createImageBitmap(file);
        let width = bitmap.width;
        let height = bitmap.height;
        // Cap absurdly large signature photos.
        if (width > 1600) {
          height = Math.round((height * 1600) / width);
          width = 1600;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("canvas");
        ctx.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();

        // Alpha-trim: cut transparent margins so placement feels exact.
        let x0 = 0;
        let y0 = 0;
        let x1 = width;
        let y1 = height;
        const data = ctx.getImageData(0, 0, width, height).data;
        let minX = width;
        let minY = height;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            if (data[(y * width + x) * 4 + 3] > 8) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX >= minX && maxY >= minY) {
          const pad = 4;
          x0 = Math.max(0, minX - pad);
          y0 = Math.max(0, minY - pad);
          x1 = Math.min(width, maxX + 1 + pad);
          y1 = Math.min(height, maxY + 1 + pad);
        }
        const tw = x1 - x0;
        const th = y1 - y0;
        if (tw < 2 || th < 2) throw new Error("empty");

        const out = document.createElement("canvas");
        out.width = tw;
        out.height = th;
        const octx = out.getContext("2d");
        if (!octx) throw new Error("canvas");
        octx.drawImage(canvas, x0, y0, tw, th, 0, 0, tw, th);
        const blob = await new Promise<Blob | null>((resolve) =>
          out.toBlob(resolve, "image/png")
        );
        if (!blob) throw new Error("encode");
        onReady(new File([blob], "signature-upload.png", { type: "image/png" }));
      } catch {
        /* invalid image — the toast in the caller is fired by the store */
      }
    },
    [onReady]
  );

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
          e.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="outline"
        onClick={() => inputRef.current?.click()}
        className="h-auto w-full flex-col gap-1.5 rounded-btn border-dashed py-6"
      >
        <Upload className="size-5 text-primary" aria-hidden="true" />
        <span className="text-sm font-medium">{t("sign.uploadBtn")}</span>
        <span className="text-xs font-normal text-muted-foreground">
          {t("sign.uploadHint")}
        </span>
      </Button>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t("sign.uploadTrimNote")}
      </p>
    </div>
  );
}

/* ------------------------------- panel ------------------------------------ */

export function SignPanel({
  files,
  values,
  onChange,
}: ToolPanelProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [signatureUrl, setSignatureUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const [pageCount, setPageCount] = useState(0);

  const file = files.length > 0 ? files[0].file : null;

  // Mirror the signature store into an object URL for the preview chip.
  const syncSignature = useCallback(() => {
    const sig = getSignatureFile();
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    if (sig) {
      const url = URL.createObjectURL(sig);
      urlRef.current = url;
      setSignatureUrl(url);
    } else {
      setSignatureUrl(null);
    }
  }, []);

  useEffect(() => {
    syncSignature();
    return subscribeToSignature(syncSignature);
  }, [syncSignature]);

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  // Page count for the Last-page quick button.
  useEffect(() => {
    if (!file) {
      setPageCount(0);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { getPdfPageCount } = await import("@/lib/pdf/thumbnails");
      const count = await getPdfPageCount(file);
      if (!cancelled) setPageCount(count);
    })().catch(() => {
      if (!cancelled) setPageCount(0);
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const handleReady = useCallback(
    (next: File) => {
      setSignatureFile(next);
      toast({ title: t("sign.readyToast") });
    },
    [t, toast]
  );

  const removeSignature = useCallback(() => {
    setSignatureFile(null);
  }, []);

  const sizePct = useMemo(() => {
    const raw = values[SIGN_IDS.size];
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? Math.min(90, Math.max(4, n)) : SIGN_DEFAULTS.sizePct;
  }, [values]);

  const pages = useMemo(() => {
    const raw = values[SIGN_IDS.pages];
    return typeof raw === "string" ? raw : SIGN_DEFAULTS.pages;
  }, [values]);

  const quickPages = useCallback(
    (value: string) => {
      onChange(SIGN_IDS.pages, value);
    },
    [onChange]
  );

  return (
    <div className="flex flex-col gap-5">
      {/* ---- Signature source ---- */}
      <section className="flex flex-col gap-3">
        <SectionTitle icon={<FileSignature className="size-3.5" />} label={t("sign.sectionSignature")} />

        {signatureUrl ? (
          <div className="flex items-center gap-3 rounded-btn border border-border bg-card p-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-btn bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
              <PenLine className="size-5" aria-hidden="true" />
            </span>
            <img
              src={signatureUrl}
              alt={t("sign.currentSignature")}
              className="h-10 max-w-40 self-stretch object-contain"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={removeSignature}
              className="ml-auto shrink-0 text-muted-foreground"
            >
              {t("sign.removeSignature")}
            </Button>
          </div>
        ) : null}

        <Tabs defaultValue="draw">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="draw" className="gap-1.5 text-xs">
              <PenLine className="size-3.5" aria-hidden="true" />
              {t("sign.tabDraw")}
            </TabsTrigger>
            <TabsTrigger value="type" className="gap-1.5 text-xs">
              <TypeIcon className="size-3.5" aria-hidden="true" />
              {t("sign.tabType")}
            </TabsTrigger>
            <TabsTrigger value="upload" className="gap-1.5 text-xs">
              <ImagePlus className="size-3.5" aria-hidden="true" />
              {t("sign.tabUpload")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="draw" className="mt-3">
            <DrawPad onReady={handleReady} />
          </TabsContent>
          <TabsContent value="type" className="mt-3">
            <TypeSignature onReady={handleReady} />
          </TabsContent>
          <TabsContent value="upload" className="mt-3">
            <UploadSignature onReady={handleReady} />
          </TabsContent>
        </Tabs>
      </section>

      {/* ---- Placement ---- */}
      <section className="flex flex-col gap-3">
        <SectionTitle icon={<Move className="size-3.5" />} label={t("sign.sectionPlacement")} />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="sign-size" className="text-sm font-medium">
              {t("sign.sizeLabel")}
            </Label>
            <span className="rounded-chip bg-primary/10 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-primary">
              {t("sign.sizeValue", { pct: sizePct })}
            </span>
          </div>
          <Slider
            id="sign-size"
            value={[sizePct]}
            min={4}
            max={90}
            step={1}
            onValueChange={(next) => onChange(SIGN_IDS.size, next[0] ?? sizePct)}
            className="py-1.5"
            aria-label={t("sign.sizeLabel")}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sign-pages" className="text-sm font-medium">
            {t("sign.pagesLabel")}
          </Label>
          <div className="flex flex-wrap gap-1.5">
            <Button type="button" variant="outline" size="sm" className="h-7 rounded-chip px-2.5 text-xs" onClick={() => quickPages("1")}>
              {t("sign.firstPage")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 rounded-chip px-2.5 text-xs"
              disabled={pageCount < 1}
              onClick={() => quickPages(String(pageCount))}
            >
              {t("sign.lastPage")}
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-7 rounded-chip px-2.5 text-xs" onClick={() => quickPages("all")}>
              {t("sign.allPages")}
            </Button>
          </div>
          <Input
            id="sign-pages"
            value={pages}
            placeholder={t("sign.pagesPh")}
            onChange={(e) => onChange(SIGN_IDS.pages, e.target.value)}
            className="h-8 text-xs"
          />
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("sign.dragHint")}
        </p>
      </section>
    </div>
  );
}
