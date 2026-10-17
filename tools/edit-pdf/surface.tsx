"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Loader2, TriangleAlert } from "lucide-react";

import { loadPdfjs } from "@/lib/pdf/pdfjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  getPdfPageCount,
  getPdfPagePixelSize,
  renderPdfThumbnail,
} from "@/lib/pdf/thumbnails";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { useI18n } from "@/components/providers/locale-provider";
import {
  PreviewFileHeader,
  PreviewPageStrip,
} from "../stamp-common/preview-parts";
import {
  addImageFile,
  addPngBlob,
  clearAssets,
  getAssetsSnapshot,
  setRunOrder,
  subscribeAssets,
} from "./asset-store";
import {
  CanvasHeader,
  EditorContextMenu,
  EditorToolbar,
  FindReplaceDialog,
  LayersPanel,
  ObjView,
  PropertiesPanel,
  SignPadDialog,
  TextPieceButtons,
  type ContextMenuState,
  type FrMatchView,
  type ToolId,
} from "./editor-parts";
import { harvestPageText, scanPagesText } from "./text-layer";
import {
  HISTORY_LIMIT,
  LINE_HEIGHT,
  MIN_OBJ_PT,
  TEXT_PAD,
  bringToFront,
  buildReplaceLineObjects,
  buildReplacePieceObjects,
  clampN,
  displayRectToPdf,
  displaySize,
  duplicateObject,
  groupPiecesIntoLines,
  luminance,
  lowerOne,
  makeDraw,
  makeImage,
  makeShape,
  makeText,
  makeWhiteout,
  medianRgb,
  normaliseDraw,
  pdfRectToDisplay,
  pickInkFromPixels,
  pieceRect,
  planLineReplacements,
  raiseOne,
  redoStep,
  rgbToHex,
  roundPt,
  sendToBack,
  substituteOccurrences,
  undoStep,
  type EditorObject,
  type HarvestPiece,
  type HitEdge,
  type LineMatch,
  type ObjRect,
  type PageView,
  type PieceLine,
} from "./model";

/**
 * Edit PDF live surface (PRD §8.2.1 flagship editor).
 *
 * Layout: toolbar + canvas column (page strip, page render with the
 * object overlay) + right rail (properties, layers) — the right rail
 * stacks below the canvas on mobile. Every edit lands in the options
 * blob under "e:<fileId>" (the redact epoch-key pattern) as
 * { objects, pageViews, assetOrder }; the export worker bakes the final
 * PDF from that blob plus the assets riding the run message.
 */

const PREVIEW_MAX_DIM = 640;
const EDITOR_MAX_PAGES = 500;
const KEY_PREFIX = "e:";
const EKEY_ID = "ekey";
/** Minimum drag (fraction of the page) that becomes a new object. */
const MIN_DRAW = 0.02;

/** Proper-noun font labels for the matched/closest toasts. */
const FONT_LABEL: Record<string, string> = {
  helvetica: "Helvetica",
  times: "Times",
  courier: "Courier",
  devanagari: "Noto Sans Devanagari",
};

interface EditorBlob {
  objects: EditorObject[];
  pageViews: PageView[];
  assetOrder: string[];
}

type CreateKind = "text" | "rect" | "ellipse" | "line" | "arrow" | "whiteout";

type Gesture =
  | {
      type: "create";
      kind: CreateKind;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    }
  | {
      type: "move";
      id: string;
      grabDx: number;
      grabDy: number;
      orig: ObjRect;
    }
  | {
      type: "resize";
      id: string;
      edge: HitEdge;
      orig: ObjRect;
      keepAspect: boolean;
      aspect: number;
    }
  | { type: "stroke"; pts: { x: number; y: number }[] };

/** Collects per-page crop-box + rotation views (pdf.js, main thread). */
async function collectPageViews(
  file: File,
  maxPages: number
): Promise<PageView[]> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc: PDFDocumentProxy = await pdfjs.getDocument({
    data,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;
  const count = Math.min(doc.numPages, maxPages);
  const views: PageView[] = [];
  for (let p = 1; p <= count; p += 1) {
    const page = await doc.getPage(p);
    const raw = (page as unknown as { view: number[] }).view ?? [0, 0, 612, 792];
    const rotateRaw = (page as unknown as { rotate: number }).rotate ?? 0;
    const r = ((rotateRaw % 360) + 360) % 360;
    views.push({
      x0: raw[0],
      y0: raw[1],
      x1: raw[2],
      y1: raw[3],
      rotate: r === 90 || r === 180 || r === 270 ? r : 0,
    });
  }
  return views;
}

function parseBlob(raw: unknown): EditorBlob {
  try {
    const parsed = JSON.parse(String(raw ?? "{}")) as Partial<EditorBlob>;
    return {
      objects: Array.isArray(parsed.objects)
        ? (parsed.objects as EditorObject[])
        : [],
      pageViews: Array.isArray(parsed.pageViews)
        ? (parsed.pageViews as PageView[])
        : [],
      assetOrder: Array.isArray(parsed.assetOrder)
        ? parsed.assetOrder.filter((k): k is string => typeof k === "string")
        : [],
    };
  } catch {
    return { objects: [], pageViews: [], assetOrder: [] };
  }
}

/** Asset keys referenced by visible objects, first-seen order. */
function orderFromObjects(objects: EditorObject[]): string[] {
  const seen: string[] = [];
  for (const o of objects) {
    if (o.kind === "image" && !seen.includes(o.assetKey)) seen.push(o.assetKey);
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Existing-text colour sampling (P8.3) — from the rendered page bitmap
// ---------------------------------------------------------------------------

const DEFAULT_BG = "#ffffff";
const DEFAULT_INK = "#111827";

function scratchContext(
  bitmap: ImageBitmap
): CanvasRenderingContext2D | null {
  // OffscreenCanvas on the main thread everywhere modern; DOM fallback.
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0);
      return ctx as unknown as CanvasRenderingContext2D;
    }
  } catch {
    /* fall through to the DOM canvas */
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0);
      return ctx;
    }
  } catch {
    /* give up honestly */
  }
  return null;
}

/**
 * Samples the cover (page background) and ink (text) colours for a piece
 * from the rendered page bitmap. Background: the median of thin strips
 * just above/below the piece (works on tinted forms). Ink: the darkest
 * pixel cluster on light pages, the brightest on dark ones — with an
 * honest fallback when the contrast is too weak to trust.
 */
function samplePieceColors(
  bitmap: ImageBitmap,
  dispW: number,
  dispH: number,
  piece: HarvestPiece
): { bg: string; ink: string } {
  try {
    const sx = bitmap.width / Math.max(1, dispW);
    const sy = bitmap.height / Math.max(1, dispH);
    const rect = pieceRect(piece);
    const ctx = scratchContext(bitmap);
    if (!ctx) return { bg: DEFAULT_BG, ink: DEFAULT_INK };

    const x0 = Math.max(0, Math.floor((rect.x - 2) * sx));
    const x1 = Math.min(
      bitmap.width,
      Math.ceil((rect.x + rect.w + 2) * sx)
    );
    const band = Math.max(2, Math.round(3 * sy));
    const topY = Math.max(0, Math.floor((rect.y - 3.5) * sy));
    const botY = Math.min(
      bitmap.height,
      Math.ceil((rect.y + rect.h + 3.5) * sy)
    );

    const bgPx: number[] = [];
    const stripW = Math.max(1, x1 - x0);
    if (topY + band <= bitmap.height && stripW > 0) {
      bgPx.push(
        ...ctx.getImageData(x0, topY, stripW, band).data
      );
    }
    if (botY - band >= 0 && stripW > 0) {
      bgPx.push(
        ...ctx.getImageData(x0, botY - band, stripW, band).data
      );
    }
    const bg =
      bgPx.length > 0
        ? medianRgb(bgPx)
        : { r: 255, g: 255, b: 255 };
    const bgLum = luminance(bg.r, bg.g, bg.b);

    const ix0 = Math.max(0, Math.floor(rect.x * sx));
    const ix1 = Math.min(bitmap.width, Math.ceil((rect.x + rect.w) * sx));
    const iy0 = Math.max(0, Math.floor(rect.y * sy));
    const iy1 = Math.min(bitmap.height, Math.ceil((rect.y + rect.h) * sy));
    let ink: { r: number; g: number; b: number } | null = null;
    if (ix1 > ix0 && iy1 > iy0) {
      ink = pickInkFromPixels(
        Array.from(ctx.getImageData(ix0, iy0, ix1 - ix0, iy1 - iy0).data),
        bgLum
      );
    }
    if (ink === null) {
      ink =
        bgLum > 0.5
          ? { r: 17, g: 24, b: 39 }
          : { r: 248, g: 250, b: 252 };
    }
    return {
      bg: rgbToHex(bg.r, bg.g, bg.b),
      ink: rgbToHex(ink.r, ink.g, ink.b),
    };
  } catch {
    return { bg: DEFAULT_BG, ink: DEFAULT_INK };
  }
}

export function EditSurface(props: ToolSurfaceProps): React.JSX.Element | null {
  const { files, values, onChange, setRunBlocked } = props;
  const { t } = useI18n();
  const { toast } = useToast();
  const file = files.length > 0 ? files[0].file : null;
  const fileId = files.length > 0 ? files[0].id : "";

  const assets = useSyncExternalStore(subscribeAssets, getAssetsSnapshot);
  const assetUrls = useMemo(
    () => new Map(assets.map((a) => [a.key, a.url] as const)),
    [assets]
  );

  // --- Options blob ("e:<fileId>") --------------------------------------
  const blobKey = `${KEY_PREFIX}${fileId}`;
  const blob = useMemo<EditorBlob>(
    () => parseBlob(values[blobKey]),
    [values, blobKey]
  );
  const objects = blob.objects;
  const pageViews = blob.pageViews;

  // Live object mirror — written ONLY inside event handlers/effects (never
  // during render), so successive mutations in one tick always see the
  // latest array even before React flushes the blob back down.
  const objectsRef = useRef<EditorObject[]>([]);

  const commit = useCallback(
    (nextObjects: EditorObject[], views?: PageView[]): void => {
      const nextViews = views ?? pageViews;
      const order = orderFromObjects(nextObjects);
      // Keep the asset store's run order in sync so config.collectAssets
      // returns the exact File[] the blob's assetOrder describes.
      setRunOrder(order);
      onChange(
        blobKey,
        JSON.stringify({
          objects: nextObjects,
          pageViews: nextViews,
          assetOrder: order,
        })
      );
    },
    [blobKey, onChange, pageViews]
  );

  // Point the worker at this document's blob.
  useEffect(() => {
    if (fileId !== "") onChange(EKEY_ID, fileId);
  }, [fileId, onChange]);

  // --- History (undo/redo snapshot stack) --------------------------------
  // Stacks live in a ref (mutated from handlers only); their LENGTHS are
  // mirrored into state so canUndo/canRedo stay render-safe.
  const histRef = useRef<{
    past: string[];
    future: string[];
    lastKey: string;
    lastAt: number;
  }>({ past: [], future: [], lastKey: "", lastAt: 0 });
  const [histLens, setHistLens] = useState({ past: 0, future: 0 });
  const syncLens = useCallback((): void => {
    setHistLens({
      past: histRef.current.past.length,
      future: histRef.current.future.length,
    });
  }, []);

  const applyObjects = useCallback(
    (next: EditorObject[], groupKey: string, history = true): void => {
      if (history) {
        const h = histRef.current;
        const now = Date.now();
        if (h.lastKey === groupKey && now - h.lastAt < 800) {
          h.lastAt = now;
        } else {
          h.past = [
            ...h.past,
            JSON.stringify(objectsRef.current),
          ].slice(-HISTORY_LIMIT);
          h.future = [];
          h.lastKey = groupKey;
          h.lastAt = now;
        }
        syncLens();
      }
      objectsRef.current = next;
      commit(next);
    },
    [commit, syncLens]
  );

  const undo = useCallback((): void => {
    const current = JSON.stringify(objectsRef.current);
    const step = undoStep(histRef.current.past, histRef.current.future, current);
    if (step.snapshot === null) return;
    histRef.current.past = step.past;
    histRef.current.future = step.future;
    histRef.current.lastKey = "";
    histRef.current.lastAt = 0;
    const restored = JSON.parse(step.snapshot) as EditorObject[];
    objectsRef.current = restored;
    commit(restored);
    syncLens();
  }, [commit, syncLens]);

  const redo = useCallback((): void => {
    const current = JSON.stringify(objectsRef.current);
    const step = redoStep(histRef.current.past, histRef.current.future, current);
    if (step.snapshot === null) return;
    histRef.current.past = step.past;
    histRef.current.future = step.future;
    histRef.current.lastKey = "";
    histRef.current.lastAt = 0;
    const restored = JSON.parse(step.snapshot) as EditorObject[];
    objectsRef.current = restored;
    commit(restored);
    syncLens();
  }, [commit, syncLens]);

  const canUndo = histLens.past > 0;
  const canRedo = histLens.future > 0;

  // --- Document state -----------------------------------------------------
  const [pageCount, setPageCount] = useState(0);
  const [selectedPage, setSelectedPage] = useState(0);
  const [pageError, setPageError] = useState<"password" | "corrupt" | null>(null);
  const [viewsReady, setViewsReady] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [base, setBase] = useState<{
    bitmap: ImageBitmap;
    dispW: number;
    dispH: number;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const viewToken = useRef(0);

  // Load: page count + per-page views.
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    const token = viewToken.current + 1;
    viewToken.current = token;
    void (async () => {
      setViewsReady(false);
      setPageError(null);
      setSelectedPage(0);
      setTruncated(false);
      const count = await getPdfPageCount(file);
      if (cancelled || viewToken.current !== token) return;
      setPageCount(count);
      setTruncated(count > EDITOR_MAX_PAGES);
      const views = await collectPageViews(file, EDITOR_MAX_PAGES);
      if (cancelled || viewToken.current !== token) return;
      objectsRef.current = [];
      histRef.current = { past: [], future: [], lastKey: "", lastAt: 0 };
      syncLens();
      commit([], views);
      setViewsReady(true);
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
      viewToken.current += 1;
    };
    // commit is stable via pageViews identity per file session
  }, [file]);

  // Assets belong to this document session only.
  useEffect(() => {
    return () => {
      clearAssets();
    };
  }, []);

  // --- Page preview render -------------------------------------------------
  useEffect(() => {
    if (!file || pageCount === 0) return;
    let cancelled = false;
    void (async () => {
      const [thumb, pixel] = await Promise.all([
        renderPdfThumbnail(file, {
          pageIndex: selectedPage,
          maxDim: Math.min(2800, Math.round(PREVIEW_MAX_DIM * zoom * 2)),
        }),
        getPdfPagePixelSize(file, 1, selectedPage),
      ]);
      if (cancelled) return;
      const bitmap = await createImageBitmap(thumb.blob);
      if (cancelled) return;
      setFailed(false);
      setBase({ bitmap, dispW: pixel.width, dispH: pixel.height });
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [file, pageCount, selectedPage, zoom]);

  // Actual rendered page width (CSS px) — the object overlay scales by it.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderScale, setRenderScale] = useState(1);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !base) return;
    const measure = (): void => {
      const w = canvas.getBoundingClientRect().width;
      if (w > 0) setRenderScale(w / base.dispW);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [base]);

  const currentView = pageViews[selectedPage] ?? null;
  const pageDisp = currentView ? displaySize(currentView) : null;

  // --- Selection + tools ----------------------------------------------------
  const [tool, setTool] = useState<ToolId>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [signOpen, setSignOpen] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  const pageObjects = useMemo(
    () => objects.filter((o) => o.page === selectedPage),
    [objects, selectedPage]
  );
  const selected = useMemo(
    () => objects.find((o) => o.id === selectedId) ?? null,
    [objects, selectedId]
  );
  const editing = useMemo(
    () => (editingId !== null ? objects.find((o) => o.id === editingId) ?? null : null),
    [objects, editingId]
  );
  const touchedPages = useMemo(
    () => new Set(objects.map((o) => o.page)),
    [objects]
  );

  const runGated = !viewsReady || pageError !== null;
  useEffect(() => {
    setRunBlocked(runGated ? "editPdf.notReady" : null);
  }, [runGated, setRunBlocked]);

  // --- Object actions ------------------------------------------------------
  const patchObject = useCallback(
    (id: string, patch: Partial<EditorObject>, history = true): void => {
      applyObjects(
        objectsRef.current.map((o) => (o.id === id ? ({ ...o, ...patch } as EditorObject) : o)),
        `patch:${id}`,
        history
      );
    },
    [applyObjects]
  );

  const removeObject = useCallback(
    (id: string): void => {
      applyObjects(
        objectsRef.current.filter((o) => o.id !== id),
        `remove:${id}`
      );
      if (selectedId === id) setSelectedId(null);
      if (editingId === id) setEditingId(null);
    },
    [applyObjects, selectedId, editingId]
  );

  const duplicateSel = useCallback((): void => {
    if (!selectedId) return;
    const result = duplicateObject(objectsRef.current, selectedId);
    if (result.copy) {
      applyObjects(result.objects, `dup:${selectedId}`);
      setSelectedId(result.copy.id);
    }
  }, [applyObjects, selectedId]);

  // --- Text editing ---------------------------------------------------------
  const startEditText = useCallback((id: string): void => {
    setSelectedId(id);
    setEditingId(id);
    setTool("select");
  }, []);

  useEffect(() => {
    if (editingId !== null && textAreaRef.current) {
      textAreaRef.current.focus();
      textAreaRef.current.select();
    }
  }, [editingId]);

  const endEdit = useCallback((): void => {
    const obj = objectsRef.current.find((o) => o.id === editingId);
    if (obj && obj.kind === "text" && obj.text.trim().length === 0) {
      // An empty text box never survives blur.
      applyObjects(
        objectsRef.current.filter((o) => o.id !== editingId),
        `remove:${editingId}`
      );
    }
    setEditingId(null);
  }, [applyObjects, editingId]);

  // --- Image + signature insertion ------------------------------------------
  const insertImageAsset = useCallback(
    (key: string, naturalW: number, naturalH: number): void => {
      if (!pageDisp || !currentView) return;
      const page = pageDisp;
      const aspect = naturalH / Math.max(1, naturalW);
      const w = Math.min(page.w * 0.4, 240);
      const h = w * aspect;
      const disp = {
        x: (page.w - w) / 2,
        y: Math.min(page.h * 0.5, (page.h - h) / 2),
        w,
        h,
      };
      const pdf = displayRectToPdf(disp, currentView);
      const obj = makeImage(selectedPage, pdf, key);
      applyObjects([...objectsRef.current, obj], `add:${obj.id}`);
      setSelectedId(obj.id);
      setTool("select");
    },
    [applyObjects, currentView, pageDisp, selectedPage]
  );

  const onImageFiles = useCallback(
    (list: FileList | null): void => {
      if (!list || list.length === 0) return;
      void (async () => {
        try {
          for (const f of Array.from(list)) {
            const asset = await addImageFile(f);
            insertImageAsset(asset.key, asset.w, asset.h);
          }
        } catch {
          toast({
            title: t("editPdf.errorImageTitle"),
            description: t("editPdf.errorImageDesc"),
            variant: "destructive",
          });
        }
      })();
    },
    [insertImageAsset, t, toast]
  );

  const onSignature = useCallback(
    (png: Blob): void => {
      setSignOpen(false);
      void (async () => {
        try {
          const asset = await addPngBlob(png, "signature");
          insertImageAsset(asset.key, asset.w, asset.h);
        } catch {
          toast({
            title: t("editPdf.errorImageTitle"),
            variant: "destructive",
          });
        }
      })();
    },
    [insertImageAsset, t, toast]
  );

  const onTool = useCallback((next: ToolId): void => {
    if (next === "image") {
      imageInputRef.current?.click();
      return;
    }
    if (next === "sign") {
      setSignOpen(true);
      return;
    }
    setTool(next);
    setSelectedId(null);
  }, []);

  // --- Existing-text editing (P8.3) ------------------------------------------
  // Per-page piece cache + harvest on demand (the annotate-pdf pattern).
  const pieceCacheRef = useRef<Map<number, HarvestPiece[]>>(new Map());
  const harvestToken = useRef(0);
  const [pieces, setPieces] = useState<HarvestPiece[]>([]);
  const [piecesState, setPiecesState] = useState<
    "idle" | "loading" | "empty" | "ready"
  >("idle");

  useEffect(() => {
    if (tool !== "edittext" || !file || !viewsReady) {
      setPiecesState("idle");
      setPieces([]);
      return;
    }
    const cached = pieceCacheRef.current.get(selectedPage);
    if (cached) {
      setPieces(cached);
      setPiecesState(cached.length === 0 ? "empty" : "ready");
      return;
    }
    const token = harvestToken.current + 1;
    harvestToken.current = token;
    setPiecesState("loading");
    setPieces([]);
    void (async () => {
      try {
        const harvested = await harvestPageText(file, selectedPage);
        if (harvestToken.current !== token) return;
        pieceCacheRef.current.set(selectedPage, harvested);
        setPieces(harvested);
        setPiecesState(harvested.length === 0 ? "empty" : "ready");
      } catch {
        if (harvestToken.current !== token) return;
        setPieces([]);
        setPiecesState("empty");
      }
    })();
  }, [tool, file, selectedPage, viewsReady]);

  const pickPiece = useCallback(
    (piece: HarvestPiece): void => {
      if (!base || !pageDisp || !currentView) return;
      const samples = samplePieceColors(
        base.bitmap,
        base.dispW,
        base.dispH,
        piece
      );
      const { cover, text } = buildReplacePieceObjects(
        selectedPage,
        currentView,
        piece,
        samples.bg,
        samples.ink
      );
      applyObjects([...objectsRef.current, cover, text], `replace:${text.id}`);
      setSelectedId(text.id);
      setEditingId(text.id);
      setTool("select");
      // PRD §8.2: "UI me clear message — font mil gaya / nahi mila".
      const fontLabel = FONT_LABEL[piece.font.font];
      toast({
        title: piece.font.exact
          ? t("editPdf.fontMatched", { font: fontLabel })
          : t("editPdf.fontClosest", {
              font: fontLabel,
              original: piece.font.original || t("editPdf.fontUnknown"),
            }),
      });
    },
    [applyObjects, base, currentView, pageDisp, selectedPage, t, toast]
  );

  // --- Find & replace (P8.3, same font rules) ---------------------------------
  const [frOpen, setFrOpen] = useState(false);
  const [frQuery, setFrQuery] = useState("");
  const [frReplacement, setFrReplacement] = useState("");
  const [frCase, setFrCase] = useState(false);
  const [frScan, setFrScan] = useState<{ page: number; pages: number } | null>(
    null
  );
  const [frDone, setFrDone] = useState<ReadonlySet<string>>(new Set());
  /** Bulk pieces per page + flattened lines, computed once per file. */
  const frPiecesRef = useRef<HarvestPiece[][] | null>(null);
  const frLinesRef = useRef<PieceLine[] | null>(null);
  const [frVersion, setFrVersion] = useState(0);

  const openFindReplace = useCallback((): void => {
    setFrOpen(true);
    if (frPiecesRef.current === null && file) {
      setFrScan({ page: 0, pages: 0 });
      void (async () => {
        try {
          const all = await scanPagesText(
            file,
            Math.max(1, pageCount || EDITOR_MAX_PAGES),
            (p) => setFrScan({ page: p.page, pages: p.pages })
          );
          frPiecesRef.current = all;
          const lines: PieceLine[] = [];
          for (let p = 0; p < all.length; p += 1) {
            for (const line of groupPiecesIntoLines(p, all[p])) {
              lines.push(line);
            }
          }
          frLinesRef.current = lines;
        } catch {
          frPiecesRef.current = [];
          frLinesRef.current = [];
        } finally {
          setFrScan(null);
          setFrVersion((v) => v + 1);
        }
      })();
    }
  }, [file, pageCount]);

  const frMatches = useMemo<FrMatchView[]>(() => {
    void frVersion; // recomputes once the scan lands
    const lines = frLinesRef.current;
    if (!lines || frQuery.length === 0) return [];
    const PAD = 24;
    const out: FrMatchView[] = [];
    for (const m of planLineReplacements(lines, frQuery, frCase)) {
      const text = lines[m.line].text;
      const key = `${m.page}:${m.line}:${m.start}`;
      out.push({
        key,
        page: m.page,
        before:
          (m.start > PAD ? "…" : "") + text.slice(Math.max(0, m.start - PAD), m.start),
        hit: text.slice(m.start, m.end),
        after:
          text.slice(m.end, m.end + PAD) +
          (m.end + PAD < text.length ? "…" : ""),
        done: frDone.has(key),
      });
    }
    return out;
  }, [frVersion, frQuery, frCase, frDone]);

  const applyLineReplacements = useCallback(
    (firstOnly: boolean): void => {
      const lines = frLinesRef.current;
      const all = frPiecesRef.current;
      if (!lines || !all) return;
      const matches = planLineReplacements(lines, frQuery, frCase);
      // Group the not-yet-done matches per line — one retype per line
      // substitutes ALL of that line's occurrences.
      const byLine = new Map<number, LineMatch[]>();
      for (const m of matches) {
        const key = `${m.page}:${m.line}:${m.start}`;
        if (frDone.has(key)) continue;
        const bucket = byLine.get(m.line);
        if (bucket) bucket.push(m);
        else byLine.set(m.line, [m]);
      }
      const chosen = firstOnly
        ? byLine.size > 0
          ? [[...byLine.entries()][0]]
          : []
        : [...byLine.entries()];
      if (chosen.length === 0) return;

      const added: EditorObject[] = [];
      const newDone = new Set(frDone);
      let replacedLines = 0;
      for (const [lineIdx, ms] of chosen) {
        const line = lines[lineIdx];
        const pagePieces = all[line.page] ?? [];
        const view = pageViews[line.page];
        if (!view) continue;
        const newText = substituteOccurrences(
          line.text,
          ms.map((m) => ({ start: m.start, end: m.end })),
          frReplacement
        );
        const { cover, text } = buildReplaceLineObjects(
          line.page,
          view,
          line,
          pagePieces,
          newText,
          DEFAULT_BG,
          DEFAULT_INK
        );
        added.push(cover, text);
        for (const m of ms) newDone.add(`${m.page}:${m.line}:${m.start}`);
        replacedLines += 1;
      }
      if (added.length === 0) return;
      applyObjects(
        [...objectsRef.current, ...added],
        firstOnly ? `fr:${chosen[0][0]}` : "fr:all"
      );
      setFrDone(newDone);
      toast({
        title: t("editPdf.frReplacedCount", { n: replacedLines }),
      });
    },
    [applyObjects, frCase, frDone, frQuery, frReplacement, pageViews, t, toast]
  );

  // Per-file caches reset when the document changes.
  useEffect(() => {
    pieceCacheRef.current.clear();
    frPiecesRef.current = null;
    frLinesRef.current = null;
    setFrDone(new Set());
    setFrVersion((v) => v + 1);
  }, [fileId]);

  // --- Pointer machinery ------------------------------------------------------
  const displayPos = (
    event: React.PointerEvent<Element>
  ): { x: number; y: number } => {
    const overlay = overlayRef.current;
    if (!overlay || !pageDisp) return { x: 0, y: 0 };
    const box = overlay.getBoundingClientRect();
    const scale = pageDisp.w / Math.max(1, box.width);
    return {
      x: clampN((event.clientX - box.left) * scale, 0, pageDisp.w),
      y: clampN((event.clientY - box.top) * scale, 0, pageDisp.h),
    };
  };

  const handleOverlayPointerDown = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    if (!base || !currentView || event.button !== 0) return;
    if (menu) setMenu(null);
    const pos = displayPos(event);
    if (tool === "select") {
      setSelectedId(null);
      setEditingId(null);
      return;
    }
    // Clicks land on the piece buttons (pointer-events-auto); anything
    // that slips through onto the overlay does nothing.
    if (tool === "edittext") return;
    if (tool === "draw") {
      try {
        overlayRef.current?.setPointerCapture(event.pointerId);
      } catch {
        /* synthetic pointers */
      }
      setSelectedId(null);
      setGesture({ type: "stroke", pts: [pos] });
      event.preventDefault();
      return;
    }
    // Create tools: text (click or drag), shapes + whiteout (drag).
    try {
      overlayRef.current?.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic pointers */
    }
    setSelectedId(null);
    setGesture({
      type: "create",
      kind: tool as CreateKind,
      x0: pos.x,
      y0: pos.y,
      x1: pos.x,
      y1: pos.y,
    });
    event.preventDefault();
  };

  const handleOverlayPointerMove = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    if (!gesture || !pageDisp || !currentView) return;
    const pos = displayPos(event);
    if (gesture.type === "stroke") {
      const last = gesture.pts[gesture.pts.length - 1];
      if (Math.hypot(pos.x - last.x, pos.y - last.y) > 1.5) {
        setGesture({ ...gesture, pts: [...gesture.pts, pos] });
      }
      return;
    }
    if (gesture.type === "create") {
      setGesture({ ...gesture, x1: pos.x, y1: pos.y });
      return;
    }
    if (gesture.type === "move") {
      const obj = objectsRef.current.find((o) => o.id === gesture.id);
      if (!obj) {
        setGesture(null);
        return;
      }
      const disp = pdfRectToDisplay(obj, currentView);
      // grabDx/grabDy are the pointer's offset FROM the object origin at
      // gesture start — pos - grab IS the new origin (no extra disp add).
      const next = {
        x: clampN(pos.x - gesture.grabDx, 0, pageDisp.w - disp.w),
        y: clampN(pos.y - gesture.grabDy, 0, pageDisp.h - disp.h),
        w: disp.w,
        h: disp.h,
      };
      const pdf = displayRectToPdf(next, currentView);
      patchObject(gesture.id, {
        x: roundPt(pdf.x),
        y: roundPt(pdf.y),
      });
      return;
    }
    // resize
    const orig = gesture.orig;
    const min = MIN_OBJ_PT;
    let { x, y, w, h } = orig;
    if (gesture.edge === "se") {
      w = Math.max(min, pos.x - x);
      h = Math.max(min, pos.y - y);
    } else if (gesture.edge === "ne") {
      const ny = Math.min(y + h - min, pos.y);
      w = Math.max(min, pos.x - x);
      h = Math.max(min, y + h - ny);
      y = ny;
    } else if (gesture.edge === "sw") {
      const nx = Math.min(x + w - min, pos.x);
      w = Math.max(min, x + w - nx);
      x = nx;
      h = Math.max(min, pos.y - y);
    } else {
      const nx = Math.min(x + w - min, pos.x);
      const ny = Math.min(y + h - min, pos.y);
      w = Math.max(min, x + w - nx);
      h = Math.max(min, y + h - ny);
      x = nx;
      y = ny;
    }
    if (gesture.keepAspect) {
      w = Math.max(min, Math.min(w, h * gesture.aspect));
      h = w / gesture.aspect;
      if (gesture.edge === "ne") y = orig.y + orig.h - h;
      if (gesture.edge === "sw") x = orig.x + orig.w - w;
      if (gesture.edge === "nw") {
        x = orig.x + orig.w - w;
        y = orig.y + orig.h - h;
      }
    }
    const pdf = displayRectToPdf({ x, y, w, h }, currentView);
    patchObject(gesture.id, {
      x: roundPt(pdf.x),
      y: roundPt(pdf.y),
      w: roundPt(pdf.w),
      h: roundPt(pdf.h),
    });
  };

  const handleOverlayPointerUp = (): void => {
    if (!gesture || !currentView || !pageDisp) {
      setGesture(null);
      return;
    }
    if (gesture.type === "stroke") {
      const norm = normaliseDraw(gesture.pts);
      setGesture(null);
      if (norm) {
        const pdf = displayRectToPdf(norm.rect, currentView);
        const obj = makeDraw(selectedPage, pdf, norm.fracs);
        applyObjects([...objectsRef.current, obj], `add:${obj.id}`);
        setSelectedId(obj.id);
        setTool("select");
      }
      return;
    }
    if (gesture.type === "create") {
      const x0 = Math.min(gesture.x0, gesture.x1);
      const x1 = Math.max(gesture.x0, gesture.x1);
      const y0 = Math.min(gesture.y0, gesture.y1);
      const y1 = Math.max(gesture.y0, gesture.y1);
      setGesture(null);
      const dragged =
        (x1 - x0) / pageDisp.w >= MIN_DRAW || (y1 - y0) / pageDisp.h >= MIN_DRAW;
      let disp: ObjRect;
      if (dragged) {
        disp = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      } else if (gesture.kind === "text") {
        // Click = default-size text box at the click point.
        disp = { x: gesture.x0, y: gesture.y0, w: 160, h: Math.max(18, 16 * LINE_HEIGHT + 2 * TEXT_PAD) };
      } else {
        return;
      }
      const pdf = displayRectToPdf(disp, currentView);
      let obj: EditorObject;
      switch (gesture.kind) {
        case "text":
          obj = makeText(selectedPage, pdf);
          break;
        case "line":
        case "arrow": {
          obj = makeShape(selectedPage, pdf, gesture.kind);
          if (obj.kind === "line" || obj.kind === "arrow") {
            obj.flip =
              (gesture.x1 - gesture.x0) * (gesture.y1 - gesture.y0) < 0;
          }
          break;
        }
        case "rect":
        case "ellipse":
          obj = makeShape(selectedPage, pdf, gesture.kind);
          break;
        default:
          obj = makeWhiteout(selectedPage, pdf);
          break;
      }
      applyObjects([...objectsRef.current, obj], `add:${obj.id}`);
      setSelectedId(obj.id);
      if (obj.kind === "text") {
        setEditingId(obj.id);
      }
      setTool("select");
      return;
    }
    setGesture(null);
  };

  const handleObjectPointerDown = (obj: EditorObject) => (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    if (!base || !currentView || event.button !== 0 || tool !== "select") return;
    event.stopPropagation();
    setSelectedId(obj.id);
    if (obj.locked || editingId === obj.id) return;
    const handleEl = (event.target as HTMLElement).closest("[data-handle]");
    if (handleEl) {
      const edge = handleEl.getAttribute("data-handle") as HitEdge;
      try {
        overlayRef.current?.setPointerCapture(event.pointerId);
      } catch {
        /* synthetic pointers */
      }
      const orig = pdfRectToDisplay(obj, currentView);
      const keepAspect = event.shiftKey && obj.kind === "image";
      setGesture({
        type: "resize",
        id: obj.id,
        edge,
        orig,
        keepAspect,
        aspect: orig.w / Math.max(1, orig.h),
      });
      event.preventDefault();
      return;
    }
    try {
      overlayRef.current?.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic pointers */
    }
    const pos = displayPos(event);
    const disp = pdfRectToDisplay(obj, currentView);
    setGesture({
      type: "move",
      id: obj.id,
      grabDx: pos.x - disp.x,
      grabDy: pos.y - disp.y,
      orig: disp,
    });
    event.preventDefault();
  };

  const handleContextMenu = (obj: EditorObject) => (
    event: React.MouseEvent<HTMLDivElement>
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(obj.id);
    setMenu({ x: event.clientX, y: event.clientY, objId: obj.id });
  };

  // --- Keyboard shortcuts -----------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (signOpen) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      const inField = tag === "TEXTAREA" || tag === "INPUT";
      if (editingId !== null && inField) {
        if (event.key === "Escape") {
          event.preventDefault();
          (target as HTMLTextAreaElement).blur();
        }
        return;
      }
      if (inField) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (mod && key === "d") {
        event.preventDefault();
        duplicateSel();
        return;
      }
      if (mod) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedId !== null) {
          event.preventDefault();
          removeObject(selectedId);
        }
        return;
      }
      if (event.key === "Escape") {
        setSelectedId(null);
        setMenu(null);
        return;
      }
      if (event.key.startsWith("Arrow") && selectedId !== null && currentView) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const obj = objectsRef.current.find((o) => o.id === selectedId);
        if (!obj) return;
        const disp = pdfRectToDisplay(obj, currentView);
        const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        const next = {
          x: clampN(disp.x + dx, 0, (pageDisp?.w ?? disp.w + disp.x) - disp.w),
          y: clampN(disp.y + dy, 0, (pageDisp?.h ?? disp.h + disp.y) - disp.h),
          w: disp.w,
          h: disp.h,
        };
        const pdf = displayRectToPdf(next, currentView);
        patchObject(selectedId, {
          x: roundPt(pdf.x),
          y: roundPt(pdf.y),
        });
        return;
      }
      switch (key) {
        case "v":
          setTool("select");
          break;
        case "t":
          setTool("text");
          break;
        case "e":
          setTool("edittext");
          break;
        case "r":
          setTool("rect");
          break;
        case "o":
          setTool("ellipse");
          break;
        case "l":
          setTool("line");
          break;
        case "a":
          setTool("arrow");
          break;
        case "d":
          setTool("draw");
          break;
        case "w":
          setTool("whiteout");
          break;
        case "+":
        case "=":
          setZoom((z) => Math.min(3, Math.round((z + 0.25) * 100) / 100));
          break;
        case "-":
          setZoom((z) => Math.max(0.75, Math.round((z - 0.25) * 100) / 100));
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    currentView,
    duplicateSel,
    editingId,
    pageDisp,
    patchObject,
    redo,
    removeObject,
    selectedId,
    signOpen,
    undo,
  ]);

  // --- Guards -----------------------------------------------------------------
  if (!file) return null;

  if (pageError === "password") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-card border border-border bg-card p-8 text-center">
        <TriangleAlert className="size-8 text-amber-500" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">
          {t("editPdf.passwordProtected")}
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          {t("editPdf.passwordHint")}
        </p>
      </div>
    );
  }

  if (pageError === "corrupt") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-card border border-border bg-card p-8 text-center">
        <TriangleAlert className="size-8 text-amber-500" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">
          {t("editPdf.corruptTitle")}
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          {t("editPdf.corruptHint")}
        </p>
      </div>
    );
  }

  const createPreview = gesture?.type === "create"
    ? {
        left: `${(Math.min(gesture.x0, gesture.x1) / (pageDisp?.w ?? 1)) * 100}%`,
        top: `${(Math.min(gesture.y0, gesture.y1) / (pageDisp?.h ?? 1)) * 100}%`,
        width: `${(Math.abs(gesture.x1 - gesture.x0) / (pageDisp?.w ?? 1)) * 100}%`,
        height: `${(Math.abs(gesture.y1 - gesture.y0) / (pageDisp?.h ?? 1)) * 100}%`,
      }
    : null;

  const strokePreview = gesture?.type === "stroke" && pageDisp
    ? {
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
      }
    : null;

  const toolHintKey =
    tool === "select"
      ? "editPdf.hintSelect"
      : tool === "text"
        ? "editPdf.hintText"
        : tool === "edittext"
          ? "editPdf.hintEditText"
          : tool === "draw"
            ? "editPdf.hintDraw"
            : "editPdf.hintShape";

  return (
    <div className="flex flex-col gap-3">
      <PreviewFileHeader
        file={file}
        pageCount={pageCount}
        onRemove={() => undefined}
      />

      {truncated ? (
        <div className="flex items-start gap-2.5 rounded-card border border-amber-300/60 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="text-xs leading-relaxed">
            {t("editPdf.truncated", { pages: EDITOR_MAX_PAGES })}
          </p>
        </div>
      ) : null}

      <EditorToolbar
        tool={tool}
        onTool={onTool}
        objectCount={objects.length}
      />

      <div className="flex flex-col gap-3 lg:flex-row">
        {/* Canvas column */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <CanvasHeader
            page={selectedPage}
            pages={pageCount}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
            zoom={zoom}
            onZoom={setZoom}
            markedCount={pageObjects.length}
            onFindReplace={openFindReplace}
          />

          {pageCount > 1 ? (
            <PreviewPageStrip
              file={file}
              pageCount={pageCount}
              selected={selectedPage}
              onSelect={setSelectedPage}
              markedSet={touchedPages}
            />
          ) : null}

          {base && !failed && pageDisp && currentView ? (
            <div className="relative mx-auto w-fit max-w-full overflow-hidden rounded-card border border-border bg-card shadow-sm">
              <canvas
                className="block max-w-full"
                style={{
                  width: `${pageDisp.w * zoom}px`,
                }}
                aria-label={t("editPdf.canvasLabel")}
                ref={(canvas) => {
                  (canvasRef as { current: HTMLCanvasElement | null }).current =
                    canvas;
                  if (!canvas) return;
                  const ctx = canvas.getContext("2d");
                  if (!ctx) return;
                  canvas.width = base.bitmap.width;
                  canvas.height = base.bitmap.height;
                  ctx.drawImage(base.bitmap, 0, 0);
                }}
              />
              <div
                ref={overlayRef}
                className="absolute inset-0 touch-none"
                style={{
                  cursor:
                    tool === "select"
                      ? "default"
                      : tool === "edittext"
                        ? "text"
                        : "crosshair",
                }}
                onPointerDown={handleOverlayPointerDown}
                onPointerMove={handleOverlayPointerMove}
                onPointerUp={handleOverlayPointerUp}
                onPointerLeave={handleOverlayPointerUp}
                onContextMenu={(event) => event.preventDefault()}
                role="presentation"
              >
                {pageObjects.map((obj) => (
                  <ObjView
                    key={obj.id}
                    obj={obj}
                    view={currentView}
                    dispW={pageDisp.w}
                    dispH={pageDisp.h}
                    scale={renderScale}
                    selected={selectedId === obj.id}
                    editing={editingId === obj.id}
                    imageUrl={
                      obj.kind === "image"
                        ? assetUrls.get(obj.assetKey) ?? null
                        : null
                    }
                    onCreateDrag={handleObjectPointerDown(obj)}
                    onStartEdit={() => startEditText(obj.id)}
                    onContextMenu={handleContextMenu(obj)}
                  />
                ))}

                {/* P8.3: click-to-edit existing text pieces. */}
                {tool === "edittext" && piecesState === "ready" ? (
                  <TextPieceButtons
                    pieces={pieces}
                    dispW={pageDisp.w}
                    dispH={pageDisp.h}
                    onPick={pickPiece}
                  />
                ) : null}

                {/* Live text editor — exact geometry of the text object. */}
                {editing && editing.kind === "text" ? (() => {
                  const disp = pdfRectToDisplay(editing, currentView);
                  return (
                  <textarea
                    ref={textAreaRef}
                    value={editing.text}
                    onChange={(event) =>
                      patchObject(editing.id, { text: event.target.value }, true)
                    }
                    onBlur={endEdit}
                    spellCheck={false}
                    aria-label={t("editPdf.textEditorLabel")}
                    className="absolute z-20 resize-none overflow-visible rounded-sm bg-white/85 outline-2 outline-primary backdrop-blur-[1px]"
                    style={{
                      left: `${(disp.x / pageDisp.w) * 100}%`,
                      top: `${(disp.y / pageDisp.h) * 100}%`,
                      width: `${(disp.w / pageDisp.w) * 100}%`,
                      minHeight: `${disp.h * renderScale}px`,
                      fontFamily: cssFontOf(editing.font),
                      fontSize: `${editing.size * renderScale}px`,
                      lineHeight: LINE_HEIGHT,
                      color: editing.color,
                      fontWeight: editing.bold ? 700 : 400,
                      fontStyle: editing.italic ? "italic" : "normal",
                      textDecoration: editing.underline ? "underline" : "none",
                      textAlign: editing.align,
                      padding: `${TEXT_PAD * renderScale}px`,
                    }}
                  />
                  );
                })() : null}

                {createPreview ? (
                  <div
                    className="pointer-events-none absolute border-2 border-primary bg-primary/10"
                    style={createPreview}
                    aria-hidden="true"
                  />
                ) : null}

                {strokePreview && gesture?.type === "stroke" && pageDisp ? (
                  <svg
                    className="pointer-events-none absolute inset-0"
                    width="100%"
                    height="100%"
                    viewBox={`0 0 ${pageDisp.w} ${pageDisp.h}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <polyline
                      points={gesture.pts
                        .map((p) => `${p.x},${p.y}`)
                        .join(" ")}
                      fill="none"
                      stroke="#dc2626"
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center rounded-card border border-border bg-card">
              {failed ? (
                <p className="text-xs text-muted-foreground">
                  {t("editPdf.renderError")}
                </p>
              ) : (
                <>
                  <Loader2
                    className="size-5 animate-spin text-primary"
                    aria-hidden="true"
                  />
                  <span className="sr-only">{t("editPdf.loading")}</span>
                </>
              )}
            </div>
          )}

          <p className="text-xs leading-relaxed text-muted-foreground">
            {tool === "edittext" && piecesState === "loading"
              ? t("editPdf.pieceLoading")
              : t(toolHintKey)}
          </p>

          {tool === "edittext" && piecesState === "empty" ? (
            <div className="flex items-start gap-2.5 rounded-card border border-amber-300/60 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <div>
                <p className="text-xs font-semibold">
                  {t("editPdf.noTextTitle")}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed">
                  {t("editPdf.noTextHint")}
                </p>
              </div>
            </div>
          ) : null}
        </div>

        {/* Right rail: properties + layers */}
        <div className="flex w-full shrink-0 flex-col gap-3 lg:w-80">
          <PropertiesPanel
            object={selected}
            onPatch={(patch) => {
              if (selected) patchObject(selected.id, patch);
            }}
            onRaise={() => {
              if (selectedId)
                applyObjects(raiseOne(objectsRef.current, selectedId), `z:${selectedId}`);
            }}
            onLower={() => {
              if (selectedId)
                applyObjects(lowerOne(objectsRef.current, selectedId), `z:${selectedId}`);
            }}
            onDuplicate={duplicateSel}
            onDelete={() => {
              if (selectedId) removeObject(selectedId);
            }}
            onToggleLock={() => {
              if (selected)
                patchObject(selected.id, { locked: !selected.locked });
            }}
          />
          <LayersPanel
            objects={pageObjects}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onPatch={patchObject}
            onRemove={removeObject}
          />
        </div>
      </div>

      {/* Hidden image input */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          onImageFiles(event.target.files);
          event.target.value = "";
        }}
        aria-hidden="true"
        tabIndex={-1}
      />

      {signOpen ? (
        <SignPadDialog
          onClose={() => setSignOpen(false)}
          onDone={onSignature}
        />
      ) : null}

      {frOpen ? (
        <FindReplaceDialog
          query={frQuery}
          onQuery={setFrQuery}
          replacement={frReplacement}
          onReplacement={setFrReplacement}
          matchCase={frCase}
          onMatchCase={setFrCase}
          scanning={frScan !== null}
          scanPage={frScan?.page ?? 0}
          scanPages={frScan?.pages ?? 0}
          matches={frMatches}
          hasQuery={frQuery.length > 0}
          onReplaceOne={() => applyLineReplacements(true)}
          onReplaceAll={() => applyLineReplacements(false)}
          onJump={(index) => {
            const match = frMatches[index];
            if (match) {
              setSelectedPage(match.page);
              setFrOpen(false);
            }
          }}
          onClose={() => setFrOpen(false)}
        />
      ) : null}

      {menu && selected ? (
        <EditorContextMenu
          state={menu}
          locked={selected.locked}
          onDuplicate={duplicateSel}
          onBringFront={() =>
            applyObjects(bringToFront(objectsRef.current, menu.objId), `z:${menu.objId}`)
          }
          onSendBack={() =>
            applyObjects(sendToBack(objectsRef.current, menu.objId), `z:${menu.objId}`)
          }
          onToggleLock={() =>
            patchObject(menu.objId, {
              locked: !objectsRef.current.find((o) => o.id === menu.objId)?.locked,
            })
          }
          onDelete={() => removeObject(menu.objId)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

function cssFontOf(font: string): string {
  if (font === "times") return "'Times New Roman', Times, serif";
  if (font === "courier") return "'Courier New', Courier, monospace";
  if (font === "devanagari") return "'Noto Sans Devanagari', Arial, sans-serif";
  return "Arial, Helvetica, sans-serif";
}
