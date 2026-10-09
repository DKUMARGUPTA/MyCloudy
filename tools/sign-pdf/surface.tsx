"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar,
  Check,
  Loader2,
  Lock,
  MousePointerClick,
  PenTool,
  Plus,
  Signature,
  Trash2,
  TriangleAlert,
  Type as TypeIcon,
  UserRound,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import {
  getPdfPageCount,
  getPdfPagePixelSize,
  renderPdfThumbnail,
} from "@/lib/pdf/thumbnails";
import { cn } from "@/lib/utils";
import { loadFillProfile } from "../fill-out-pdf/profile";
import {
  PreviewFileHeader,
  PreviewPageStrip,
  PreviewZoomControl,
} from "../stamp-common/preview-parts";
import {
  type SignPlacement,
  parsePlacementsOption,
  placementTargets,
  placementsOnPage,
} from "./engine";
import { renderCheckmark, renderTextSignature } from "./raster";
import { SignatureDialog } from "./signature-dialog";
import {
  type StoredSignature,
  addSignature,
  listSignatures,
  removeSignature,
  subscribeSignatures,
} from "./signature-store";

/**
 * Sign PDF live surface (PRD §7.6): page preview with click-to-place
 * signatures, direct-manipulation boxes (drag / resize handle / rotate
 * handle / delete), a quick-stamp rail (date, name, initials, checkmark)
 * and a per-placement inspector (pages, size, rotation, opacity).
 *
 * Placements live in the shell options under "p:<fileId>" as JSON —
 * replacing the file can never leak placements into another document.
 * The PNG signatures themselves ride the run as assets, never options.
 */

const PREVIEW_MAX_DIM = 560;
const ZOOM_STEPS = [1, 1.5, 2] as const;
const KEY_PREFIX = "p:";
const SIGKEY_ID = "sigkey";

type DragMode = "move" | "resize" | "rotate";

interface DragState {
  mode: DragMode;
  id: string;
  orig: SignPlacement;
  grabDx: number;
  grabDy: number;
}

interface Base {
  file: File;
  pageIndex: number;
  bitmap: ImageBitmap;
  dispW: number;
  dispH: number;
}

let placementSeq = 0;
const nextPlacementId = (): string =>
  `pl${Date.now().toString(36)}${(placementSeq += 1).toString(36)}`;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function SignSurface(props: ToolSurfaceProps): React.JSX.Element | null {
  const { files, values, onChange, setFileOrder, setRunBlocked } = props;
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const file = files.length > 0 ? files[0].file : null;
  const fileId = files.length > 0 ? files[0].id : "";

  const [pageCount, setPageCount] = useState(0);
  const [selectedPage, setSelectedPage] = useState(0);
  const [zoom, setZoom] = useState<number>(1);
  const [base, setBase] = useState<Base | null>(null);
  const [failed, setFailed] = useState<{ file: File; pageIndex: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const [signatures, setSignatures] = useState<StoredSignature[]>(() =>
    typeof window === "undefined" ? [] : listSignatures()
  );
  const [armedId, setArmedId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [angleFlash, setAngleFlash] = useState<number | null>(null);
  const [profileName, setProfileName] = useState("");

  // --- Library subscription (draw/type/upload saves, removals) ----------
  useEffect(() => {
    const sync = (): void => setSignatures([...listSignatures()]);
    sync();
    return subscribeSignatures(sync);
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setProfileName(loadFillProfile().name);
    }
  }, []);

  // --- Placements (option "p:<fileId>") ---------------------------------
  const placementsKey = `${KEY_PREFIX}${fileId}`;
  const placements = useMemo(
    () => parsePlacementsOption(file ? values[placementsKey] : undefined),
    [file, values, placementsKey]
  );

  const commit = useCallback(
    (next: SignPlacement[]): void => {
      onChange(placementsKey, JSON.stringify(next));
    },
    [onChange, placementsKey]
  );

  // Stamp the current file id so the worker only reads this document's
  // placements — replacing the file can never leak them across.
  useEffect(() => {
    if (fileId !== "") onChange(SIGKEY_ID, fileId);
  }, [fileId, onChange]);

  // --- Page count + preview ---------------------------------------------
  const [pageError, setPageError] = useState<null | "password" | "corrupt">(null);
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setPageError(null);
    void (async () => {
      const count = await getPdfPageCount(file);
      if (cancelled) return;
      setPageCount(count);
      setSelectedPage((page) => Math.min(page, Math.max(0, count - 1)));
    })().catch((error: unknown) => {
      if (cancelled) return;
      // PasswordException arrives as the PdfParseError cause — the whole
      // preview pipeline would otherwise hang on pageCount 0.
      const cause = (error as { cause?: unknown })?.cause;
      const name =
        (cause as { name?: string } | undefined)?.name ??
        (error as { name?: string } | undefined)?.name ??
        "";
      const message = String((error as Error)?.message ?? "");
      setPageError(
        name === "PasswordException" || /password/i.test(message)
          ? "password"
          : "corrupt"
      );
      setPageCount(0);
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  useEffect(() => {
    if (!file || pageCount === 0) return;
    let cancelled = false;
    void (async () => {
      const [thumb, pixel] = await Promise.all([
        renderPdfThumbnail(file, {
          pageIndex: selectedPage,
          maxDim: Math.round(PREVIEW_MAX_DIM * zoom),
        }),
        getPdfPagePixelSize(file, 1, selectedPage),
      ]);
      if (cancelled) return;
      const bitmap = await createImageBitmap(thumb.blob);
      if (cancelled) return;
      setFailed(null);
      setBase({ file, pageIndex: selectedPage, bitmap, dispW: pixel.width, dispH: pixel.height });
    })().catch(() => {
      if (!cancelled) {
        setFailed({ file, pageIndex: selectedPage });
        setBase(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [file, pageCount, selectedPage, zoom]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
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

  // --- CTA gating --------------------------------------------------------
  const blockedKey =
    !file || placements.length > 0 ? null : "sign.ctaNoSignatures";
  useEffect(() => {
    setRunBlocked(blockedKey);
  }, [blockedKey, setRunBlocked]);

  // --- Derived helpers ---------------------------------------------------
  const sigById = useMemo(() => {
    const map = new Map<string, StoredSignature>();
    for (const sig of signatures) map.set(sig.id, sig);
    return map;
  }, [signatures]);

  const current =
    base !== null && base.file === file && base.pageIndex === selectedPage ? base : null;
  const pagePlacements = useMemo(
    () => placementsOnPage(placements, selectedPage, pageCount),
    [placements, selectedPage, pageCount]
  );

  const markedPages = useMemo(() => {
    const set = new Set<number>();
    for (const p of placements) {
      const targets = placementTargets(p, pageCount);
      if (targets) for (const i of targets) set.add(i);
    }
    return set;
  }, [placements, pageCount]);

  const armed = armedId !== null ? sigById.get(armedId) ?? null : null;
  const selected = selectedId !== null ? placements.find((p) => p.id === selectedId) ?? null : null;

  // --- Placement actions -------------------------------------------------
  const placeAt = useCallback(
    (fx: number, fy: number): void => {
      if (!armed || !file) return;
      const next: SignPlacement = {
        id: nextPlacementId(),
        sigId: armed.id,
        cx: Math.min(Math.max(fx, 0.05), 0.95),
        cy: Math.min(Math.max(fy, 0.05), 0.95),
        w: 0.25,
        rot: 0,
        op: 1,
        pages: "this",
        pageIndex: selectedPage,
      };
      commit([...placements, next]);
      setSelectedId(next.id);
    },
    [armed, commit, file, placements, selectedPage]
  );

  const updatePlacement = useCallback(
    (id: string, patch: Partial<SignPlacement>): void => {
      commit(
        placements.map((p) =>
          p.id === id
            ? { ...p, ...patch, range: patch.range ?? (patch.pages === "range" ? p.range : undefined) }
            : p
        )
      );
    },
    [commit, placements]
  );

  const removePlacement = useCallback(
    (id: string): void => {
      commit(placements.filter((p) => p.id !== id));
      if (selectedId === id) setSelectedId(null);
    },
    [commit, placements, selectedId]
  );

  const handleRemoveSignature = useCallback(
    (id: string): void => {
      removeSignature(id);
      if (armedId === id) setArmedId(null);
      const stillUsed = placements.some((p) => p.sigId === id);
      if (stillUsed) commit(placements.filter((p) => p.sigId !== id));
    },
    [armedId, commit, placements]
  );

  // --- Overlay pointer machinery (place / drag / resize / rotate) --------
  const fractionPos = (event: React.PointerEvent<Element>): { fx: number; fy: number } => {
    const overlay = overlayRef.current;
    if (!overlay) return { fx: 0, fy: 0 };
    const box = overlay.getBoundingClientRect();
    return {
      fx: (event.clientX - box.left) / box.width,
      fy: (event.clientY - box.top) / box.height,
    };
  };

  const handleOverlayPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!current || event.button !== 0) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    // Only empty-canvas clicks place — boxes stop propagation.
    const { fx, fy } = fractionPos(event);
    try {
      overlay.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers — the overlay handlers still cover the gesture.
    }
    if (armed) {
      placeAt(fx, fy);
      event.preventDefault();
    } else {
      setSelectedId(null);
    }
  };

  const beginBoxDrag =
    (mode: DragMode, placement: SignPlacement) =>
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (!current || event.button !== 0 || drag) return;
      event.stopPropagation();
      const overlay = overlayRef.current;
      if (!overlay) return;
      try {
        overlay.setPointerCapture(event.pointerId);
      } catch {
        // See above — non-capturable pointers still drag via overlay.
      }
      const { fx, fy } = fractionPos(event);
      setSelectedId(placement.id);
      setArmedId(null);
      setDrag({
        mode,
        id: placement.id,
        orig: placement,
        grabDx: fx - placement.cx,
        grabDy: fy - placement.cy,
      });
      event.preventDefault();
    };

  const handleOverlayPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!drag) return;
    const { fx, fy } = fractionPos(event);
    const { orig, mode } = drag;
    switch (mode) {
      case "move": {
        const cx = Math.min(Math.max(fx - drag.grabDx, 0), 1);
        const cy = Math.min(Math.max(fy - drag.grabDy, 0), 1);
        setDrag({ ...drag, orig: { ...orig, cx, cy } });
        break;
      }
      case "resize": {
        const leftEdge = orig.cx - orig.w / 2;
        const w = Math.min(Math.max((fx - leftEdge) / 1, 0.05), 1.2);
        setDrag({ ...drag, orig: { ...orig, w } });
        break;
      }
      case "rotate": {
        const dx = fx - orig.cx;
        const dy = fy - orig.cy;
        let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
        // Snap to 15° steps when close — signatures usually sit straight.
        const snapped = Math.round(deg / 15) * 15;
        if (Math.abs(deg - snapped) < 5) deg = snapped;
        deg = Math.round(deg * 10) / 10;
        setDrag({ ...drag, orig: { ...orig, rot: Math.min(Math.max(deg, -180), 180) } });
        setAngleFlash(deg);
        break;
      }
    }
  };

  const commitDrag = useCallback((): void => {
    if (!drag) return;
    commit(placements.map((p) => (p.id === drag.id ? drag.orig : p)));
    setDrag(null);
    if (angleFlash !== null) {
      window.setTimeout(() => setAngleFlash(null), 900);
    }
  }, [angleFlash, commit, drag, placements]);

  const handleBoxKeyDown =
    (placement: SignPlacement) =>
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const step = event.shiftKey ? 0.02 : 0.005;
      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          updatePlacement(placement.id, { cx: clampN(placement.cx - step, 0, 1) });
          break;
        case "ArrowRight":
          event.preventDefault();
          updatePlacement(placement.id, { cx: clampN(placement.cx + step, 0, 1) });
          break;
        case "ArrowUp":
          event.preventDefault();
          updatePlacement(placement.id, { cy: clampN(placement.cy - step, 0, 1) });
          break;
        case "ArrowDown":
          event.preventDefault();
          updatePlacement(placement.id, { cy: clampN(placement.cy + step, 0, 1) });
          break;
        case "Delete":
        case "Backspace":
          event.preventDefault();
          removePlacement(placement.id);
          break;
        case "Escape":
          setSelectedId(null);
          setArmedId(null);
          break;
        default:
          return;
      }
    };

  // --- Quick stamps -------------------------------------------------------
  const quickStampBusy = useRef(false);
  const quickStamp = useCallback(
    (kind: "date" | "name" | "initials" | "check"): void => {
      if (quickStampBusy.current) return;
      quickStampBusy.current = true;
      void (async () => {
        try {
          if (kind === "check") {
            const mark = renderCheckmark("#1e3a5f");
            const sig = addSignature(
              { kind: "stamp", label: t("sign.quickCheck"), dataUrl: mark.dataUrl, w: mark.w, h: mark.h },
              { persist: false }
            );
            setArmedId(sig.id);
          } else if (kind === "date") {
            const date = new Date().toLocaleDateString(
              locale === "hi" ? "hi-IN" : "en-IN",
              { day: "numeric", month: "short", year: "numeric" }
            );
            const rendered = await renderTextSignature(
              date,
              'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
              "#1e3a5f",
              88
            );
            const sig = addSignature(
              { kind: "stamp", label: date, dataUrl: rendered.dataUrl, w: rendered.w, h: rendered.h },
              { persist: false }
            );
            setArmedId(sig.id);
          } else {
            const name = profileName.trim();
            if (name.length === 0) {
              toast({ title: t("sign.quickNeedName") });
              return;
            }
            const text = kind === "initials" ? initialsOf(name) : name;
            const rendered = await renderTextSignature(text, "Great Vibes", "#111827", 96);
            const sig = addSignature(
              { kind: "stamp", label: text, dataUrl: rendered.dataUrl, w: rendered.w, h: rendered.h },
              { persist: false }
            );
            setArmedId(sig.id);
          }
        } finally {
          quickStampBusy.current = false;
        }
      })();
    },
    [locale, profileName, t, toast]
  );

  const removeFile = useCallback((): void => {
    setFileOrder([]);
  }, [setFileOrder]);

  if (!file) return null;

  const aspectOf = (sigId: string): number => {
    const sig = sigById.get(sigId);
    if (!sig || sig.h <= 0) return 0.4;
    return sig.w / sig.h; // width/height — height fraction derives from it
  };

  const renderPlacementBox = (placement: SignPlacement): React.JSX.Element | null => {
    const sig = sigById.get(placement.sigId);
    if (!sig) return null;
    const live = drag !== null && drag.id === placement.id ? drag.orig : placement;
    const aspectW = aspectOf(placement.sigId); // w/h
    const hFrac =
      (live.w * (current ? current.dispW / current.dispH : 1)) / Math.max(aspectW, 0.05);
    const isSel = selectedId === placement.id;
    return (
      <div
        key={placement.id}
        role="group"
        aria-label={t("sign.placementBox", { label: sig.label })}
        tabIndex={0}
        className={cn(
          "absolute rounded-[3px] outline-none transition-shadow",
          isSel
            ? "z-20 ring-2 ring-primary"
            : "z-10 ring-1 ring-primary/25 hover:ring-primary/60"
        )}
        style={{
          left: `${(live.cx - live.w / 2) * 100}%`,
          top: `${(live.cy - hFrac / 2) * 100}%`,
          width: `${live.w * 100}%`,
          height: `${hFrac * 100}%`,
          transform: `rotate(${live.rot}deg)`,
          cursor: drag?.mode === "move" ? "grabbing" : "grab",
          touchAction: "none",
        }}
        onPointerDown={beginBoxDrag("move", placement)}
        onKeyDown={handleBoxKeyDown(placement)}
      >
        { }
        <img
          src={sig.dataUrl}
          alt=""
          draggable={false}
          className="pointer-events-none h-full w-full select-none object-contain"
          style={{ opacity: live.op }}
        />
        {isSel ? (
          <>
            <button
              type="button"
              aria-label={t("sign.deletePlacement")}
              className="absolute -right-3 -top-3 z-30 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition-transform hover:scale-110"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                removePlacement(placement.id);
              }}
            >
              <span className="sr-only">{t("sign.deletePlacement")}</span>
              <span aria-hidden="true" className="text-sm leading-none">
                ×
              </span>
            </button>
            <span
              role="button"
              aria-label={t("sign.resizeHandle")}
              className="absolute -bottom-2 -right-2 z-30 size-4 cursor-nwse-resize rounded-full border-2 border-primary bg-background shadow"
              onPointerDown={beginBoxDrag("resize", placement)}
            />
            <span
              role="button"
              aria-label={t("sign.rotateHandle")}
              className="absolute -top-8 left-1/2 z-30 size-4 -translate-x-1/2 cursor-grab rounded-full border-2 border-primary bg-background shadow"
              onPointerDown={beginBoxDrag("rotate", placement)}
            />
            {angleFlash !== null && drag?.id === placement.id && drag.mode === "rotate" ? (
              <span className="absolute -top-8 left-1/2 z-30 -translate-x-1/2 -translate-y-5 rounded-btn bg-primary px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-primary-foreground">
                {Math.round(live.rot)}°
              </span>
            ) : null}
          </>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <PreviewFileHeader
        file={file}
        pageCount={pageCount}
        onRemove={removeFile}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* ---- Preview column ---- */}
        <div className="flex min-w-0 flex-col gap-3">
          {pageCount > 1 ? (
            <PreviewPageStrip
              file={file}
              pageCount={pageCount}
              selected={selectedPage}
              onSelect={setSelectedPage}
              markedSet={markedPages}
            />
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
              {armed ? (
                <>
                  <MousePointerClick
                    className="size-3.5 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  <span className="truncate">
                    {t("sign.armHint", { label: armed.label })}
                  </span>
                </>
              ) : (
                <>
                  <Signature
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="truncate">{t("sign.previewHint")}</span>
                </>
              )}
            </p>
            <PreviewZoomControl
              steps={ZOOM_STEPS}
              value={zoom}
              onChange={(next) => setZoom(next)}
            />
          </div>
          <div className="flex justify-center overflow-auto rounded-card border border-border bg-checker p-3 sm:p-4">
            {current ? (
              <div
                className="relative w-full"
                style={{ maxWidth: Math.round(560 * zoom) }}
              >
                <canvas
                  ref={canvasRef}
                  className="block h-auto w-full rounded-sm bg-white shadow-sm"
                  aria-label={t("sign.previewCanvas", { page: selectedPage + 1 })}
                  role="img"
                />
                <div
                  ref={overlayRef}
                  className={cn(
                    "absolute inset-0 touch-none",
                    armed ? "cursor-crosshair" : "cursor-default"
                  )}
                  onPointerDown={handleOverlayPointerDown}
                  onPointerMove={handleOverlayPointerMove}
                  onPointerUp={commitDrag}
                  onPointerCancel={commitDrag}
                >
                  {pagePlacements.map(renderPlacementBox)}
                </div>
              </div>
            ) : pageError === "password" ? (
              <div
                className="flex w-full items-center gap-3 px-4 py-10 text-sm text-muted-foreground"
                role="alert"
              >
                <Lock
                  className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                />
                {t("tool.errorEncrypted")}
              </div>
            ) : pageError === "corrupt" ? (
              <div
                className="flex w-full items-center gap-3 px-4 py-10 text-sm text-muted-foreground"
                role="alert"
              >
                <TriangleAlert
                  className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                />
                {t("tool.errorCorrupt")}
              </div>
            ) : failed && failed.file === file && failed.pageIndex === selectedPage ? (
              <div
                className="flex w-full items-center gap-3 px-4 py-10 text-sm text-muted-foreground"
                role="alert"
              >
                <TriangleAlert
                  className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                />
                {t("sign.previewFailed")}
              </div>
            ) : (
              <div
                className="flex w-full items-center gap-3 px-4 py-10 text-sm text-muted-foreground"
                role="status"
              >
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                {t("sign.previewLoading")}
              </div>
            )}
          </div>
          {placements.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("sign.placedCount", { count: placements.length })}
            </p>
          ) : null}
        </div>

        {/* ---- Right rail ---- */}
        <div className="flex min-w-0 flex-col gap-4">
          {/* Signature library */}
          <div className="rounded-card border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">
                {t("sign.trayTitle")}
              </h3>
              <span className="text-[11px] text-muted-foreground">
                {t("sign.trayDeviceOnly")}
              </span>
            </div>
            {signatures.length > 0 ? (
              <div className="mt-3 grid grid-cols-2 gap-2">
                {signatures.map((sig) => (
                  <div
                    key={sig.id}
                    className={cn(
                      "group relative overflow-hidden rounded-btn border transition-all",
                      armedId === sig.id
                        ? "border-primary ring-2 ring-primary/30"
                        : "border-border hover:border-primary/50"
                    )}
                  >
                    <button
                      type="button"
                      className="flex h-20 w-full items-center justify-center bg-checker p-2"
                      onClick={() => {
                        setArmedId(armedId === sig.id ? null : sig.id);
                        setSelectedId(null);
                      }}
                      aria-pressed={armedId === sig.id}
                      aria-label={t("sign.trayPick", { label: sig.label })}
                    >
                      { }
                      <img
                        src={sig.dataUrl}
                        alt=""
                        draggable={false}
                        className="max-h-16 max-w-full select-none object-contain"
                      />
                    </button>
                    <div className="flex items-center justify-between gap-1 border-t border-border px-2 py-1">
                      <span className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
                        {sig.kind === "draw" ? (
                          <PenTool className="size-2.5 shrink-0" aria-hidden="true" />
                        ) : sig.kind === "upload" ? (
                          <Signature className="size-2.5 shrink-0" aria-hidden="true" />
                        ) : (
                          <TypeIcon className="size-2.5 shrink-0" aria-hidden="true" />
                        )}
                        <span className="truncate">{sig.label}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRemoveSignature(sig.id)}
                        aria-label={t("sign.trayRemove", { label: sig.label })}
                        className="shrink-0 rounded-sm p-0.5 text-muted-foreground/60 opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <Trash2 className="size-3" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 flex flex-col items-center gap-2 rounded-btn border border-dashed border-border px-3 py-6 text-center">
                <Signature className="size-6 text-muted-foreground/60" aria-hidden="true" />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("sign.trayEmpty")}
                </p>
              </div>
            )}
            <Button
              type="button"
              className="mt-3 w-full gap-1.5 rounded-btn"
              onClick={() => setDialogOpen(true)}
            >
              <Plus className="size-4" aria-hidden="true" />
              {t("sign.addSignature")}
            </Button>
          </div>

          {/* Quick stamps */}
          <div className="rounded-card border border-border bg-card p-4">
            <h3 className="text-sm font-semibold text-foreground">
              {t("sign.quickTitle")}
            </h3>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {t("sign.quickHint")}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto justify-start gap-1.5 rounded-btn py-2 text-xs"
                onClick={() => quickStamp("date")}
              >
                <Calendar className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                {t("sign.quickDate")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto justify-start gap-1.5 rounded-btn py-2 text-xs"
                onClick={() => quickStamp("name")}
              >
                <UserRound className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                {t("sign.quickName")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto justify-start gap-1.5 rounded-btn py-2 text-xs"
                onClick={() => quickStamp("initials")}
              >
                <TypeIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                {t("sign.quickInitials")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto justify-start gap-1.5 rounded-btn py-2 text-xs"
                onClick={() => quickStamp("check")}
              >
                <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                {t("sign.quickCheck")}
              </Button>
            </div>
          </div>

          {/* Selected placement inspector */}
          {selected ? (
            <div className="rounded-card border border-primary/40 bg-card p-4 ring-1 ring-primary/15">
              <h3 className="text-sm font-semibold text-foreground">
                {t("sign.editTitle")}
              </h3>
              <div className="mt-3 flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sign-pages" className="text-xs font-medium">
                    {t("sign.pagesLabel")}
                  </Label>
                  <Select
                    value={selected.pages}
                    onValueChange={(v) =>
                      updatePlacement(selected.id, {
                        pages: v as SignPlacement["pages"],
                      })
                    }
                  >
                    <SelectTrigger id="sign-pages" className="h-10 w-full rounded-btn">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="this">{t("sign.pagesThis")}</SelectItem>
                      <SelectItem value="all">{t("sign.pagesAll")}</SelectItem>
                      <SelectItem value="odd">{t("sign.pagesOdd")}</SelectItem>
                      <SelectItem value="even">{t("sign.pagesEven")}</SelectItem>
                      <SelectItem value="range">{t("sign.pagesRange")}</SelectItem>
                    </SelectContent>
                  </Select>
                  {selected.pages === "range" ? (
                    <Input
                      value={selected.range ?? ""}
                      onChange={(e) =>
                        updatePlacement(selected.id, { range: e.target.value })
                      }
                      placeholder={t("tool.pagesPlaceholder")}
                      className="mt-1 h-10 rounded-btn"
                      aria-label={t("sign.pagesRange")}
                    />
                  ) : null}
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="sign-size" className="text-xs font-medium">
                      {t("sign.sizeLabel")}
                    </Label>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {Math.round(selected.w * 100)}%
                    </span>
                  </div>
                  <Slider
                    id="sign-size"
                    value={[Math.round(selected.w * 100)]}
                    min={5}
                    max={100}
                    step={1}
                    onValueChange={([v]) =>
                      updatePlacement(selected.id, { w: v / 100 })
                    }
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="sign-rot" className="text-xs font-medium">
                      {t("sign.rotationLabel")}
                    </Label>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {Math.round(selected.rot)}°
                    </span>
                  </div>
                  <Slider
                    id="sign-rot"
                    value={[Math.round(selected.rot)]}
                    min={-90}
                    max={90}
                    step={1}
                    onValueChange={([v]) => updatePlacement(selected.id, { rot: v })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="sign-op" className="text-xs font-medium">
                      {t("sign.opacityLabel")}
                    </Label>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {Math.round(selected.op * 100)}%
                    </span>
                  </div>
                  <Slider
                    id="sign-op"
                    value={[Math.round(selected.op * 100)]}
                    min={20}
                    max={100}
                    step={5}
                    onValueChange={([v]) => updatePlacement(selected.id, { op: v / 100 })}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5 rounded-btn text-destructive hover:text-destructive"
                  onClick={() => removePlacement(selected.id)}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  {t("sign.deletePlacement")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-card border border-border bg-card p-4">
              <h3 className="text-sm font-semibold text-foreground">
                {t("sign.editEmptyTitle")}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t("sign.editEmptyBody")}
              </p>
            </div>
          )}
        </div>
      </div>

      <SignatureDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        profileName={profileName}
        onCreated={(sig) => {
          setArmedId(sig.id);
          toast({ title: t("sign.createdToast", { label: sig.label }) });
        }}
      />
    </div>
  );
}

function clampN(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
