"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Eraser,
  ImagePlus,
  PenLine,
  RotateCcw,
  Type as TypeIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  SIGN_FONTS,
  SIGN_INKS,
  imageFileToCanvas,
  loadSignFonts,
  removeWhiteBackground,
  renderTextSignature,
  trimCanvasToInk,
} from "./raster";
import { addSignature, type StoredSignature } from "./signature-store";

/**
 * Signature creation dialog (PRD §7.6 "Create signature"): Draw with
 * mouse/touch/stylus (smoothed strokes, undo), Type in five script fonts
 * (Kalam covers Hindi), or Upload an image with automatic white-background
 * removal. Saved signatures persist on this device only.
 */

interface DrawPoint {
  x: number;
  y: number;
}

interface DrawStroke {
  points: DrawPoint[];
  color: string;
  width: number;
}

const DRAW_PAD_H = 220;

export function SignatureDialog({
  open,
  onOpenChange,
  onCreated,
  profileName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (sig: StoredSignature) => void;
  profileName?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const { toast } = useToast();
  const [tab, setTab] = useState<"draw" | "type" | "upload">("draw");

  // --- Draw state -------------------------------------------------------
  const padRef = useRef<HTMLCanvasElement>(null);
  const padWrapRef = useRef<HTMLDivElement>(null);
  const strokesRef = useRef<DrawStroke[]>([]);
  const activeStrokeRef = useRef<DrawStroke | null>(null);
  const [padReady, setPadReady] = useState(0); // bump → redraw
  const [strokeCount, setStrokeCount] = useState(0); // placeholder visibility
  const [ink, setInk] = useState<string>(SIGN_INKS[0]);
  const [penWidth, setPenWidth] = useState(3);

  // --- Type state -------------------------------------------------------
  const [typeText, setTypeText] = useState("");
  const [fontId, setFontId] = useState<string>(SIGN_FONTS[0].id);
  const [fontsReady, setFontsReady] = useState(false);

  // --- Upload state -----------------------------------------------------
  const uploadInputId = useRef(`sign-upload-${Math.random().toString(36).slice(2, 8)}`);
  const [uploadPreview, setUploadPreview] = useState<{ dataUrl: string; w: number; h: number } | null>(null);
  const [removeBg, setRemoveBg] = useState(true);
  const [uploadBusy, setUploadBusy] = useState(false);

  const activeFont = SIGN_FONTS.find((f) => f.id === fontId) ?? SIGN_FONTS[0];

  // Reset per-open state.
  useEffect(() => {
    if (!open) return;
    strokesRef.current = [];
    activeStrokeRef.current = null;
    setUploadPreview(null);
    setTypeText(profileName && profileName.trim().length > 0 ? profileName.trim() : "");
    setStrokeCount(0);
    setPadReady((n) => n + 1);
  }, [open, profileName]);

  // Script fonts load only when the Type tab is first needed.
  useEffect(() => {
    if (!open || tab !== "type") return;
    let cancelled = false;
    void loadSignFonts().then(() => {
      if (!cancelled) setFontsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open, tab]);

  // --- Draw pad: size to container, redraw on resize --------------------
  const redraw = useCallback((): void => {
    const canvas = padRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const cssW = canvas.clientWidth || 480;
    const w = Math.round(cssW * dpr);
    const h = Math.round(DRAW_PAD_H * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, DRAW_PAD_H);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const all = activeStrokeRef.current
      ? [...strokesRef.current, activeStrokeRef.current]
      : strokesRef.current;
    for (const stroke of all) {
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.beginPath();
      const pts = stroke.points;
      if (pts.length === 1) {
        ctx.arc(pts[0].x, pts[0].y, stroke.width / 2, 0, Math.PI * 2);
        ctx.fillStyle = stroke.color;
        ctx.fill();
        continue;
      }
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i += 1) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }
  }, []);

  useEffect(() => {
    if (!open || tab !== "draw") return;
    const wrap = padWrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(wrap);
    redraw();
    return () => ro.disconnect();
  }, [open, tab, padReady, redraw]);

  const padPos = (event: React.PointerEvent<HTMLCanvasElement>): DrawPoint => {
    const canvas = padRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    };
  };

  const handlePadDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const canvas = padRef.current;
    if (!canvas) return;
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers can't always be captured — move/up still fire
      // while the pointer stays on the pad.
    }
    activeStrokeRef.current = { points: [padPos(event)], color: ink, width: penWidth };
    redraw();
    event.preventDefault();
  };

  const handlePadMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const stroke = activeStrokeRef.current;
    if (!stroke) return;
    const pos = padPos(event);
    const last = stroke.points[stroke.points.length - 1];
    if (Math.hypot(pos.x - last.x, pos.y - last.y) < 1.2) return;
    stroke.points.push(pos);
    redraw();
  };

  const handlePadUp = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const stroke = activeStrokeRef.current;
    if (stroke && stroke.points.length > 0) strokesRef.current.push(stroke);
    activeStrokeRef.current = null;
    setStrokeCount(strokesRef.current.length);
    try {
      padRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
    redraw();
  };

  const undoStroke = (): void => {
    strokesRef.current.pop();
    setStrokeCount(strokesRef.current.length);
    redraw();
  };

  const clearPad = (): void => {
    strokesRef.current = [];
    setStrokeCount(0);
    redraw();
  };

  // --- Save handlers ----------------------------------------------------
  const saveDrawn = (): void => {
    if (strokesRef.current.length === 0) {
      toast({ title: t("sign.drawEmpty") });
      return;
    }
    const canvas = padRef.current;
    if (!canvas) return;
    const trimmed = trimCanvasToInk(canvas, { pad: 10, maxW: 720 });
    const dataUrl = trimmed.toDataURL("image/png");
    if (dataUrl.length < 100) {
      toast({ title: t("sign.drawEmpty") });
      return;
    }
    finishSave({
      kind: "draw",
      label: t("sign.kindDrawn"),
      dataUrl,
      w: trimmed.width,
      h: trimmed.height,
    });
  };

  const saveTyped = async (): Promise<void> => {
    const text = typeText.replace(/\s+/g, " ").trim();
    if (text.length === 0) {
      toast({ title: t("sign.typeEmpty") });
      return;
    }
    const rendered = await renderTextSignature(text, activeFont.css, ink);
    if (rendered.w <= 1) {
      toast({ title: t("sign.typeEmpty") });
      return;
    }
    finishSave({
      kind: "type",
      label: text,
      dataUrl: rendered.dataUrl,
      w: rendered.w,
      h: rendered.h,
    });
  };

  const handleUploadFile = (file: File | undefined): void => {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      toast({ title: t("sign.uploadTooLarge") });
      return;
    }
    setUploadBusy(true);
    void (async () => {
      try {
        await loadSignFonts(); // keep the tab's promise warm — cheap after first
        const canvas = await imageFileToCanvas(file, 1200);
        if (removeBg) removeWhiteBackground(canvas);
        const trimmed = trimCanvasToInk(canvas, { pad: 8, maxW: 900 });
        setUploadPreview({
          dataUrl: trimmed.toDataURL("image/png"),
          w: trimmed.width,
          h: trimmed.height,
        });
      } catch {
        toast({ title: t("sign.uploadBadFile") });
        setUploadPreview(null);
      } finally {
        setUploadBusy(false);
      }
    })();
  };

  const saveUploaded = (): void => {
    if (!uploadPreview) {
      toast({ title: t("sign.uploadPickFirst") });
      return;
    }
    finishSave({
      kind: "upload",
      label: t("sign.kindUploaded"),
      dataUrl: uploadPreview.dataUrl,
      w: uploadPreview.w,
      h: uploadPreview.h,
    });
  };

  const finishSave = (
    sig: Omit<StoredSignature, "id" | "createdAt">
  ): void => {
    const stored = addSignature(sig);
    onCreated(stored);
    onOpenChange(false);
  };

  const inkSwatches = (
    <div className="flex items-center gap-1.5" role="group" aria-label={t("sign.inkLabel")}>
      {SIGN_INKS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => setInk(color)}
          aria-pressed={ink === color}
          aria-label={t("sign.inkColor", { color })}
          className={cn(
            "size-7 rounded-full border-2 transition-transform",
            ink === color
              ? "border-primary scale-110 ring-2 ring-primary/30"
              : "border-border hover:scale-105"
          )}
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto rounded-card">
        <DialogHeader>
          <DialogTitle>{t("sign.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("sign.dialogDesc")}</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as "draw" | "type" | "upload")}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="draw" className="gap-1.5">
              <PenLine className="size-3.5" aria-hidden="true" />
              {t("sign.tabDraw")}
            </TabsTrigger>
            <TabsTrigger value="type" className="gap-1.5">
              <TypeIcon className="size-3.5" aria-hidden="true" />
              {t("sign.tabType")}
            </TabsTrigger>
            <TabsTrigger value="upload" className="gap-1.5">
              <ImagePlus className="size-3.5" aria-hidden="true" />
              {t("sign.tabUpload")}
            </TabsTrigger>
          </TabsList>

          {/* ---- DRAW ---- */}
          <TabsContent value="draw" className="mt-4 flex flex-col gap-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("sign.drawHint")}
            </p>
            <div
              ref={padWrapRef}
              className="relative w-full overflow-hidden rounded-card border border-border bg-white"
              style={{ height: DRAW_PAD_H }}
            >
              <canvas
                ref={padRef}
                className="block h-full w-full touch-none"
                style={{ height: DRAW_PAD_H, cursor: "crosshair" }}
                onPointerDown={handlePadDown}
                onPointerMove={handlePadMove}
                onPointerUp={handlePadUp}
                onPointerCancel={handlePadUp}
                aria-label={t("sign.padLabel")}
                role="img"
              />
              <span
                className="pointer-events-none absolute inset-x-8 border-b-2 border-dashed border-slate-300"
                style={{ top: "68%" }}
                aria-hidden="true"
              />
              {strokeCount === 0 && activeStrokeRef.current === null ? (
                <span
                  className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-400"
                  aria-hidden="true"
                >
                  {t("sign.drawPlaceholder")}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {inkSwatches}
              <div className="flex min-w-40 flex-1 items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("sign.penWidth")}</span>
                <Slider
                  value={[penWidth]}
                  min={2}
                  max={6}
                  step={0.5}
                  onValueChange={([v]) => setPenWidth(v)}
                  aria-label={t("sign.penWidth")}
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={undoStroke}
                  className="gap-1.5 rounded-btn"
                >
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                  {t("sign.undo")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={clearPad}
                  className="gap-1.5 rounded-btn"
                >
                  <Eraser className="size-3.5" aria-hidden="true" />
                  {t("sign.clear")}
                </Button>
              </div>
              <Button type="button" onClick={saveDrawn} className="rounded-btn">
                {t("sign.useSignature")}
              </Button>
            </div>
          </TabsContent>

          {/* ---- TYPE ---- */}
          <TabsContent value="type" className="mt-4 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sign-type-text" className="text-sm font-medium">
                {t("sign.typeLabel")}
              </Label>
              <Input
                id="sign-type-text"
                value={typeText}
                onChange={(e) => setTypeText(e.target.value.slice(0, 40))}
                placeholder={t("sign.typePlaceholder")}
                className="h-11 rounded-btn"
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t("sign.fontLabel")}</span>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("sign.fontLabel")}>
                {SIGN_FONTS.map((font) => (
                  <button
                    key={font.id}
                    type="button"
                    onClick={() => setFontId(font.id)}
                    aria-pressed={fontId === font.id}
                    className={cn(
                      "rounded-btn border px-3 py-1.5 text-sm transition-colors",
                      fontId === font.id
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-foreground hover:bg-muted"
                    )}
                  >
                    <span style={{ fontFamily: `"${font.css}", cursive` }}>
                      {font.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              {inkSwatches}
            </div>
            <div
              className="flex min-h-28 items-center justify-center overflow-hidden rounded-card border border-border bg-checker p-4"
              aria-label={t("sign.typePreview")}
              role="img"
            >
              {typeText.trim().length > 0 ? (
                <span
                  className="block max-w-full truncate text-4xl leading-tight"
                  style={{
                    fontFamily: `"${activeFont.css}", cursive`,
                    color: ink,
                  }}
                >
                  {typeText.trim()}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">
                  {fontsReady ? t("sign.typePreviewEmpty") : t("sign.fontsLoading")}
                </span>
              )}
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => void saveTyped()}
                className="rounded-btn"
              >
                {t("sign.useSignature")}
              </Button>
            </div>
          </TabsContent>

          {/* ---- UPLOAD ---- */}
          <TabsContent value="upload" className="mt-4 flex flex-col gap-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("sign.uploadHint")}
            </p>
            <div className="flex items-center justify-between gap-3 rounded-card border border-border bg-card p-3">
              <div className="min-w-0">
                <Label htmlFor={uploadInputId.current} className="text-sm font-medium">
                  {t("sign.uploadButton")}
                </Label>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  PNG · JPG · WebP
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="sign-remove-bg"
                  checked={removeBg}
                  onCheckedChange={setRemoveBg}
                />
                <Label
                  htmlFor="sign-remove-bg"
                  className="cursor-pointer text-xs text-muted-foreground"
                >
                  {t("sign.uploadRemoveBg")}
                </Label>
              </div>
            </div>
            <input
              id={uploadInputId.current}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                handleUploadFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              className="h-24 w-full flex-col gap-1 rounded-card border-dashed text-muted-foreground"
              onClick={() => document.getElementById(uploadInputId.current)?.click()}
            >
              <ImagePlus className="size-6" aria-hidden="true" />
              <span className="text-xs">{t("sign.uploadButton")}</span>
            </Button>
            {uploadBusy ? (
              <p className="text-center text-xs text-muted-foreground" role="status">
                {t("sign.uploadWorking")}
              </p>
            ) : null}
            {uploadPreview && !uploadBusy ? (
              <div className="flex flex-col gap-2">
                <div className="flex min-h-24 items-center justify-center rounded-card border border-border bg-checker p-4">
                  { }
                  <img
                    src={uploadPreview.dataUrl}
                    alt={t("sign.uploadPreviewAlt")}
                    className="max-h-32 max-w-full object-contain"
                  />
                </div>
                <div className="flex justify-end">
                  <Button type="button" onClick={saveUploaded} className="rounded-btn">
                    {t("sign.useSignature")}
                  </Button>
                </div>
              </div>
            ) : null}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
