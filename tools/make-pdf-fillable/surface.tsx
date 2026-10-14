"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckSquare,
  Loader2,
  MousePointer2,
  RotateCw,
  SquareDashed,
  Trash2,
  TriangleAlert,
  Type,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  type FieldKind,
  type FieldSpec,
  type PageView,
  displayRectToPdf,
  displaySize,
  pdfRectToDisplay,
} from "./engine";
import { MAX_DETECT_PAGES, detectFields } from "./detect";

/**
 * Make PDF fillable live surface (PRD §8.2 "Make fillable"): auto-detect
 * underlines/boxes on load (green suggestion boxes), then edit them —
 * toggle keep/skip, rename, switch type, drag to move, corner-resize — or
 * draw brand-new text boxes and checkboxes anywhere on the page.
 *
 * The whole field list lives in the shell options under "f:<fileId>" as
 * one JSON blob { specs, pageViews } (the redact epoch-key pattern:
 * swapping the file can never leak another document's fields), and the
 * worker reads it through the "fkey" pointer option.
 */

const PREVIEW_MAX_DIM = 560;
const ZOOM_STEPS = [1, 1.5, 2] as const;
const KEY_PREFIX = "f:";
const FKEY_ID = "fkey";
/** Minimum drag (fraction of the page) that becomes a new field. */
const MIN_DRAW = 0.02;

type DrawMode = "text" | "checkbox";
type Mode = "select" | DrawMode;

interface Base {
  file: File;
  pageIndex: number;
  bitmap: ImageBitmap;
  dispW: number;
  dispH: number;
}

interface FieldsBlob {
  specs: FieldSpec[];
  pageViews: PageView[];
}

type BoxDrag =
  | { mode: "move"; id: string; orig: FieldSpec; grabFx: number; grabFy: number }
  | { mode: "resize"; id: string; orig: FieldSpec };

let manualSeq = 0;
function nextManualId(): string {
  manualSeq += 1;
  return `m${Date.now().toString(36)}${manualSeq.toString(36)}`;
}

function clampN(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

function roundPt(n: number): number {
  return Math.round(n * 10) / 10;
}

export function MakeFillableSurface(
  props: ToolSurfaceProps
): React.JSX.Element | null {
  const { files, values, onChange, setRunBlocked } = props;
  const { t } = useI18n();
  const { toast } = useToast();
  const file = files.length > 0 ? files[0].file : null;
  const fileId = files.length > 0 ? files[0].id : "";

  // --- Fields blob (option "f:<fileId>") -------------------------------
  const fieldsKey = `${KEY_PREFIX}${fileId}`;
  const blob = useMemo<FieldsBlob>(() => {
    try {
      const parsed = JSON.parse(
        String(values[fieldsKey] ?? "{}")
      ) as Partial<FieldsBlob>;
      return {
        specs: Array.isArray(parsed.specs) ? (parsed.specs as FieldSpec[]) : [],
        pageViews: Array.isArray(parsed.pageViews)
          ? (parsed.pageViews as PageView[])
          : [],
      };
    } catch {
      return { specs: [], pageViews: [] };
    }
  }, [values, fieldsKey]);
  const specs = blob.specs;
  const pageViews = blob.pageViews;

  const commit = useCallback(
    (next: FieldSpec[], views?: PageView[]): void => {
      onChange(
        fieldsKey,
        JSON.stringify({
          specs: next,
          pageViews: views ?? pageViews,
        })
      );
    },
    [onChange, fieldsKey, pageViews]
  );

  // Point the worker at this document's blob.
  useEffect(() => {
    if (fileId !== "") onChange(FKEY_ID, fileId);
  }, [fileId, onChange]);

  const enabledCount = useMemo(
    () => specs.filter((s) => s.enabled).length,
    [specs]
  );
  const touchedPages = useMemo(
    () => new Set(specs.filter((s) => s.enabled).map((s) => s.page)),
    [specs]
  );

  // --- Editor state -----------------------------------------------------
  const [pageCount, setPageCount] = useState(0);
  const [selectedPage, setSelectedPage] = useState(0);
  const [pageError, setPageError] = useState<"password" | "corrupt" | null>(null);
  const [base, setBase] = useState<Base | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState<number>(1);
  const [mode, setMode] = useState<Mode>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const [boxDrag, setBoxDrag] = useState<BoxDrag | null>(null);
  const [detectState, setDetectState] = useState<
    "idle" | "detecting" | "ready" | "error"
  >("idle");
  const [detectProgress, setDetectProgress] = useState({ page: 0, pages: 0 });
  const [existingCount, setExistingCount] = useState(0);
  const detectToken = useRef(0);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // --- Auto-detect on file load ----------------------------------------
  const runDetect = useCallback(
    (f: File): void => {
      const token = detectToken.current + 1;
      detectToken.current = token;
      setDetectState("detecting");
      setDetectProgress({ page: 0, pages: 0 });
      void detectFields(f, (p) => {
        if (detectToken.current === token) setDetectProgress(p);
      })
        .then((result) => {
          if (detectToken.current !== token) return;
          setDetectState("ready");
          setExistingCount(result.existingCount);
          commit(result.specs, result.pageViews);
          if (result.specs.length === 0) {
            toast({
              title: t("makeFillable.nothingFound"),
              description: t("makeFillable.nothingFoundHint"),
            });
          }
        })
        .catch((error: unknown) => {
          if (detectToken.current !== token) return;
          setDetectState("error");
          const message = String((error as Error)?.message ?? "");
          if (/password/i.test(message)) {
            setPageError("password");
          } else {
            toast({
              title: t("makeFillable.errorDetect"),
              variant: "destructive",
            });
          }
        });
    },
    [commit, t, toast]
  );

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      setPageError(null);
      setSelectedId(null);
      setMode("select");
      const count = await getPdfPageCount(file);
      if (cancelled) return;
      setPageCount(count);
      setSelectedPage((p) => Math.min(p, Math.max(0, count - 1)));
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
    // Start detection one microtask later — runDetect flips state
    // synchronously and the effect body must stay render-safe.
    queueMicrotask(() => runDetect(file));
    return () => {
      cancelled = true;
      detectToken.current += 1;
    };
  }, [file]);

  // --- Page preview ------------------------------------------------------
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
      setFailed(false);
      setBase({
        file,
        pageIndex: selectedPage,
        bitmap,
        dispW: pixel.width,
        dispH: pixel.height,
      });
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [file, pageCount, selectedPage, zoom]);

  const currentView = pageViews[selectedPage] ?? null;

  // --- Run gating --------------------------------------------------------
  useEffect(() => {
    setRunBlocked(enabledCount === 0 ? "makeFillable.blockedNoFields" : null);
  }, [enabledCount, setRunBlocked]);

  // --- Field actions -----------------------------------------------------
  const updateSpec = useCallback(
    (id: string, patch: Partial<FieldSpec>): void => {
      commit(specs.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    },
    [commit, specs]
  );

  const toggleSpec = useCallback(
    (id: string): void => {
      commit(
        specs.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s))
      );
    },
    [commit, specs]
  );

  const removeSpec = useCallback(
    (id: string): void => {
      commit(specs.filter((s) => s.id !== id));
      if (selectedId === id) setSelectedId(null);
    },
    [commit, selectedId, specs]
  );

  const pageSpecs = useMemo(
    () => specs.filter((s) => s.page === selectedPage),
    [specs, selectedPage]
  );
  const selected = useMemo(
    () => specs.find((s) => s.id === selectedId) ?? null,
    [specs, selectedId]
  );

  // --- Overlay pointer machinery -----------------------------------------
  const fractionPos = (
    event: React.PointerEvent<Element>
  ): { fx: number; fy: number } => {
    const overlay = overlayRef.current;
    if (!overlay) return { fx: 0, fy: 0 };
    const box = overlay.getBoundingClientRect();
    return {
      fx: clampN((event.clientX - box.left) / box.width, 0, 1),
      fy: clampN((event.clientY - box.top) / box.height, 0, 1),
    };
  };

  const handleOverlayPointerDown = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    if (!base || event.button !== 0) return;
    if (mode === "select") {
      setSelectedId(null);
      return;
    }
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
    (dragMode: "move" | "resize", spec: FieldSpec) =>
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (!base || event.button !== 0 || mode !== "select") return;
      event.stopPropagation();
      const overlay = overlayRef.current;
      if (!overlay) return;
      try {
        overlay.setPointerCapture(event.pointerId);
      } catch {
        // See above.
      }
      const { fx, fy } = fractionPos(event);
      setSelectedId(spec.id);
      setDrawing(null);
      if (dragMode === "move") {
        setBoxDrag({
          mode: dragMode,
          id: spec.id,
          orig: spec,
          grabFx: fx,
          grabFy: fy,
        });
      } else {
        setBoxDrag({ mode: dragMode, id: spec.id, orig: spec } satisfies BoxDrag);
      }
      event.preventDefault();
    };

  const handleOverlayPointerMove = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    const { fx, fy } = fractionPos(event);
    if (drawing) {
      setDrawing({ ...drawing, x1: fx, y1: fy });
      return;
    }
    if (!boxDrag || !currentView) return;
    const { orig, mode: dragMode } = boxDrag;
    const disp = pdfRectToDisplay(orig, currentView);
    if (dragMode === "move") {
      const dx = (fx - boxDrag.grabFx) * base!.dispW;
      const dy = (fy - boxDrag.grabFy) * base!.dispH;
      const next = {
        x: clampN(disp.x + dx, 0, base!.dispW - disp.w),
        y: clampN(disp.y + dy, 0, base!.dispH - disp.h),
        w: disp.w,
        h: disp.h,
      };
      const pdf = displayRectToPdf(next, currentView);
      updateSpec(orig.id, {
        x: roundPt(pdf.x),
        y: roundPt(pdf.y),
      });
    } else {
      const x1 = fx * base!.dispW;
      const y1 = fy * base!.dispH;
      const next = {
        x: disp.x,
        y: disp.y,
        w: Math.max(12, Math.min(x1 - disp.x, base!.dispW - disp.x)),
        h: Math.max(12, Math.min(y1 - disp.y, base!.dispH - disp.y)),
      };
      const pdf = displayRectToPdf(next, currentView);
      updateSpec(orig.id, {
        w: roundPt(pdf.w),
        h: roundPt(pdf.h),
      });
    }
  };

  const handleOverlayPointerUp = (): void => {
    if (drawing) {
      const x0 = Math.min(drawing.x0, drawing.x1);
      const x1 = Math.max(drawing.x0, drawing.x1);
      const y0 = Math.min(drawing.y0, drawing.y1);
      const y1 = Math.max(drawing.y0, drawing.y1);
      setDrawing(null);
      if (
        x1 - x0 >= MIN_DRAW &&
        y1 - y0 >= MIN_DRAW &&
        base &&
        currentView
      ) {
        const kind: FieldKind = mode === "checkbox" ? "checkbox" : "text";
        const pdf = displayRectToPdf(
          { x: x0 * base.dispW, y: y0 * base.dispH, w: (x1 - x0) * base.dispW, h: (y1 - y0) * base.dispH },
          currentView
        );
        const id = nextManualId();
        const manual: FieldSpec = {
          id,
          page: selectedPage,
          x: roundPt(pdf.x),
          y: roundPt(pdf.y),
          w: roundPt(pdf.w),
          h: roundPt(pdf.h),
          kind,
          name: `${kind === "checkbox" ? t("makeFillable.checkbox") : t("makeFillable.textField")} ${specs.filter((s) => s.kind === kind).length + 1}`,
          enabled: true,
        };
        commit([...specs, manual]);
        setSelectedId(id);
        setMode("select");
      }
      return;
    }
    setBoxDrag(null);
  };

  // --- Render helpers -----------------------------------------------------
  const specToStyle = (spec: FieldSpec): React.CSSProperties => {
    if (!base || !currentView) return { display: "none" };
    const disp = pdfRectToDisplay(spec, currentView);
    return {
      left: `${(disp.x / base.dispW) * 100}%`,
      top: `${(disp.y / base.dispH) * 100}%`,
      width: `${(disp.w / base.dispW) * 100}%`,
      height: `${(disp.h / base.dispH) * 100}%`,
    };
  };

  const isDetecting = detectState === "detecting";

  const drawingStyle: React.CSSProperties | null = drawing
    ? {
        left: `${Math.min(drawing.x0, drawing.x1) * 100}%`,
        top: `${Math.min(drawing.y0, drawing.y1) * 100}%`,
        width: `${Math.abs(drawing.x1 - drawing.x0) * 100}%`,
        height: `${Math.abs(drawing.y1 - drawing.y0) * 100}%`,
      }
    : null;

  // --- Guards -------------------------------------------------------------
  if (!file) return null;

  if (pageError === "password") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-card border border-border bg-card p-8 text-center">
        <TriangleAlert className="size-8 text-amber-500" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">
          {t("makeFillable.passwordProtected")}
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          {t("makeFillable.passwordHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PreviewFileHeader
        file={file}
        pageCount={pageCount}
        onRemove={() => undefined}
      />

      {existingCount > 0 ? (
        <div className="flex items-start gap-2.5 rounded-card border border-amber-300/60 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="text-xs leading-relaxed">
            {t("makeFillable.existingFields", { count: existingCount })}
          </p>
        </div>
      ) : null}

      {isDetecting ? (
        <div className="flex items-center gap-2.5 rounded-card border border-border bg-card p-3">
          <Loader2
            className="size-4 shrink-0 animate-spin text-primary"
            aria-hidden="true"
          />
          <p className="text-xs text-muted-foreground">
            {detectProgress.pages > 0
              ? t("makeFillable.detectingProgress", {
                  page: detectProgress.page,
                  pages: detectProgress.pages,
                })
              : t("makeFillable.detecting")}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={mode === "select" ? "default" : "outline"}
            size="sm"
            className="h-9"
            onClick={() => setMode("select")}
            aria-pressed={mode === "select"}
          >
            <MousePointer2 className="size-4" aria-hidden="true" />
            {t("makeFillable.modeSelect")}
          </Button>
          <Button
            type="button"
            variant={mode === "text" ? "default" : "outline"}
            size="sm"
            className="h-9"
            onClick={() => setMode("text")}
            aria-pressed={mode === "text"}
          >
            <Type className="size-4" aria-hidden="true" />
            {t("makeFillable.modeText")}
          </Button>
          <Button
            type="button"
            variant={mode === "checkbox" ? "default" : "outline"}
            size="sm"
            className="h-9"
            onClick={() => setMode("checkbox")}
            aria-pressed={mode === "checkbox"}
          >
            <CheckSquare className="size-4" aria-hidden="true" />
            {t("makeFillable.modeCheckbox")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => {
              setSelectedId(null);
              runDetect(file);
            }}
            disabled={isDetecting}
          >
            {isDetecting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <RotateCw className="size-4" aria-hidden="true" />
            )}
            {t("makeFillable.detectAgain")}
          </Button>
          <span className="ml-auto text-xs font-medium text-muted-foreground">
            {t("makeFillable.summary", {
              count: enabledCount,
              total: specs.length,
              pages: touchedPages.size,
            })}
          </span>
        </div>
      )}

      {pageCount > 1 ? (
        <PreviewPageStrip
          file={file}
          pageCount={pageCount}
          selected={selectedPage}
          onSelect={setSelectedPage}
          markedSet={touchedPages}
        />
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {t("makeFillable.pageOf", {
            page: selectedPage + 1,
            pages: pageCount,
          })}
          {mode !== "select"
            ? ` · ${t("makeFillable.drawHint")}`
            : ` · ${t("makeFillable.editHint")}`}
        </p>
        <PreviewZoomControl steps={ZOOM_STEPS} value={zoom} onChange={setZoom} />
      </div>

      {base && !failed ? (
        <div className="relative mx-auto w-fit max-w-full overflow-hidden rounded-card border border-border bg-card shadow-sm">
          <canvas
            className="block max-w-full"
            style={{
              width: `${Math.min(base.dispW, PREVIEW_MAX_DIM * zoom)}px`,
              height: "auto",
            }}
            ref={(canvas) => {
              if (!canvas) return;
              const ctx = canvas.getContext("2d");
              if (!ctx) return;
              canvas.width = base.bitmap.width;
              canvas.height = base.bitmap.height;
              ctx.drawImage(base.bitmap, 0, 0);
            }}
            aria-label={t("makeFillable.previewLabel")}
          />
          <div
            ref={overlayRef}
            className={cn(
              "absolute inset-0 touch-none select-none",
              mode === "select" ? "cursor-default" : "cursor-crosshair"
            )}
            onPointerDown={handleOverlayPointerDown}
            onPointerMove={handleOverlayPointerMove}
            onPointerUp={handleOverlayPointerUp}
            onPointerCancel={handleOverlayPointerUp}
            role="application"
            aria-label={t("makeFillable.overlayLabel")}
          >
            {pageSpecs.map((spec) => {
              const isSelected = spec.id === selectedId;
              return (
                <div
                  key={spec.id}
                  className={cn(
                    "group absolute",
                    spec.enabled
                      ? "border-2 border-primary/70 bg-primary/10"
                      : "border-2 border-dashed border-muted-foreground/50 bg-transparent",
                    isSelected && "border-primary ring-2 ring-primary/30",
                    mode === "select" && "cursor-move"
                  )}
                  style={specToStyle(spec)}
                  onPointerDown={beginBoxDrag("move", spec)}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (mode === "select") setSelectedId(spec.id);
                  }}
                >
                  <span
                    className={cn(
                      "absolute -top-5 left-0 max-w-full truncate rounded-sm px-1 py-px text-[10px] font-medium leading-none",
                      spec.enabled
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    {spec.name}
                    {spec.kind === "checkbox" ? " ☐" : ""}
                  </span>
                  <button
                    type="button"
                    className="absolute -right-2.5 -top-2.5 z-20 flex size-5 items-center justify-center rounded-full bg-destructive text-white opacity-0 shadow-md transition-opacity group-hover:opacity-100 focus:opacity-100"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeSpec(spec.id);
                    }}
                    aria-label={t("makeFillable.deleteField")}
                  >
                    <Trash2 className="size-3" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="absolute -left-2.5 -top-2.5 z-20 flex size-5 items-center justify-center rounded-full bg-card text-foreground opacity-0 shadow-md ring-1 ring-border transition-opacity group-hover:opacity-100 focus:opacity-100"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSpec(spec.id);
                    }}
                    aria-label={spec.enabled ? t("makeFillable.skipField") : t("makeFillable.keepField")}
                  >
                    {spec.enabled ? (
                      <SquareDashed className="size-3" aria-hidden="true" />
                    ) : (
                      <CheckSquare className="size-3" aria-hidden="true" />
                    )}
                  </button>
                  {isSelected && mode === "select" ? (
                    <span
                      className="absolute -bottom-1 -right-1 size-3 cursor-nwse-resize rounded-full border-2 border-primary bg-background"
                      onPointerDown={beginBoxDrag("resize", spec)}
                      aria-hidden="true"
                    />
                  ) : null}
                </div>
              );
            })}
            {drawingStyle ? (
              <div
                className="pointer-events-none absolute border-2 border-dashed border-primary bg-primary/10"
                style={drawingStyle}
              />
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex h-64 items-center justify-center rounded-card border border-border bg-card">
          {failed ? (
            <p className="text-sm text-muted-foreground">
              {t("makeFillable.previewFailed")}
            </p>
          ) : (
            <Loader2
              className="size-6 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          )}
        </div>
      )}

      {selected ? (
        <div className="rounded-card border border-border bg-card p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("makeFillable.properties")}
          </p>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="grid gap-1.5">
              <Label
                htmlFor="mf-name"
                className="text-xs text-muted-foreground"
              >
                {t("makeFillable.fieldName")}
              </Label>
              <Input
                id="mf-name"
                className="h-9"
                value={selected.name}
                onChange={(e) => updateSpec(selected.id, { name: e.target.value })}
                maxLength={60}
              />
            </div>
            <div className="grid gap-1.5">
              <Label
                htmlFor="mf-kind"
                className="text-xs text-muted-foreground"
              >
                {t("makeFillable.fieldType")}
              </Label>
              <Select
                value={selected.kind}
                onValueChange={(v) =>
                  updateSpec(selected.id, { kind: v as FieldKind })
                }
              >
                <SelectTrigger id="mf-kind" className="h-9 w-full sm:w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">
                    {t("makeFillable.kindText")}
                  </SelectItem>
                  <SelectItem value="multiline">
                    {t("makeFillable.kindMultiline")}
                  </SelectItem>
                  <SelectItem value="checkbox">
                    {t("makeFillable.kindCheckbox")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => toggleSpec(selected.id)}
            >
              {selected.enabled
                ? t("makeFillable.skipField")
                : t("makeFillable.keepField")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="h-8"
              onClick={() => removeSpec(selected.id)}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {t("makeFillable.deleteField")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
