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
import { createPortal } from "react-dom";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement } from "@dnd-kit/modifiers";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Camera,
  CameraOff,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  GripVertical,
  Images,
  Loader2,
  Pencil,
  RotateCcw,
  RotateCw,
  ScanLine,
  Sparkles,
  Trash2,
  TriangleAlert,
  Wand2,
  X,
  Zap,
  ZapOff,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { formatBytes } from "@/lib/storage/recent-files";
import { cn } from "@/lib/utils";
import {
  applyScanFilter,
  createInitialScanPages,
  deleteScanPages,
  denormalizeQuad,
  detectDocumentQuad,
  FULL_FRAME_QUAD,
  moveScanPage,
  normalizeQuad,
  quadOutputSize,
  reconcileScanPages,
  rotateQuarter,
  rotateScanPages,
  serializeScanPages,
  setScanFilter,
  warpPerspective,
  type Quad,
  type ScanFilter,
  type ScanPage,
} from "./engine";

/**
 * Scan to PDF surface (PRD §8.4) — camera-first scanner that also accepts
 * gallery photos through the same pipeline.
 *
 * - renders on the LANDING too (config.landingSurface): camera hero +
 *   gallery picker, no upload needed to reach the camera
 * - camera sheet: live edge-detection overlay, multi-shot session,
 *   torch (capability-gated), honest permission errors
 * - every photo runs auto edge detection → perspective-corrected preview
 *   rendered by the SAME engine the export worker uses (WYSIWYG)
 * - page cards: drag reorder, rotate, delete, per-page corner editor
 *   (draggable handles + arrow-key nudge) with live filter chips
 * - state sync via the house pattern: promise callbacks only, never
 *   setState synchronously inside effect bodies
 */

const TOOL_BTN =
  "h-11 min-h-11 gap-1.5 rounded-btn px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50";

const FILTERS: { id: ScanFilter; icon: typeof Sparkles }[] = [
  { id: "original", icon: Camera },
  { id: "magic", icon: Wand2 },
  { id: "bw", icon: ScanLine },
  { id: "gray", icon: Images },
];

const CORNER_KEYS = ["tl", "tr", "br", "bl"] as const;
type CornerIndex = 0 | 1 | 2 | 3;

/* ------------------------------ helpers ------------------------------ */

function quadPoints(quad: Quad, scale = 1): string {
  return [
    `${quad[0] * scale},${quad[1] * scale}`,
    `${quad[2] * scale},${quad[3] * scale}`,
    `${quad[4] * scale},${quad[5] * scale}`,
    `${quad[6] * scale},${quad[7] * scale}`,
  ].join(" ");
}

function isFullFrame(quad: Quad): boolean {
  return quad.every((v, i) => Math.abs(v - FULL_FRAME_QUAD[i]) < 1e-6);
}

let scanShotSeq = 0;
function nextShotName(total: number): string {
  scanShotSeq += 1;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  return `scan-${stamp}-${String(total).padStart(2, "0")}-${scanShotSeq}.jpg`;
}

/* ------------------------- preview bitmap cache ------------------------- */

interface PreviewBitmap {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const previewCache = new Map<string, Promise<PreviewBitmap>>();
const PREVIEW_CACHE_MAX = 48;

/** Draws a decoded bitmap into a downscaled RGBA preview buffer. */
function bitmapToPreview(bitmap: ImageBitmap): PreviewBitmap {
  try {
    const maxEdge = 480;
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("no 2d context");
    context.drawImage(bitmap, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);
    return { data: imageData.data, width, height };
  } finally {
    bitmap.close();
  }
}

/** <img> + objectURL decode (Promise wrapper). */
function decodeViaImg(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image decode failed"));
    };
    img.src = url;
  });
}

async function decodePreview(file: File): Promise<PreviewBitmap> {
  // Path A — bytes → fresh Blob → createImageBitmap. Some WebViews and
  // sandboxed file inputs hand createImageBitmap a File whose lazy
  // backing store its async decoder cannot read, while a plain copy
  // decodes fine.
  try {
    const bytes = await file.arrayBuffer();
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: file.type || "image/jpeg" })
    );
    return bitmapToPreview(bitmap);
  } catch {
    // Path B — objectURL + <img>: the media loader reads File stores that
    // even arrayBuffer() refuses (iOS Safari file handles, some QA
    // harnesses) — the imagegrid card pattern, battle-tested.
    const img = await decodeViaImg(file);
    const scale = Math.min(1, 480 / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("no 2d context");
    context.drawImage(img, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);
    return { data: imageData.data, width, height };
  }
}

async function loadPreviewBitmap(file: File, key: string): Promise<PreviewBitmap> {
  const cached = previewCache.get(key);
  if (cached) return cached;
  if (previewCache.size >= PREVIEW_CACHE_MAX) {
    // Soft LRU — Map keeps insertion order; drop the oldest entry.
    const oldest = previewCache.keys().next();
    if (!oldest.done) previewCache.delete(oldest.value);
  }
  const pending = decodePreview(file);
  previewCache.set(key, pending);
  pending.catch(() => previewCache.delete(key));
  return pending;
}

/** Runs the exact export pipeline at preview resolution onto a canvas. */
function drawScanPreview(
  canvas: HTMLCanvasElement,
  bmp: PreviewBitmap,
  page: Pick<ScanPage, "quad" | "filter" | "rotation">,
  maxEdge: number
): void {
  const quadAbs = denormalizeQuad(page.quad, bmp.width, bmp.height);
  const { width, height } = quadOutputSize(quadAbs, maxEdge);
  let warped = warpPerspective(bmp, quadAbs, width, height);
  applyScanFilter(warped, page.filter);
  warped = rotateQuarter(warped, page.rotation);
  canvas.width = warped.width;
  canvas.height = warped.height;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.putImageData(
    new ImageData(new Uint8ClampedArray(warped.data), warped.width, warped.height),
    0,
    0
  );
}

/* ------------------------------ surface ------------------------------ */

export function ScanSurface({
  files,
  onChange,
  addFiles,
  setRunBlocked,
}: ToolSurfaceProps) {
  const { t } = useI18n();
  const toast = useToast().toast;

  const [pages, setPages] = useState<ScanPage[]>(() =>
    createInitialScanPages(files.length)
  );
  const [prevFileCount, setPrevFileCount] = useState(files.length);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [editingUid, setEditingUid] = useState<string | null>(null);
  // Mirror of the latest page list for async continuations (auto-detect
  // must read the state that exists AFTER its awaits). apply() keeps it
  // current — never assigned during render.
  const pagesRef = useRef<ScanPage[]>(pages);

  const cameraSupported =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function";

  const apply = useCallback(
    (next: ScanPage[]) => {
      pagesRef.current = next;
      setPages(next);
      onChange("scan", serializeScanPages(next));
      setRunBlocked(next.length === 0 ? "scan.ctaNoPages" : null);
    },
    [onChange, setRunBlocked]
  );

  // CTA gate: no pages → blocked (fires for the initial mount too, inside
  // a microtask so no setState happens in the effect body itself).
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setRunBlocked(pages.length === 0 ? "scan.ctaNoPages" : null);
    });
    return () => {
      cancelled = true;
    };
  }, [pages.length, setRunBlocked]);

  // Auto edge detection for newly arrived full-frame pages — sequential
  // pass, applied page by page so cards update progressively.
  const autoDetect = useCallback(
    (targets: ScanPage[]) => {
      const run = async () => {
        for (const target of targets) {
          if (target.autoDetected || !isFullFrame(target.quad)) continue;
          const fileRef = files[target.source];
          if (!fileRef) continue;
          try {
            const bmp = await loadPreviewBitmap(fileRef.file, fileRef.id);
            const det = detectDocumentQuad(bmp.data, bmp.width, bmp.height);
            if (det.confidence > 0.45) {
              const next = pagesRef.current.map((page) =>
                page.uid === target.uid
                  ? {
                      ...page,
                      quad: normalizeQuad(det.quad, bmp.width, bmp.height),
                      autoDetected: true,
                    }
                  : page
              );
              apply(next);
            }
          } catch {
            // Preview decode failure — page stays full-frame, honest.
          }
        }
      };
      void run().catch(() => undefined);
    },
    [apply, files]
  );

  // Reconcile when the shell file list changes (camera batches, gallery
  // add-more, chain handoff) — microtask, never in the effect body.
  useEffect(() => {
    if (files.length === prevFileCount) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      const next = reconcileScanPages(pages, files.length, prevFileCount);
      setPrevFileCount(files.length);
      apply(next);
    });
    return () => {
      cancelled = true;
    };
  }, [files.length, pages, prevFileCount, apply]);

  // Auto-detection kicker — the SINGLE entry point for edge detection on
  // newly arrived photos. Fires on mount (the landing→workspace remount
  // rebuilds pages with no files transition the reconcile effect could
  // see) and on every file-list change (after the reconcile microtask —
  // effects run in declaration order, microtasks FIFO). Already-detected
  // and manually-adjusted (non-full-frame) pages are skipped, so a user
  // resetting corners is never fought by re-detection.
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      const current = pagesRef.current;
      if (current.length === 0) return;
      if (current.every((page) => page.autoDetected || !isFullFrame(page.quad))) {
        return;
      }
      autoDetect(current);
    });
    return () => {
      cancelled = true;
    };
  }, [files.length, autoDetect]);

  /* ------------------------------ actions ------------------------------ */

  const rotateAll = (delta: number) => {
    apply(
      rotateScanPages(
        pages,
        pages.map((_, index) => index),
        delta
      )
    );
  };

  const onCameraDone = useCallback(
    (captured: File[]) => {
      setCameraOpen(false);
      if (captured.length > 0) {
        addFiles(captured);
        toast({ description: t("scan.capturedToast", { count: captured.length }) });
      }
    },
    [addFiles, t, toast]
  );

  /* ------------------------------ drag reorder ------------------------------ */

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = pages.findIndex((page) => page.uid === active.id);
    const to = pages.findIndex((page) => page.uid === over.id);
    if (from < 0 || to < 0) return;
    apply(moveScanPage(pages, from, to));
  };

  const stats = useMemo(
    () => ({
      pages: pages.length,
      auto: pages.filter((page) => page.autoDetected).length,
      filtered: pages.filter((page) => page.filter !== "original").length,
    }),
    [pages]
  );
  const totalBytes = useMemo(
    () => files.reduce((sum, item) => sum + item.file.size, 0),
    [files]
  );

  const editingPage = pages.find((page) => page.uid === editingUid) ?? null;
  const editingIndex = editingPage
    ? pages.findIndex((page) => page.uid === editingPage.uid)
    : -1;
  const editingFileRef =
    editingPage && editingIndex >= 0 ? files[editingPage.source] : undefined;

  /* ------------------------------ render ------------------------------ */

  if (files.length === 0) {
    // LANDING variant — camera hero + gallery picker (the surface
    // replaces the DropZone; PRD "camera/scan option on mobile" flow).
    return (
      <section aria-label={t("scan.surfaceLabel")} className="flex flex-col gap-3">
        <div className="overflow-hidden rounded-card border border-border bg-card">
          <div className="grid gap-0 md:grid-cols-[1.05fr_1fr]">
            <div className="flex flex-col gap-4 p-5 sm:p-6">
              <span
                className="flex size-12 items-center justify-center rounded-card bg-cat-create/10 text-cat-create"
                aria-hidden="true"
              >
                <Camera className="size-6" />
              </span>
              <div className="flex flex-col gap-1.5">
                <h2 className="text-base font-semibold text-foreground">
                  {t("scan.heroTitle")}
                </h2>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("scan.heroDesc")}
                </p>
              </div>
              {cameraSupported ? (
                <Button
                  type="button"
                  className="h-11 min-h-11 gap-2 self-start rounded-btn px-5 text-sm font-semibold"
                  onClick={() => setCameraOpen(true)}
                >
                  <Camera className="size-4" aria-hidden="true" />
                  {t("scan.openCamera")}
                </Button>
              ) : (
                <p className="flex items-center gap-2 rounded-btn bg-muted p-3 text-xs font-medium text-muted-foreground">
                  <CameraOff className="size-4 shrink-0" aria-hidden="true" />
                  {t("scan.cameraUnavailable")}
                </p>
              )}
            </div>
            <div className="flex flex-col justify-center gap-2 border-t border-border p-4 sm:p-5 md:border-l md:border-t-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t("scan.galleryTitle")}
              </p>
              <DropZone
                labelKey="scan.dropImages"
                multiple
                maxFiles={30}
                acceptKind="image"
                onAccept={addFiles}
                currentCount={0}
                className="py-2"
              />
            </div>
          </div>
        </div>
        {cameraOpen && cameraSupported ? (
          <CameraSheet
            existingCount={0}
            onDone={onCameraDone}
            onClose={() => setCameraOpen(false)}
          />
        ) : null}
      </section>
    );
  }

  // WORKSPACE variant — page grid.
  return (
    <section aria-label={t("scan.surfaceLabel")} className="flex flex-col gap-3">
      {/* Header — stats + camera + quick actions */}
      <div className="flex flex-col gap-3 rounded-card border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-chip px-2.5 py-1 text-[11px] font-semibold",
              pages.length > 0
                ? "bg-cat-create/10 text-cat-create"
                : "bg-muted text-muted-foreground"
            )}
          >
            <ScanLine className="size-3.5" aria-hidden="true" />
            {t("scan.pageCount", { count: stats.pages })}
          </span>
          <span className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            {formatBytes(totalBytes)}
          </span>
          {stats.auto > 0 ? (
            <span className="flex items-center gap-1 rounded-chip bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
              <Sparkles className="size-3" aria-hidden="true" />
              {t("scan.autoCount", { count: stats.auto })}
            </span>
          ) : null}
          {stats.filtered > 0 ? (
            <span className="rounded-chip bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
              {t("scan.filteredCount", { count: stats.filtered })}
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-1.5">
            <Button
              type="button"
              className={cn(
                TOOL_BTN,
                "border-cat-create/30 bg-cat-create/5 text-cat-create hover:bg-cat-create/10 hover:text-cat-create"
              )}
              onClick={() => setCameraOpen(true)}
              disabled={!cameraSupported}
              aria-label={t("scan.openCameraLabel")}
            >
              <Camera className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t("scan.scanMore")}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              className={cn(TOOL_BTN, "px-2")}
              onClick={() => rotateAll(-90)}
              disabled={pages.length === 0}
              aria-label={t("scan.rotateAllLeft")}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              className={cn(TOOL_BTN, "px-2")}
              onClick={() => rotateAll(90)}
              disabled={pages.length === 0}
              aria-label={t("scan.rotateAllRight")}
            >
              <RotateCw className="size-4" aria-hidden="true" />
            </Button>
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">{t("scan.hint")}</p>
      </div>

      {/* Page grid */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={pages.map((page) => page.uid)}
          strategy={rectSortingStrategy}
        >
          <ul className="grid list-none grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {pages.map((page, index) => {
              const fileRef = files[page.source];
              return (
                <ScanPageCard
                  key={page.uid}
                  page={page}
                  index={index}
                  total={pages.length}
                  file={fileRef?.file ?? null}
                  fileKey={fileRef?.id ?? page.uid}
                  onEdit={() => setEditingUid(page.uid)}
                  onRotate={(delta) => apply(rotateScanPages(pages, [index], delta))}
                  onRemove={() => {
                    apply(deleteScanPages(pages, [index]));
                    if (editingUid === page.uid) setEditingUid(null);
                  }}
                  onMove={(from, to) => apply(moveScanPage(pages, from, to))}
                />
              );
            })}
          </ul>
        </SortableContext>
      </DndContext>

      {/* Add more */}
      <DropZone
        labelKey="scan.addMore"
        multiple
        maxFiles={30}
        acceptKind="image"
        onAccept={addFiles}
        currentCount={files.length}
        className="py-2"
      />

      {cameraOpen ? (
        <CameraSheet
          existingCount={files.length}
          onDone={onCameraDone}
          onClose={() => setCameraOpen(false)}
        />
      ) : null}

      {editingPage !== null && editingIndex >= 0 ? (
        <PageEditorDialog
          page={editingPage}
          file={editingFileRef?.file ?? null}
          fileKey={editingFileRef?.id ?? editingPage.uid}
          pageIndex={editingIndex + 1}
          onClose={() => setEditingUid(null)}
          onChangeQuad={(quad, autoDetected) => {
            apply(
              pages.map((page) =>
                page.uid === editingPage.uid ? { ...page, quad, autoDetected } : page
              )
            );
          }}
          onChangeFilter={(filter) => {
            apply(setScanFilter(pages, [editingIndex], filter));
          }}
          onRotate={(delta) => {
            apply(rotateScanPages(pages, [editingIndex], delta));
          }}
        />
      ) : null}
    </section>
  );
}

/* ------------------------------ page card ------------------------------ */

function ScanPageCard({
  page,
  index,
  total,
  file,
  fileKey,
  onEdit,
  onRotate,
  onRemove,
  onMove,
}: {
  page: ScanPage;
  index: number;
  total: number;
  file: File | null;
  fileKey: string;
  onEdit: () => void;
  onRotate: (delta: number) => void;
  onRemove: () => void;
  onMove: (from: number, to: number) => void;
}) {
  const { t } = useI18n();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: page.uid });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [bitmap, setBitmap] = useState<PreviewBitmap | null>(null);

  // Bitmap loads once per file — the only setState lives in promise
  // callbacks (microtask reset included), never in the effect body.
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) setStatus("loading");
    });
    void loadPreviewBitmap(file, fileKey)
      .then((bmp) => {
        if (cancelled) return;
        setBitmap(bmp);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [file, fileKey]);

  // WYSIWYG redraw — the exact export pipeline at card resolution,
  // redone whenever the page (quad/filter/rotation) or bitmap changes.
  // Purely imperative canvas work, no React state.
  useEffect(() => {
    if (!bitmap) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawScanPreview(canvas, bitmap, page, 420);
  }, [bitmap, page]);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "relative list-none",
        isDragging && "z-20",
        isOver && !isDragging && "rounded-card ring-2 ring-primary/40"
      )}
    >
      <div
        className={cn(
          "group relative flex flex-col overflow-hidden rounded-card border border-border bg-card transition-all duration-200",
          "hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md focus-within:ring-[3px] focus-within:ring-ring/50",
          isDragging && "shadow-lg ring-2 ring-primary/30"
        )}
      >
        {/* Perspective-corrected preview */}
        <div className="relative aspect-[4/5] w-full overflow-hidden bg-muted/40">
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={t("scan.cardPreviewLabel", { index: index + 1 })}
            className="size-full object-contain"
          />
          {status !== "ready" ? (
            <div
              aria-hidden="true"
              className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-muted to-muted/40"
            >
              {status === "loading" ? (
                <Loader2 className="size-5 animate-spin text-muted-foreground/60" />
              ) : (
                <CircleAlert className="size-5 text-destructive/70" />
              )}
            </div>
          ) : null}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-1.5 top-1.5 rounded-chip bg-background/85 px-1.5 py-0.5 text-[10px] font-bold text-foreground shadow-sm backdrop-blur"
          >
            {index + 1}
          </span>
          {page.autoDetected ? (
            <span className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-1 rounded-chip bg-emerald-600/95 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm">
              <Sparkles className="size-2.5" aria-hidden="true" />
              <span className="sr-only">{t("scan.autoBadge")}</span>
            </span>
          ) : null}
          <span className="sr-only">
            {t("scan.cardPosition", { index: index + 1, total })}
          </span>
        </div>

        {/* Meta + actions */}
        <div className="flex flex-col gap-1.5 p-2.5">
          <p className="truncate text-xs font-semibold text-foreground" title={file?.name}>
            {file?.name}
          </p>
          <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span>{file ? formatBytes(file.size) : ""}</span>
            <span aria-hidden="true">·</span>
            <span>{t(`scan.filter.${page.filter}`)}</span>
            {page.rotation !== 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{page.rotation}°</span>
              </>
            ) : null}
          </p>
          <div className="mt-0.5 flex items-center gap-1">
            <button
              type="button"
              onClick={onEdit}
              aria-label={t("scan.editLabel", { name: file?.name ?? "" })}
              className="flex size-8 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Pencil className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onRotate(-90)}
              aria-label={t("scan.rotateLeftLabel", { name: file?.name ?? "" })}
              className="flex size-8 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onRotate(90)}
              aria-label={t("scan.rotateRightLabel", { name: file?.name ?? "" })}
              className="flex size-8 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <RotateCw className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onMove(index, index - 1)}
              disabled={index === 0}
              aria-label={t("scan.moveEarlierLabel", { name: file?.name ?? "" })}
              className="hidden size-8 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-30 sm:flex"
            >
              <ChevronUp className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onMove(index, index + 1)}
              disabled={index === total - 1}
              aria-label={t("scan.moveLaterLabel", { name: file?.name ?? "" })}
              className="hidden size-8 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-30 sm:flex"
            >
              <ChevronDown className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onRemove}
              aria-label={t("scan.removeLabel", { name: file?.name ?? "" })}
              className="ml-auto flex size-8 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Drag grip — hover-revealed on pointer, always on touch */}
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t("scan.dragLabel", { name: file?.name ?? "" })}
          className={cn(
            "absolute bottom-1.5 right-1.5 z-10 flex size-8 items-center justify-center rounded-btn bg-background/80 text-muted-foreground/70 opacity-0 outline-none backdrop-blur transition-all",
            "cursor-grab touch-none hover:text-foreground active:cursor-grabbing focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "focus-visible:opacity-100 group-hover:opacity-100",
            "max-lg:opacity-90",
            isDragging && "opacity-100 bg-accent text-foreground"
          )}
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

/* --------------------------- page editor dialog --------------------------- */

function PageEditorDialog({
  page,
  file,
  fileKey,
  pageIndex,
  onClose,
  onChangeQuad,
  onChangeFilter,
  onRotate,
}: {
  page: ScanPage;
  file: File | null;
  fileKey: string;
  pageIndex: number;
  onClose: () => void;
  onChangeQuad: (quad: Quad, autoDetected: boolean) => void;
  onChangeFilter: (filter: ScanFilter) => void;
  onRotate: (delta: number) => void;
}) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const dragCorner = useRef<CornerIndex | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceDims, setSourceDims] = useState<{ w: number; h: number } | null>(null);
  const [bitmap, setBitmap] = useState<PreviewBitmap | null>(null);
  const [bitmapError, setBitmapError] = useState(false);

  // Object URL for the untouched source photo + the shared preview bitmap.
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(file);
      setSourceUrl(objectUrl);
      const img = new Image();
      img.onload = () => {
        if (!cancelled) setSourceDims({ w: img.naturalWidth, h: img.naturalHeight });
      };
      img.src = objectUrl;
      void loadPreviewBitmap(file, fileKey)
        .then((bmp) => {
          if (!cancelled) setBitmap(bmp);
        })
        .catch(() => {
          if (!cancelled) setBitmapError(true);
        });
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file, fileKey]);

  // Live warped preview — imperative canvas redraw, one rAF per change
  // (rapid corner drags coalesce into the next frame; no React state).
  useEffect(() => {
    if (!bitmap) return;
    const frame = requestAnimationFrame(() => {
      const canvas = previewCanvasRef.current;
      if (!canvas) return;
      drawScanPreview(canvas, bitmap, page, 620);
    });
    return () => cancelAnimationFrame(frame);
  }, [bitmap, page]);

  /* --------------------------- corner dragging --------------------------- */

  const beginDrag =
    (corner: CornerIndex) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragCorner.current = corner;
    };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const corner = dragCorner.current;
    const stage = stageRef.current;
    if (corner === null || !stage) return;
    const rect = stage.getBoundingClientRect();
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
    const nx = clamp01((event.clientX - rect.left) / rect.width);
    const ny = clamp01((event.clientY - rect.top) / rect.height);
    const next = [...page.quad] as Quad;
    next[corner * 2] = nx;
    next[corner * 2 + 1] = ny;
    onChangeQuad(next, false);
  };

  const commitDrag = () => {
    dragCorner.current = null;
  };

  const nudgeCorner = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    corner: CornerIndex
  ) => {
    const map: Record<string, [number, number]> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    };
    const delta = map[event.key];
    if (!delta) return;
    event.preventDefault();
    const factor = event.shiftKey ? 4 : 1;
    const step = 0.005 * factor;
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
    const next = [...page.quad] as Quad;
    next[corner * 2] = clamp01(next[corner * 2] + delta[0] * step);
    next[corner * 2 + 1] = clamp01(next[corner * 2 + 1] + delta[1] * step);
    onChangeQuad(next, false);
  };

  const runAutoDetect = () => {
    if (!bitmap) return;
    const det = detectDocumentQuad(bitmap.data, bitmap.width, bitmap.height);
    if (det.confidence > 0.2) {
      onChangeQuad(normalizeQuad(det.quad, bitmap.width, bitmap.height), true);
    }
  };

  const resetCorners = () => {
    onChangeQuad([...FULL_FRAME_QUAD] as Quad, false);
  };

  const aspect = sourceDims ? `${sourceDims.w} / ${sourceDims.h}` : "4 / 5";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[92dvh] overflow-y-auto rounded-card p-0 sm:max-w-4xl">
        <DialogHeader className="border-b border-border p-4 sm:px-6">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <Pencil className="size-4 text-primary" aria-hidden="true" />
            {t("scan.editTitle", { index: pageIndex })}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("scan.editDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 p-4 sm:grid-cols-[1.25fr_1fr] sm:p-6 sm:pt-4">
          {/* Source photo + draggable quad */}
          <div className="flex flex-col gap-2">
            <div
              ref={stageRef}
              className="relative w-full select-none overflow-hidden rounded-card border border-border bg-muted"
              style={{ aspectRatio: aspect }}
              onPointerMove={handlePointerMove}
              onPointerUp={commitDrag}
              onPointerCancel={commitDrag}
            >
              {sourceUrl ? (
                <img
                  src={sourceUrl}
                  alt={t("scan.sourceAlt")}
                  className="pointer-events-none size-full object-fill"
                  draggable={false}
                />
              ) : (
                <div className="size-full animate-pulse bg-gradient-to-br from-muted to-muted/40" />
              )}
              <svg
                aria-hidden="true"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="pointer-events-none absolute inset-0 size-full"
              >
                <polygon
                  points={quadPoints(page.quad, 100)}
                  fill="rgba(37, 99, 235, 0.10)"
                  stroke="rgb(37, 99, 235)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              {CORNER_KEYS.map((key, corner) => (
                <button
                  key={key}
                  type="button"
                  onPointerDown={beginDrag(corner as CornerIndex)}
                  onKeyDown={(event) => nudgeCorner(event, corner as CornerIndex)}
                  aria-label={t(`scan.corner.${key}`)}
                  className="absolute z-10 flex size-8 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded-full border-2 border-primary bg-background/90 shadow-md outline-none transition-transform hover:scale-110 focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing"
                  style={{
                    left: `${page.quad[corner * 2] * 100}%`,
                    top: `${page.quad[corner * 2 + 1] * 100}%`,
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="size-2.5 rounded-full bg-primary"
                  />
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("scan.editHint")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className={TOOL_BTN}
                onClick={runAutoDetect}
                disabled={!bitmap}
              >
                <Sparkles className="size-4" aria-hidden="true" />
                {t("scan.autoDetect")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className={TOOL_BTN}
                onClick={resetCorners}
              >
                {t("scan.resetCorners")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className={cn(TOOL_BTN, "px-2")}
                onClick={() => onRotate(90)}
                aria-label={t("scan.rotateRightLabel", { name: file?.name ?? "" })}
              >
                <RotateCw className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          {/* Live result + filters */}
          <div className="flex flex-col gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("scan.previewLabel")}
            </p>
            <div className="relative w-full overflow-hidden rounded-card border border-border bg-muted/40">
              <div
                className="flex min-h-40 w-full items-center justify-center"
                style={{
                  aspectRatio: (() => {
                    if (!bitmap) return "3 / 4";
                    const quadAbs = denormalizeQuad(
                      page.quad,
                      bitmap.width,
                      bitmap.height
                    );
                    const size = quadOutputSize(quadAbs, 620);
                    const rotated = page.rotation === 90 || page.rotation === 270;
                    return `${rotated ? size.height : size.width} / ${rotated ? size.width : size.height}`;
                  })(),
                }}
              >
                <canvas
                  ref={previewCanvasRef}
                  role="img"
                  aria-label={t("scan.previewAria")}
                  className="max-h-full max-w-full object-contain"
                />
                {bitmapError ? (
                  <span className="absolute inset-0 flex items-center justify-center gap-2 bg-card/80 p-4 text-center text-xs font-medium text-destructive">
                    <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
                    {t("tool.errorDecode", { detail: file?.name ?? "" })}
                  </span>
                ) : null}
                {!bitmap && !bitmapError ? (
                  <Loader2
                    className="absolute size-5 animate-spin text-muted-foreground/60"
                    aria-hidden="true"
                  />
                ) : null}
              </div>
            </div>

            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("scan.filterTitle")}
            </p>
            <div
              className="grid grid-cols-2 gap-2"
              role="radiogroup"
              aria-label={t("scan.filterTitle")}
            >
              {FILTERS.map((entry) => {
                const active = page.filter === entry.id;
                const Icon = entry.icon;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onChangeFilter(entry.id)}
                    className={cn(
                      "flex min-h-11 items-center gap-2 rounded-btn border px-3 py-2 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      active
                        ? "border-primary/60 bg-primary/10 text-foreground"
                        : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    {t(`scan.filter.${entry.id}`)}
                    {active ? (
                      <Check
                        className="ml-auto size-3.5 text-primary"
                        aria-hidden="true"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-border p-4 sm:px-6">
          <Button type="button" variant="outline" onClick={onClose} className={TOOL_BTN}>
            {t("scan.editDone")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------ camera sheet ------------------------------ */

type CameraError = "denied" | "notfound" | "unsupported" | null;

function CameraSheet({
  existingCount,
  onDone,
  onClose,
}: {
  existingCount: number;
  onDone: (captured: File[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const busyRef = useRef(false);
  const shotUrlsRef = useRef<Set<string>>(new Set());

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<CameraError>(null);
  const [shots, setShots] = useState<{ url: string; file: File }[]>([]);
  const [overlay, setOverlay] = useState<{ quad: Quad; confident: boolean } | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [videoDims, setVideoDims] = useState<{ w: number; h: number } | null>(null);

  const maxShots = 30 - existingCount;

  // Stream lifecycle: open the rear camera, clean up on unmount/close.
  const startStream = useCallback(async () => {
    setError(null);
    setReady(false);
    if (
      typeof navigator === "undefined" ||
      typeof navigator.mediaDevices?.getUserMedia !== "function"
    ) {
      setError("unsupported");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 2560 },
          height: { ideal: 1440 },
        },
        audio: false,
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      setError(
        name === "NotAllowedError" || name === "SecurityError" ? "denied" : "notfound"
      );
      return;
    }
    streamRef.current = stream;
    const video = videoRef.current;
    if (video) {
      video.srcObject = stream;
      await video.play().catch(() => undefined);
    }
    setReady(true);
    const track = stream.getVideoTracks()[0];
    try {
      const caps = track?.getCapabilities?.();
      setTorchSupported(
        Boolean(caps && "torch" in caps && (caps as { torch?: unknown }).torch)
      );
    } catch {
      setTorchSupported(false);
    }
  }, []);

  useEffect(() => {
    void startStream();
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      for (const url of shotUrlsRef.current) URL.revokeObjectURL(url);
      shotUrlsRef.current.clear();
    };
  }, [startStream]);

  // Live edge detection — throttled overlay on the video feed.
  useEffect(() => {
    if (!ready) return;
    const small = document.createElement("canvas");
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || busyRef.current || video.videoWidth === 0) return;
      busyRef.current = true;
      try {
        const scale = Math.min(1, 240 / Math.max(video.videoWidth, video.videoHeight));
        const width = Math.max(1, Math.round(video.videoWidth * scale));
        const height = Math.max(1, Math.round(video.videoHeight * scale));
        small.width = width;
        small.height = height;
        const context = small.getContext("2d", { willReadFrequently: true });
        if (!context) return;
        context.drawImage(video, 0, 0, width, height);
        const data = context.getImageData(0, 0, width, height).data;
        const det = detectDocumentQuad(data, width, height);
        setOverlay({ quad: det.quad, confident: det.confidence > 0.45 });
      } catch {
        // Frame read hiccup — keep the last overlay, try next tick.
      } finally {
        busyRef.current = false;
      }
    }, 450);
    return () => {
      window.clearInterval(timer);
    };
  }, [ready]);

  const capture = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || capturing) return;
    setCapturing(true);
    try {
      const maxEdge = 2560;
      const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(video, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((result) => resolve(result), "image/jpeg", 0.95);
      });
      if (!blob) return;
      const file = new File(
        [blob],
        nextShotName(existingCount + shots.length + 1),
        { type: "image/jpeg" }
      );
      const url = URL.createObjectURL(blob);
      shotUrlsRef.current.add(url);
      setShots((prev) => [...prev, { url, file }]);
    } finally {
      setCapturing(false);
    }
  };

  const removeShot = (url: string) => {
    URL.revokeObjectURL(url);
    shotUrlsRef.current.delete(url);
    setShots((prev) => prev.filter((shot) => shot.url !== url));
  };

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
    }
  };

  const done = () => {
    // Hand over plain Files; the unmount cleanup revokes the display URLs.
    onDone(shots.map((shot) => shot.file));
  };

  const atLimit = shots.length >= maxShots;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("scan.cameraTitle")}
      className="fixed inset-0 z-[70] flex flex-col bg-black text-white"
    >
      {/* Header */}
      <div className="flex items-center gap-3 p-4 pb-2">
        <button
          type="button"
          onClick={onClose}
          aria-label={t("scan.closeCamera")}
          className="flex size-11 items-center justify-center rounded-full bg-white/10 outline-none transition-colors hover:bg-white/20 focus-visible:ring-[3px] focus-visible:ring-white/60"
        >
          <X className="size-5" aria-hidden="true" />
        </button>
        <p className="text-sm font-semibold">{t("scan.cameraTitle")}</p>
        {shots.length > 0 ? (
          <span className="ml-auto rounded-chip bg-white/10 px-2.5 py-1 text-[11px] font-semibold">
            {t("scan.shotsCount", { count: shots.length })}
          </span>
        ) : null}
      </div>

      {/* Video stage */}
      <div className="flex min-h-0 flex-1 items-center justify-center p-2">
        <div
          className="relative h-full"
          style={{ aspectRatio: videoDims ? `${videoDims.w} / ${videoDims.h}` : "3 / 4" }}
        >
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            onLoadedMetadata={(event) => {
              setVideoDims({
                w: event.currentTarget.videoWidth || 3,
                h: event.currentTarget.videoHeight || 4,
              });
            }}
            className="size-full rounded-card bg-black object-contain"
            aria-label={t("scan.cameraFeed")}
          />
          {/* Live detection overlay */}
          {overlay && videoDims ? (
            <svg
              aria-hidden="true"
              viewBox={`0 0 ${videoDims.w} ${videoDims.h}`}
              preserveAspectRatio="none"
              className={cn(
                "pointer-events-none absolute inset-0 size-full transition-opacity duration-300",
                overlay.confident ? "opacity-100" : "opacity-50"
              )}
            >
              <polygon
                points={quadPoints(overlay.quad)}
                fill={
                  overlay.confident
                    ? "rgba(16, 185, 129, 0.12)"
                    : "rgba(245, 158, 11, 0.08)"
                }
                stroke={overlay.confident ? "rgb(16, 185, 129)" : "rgb(245, 158, 11)"}
                strokeWidth={2.5}
                strokeDasharray={overlay.confident ? undefined : "8 6"}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          ) : null}

          {/* Error states */}
          {error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-card bg-black/80 p-6 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-white/10">
                {error === "denied" ? (
                  <CameraOff className="size-6" aria-hidden="true" />
                ) : (
                  <CircleAlert className="size-6" aria-hidden="true" />
                )}
              </span>
              <p className="max-w-sm text-sm font-semibold">
                {error === "denied"
                  ? t("scan.errDenied")
                  : error === "notfound"
                    ? t("scan.errNotFound")
                    : t("scan.errUnsupported")}
              </p>
              {error === "denied" ? (
                <p className="max-w-sm text-xs text-white/70">{t("scan.errDeniedHint")}</p>
              ) : null}
              <Button
                type="button"
                variant="outline"
                className="gap-2 rounded-btn border-white/30 bg-transparent text-white hover:bg-white/10 hover:text-white"
                onClick={() => void startStream()}
              >
                {t("scan.retry")}
              </Button>
            </div>
          ) : null}

          {!ready && !error ? (
            <div className="absolute inset-0 flex items-center justify-center rounded-card bg-black/60">
              <Loader2 className="size-6 animate-spin" aria-hidden="true" />
            </div>
          ) : null}

          {/* Detection status chip */}
          {ready && !error ? (
            <span
              className={cn(
                "pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-chip px-3 py-1.5 text-[11px] font-semibold shadow-lg backdrop-blur",
                overlay?.confident
                  ? "bg-emerald-500/90 text-white"
                  : "bg-black/60 text-white/90"
              )}
            >
              {overlay?.confident ? (
                <>
                  <Check className="size-3" aria-hidden="true" />
                  {t("scan.detected")}
                </>
              ) : (
                t("scan.searching")
              )}
            </span>
          ) : null}
        </div>
      </div>

      {/* Shots strip */}
      {shots.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto px-4 pb-2">
          {shots.map((shot, i) => (
            <div
              key={shot.url}
              className="relative shrink-0 overflow-hidden rounded-btn border-2 border-white/30"
            >
              <img
                src={shot.url}
                alt={t("scan.shotAlt", { index: i + 1 })}
                className="size-14 object-cover"
              />
              <span className="absolute bottom-0.5 left-0.5 rounded-chip bg-black/70 px-1 text-[10px] font-bold">
                {i + 1}
              </span>
              <button
                type="button"
                onClick={() => removeShot(shot.url)}
                aria-label={t("scan.removeShot", { index: i + 1 })}
                className="absolute right-0.5 top-0.5 flex size-5 items-center justify-center rounded-full bg-black/70 outline-none transition-colors hover:bg-destructive focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {/* Bottom controls */}
      <div className="flex items-center justify-between gap-3 px-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
        <div className="flex w-24 justify-start">
          {torchSupported ? (
            <button
              type="button"
              onClick={() => void toggleTorch()}
              aria-pressed={torchOn}
              aria-label={t("scan.torch")}
              className={cn(
                "flex size-11 items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-white/60",
                torchOn ? "bg-amber-400 text-black" : "bg-white/10 hover:bg-white/20"
              )}
            >
              {torchOn ? (
                <Zap className="size-5" aria-hidden="true" />
              ) : (
                <ZapOff className="size-5" aria-hidden="true" />
              )}
            </button>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => void capture()}
          disabled={!ready || atLimit || capturing}
          aria-label={atLimit ? t("scan.limitReached") : t("scan.capture")}
          className="group relative flex size-20 items-center justify-center rounded-full outline-none disabled:cursor-not-allowed focus-visible:ring-[3px] focus-visible:ring-white/60"
        >
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full border-[3px] border-white/80 transition-transform group-enabled:group-active:scale-90"
          />
          <span
            aria-hidden="true"
            className={cn(
              "size-15 rounded-full bg-white transition-colors",
              capturing && "animate-pulse",
              overlay?.confident && "bg-emerald-400"
            )}
          />
        </button>

        <div className="flex w-24 justify-end">
          <Button
            type="button"
            disabled={shots.length === 0}
            onClick={done}
            className="h-11 min-h-11 gap-1.5 rounded-btn bg-white px-4 text-xs font-semibold text-black hover:bg-white/90 disabled:opacity-40"
          >
            <Check className="size-4" aria-hidden="true" />
            {t("scan.doneShots")}
          </Button>
        </div>
      </div>

      {atLimit ? (
        <p className="px-6 pb-4 text-center text-[11px] text-white/70">
          {t("scan.limitReached")}
        </p>
      ) : null}
    </div>,
    document.body
  );
}
