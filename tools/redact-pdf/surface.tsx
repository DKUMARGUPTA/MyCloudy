"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EyeOff,
  Loader2,
  Lock,
  MousePointerSquareDashed,
  Search,
  ShieldCheck,
  SquareDashed,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import {
  getPdfPageCount,
  getPdfPagePixelSize,
  renderPdfThumbnail,
} from "@/lib/pdf/thumbnails";
import { cn } from "@/lib/utils";
import {
  PreviewFileHeader,
  PreviewPageStrip,
  PreviewZoomControl,
} from "../stamp-common/preview-parts";
import {
  type RedactKind,
  type RedactMark,
  marksOnPage,
  markedPages,
} from "./engine";
import {
  type PageText,
  extractPageTexts,
  findSensitiveMarks,
  hasNoText,
} from "./search";

/**
 * Redact PDF live surface (PRD §8.4): page preview with found sensitive
 * text (translucent boxes, click to keep/skip) and hand-drawn boxes
 * (drag / resize / delete), plus a "Find" rail that scans for Aadhaar,
 * PAN, phone and email patterns or custom words.
 *
 * Marks live in the shell options under "m:<fileId>" — replacing the file
 * can never leak boxes into another document (sign's epoch-key pattern).
 */

const PREVIEW_MAX_DIM = 560;
const ZOOM_STEPS = [1, 1.5, 2] as const;
const KEY_PREFIX = "m:";
const MKEY_ID = "mkey";
/** Minimum drag (fraction of the page) that becomes a manual box. */
const MIN_DRAW = 0.02;

type BoxDrag =
  | { mode: "move"; id: string; orig: RedactMark; grabDx: number; grabDy: number }
  | { mode: "resize"; id: string; orig: RedactMark };

interface Base {
  file: File;
  pageIndex: number;
  bitmap: ImageBitmap;
  dispW: number;
  dispH: number;
}

let manualSeq = 0;
const nextManualId = (): string =>
  `b${Date.now().toString(36)}${(manualSeq += 1).toString(36)}`;

function clampN(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

export function RedactSurface(props: ToolSurfaceProps): React.JSX.Element | null {
  const { files, values, onChange, setFileOrder, setRunBlocked } = props;
  const { t } = useI18n();
  const { toast } = useToast();
  const file = files.length > 0 ? files[0].file : null;
  const fileId = files.length > 0 ? files[0].id : "";

  // --- Preview plumbing (same skeleton as sign) --------------------------
  const [pageCount, setPageCount] = useState(0);
  const [selectedPage, setSelectedPage] = useState(0);
  const [zoom, setZoom] = useState<number>(1);
  const [base, setBase] = useState<Base | null>(null);
  const [failed, setFailed] = useState<{ file: File; pageIndex: number } | null>(null);
  const [pageError, setPageError] = useState<null | "password" | "corrupt">(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // --- Marks (option "m:<fileId>") ---------------------------------------
  const marksKey = `${KEY_PREFIX}${fileId}`;
  const marks = useMemo<RedactMark[]>(() => {
    if (!file) return [];
    try {
      return JSON.parse(String(values[marksKey] ?? "[]")) as RedactMark[];
    } catch {
      return [];
    }
  }, [file, values, marksKey]);

  const commit = useCallback(
    (next: RedactMark[]): void => {
      onChange(marksKey, JSON.stringify(next));
    },
    [onChange, marksKey]
  );

  // Stamp the current file id so the worker only reads this document's
  // marks — replacing the file can never leak them across.
  useEffect(() => {
    if (fileId !== "") onChange(MKEY_ID, fileId);
  }, [fileId, onChange]);

  // --- Search state ------------------------------------------------------
  const [textPages, setTextPages] = useState<PageText[] | null>(null);
  const [textState, setTextState] = useState<"idle" | "extracting" | "ready" | "error">("idle");
  const [presets, setPresets] = useState({ aadhaar: true, pan: true, phone: true, email: true });
  const [customTerms, setCustomTerms] = useState("");
  const [searchSummary, setSearchSummary] = useState<{
    count: number;
    pages: number;
  } | null>(null);

  // --- Page count + preview ----------------------------------------------
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      setPageError(null);
      const count = await getPdfPageCount(file);
      if (cancelled) return;
      setPageCount(count);
      setSelectedPage((page) => Math.min(page, Math.max(0, count - 1)));
    })().catch((error: unknown) => {
      if (cancelled) return;
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

  // --- Text extraction for search (main thread, cached per File) ---------
  useEffect(() => {
    if (!file || pageError !== null) return;
    let cancelled = false;
    void (async () => {
      setTextPages(null);
      setSearchSummary(null);
      setTextState("extracting");
      const pages = await extractPageTexts(file);
      if (cancelled) return;
      setTextPages(pages);
      setTextState("ready");
    })().catch(() => {
      if (!cancelled) setTextState("error");
    });
    return () => {
      cancelled = true;
    };
  }, [file, pageError]);

  // --- CTA gating --------------------------------------------------------
  const enabledCount = useMemo(
    () => marks.filter((m) => m.enabled).length,
    [marks]
  );
  useEffect(() => {
    setRunBlocked(enabledCount > 0 || !file ? null : "redact.ctaNoMarks");
  }, [enabledCount, file, setRunBlocked]);

  // --- Derived ------------------------------------------------------------
  const current =
    base !== null && base.file === file && base.pageIndex === selectedPage ? base : null;
  const pageMarks = useMemo(
    () => marksOnPage(marks, selectedPage),
    [marks, selectedPage]
  );
  const flaggedPages = useMemo(() => markedPages(marks), [marks]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => marks.find((m) => m.id === selectedId) ?? null,
    [marks, selectedId]
  );
  /** The inspector only shows a selection on ITS page (derived, no effect). */
  const selectedLive = selected && selected.page === selectedPage ? selected : null;
  const [drawing, setDrawing] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const [boxDrag, setBoxDrag] = useState<BoxDrag | null>(null);

  /** Live geometry while dragging (sign's pattern: state during, commit once). */
  const liveOf = (mark: RedactMark): RedactMark =>
    boxDrag?.id === mark.id ? boxDrag.orig : mark;

  const kindLabel = useCallback(
    (kind: RedactKind): string =>
      t(
        kind === "aadhaar"
          ? "redact.kindAadhaar"
          : kind === "pan"
            ? "redact.kindPan"
            : kind === "phone"
              ? "redact.kindPhone"
              : kind === "email"
                ? "redact.kindEmail"
                : kind === "text"
                  ? "redact.kindText"
                  : "redact.kindManual"
      ),
    [t]
  );

  // --- Search --------------------------------------------------------------
  const runFind = useCallback((): void => {
    if (textState !== "ready" || !textPages) {
      return;
    }
    const terms = customTerms
      .split(/\r?\n/)
      .map((term) => term.trim())
      .filter((term) => term.length > 0);
    const anyActive =
      presets.aadhaar || presets.pan || presets.phone || presets.email || terms.length > 0;
    if (!anyActive) {
      toast({ description: t("redact.findNothingSelected") });
      return;
    }
    const found = findSensitiveMarks(textPages, { ...presets, terms });
    const manual = marks.filter((m) => m.kind === "manual");
    const next = [...manual, ...found];
    commit(next);
    const pages = new Set(found.map((m) => m.page)).size;
    setSearchSummary({ count: found.length, pages });
  }, [commit, customTerms, marks, presets, textPages, textState, toast, t]);

  const clearFound = useCallback((): void => {
    commit(marks.filter((m) => m.kind === "manual"));
    setSearchSummary({ count: 0, pages: 0 });
  }, [commit, marks]);

  const perKind = useMemo(() => {
    const counts = new Map<RedactKind, number>();
    for (const mark of marks) {
      if (!mark.enabled) continue;
      counts.set(mark.kind, (counts.get(mark.kind) ?? 0) + 1);
    }
    return counts;
  }, [marks]);

  // --- Mark actions --------------------------------------------------------
  const toggleMark = useCallback(
    (id: string): void => {
      commit(marks.map((m) => (m.id === id ? { ...m, enabled: !m.enabled } : m)));
    },
    [commit, marks]
  );

  const removeMark = useCallback(
    (id: string): void => {
      commit(marks.filter((m) => m.id !== id));
      if (selectedId === id) setSelectedId(null);
    },
    [commit, marks, selectedId]
  );

  const updateMark = useCallback(
    (id: string, patch: Partial<RedactMark>): void => {
      commit(marks.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    },
    [commit, marks]
  );

  // --- Overlay pointer machinery (draw / move / resize) --------------------
  const fractionPos = (event: React.PointerEvent<Element>): { fx: number; fy: number } => {
    const overlay = overlayRef.current;
    if (!overlay) return { fx: 0, fy: 0 };
    const box = overlay.getBoundingClientRect();
    return {
      fx: clampN((event.clientX - box.left) / box.width, 0, 1),
      fy: clampN((event.clientY - box.top) / box.height, 0, 1),
    };
  };

  const handleOverlayPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!current || event.button !== 0) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const { fx, fy } = fractionPos(event);
    try {
      overlay.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers — overlay handlers still cover the gesture.
    }
    setSelectedId(null);
    setDrawing({ x0: fx, y0: fy, x1: fx, y1: fy });
    event.preventDefault();
  };

  const beginBoxDrag =
    (mode: "move" | "resize", mark: RedactMark) =>
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (!current || event.button !== 0 || boxDrag) return;
      event.stopPropagation();
      const overlay = overlayRef.current;
      if (!overlay) return;
      try {
        overlay.setPointerCapture(event.pointerId);
      } catch {
        // See above.
      }
      const { fx, fy } = fractionPos(event);
      setSelectedId(mark.id);
      setDrawing(null);
      if (mode === "move") {
        setBoxDrag({
          mode,
          id: mark.id,
          orig: mark,
          grabDx: fx - mark.x,
          grabDy: fy - mark.y,
        });
      } else {
        setBoxDrag({ mode, id: mark.id, orig: mark });
      }
      event.preventDefault();
    };

  const handleOverlayPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const { fx, fy } = fractionPos(event);
    if (drawing) {
      setDrawing({ ...drawing, x1: fx, y1: fy });
      return;
    }
    if (!boxDrag) return;
    const { orig, mode } = boxDrag;
    if (mode === "move") {
      setBoxDrag({
        ...boxDrag,
        orig: {
          ...orig,
          x: clampN(fx - boxDrag.grabDx, 0, 1 - orig.w),
          y: clampN(fy - boxDrag.grabDy, 0, 1 - orig.h),
        },
      });
    } else {
      setBoxDrag({
        ...boxDrag,
        orig: {
          ...orig,
          w: Math.max(0.01, clampN(fx - orig.x, 0.01, 1 - orig.x)),
          h: Math.max(0.01, clampN(fy - orig.y, 0.01, 1 - orig.y)),
        },
      });
    }
  };

  const handleOverlayPointerUp = (): void => {
    if (drawing) {
      const x = Math.min(drawing.x0, drawing.x1);
      const y = Math.min(drawing.y0, drawing.y1);
      const w = Math.abs(drawing.x1 - drawing.x0);
      const h = Math.abs(drawing.y1 - drawing.y0);
      if (w >= MIN_DRAW && h >= MIN_DRAW) {
        const mark: RedactMark = {
          id: nextManualId(),
          page: selectedPage,
          x,
          y,
          w: Math.min(w, 1 - x),
          h: Math.min(h, 1 - y),
          kind: "manual",
          label: "",
          enabled: true,
        };
        commit([...marks, mark]);
        setSelectedId(mark.id);
      }
      setDrawing(null);
    }
    if (boxDrag) {
      commit(marks.map((m) => (m.id === boxDrag.id ? boxDrag.orig : m)));
      setBoxDrag(null);
    }
  };

  const handleBoxKeyDown =
    (mark: RedactMark) =>
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const step = event.shiftKey ? 0.02 : 0.005;
      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          updateMark(mark.id, { x: clampN(mark.x - step, 0, 1 - mark.w) });
          break;
        case "ArrowRight":
          event.preventDefault();
          updateMark(mark.id, { x: clampN(mark.x + step, 0, 1 - mark.w) });
          break;
        case "ArrowUp":
          event.preventDefault();
          updateMark(mark.id, { y: clampN(mark.y - step, 0, 1 - mark.h) });
          break;
        case "ArrowDown":
          event.preventDefault();
          updateMark(mark.id, { y: clampN(mark.y + step, 0, 1 - mark.h) });
          break;
        case "Delete":
        case "Backspace":
          event.preventDefault();
          removeMark(mark.id);
          break;
        case "Escape":
          setSelectedId(null);
          break;
        default:
          return;
      }
    };

  // --- Box renderers -------------------------------------------------------
  const renderMarkBox = (mark: RedactMark): React.JSX.Element => {
    const live = liveOf(mark);
    const isSelected = mark.id === selectedId;
    const manual = mark.kind === "manual";
    const boxStyle: React.CSSProperties = {
      left: `${live.x * 100}%`,
      top: `${live.y * 100}%`,
      width: `${live.w * 100}%`,
      height: `${live.h * 100}%`,
    };

    if (!manual) {
      return (
        <div
          key={mark.id}
          role="switch"
          aria-checked={mark.enabled}
          aria-label={t("redact.matchAria", {
            kind: kindLabel(mark.kind),
            label: mark.label.length > 0 ? mark.label : "…",
          })}
          tabIndex={0}
          title={`${kindLabel(mark.kind)}${mark.label ? `: ${mark.label}` : ""}`}
          className={cn(
            "absolute z-20 cursor-pointer rounded-[3px] border-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            mark.enabled
              ? "border-destructive bg-destructive/35 hover:bg-destructive/45"
              : "border-dashed border-muted-foreground/70 bg-transparent hover:bg-muted/40"
          )}
          style={boxStyle}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            toggleMark(mark.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleMark(mark.id);
            }
          }}
        >
          {mark.enabled ? (
            <span className="pointer-events-none absolute inset-x-0 -top-6 mx-auto w-fit rounded-btn bg-destructive px-1.5 py-0.5 text-[10px] font-semibold leading-tight text-white">
              {kindLabel(mark.kind)}
            </span>
          ) : null}
        </div>
      );
    }

    return (
      <div
        key={mark.id}
        role="button"
        aria-label={t("redact.manualAria")}
        tabIndex={0}
        className={cn(
          "absolute z-20 cursor-move rounded-[3px] border-2 outline-none",
          mark.enabled
            ? "border-destructive bg-destructive/45"
            : "border-dashed border-muted-foreground/70 bg-muted/30",
          isSelected && "border-primary ring-2 ring-primary/40"
        )}
        style={boxStyle}
        onPointerDown={beginBoxDrag("move", mark)}
        onKeyDown={handleBoxKeyDown(mark)}
      >
        {isSelected ? (
          <>
            <button
              type="button"
              aria-label={t("redact.deleteBox")}
              className="absolute -right-3 -top-3 z-30 flex size-6 items-center justify-center rounded-full bg-destructive text-white shadow-md transition-transform hover:scale-110"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                removeMark(mark.id);
              }}
            >
              <span className="sr-only">{t("redact.deleteBox")}</span>
              <span aria-hidden="true" className="text-sm leading-none">
                ×
              </span>
            </button>
            <span
              role="button"
              aria-label={t("redact.resizeHandle")}
              className="absolute -bottom-2 -right-2 z-30 size-4 cursor-nwse-resize rounded-full border-2 border-destructive bg-background shadow"
              onPointerDown={beginBoxDrag("resize", mark)}
            />
          </>
        ) : null}
      </div>
    );
  };

  const drawRect = drawing
    ? {
        x: Math.min(drawing.x0, drawing.x1),
        y: Math.min(drawing.y0, drawing.y1),
        w: Math.abs(drawing.x1 - drawing.x0),
        h: Math.abs(drawing.y1 - drawing.y0),
      }
    : null;

  const removeFile = useCallback((): void => {
    setFileOrder([]);
  }, [setFileOrder]);

  const searchDisabled = textState !== "ready";

  if (!file) return null;

  // ---------------------------------------------------------------------
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
              markedSet={flaggedPages}
            />
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
              <MousePointerSquareDashed
                className="size-3.5 shrink-0 text-primary"
                aria-hidden="true"
              />
              <span className="truncate">{t("redact.previewHint")}</span>
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
                style={{ maxWidth: Math.round(PREVIEW_MAX_DIM * zoom) }}
              >
                <canvas
                  ref={canvasRef}
                  className="block h-auto w-full rounded-sm bg-white shadow-sm"
                  aria-label={t("redact.previewCanvas", { page: selectedPage + 1 })}
                  role="img"
                />
                <div
                  ref={overlayRef}
                  className="absolute inset-0 cursor-crosshair touch-none"
                  onPointerDown={handleOverlayPointerDown}
                  onPointerMove={handleOverlayPointerMove}
                  onPointerUp={handleOverlayPointerUp}
                  onPointerCancel={handleOverlayPointerUp}
                >
                  {pageMarks.map(renderMarkBox)}
                  {drawRect && drawRect.w >= MIN_DRAW * 0.5 ? (
                    <div
                      className="absolute z-20 rounded-[3px] border-2 border-dashed border-destructive bg-destructive/20"
                      style={{
                        left: `${drawRect.x * 100}%`,
                        top: `${drawRect.y * 100}%`,
                        width: `${drawRect.w * 100}%`,
                        height: `${drawRect.h * 100}%`,
                      }}
                    />
                  ) : null}
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
                {t("redact.previewFailed")}
              </div>
            ) : (
              <div
                className="flex w-full items-center gap-3 px-4 py-10 text-sm text-muted-foreground"
                role="status"
              >
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                {t("redact.previewLoading")}
              </div>
            )}
          </div>
          {marks.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("redact.marksCount", { count: enabledCount })}
            </p>
          ) : null}
        </div>

        {/* ---- Right rail ---- */}
        <div className="flex min-w-0 flex-col gap-4">
          {/* Find sensitive text */}
          <div className="rounded-card border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <Search className="size-4 text-primary" aria-hidden="true" />
                {t("redact.findTitle")}
              </h3>
              <span className="text-[11px] text-muted-foreground">
                {t("redact.findDeviceOnly")}
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {t("redact.findHint")}
            </p>

            <div className="mt-3 grid grid-cols-2 gap-2">
              {(
                [
                  ["aadhaar", "redact.presetAadhaar"],
                  ["pan", "redact.presetPan"],
                  ["phone", "redact.presetPhone"],
                  ["email", "redact.presetEmail"],
                ] as const
              ).map(([key, labelKey]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={presets[key]}
                  onClick={() =>
                    setPresets((prev) => ({ ...prev, [key]: !prev[key] }))
                  }
                  className={cn(
                    "flex min-h-11 items-center justify-between gap-2 rounded-btn border px-3 py-2 text-xs font-medium transition-colors",
                    presets[key]
                      ? "border-primary/60 bg-primary/10 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:border-primary/40"
                  )}
                >
                  {t(labelKey)}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-4 items-center justify-center rounded-[4px] border",
                      presets[key]
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-muted-foreground/40 bg-background"
                    )}
                  >
                    {presets[key] ? (
                      <svg viewBox="0 0 12 12" className="size-3" fill="none">
                        <path
                          d="M2.5 6.5 5 9l4.5-6"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>

            <div className="mt-3">
              <Label
                htmlFor="redact-terms"
                className="text-xs font-medium text-foreground"
              >
                {t("redact.customLabel")}
              </Label>
              <Textarea
                id="redact-terms"
                value={customTerms}
                onChange={(e) => setCustomTerms(e.target.value)}
                placeholder={t("redact.customPlaceholder")}
                rows={3}
                className="mt-1.5 resize-none rounded-btn text-xs"
              />
            </div>

            <Button
              type="button"
              className="mt-3 w-full gap-1.5 rounded-btn"
              disabled={searchDisabled}
              onClick={runFind}
            >
              {textState === "extracting" ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  {t("redact.finding")}
                </>
              ) : (
                <>
                  <Search className="size-4" aria-hidden="true" />
                  {t("redact.findButton")}
                </>
              )}
            </Button>

            {textState === "error" ? (
              <p
                className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400"
                role="status"
              >
                <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                {t("redact.findError")}
              </p>
            ) : null}

            {searchSummary ? (
              <div className="mt-3 rounded-btn border border-border bg-background p-2.5">
                <p className="text-xs font-medium text-foreground">
                  {searchSummary.count > 0
                    ? t("redact.findSummary", {
                        count: searchSummary.count,
                        pages: searchSummary.pages,
                      })
                    : t("redact.findNone")}
                </p>
                {searchSummary.count > 0 && perKind.size > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {[...perKind.entries()].map(([kind, count]) => (
                      <span
                        key={kind}
                        className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[10px] text-muted-foreground"
                      >
                        {kindLabel(kind)} × {count}
                      </span>
                    ))}
                  </div>
                ) : null}
                {textPages && searchSummary.count === 0 && hasNoText(textPages) ? (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    {t("redact.findNoneScan")}
                  </p>
                ) : null}
                {searchSummary.count > 0 ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2 h-8 w-full gap-1 rounded-btn text-[11px]"
                    onClick={clearFound}
                  >
                    <Trash2 className="size-3" aria-hidden="true" />
                    {t("redact.clearFound")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Selected box inspector */}
          {selectedLive ? (
            <div className="rounded-card border border-primary/40 bg-card p-4 ring-1 ring-primary/15">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <SquareDashed className="size-4 text-primary" aria-hidden="true" />
                {t("redact.selectedTitle")}
              </h3>
              <dl className="mt-2 space-y-1.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">{t("redact.propKind")}</dt>
                  <dd className="font-medium text-foreground">
                    {kindLabel(selectedLive.kind)}
                  </dd>
                </div>
                {selectedLive.kind !== "manual" && selectedLive.label ? (
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t("redact.propText")}</dt>
                    <dd className="max-w-[190px] truncate font-mono text-[11px] text-foreground">
                      {selectedLive.label}
                    </dd>
                  </div>
                ) : null}
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">{t("redact.propPage")}</dt>
                  <dd className="font-medium tabular-nums text-foreground">
                    {selectedLive.page + 1} / {pageCount}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">{t("redact.propState")}</dt>
                  <dd
                    className={cn(
                      "font-medium",
                      selectedLive.enabled ? "text-destructive" : "text-muted-foreground"
                    )}
                  >
                    {selectedLive.enabled
                      ? t("redact.stateWillRedact")
                      : t("redact.stateKept")}
                  </dd>
                </div>
              </dl>
              <div className="mt-3 flex gap-2">
                <Button
                  type="button"
                  variant={selectedLive.enabled ? "outline" : "default"}
                  size="sm"
                  className="h-9 flex-1 rounded-btn text-xs"
                  onClick={() => toggleMark(selectedLive.id)}
                >
                  {selectedLive.enabled
                    ? t("redact.keepThis")
                    : t("redact.redactThis")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 rounded-btn text-xs text-destructive hover:text-destructive"
                  onClick={() => removeMark(selectedLive.id)}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  {t("redact.deleteBox")}
                </Button>
              </div>
            </div>
          ) : null}

          {/* How it works */}
          <div className="rounded-card border border-border bg-card p-4">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
              {t("redact.howTitle")}
            </h3>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {t("redact.howBody")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
