"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileText,
  Lightbulb,
  Loader2,
  LockKeyhole,
  ScanText,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { PDF_DOC_PARAMS, loadPdfjs } from "@/lib/pdf/pdfjs";
import { parsePageSpec } from "@/lib/workers/protocol";
import { PreviewFileHeader } from "../stamp-common/preview-parts";
import {
  extractWords,
  OCR_MAX_PIXELS,
  OCR_MODEL_MB,
  pageTextOf,
  resolveOcrOptions,
  type OcrWord,
  type ResolvedOcrOptions,
} from "./engine";
import { createOcrWorker, type TessWorkerApi } from "./tess";

/**
 * OCR PDF surface (PRD §8.4): the interactive part of the tool.
 *
 *  - Probe: a read-only main-thread pdf.js pass flags which pages already
 *    have a text layer (they get skipped by the run) — the summary chips
 *    the PRD's per-page view.
 *  - Preview OCR: one page, the SAME engine + language + DPI the run
 *    uses, drawn as confidence-colored boxes over the scan with an
 *    optional text overlay (the "text overlay toggle") + a confidence
 *    readout — check quality before committing to a long run.
 *
 * The run (worker) remains the authority; this surface never blocks it.
 */

/** Overlay elements cap — beyond it only boxes draw (honest note). */
const MAX_OVERLAY_WORDS = 2000;
/** Preview render DPI clamp base — same 40MP guard as the worker. */
function previewScale(widthPt: number, heightPt: number, dpi: number): number {
  let scale = Math.max(0.5, Math.min(8, dpi / 72));
  const pixels = widthPt * scale * heightPt * scale;
  if (pixels > OCR_MAX_PIXELS) {
    scale = Math.sqrt(OCR_MAX_PIXELS / (widthPt * heightPt));
  }
  return scale;
}

const LANG_LABELS: Record<ResolvedOcrOptions["langs"], { en: string; hi: string }> = {
  eng: { en: "English", hi: "अंग्रेज़ी" },
  hin: { en: "Hindi", hi: "हिंदी" },
  "eng+hin": { en: "English + Hindi", hi: "अंग्रेज़ी + हिंदी" },
};

function langLabel(langs: ResolvedOcrOptions["langs"], locale: string): string {
  const entry = LANG_LABELS[langs] ?? LANG_LABELS.eng;
  return locale === "hi" ? entry.hi : entry.en;
}

function modelMb(langs: string): number {
  return langs
    .split("+")
    .reduce((sum, code) => sum + (OCR_MODEL_MB[code as "eng" | "hin"] ?? 0), 0);
}

/* ------------------------------------------------------------------ */
/* Preview state                                                       */
/* ------------------------------------------------------------------ */

type PreviewState =
  | { phase: "idle" }
  | { phase: "model"; page: number }
  | { phase: "working"; page: number }
  | {
      phase: "done";
      page: number;
      langs: string;
      words: OcrWord[];
      confidence: number;
      text: string;
      imgW: number;
      imgH: number;
      imageUrl: string;
    }
  | { phase: "error"; page: number };

interface ProbeState {
  file: File;
  status: "working" | "ready" | "encrypted" | "error";
  pageCount: number;
  hasText: boolean[] | null;
}

type PreviewStatus = "working" | "ready" | "encrypted" | "error";

export function OcrSurface({
  files,
  values,
  onChange,
  setFileOrder,
  setRunBlocked,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t, locale } = useI18n();
  const fileMeta = files[0];
  const file = fileMeta?.file ?? null;
  const opts = resolveOcrOptions(values);

  const [probe, setProbe] = useState<ProbeState | null>(null);
  const [previewPageInput, setPreviewPageInput] = useState("1");
  const [preview, setPreview] = useState<PreviewState>({ phase: "idle" });
  const [overlayOn, setOverlayOn] = useState(true);

  /** Latest-ref for the shell onChange (used from async microtasks). */
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  /** Live tesseract preview worker (main thread); swapped when langs change. */
  const tessRef = useRef<{ langs: string; worker: TessWorkerApi } | null>(null);
  /** Current preview object URL — revoked on replace/unmount. */
  const previewUrlRef = useRef<string | null>(null);

  const revokePreviewUrl = useCallback(() => {
    if (previewUrlRef.current !== null) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  }, []);

  /* ---------------- text-layer probe (read-only) ---------------- */

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      // Reset on a microtask — never synchronously in the effect body.
      await Promise.resolve();
      if (cancelled) return;
      setProbe({ file, status: "working", pageCount: 0, hasText: null });

      const pdfjs = await loadPdfjs();
      const data = new Uint8Array(await file.arrayBuffer());
      const doc = await pdfjs.getDocument({ data, ...PDF_DOC_PARAMS })
        .promise;
      if (cancelled) {
        void doc.destroy().catch(() => undefined);
        return;
      }
      const hasText: boolean[] = [];
      try {
        for (let page = 1; page <= doc.numPages; page += 1) {
          if (cancelled) return;
          const pdfPage = await doc.getPage(page);
          const content = await pdfPage.getTextContent();
          pdfPage.cleanup();
          hasText.push(
            (content.items as { str?: unknown }[]).some(
              (item) => typeof item.str === "string" && item.str.trim() !== ""
            )
          );
        }
      } finally {
        await doc.destroy().catch(() => undefined);
      }
      if (cancelled) return;
      setProbe({ file, status: "ready", pageCount: hasText.length, hasText });
    })().catch((cause: unknown) => {
      if (cancelled) return;
      const name =
        cause !== null && typeof cause === "object" && "name" in cause
          ? String((cause as { name: unknown }).name)
          : "";
      setProbe({
        file,
        status: name === "PasswordException" ? "encrypted" : "error",
        pageCount: 0,
        hasText: null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const activeProbe =
    probe !== null && probe.file === file ? probe : null;
  const probeStatus: PreviewStatus | "none-yet" =
    activeProbe?.status ?? "none-yet";
  const pageCount =
    probeStatus === "ready" && activeProbe !== null ? activeProbe.pageCount : 0;
  const hasText =
    probeStatus === "ready" && activeProbe !== null ? activeProbe.hasText : null;

  const selectedPages =
    pageCount > 0 ? parsePageSpec(opts.pages, pageCount) : null;
  const imageOnlyCount =
    hasText !== null && selectedPages !== null
      ? selectedPages.filter((index) => !hasText[index]).length
      : 0;
  const withTextCount =
    hasText !== null && selectedPages !== null
      ? selectedPages.length - imageOnlyCount
      : 0;

  /* -------- share the probe with the panel (bookmark precedent) ------- */

  useEffect(() => {
    if (!file || probeStatus !== "ready" || pageCount === 0) return;
    const summary = `${pageCount}:${imageOnlyCount}:${withTextCount}`;
    if (String(values.probeSummary ?? "") === summary) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) onChangeRef.current("probeSummary", summary);
    });
    return () => {
      cancelled = true;
    };
  }, [
    file,
    probeStatus,
    pageCount,
    imageOnlyCount,
    withTextCount,
    values.probeSummary,
  ]);

  /* ---------------- run gating (CTA) ---------------- */

  const blockedKey =
    !file || pageCount === 0
      ? null
      : parsePageSpec(opts.pages, pageCount) === null
        ? "tool.errorInvalidPages"
        : null;

  useEffect(() => {
    setRunBlocked(blockedKey);
    return () => setRunBlocked(null);
  }, [blockedKey, setRunBlocked]);

  /* ---------------- preview OCR (one page, same engine) ---------------- */

  const getPreviewWorker = useCallback(
    async (langs: string): Promise<TessWorkerApi> => {
      if (tessRef.current?.langs === langs) return tessRef.current.worker;
      if (tessRef.current) {
        await tessRef.current.worker.terminate().catch(() => undefined);
        tessRef.current = null;
      }
      const worker = await createOcrWorker(langs, (message) => {
        setPreview((current) => {
          if (current.phase !== "model" && current.phase !== "working") {
            return current;
          }
          if (message.status === "loading language traineddata") {
            return { phase: "model", page: current.page };
          }
          if (message.status === "recognizing text") {
            return { phase: "working", page: current.page };
          }
          return current;
        });
      });
      tessRef.current = { langs, worker };
      return worker;
    },
    []
  );

  const runPreview = useCallback(async (): Promise<void> => {
    if (!file) return;
    const page = Math.max(1, Math.min(pageCount || 1, Number(previewPageInput) || 1));
    setPreviewPageInput(String(page));
    setPreview({ phase: "model", page });
    try {
      // 1. Render the page exactly the way the worker will (chosen DPI).
      const pdfjs = await loadPdfjs();
      const data = new Uint8Array(await file.arrayBuffer());
      const doc = await pdfjs.getDocument({ data, ...PDF_DOC_PARAMS }).promise;
      const pdfPage = await doc.getPage(page);
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = previewScale(base.width, base.height, opts.dpi);
      const viewport = pdfPage.getViewport({ scale });
      const pixelW = Math.max(1, Math.round(viewport.width));
      const pixelH = Math.max(1, Math.round(viewport.height));
      const canvas = new OffscreenCanvas(pixelW, pixelH);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas-2d-unavailable");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, pixelW, pixelH);
      await pdfPage.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      pdfPage.cleanup();
      await doc.destroy().catch(() => undefined);
      const blob = await canvas.convertToBlob({
        type: "image/jpeg",
        quality: 0.92,
      });

      // 2. Recognize with the same engine + language the run uses.
      const tess = await getPreviewWorker(opts.langs);
      setPreview({ phase: "working", page });
      const { data: result } = await tess.recognize(
        blob,
        {},
        { text: true, blocks: true }
      );
      const { words, confidence } = extractWords(
        (result as { blocks?: unknown }).blocks
      );
      revokePreviewUrl();
      const imageUrl = URL.createObjectURL(blob);
      previewUrlRef.current = imageUrl;
      setPreview({
        phase: "done",
        page,
        langs: opts.langs,
        words,
        confidence,
        text: pageTextOf(result),
        imgW: pixelW,
        imgH: pixelH,
        imageUrl,
      });
    } catch {
      setPreview({ phase: "error", page });
    }
  }, [
    file,
    pageCount,
    previewPageInput,
    opts.dpi,
    opts.langs,
    getPreviewWorker,
    revokePreviewUrl,
  ]);

  /* ---------------- cleanup ---------------- */

  useEffect(() => {
    return () => {
      revokePreviewUrl();
      const current = tessRef.current;
      tessRef.current = null;
      void current?.worker.terminate().catch(() => undefined);
    };
  }, [revokePreviewUrl]);

  /* ---------------- file actions ---------------- */

  const removeFirst = useCallback((): void => {
    setFileOrder(files.slice(1));
  }, [files, setFileOrder]);

  if (!file) return null;

  const busy =
    preview.phase === "model" || preview.phase === "working";
  const done =
    preview.phase === "done" && preview.langs === opts.langs
      ? preview
      : null;
  const overlayWords = done ? done.words.slice(0, MAX_OVERLAY_WORDS) : [];

  return (
    <section
      aria-label={t("ocr.surfaceLabel")}
      className="flex flex-col gap-3"
    >
      {/* File header (page count arrives from the probe) */}
      <PreviewFileHeader file={file} pageCount={pageCount} onRemove={removeFirst} />

      {/* Probe status */}
      <div aria-live="polite">
        {probeStatus === "working" || probeStatus === "none-yet" ? (
          <p
            role="status"
            className="flex items-center gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground"
          >
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            {t("ocr.probeWorking")}
          </p>
        ) : probeStatus === "encrypted" ? (
          <p className="flex items-start gap-2 rounded-card border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
            <LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t("ocr.probeEncrypted")}
          </p>
        ) : probeStatus === "error" ? (
          <p className="flex items-start gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t("ocr.probeError")}
          </p>
        ) : null}
      </div>

      {/* Probe summary chips (selected pages only) */}
      {probeStatus === "ready" && selectedPages !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-chip border border-border bg-card px-2.5 py-1 text-[11px] font-semibold tabular-nums text-foreground">
            {selectedPages.length === 1
              ? t("ocr.pagesTotalOne")
              : t("ocr.pagesTotal", { count: selectedPages.length })}
          </span>
          {imageOnlyCount > 0 ? (
            <span className="rounded-chip bg-cat-optimize/10 px-2.5 py-1 text-[11px] font-semibold tabular-nums text-cat-optimize">
              {imageOnlyCount === 1
                ? t("ocr.pagesImageOnlyOne")
                : t("ocr.pagesImageOnly", { count: imageOnlyCount })}
            </span>
          ) : null}
          {withTextCount > 0 ? (
            <span className="rounded-chip bg-cat-view/10 px-2.5 py-1 text-[11px] font-semibold tabular-nums text-cat-view">
              {withTextCount === 1
                ? t("ocr.pagesHaveTextOne")
                : t("ocr.pagesHaveText", { count: withTextCount })}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Honest notes */}
      {probeStatus === "ready" &&
      selectedPages !== null &&
      selectedPages.length > 0 &&
      imageOnlyCount === 0 ? (
        <p className="flex items-start gap-2 rounded-card border border-dashed border-border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          <FileText className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {t("ocr.allHaveText")}
        </p>
      ) : null}

      {/* ---------------- Preview OCR ---------------- */}
      <div className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
        <div className="flex flex-col gap-1">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <ScanText className="size-4 text-cat-optimize" aria-hidden="true" />
            {t("ocr.previewTitle")}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("ocr.previewIntro")}
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex w-24 flex-col gap-1.5">
            <Label htmlFor="ocr-preview-page" className="text-xs font-medium">
              {t("ocr.previewPageLabel")}
            </Label>
            <Input
              id="ocr-preview-page"
              type="number"
              inputMode="numeric"
              min={1}
              max={Math.max(1, pageCount)}
              step={1}
              value={previewPageInput}
              onChange={(event) => setPreviewPageInput(event.target.value)}
              disabled={busy}
              className="h-11 rounded-btn text-sm tabular-nums"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-11 min-h-11 rounded-btn px-4 text-xs font-medium"
            onClick={() => void runPreview()}
            disabled={busy || pageCount === 0}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <ScanText className="size-3.5" aria-hidden="true" />
            )}
            {t("ocr.previewRun")}
          </Button>
        </div>

        {/* Model download / progress note */}
        <div aria-live="polite">
          {preview.phase === "model" ? (
            <p
              role="status"
              className="flex items-center gap-2 rounded-btn border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
            >
              <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
              {t("ocr.previewModel", {
                lang: langLabel(opts.langs, locale),
                mb: modelMb(opts.langs).toFixed(1),
              })}
            </p>
          ) : null}
          {preview.phase === "working" ? (
            <p
              role="status"
              className="flex items-center gap-2 rounded-btn border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
            >
              <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
              {t("ocr.previewWorking", { page: preview.page })}
            </p>
          ) : null}
          {preview.phase === "error" ? (
            <p className="flex items-start gap-2 rounded-btn border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t("ocr.previewError")}
            </p>
          ) : null}
        </div>

        {/* Result: scan + confidence overlay + text */}
        {done !== null ? (
          <div className="flex flex-col gap-3">
            <p className="flex w-fit items-center gap-1.5 rounded-chip bg-cat-optimize/10 px-2.5 py-1 text-[11px] font-semibold tabular-nums text-cat-optimize">
              <ScanText className="size-3.5" aria-hidden="true" />
              {t("ocr.previewDone", {
                conf: Math.round(done.confidence),
                count: done.words.length,
                page: done.page,
              })}
            </p>

            <div className="relative overflow-hidden rounded-card border border-border bg-white">
              { }
              <img
                src={done.imageUrl}
                alt={t("ocr.previewTitle")}
                className="block h-auto w-full select-none"
                draggable={false}
              />
              <svg
                viewBox={`0 0 ${done.imgW} ${done.imgH}`}
                className="absolute inset-0 h-full w-full"
                aria-hidden="true"
              >
                {overlayWords.map((word, index) => {
                  const color =
                    word.confidence >= 80
                      ? "#10b981"
                      : word.confidence >= 50
                        ? "#f59e0b"
                        : "#f43f5e";
                  return (
                    <rect
                      key={`box-${index}`}
                      x={word.x0}
                      y={word.y0}
                      width={word.x1 - word.x0}
                      height={word.y1 - word.y0}
                      fill={color}
                      fillOpacity={0.22}
                      stroke={color}
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}
                {overlayOn
                  ? overlayWords.map((word, index) => {
                      const color =
                        word.confidence >= 80
                          ? "#047857"
                          : word.confidence >= 50
                            ? "#b45309"
                            : "#be123c";
                      return (
                        <text
                          key={`text-${index}`}
                          x={word.x0}
                          y={Math.max(word.y1 - 2, word.y0 + 4)}
                          fontSize={Math.max(6, (word.y1 - word.y0) * 0.75)}
                          fill={color}
                          fontWeight={600}
                        >
                          {word.text}
                        </text>
                      );
                    })
                  : null}
              </svg>
            </div>

            {/* Legend + overlay toggle */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <ul className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                <li className="flex items-center gap-1.5">
                  <span className="inline-block size-2.5 rounded-[3px] bg-emerald-500/60" aria-hidden="true" />
                  {t("ocr.confHigh")}
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="inline-block size-2.5 rounded-[3px] bg-amber-500/60" aria-hidden="true" />
                  {t("ocr.confMedium")}
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="inline-block size-2.5 rounded-[3px] bg-rose-500/60" aria-hidden="true" />
                  {t("ocr.confLow")}
                </li>
              </ul>
              <div className="flex items-center gap-2">
                <Label
                  htmlFor="ocr-overlay-toggle"
                  className="text-xs font-medium text-foreground"
                >
                  {t("ocr.overlayLabel")}
                </Label>
                <Switch
                  id="ocr-overlay-toggle"
                  checked={overlayOn}
                  onCheckedChange={setOverlayOn}
                />
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("ocr.overlayHint")}
            </p>

            {/* Recognized text snippet */}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">
                {t("ocr.textSnippetTitle")}
              </span>
              <pre className="max-h-40 overflow-y-auto scrollbar-thin whitespace-pre-wrap rounded-btn border border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-foreground">
                {done.text.trim().slice(0, 600) || "—"}
              </pre>
            </div>
          </div>
        ) : null}
      </div>

      {/* Accuracy tip (PRD §8.4 tip box) */}
      <div className="flex items-start gap-2 rounded-card border border-dashed border-cat-optimize/40 bg-cat-optimize/5 px-4 py-3 text-xs leading-relaxed text-foreground">
        <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-cat-optimize" aria-hidden="true" />
        <span>
          <span className="font-semibold">{t("ocr.tipTitle")}: </span>
          {t("ocr.tipBody")}
        </span>
      </div>
    </section>
  );
}

export default OcrSurface;
