"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  FileInput,
  FileX,
  Layers,
  Loader2,
  LockKeyhole,
  ScanSearch,
  SquareStack,
  TriangleAlert,
} from "lucide-react";

import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { PDF_DOC_PARAMS, loadPdfjs } from "@/lib/pdf/pdfjs";
import { getPdfPagePixelSize, renderPdfThumbnail } from "@/lib/pdf/thumbnails";
import { formatBytes } from "@/lib/storage/recent-files";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { cn } from "@/lib/utils";
import {
  PreviewPageStrip,
  PreviewZoomControl,
} from "../stamp-common/preview-parts";
import {
  overlayPageFor,
  overlayPlacement,
  resolveOverlayOptions,
  stampedCount,
  stampTargets,
} from "./engine";

/**
 * Overlay PDF surface (PRD §8.3) — the interactive product:
 *
 *  - TWO files with fixed roles: the first is the BASE (stays underneath),
 *    the second the OVERLAY (drawn on top). The compare-tool second-file
 *    prompt pattern covers the in-between state.
 *  - Live composite preview: the base page renders with pdf.js (white
 *    background), the mapped OVERLAY page renders onto a TRANSPARENT canvas
 *    (pdf.js, no white fill — exactly what `embedPdf` composites: only the
 *    content the page itself paints) and is drawn on top with the SAME
 *    placement math the worker uses — position, scale, opacity, rotation.
 *    What you see is what the PDF gets.
 *  - The base page strip (shared preview parts) dots every page that
 *    receives the overlay under the current mapping.
 */

const PREVIEW_MAX_DIM = 560;
/** Zoom presets — small corner stamps need a closer look. */
const ZOOM_STEPS = [1, 1.5, 2] as const;

type ProbeStatus = "working" | "done" | "encrypted" | "error";

interface ProbeState {
  file: File;
  status: ProbeStatus;
  pageCount: number;
}

interface BasePreview {
  file: File;
  pageIndex: number;
  bitmap: ImageBitmap;
  pdfW: number;
  pdfH: number;
}

interface OverlayPreview {
  file: File;
  pageIndex: number;
  bitmap: ImageBitmap;
}

export function OverlaySurface({
  files,
  values,
  setFileOrder,
  setRunBlocked,
  addFiles,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();

  const baseFile = files[0]?.file ?? null;
  const overlayFile = files[1]?.file ?? null;

  const opts = useMemo(() => resolveOverlayOptions(values), [values]);

  /* ---------------- probes (both files, unlock-pdf pattern) ---------------- */

  const [probeBase, setProbeBase] = useState<ProbeState | null>(null);
  const [probeOverlay, setProbeOverlay] = useState<ProbeState | null>(null);
  const overlayDocRef = useRef<PDFDocumentProxy | null>(null);

  const probe = useCallback(
    async (
      file: File | null,
      setProbe: (state: ProbeState | null) => void,
      setOverlayDoc: boolean
    ): Promise<void> => {
      if (file === null) {
        setProbe(null);
        if (setOverlayDoc) {
          overlayDocRef.current?.destroy().catch(() => undefined);
          overlayDocRef.current = null;
        }
        return;
      }
      await Promise.resolve(); // microtask reset — never synchronous
      setProbe({ file, status: "working", pageCount: 0 });
      try {
        const pdfjs = await loadPdfjs();
        const data = new Uint8Array(await file.arrayBuffer());
        const doc = await pdfjs.getDocument({ data, ...PDF_DOC_PARAMS })
          .promise;
        if (setOverlayDoc) {
          overlayDocRef.current?.destroy().catch(() => undefined);
          overlayDocRef.current = doc;
        } else {
          doc.destroy().catch(() => undefined);
        }
        setProbe({ file, status: "done", pageCount: doc.numPages });
      } catch (cause: unknown) {
        if (setOverlayDoc) overlayDocRef.current = null;
        const name =
          cause !== null && typeof cause === "object" && "name" in cause
            ? String((cause as { name: unknown }).name)
            : "";
        setProbe({
          file,
          status: name === "PasswordException" ? "encrypted" : "error",
          pageCount: 0,
        });
      }
    },
    []
  );

  useEffect(() => {
    void probe(baseFile, setProbeBase, false);
  }, [baseFile, probe]);

  useEffect(() => {
    void probe(overlayFile, setProbeOverlay, true);
    return () => {
      overlayDocRef.current?.destroy().catch(() => undefined);
      overlayDocRef.current = null;
    };
  }, [overlayFile, probe]);

  const activeBase =
    probeBase !== null && probeBase.file === baseFile ? probeBase : null;
  const activeOverlay =
    probeOverlay !== null && probeOverlay.file === overlayFile
      ? probeOverlay
      : null;
  const bothReady =
    activeBase?.status === "done" && activeOverlay?.status === "done";
  const baseCount = activeBase?.pageCount ?? 0;
  const overlayCount = activeOverlay?.pageCount ?? 0;

  /* ---------------- selection + gating ---------------- */

  const [selectedPage, setSelectedPage] = useState(0);
  useEffect(() => {
    setSelectedPage((page) => Math.min(page, Math.max(0, baseCount - 1)));
  }, [baseCount]);

  const targets = useMemo(
    () => (baseCount > 0 ? stampTargets(opts, baseCount) : []),
    [opts, baseCount]
  );
  const markedSet = useMemo(() => {
    const set = new Set<number>();
    if (targets !== null) {
      for (const index of targets) {
        if (overlayPageFor(opts.source, index, overlayCount) !== null) {
          set.add(index);
        }
      }
    }
    return set;
  }, [targets, opts.source, overlayCount]);

  const count = useMemo(
    () =>
      baseCount > 0 ? stampedCount(opts, baseCount, overlayCount) : null,
    [opts, baseCount, overlayCount]
  );

  // CTA gating: two files + a valid range + at least one stamped page.
  useEffect(() => {
    const key =
      files.length < 2
        ? "overlay.errorNeedTwo"
        : targets === null
          ? "wm.rangeInvalid"
          : count === 0
            ? "overlay.errorNoMatch"
            : null;
    setRunBlocked(key);
    return () => setRunBlocked(null);
  }, [files.length, targets, count, setRunBlocked]);

  /* ---------------- base page render (pdf.js, white) ---------------- */

  const [base, setBase] = useState<BasePreview | null>(null);
  const [baseFailed, setBaseFailed] = useState(false);

  useEffect(() => {
    if (!baseFile || !bothReady) return;
    let cancelled = false;
    setBase(null);
    setBaseFailed(false);
    void (async () => {
      try {
        const [thumb, pixel] = await Promise.all([
          renderPdfThumbnail(baseFile, {
            pageIndex: selectedPage,
            maxDim: PREVIEW_MAX_DIM,
          }),
          getPdfPagePixelSize(baseFile, 1, selectedPage),
        ]);
        if (cancelled) return;
        const bitmap = await createImageBitmap(thumb.blob);
        if (cancelled) return;
        setBase({
          file: baseFile,
          pageIndex: selectedPage,
          bitmap,
          pdfW: pixel.width,
          pdfH: pixel.height,
        });
      } catch {
        if (!cancelled) {
          setBaseFailed(true);
          setBase(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseFile, selectedPage, bothReady]);

  /* ---------------- overlay page render (transparent) ---------------- */

  const mappedOverlayIndex = useMemo(
    () =>
      bothReady && markedSet.has(selectedPage)
        ? overlayPageFor(opts.source, selectedPage, overlayCount)
        : null,
    [bothReady, markedSet, selectedPage, opts.source, overlayCount]
  );

  const [overlay, setOverlay] = useState<OverlayPreview | null>(null);
  const [overlayFailed, setOverlayFailed] = useState(false);

  useEffect(() => {
    const doc = overlayDocRef.current;
    if (!overlayFile || !doc || mappedOverlayIndex === null) {
      setOverlay(null);
      setOverlayFailed(false);
      return;
    }
    const pageIndex = mappedOverlayIndex;
    let cancelled = false;
    let page: PDFPageProxy | null = null;
    void (async () => {
      try {
        page = await doc.getPage(pageIndex + 1); // 1-based in pdf.js
        const base = page.getViewport({ scale: 1 });
        const scale = PREVIEW_MAX_DIM / Math.max(base.width, base.height);
        const viewport = page.getViewport({ scale });
        const width = Math.max(1, Math.round(viewport.width));
        const height = Math.max(1, Math.round(viewport.height));
        // TRANSPARENT render — pdf.js paints an opaque WHITE background by
        // default (RenderParameters.background); only an explicit alpha-0
        // fill leaves the canvas transparent, which is exactly what
        // embedPdf composites: just the content the page itself paints.
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("overlay-canvas");
        await page.render({
          canvasContext: context,
          viewport,
          background: "rgba(255,255,255,0)",
        }).promise;
        const bitmap = await createImageBitmap(canvas);
        if (cancelled) return;
        setOverlayFailed(false);
        setOverlay({ file: overlayFile, pageIndex, bitmap });
      } catch {
        if (!cancelled) {
          setOverlayFailed(true);
          setOverlay(null);
        }
      } finally {
        page?.cleanup();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [overlayFile, mappedOverlayIndex]);

  /* ---------------- THE composite painter — worker math ---------------- */

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState<(typeof ZOOM_STEPS)[number]>(1);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !base) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = base.bitmap.width;
    const h = base.bitmap.height;
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(base.bitmap, 0, 0);

    if (overlay) {
      // Overlay page size in PDF points (aspect source of truth).
      const ovW = overlay.bitmap.width;
      const ovH = overlay.bitmap.height;
      const s = w / base.pdfW; // px per PDF point
      const { boxW, boxH, cx, cy } = overlayPlacement(
        base.pdfW,
        base.pdfH,
        ovW,
        ovH,
        opts
      );
      const rad = (opts.rotation * Math.PI) / 180;
      ctx.save();
      ctx.globalAlpha = opts.opacity;
      // cy is PDF coords (y UP); canvas is y DOWN.
      ctx.translate(cx * s, (base.pdfH - cy) * s);
      ctx.rotate(-rad);
      ctx.drawImage(overlay.bitmap, (-boxW / 2) * s, (-boxH / 2) * s, boxW * s, boxH * s);
      ctx.restore();
    }
  }, [base, overlay, opts]);

  const removeFile = useCallback(
    (id: string): void => {
      setFileOrder(files.filter((item) => item.id !== id));
    },
    [files, setFileOrder]
  );

  /* ---------------- render ---------------- */

  if (files.length === 0) return null;

  const current =
    base !== null && base.file === baseFile && base.pageIndex === selectedPage
      ? base
      : null;
  // Base render failed → the failure box; the overlay failing alone keeps
  // the base preview with an honest amber note (never a silent miss).
  const previewFailed = baseFailed && current === null;

  return (
    <section
      aria-label={t("overlay.surfaceLabel")}
      className="flex flex-col gap-3"
    >
      {/* Role headers */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <RoleFileHeader
          roleKey="overlay.base"
          badgeKey="overlay.baseBadge"
          file={baseFile}
          pageCount={activeBase?.pageCount ?? 0}
          status={activeBase?.status ?? "none"}
          onRemove={files[0] ? () => removeFile(files[0].id) : undefined}
        />
        <RoleFileHeader
          roleKey="overlay.top"
          badgeKey="overlay.topBadge"
          file={overlayFile}
          pageCount={activeOverlay?.pageCount ?? 0}
          status={activeOverlay?.status ?? "none"}
          onRemove={files[1] ? () => removeFile(files[1].id) : undefined}
        />
      </div>

      {/* Second file prompt */}
      {files.length < 2 ? (
        <>
          <p className="flex items-start gap-2 rounded-card border border-dashed border-border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
            <Layers className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t("overlay.addSecond")}
          </p>
          <DropZone
            labelKey="overlay.dropSecond"
            multiple={false}
            maxFiles={2}
            acceptKind="pdf"
            onAccept={addFiles}
            currentCount={files.length}
            className="py-2"
          />
        </>
      ) : null}

      {/* Probe status */}
      <div aria-live="polite">
        {(activeBase?.status === "working" ||
          activeOverlay?.status === "working") && bothReady === false ? (
          <p
            role="status"
            className="flex items-center gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground"
          >
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            {t("overlay.reading")}
          </p>
        ) : null}
        {probeIssue(activeBase, "overlay.probeEncryptedBase", "overlay.probeErrorBase", t)}
        {probeIssue(activeOverlay, "overlay.probeEncryptedTop", "overlay.probeErrorTop", t)}
      </div>

      {bothReady && current ? (
        <>
          {/* Live preview card */}
          <div className="overflow-hidden rounded-card border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <ScanSearch className="size-3.5 text-primary" aria-hidden="true" />
                {t("overlay.previewTitle", { page: selectedPage + 1 })}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {targets === null ? (
                  <span className="flex items-center gap-1 rounded-chip bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                    <TriangleAlert className="size-3" aria-hidden="true" />
                    {t("wm.rangeInvalid")}
                  </span>
                ) : (
                  <span className="rounded-chip bg-primary/10 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-primary">
                    {t("overlay.markedCount", {
                      count: count ?? 0,
                      pages: baseCount,
                    })}
                  </span>
                )}
                <span
                  className={cn(
                    "rounded-chip px-2 py-0.5 text-[10px] font-semibold",
                    opts.behind
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {opts.behind ? t("overlay.behindChip") : t("overlay.frontChip")}
                </span>
                {mappedOverlayIndex !== null ? (
                  <span className="flex items-center gap-1 rounded-chip bg-cat-view/10 px-2 py-0.5 text-[10px] font-semibold text-cat-view">
                    <SquareStack className="size-3" aria-hidden="true" />
                    {t("overlay.pageUsed", { page: mappedOverlayIndex + 1 })}
                  </span>
                ) : (
                  <span className="rounded-chip bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                    {t("overlay.pageUnused")}
                  </span>
                )}
                <PreviewZoomControl
                  steps={ZOOM_STEPS}
                  value={zoom}
                  onChange={setZoom}
                />
              </div>
            </div>

            <div
              className={cn(
                "relative flex max-w-full justify-center bg-muted/30 px-4 py-5",
                zoom > 1
                  ? "overflow-x-auto overflow-y-hidden scrollbar-thin"
                  : "items-center"
              )}
            >
              {previewFailed ? (
                <div className="flex items-start gap-2.5 px-3 py-6 text-xs leading-relaxed text-muted-foreground">
                  <TriangleAlert
                    className="mt-0.5 size-4 shrink-0 text-amber-500"
                    aria-hidden="true"
                  />
                  {t("wm.previewFailed")}
                </div>
              ) : (
                <canvas
                  ref={canvasRef}
                  style={
                    zoom > 1
                      ? { width: `${Math.round(current.bitmap.width * zoom)}px` }
                      : undefined
                  }
                  className={cn(
                    "h-auto w-auto rounded-md border border-border/60 shadow-sm",
                    zoom > 1 ? "max-w-none shrink-0" : "max-h-[62vh] max-w-full"
                  )}
                  aria-label={t("overlay.previewTitle", { page: selectedPage + 1 })}
                  role="img"
                />
              )}
            </div>

            <p className="flex items-start gap-1.5 border-t border-border/60 px-4 py-2 text-[10px] leading-snug text-muted-foreground">
              {overlayFailed && mappedOverlayIndex !== null ? (
                <>
                  <TriangleAlert
                    className="mt-px size-3 shrink-0 text-amber-500"
                    aria-hidden="true"
                  />
                  <span className="text-amber-700 dark:text-amber-400">
                    {t("overlay.previewOverlayFailed")}
                  </span>
                </>
              ) : (
                t("overlay.previewNote")
              )}
            </p>
          </div>

          {/* Base page strip */}
          <PreviewPageStrip
            file={baseFile as File}
            pageCount={baseCount}
            selected={selectedPage}
            onSelect={setSelectedPage}
            markedSet={markedSet}
          />
        </>
      ) : null}

      {bothReady && !current && !previewFailed ? (
        <div className="flex items-center justify-center rounded-card border border-border bg-muted/30 px-4 py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      ) : null}
    </section>
  );
}

export default OverlaySurface;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function probeIssue(
  probe: ProbeState | null,
  encryptedKey: string,
  errorKey: string,
  t: (key: string) => string
): React.JSX.Element | null {
  if (probe === null) return null;
  if (probe.status === "encrypted") {
    return (
      <p className="flex items-start gap-2 rounded-card border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
        <LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        {t(encryptedKey)}
      </p>
    );
  }
  if (probe.status === "error") {
    return (
      <p className="flex items-start gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        {t(errorKey)}
      </p>
    );
  }
  return null;
}

function RoleFileHeader({
  roleKey,
  badgeKey,
  file,
  pageCount,
  status,
  onRemove,
}: {
  roleKey: string;
  badgeKey: string;
  file: File | null;
  pageCount: number;
  status: ProbeStatus | "none";
  onRemove?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3 rounded-card border border-border bg-card px-4 py-3">
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-btn",
          roleKey === "overlay.base"
            ? "bg-muted text-muted-foreground"
            : "bg-primary/10 text-primary"
        )}
        aria-hidden="true"
      >
        {roleKey === "overlay.base" ? (
          <FileInput className="size-5" />
        ) : (
          <Layers className="size-5" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t(roleKey)}
          <span
            className={cn(
              "rounded px-1 py-px text-[9px] font-bold",
              roleKey === "overlay.base"
                ? "bg-muted text-muted-foreground"
                : "bg-primary/10 text-primary"
            )}
          >
            {t(badgeKey)}
          </span>
        </p>
        {file !== null ? (
          <p className="truncate text-sm font-semibold text-foreground" title={file.name}>
            {file.name}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("overlay.waitingFile")}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {status === "done" && pageCount > 0 && file !== null
            ? t("compare.pages", {
                count: pageCount,
                size: formatBytes(file.size),
              })
            : status === "working"
              ? t("overlay.reading")
              : ""}
        </p>
      </div>
      {onRemove !== undefined && file !== null ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("tool.removeFileLabel", { name: file.name })}
          className="flex size-9 shrink-0 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <FileX className="size-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
