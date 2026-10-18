"use client";

/**
 * Create card surface (PRD "Card") — the WYSIWYG greeting-card maker.
 * landingSurface (scan-pdf precedent): photos are OPTIONAL, so this
 * surface renders directly on the landing page in place of the DropZone
 * and embeds its own photo drop zone (shell addFiles pipeline). It keeps
 * its own export CTA (create-pdf worker-spawn pattern) so a card with
 * no photo can be created straight from the landing page; once photos
 * are added the shell's sticky Run CTA becomes a second, equivalent path
 * (same serialized recipe, same worker).
 *
 * STATE PERSISTENCE ACROSS REMOUNTS: the landing → workspace phase
 * switch remounts this component (different JSX branches), so every
 * piece of state survives through the serialized "card" option — the
 * initializer re-reads `values.card`, and every mutation re-serializes
 * (event-context only, collage pattern). Text rules (model.ts):
 * switching TEMPLATE resets the texts to the new template's defaults
 * for the CURRENT UI locale; switching the UI LANGUAGE never touches
 * typed texts (it only re-serializes so the output name localizes —
 * the collage "stale-locale file name" lesson).
 *
 * The live preview is painted by the SAME render.ts the worker uses,
 * with the self-hosted Devanagari font registered on the main thread so
 * Hindi measures correctly even on systems without one.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type JSX,
} from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Gift,
  ImagePlus,
  Loader2,
  Palette,
  Ruler,
  Sparkles,
  Table,
  TriangleAlert,
  Type,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { looksHeic, resolveHeicPreview } from "@/lib/heic/heic-preview";
import { decodeHeicToBitmap } from "@/lib/heic/heic-decode";
import { downloadBlob, sanitizeFileName } from "@/lib/files/output";
import { cn } from "@/lib/utils";
import {
  BLANK_BACKGROUNDS,
  CSV_MAX_CHARS,
  computeSheets,
  CsvError,
  DEFAULT_TEMPLATE_ID,
  defaultTextsFor,
  mergedTextsFor,
  outputBaseName,
  pagePixelSize,
  pagePtSize,
  parseCardOption,
  parseCsv,
  serializeCard,
  TEXT_FIELD_LIMITS,
  TEMPLATES,
  templateById,
  validatePlaceholders,
  type CardFormat,
  type CardOrientation,
  type CardTexts,
  type ExportFormat,
} from "./model";
import {
  drawCardSheet,
  loadTemplateBackdrop,
  type CardSheetMetrics,
  type CardSource,
} from "./render";

/* ------------------------------ helpers ------------------------------ */

const TOOL_BTN =
  "h-11 min-h-11 gap-1.5 rounded-btn px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50";

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

/** Preview-quality photo decode (HEIC uses the queued thumbnail). */
async function decodePreviewPhoto(file: File): Promise<CardSource> {
  let bitmap: ImageBitmap | null = null;
  if (looksHeic(file)) {
    const preview = await resolveHeicPreview(file);
    if (preview) {
      try {
        bitmap = await createImageBitmap(preview.blob);
      } catch {
        bitmap = null;
      }
    }
  }
  if (bitmap === null && looksTiff(file)) {
    bitmap = await tiffBitmap(file);
  }
  if (bitmap === null) {
    bitmap = await createImageBitmap(file);
  }
  return bitmap;
}

/** Full-resolution photo decode for the quick downloads (HEIC via libheif). */
async function decodeFullPhoto(file: File): Promise<CardSource> {
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
  if (bitmap === null) {
    throw new Error("decode-failed");
  }
  return bitmap;
}

/* ------------------------------ chips ------------------------------ */

/** Photo chip thumbnail with an honest icon fallback (HEIC etc.). */
function ChipImage({ src, alt }: { src: string; alt: string }): JSX.Element {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span className="flex size-11 items-center justify-center bg-muted text-muted-foreground">
        <ImagePlus className="size-4" aria-hidden="true" />
      </span>
    );
  }
  return (
     
    <img
      src={src}
      alt={alt}
      className="size-11 rounded-sm object-cover"
      onError={() => setBroken(true)}
      draggable={false}
    />
  );
}

/* ------------------------------ surface ------------------------------ */

interface SurfaceState {
  template: string;
  format: CardFormat;
  orientation: CardOrientation;
  texts: CardTexts;
  photoIndex: number | null;
  background: string;
  csvText: string;
  csvName: string;
  exportFormat: ExportFormat;
}

/** Field → fold panel tag (which printed panel the field lands on). */
const FOLD_PANEL_TAG: Record<keyof CardTexts, string | null> = {
  to: "card.panelBack",
  headline: "card.panelFront",
  sub: "card.panelFront",
  message: "card.panelInsideRight",
  venue: "card.panelInsideLeft",
  from: "card.panelBack",
};

const FORMATS: { id: CardFormat; key: string }[] = [
  { id: "flat-a6", key: "card.formatA6" },
  { id: "flat-a5", key: "card.formatA5" },
  { id: "flat-4x6", key: "card.format4x6" },
  { id: "fold-a4", key: "card.formatFold" },
];

const TEXT_FIELDS: {
  id: keyof CardTexts;
  labelKey: string;
  placeholderKey: string;
  multiline?: boolean;
}[] = [
  { id: "to", labelKey: "card.fieldTo", placeholderKey: "card.phTo" },
  { id: "headline", labelKey: "card.fieldHeadline", placeholderKey: "card.phHeadline" },
  { id: "sub", labelKey: "card.fieldSub", placeholderKey: "card.phSub" },
  {
    id: "message",
    labelKey: "card.fieldMessage",
    placeholderKey: "card.phMessage",
    multiline: true,
  },
  { id: "venue", labelKey: "card.fieldVenue", placeholderKey: "card.phVenue" },
  { id: "from", labelKey: "card.fieldFrom", placeholderKey: "card.phFrom" },
];

export function CardSurface({
  files,
  values,
  onChange,
  addFiles,
  setRunBlocked,
}: ToolSurfaceProps): JSX.Element {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  /* ---------------- state (survives remounts via values.card) ---------------- */

  const [state, setState] = useState<SurfaceState>(() => {
    const raw = values.card;
    if (typeof raw === "string" && raw !== "") {
      const parsed = parseCardOption(raw, files.length);
      return {
        template: parsed.template,
        format: parsed.format,
        orientation: parsed.orientation,
        texts: parsed.texts,
        photoIndex: parsed.photoIndex,
        background: parsed.background,
        csvText: parsed.csvText,
        csvName: parsed.csvName,
        exportFormat: parsed.exportFormat,
      };
    }
    return {
      template: DEFAULT_TEMPLATE_ID,
      format: "flat-a6",
      orientation: "portrait",
      texts: defaultTextsFor(DEFAULT_TEMPLATE_ID, locale),
      photoIndex: null,
      background: "#ffffff",
      csvText: "",
      csvName: "",
      exportFormat: "pdf",
    };
  });
  const [sheetIdx, setSheetIdx] = useState(0);
  const [previewRow, setPreviewRow] = useState(0);
  const [metrics, setMetrics] = useState<CardSheetMetrics>({
    headlineOverflowed: false,
    messageOverflowed: false,
  });
  const [pasteOpen, setPasteOpen] = useState(false);
  const [csvDraft, setCsvDraft] = useState("");
  const [csvDrag, setCsvDrag] = useState(false);
  const [quickBusy, setQuickBusy] = useState<"jpg" | "png" | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [done, setDone] = useState<{ name: string; pages: number } | null>(null);

  const csvInputRef = useRef<HTMLInputElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const urlCacheRef = useRef(new Map<string, string>());
  const bitmapCache = useRef(new Map<string, CardSource>());

  /* ---------------- fonts (self-hosted Devanagari for the preview) ---------------- */

  const [fontsTick, setFontsTick] = useState(0);
  useEffect(() => {
    const face = new FontFace(
      "Noto Sans Devanagari",
      "url(/fonts/NotoSansDevanagari-Regular.ttf)"
    );
    document.fonts.add(face);
    let alive = true;
    void face.load().then(() => {
      if (alive) setFontsTick((tick) => tick + 1);
    }).catch(() => undefined);
    void document.fonts.ready
      .then(() => {
        if (alive) setFontsTick((tick) => tick + 1);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      document.fonts.delete(face);
    };
  }, []);

  /* ---------------- option sync (event-context only) ---------------- */

  // Live mirror of the state for event handlers (React batches — a
  // render-time assignment below keeps it fresh; commits update it
  // eagerly so two mutations in one tick compose).
  const stateRef = useRef(state);

  const syncOption = useCallback(
    (next: SurfaceState): void => {
      onChange("card", serializeCard({ ...next, locale }));
    },
    [locale, onChange]
  );

  /**
   * The ONE commit path: sets local state AND re-serializes the option
   * — both OUTSIDE any setState updater (React runs updaters during
   * render, so calling the shell's onChange inside one is the classic
   * "update a component while rendering a different component" trap).
   */
  const commit = useCallback(
    (next: SurfaceState): void => {
      stateRef.current = next;
      setState(next);
      syncOption(next);
    },
    [syncOption]
  );

  const apply = useCallback(
    (partial: Partial<SurfaceState>): void => {
      commit({ ...stateRef.current, ...partial });
    },
    [commit]
  );

  // Mount sync: the serialized option mirrors the freshly initialized
  // state (which was itself re-read from values.card — so a phase
  // remount keeps the recipe, and a fresh session starts clean).
  const initialSync = useRef(false);
  useEffect(() => {
    if (initialSync.current) return;
    initialSync.current = true;
    void Promise.resolve().then(() => {
      syncOption(state);
    });
    // Mount-only by design (state is the initializer's value).
     
  }, []);

  // Language switch re-sync: `locale` rides the serialized option (it
  // names the output file), so switching EN ↔ HI after the last edit
  // must re-serialize (the collage stale-locale lesson). Typed texts
  // are NEVER touched here.
  stateRef.current = state;
  const localeSeen = useRef(locale);
  useEffect(() => {
    if (localeSeen.current === locale) return;
    localeSeen.current = locale;
    void Promise.resolve().then(() => {
      syncOption(stateRef.current);
    });
  }, [locale, syncOption]);

  /* ---------------- CSV (parse + validate on the main thread) ---------------- */

  const csv = useMemo(() => {
    if (state.csvText.trim() === "") {
      return { status: "none" as const };
    }
    try {
      const parsed = parseCsv(state.csvText);
      if (parsed.rows.length === 0) {
        return { status: "none" as const };
      }
      return {
        status: "ok" as const,
        columns: parsed.columns,
        rows: parsed.rows,
        unknown: validatePlaceholders(state.texts, parsed.columns),
      };
    } catch (error) {
      const code =
        error instanceof CsvError ? error.code : "card.errorCsvQuote";
      return { status: "error" as const, code };
    }
  }, [state.csvText, state.texts]);

  const csvBlockKey = csv.status === "error" ? csv.code : null;

  // Block BOTH CTAs on a broken CSV (the sticky bar gets the key; the
  // surface's own CTA checks the same flag). Unknown column names stay
  // a warning — the run then fails with the honest worker error that
  // lists them.
  useEffect(() => {
    setRunBlocked(csvBlockKey);
  }, [csvBlockKey, setRunBlocked]);

  const mergeRows = csv.status === "ok" ? csv.rows.length : 1;
  const csvColumns = csv.status === "ok" ? csv.columns : [];
  const csvUnknown = csv.status === "ok" ? csv.unknown : [];

  const row = Math.min(previewRow, Math.max(0, mergeRows - 1));

  const readCsvFile = useCallback(
    (file: File): void => {
      void file
        .text()
        .then((text) => {
          if (text.length > CSV_MAX_CHARS) {
            toast({
              title: t("tool.errorTitle"),
              description: t("card.errorCsvSize"),
              variant: "destructive",
            });
            return;
          }
          commit({
            ...stateRef.current,
            csvText: text,
            csvName: file.name.replace(/[\u0000-\u001f]/g, "").slice(0, 120),
          });
        })
        .catch(() => {
          toast({
            title: t("tool.errorTitle"),
            description: t("tool.errorGeneric"),
            variant: "destructive",
          });
        });
    },
    [commit, t, toast]
  );

  const onCsvDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      setCsvDrag(false);
      const dropped = Array.from(event.dataTransfer?.files ?? [])[0];
      if (dropped) readCsvFile(dropped);
    },
    [readCsvFile]
  );

  const onCsvPick = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const picked = event.target.files?.[0];
      if (picked) readCsvFile(picked);
      event.target.value = "";
    },
    [readCsvFile]
  );

  const applyPastedCsv = useCallback((): void => {
    const text = csvDraft;
    if (text.trim() === "") return;
    commit({
      ...stateRef.current,
      csvText: text,
      csvName: t("card.csvPastedName"),
    });
    setPasteOpen(false);
  }, [commit, csvDraft, t]);

  const clearCsv = useCallback((): void => {
    setCsvDraft("");
    setPasteOpen(false);
    commit({ ...stateRef.current, csvText: "", csvName: "" });
  }, [commit]);

  /* ---------------- photo reconcile ---------------- */

  // A removed photo file must never leave a dangling photoIndex.
  useEffect(() => {
    const current = stateRef.current;
    if (current.photoIndex === null) return;
    if (current.photoIndex < files.length) return;
    apply({
      photoIndex: files.length > 0 ? files.length - 1 : null,
    });
  }, [apply, files]);

  const photoUrl = useCallback((id: string, file: File): string => {
    let url = urlCacheRef.current.get(id);
    if (!url) {
      url = URL.createObjectURL(file);
      urlCacheRef.current.set(id, url);
    }
    return url;
  }, []);

  useEffect(() => {
    const cache = bitmapCache.current;
    const urls = urlCacheRef.current;
    return () => {
      for (const source of cache.values()) {
        if ("close" in source && typeof source.close === "function") source.close();
      }
      cache.clear();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  /* ---------------- derived ---------------- */

  const sheets = useMemo(
    () => computeSheets(state.format, mergeRows),
    [state.format, mergeRows]
  );
  const sheetIndex =
    state.format === "fold-a4" ? Math.min(sheetIdx, 1) + row * 2 : row;
  const sheet = sheets[Math.min(sheetIndex, sheets.length - 1)] ?? sheets[0];

  /** Texts of the currently previewed merge row. */
  const effTexts = useMemo(
    () =>
      csv.status === "ok"
        ? mergedTextsFor(state.texts, csv.rows[row] ?? null, csv.columns)
        : state.texts,
    [csv, row, state.texts]
  );

  const template = templateById(state.template);
  const isFold = state.format === "fold-a4";
  const pt = pagePtSize(state.format, state.orientation);

  /* ---------------- live preview (shared engine) ---------------- */

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [previewW, setPreviewW] = useState(0);
  const renderToken = useRef(0);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver((observed) => {
      const width = observed[0]?.contentRect.width ?? 0;
      if (width > 0) setPreviewW(Math.round(Math.min(560, width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (previewW === 0 || !sheet) return;
    const token = renderToken.current + 1;
    renderToken.current = token;
    const timer = setTimeout(() => {
      void (async () => {
        const canvas = canvasRef.current;
        if (!canvas || renderToken.current !== token) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const width = Math.round(previewW * dpr);
        const height = Math.round((previewW * pt.h) / pt.w * dpr);
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${previewW}px`;
        canvas.style.height = `${Math.round((previewW * pt.h) / pt.w)}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const backdrop = await loadTemplateBackdrop(template.bg);
        if (renderToken.current !== token) return;
        const style = {
          template: state.template,
          format: state.format,
          orientation: state.orientation,
          texts: effTexts,
          background: state.background,
        };
        const hasPhoto = state.photoIndex !== null;
        // Skeleton first (backdrop + placeholder photo slot), so the
        // design is visible while the photo decodes.
        const drawn = drawCardSheet(ctx, sheet, style, { photo: null, backdrop }, hasPhoto);
        setMetrics(drawn);
        const ref = state.photoIndex !== null ? files[state.photoIndex] : undefined;
        if (!ref || !hasPhoto) return;
        let photo = bitmapCache.current.get(ref.id) ?? null;
        if (!photo) {
          try {
            photo = await decodePreviewPhoto(ref.file);
            bitmapCache.current.set(ref.id, photo);
          } catch {
            return; // placeholder stays; the run raises the honest error
          }
        }
        if (renderToken.current !== token) return;
        drawCardSheet(ctx, sheet, style, { photo, backdrop }, true);
      })().catch(() => undefined);
    }, 140);
    return () => clearTimeout(timer);
  }, [
    effTexts,
    files,
    fontsTick,
    previewW,
    pt.h,
    pt.w,
    sheet,
    state.background,
    state.format,
    state.orientation,
    state.photoIndex,
    state.template,
    template.bg,
  ]);

  /* ---------------- text mutations ---------------- */

  const setText = useCallback(
    (field: keyof CardTexts, value: string): void => {
      const current = stateRef.current;
      commit({
        ...current,
        texts: {
          ...current.texts,
          [field]: value.slice(0, TEXT_FIELD_LIMITS[field]),
        },
      });
    },
    [commit]
  );

  const pickTemplate = useCallback(
    (templateId: string): void => {
      commit({
        ...stateRef.current,
        template: templateId,
        // Switching templates resets the texts to the new template's
        // defaults for the CURRENT UI locale (model.ts rule).
        texts: defaultTextsFor(templateId, locale),
      });
    },
    [commit, locale]
  );

  /* ---------------- quick downloads (page 1, main thread) ---------------- */

  const downloadImage = useCallback(
    async (format: "jpg" | "png"): Promise<void> => {
      if (quickBusy) return;
      setQuickBusy(format);
      try {
        const backdrop = await loadTemplateBackdrop(templateById(state.template).bg);
        let photo: CardSource | null = null;
        const ref = state.photoIndex !== null ? files[state.photoIndex] : undefined;
        if (ref) {
          try {
            photo = await decodeFullPhoto(ref.file);
          } catch {
            photo = null;
          }
        }
        const px = pagePixelSize(state.format, state.orientation);
        const canvas = document.createElement("canvas");
        canvas.width = px.w;
        canvas.height = px.h;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas-2d-unavailable");
        const texts =
          csv.status === "ok"
            ? mergedTextsFor(state.texts, csv.rows[0] ?? null, csv.columns)
            : state.texts;
        drawCardSheet(
          ctx,
          sheets[0],
          {
            template: state.template,
            format: state.format,
            orientation: state.orientation,
            texts,
            background: state.background,
          },
          { photo, backdrop },
          state.photoIndex !== null
        );
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(
            resolve,
            format === "png" ? "image/png" : "image/jpeg",
            0.92
          )
        );
        if (!blob) throw new Error("encode-failed");
        downloadBlob(
          blob,
          sanitizeFileName(outputBaseName(locale, format, mergeRows), format)
        );
      } catch {
        toast({ title: t("card.quickFailed"), variant: "destructive" });
      } finally {
        setQuickBusy(null);
      }
    },
    [
      csv,
      files,
      locale,
      mergeRows,
      quickBusy,
      sheets,
      state.background,
      state.format,
      state.orientation,
      state.photoIndex,
      state.template,
      state.texts,
      t,
      toast,
    ]
  );

  /* ---------------- export (surface-driven run, create-pdf pattern) ---------------- */

  const runDisabledLocal =
    pct !== null ||
    csvBlockKey !== null ||
    (csv.status === "ok" && csvUnknown.length > 0);

  const createCard = useCallback((): void => {
    if (workerRef.current) return;
    setPct(0);
    setDone(null);
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    const runId = Date.now();
    const cleanup = (): void => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
    worker.addEventListener(
      "message",
      (event: MessageEvent<{ type: string; runId: number; pct?: number; code?: string; detail?: string; outputs?: { name: string; blob: Blob }[] }>) => {
        const data = event.data;
        if (!data || data.runId !== runId) return;
        if (data.type === "progress") {
          setPct(data.pct ?? 0);
          return;
        }
        if (data.type === "result") {
          const output = data.outputs?.[0];
          setPct(null);
          if (output) {
            downloadBlob(output.blob, sanitizeFileName(output.name, "pdf"));
            const pages = sheets.length;
            setDone({ name: output.name, pages });
            toast({
              title: t("card.doneTitle"),
              description: t("card.doneDesc", { name: output.name }),
            });
          }
          cleanup();
          return;
        }
        if (data.type === "error") {
          setPct(null);
          toast({
            title: t("tool.errorTitle"),
            description: t(data.code ?? "tool.errorGeneric", {
              detail: data.detail ?? "",
            }),
            variant: "destructive",
          });
          cleanup();
        }
      }
    );
    worker.addEventListener("error", () => {
      setPct(null);
      toast({
        title: t("tool.errorTitle"),
        description: t("tool.errorGeneric"),
        variant: "destructive",
      });
      cleanup();
    });
    worker.postMessage({
      type: "run",
      runId,
      toolId: "create-card",
      options: { card: serializeCard({ ...state, locale }) },
      files: files.map((ref) => ref.file),
    });
  }, [files, locale, sheets.length, state, t, toast]);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  /* ---------------- render ---------------- */

  const busy = pct !== null;
  const triggerClass = "h-11 w-full rounded-btn text-sm";

  return (
    <section aria-label={t("card.surfaceLabel")} className="flex flex-col gap-3">
      {/* Header — stats */}
      <div className="flex flex-col gap-2 rounded-card border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-chip bg-cat-create/10 px-2.5 py-1 text-[11px] font-semibold text-cat-create">
            {t("card.pagesChip", { count: sheets.length })}
          </span>
          {mergeRows > 1 ? (
            <span className="rounded-chip bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
              {t("card.recipientsChip", { count: mergeRows })}
            </span>
          ) : null}
          {files.length > 0 ? (
            <span className="rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              {t("card.photoChip", { count: files.length })}
            </span>
          ) : null}
        </div>
        <p className="text-[11px] text-muted-foreground">{t("card.hint")}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-6">
        {/* ---------------- live preview ---------------- */}
        <figure className="flex min-w-0 flex-col items-center gap-3">
          <div ref={wrapRef} className="flex w-full justify-center">
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={t("card.previewAlt", {
                page: state.format === "fold-a4" ? Math.min(sheetIdx, 1) + 1 : 1,
                pages: state.format === "fold-a4" ? 2 : 1,
              })}
              className="max-w-full rounded-sm border border-border bg-white shadow-md"
            />
          </div>
          <figcaption className="flex w-full flex-col items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t("card.previewLabel")}
            </span>
            {isFold ? (
              <ToggleGroup
                type="single"
                value={String(Math.min(sheetIdx, 1))}
                onValueChange={(value) => {
                  if (value !== "") setSheetIdx(Number(value));
                }}
                className="justify-center"
              >
                <ToggleGroupItem
                  value="0"
                  aria-label={t("card.sideOutside")}
                  className="min-h-11 rounded-btn text-xs"
                >
                  {t("card.sideOutside")}
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="1"
                  aria-label={t("card.sideInside")}
                  className="min-h-11 rounded-btn text-xs"
                >
                  {t("card.sideInside")}
                </ToggleGroupItem>
              </ToggleGroup>
            ) : null}
            {mergeRows > 1 ? (
              <span className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-11 rounded-btn"
                  onClick={() => setPreviewRow(Math.max(0, row - 1))}
                  disabled={row === 0}
                  aria-label={t("card.prevRow")}
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </Button>
                <span className="min-w-28 text-center text-xs font-medium text-foreground">
                  {t("card.rowOf", { row: row + 1, rows: mergeRows })}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-11 rounded-btn"
                  onClick={() => setPreviewRow(Math.min(mergeRows - 1, row + 1))}
                  disabled={row >= mergeRows - 1}
                  aria-label={t("card.nextRow")}
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </Button>
              </span>
            ) : null}
            {metrics.headlineOverflowed ? (
              <p className="flex items-center gap-1.5 rounded-chip bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                {t("card.headlineOverflowBadge")}
              </p>
            ) : null}
            {metrics.messageOverflowed ? (
              <p className="flex items-center gap-1.5 rounded-chip bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                {t("card.overflowBadge")}
              </p>
            ) : null}
            {isFold ? (
              <p className="max-w-md text-center text-[11px] leading-relaxed text-muted-foreground">
                {t("card.foldPrintNote")}
              </p>
            ) : null}
          </figcaption>
        </figure>

        {/* ---------------- controls ---------------- */}
        <div className="flex flex-col gap-4">
          {/* Template picker */}
          <fieldset className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
            <legend className="flex items-center gap-1.5 px-1 text-sm font-semibold text-foreground">
              <Gift className="size-4 text-primary" aria-hidden="true" />
              {t("card.templateLabel")}
            </legend>
            <div className="grid grid-cols-4 gap-2">
              {TEMPLATES.map((item) => {
                const selected = state.template === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => pickTemplate(item.id)}
                    className={
                      "group flex flex-col items-center gap-1.5 rounded-btn border p-1.5 outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
                      (selected
                        ? "border-primary bg-accent/50"
                        : "border-border bg-background hover:border-primary/40 hover:bg-accent/40")
                    }
                  >
                    <span className="block aspect-[3/4] w-full overflow-hidden rounded-sm border border-border">
                      {item.bg ? (
                         
                        <img
                          src={item.bg}
                          alt=""
                          className="size-full object-cover"
                          loading="lazy"
                          draggable={false}
                        />
                      ) : (
                        <span
                          className="block size-full"
                          style={{ backgroundColor: state.background }}
                        />
                      )}
                    </span>
                    <span className="w-full truncate text-center text-[10px] font-medium text-foreground">
                      {item.label[locale]}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t("card.templateNote")}
            </p>
            {template.bg === null ? (
              <div className="flex flex-col gap-2 border-t border-border pt-3">
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Palette className="size-3.5" aria-hidden="true" />
                  {t("card.backgroundLabel")}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  {BLANK_BACKGROUNDS.map((swatch) => (
                    <button
                      key={swatch.hex}
                      type="button"
                      aria-pressed={state.background === swatch.hex}
                      aria-label={swatch.label[locale]}
                      onClick={() => apply({ background: swatch.hex })}
                      className={
                        "size-11 rounded-btn border-2 outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
                        (state.background === swatch.hex
                          ? "border-primary"
                          : "border-border hover:border-primary/40")
                      }
                      style={{ backgroundColor: swatch.hex }}
                    />
                  ))}
                  <label className="flex h-11 cursor-pointer items-center gap-2 rounded-btn border border-border px-3 text-xs text-muted-foreground">
                    {t("card.customColorLabel")}
                    <input
                      type="color"
                      value={state.background}
                      onChange={(event) =>
                        apply({ background: event.target.value })
                      }
                      className="size-6 cursor-pointer border-0 bg-transparent p-0"
                      aria-label={t("card.customColorLabel")}
                    />
                  </label>
                </div>
              </div>
            ) : null}
          </fieldset>

          {/* Format + orientation */}
          <fieldset className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
            <legend className="flex items-center gap-1.5 px-1 text-sm font-semibold text-foreground">
              <Ruler className="size-4 text-primary" aria-hidden="true" />
              {t("card.formatLabel")}
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {FORMATS.map((item) => (
                <Button
                  key={item.id}
                  type="button"
                  variant={state.format === item.id ? "default" : "outline"}
                  aria-pressed={state.format === item.id}
                  onClick={() => apply({ format: item.id })}
                  className="h-11 min-h-11 rounded-btn text-xs font-medium"
                >
                  {t(item.key)}
                </Button>
              ))}
            </div>
            {isFold ? (
              <p className="text-[11px] text-muted-foreground">
                {t("card.orientationFoldHint")}
              </p>
            ) : (
              <ToggleGroup
                type="single"
                value={state.orientation}
                onValueChange={(value) => {
                  if (value !== "") {
                    apply({ orientation: value as CardOrientation });
                  }
                }}
                className="w-full"
              >
                <ToggleGroupItem
                  value="portrait"
                  aria-label={t("card.orientationPortrait")}
                  className="min-h-11 flex-1 rounded-btn text-xs"
                >
                  {t("card.orientationPortrait")}
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="landscape"
                  aria-label={t("card.orientationLandscape")}
                  className="min-h-11 flex-1 rounded-btn text-xs"
                >
                  {t("card.orientationLandscape")}
                </ToggleGroupItem>
              </ToggleGroup>
            )}
          </fieldset>

          {/* Text fields */}
          <fieldset className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
            <legend className="flex items-center gap-1.5 px-1 text-sm font-semibold text-foreground">
              <Type className="size-4 text-primary" aria-hidden="true" />
              {t("card.textLabel")}
            </legend>
            {TEXT_FIELDS.map((field) => (
              <div key={field.id} className="flex flex-col gap-1.5">
                <Label
                  htmlFor={`card-${field.id}`}
                  className="flex items-center gap-2 text-xs font-medium text-muted-foreground"
                >
                  {t(field.labelKey)}
                  {isFold && FOLD_PANEL_TAG[field.id] ? (
                    <span className="rounded-chip bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {t(FOLD_PANEL_TAG[field.id] as string)}
                    </span>
                  ) : null}
                </Label>
                {field.multiline ? (
                  <Textarea
                    id={`card-${field.id}`}
                    value={state.texts[field.id]}
                    onChange={(event) => setText(field.id, event.target.value)}
                    placeholder={t(field.placeholderKey)}
                    rows={4}
                    maxLength={TEXT_FIELD_LIMITS[field.id]}
                    className="min-h-11 rounded-btn text-sm"
                  />
                ) : (
                  <Input
                    id={`card-${field.id}`}
                    value={state.texts[field.id]}
                    onChange={(event) => setText(field.id, event.target.value)}
                    placeholder={t(field.placeholderKey)}
                    maxLength={TEXT_FIELD_LIMITS[field.id]}
                    className="h-11 rounded-btn text-sm"
                  />
                )}
              </div>
            ))}
          </fieldset>

          {/* Photo (optional) */}
          <fieldset className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
            <legend className="flex items-center gap-1.5 px-1 text-sm font-semibold text-foreground">
              <ImagePlus className="size-4 text-primary" aria-hidden="true" />
              {t("card.photosLabel")}
            </legend>
            <p className="text-[11px] text-muted-foreground">
              {t("card.photosHint")}
            </p>
            {files.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  aria-pressed={state.photoIndex === null}
                  aria-label={t("card.photoRemoveLabel")}
                  onClick={() => apply({ photoIndex: null })}
                  className={
                    "flex h-11 min-w-11 items-center gap-1.5 rounded-btn border px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
                    (state.photoIndex === null
                      ? "border-primary bg-accent/50 text-foreground"
                      : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground")
                  }
                >
                  <X className="size-3.5" aria-hidden="true" />
                  {t("card.photoNone")}
                </button>
                {files.map((ref, index) => {
                  const selected = state.photoIndex === index;
                  return (
                    <button
                      key={ref.id}
                      type="button"
                      aria-pressed={selected}
                      aria-label={t("card.photoPickLabel", { name: ref.file.name })}
                      onClick={() => apply({ photoIndex: index })}
                      className={
                        "rounded-btn border-2 p-0.5 outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
                        (selected
                          ? "border-primary"
                          : "border-border hover:border-primary/40")
                      }
                    >
                      <ChipImage
                        src={photoUrl(ref.id, ref.file)}
                        alt={ref.file.name}
                      />
                    </button>
                  );
                })}
              </div>
            ) : null}
            {files.length < 8 ? (
              <DropZone
                labelKey="card.addPhoto"
                multiple
                maxFiles={8}
                acceptKind="image"
                onAccept={addFiles}
                currentCount={files.length}
                className="border-dashed py-4"
              />
            ) : null}
          </fieldset>

          {/* CSV mail merge */}
          <fieldset className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
            <legend className="flex items-center gap-1.5 px-1 text-sm font-semibold text-foreground">
              <Table className="size-4 text-primary" aria-hidden="true" />
              {t("card.csvLabel")}
            </legend>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("card.csvHint")}
            </p>

            {state.csvText.trim() === "" ? (
              <>
                <div
                  onDragOver={(event) => {
                    event.preventDefault();
                    setCsvDrag(true);
                  }}
                  onDragLeave={() => setCsvDrag(false)}
                  onDrop={onCsvDrop}
                  className={cn(
                    "flex flex-col items-center gap-2 rounded-card border border-dashed p-4 text-center",
                    csvDrag
                      ? "border-primary bg-accent/40"
                      : "border-border bg-background"
                  )}
                >
                  <p className="text-xs font-medium text-foreground">
                    {t("card.csvDrop")}
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className={TOOL_BTN}
                      onClick={() => csvInputRef.current?.click()}
                    >
                      {t("card.csvFileLabel")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className={TOOL_BTN}
                      onClick={() => setPasteOpen((open) => !open)}
                    >
                      {t("card.csvPasteToggle")}
                    </Button>
                  </div>
                  <input
                    ref={csvInputRef}
                    type="file"
                    accept=".csv,.txt,text/csv,text/plain"
                    onChange={onCsvPick}
                    className="hidden"
                    aria-hidden="true"
                    tabIndex={-1}
                  />
                </div>
                {pasteOpen ? (
                  <div className="flex flex-col gap-2">
                    <Textarea
                      value={csvDraft}
                      onChange={(event) => setCsvDraft(event.target.value)}
                      placeholder={t("card.csvPastePlaceholder")}
                      rows={5}
                      className="rounded-btn text-xs"
                      aria-label={t("card.csvPasteToggle")}
                    />
                    <Button
                      type="button"
                      className="h-11 min-h-11 rounded-btn text-xs font-semibold"
                      onClick={applyPastedCsv}
                      disabled={csvDraft.trim() === ""}
                    >
                      {t("card.csvApply")}
                    </Button>
                  </div>
                ) : null}
                <p className="text-[11px] text-muted-foreground">
                  {t("card.csvNone")}
                </p>
              </>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="max-w-full truncate rounded-chip bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground">
                    {state.csvName}
                  </span>
                  <span className="rounded-chip bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
                    {t("card.recipientsChip", { count: mergeRows })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    className="ml-auto h-11 min-h-11 rounded-btn px-2 text-xs text-muted-foreground"
                    onClick={clearCsv}
                    aria-label={t("card.csvClear")}
                  >
                    <X className="size-4" aria-hidden="true" />
                    {t("card.csvClear")}
                  </Button>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {t("card.csvColumns")}
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {csvColumns.map((column) => (
                      <span
                        key={column}
                        className="rounded-chip bg-muted px-2 py-0.5 text-[10px] font-medium text-foreground"
                      >
                        {column}
                      </span>
                    ))}
                  </div>
                </div>
                {csv.status === "error" ? (
                  <p className="flex items-center gap-1.5 text-[11px] font-medium text-red-600 dark:text-red-400">
                    <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                    {t(csv.code as string)}
                  </p>
                ) : csvUnknown.length > 0 ? (
                  <p className="flex items-start gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    {t("card.csvUnknownWarning", {
                      names: csvUnknown.join(", "),
                    })}
                  </p>
                ) : null}
              </div>
            )}
          </fieldset>

          {/* Export format + quick downloads */}
          <fieldset className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
            <legend className="flex items-center gap-1.5 px-1 text-sm font-semibold text-foreground">
              <Download className="size-4 text-primary" aria-hidden="true" />
              {t("card.exportLabel")}
            </legend>
            <ToggleGroup
              type="single"
              value={state.exportFormat}
              onValueChange={(value) => {
                if (value !== "") {
                  apply({ exportFormat: value as ExportFormat });
                }
              }}
              className="w-full"
            >
              <ToggleGroupItem
                value="pdf"
                aria-label={t("card.exportPdf")}
                className="min-h-11 flex-1 rounded-btn text-xs"
              >
                {t("card.exportPdf")}
              </ToggleGroupItem>
              <ToggleGroupItem
                value="jpg"
                aria-label={t("card.exportJpg")}
                className="min-h-11 flex-1 rounded-btn text-xs"
              >
                {t("card.exportJpg")}
              </ToggleGroupItem>
              <ToggleGroupItem
                value="png"
                aria-label={t("card.exportPng")}
                className="min-h-11 flex-1 rounded-btn text-xs"
              >
                {t("card.exportPng")}
              </ToggleGroupItem>
            </ToggleGroup>
            <p className="text-[11px] text-muted-foreground">
              {t("card.exportImageNote")}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {t("card.qualityNote")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className={TOOL_BTN}
                onClick={() => void downloadImage("jpg")}
                disabled={quickBusy !== null}
              >
                {quickBusy === "jpg" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="size-4" aria-hidden="true" />
                )}
                {t("card.quickJpg")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className={TOOL_BTN}
                onClick={() => void downloadImage("png")}
                disabled={quickBusy !== null}
              >
                {quickBusy === "png" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="size-4" aria-hidden="true" />
                )}
                {t("card.quickPng")}
              </Button>
            </div>
          </fieldset>
        </div>
      </div>

      {/* CTA */}
      <div className="flex flex-col items-center gap-2">
        <Button
          type="button"
          size="touch"
          onClick={createCard}
          disabled={runDisabledLocal}
          className="w-full max-w-sm rounded-btn font-semibold"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="size-4" aria-hidden="true" />
          )}
          {busy ? t("card.creating") : t("card.cta")}
        </Button>
      </div>

      {/* progress */}
      {pct !== null ? (
        <div
          className="flex items-center gap-2 rounded-card border border-border bg-card p-3 text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span>{t("card.creating")}</span>
        </div>
      ) : null}

      {/* success chip */}
      {done ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-card p-3 text-sm text-foreground"
          role="status"
        >
          <CheckCircle2
            className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
          <span className="font-medium">{done.name}</span>
          <span className="text-xs text-muted-foreground">
            {t("card.doneDetail", { count: done.pages })}
          </span>
        </div>
      ) : null}
    </section>
  );
}
