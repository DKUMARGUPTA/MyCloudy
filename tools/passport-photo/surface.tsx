"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Contrast,
  Crop,
  Loader2,
  RotateCcw,
  Scissors,
  Sun,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/components/providers/locale-provider";
import { formatBytes } from "@/lib/storage/recent-files";
import { looksHeic } from "@/lib/heic/heic-preview";
import { decodeHeicToBitmap } from "@/lib/heic/heic-decode";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { cn } from "@/lib/utils";
import {
  ADJUST_MAX,
  CUSTOM_MM_MAX,
  CUSTOM_MM_MIN,
  DEFAULT_STYLE,
  MAX_ZOOM,
  MIN_ZOOM,
  PHOTO_SIZES,
  SHEETS,
  WHITE_TOLERANCE_MAX,
  applyBrightnessContrast,
  applyWhiteBackground,
  computeCropRect,
  computeSheetPlan,
  infoLineText,
  photoPixelSize,
  resolveSize,
  serializePassport,
  sizeAspect,
  clampCustomMM,
  type PassportStyle,
} from "./model";
import {
  dimOutside,
  drawCropFrame,
  drawHeadGuide,
  drawPhotoCrop,
  drawSheetPreview,
  type PassportSource,
} from "./render";

/**
 * Passport photo surface (PRD "Passport photo maker") — the studio
 * workspace. One photo in; the drag/zoom framing editor with the
 * head-guide band, the smart-white background + brightness/contrast
 * tuning, and the live sheet preview all run here on the main thread
 * (small canvases — the worker owns the full-resolution run).
 *
 * State flows one way: every mutation rewrites the serialized "passport"
 * option via the shell's onChange, so the Run CTA always ships the exact
 * previewed recipe. One run returns BOTH files (photo JPEG + sheet PDF);
 * the result view gives each its own download button.
 */

const TOOL_BTN =
  "h-11 min-h-11 gap-1.5 rounded-btn px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50";

/* --------------------------- decode helpers --------------------------- */

/** Cheap TIFF check without reading bytes (type or extension). */
function looksTiff(file: File): boolean {
  return file.type === "image/tiff" || /\.(tif|tiff)$/i.test(file.name);
}

/** Full-resolution first page of a TIFF (clean-room reader, main thread). */
async function tiffBitmap(file: File): Promise<ImageBitmap | null> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { TiffFile } = await import("../imgconv/tiff");
    const tiff = TiffFile.parse(bytes);
    if (tiff.pageCount === 0) return null;
    const page = tiff.decodePage(0);
    const canvas = document.createElement("canvas");
    canvas.width = page.width;
    canvas.height = page.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.putImageData(
      new ImageData(page.rgba, page.width, page.height) as unknown as ImageData,
      0,
      0
    );
    return await createImageBitmap(canvas);
  } catch {
    return null;
  }
}

/** Decodes the workspace photo for the editor (HEIC via libheif, TIFF p1). */
async function decodeSource(file: File): Promise<PassportSource> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    bitmap = null;
  }
  if (bitmap === null && looksHeic(file)) {
    bitmap = await decodeHeicToBitmap(new Uint8Array(await file.arrayBuffer()));
  }
  if (bitmap === null && looksTiff(file)) {
    bitmap = await tiffBitmap(file);
  }
  if (bitmap === null) throw new Error("decode-failed");
  return bitmap;
}

function closeSource(source: PassportSource | null): void {
  if (source && "close" in source && typeof source.close === "function") {
    source.close();
  }
}

/* ------------------------------ surface ------------------------------ */

export function PassportPhotoSurface({
  files,
  onChange,
  setFileOrder,
  setRunBlocked,
}: ToolSurfaceProps) {
  const { t, locale } = useI18n();

  const fileRef = files[0] ?? null;
  const fileId = fileRef?.id ?? null;

  const [style, setStyle] = useState<PassportStyle>({ ...DEFAULT_STYLE });
  const [bitmap, setBitmap] = useState<PassportSource | null>(null);
  const [bitmapDims, setBitmapDims] = useState<{ w: number; h: number } | null>(null);
  const [decodeBroken, setDecodeBroken] = useState(false);
  const [washedZero, setWashedZero] = useState(false);
  const [previewW, setPreviewW] = useState(0);

  // Latest-recipe ref: `apply` writes it in the event context; this effect
  // only re-syncs after commits (never a ref write during render).
  const styleRef = useRef(style);
  useEffect(() => {
    styleRef.current = style;
  }, [style]);

  /* ---------------- derived recipe ---------------- */

  const size = useMemo(
    () => resolveSize(style.sizeId, style.customW, style.customH),
    [style.sizeId, style.customW, style.customH]
  );
  const plan = useMemo(
    () => computeSheetPlan(size, style.sheet, { infoLine: style.infoLine }),
    [size, style.sheet, style.infoLine]
  );
  const pixels = useMemo(() => photoPixelSize(size), [size]);
  const sheetBlocked = plan.copies < 1;

  /* ---------------- option sync (event-context only) ---------------- */

  const syncOption = useCallback(
    (next: PassportStyle): void => {
      onChange("passport", serializePassport({ style: next, locale }));
    },
    [locale, onChange]
  );

  const apply = useCallback(
    (partial: Partial<PassportStyle>): void => {
      const next = { ...styleRef.current, ...partial };
      styleRef.current = next;
      setStyle(next);
      syncOption(next);
    },
    [syncOption]
  );

  // Mount sync: the serialized option always mirrors the freshly
  // initialized recipe (a remount from the result view resets edits — the
  // worker must never receive a stale recipe). Microtask, like the house
  // pattern — never a synchronous write inside the effect body.
  const initialSync = useRef(false);
  useEffect(() => {
    if (initialSync.current) return;
    initialSync.current = true;
    void Promise.resolve().then(() => {
      syncOption(styleRef.current);
    });
    // Mount-only by design (state is the lazy initializer's value).
  }, []);

  // Language switch re-sync: `locale` rides inside the serialized option
  // (it names the output files), so switching EN ↔ HI after the last edit
  // must re-serialize.
  const localeSeen = useRef(locale);
  useEffect(() => {
    if (localeSeen.current === locale) return;
    localeSeen.current = locale;
    void Promise.resolve().then(() => {
      syncOption(styleRef.current);
    });
  }, [locale, syncOption]);

  // Run gating: no photo, or a size that cannot fit the sheet.
  const gateKey = fileId === null ? "pp.ctaNoPhoto" : sheetBlocked ? "pp.sheetTooSmall" : null;
  const gateRef = useRef(gateKey);
  useEffect(() => {
    if (gateRef.current === gateKey) return;
    gateRef.current = gateKey;
    void Promise.resolve().then(() => {
      setRunBlocked(gateKey);
    });
  }, [gateKey, setRunBlocked]);

  /* ---------------- photo decode (main thread) ---------------- */

  const fileObjRef = useRef<File | null>(null);
  useEffect(() => {
    fileObjRef.current = fileRef?.file ?? null;
  }, [fileRef]);

  useEffect(() => {
    if (fileId === null) return;
    const file = fileObjRef.current;
    if (!file) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (!cancelled) {
        setDecodeBroken(false);
        setWashedZero(false);
      }
      try {
        const source = await decodeSource(file);
        if (cancelled) {
          closeSource(source);
          return;
        }
        setBitmap(source);
        setBitmapDims({ w: source.width, h: source.height });
      } catch {
        if (!cancelled) setDecodeBroken(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  // Bitmap lifecycle: close the replaced source, and the held one on
  // unmount (StrictMode-safe — no side effects inside state updaters).
  const bitmapHeldRef = useRef<PassportSource | null>(null);
  useEffect(() => {
    const previous = bitmapHeldRef.current;
    bitmapHeldRef.current = bitmap;
    if (previous && previous !== bitmap) closeSource(previous);
  }, [bitmap]);
  useEffect(() => {
    const held = bitmapHeldRef;
    return () => closeSource(held.current);
  }, []);

  // Editor width follows the container (capped), like the collage preview.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver((observed) => {
      const width = observed[0]?.contentRect.width ?? 0;
      if (width > 0) setPreviewW(Math.round(Math.min(520, width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* ---------------- framing editor canvas ---------------- */

  const editorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Source px per canvas CSS px — set by the draw pass, read by gestures. */
  const editorScaleRef = useRef(1);
  const cropRef = useRef({ sw: 0, sh: 0 });

  useEffect(() => {
    const canvas = editorCanvasRef.current;
    if (!canvas || !bitmap || previewW <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Contain-fit the photo into (previewW × 460).
    const ratio = bitmap.width / bitmap.height;
    let cssW = previewW;
    let cssH = previewW / ratio;
    if (cssH > 460) {
      cssH = 460;
      cssW = 460 * ratio;
    }
    const width = Math.round(cssW * dpr);
    const height = Math.round(cssH * dpr);
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${Math.round(cssW)}px`;
    canvas.style.height = `${Math.round(cssH)}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#f5f5f4";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);

    const scale = width / bitmap.width;
    editorScaleRef.current = cssW / bitmap.width; // source px per CSS px
    const crop = computeCropRect(
      bitmap.width,
      bitmap.height,
      sizeAspect(size),
      style.zoom,
      style.panX,
      style.panY
    );
    cropRef.current = { sw: crop.sw, sh: crop.sh };
    const rect = {
      x: crop.sx * scale,
      y: crop.sy * scale,
      w: crop.sw * scale,
      h: crop.sh * scale,
    };
    dimOutside(ctx, rect, width, height);
    drawCropFrame(ctx, rect);
    drawHeadGuide(ctx, rect);
  }, [bitmap, previewW, size, style.zoom, style.panX, style.panY]);

  /* ---------------- gestures: drag pan + pinch + wheel ---------------- */

  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchDistRef = useRef(0);

  const panBy = useCallback(
    (dxCss: number, dyCss: number): void => {
      if (!bitmap) return;
      const crop = cropRef.current;
      const slackX = bitmap.width - crop.sw;
      const slackY = bitmap.height - crop.sh;
      const srcPerCss = editorScaleRef.current; // source px per CSS px
      const perCssX = slackX > 0 ? (2 * dxCss * srcPerCss) / slackX : 0;
      const perCssY = slackY > 0 ? (2 * dyCss * srcPerCss) / slackY : 0;
      const next = styleRef.current;
      const panX = Math.min(1, Math.max(-1, next.panX - perCssX));
      const panY = Math.min(1, Math.max(-1, next.panY - perCssY));
      apply({ panX, panY });
    },
    [apply, bitmap]
  );

  const zoomBy = useCallback(
    (factor: number): void => {
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, styleRef.current.zoom * factor));
      if (Math.abs(next - styleRef.current.zoom) < 1e-4) return;
      apply({ zoom: next });
    },
    [apply]
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!bitmap) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchDistRef.current = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!bitmap || !pointersRef.current.has(event.pointerId)) return;
    const prev = pointersRef.current.get(event.pointerId) ?? { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size >= 2) {
      // Pinch: the distance ratio zooms.
      const [a, b] = [...pointersRef.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDistRef.current > 0 && dist > 0) {
        zoomBy(dist / pinchDistRef.current);
      }
      pinchDistRef.current = dist;
      return;
    }
    panBy(event.clientX - prev.x, event.clientY - prev.y);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchDistRef.current = 0;
  };

  // Wheel zoom needs a non-passive listener (preventDefault).
  useEffect(() => {
    const element = editorCanvasRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent): void => {
      if (!bitmap) return;
      event.preventDefault();
      zoomBy(Math.exp(-event.deltaY * 0.0016));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [bitmap, zoomBy]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>): void => {
    if (!bitmap) return;
    const step = 0.06;
    const map: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const pan = map[event.key];
    if (pan) {
      event.preventDefault();
      const next = styleRef.current;
      apply({
        panX: Math.min(1, Math.max(-1, next.panX + pan[0])),
        panY: Math.min(1, Math.max(-1, next.panY + pan[1])),
      });
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(1.15);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomBy(1 / 1.15);
    }
  };

  /* ---------------- final photo + sheet previews ---------------- */

  const photoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sheetCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!bitmap || previewW <= 0) return;
    const timer = setTimeout(() => {
      const photo = photoCanvasRef.current;
      const sheet = sheetCanvasRef.current;
      if (!photo) return;
      const width = 220;
      const height = Math.round(width / sizeAspect(size));
      if (photo.width !== width || photo.height !== height) {
        photo.width = width;
        photo.height = height;
      }
      const ctx = photo.getContext("2d");
      if (!ctx) return;
      const crop = computeCropRect(
        bitmap.width,
        bitmap.height,
        sizeAspect(size),
        style.zoom,
        style.panX,
        style.panY
      );
      drawPhotoCrop(ctx, bitmap, crop, 0, 0, width, height);

      // The pixel pipeline — the same pure model functions the worker runs.
      let washed = 0;
      if (style.background === "white" || style.brightness !== 0 || style.contrast !== 0) {
        const image = ctx.getImageData(0, 0, width, height);
        if (style.background === "white") {
          washed = applyWhiteBackground(image.data, width, height, style.whiteTolerance);
        }
        if (style.brightness !== 0 || style.contrast !== 0) {
          applyBrightnessContrast(image.data, style.brightness, style.contrast);
        }
        ctx.putImageData(image, 0, 0);
      }
      setWashedZero(style.background === "white" && washed === 0);

      // Sheet preview — draws FROM the processed photo canvas (WYSIWYG).
      if (sheet) {
        const sheetWidth = 240;
        const sheetHeight = Math.round((sheetWidth * plan.pageH) / plan.pageW);
        if (sheet.width !== sheetWidth || sheet.height !== sheetHeight) {
          sheet.width = sheetWidth;
          sheet.height = sheetHeight;
        }
        const sheetCtx = sheet.getContext("2d");
        if (sheetCtx) {
          drawSheetPreview(sheetCtx, plan, photo, {
            cutGuides: style.cutGuides,
            infoText: plan.infoLine ? infoLineText(size, plan) : "",
          });
        }
      }
    }, 130);
    return () => clearTimeout(timer);
  }, [
    bitmap,
    previewW,
    size,
    plan,
    style.zoom,
    style.panX,
    style.panY,
    style.background,
    style.whiteTolerance,
    style.brightness,
    style.contrast,
    style.cutGuides,
    style.infoLine,
  ]);

  /* ---------------- custom mm drafts ---------------- */

  const [customDraft, setCustomDraft] = useState({ w: "35", h: "45" });

  // Fresh drafts whenever the custom size becomes active — the inputs
  // mirror the live clamped values, never a stale edit.
  const customSeen = useRef(false);
  useEffect(() => {
    if (style.sizeId !== "custom" || customSeen.current) return;
    customSeen.current = true;
    void Promise.resolve().then(() => {
      setCustomDraft({
        w: String(styleRef.current.customW),
        h: String(styleRef.current.customH),
      });
    });
  }, [style.sizeId]);

  const commitCustom = (axis: "w" | "h", raw: string): void => {
    const parsed = Number.parseFloat(raw.replace(",", "."));
    if (Number.isFinite(parsed)) {
      apply(axis === "w" ? { customW: clampCustomMM(parsed, 35) } : { customH: clampCustomMM(parsed, 45) });
    }
  };
  const commitCustomBlur = (axis: "w" | "h"): void => {
    setCustomDraft((prev) => ({
      ...prev,
      [axis]: String(axis === "w" ? style.customW : style.customH),
    }));
  };

  /* ---------------- render ---------------- */

  const pxNote = `${pixels.w}\u00d7${pixels.h}`;

  return (
    <section aria-label={t("pp.surfaceLabel")} className="flex flex-col gap-3">
      {/* Header — file card */}
      <div className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-card p-3">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-chip bg-cat-create/10 text-cat-create">
            <Crop className="size-4" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-xs font-semibold text-foreground" title={fileRef?.file.name}>
              {fileRef?.file.name}
            </span>
            <span className="block text-[10px] text-muted-foreground">
              {fileRef ? formatBytes(fileRef.file.size) : ""}
              {bitmapDims ? (
                <>
                  {" \u00b7 "}
                  {bitmapDims.w}×{bitmapDims.h}
                </>
              ) : null}
            </span>
          </span>
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            {t("pp.copiesNote", { count: plan.copies })}
          </span>
          <Button
            type="button"
            variant="outline"
            className={cn(TOOL_BTN, "px-2")}
            aria-label={t("pp.removeLabel", { name: fileRef?.file.name ?? "" })}
            onClick={() => setFileOrder([])}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </span>
      </div>

      {/* Framing editor */}
      <div className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("pp.editorLabel")}
          </h3>
          <span className="ml-auto flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              className={cn(TOOL_BTN, "px-2")}
              aria-label={t("pp.zoomOut")}
              onClick={() => zoomBy(1 / 1.25)}
              disabled={!bitmap}
            >
              <span className="text-sm leading-none" aria-hidden="true">−</span>
            </Button>
            <span className="min-w-12 text-center text-xs font-medium text-foreground">
              {Math.round(style.zoom * 100)}%
            </span>
            <Button
              type="button"
              variant="outline"
              className={cn(TOOL_BTN, "px-2")}
              aria-label={t("pp.zoomIn")}
              onClick={() => zoomBy(1.25)}
              disabled={!bitmap}
            >
              <span className="text-sm leading-none" aria-hidden="true">+</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              className={TOOL_BTN}
              onClick={() => apply({ zoom: 1, panX: 0, panY: 0 })}
              disabled={!bitmap}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t("pp.resetCrop")}</span>
            </Button>
          </span>
        </div>

        <div ref={wrapRef} className="flex w-full justify-center overflow-hidden">
          {bitmap ? (
            <canvas
              ref={editorCanvasRef}
              role="application"
              aria-label={t("pp.editorAlt")}
              tabIndex={0}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onKeyDown}
              className="max-w-full touch-none rounded-btn border border-border bg-card shadow-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          ) : decodeBroken ? (
            <p className="flex w-full items-center justify-center gap-1.5 rounded-btn border border-dashed border-border bg-muted/30 px-6 py-10 text-xs font-medium text-amber-600 dark:text-amber-400">
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
              {t("pp.decodeFailed")}
            </p>
          ) : (
            <div className="flex h-56 w-full max-w-[520px] items-center justify-center rounded-btn border border-dashed border-border bg-muted/30">
              <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="pp-zoom" className="text-xs font-medium text-foreground">
            {t("pp.zoomLabel")}
          </Label>
          <Slider
            id="pp-zoom"
            value={[style.zoom]}
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.05}
            onValueChange={([value]) => apply({ zoom: value })}
            disabled={!bitmap}
            aria-label={t("pp.zoomLabel")}
          />
          <p className="text-[11px] text-muted-foreground">{t("pp.editorHint")}</p>
          <p className="text-[11px] text-muted-foreground">{t("pp.guideNote")}</p>
        </div>
      </div>

      {/* Recipe controls */}
      <div className="grid gap-5 rounded-card border border-border bg-card p-4 sm:grid-cols-2">
        {/* Size + sheet */}
        <fieldset className="flex flex-col gap-3">
          <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("pp.sizeLabel")}
          </Label>
          <Select
            value={style.sizeId}
            onValueChange={(value) => apply({ sizeId: value as PassportStyle["sizeId"] })}
          >
            <SelectTrigger className="h-11 min-h-11 w-full rounded-btn text-xs" aria-label={t("pp.sizeLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PHOTO_SIZES.map((entry) => (
                <SelectItem key={entry.id} value={entry.id} className="text-xs">
                  {entry.label[locale]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {style.sizeId === "custom" ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-medium text-muted-foreground">
                  {t("pp.customWLabel")}
                </span>
                <Input
                  inputMode="decimal"
                  value={customDraft.w}
                  onChange={(event) => {
                    setCustomDraft((prev) => ({ ...prev, w: event.target.value }));
                    commitCustom("w", event.target.value);
                  }}
                  onBlur={() => commitCustomBlur("w")}
                  aria-label={t("pp.customWLabel")}
                  className="h-10 min-h-10 rounded-btn text-xs"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-medium text-muted-foreground">
                  {t("pp.customHLabel")}
                </span>
                <Input
                  inputMode="decimal"
                  value={customDraft.h}
                  onChange={(event) => {
                    setCustomDraft((prev) => ({ ...prev, h: event.target.value }));
                    commitCustom("h", event.target.value);
                  }}
                  onBlur={() => commitCustomBlur("h")}
                  aria-label={t("pp.customHLabel")}
                  className="h-10 min-h-10 rounded-btn text-xs"
                />
              </label>
              <p className="col-span-2 text-[10px] text-muted-foreground">{t("pp.customNote")}</p>
            </div>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            {t("pp.sizeNote", {
              w: Math.round(size.wMM),
              h: Math.round(size.hMM),
              px: pxNote,
            })}
          </p>

          <Label className="mt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("pp.sheetLabel")}
          </Label>
          <Select
            value={style.sheet}
            onValueChange={(value) => apply({ sheet: value as PassportStyle["sheet"] })}
          >
            <SelectTrigger className="h-11 min-h-11 w-full rounded-btn text-xs" aria-label={t("pp.sheetLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SHEETS.map((sheet) => (
                <SelectItem key={sheet.id} value={sheet.id} className="text-xs">
                  {sheet.label[locale]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {sheetBlocked ? (
            <p className="flex items-start gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t("pp.sheetTooSmall", {
                size: `${Math.round(size.wMM)}×${Math.round(size.hMM)}mm`,
              })}
            </p>
          ) : null}
        </fieldset>

        {/* Background + adjustments */}
        <fieldset className="flex flex-col gap-3">
          <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("pp.bgLabel")}
          </Label>
          <RadioGroup
            value={style.background}
            onValueChange={(value) => apply({ background: value as PassportStyle["background"] })}
            className="grid grid-cols-2 gap-2"
          >
            <label
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-2 rounded-btn border p-2.5 text-xs outline-none transition-colors",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                style.background === "white"
                  ? "border-cat-create/60 bg-cat-create/10"
                  : "border-border bg-card hover:border-cat-create/40"
              )}
            >
              <RadioGroupItem value="white" />
              {t("pp.bgWhite")}
            </label>
            <label
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-2 rounded-btn border p-2.5 text-xs outline-none transition-colors",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                style.background === "original"
                  ? "border-cat-create/60 bg-cat-create/10"
                  : "border-border bg-card hover:border-cat-create/40"
              )}
            >
              <RadioGroupItem value="original" />
              {t("pp.bgOriginal")}
            </label>
          </RadioGroup>
          {style.background === "white" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pp-tolerance" className="text-xs font-medium text-foreground">
                {t("pp.whiteToleranceLabel")}
              </Label>
              <Slider
                id="pp-tolerance"
                value={[style.whiteTolerance]}
                min={0}
                max={WHITE_TOLERANCE_MAX}
                step={1}
                onValueChange={([value]) => apply({ whiteTolerance: value })}
                aria-label={t("pp.whiteToleranceLabel")}
              />
              <p className="text-[10px] text-muted-foreground">
                {t("pp.whiteToleranceHint")} ({style.whiteTolerance})
              </p>
              {washedZero ? (
                <p className="flex items-start gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  {t("pp.washNone")}
                </p>
              ) : null}
              <p className="text-[11px] text-muted-foreground">{t("pp.whiteNote")}</p>
            </div>
          ) : null}

          <div className="mt-2 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pp-brightness" className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Sun className="size-3.5 text-muted-foreground" aria-hidden="true" />
                {t("pp.brightnessLabel")}
              </Label>
              <Slider
                id="pp-brightness"
                value={[style.brightness]}
                min={-ADJUST_MAX}
                max={ADJUST_MAX}
                step={1}
                onValueChange={([value]) => apply({ brightness: value })}
                disabled={!bitmap}
                aria-label={t("pp.brightnessLabel")}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pp-contrast" className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Contrast className="size-3.5 text-muted-foreground" aria-hidden="true" />
                {t("pp.contrastLabel")}
              </Label>
              <Slider
                id="pp-contrast"
                value={[style.contrast]}
                min={-ADJUST_MAX}
                max={ADJUST_MAX}
                step={1}
                onValueChange={([value]) => apply({ contrast: value })}
                disabled={!bitmap}
                aria-label={t("pp.contrastLabel")}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">{t("pp.adjustNote")}</p>
          </div>
        </fieldset>

        {/* Sheet options */}
        <fieldset className="flex flex-col gap-3 sm:col-span-2 sm:grid sm:grid-cols-2">
          <label className="flex items-start gap-3 rounded-btn border border-border bg-card p-3">
            <Switch
              checked={style.cutGuides}
              onCheckedChange={(checked) => apply({ cutGuides: checked })}
              aria-label={t("pp.cutGuidesLabel")}
              className="mt-0.5"
            />
            <span className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <Scissors className="size-3.5 text-muted-foreground" aria-hidden="true" />
                {t("pp.cutGuidesLabel")}
              </span>
              <span className="text-[11px] text-muted-foreground">{t("pp.cutGuidesHint")}</span>
            </span>
          </label>
          <label className="flex items-start gap-3 rounded-btn border border-border bg-card p-3">
            <Switch
              checked={style.infoLine}
              onCheckedChange={(checked) => apply({ infoLine: checked })}
              aria-label={t("pp.infoLineLabel")}
              className="mt-0.5"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-xs font-semibold text-foreground">{t("pp.infoLineLabel")}</span>
              <span className="text-[11px] text-muted-foreground">{t("pp.infoLineHint")}</span>
            </span>
          </label>
        </fieldset>
      </div>

      {/* Previews — the final photo + the print sheet */}
      <div className="grid gap-4 rounded-card border border-border bg-card p-4 sm:grid-cols-[220px_1fr] sm:items-start">
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("pp.previewLabel")}
          </h3>
          <canvas
            ref={photoCanvasRef}
            role="img"
            aria-label={t("pp.previewAlt")}
            className="w-[220px] max-w-full rounded-btn border border-border bg-white shadow-sm"
          />
          <p className="text-[11px] text-muted-foreground">
            {t("pp.dpiNote", { px: pxNote })}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("pp.sheetPreviewLabel")}
          </h3>
          {sheetBlocked ? (
            <p className="flex items-center justify-center rounded-btn border border-dashed border-border bg-muted/30 px-6 py-10 text-xs text-muted-foreground">
              {t("pp.sheetTooSmall", {
                size: `${Math.round(size.wMM)}×${Math.round(size.hMM)}mm`,
              })}
            </p>
          ) : (
            <canvas
              ref={sheetCanvasRef}
              role="img"
              aria-label={t("pp.sheetPreviewAlt")}
              className="w-[240px] max-w-full rounded-btn border border-border bg-white shadow-sm"
            />
          )}
        </div>
      </div>
    </section>
  );
}

export default PassportPhotoSurface;
