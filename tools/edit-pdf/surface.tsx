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
import { Info, Lightbulb, Loader2, ScanText, TriangleAlert, X } from "lucide-react";

import { loadPdfjs } from "@/lib/pdf/pdfjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  getPdfPageCount,
  getPdfPagePixelSize,
  renderPdfThumbnail,
} from "@/lib/pdf/thumbnails";
import { useToast } from "@/hooks/use-toast";
import { navigateToHash, ROUTES } from "@/hooks/use-hash-route";
import { setChainHandoff } from "@/lib/tools/chain";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { useI18n } from "@/components/providers/locale-provider";
import { BottomSheet } from "@/components/doco/bottom-sheet";
import { Button } from "@/components/ui/button";
import {
  PreviewFileHeader,
} from "../stamp-common/preview-parts";
import {
  addImageFile,
  addPngBlob,
  clearAssets,
  getAssetsSnapshot,
  getAssetsServerSnapshot,
  setRunOrder,
  subscribeAssets,
} from "./asset-store";
import {
  CanvasHeader,
  CropOverlay,
  EditorContextMenu,
  EditorPageStrip,
  EditorToolbar,
  FindReplaceDialog,
  LayersPanel,
  MobileToolbar,
  MoreSheet,
  MultiSelectPanel,
  ObjView,
  PropertiesPanel,
  SignPadDialog,
  SnapGuides,
  TextEditBar,
  TextPieceButtons,
  type ContextMenuState,
  type FrMatchView,
  type ToolId,
} from "./editor-parts";
import { harvestPageText, scanPagesText } from "./text-layer";
import {
  deleteDraft,
  draftHasImages,
  encodeDraft,
  loadDraft,
  saveDraft,
  draftKeyFor,
  type EditDraft,
} from "./drafts";
import {
  HISTORY_LIMIT,
  LINE_HEIGHT,
  MIN_CROP_PT,
  MIN_OBJ_PT,
  TEXT_PAD,
  bringManyToFront,
  bringToFront,
  buildReplaceLineObjects,
  buildReplacePieceObjects,
  clampN,
  computeSnap,
  cropPageViews,
  cropSignature,
  deletePageViews,
  displayAngle,
  displayRectToPdf,
  displaySize,
  duplicateObject,
  duplicateObjects,
  duplicatePageViews,
  effectiveView,
  groupPiecesIntoLines,
  isRotatable,
  lowerOne,
  luminance,
  makeDraw,
  makeField,
  makeImage,
  makeShape,
  makeText,
  makeWhiteout,
  marqueeSelection,
  medianRgb,
  movePageViews,
  movePermutation,
  normaliseDraw,
  normalizeRotation,
  normalizeViews,
  pdfRectToDisplay,
  pickInkFromPixels,
  pieceDisplayRect,
  pieceRect,
  planLineReplacements,
  raiseOne,
  redoStep,
  remapObjectsByPermutation,
  remapObjectsForPageOp,
  rgbToHex,
  rotatePageViews,
  rotationOffset,
  roundPt,
  sendManyToBack,
  sendToBack,
  substituteOccurrences,
  takenFieldNames,
  unionRects,
  undoStep,
  viewCrop,
  workspacePositionsForSrc,
  type CropRect,
  type EditorObject,
  type HarvestPiece,
  type HitEdge,
  type LineMatch,
  type ObjRect,
  type PageView,
  type PieceLine,
  type SnapGuide,
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
/** P8.6: snap threshold at display scale (page pt, zoom-adjusted). */
const SNAP_BASE_PT = 4;
/** P8.6: long-press opens the context menu after this long (ms). */
const LONG_PRESS_MS = 500;
/** P8.6: movement that cancels a long-press (display pt). */
const LONG_PRESS_SLOP = 8;
/** P8.6: a marquee drag smaller than this is a click (display pt). */
const MARQUEE_MIN_PT = 4;
/** P8.6: autosave debounce (ms). */
const DRAFT_DEBOUNCE_MS = 1500;
/** R6-a (D): one-time "Edit text exists" hint flag (per install). */
const FIRST_HINT_KEY = "dp_editpdf_first_hint_v1";

/** Mobile mode = coarse pointer OR narrower than the lg breakpoint. */
function useMobileMode(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const coarse = window.matchMedia("(pointer: coarse)");
    const update = (): void => {
      setMobile(coarse.matches || window.innerWidth < 1024);
    };
    update();
    coarse.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      coarse.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return mobile;
}

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
  /** R12: true when the source document exceeds EDITOR_MAX_PAGES — the
   * worker then treats an identity-prefix plan as truncated (tail kept)
   * instead of a tail-page delete. */
  truncated?: boolean;
}

type CreateKind =
  | "text"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "whiteout"
  | "field";

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
      ids: string[];
      grabDx: number;
      grabDy: number;
      origs: ObjRect[];
      union: ObjRect;
    }
  | {
      type: "resize";
      id: string;
      edge: HitEdge;
      orig: ObjRect;
      keepAspect: boolean;
      aspect: number;
    }
  | {
      type: "rotate";
      id: string;
      cx: number;
      cy: number;
      startAngle: number;
      startRotation: number;
    }
  | {
      type: "marquee";
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      base: string[];
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
    const rotate = r === 90 || r === 180 || r === 270 ? r : 0;
    views.push({
      x0: raw[0],
      y0: raw[1],
      x1: raw[2],
      y1: raw[3],
      rotate,
      // R13: the rotation this SOURCE page shipped with — the user's
      // offset reads as rotate − srcRotate (badges, honest resets).
      srcRotate: rotate,
      // R12: identity source index — page ops permute/splice/repeat these.
      src: p - 1,
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
      // Stale blobs (pre-R12) carry no src — identity positions, exactly
      // what the worker's parseViews assumes for absent srcs.
      pageViews: Array.isArray(parsed.pageViews)
        ? (parsed.pageViews as PageView[]).map((v, i) => ({
            ...v,
            src: typeof v?.src === "number" ? v.src : i,
          }))
        : [],
      truncated: parsed.truncated === true,
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
 * R13: takes the piece's DISPLAY rect (mapped through the CURRENT view)
 * so bitmap and rect agree on every rotation.
 */
function samplePieceColors(
  bitmap: ImageBitmap,
  dispW: number,
  dispH: number,
  rect: ObjRect
): { bg: string; ink: string } {
  try {
    const sx = bitmap.width / Math.max(1, dispW);
    const sy = bitmap.height / Math.max(1, dispH);
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

  const assets = useSyncExternalStore(
    subscribeAssets,
    getAssetsSnapshot,
    getAssetsServerSnapshot,
  );
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
          truncated: truncatedRef.current,
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

  // --- Document state (page-positioning half — needed by history) --------
  // R12: pageCount is the WORKSPACE page count (changes with page ops);
  // srcPageCount is the ORIGINAL file's page count (find & replace scans
  // and draft validation run against the source document).
  const [pageCount, setPageCount] = useState(0);
  const [selectedPage, setSelectedPage] = useState(0);
  const [srcPageCount, setSrcPageCount] = useState(0);

  // --- History (undo/redo snapshot stack) --------------------------------
  // Stacks live in a ref (mutated from handlers only); their LENGTHS are
  // mirrored into state so canUndo/canRedo stay render-safe.
  // R12: a snapshot = objects AND page views ({o, v}) — undo/redo of a
  // delete/reorder/duplicate restores the page plan with its objects.
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

  // R12: live views mirror — the same write-only-in-handlers discipline
  // as objectsRef, so a page op and an object edit in one tick cohere.
  // truncatedRef mirrors the >500-page flag for the blob the worker reads.
  const viewsRef = useRef<PageView[]>([]);
  const truncatedRef = useRef(false);
  const snapshot = useCallback(
    (): string =>
      JSON.stringify({ o: objectsRef.current, v: viewsRef.current }),
    []
  );

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
            snapshot(),
          ].slice(-HISTORY_LIMIT);
          h.future = [];
          h.lastKey = groupKey;
          h.lastAt = now;
        }
        syncLens();
      }
      objectsRef.current = next;
      commit(next, viewsRef.current);
    },
    [commit, snapshot, syncLens]
  );

  /** Restores a history snapshot (objects + page plan) into the live state. */
  const restoreSnapshot = useCallback(
    (raw: string): void => {
      const parsed = JSON.parse(raw) as {
        o: EditorObject[];
        v: PageView[];
      };
      objectsRef.current = parsed.o;
      viewsRef.current = parsed.v;
      commit(parsed.o, parsed.v);
      setPageCount(parsed.v.length);
      setSelectedPage((p) => Math.min(p, Math.max(0, parsed.v.length - 1)));
    },
    [commit]
  );

  // --- R12: page operations (delete / reorder / duplicate) -----------------
  /** Commits a page plan change with its remapped objects, as ONE undo step. */
  const applyPageOp = useCallback(
    (
      nextObjects: EditorObject[],
      nextViews: PageView[],
      groupKey: string,
      nextSelected?: number
    ): void => {
      const h = histRef.current;
      const now = Date.now();
      if (h.lastKey === groupKey && now - h.lastAt < 800) {
        h.lastAt = now;
      } else {
        h.past = [...h.past, snapshot()].slice(-HISTORY_LIMIT);
        h.future = [];
        h.lastKey = groupKey;
        h.lastAt = now;
      }
      syncLens();
      objectsRef.current = nextObjects;
      viewsRef.current = nextViews;
      commit(nextObjects, nextViews);
      setPageCount(nextViews.length);
      if (nextSelected !== undefined) setSelectedPage(nextSelected);
      else
        setSelectedPage((p) => Math.min(p, Math.max(0, nextViews.length - 1)));
    },
    [commit, snapshot, syncLens]
  );

  const deletePage = useCallback(
    (pos: number): void => {
      const views = viewsRef.current;
      if (pos < 0 || pos >= views.length || views.length <= 1) return;
      const nextViews = deletePageViews(views, pos);
      const nextObjects = remapObjectsForPageOp(
        objectsRef.current,
        pos,
        "delete"
      );
      const next =
        selectedPage === pos
          ? Math.min(pos, nextViews.length - 1)
          : selectedPage > pos
            ? selectedPage - 1
            : selectedPage;
      applyPageOp(nextObjects, nextViews, `page:delete:${pos}`, next);
      toast({ title: t("editPdf.pageDeletedToast", { page: pos + 1 }) });
    },
    [applyPageOp, selectedPage, t, toast]
  );

  const movePage = useCallback(
    (from: number, to: number): void => {
      const views = viewsRef.current;
      if (
        from < 0 ||
        to < 0 ||
        from >= views.length ||
        to >= views.length ||
        from === to
      ) {
        return;
      }
      const perm = movePermutation(from, to, views.length);
      const nextViews = movePageViews(views, from, to);
      const nextObjects = remapObjectsByPermutation(
        objectsRef.current,
        perm
      );
      applyPageOp(
        nextObjects,
        nextViews,
        `page:move:${from}:${to}`,
        perm[selectedPage] ?? selectedPage
      );
    },
    [applyPageOp, selectedPage]
  );

  const duplicatePage = useCallback(
    (pos: number): void => {
      const views = viewsRef.current;
      if (
        pos < 0 ||
        pos >= views.length ||
        views.length >= EDITOR_MAX_PAGES
      ) {
        return;
      }
      const nextViews = duplicatePageViews(views, pos);
      if (nextViews === views) return;
      const nextObjects = remapObjectsForPageOp(
        objectsRef.current,
        pos,
        "duplicate"
      );
      const next = selectedPage > pos ? selectedPage + 1 : selectedPage;
      applyPageOp(nextObjects, nextViews, `page:dup:${pos}`, next);
      toast({ title: t("editPdf.pageDuplicatedToast", { page: pos + 1 }) });
    },
    [applyPageOp, selectedPage, t, toast]
  );

  // R13: page rotation — objects stay in user space (they ride along with
  // the page), so this is a views-only commit; the selection stays put.
  // Rotation is allowed even on truncated (>500-page) workspaces: it
  // never reorders or drops slots, and the untouched tail keeps its own
  // /Rotate in the worker (the plan bounds the setRotation loop).
  const rotatePage = useCallback(
    (pos: number, delta: number): void => {
      const views = viewsRef.current;
      const nextViews = rotatePageViews(views, pos, delta);
      if (nextViews === views) return;
      applyPageOp(
        objectsRef.current,
        nextViews,
        `page:rot:${pos}:${nextViews[pos]?.rotate ?? 0}`,
        selectedPage
      );
      toast({
        title: t("editPdf.pageRotatedToast", {
          page: pos + 1,
          deg: nextViews[pos]?.rotate ?? 0,
        }),
      });
    },
    [applyPageOp, selectedPage, t, toast]
  );

  // --- R15: page crop (the last organize op) --------------------------------
  // cropPage commits a cropped/reset view exactly like rotatePage — objects
  // stay in user space, so it's a views-only commit; the selection stays.
  // Crop is allowed even on truncated (>500-page) workspaces: it never
  // reorders or drops slots, and the worker bounds its /CropBox writes to
  // the plan (the untouched tail keeps its own box).
  const cropPage = useCallback(
    (pos: number, crop: CropRect | null): void => {
      const views = viewsRef.current;
      const nextViews = cropPageViews(views, pos, crop);
      if (nextViews === views) return;
      applyPageOp(
        objectsRef.current,
        nextViews,
        crop === null ? `page:cropreset:${pos}` : `page:crop:${pos}`,
        selectedPage
      );
      toast({
        title:
          crop === null
            ? t("editPdf.cropResetToast", { page: pos + 1 })
            : t("editPdf.pageCroppedToast", { page: pos + 1 }),
      });
    },
    [applyPageOp, selectedPage, t, toast]
  );

  const undo = useCallback((): void => {
    const current = snapshot();
    const step = undoStep(histRef.current.past, histRef.current.future, current);
    if (step.snapshot === null) return;
    histRef.current.past = step.past;
    histRef.current.future = step.future;
    histRef.current.lastKey = "";
    histRef.current.lastAt = 0;
    restoreSnapshot(step.snapshot);
    syncLens();
  }, [restoreSnapshot, snapshot, syncLens]);

  const redo = useCallback((): void => {
    const current = snapshot();
    const step = redoStep(histRef.current.past, histRef.current.future, current);
    if (step.snapshot === null) return;
    histRef.current.past = step.past;
    histRef.current.future = step.future;
    histRef.current.lastKey = "";
    histRef.current.lastAt = 0;
    restoreSnapshot(step.snapshot);
    syncLens();
  }, [restoreSnapshot, snapshot, syncLens]);

  const canUndo = histLens.past > 0;
  const canRedo = histLens.future > 0;

  // --- Document state -----------------------------------------------------
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
      setCropMode(false);
      const count = await getPdfPageCount(file);
      if (cancelled || viewToken.current !== token) return;
      setSrcPageCount(count);
      const isTruncated = count > EDITOR_MAX_PAGES;
      truncatedRef.current = isTruncated;
      setTruncated(isTruncated);
      const views = await collectPageViews(file, EDITOR_MAX_PAGES);
      if (cancelled || viewToken.current !== token) return;
      objectsRef.current = [];
      viewsRef.current = views;
      histRef.current = { past: [], future: [], lastKey: "", lastAt: 0 };
      syncLens();
      // R12: the workspace starts as the document's identity plan (capped
      // at EDITOR_MAX_PAGES for monster files) — pageCount tracks it.
      setPageCount(views.length);
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
  // R12: the canvas renders the SOURCE page the selected slot shows; the
  // plan string (not the array identity) is the dep, so object-only
  // commits never re-render the page bitmap.
  // R13: the fingerprint carries src AND effective rotation (src@rotate),
  // so a page rotation re-renders the bitmap; the pdf.js viewport gets
  // the rotation as an explicit override (replaces /Rotate).
  // R15: the fingerprint also carries the crop signature (3rd part) — a
  // crop re-renders the bitmap AND its display size (getPdfPagePixelSize
  // gets the same crop), so canvas, size and overlay always agree.
  const planKey = useMemo(
    () =>
      pageViews
        .map((v) => `${v.src ?? -1}@${v.rotate}@${cropSignature(v)}`)
        .join(","),
    [pageViews]
  );
  useEffect(() => {
    if (!file || pageCount === 0) return;
    const view = viewsRef.current[selectedPage];
    const src = view?.src ?? selectedPage;
    const rotation = view?.rotate;
    const crop = viewCrop(view);
    let cancelled = false;
    void (async () => {
      const [thumb, pixel] = await Promise.all([
        renderPdfThumbnail(file, {
          pageIndex: src,
          maxDim: Math.min(2800, Math.round(PREVIEW_MAX_DIM * zoom * 2)),
          ...(rotation !== undefined ? { rotation } : {}),
          ...(crop ? { crop } : {}),
        }),
        getPdfPagePixelSize(file, 1, src, rotation, crop),
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
  }, [file, pageCount, selectedPage, zoom, planKey]);

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

  const currentView = pageViews[selectedPage]
    ? effectiveView(pageViews[selectedPage])
    : null;
  const pageDisp = currentView ? displaySize(currentView) : null;

  // R15 crop mode (see cropPage above): the overlay state lives here so it
  // can read the effective view + display size.
  const [cropMode, setCropMode] = useState(false);
  const canvasReady = base !== null && !failed;
  const toggleCropMode = useCallback((): void => {
    setCropMode((on) => {
      if (on) return false;
      if (!canvasReady) return false;
      // Object chrome (selection handles, edit boxes) would fight the
      // crop handles for pointer events — clear it for the session.
      setSelectedIds([]);
      return true;
    });
  }, [canvasReady]);

  // Applying from the overlay: the rect arrives in DISPLAY points of the
  // CURRENT effective view — mapped to user space (rotation-aware) before
  // the commit. A rect covering (almost) the whole view resets the crop
  // instead of storing a pointless whole-page crop.
  const applyCropFromDisplay = useCallback(
    (disp: ObjRect): void => {
      if (!currentView || !pageDisp) return;
      const isFull =
        disp.x <= 0.5 &&
        disp.y <= 0.5 &&
        disp.w >= pageDisp.w - 1 &&
        disp.h >= pageDisp.h - 1;
      const user = displayRectToPdf(disp, currentView);
      cropPage(selectedPage, isFull ? null : {
        x0: user.x,
        y0: user.y,
        x1: user.x + user.w,
        y1: user.y + user.h,
      });
      setCropMode(false);
    },
    [cropPage, currentView, pageDisp, selectedPage]
  );
  const resetCrop = useCallback((): void => {
    cropPage(selectedPage, null);
    setCropMode(false);
  }, [cropPage, selectedPage]);

  // --- Selection + tools ----------------------------------------------------
  const [tool, setTool] = useState<ToolId>("select");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [signOpen, setSignOpen] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const mobileMode = useMobileMode();
  const [moreOpen, setMoreOpen] = useState(false);
  const [propsOpen, setPropsOpen] = useState(false);
  // R6-a (C): session-dismissible "click any text" chip (edittext mode).
  const [editHintDismissed, setEditHintDismissed] = useState(false);
  // R6-a (D): one-time "Edit text exists" pointer — null = not yet shown,
  // "seen" = dismissed/shown before (persisted per install).
  const [firstHint, setFirstHint] = useState<string | null>(() => {
    try {
      return localStorage.getItem(FIRST_HINT_KEY);
    } catch {
      return null; // private mode — just show the hint, persist nothing
    }
  });

  const dismissFirstHint = useCallback((): void => {
    setFirstHint("seen");
    try {
      localStorage.setItem(FIRST_HINT_KEY, "1");
    } catch {
      /* storage unavailable — session dismissal only */
    }
  }, []);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const zoomWrapRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  // P8.6 pinch: live pointer cache (capture-phase on the overlay) — when 2
  // pointers are active, single-finger gestures are cancelled and the
  // pinch math owns zoom + pan.
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{
    dist: number;
    zoom: number;
    mid: { x: number; y: number };
    scroll: { left: number; top: number };
  } | null>(null);
  // P8.6 long-press context menu (coarse pointers).
  const longPressRef = useRef<{
    id: string;
    x: number;
    y: number;
    clientX: number;
    clientY: number;
    timer: number;
  } | null>(null);
  const coarseRef = useRef(false);

  const pageObjects = useMemo(
    () => objects.filter((o) => o.page === selectedPage),
    [objects, selectedPage]
  );
  const selected = useMemo(
    () => (selectedId !== null ? objects.find((o) => o.id === selectedId) ?? null : null),
    [objects, selectedId]
  );
  /** P8.6: the multi-selection outline = the union of the selected bboxes. */
  const multiUnion = useMemo(() => {
    if (selectedIds.length < 2 || !currentView) return null;
    const rects = selectedIds
      .map((id) => objects.find((o) => o.id === id))
      .filter((o): o is EditorObject => o !== undefined && !o.hidden)
      .map((o) => pdfRectToDisplay(o, currentView));
    return unionRects(rects);
  }, [selectedIds, objects, currentView]);
  const allSelectedLocked = useMemo(
    () =>
      selectedIds.length > 0 &&
      selectedIds.every((id) => objects.find((o) => o.id === id)?.locked === true),
    [selectedIds, objects]
  );
  const editing = useMemo(
    () => (editingId !== null ? objects.find((o) => o.id === editingId) ?? null : null),
    [objects, editingId]
  );
  const touchedPages = useMemo(
    () => new Set(objects.map((o) => o.page)),
    [objects]
  );
  // R13: per-slot user rotation offsets (0 = untouched) — the strip's
  // amber degree badges read them (a rotated page needs the cue its
  // 72px thumbnail can't give on its own).
  const rotOffsets = useMemo(
    () => pageViews.map((v) => rotationOffset(v)),
    [pageViews]
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
      setSelectedIds((prev) => prev.filter((sid) => sid !== id));
      if (editingId === id) setEditingId(null);
    },
    [applyObjects, editingId]
  );

  /** P8.6: removes EVERY selected object in one history step. */
  const removeSelected = useCallback((): void => {
    if (selectedIds.length === 0) return;
    const gone = new Set(selectedIds);
    applyObjects(
      objectsRef.current.filter((o) => !gone.has(o.id)),
      `removeMany:${selectedIds.length}`
    );
    setSelectedIds([]);
    setEditingId(null);
  }, [applyObjects, selectedIds]);

  const duplicateSelected = useCallback((): void => {
    if (selectedIds.length === 0) return;
    if (selectedIds.length === 1) {
      const result = duplicateObject(objectsRef.current, selectedIds[0]);
      if (result.copy) {
        applyObjects(result.objects, `dup:${selectedIds[0]}`);
        setSelectedIds([result.copy.id]);
      }
      return;
    }
    const result = duplicateObjects(objectsRef.current, selectedIds);
    if (result.copies.length > 0) {
      applyObjects(result.objects, `dupMany:${selectedIds.length}`);
      setSelectedIds(result.copies.map((c) => c.id));
    }
  }, [applyObjects, selectedIds]);

  /** P8.6: moves every selected object by a display delta (one step). */
  const nudgeSelected = useCallback(
    (dx: number, dy: number): void => {
      if (selectedIds.length === 0 || !currentView || !pageDisp) return;
      const ids = new Set(selectedIds);
      applyObjects(
        objectsRef.current.map((o) => {
          if (!ids.has(o.id)) return o;
          const disp = pdfRectToDisplay(o, currentView);
          const pdf = displayRectToPdf(
            {
              x: clampN(disp.x + dx, 0, pageDisp.w - disp.w),
              y: clampN(disp.y + dy, 0, pageDisp.h - disp.h),
              w: disp.w,
              h: disp.h,
            },
            currentView
          );
          return { ...o, x: roundPt(pdf.x), y: roundPt(pdf.y) } as EditorObject;
        }),
        `nudge:${selectedIds.length}`
      );
    },
    [applyObjects, currentView, pageDisp, selectedIds]
  );

  // --- Text editing ---------------------------------------------------------
  const startEditText = useCallback((id: string): void => {
    setSelectedIds([id]);
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

  // R6-c: auto-grow the inline editing box so it hugs its content. The
  // object rect stays the save-time geometry, but while editing, wrapped
  // lines must stay inside the visible white box — a plain textarea keeps
  // its default 2-row height and spills text below it, which also fed the
  // mini-toolbar's below-anchor a stale live height. Runs on every text
  // patch (objects changes per keystroke), font/size change, and zoom.
  useLayoutEffect(() => {
    const el = textAreaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editingId, objects, renderScale]);

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
      setSelectedIds([obj.id]);
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
    setSelectedIds([]);
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
    // R12: pieces are SOURCE-page-indexed (they harvest from the file), so
    // the cache survives reorders/deletes/duplicates of the same src.
    const src = viewsRef.current[selectedPage]?.src ?? selectedPage;
    const cached = pieceCacheRef.current.get(src);
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
        const harvested = await harvestPageText(file, src);
        if (harvestToken.current !== token) return;
        pieceCacheRef.current.set(src, harvested);
        setPieces(harvested);
        setPiecesState(harvested.length === 0 ? "empty" : "ready");
      } catch {
        if (harvestToken.current !== token) return;
        setPieces([]);
        setPiecesState("empty");
      }
    })();
  }, [tool, file, selectedPage, viewsReady, planKey]);

  const pickPiece = useCallback(
    (piece: HarvestPiece): void => {
      if (!base || !pageDisp || !currentView) return;
      const samples = samplePieceColors(
        base.bitmap,
        base.dispW,
        base.dispH,
        pieceDisplayRect(piece, currentView)
      );
      const { cover, text } = buildReplacePieceObjects(
        selectedPage,
        piece,
        samples.bg,
        samples.ink
      );
      applyObjects([...objectsRef.current, cover, text], `replace:${text.id}`);
      setSelectedIds([text.id]);
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

  // --- R6-a: empty-state OCR hand-off (scan PDFs get a real next step) ------
  // The chain bridge (src/lib/tools/chain.ts) passes the working File to
  // ocr-pdf in memory — the same genuine hand-off the result view's "What
  // next?" row uses; the OCR shell picks it up on mount, no re-upload.
  const handOffToOcr = useCallback((): void => {
    if (!file) return;
    setChainHandoff({
      fromToolId: "edit-pdf",
      items: [{ id: fileId !== "" ? fileId : "ocr-handoff", file }],
    });
    toast({ title: t("editPdf.ocrHandoffToast") });
    navigateToHash(ROUTES.tool("ocr-pdf"));
  }, [file, fileId, t, toast]);

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
          // R12: the scan walks SOURCE pages (its page refs are original
          // indices) — page ops in the workspace never stale it.
          const all = await scanPagesText(
            file,
            Math.max(1, srcPageCount || EDITOR_MAX_PAGES),
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
  }, [file, srcPageCount]);

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
        // R12: the row shows the CURRENT workspace position of that source
        // page (what the jump selects); the key stays source-based so the
        // replace bookkeeping is untouched by reorders.
        page: workspacePositionsForSrc(pageViews, m.page)[0] ?? m.page,
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
  }, [frVersion, frQuery, frCase, frDone, pageViews]);

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
        // R12: the line lives on SOURCE page line.page — the replacement
        // lands on EVERY workspace slot showing that source (duplicated
        // pages get their copy fixed too, what "replace across the
        // document" means after page ops). R13: line.user is view-free
        // (user-space rect) — every slot showing one src shares it.
        const targets = workspacePositionsForSrc(pageViews, line.page);
        const slots = targets.length > 0 ? targets : [line.page];
        if (slots.length === 0) continue;
        const newText = substituteOccurrences(
          line.text,
          ms.map((m) => ({ start: m.start, end: m.end })),
          frReplacement
        );
        for (const q of slots) {
          const { cover, text } = buildReplaceLineObjects(
            q,
            line,
            pagePieces,
            newText,
            DEFAULT_BG,
            DEFAULT_INK
          );
          added.push(cover, text);
        }
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

  // P8.6 pinch: capture-phase pointer cache. Runs BEFORE any child handler
  // (so a second finger cancels an in-flight drag), on every pointer over
  // the page.
  const cancelLongPress = (): void => {
    if (longPressRef.current !== null) {
      clearTimeout(longPressRef.current.timer);
      longPressRef.current = null;
    }
  };

  const initPinch = (): void => {
    const pts = [...pointersRef.current.values()];
    if (pts.length < 2) {
      pinchRef.current = null;
      return;
    }
    const wrap = zoomWrapRef.current;
    const box = wrap?.getBoundingClientRect();
    pinchRef.current = {
      dist: Math.max(1, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)),
      zoom,
      mid: box
        ? {
            x: (pts[0].x + pts[1].x) / 2 - box.left,
            y: (pts[0].y + pts[1].y) / 2 - box.top,
          }
        : { x: 0, y: 0 },
      scroll: {
        left: wrap?.scrollLeft ?? 0,
        top: wrap?.scrollTop ?? 0,
      },
    };
  };

  const applyPinch = (): void => {
    const pinch = pinchRef.current;
    const wrap = zoomWrapRef.current;
    if (!pinch || !wrap || !pageDisp) return;
    const pts = [...pointersRef.current.values()];
    if (pts.length < 2) return;
    const box = wrap.getBoundingClientRect();
    const dist = Math.max(1, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
    const mid = {
      x: (pts[0].x + pts[1].x) / 2 - box.left,
      y: (pts[0].y + pts[1].y) / 2 - box.top,
    };
    const z = clampN((pinch.zoom * dist) / pinch.dist, 0.75, 3);
    // Keep the pinch-start content point under the CURRENT midpoint and
    // let the midpoint's own movement pan the page (s1 = p*z − scroll).
    const ratio = z / pinch.zoom;
    const left = (pinch.scroll.left + pinch.mid.x) * ratio - mid.x;
    const top = (pinch.scroll.top + pinch.mid.y) * ratio - mid.y;
    setZoom(z);
    const settle = (): void => {
      wrap.scrollLeft = left;
      wrap.scrollTop = top;
    };
    settle();
    requestAnimationFrame(settle);
  };

  const trackPointerDown = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointersRef.current.size === 2) {
      // Second finger: single-pointer gestures are dead, pinch owns zoom.
      cancelLongPress();
      setGesture(null);
      setGuides([]);
      initPinch();
    }
  };

  const trackPointerMove = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointersRef.current.size >= 2) {
      applyPinch();
      event.preventDefault();
    }
  };

  const trackPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
  };

  const handleOverlayPointerDown = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    if (!base || !currentView || event.button !== 0) return;
    if (pointersRef.current.size >= 2) return; // pinch owns the canvas
    if (menu) setMenu(null);
    const pos = displayPos(event);
    if (tool === "select") {
      // P8.6: dragging on empty canvas marquee-selects; a click clears.
      setEditingId(null);
      try {
        overlayRef.current?.setPointerCapture(event.pointerId);
      } catch {
        /* synthetic pointers */
      }
      setGesture({
        type: "marquee",
        x0: pos.x,
        y0: pos.y,
        x1: pos.x,
        y1: pos.y,
        base: event.shiftKey ? [...selectedIds] : [],
      });
      event.preventDefault();
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
      setSelectedIds([]);
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
    setSelectedIds([]);
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
    if (pointersRef.current.size >= 2) return; // pinch owns the canvas
    if (!gesture || !pageDisp || !currentView) return;
    const pos = displayPos(event);
    // Long-press cancels as soon as the finger drifts past the slop.
    if (longPressRef.current !== null) {
      const lp = longPressRef.current;
      if (Math.hypot(pos.x - lp.x, pos.y - lp.y) > LONG_PRESS_SLOP) {
        cancelLongPress();
      }
    }
    if (gesture.type === "stroke") {
      const last = gesture.pts[gesture.pts.length - 1];
      if (Math.hypot(pos.x - last.x, pos.y - last.y) > 1.5) {
        setGesture({ ...gesture, pts: [...gesture.pts, pos] });
      }
      return;
    }
    if (gesture.type === "create" || gesture.type === "marquee") {
      setGesture({ ...gesture, x1: pos.x, y1: pos.y });
      return;
    }
    if (gesture.type === "rotate") {
      const angle = displayAngle(pos, { x: gesture.cx, y: gesture.cy });
      let delta = (angle - gesture.startAngle) % 360;
      if (delta > 180) delta -= 360;
      if (delta <= -180) delta += 360;
      let next = gesture.startRotation + delta;
      // Shift = 15° steps, otherwise a 1° grid (PRD §8.2 rotation).
      next = event.shiftKey ? Math.round(next / 15) * 15 : Math.round(next);
      patchObject(gesture.id, { rotation: normalizeRotation(next) });
      return;
    }
    if (gesture.type === "move") {
      // P8.6: group move — the union rect is proposed from the pointer,
      // clamped to the page, snapped to the guides, then the same display
      // delta is applied to every selected object (one history group).
      const union = gesture.union;
      const proposed = {
        x: clampN(pos.x - gesture.grabDx, 0, pageDisp.w - union.w),
        y: clampN(pos.y - gesture.grabDy, 0, pageDisp.h - union.h),
        w: union.w,
        h: union.h,
      };
      const moving = new Set(gesture.ids);
      const others = objectsRef.current
        .filter((o) => o.page === selectedPage && !o.hidden && !moving.has(o.id))
        .map((o) => pdfRectToDisplay(o, currentView));
      const snap = computeSnap(
        proposed,
        pageDisp,
        others,
        SNAP_BASE_PT * zoom
      );
      setGuides(snap.guides);
      const dx = proposed.x + snap.dx - union.x;
      const dy = proposed.y + snap.dy - union.y;
      const byId = new Map<string, ObjRect>();
      gesture.ids.forEach((id, i) => {
        const orig = gesture.origs[i];
        const pdf = displayRectToPdf(
          { x: orig.x + dx, y: orig.y + dy, w: orig.w, h: orig.h },
          currentView
        );
        byId.set(id, { x: roundPt(pdf.x), y: roundPt(pdf.y), w: 0, h: 0 });
      });
      applyObjects(
        objectsRef.current.map((o) =>
          byId.has(o.id)
            ? ({
                ...o,
                x: (byId.get(o.id) as { x: number }).x,
                y: (byId.get(o.id) as { y: number }).y,
              } as EditorObject)
            : o
        ),
        `move:${gesture.ids.length > 1 ? "grp" : gesture.ids[0]}`
      );
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
    } else {
      // Checkbox/radio widgets export as squares — keep the drag honest.
      const target = objectsRef.current.find((o) => o.id === gesture.id);
      if (
        target?.kind === "field" &&
        (target.fieldType === "checkbox" || target.fieldType === "radio")
      ) {
        const size = Math.max(min, Math.min(w, h));
        if (gesture.edge === "ne" || gesture.edge === "nw") {
          y = y + (h - size);
        }
        if (gesture.edge === "sw" || gesture.edge === "nw") {
          x = x + (w - size);
        }
        w = size;
        h = size;
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
    cancelLongPress();
    if (!gesture || !currentView || !pageDisp) {
      setGesture(null);
      setGuides([]);
      return;
    }
    if (gesture.type === "stroke") {
      const norm = normaliseDraw(gesture.pts);
      setGesture(null);
      if (norm) {
        const pdf = displayRectToPdf(norm.rect, currentView);
        const obj = makeDraw(selectedPage, pdf, norm.fracs);
        applyObjects([...objectsRef.current, obj], `add:${obj.id}`);
        setSelectedIds([obj.id]);
        setTool("select");
        if (mobileMode) setPropsOpen(true);
      }
      return;
    }
    if (gesture.type === "marquee") {
      const x0 = Math.min(gesture.x0, gesture.x1);
      const x1 = Math.max(gesture.x0, gesture.x1);
      const y0 = Math.min(gesture.y0, gesture.y1);
      const y1 = Math.max(gesture.y0, gesture.y1);
      const clicked = x1 - x0 < MARQUEE_MIN_PT && y1 - y0 < MARQUEE_MIN_PT;
      setGesture(null);
      let next: string[];
      if (clicked) {
        // Plain tap on empty canvas clears (shift keeps the current set).
        next = gesture.base;
      } else {
        const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        const hits = marqueeSelection(
          objectsRef.current,
          currentView,
          selectedPage,
          rect
        );
        next =
          gesture.base.length > 0
            ? [...new Set([...gesture.base, ...hits])]
            : hits;
      }
      setSelectedIds(next);
      if (mobileMode && next.length > 0 && editingId === null) {
        setPropsOpen(true);
      }
      return;
    }
    if (gesture.type === "rotate") {
      setGesture(null);
      return;
    }
    if (gesture.type === "move") {
      setGesture(null);
      setGuides([]);
      if (mobileMode && selectedIds.length > 0 && editingId === null) {
        setPropsOpen(true);
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
      } else if (gesture.kind === "field") {
        // Click = a default-size single-line text field (switch the type
        // and size it in the properties panel afterwards).
        disp = { x: gesture.x0, y: gesture.y0, w: 160, h: 20 };
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
        case "field":
          obj = makeField(selectedPage, pdf, takenFieldNames(objectsRef.current));
          break;
        default:
          obj = makeWhiteout(selectedPage, pdf);
          break;
      }
      applyObjects([...objectsRef.current, obj], `add:${obj.id}`);
      setSelectedIds([obj.id]);
      if (obj.kind === "text") {
        setEditingId(obj.id);
      } else if (mobileMode) {
        setPropsOpen(true);
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
    if (pointersRef.current.size >= 2) return; // pinch owns the canvas
    event.stopPropagation();
    if (event.shiftKey) {
      // P8.6: shift-click toggles this object in/out of the selection.
      setSelectedIds((prev) =>
        prev.includes(obj.id)
          ? prev.filter((sid) => sid !== obj.id)
          : [...prev, obj.id]
      );
      return;
    }
    if (!selectedIds.includes(obj.id)) {
      setSelectedIds([obj.id]);
    }
    if (obj.locked || editingId === obj.id) return;
    const handleEl = (event.target as HTMLElement).closest("[data-handle]");
    if (handleEl) {
      const edge = handleEl.getAttribute("data-handle");
      try {
        overlayRef.current?.setPointerCapture(event.pointerId);
      } catch {
        /* synthetic pointers */
      }
      if (edge === "rot") {
        // P8.6 rotation handle — the gesture tracks the angle around the
        // object's display center (Shift snaps to 15° steps).
        const disp = pdfRectToDisplay(obj, currentView);
        const pos = displayPos(event);
        setGesture({
          type: "rotate",
          id: obj.id,
          cx: disp.x + disp.w / 2,
          cy: disp.y + disp.h / 2,
          startAngle: displayAngle(pos, {
            x: disp.x + disp.w / 2,
            y: disp.y + disp.h / 2,
          }),
          startRotation: obj.rotation,
        });
        event.preventDefault();
        return;
      }
      const orig = pdfRectToDisplay(obj, currentView);
      const keepAspect = event.shiftKey && obj.kind === "image";
      setGesture({
        type: "resize",
        id: obj.id,
        edge: edge as HitEdge,
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
    // P8.6: multi-select drag — the union of every selected object moves.
    const ids = selectedIds.includes(obj.id) ? selectedIds : [obj.id];
    const targets = objectsRef.current.filter(
      (o) => ids.includes(o.id) && !o.locked && !o.hidden
    );
    if (targets.length === 0) {
      event.preventDefault();
      return;
    }
    const dispRects = targets.map((o) => pdfRectToDisplay(o, currentView));
    const union = unionRects(dispRects) ?? dispRects[0];
    const pos = displayPos(event);
    setGesture({
      type: "move",
      ids: targets.map((o) => o.id),
      grabDx: pos.x - union.x,
      grabDy: pos.y - union.y,
      origs: dispRects,
      union,
    });
    // P8.6: long-press opens the object menu on touch (canceled by move).
    if (coarseRef.current) {
      cancelLongPress();
      const start = { x: pos.x, y: pos.y };
      const client = { x: event.clientX, y: event.clientY };
      const id = obj.id;
      const timer = window.setTimeout(() => {
        longPressRef.current = null;
        setGesture(null);
        setMenu({ x: client.x, y: client.y, objId: id });
      }, LONG_PRESS_MS);
      longPressRef.current = { id, x: start.x, y: start.y, clientX: client.x, clientY: client.y, timer };
    }
    event.preventDefault();
  };

  const handleContextMenu = (obj: EditorObject) => (
    event: React.MouseEvent<HTMLDivElement>
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedIds.includes(obj.id)) setSelectedIds([obj.id]);
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
        duplicateSelected();
        return;
      }
      if (mod) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedIds.length > 0) {
          event.preventDefault();
          removeSelected();
        }
        return;
      }
      if (event.key === "Escape") {
        setSelectedIds([]);
        setMenu(null);
        setPropsOpen(false);
        return;
      }
      if (event.key.startsWith("Arrow") && selectedIds.length > 0) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        nudgeSelected(dx, dy);
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
        case "f":
          setTool("field");
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
    duplicateSelected,
    editingId,
    nudgeSelected,
    redo,
    removeSelected,
    selectedIds,
    signOpen,
    undo,
  ]);

  // --- P8.6: mobile mode + sheets ---------------------------------------------
  // Keep the raw coarse-pointer flag in a ref for the long-press path.
  useEffect(() => {
    coarseRef.current =
      typeof window !== "undefined" &&
      window.matchMedia("(pointer: coarse)").matches;
  }, []);
  // The properties sheet closes when the selection goes empty.
  useEffect(() => {
    if (selectedIds.length === 0) setPropsOpen(false);
  }, [selectedIds.length]);

  // --- P8.6: autosave drafts -----------------------------------------------------
  const draftKey = useMemo(
    () => (file ? draftKeyFor(file.name, file.size, file.lastModified) : null),
    [file]
  );
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const draftCheckedFor = useRef("");

  // On a freshly loaded document: offer a found draft (once per session).
  useEffect(() => {
    if (!viewsReady || !file || !draftKey || draftCheckedFor.current === fileId) {
      return;
    }
    draftCheckedFor.current = fileId;
    void (async () => {
      try {
        const found = await loadDraft(draftKey);
        if (!found) return;
        // R12: a draft carrying a page plan is only resumable when that
        // plan fits THIS document (every src inside the real page count,
        // within the workspace cap) — otherwise its objects could land on
        // the wrong pages; drop it honestly instead.
        if (found.pageViews !== undefined) {
          const valid =
            found.pageViews.length > 0 &&
            found.pageViews.length <= EDITOR_MAX_PAGES &&
            found.pageViews.every(
              (v) =>
                Number.isInteger(v.src) &&
                (v.src ?? 0) >= 0 &&
                (v.src ?? 0) < Math.max(1, srcPageCount)
            );
          if (!valid) {
            void deleteDraft(draftKey);
            return;
          }
        }
        setDraft(found);
      } catch {
        /* private mode / IDB unavailable — autosave silently off */
      }
    })();
  }, [viewsReady, file, draftKey, fileId, srcPageCount]);

  const resumeDraft = useCallback((): void => {
    if (!draft) return;
    setZoom(clampN(draft.zoom, 0.75, 3));
    const views = draft.pageViews;
    if (views !== undefined && views.length > 0) {
      // R12: restore the saved page plan WITH its objects as one undoable
      // step (normalize clamps srcs against the real page count again).
      const plan = normalizeViews(views, Math.max(1, srcPageCount));
      applyPageOp(
        [...objectsRef.current, ...draft.objects],
        plan,
        `draft:resume:${draft.savedAt}`,
        Math.min(draft.page, plan.length - 1)
      );
    } else {
      setSelectedPage(Math.min(draft.page, Math.max(0, pageCount - 1)));
      applyObjects(
        [...objectsRef.current, ...draft.objects],
        `draft:resume:${draft.savedAt}`
      );
    }
    setDraft(null);
    toast({ title: t("editPdf.draftRestored") });
  }, [applyObjects, applyPageOp, draft, pageCount, srcPageCount, t, toast]);

  const discardDraft = useCallback((): void => {
    setDraft(null);
    if (draftKey) void deleteDraft(draftKey);
  }, [draftKey]);

  // Debounced autosave — objects JSON + the R12 page plan (never file
  // bytes), skipped while the resume banner is up; any manual edit
  // dismisses the banner and takes over the draft slot.
  useEffect(() => {
    if (!viewsReady || !draftKey || !fileId) return;
    if (objects.length === 0) return;
    if (draft !== null) {
      setDraft(null);
      return;
    }
    const handle = window.setTimeout(() => {
      void saveDraft(
        draftKey,
        encodeDraft(
          objectsRef.current,
          selectedPage,
          zoom,
          viewsRef.current
        )
      );
    }, DRAFT_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [objects, selectedPage, zoom, viewsReady, draftKey, fileId, draft]);

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

  const marqueePreview = gesture?.type === "marquee" && pageDisp
    ? {
        left: `${(Math.min(gesture.x0, gesture.x1) / pageDisp.w) * 100}%`,
        top: `${(Math.min(gesture.y0, gesture.y1) / pageDisp.h) * 100}%`,
        width: `${(Math.abs(gesture.x1 - gesture.x0) / pageDisp.w) * 100}%`,
        height: `${(Math.abs(gesture.y1 - gesture.y0) / pageDisp.h) * 100}%`,
      }
    : null;

  const unionOutline = multiUnion && pageDisp
    ? {
        left: `${(multiUnion.x / pageDisp.w) * 100}%`,
        top: `${(multiUnion.y / pageDisp.h) * 100}%`,
        width: `${(multiUnion.w / pageDisp.w) * 100}%`,
        height: `${(multiUnion.h / pageDisp.h) * 100}%`,
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
            : tool === "field"
              ? "editPdf.hintField"
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

      {/* P8.6 autosave: a draft from a previous session on this file. */}
      {draft ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2.5 rounded-card border border-amber-300/60 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold">
              {t("editPdf.draftFoundTitle")}
            </p>
            <p className="mt-0.5 text-xs leading-relaxed">
              {t("editPdf.draftFoundHint")}
              {draftHasImages(draft)
                ? ` ${t("editPdf.draftImagesNote")}`
                : ""}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-11 rounded-btn sm:h-9"
              onClick={discardDraft}
            >
              {t("editPdf.draftDiscard")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-11 rounded-btn sm:h-9"
              onClick={resumeDraft}
            >
              {t("editPdf.draftResume")}
            </Button>
          </div>
        </div>
      ) : null}

      {!mobileMode ? (
        <EditorToolbar
          tool={tool}
          onTool={onTool}
          objectCount={objects.length}
        />
      ) : null}

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

          {/* R6-a (D): one-time discoverability pointer for the Edit text
              tool on mobile (the original complaint — nobody found it in
              the More sheet). Subtle, dismissible, once per install. */}
          {mobileMode && viewsReady && tool !== "edittext" && firstHint === null ? (
            <div className="flex items-start gap-2 rounded-card border border-border bg-card p-2.5">
              <Lightbulb
                className="mt-0.5 size-4 shrink-0 text-primary"
                aria-hidden="true"
              />
              <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
                {t("editPdf.firstHint")}
              </p>
              <button
                type="button"
                className="flex size-8 shrink-0 items-center justify-center rounded-btn text-muted-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                aria-label={t("editPdf.frClose")}
                onClick={dismissFirstHint}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          ) : null}

          {pageCount > 0 ? (
            <EditorPageStrip
              file={file}
              pageCount={pageCount}
              selected={selectedPage}
              onSelect={setSelectedPage}
              markedSet={touchedPages}
              rotOffsets={rotOffsets}
              planKey={planKey}
              opsDisabled={truncated}
              opsLocked={pageViews.length >= EDITOR_MAX_PAGES}
              cropMode={cropMode && canvasReady}
              cropDisabled={!canvasReady}
              onToggleCrop={toggleCropMode}
              onMove={movePage}
              onDelete={deletePage}
              onDuplicate={duplicatePage}
              onRotate={rotatePage}
            />
          ) : null}

          {base && !failed && pageDisp && currentView ? (() => {
            // P8.6: at zoom > 1 the page wrapper becomes a scrollable box
            // (pinch pan target) with an explicitly sized inner page so the
            // overlay keeps mapping 1:1 to the full canvas. At zoom ≤ 1 the
            // original fit-to-width layout is kept untouched.
            const zoomed = zoom > 1;
            const canvas = (
              <canvas
                className={zoomed ? "absolute inset-0 block h-full w-full" : "block max-w-full"}
                style={
                  zoomed
                    ? undefined
                    : { width: `${pageDisp.w * zoom}px` }
                }
                aria-label={t("editPdf.canvasLabel")}
                ref={(c) => {
                  (canvasRef as { current: HTMLCanvasElement | null }).current = c;
                  if (!c) return;
                  const ctx = c.getContext("2d");
                  if (!ctx) return;
                  c.width = base.bitmap.width;
                  c.height = base.bitmap.height;
                  ctx.drawImage(base.bitmap, 0, 0);
                }}
              />
            );
            const overlay = (
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
                onPointerDownCapture={trackPointerDown}
                onPointerMoveCapture={trackPointerMove}
                onPointerUpCapture={trackPointerEnd}
                onPointerCancelCapture={trackPointerEnd}
                onPointerDown={handleOverlayPointerDown}
                onPointerMove={handleOverlayPointerMove}
                onPointerUp={handleOverlayPointerUp}
                onPointerLeave={(event) => {
                  trackPointerEnd(event);
                  handleOverlayPointerUp();
                }}
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
                    selected={selectedIds.includes(obj.id)}
                    editing={editingId === obj.id}
                    rotationHandle={
                      selectedIds.length === 1 && isRotatable(obj)
                    }
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

                {/* P8.6: shared dashed outline around a multi-selection. */}
                {unionOutline ? (
                  <div
                    className="pointer-events-none absolute z-[5] border border-dashed border-primary/70"
                    style={unionOutline}
                    aria-hidden="true"
                  />
                ) : null}

                {/* P8.6: snap guide lines while dragging. */}
                <SnapGuides guides={guides} dispW={pageDisp.w} dispH={pageDisp.h} />

                {/* P8.3: click-to-edit existing text pieces. R13: the
                    buttons map piece USER rects through the CURRENT view —
                    correct on user-rotated slots too. */}
                {tool === "edittext" && piecesState === "ready" ? (
                  <TextPieceButtons
                    pieces={pieces}
                    dispW={pageDisp.w}
                    dispH={pageDisp.h}
                    view={currentView}
                    onPick={pickPiece}
                  />
                ) : null}

                {/* Live text editor — exact geometry of the text object.
                    R6-a: taps INSIDE the box stop propagation so the
                    overlay's marquee/deselect handler can't kill the edit
                    (caret repositioning + mobile keyboards stay alive). */}
                {editing && editing.kind === "text" ? (() => {
                  const disp = pdfRectToDisplay(editing, currentView);
                  return (
                  <>
                  <textarea
                    ref={textAreaRef}
                    value={editing.text}
                    onChange={(event) =>
                      patchObject(editing.id, { text: event.target.value }, true)
                    }
                    onBlur={(event) => {
                      // R6-a (B): interacting with the floating mini-toolbar
                      // (or its Radix portal, e.g. the font dropdown list)
                      // keeps the edit alive — only a real click outside
                      // closes it, matching Smallpdf.
                      const next = event.relatedTarget as HTMLElement | null;
                      if (
                        next &&
                        next.closest(
                          "[data-text-edit-bar], [data-radix-popper-content-wrapper]"
                        )
                      ) {
                        return;
                      }
                      endEdit();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
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
                  {/* R6-a (B): Smallpdf-style floating mini-toolbar just
                      above the box being edited — same state, no fork. */}
                  <TextEditBar
                    rect={disp}
                    dispW={pageDisp.w}
                    dispH={pageDisp.h}
                    scale={renderScale}
                    obj={editing}
                    onPatch={(patch) => patchObject(editing.id, patch)}
                    onDelete={() => removeObject(editing.id)}
                    editBoxRef={textAreaRef}
                  />
                  </>
                  );
                })() : null}

                {createPreview ? (
                  <div
                    className="pointer-events-none absolute border-2 border-primary bg-primary/10"
                    style={createPreview}
                    aria-hidden="true"
                  />
                ) : null}

                {/* P8.6: marquee rubber-band while dragging empty canvas. */}
                {marqueePreview ? (
                  <div
                    className="pointer-events-none absolute z-20 border border-dashed border-primary bg-primary/5"
                    style={marqueePreview}
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
            );
            // R15: the crop overlay — a SIBLING of the object overlay, never
            // a child of it: the overlay's gesture handlers capture every
            // pointerdown bubbling through them, which would eat the action
            // bar's clicks (caught live in the browser E2E). Keyed per page
            // so switching slots resets the frame.
            const cropLayer = cropMode ? (
              <CropOverlay
                key={fileId + selectedPage}
                dispW={pageDisp.w}
                dispH={pageDisp.h}
                minPt={MIN_CROP_PT}
                hadCrop={viewCrop(pageViews[selectedPage]) !== undefined}
                onApply={applyCropFromDisplay}
                onReset={resetCrop}
                onCancel={() => setCropMode(false)}
              />
            ) : null;
            if (zoomed) {
              return (
                <div
                  ref={zoomWrapRef}
                  className="mx-auto w-fit max-w-full overflow-auto rounded-card border border-border bg-card shadow-sm scrollbar-thin"
                >
                  <div
                    className="relative"
                    style={{
                      width: `${pageDisp.w * zoom}px`,
                      height: `${pageDisp.h * zoom}px`,
                    }}
                  >
                    {canvas}
                    {overlay}
                    {cropLayer}
                  </div>
                </div>
              );
            }
            return (
              <div
                ref={zoomWrapRef}
                className="relative mx-auto w-fit max-w-full overflow-hidden rounded-card border border-border bg-card shadow-sm"
              >
                {canvas}
                {overlay}
                {cropLayer}
              </div>
            );
          })() : (
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
            {cropMode
              ? t("editPdf.cropHint")
              : tool === "edittext" && piecesState === "loading"
                ? t("editPdf.pieceLoading")
                : t(toolHintKey)}
          </p>

          {/* R6-a (C): teach the click-to-edit gesture while pieces are live. */}
          {tool === "edittext" && piecesState === "ready" && !editHintDismissed ? (
            <div
              role="note"
              className="flex items-start gap-2 rounded-card border border-primary/30 bg-primary/5 p-2.5 text-primary dark:border-primary/40 dark:bg-primary/10"
            >
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <p className="min-w-0 flex-1 text-xs leading-relaxed">
                {t("editPdf.hintEditReady")}
              </p>
              <button
                type="button"
                className="flex size-8 shrink-0 items-center justify-center rounded-btn outline-none hover:bg-primary/10 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                aria-label={t("editPdf.frClose")}
                onClick={() => setEditHintDismissed(true)}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          ) : null}

          {tool === "edittext" && piecesState === "empty" ? (
            <div className="flex items-start gap-2.5 rounded-card border border-amber-300/60 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold">
                  {t("editPdf.noTextTitle")}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed">
                  {t("editPdf.noTextHint")}
                </p>
                {/* R6-a (C): real next step for scans — hand the SAME file
                    to OCR through the in-memory chain bridge. */}
                <Button
                  type="button"
                  size="sm"
                  className="mt-2.5 h-11 rounded-btn sm:h-9"
                  onClick={handOffToOcr}
                >
                  <ScanText className="size-4" aria-hidden="true" />
                  {t("editPdf.noTextOcrCta")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Right rail: properties + layers (desktop; mobile uses the sheet) */}
        {!mobileMode ? (
          <div className="flex w-full shrink-0 flex-col gap-3 lg:w-80">
            {selectedIds.length > 1 ? (
              <MultiSelectPanel
                count={selectedIds.length}
                locked={allSelectedLocked}
                onBringFront={() =>
                  applyObjects(
                    bringManyToFront(objectsRef.current, new Set(selectedIds)),
                    `zMany:${selectedIds.length}`
                  )
                }
                onSendBack={() =>
                  applyObjects(
                    sendManyToBack(objectsRef.current, new Set(selectedIds)),
                    `zMany:${selectedIds.length}`
                  )
                }
                onDuplicate={duplicateSelected}
                onDelete={removeSelected}
                onToggleLock={() => {
                  const next = !allSelectedLocked;
                  const ids = new Set(selectedIds);
                  applyObjects(
                    objectsRef.current.map((o) =>
                      ids.has(o.id) ? ({ ...o, locked: next } as EditorObject) : o
                    ),
                    `lockMany:${selectedIds.length}`
                  );
                }}
              />
            ) : (
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
                onDuplicate={duplicateSelected}
                onDelete={() => {
                  if (selectedId) removeObject(selectedId);
                }}
                onToggleLock={() => {
                  if (selected)
                    patchObject(selected.id, { locked: !selected.locked });
                }}
              />
            )}
            <LayersPanel
              objects={pageObjects}
              selectedId={selectedId}
              onSelect={(id) => setSelectedIds([id])}
              onPatch={patchObject}
              onRemove={removeObject}
            />
          </div>
        ) : null}
      </div>

      {/* P8.6 mobile: simplified bottom toolbar + More sheet + properties
          sheet (reuses the exact PropertiesPanel/LayersPanel components). */}
      {mobileMode ? (
        <MobileToolbar
          tool={tool}
          onTool={onTool}
          onMore={() => {
            setPropsOpen(false);
            setMoreOpen(true);
          }}
        />
      ) : null}

      {mobileMode ? (
        <MoreSheet
          open={moreOpen}
          onOpenChange={setMoreOpen}
          tool={tool}
          onTool={onTool}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={undo}
          onRedo={redo}
          canDuplicate={selectedIds.length > 0}
          onDuplicate={duplicateSelected}
          canDelete={selectedIds.length > 0}
          onDelete={removeSelected}
          zoom={zoom}
          onZoom={setZoom}
          onFindReplace={openFindReplace}
        />
      ) : null}

      {mobileMode ? (
        <BottomSheet
          open={propsOpen}
          onOpenChange={setPropsOpen}
          title={
            selectedIds.length > 1
              ? t("editPdf.multiTitle", { n: selectedIds.length })
              : t("editPdf.propertiesTitle")
          }
        >
          <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto pb-2 scrollbar-thin">
            {selectedIds.length > 1 ? (
              <MultiSelectPanel
                count={selectedIds.length}
                locked={allSelectedLocked}
                onBringFront={() =>
                  applyObjects(
                    bringManyToFront(objectsRef.current, new Set(selectedIds)),
                    `zMany:${selectedIds.length}`
                  )
                }
                onSendBack={() =>
                  applyObjects(
                    sendManyToBack(objectsRef.current, new Set(selectedIds)),
                    `zMany:${selectedIds.length}`
                  )
                }
                onDuplicate={duplicateSelected}
                onDelete={removeSelected}
                onToggleLock={() => {
                  const next = !allSelectedLocked;
                  const ids = new Set(selectedIds);
                  applyObjects(
                    objectsRef.current.map((o) =>
                      ids.has(o.id) ? ({ ...o, locked: next } as EditorObject) : o
                    ),
                    `lockMany:${selectedIds.length}`
                  );
                }}
              />
            ) : (
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
                onDuplicate={duplicateSelected}
                onDelete={() => {
                  if (selectedId) removeObject(selectedId);
                }}
                onToggleLock={() => {
                  if (selected)
                    patchObject(selected.id, { locked: !selected.locked });
                }}
              />
            )}
            <LayersPanel
              objects={pageObjects}
              selectedId={selectedId}
              onSelect={(id) => setSelectedIds([id])}
              onPatch={patchObject}
              onRemove={removeObject}
            />
          </div>
        </BottomSheet>
      ) : null}

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
              // R12: the match names a SOURCE page — jump to the first
              // workspace slot showing it.
              const target =
                workspacePositionsForSrc(pageViews, match.page)[0] ??
                match.page;
              setSelectedPage(Math.min(target, Math.max(0, pageCount - 1)));
              setFrOpen(false);
            }
          }}
          onClose={() => setFrOpen(false)}
        />
      ) : null}

      {menu ? (() => {
        // The menu acts on the whole selection when the target is part of
        // it (P8.6 multi-select), otherwise just the clicked object.
        const ids = selectedIds.includes(menu.objId) ? selectedIds : [menu.objId];
        const idSet = new Set(ids);
        const target = objects.find((o) => o.id === menu.objId);
        return (
          <EditorContextMenu
            state={menu}
            locked={idSet.size > 1 ? allSelectedLocked : target?.locked === true}
            onDuplicate={duplicateSelected}
            onBringFront={() =>
              applyObjects(
                ids.length > 1
                  ? bringManyToFront(objectsRef.current, idSet)
                  : bringToFront(objectsRef.current, menu.objId),
                `z:${menu.objId}`
              )
            }
            onSendBack={() =>
              applyObjects(
                ids.length > 1
                  ? sendManyToBack(objectsRef.current, idSet)
                  : sendToBack(objectsRef.current, menu.objId),
                `z:${menu.objId}`
              )
            }
            onToggleLock={() => {
              const next = !(target?.locked === true);
              applyObjects(
                objectsRef.current.map((o) =>
                  idSet.has(o.id) ? ({ ...o, locked: next } as EditorObject) : o
                ),
                `lock:${menu.objId}`
              );
            }}
            onDelete={() => {
              if (ids.length > 1) removeSelected();
              else removeObject(menu.objId);
            }}
            onClose={() => setMenu(null)}
          />
        );
      })() : null}
    </div>
  );
}

function cssFontOf(font: string): string {
  if (font === "times") return "'Times New Roman', Times, serif";
  if (font === "courier") return "'Courier New', Courier, monospace";
  if (font === "devanagari") return "'Noto Sans Devanagari', Arial, sans-serif";
  return "Arial, Helvetica, sans-serif";
}
