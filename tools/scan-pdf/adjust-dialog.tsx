"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Crop, Loader2, RefreshCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  applyFilter,
  detectDocumentQuad,
  isConvexQuad,
  suggestOutputSize,
  toGray,
  warpPerspective,
  type FilterKind,
  type ImageDataLike,
  type Quad,
} from "./engine";

/**
 * Scan to PDF — the adjust dialog (PRD §7.3): the captured frame (or a
 * gallery photo, or a stored original when re-editing a page) shown
 * with four draggable corner handles, the auto-detected document quad
 * as the starting suggestion, a LIVE cropped preview (warp + filter —
 * exactly the engine the worker runs) and filter chips. "Use page"
 * warps the FULL-resolution original through that same engine and
 * re-encodes it as JPEG 0.92; naming and shell routing stay in the
 * surface. Full-screen sheet on mobile, centered dialog from sm: up.
 *
 * Quads are stored as FRACTIONS of the frame (0..1) and converted to
 * pixels only for the pure engine. Fraction space is a
 * positive-diagonal linear rescale of pixel space, so convexity and
 * winding checks are valid there directly.
 */

export interface ScanAdjustTarget {
  /** Remount key — a fresh dialog state per capture/photo. */
  uid: string;
  /** The untouched source: camera frame blob, gallery File, or a stored original. */
  original: Blob | File;
  /** Existing page file name being re-edited (keeps its slot in the strip). */
  replaceName: string | null;
  /** True when a live camera is waiting behind the dialog ("Retake"). */
  fromCamera: boolean;
  /** 1-based position within a gallery batch (0 when not from a batch). */
  queueIndex: number;
  queueTotal: number;
}

export interface ScanAdjustResult {
  blob: Blob;
  width: number;
  height: number;
  filter: FilterKind;
}

interface ScanAdjustDialogProps {
  target: ScanAdjustTarget | null;
  /** Chip the dialog starts on — the export filter keeps expectations aligned. */
  initialFilter: FilterKind;
  /** Retake / cancel / dialog close. */
  onClose: () => void;
  /** "Use page" — the surface names the file and routes it via addFiles. */
  onApply: (result: ScanAdjustResult, target: ScanAdjustTarget) => void;
}

const FILTERS: { kind: FilterKind; labelKey: string }[] = [
  { kind: "original", labelKey: "scan.filterOriginal" },
  { kind: "magic", labelKey: "scan.filterMagic" },
  { kind: "grayscale", labelKey: "scan.filterGrayscale" },
  { kind: "bw", labelKey: "scan.filterBlackWhite" },
];

const CORNER_KEYS = ["tl", "tr", "br", "bl"] as const;
type CornerKey = (typeof CORNER_KEYS)[number];

const CORNER_LABEL_KEYS: Record<CornerKey, string> = {
  tl: "scan.cornerTl",
  tr: "scan.cornerTr",
  br: "scan.cornerBr",
  bl: "scan.cornerBl",
};

/** Longest side of the live preview source / output (per-drag cost bound). */
const PREVIEW_SRC_DIM = 560;
const PREVIEW_OUT_DIM = 420;

interface DecodedFrame {
  full: ImageDataLike;
  preview: ImageDataLike;
  url: string;
  detected: Quad; // fraction space
}

function pixelsFrom(
  source: CanvasImageSource,
  width: number,
  height: number
): ImageDataLike {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("scan: no 2d context");
  ctx.drawImage(source, 0, 0, width, height);
  const raw = ctx.getImageData(0, 0, width, height);
  return { data: raw.data, width, height };
}

async function decodeForAdjust(original: Blob | File): Promise<DecodedFrame> {
  // "from-image" bakes EXIF orientation into the pixels, so gallery
  // photos with a rotation flag display (and warp) upright — the same
  // guarantee the export worker gets from its decoder.
  const bitmap = await createImageBitmap(original, {
    imageOrientation: "from-image",
  });
  try {
    const { width, height } = bitmap;
    const full = pixelsFrom(bitmap, width, height);
    const scale = Math.min(1, PREVIEW_SRC_DIM / Math.max(width, height));
    const preview = pixelsFrom(
      bitmap,
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale))
    );
    const detectedPx = detectDocumentQuad(toGray(full), width, height);
    return {
      full,
      preview,
      url: URL.createObjectURL(original),
      detected: {
        tl: { x: detectedPx.tl.x / width, y: detectedPx.tl.y / height },
        tr: { x: detectedPx.tr.x / width, y: detectedPx.tr.y / height },
        br: { x: detectedPx.br.x / width, y: detectedPx.br.y / height },
        bl: { x: detectedPx.bl.x / width, y: detectedPx.bl.y / height },
      },
    };
  } finally {
    bitmap.close();
  }
}

function toPixelQuad(quad: Quad, width: number, height: number): Quad {
  return {
    tl: { x: quad.tl.x * width, y: quad.tl.y * height },
    tr: { x: quad.tr.x * width, y: quad.tr.y * height },
    br: { x: quad.br.x * width, y: quad.br.y * height },
    bl: { x: quad.bl.x * width, y: quad.bl.y * height },
  };
}

/**
 * Builds a DOM ImageData from an ImageDataLike. The ImageData constructor
 * needs Uint8ClampedArray<ArrayBuffer> (TS 5.9 generics), while
 * ImageDataLike.data is widened to ArrayBufferLike — so the backing buffer
 * is rebuilt honestly via new ArrayBuffer(n) (never a cast) and the pixels
 * copied in. Cost is one buffer copy per preview frame / final encode.
 */
function toImageData(source: ImageDataLike): ImageData {
  const data = new Uint8ClampedArray(new ArrayBuffer(source.data.length));
  data.set(source.data);
  return new ImageData(data, source.width, source.height);
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

export function ScanAdjustDialog(props: ScanAdjustDialogProps): React.JSX.Element {
  const { target, onClose } = props;
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-3 overflow-y-auto rounded-none p-4 pb-6 sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[92vh] sm:w-full sm:max-w-3xl sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:p-6"
      >
        {target ? (
          <AdjustBody key={target.uid} target={target} initialFilter={props.initialFilter} onClose={onClose} onApply={props.onApply} />
        ) : (
          <div aria-hidden="true" className="h-4" />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AdjustBody({
  target,
  initialFilter,
  onClose,
  onApply,
}: Omit<ScanAdjustDialogProps, "target"> & { target: ScanAdjustTarget }): React.JSX.Element {
  const { t } = useI18n();
  const { toast } = useToast();

  const [frame, setFrame] = useState<DecodedFrame | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [filter, setFilter] = useState<FilterKind>(initialFilter);
  const [busy, setBusy] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);

  // Decode the original once per mount. Every setState lands inside the
  // async callbacks — never synchronously in the effect body — and the
  // object URL is revoked on unmount (also when the decode resolves
  // after the component is already gone).
  useEffect(() => {
    let cancelled = false;
    let claimedUrl: string | null = null;
    void (async () => {
      try {
        const decoded = await decodeForAdjust(target.original);
        if (cancelled) {
          URL.revokeObjectURL(decoded.url);
          return;
        }
        claimedUrl = decoded.url;
        setFrame(decoded);
        setQuad(decoded.detected);
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (claimedUrl) URL.revokeObjectURL(claimedUrl);
    };
  }, [target]);

  /* ---- live cropped preview (the same engine the export runs) ---- */
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas || !frame || !quad) return;
    try {
      const pixelQuad = toPixelQuad(quad, frame.preview.width, frame.preview.height);
      const size = suggestOutputSize(pixelQuad);
      const scale = Math.min(1, PREVIEW_OUT_DIM / Math.max(size.width, size.height));
      const warped = warpPerspective(
        frame.preview,
        pixelQuad,
        Math.max(1, Math.round(size.width * scale)),
        Math.max(1, Math.round(size.height * scale))
      );
      const filtered = applyFilter(warped, filter);
      canvas.width = filtered.width;
      canvas.height = filtered.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.putImageData(toImageData(filtered), 0, 0);
    } catch {
      // A degenerate mid-drag quad keeps the last good preview on
      // screen; "Use page" stays disabled until the quad is valid.
    }
  }, [frame, quad, filter]);

  /* ---- corner dragging (pointer capture, the sign-pdf approach) ---- */
  const cornerPointerDown =
    (corner: CornerKey) => (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointers — move/up still fire on the handle itself.
      }
    };

  const cornerPointerMove =
    (corner: CornerKey) => (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.buttons === 0) return; // hover, not a drag
      const wrap = wrapRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const fx = clamp01((event.clientX - rect.left) / rect.width);
      const fy = clamp01((event.clientY - rect.top) / rect.height);
      setQuad((current) =>
        current ? { ...current, [corner]: { x: fx, y: fy } } : current
      );
    };

  const cornerKeyDown =
    (corner: CornerKey) => (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const step = event.shiftKey ? 0.02 : 0.005;
      let dx = 0;
      let dy = 0;
      switch (event.key) {
        case "ArrowLeft":
          dx = -step;
          break;
        case "ArrowRight":
          dx = step;
          break;
        case "ArrowUp":
          dy = -step;
          break;
        case "ArrowDown":
          dy = step;
          break;
        default:
          return;
      }
      event.preventDefault();
      setQuad((current) =>
        current
          ? {
              ...current,
              [corner]: {
                x: clamp01(current[corner].x + dx),
                y: clamp01(current[corner].y + dy),
              },
            }
          : current
      );
    };

  const resetCorners = useCallback(() => {
    if (frame) setQuad(frame.detected);
  }, [frame]);

  /* ---- "Use page": full-res warp + filter + JPEG 0.92 ---- */
  const convex = quad !== null && isConvexQuad(quad);

  const handleUsePage = useCallback((): void => {
    if (!frame || !quad || busy || !convex) return;
    setBusy(true);
    void (async () => {
      try {
        const pixelQuad = toPixelQuad(quad, frame.full.width, frame.full.height);
        const size = suggestOutputSize(pixelQuad);
        const warped = warpPerspective(frame.full, pixelQuad, size.width, size.height);
        const filtered = applyFilter(warped, filter);
        const canvas = document.createElement("canvas");
        canvas.width = filtered.width;
        canvas.height = filtered.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("scan: no 2d context");
        ctx.putImageData(toImageData(filtered), 0, 0);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", 0.92)
        );
        if (!blob) throw new Error("scan: encode failed");
        onApply({ blob, width: filtered.width, height: filtered.height, filter }, target);
      } catch {
        toast({
          title: t("tool.errorTitle"),
          description: t("tool.errorGeneric", { detail: "" }),
          variant: "destructive",
        });
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, convex, filter, frame, onApply, quad, t, target, toast]);

  if (loadFailed) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <TriangleAlert className="size-6 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{t("scan.loadFailed")}</p>
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="rounded-btn"
          onClick={onClose}
        >
          {target.fromCamera ? t("scan.retake") : t("scan.cancelAdjust")}
        </Button>
      </div>
    );
  }

  const dot = (p: { x: number; y: number }): string =>
    `${(p.x * 100).toFixed(2)} ${(p.y * 100).toFixed(2)}`;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2">
          {t("scan.adjustTitle")}
          {target.queueTotal > 1 ? (
            <span className="rounded-chip bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
              {t("scan.adjustOf", {
                index: target.queueIndex,
                total: target.queueTotal,
              })}
            </span>
          ) : null}
        </DialogTitle>
        <DialogDescription className="text-xs sm:text-sm">
          {t("scan.adjustDesc")}
        </DialogDescription>
      </DialogHeader>

      {!frame || !quad ? (
        <div
          className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("scan.loadWorking")}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_230px]">
          {/* ---- editor ---- */}
          <div className="flex min-w-0 flex-col gap-2">
            <div
              ref={wrapRef}
              className="relative w-full touch-manipulation select-none overflow-hidden rounded-btn border border-border bg-muted/40"
            >
              <img
                src={frame.url}
                alt={t("scan.adjustSourceAlt")}
                draggable={false}
                decoding="async"
                className="block w-full select-none"
              />
              <svg
                className="pointer-events-none absolute inset-0 size-full"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path
                  d={`M0 0 H100 V100 H0 Z M${dot(quad.tl)} L${dot(quad.tr)} L${dot(quad.br)} L${dot(quad.bl)} Z`}
                  fill="rgba(15, 23, 42, 0.45)"
                  fillRule="evenodd"
                />
                <polygon
                  points={`${dot(quad.tl)} ${dot(quad.tr)} ${dot(quad.br)} ${dot(quad.bl)}`}
                  fill="none"
                  stroke="currentColor"
                  className="text-primary"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              {CORNER_KEYS.map((corner) => (
                <button
                  key={corner}
                  type="button"
                  aria-label={t(CORNER_LABEL_KEYS[corner])}
                  className="absolute z-10 flex size-11 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing"
                  style={{
                    left: `${quad[corner].x * 100}%`,
                    top: `${quad[corner].y * 100}%`,
                  }}
                  onPointerDown={cornerPointerDown(corner)}
                  onPointerMove={cornerPointerMove(corner)}
                  onPointerUp={(event) => {
                    try {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    } catch {
                      // Already released together with the pointer.
                    }
                  }}
                  onKeyDown={cornerKeyDown(corner)}
                >
                  <span
                    aria-hidden="true"
                    className="size-5 rounded-full border-[3px] border-primary bg-background shadow-md"
                  />
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("scan.adjustHintKeys")}
            </p>
          </div>

          {/* ---- preview + filters ---- */}
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <Crop className="size-3.5 text-primary" aria-hidden="true" />
                {t("scan.adjustPreview")}
              </span>
              <div className="flex min-h-28 items-center justify-center overflow-hidden rounded-btn border border-border bg-checker p-2">
                <canvas
                  ref={previewRef}
                  role="img"
                  aria-label={t("scan.adjustPreview")}
                  className="block max-h-44 max-w-full lg:max-h-56"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-foreground">
                {t("scan.filterLabel")}
              </span>
              <div
                className="flex flex-wrap gap-1.5"
                role="group"
                aria-label={t("scan.filterLabel")}
              >
                {FILTERS.map(({ kind, labelKey }) => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={filter === kind}
                    onClick={() => setFilter(kind)}
                    className={cn(
                      "min-h-9 rounded-btn border px-3 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      filter === kind
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-foreground hover:bg-muted"
                    )}
                  >
                    {t(labelKey)}
                  </button>
                ))}
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-auto gap-1.5 self-start rounded-btn"
              onClick={resetCorners}
              disabled={busy}
            >
              <RefreshCcw className="size-3.5" aria-hidden="true" />
              {t("scan.adjustReset")}
            </Button>
          </div>
        </div>
      )}

      {!convex && frame && quad ? (
        <p
          role="alert"
          className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {t("scan.adjustInvalidQuad")}
        </p>
      ) : null}

      <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t border-border bg-background/95 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur supports-[backdrop-filter]:bg-background/85 sm:-mx-6 sm:flex-row sm:justify-end sm:px-6 sm:pb-3">
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="rounded-btn sm:min-w-32"
          onClick={onClose}
          disabled={busy}
        >
          {target.fromCamera ? t("scan.retake") : t("scan.cancelAdjust")}
        </Button>
        <Button
          type="button"
          size="touch"
          className="gap-1.5 rounded-btn font-semibold sm:min-w-40"
          onClick={handleUsePage}
          disabled={busy || !frame || !quad || !convex}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : null}
          {busy ? t("scan.usePageBusy") : t("scan.usePage")}
        </Button>
      </div>
    </>
  );
}
