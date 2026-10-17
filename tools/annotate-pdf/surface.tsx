"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Loader2, TriangleAlert } from "lucide-react";

import { loadPdfjs } from "@/lib/pdf/pdfjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { getPdfPageCount, renderPdfThumbnail } from "@/lib/pdf/thumbnails";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { useI18n } from "@/components/providers/locale-provider";
import {
  PreviewFileHeader,
  PreviewPageStrip,
} from "../stamp-common/preview-parts";
import {
  AnnoHeader,
  AnnoToolbar,
  CommentsRail,
  NoteBubble,
  type AnnoToolId,
} from "./parts";
import {
  DEFAULT_COLOR,
  DEFAULT_OPACITY,
  HISTORY_LIMIT,
  buildMarkupFromDrag,
  clampN,
  displaySize,
  displayToPdfPoint,
  makeNote,
  noteDisplayPoint,
  pdfRectToDisplay,
  piecesFromItems,
  quadToDisplayRect,
  redoStep,
  roundPt,
  undoStep,
  type Annotation,
  type MarkupAnno,
  type MarkupKind,
  type NoteAnno,
  type PageView,
  type TextPiece,
} from "./model";

/**
 * Annotate PDF live surface (PRD §8.2 highlights / underlines /
 * strikeouts / sticky notes — the "editor core reuse" round).
 *
 * Layout: toolbar + canvas column (page strip, page render with the
 * annotation overlay) + right rail (comments list) — the rail stacks
 * below the canvas on mobile. Every edit lands in the options blob under
 * "a:<fileId>" (the redact epoch-key pattern) as { annos, pageViews };
 * the export worker reads only `annos` and turns them into REAL PDF
 * annotation objects.
 *
 * Highlights snap to the text: one pdf.js document stays open for the
 * session and every selected page's text items are harvested into
 * display-space pieces (viewport transform, rotation-safe) — the
 * drag → quads machinery in model.ts does the word-snapping. Pages
 * without selectable text (scans) get the honest translucent-box
 * fallback.
 */

const PREVIEW_MAX_DIM = 640;
const EDITOR_MAX_PAGES = 500;
const KEY_PREFIX = "a:";
const AKEY_ID = "akey";

interface AnnoBlob {
  annos: Annotation[];
  pageViews: PageView[];
}

type Gesture =
  | { type: "drag"; x0: number; y0: number; x1: number; y1: number }
  | { type: "noteMove"; id: string; grabDx: number; grabDy: number };

interface ViewportLike {
  transform: number[];
  viewBox: number[];
  rotation: number;
}

interface PageLike {
  getViewport: (params: { scale: number }) => ViewportLike;
  getTextContent: () => Promise<{ items: unknown[] }>;
  cleanup: () => void;
}

interface DocLike {
  numPages: number;
  getPage: (n: number) => Promise<PageLike>;
  destroy: () => Promise<void>;
}

/** Opens the pdf.js doc ONCE per session; views + text pieces come from it. */
async function openDoc(file: File): Promise<DocLike> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc: PDFDocumentProxy = await pdfjs.getDocument({
    data,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;
  return doc as unknown as DocLike;
}

/** Rebuilds the mirrored PageView from a pdf.js viewport (scale 1). */
function viewFromViewport(viewport: ViewportLike): PageView {
  const raw = viewport.viewBox ?? [0, 0, 612, 792];
  const r = ((viewport.rotation % 360) + 360) % 360;
  return {
    x0: raw[0],
    y0: raw[1],
    x1: raw[2],
    y1: raw[3],
    rotate: r === 90 || r === 180 || r === 270 ? r : 0,
  };
}

function parseBlob(raw: unknown): AnnoBlob {
  try {
    const parsed = JSON.parse(String(raw ?? "{}")) as Partial<AnnoBlob>;
    return {
      annos: Array.isArray(parsed.annos) ? (parsed.annos as Annotation[]) : [],
      pageViews: Array.isArray(parsed.pageViews)
        ? (parsed.pageViews as PageView[])
        : [],
    };
  } catch {
    return { annos: [], pageViews: [] };
  }
}

export function AnnotateSurface(
  props: ToolSurfaceProps
): React.JSX.Element | null {
  const { files, values, onChange, setRunBlocked } = props;
  const { t } = useI18n();
  const { toast } = useToast();
  const file = files.length > 0 ? files[0].file : null;
  const fileId = files.length > 0 ? files[0].id : "";

  // --- Options blob ("a:<fileId>") --------------------------------------
  const blobKey = `${KEY_PREFIX}${fileId}`;
  const blob = useMemo<AnnoBlob>(
    () => parseBlob(values[blobKey]),
    [values, blobKey]
  );
  const annos = blob.annos;
  const pageViews = blob.pageViews;

  // Live mirror — written ONLY inside handlers/effects, never during
  // render (successive mutations in one tick see the latest array).
  const annosRef = useRef<Annotation[]>([]);

  const commit = useCallback(
    (nextAnnos: Annotation[], views?: PageView[]): void => {
      const nextViews = views ?? pageViews;
      onChange(
        blobKey,
        JSON.stringify({ annos: nextAnnos, pageViews: nextViews })
      );
    },
    [blobKey, onChange, pageViews]
  );

  // Point the worker at this document's blob.
  useEffect(() => {
    if (fileId !== "") onChange(AKEY_ID, fileId);
  }, [fileId, onChange]);

  // --- History (undo/redo snapshot stack, coalesced) ---------------------
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

  const applyAnnos = useCallback(
    (next: Annotation[], groupKey: string, history = true): void => {
      if (history) {
        const h = histRef.current;
        const now = Date.now();
        if (h.lastKey === groupKey && now - h.lastAt < 800) {
          h.lastAt = now;
        } else {
          h.past = [...h.past, JSON.stringify(annosRef.current)].slice(
            -HISTORY_LIMIT
          );
          h.future = [];
          h.lastKey = groupKey;
          h.lastAt = now;
        }
        syncLens();
      }
      annosRef.current = next;
      commit(next);
    },
    [commit, syncLens]
  );

  const undo = useCallback((): void => {
    const current = JSON.stringify(annosRef.current);
    const step = undoStep(histRef.current.past, histRef.current.future, current);
    if (step.snapshot === null) return;
    histRef.current.past = step.past;
    histRef.current.future = step.future;
    histRef.current.lastKey = "";
    histRef.current.lastAt = 0;
    const restored = JSON.parse(step.snapshot) as Annotation[];
    annosRef.current = restored;
    commit(restored);
    syncLens();
  }, [commit, syncLens]);

  const redo = useCallback((): void => {
    const current = JSON.stringify(annosRef.current);
    const step = redoStep(histRef.current.past, histRef.current.future, current);
    if (step.snapshot === null) return;
    histRef.current.past = step.past;
    histRef.current.future = step.future;
    histRef.current.lastKey = "";
    histRef.current.lastAt = 0;
    const restored = JSON.parse(step.snapshot) as Annotation[];
    annosRef.current = restored;
    commit(restored);
    syncLens();
  }, [commit, syncLens]);

  const canUndo = histLens.past > 0;
  const canRedo = histLens.future > 0;

  // --- Document state -----------------------------------------------------
  const [pageCount, setPageCount] = useState(0);
  const [selectedPage, setSelectedPage] = useState(0);
  const [pageError, setPageError] = useState<"password" | "corrupt" | null>(
    null
  );
  const [viewsReady, setViewsReady] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [base, setBase] = useState<{
    bitmap: ImageBitmap;
    dispW: number;
    dispH: number;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const docRef = useRef<DocLike | null>(null);
  const piecesRef = useRef<Map<number, TextPiece[]>>(new Map());
  const [pieces, setPieces] = useState<TextPiece[]>([]);
  const [piecesReady, setPiecesReady] = useState(false);
  const viewToken = useRef(0);

  // Load: page count + one open pdf.js doc → views, then reset the blob.
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
      setPieces([]);
      setPiecesReady(false);
      piecesRef.current.clear();
      try {
        await docRef.current?.destroy();
      } catch {
        /* stale doc already gone */
      }
      docRef.current = null;
      const count = await getPdfPageCount(file);
      if (cancelled || viewToken.current !== token) return;
      setPageCount(count);
      setTruncated(count > EDITOR_MAX_PAGES);
      const doc = await openDoc(file);
      if (cancelled || viewToken.current !== token) {
        void doc.destroy();
        return;
      }
      docRef.current = doc;
      const readable = Math.min(doc.numPages, EDITOR_MAX_PAGES);
      const views: PageView[] = [];
      for (let p = 1; p <= readable; p += 1) {
        const page = await doc.getPage(p);
        views.push(viewFromViewport(page.getViewport({ scale: 1 })));
        page.cleanup();
      }
      if (cancelled || viewToken.current !== token) return;
      annosRef.current = [];
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
    // NOTE: commit/syncLens are intentionally outside the deps — commit's
    // identity changes as the blob does, which must NOT re-run this load
    // (edit-pdf pattern).
  }, [file]);

  // Destroy the pdf.js doc when the surface unmounts.
  useEffect(() => {
    return () => {
      const doc = docRef.current;
      docRef.current = null;
      if (doc) void doc.destroy().catch(() => undefined);
    };
  }, []);

  const currentView =
    pageViews.length > 0
      ? pageViews[Math.min(selectedPage, pageViews.length - 1)]
      : null;
  const pageDisp = useMemo(
    () => (currentView ? displaySize(currentView) : null),
    [currentView]
  );

  // --- Text pieces for the selected page (drag → quads needs them) --------
  useEffect(() => {
    if (!viewsReady || !docRef.current) return;
    const doc = docRef.current;
    const cached = piecesRef.current.get(selectedPage);
    if (cached) {
      setPieces(cached);
      setPiecesReady(true);
      return;
    }
    let cancelled = false;
    setPiecesReady(false);
    void (async () => {
      try {
        const page = await doc.getPage(selectedPage + 1);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const next = piecesFromItems(viewport.transform, content.items);
        page.cleanup();
        if (cancelled) return;
        piecesRef.current.set(selectedPage, next);
        setPieces(next);
      } catch {
        if (!cancelled) setPieces([]);
      } finally {
        if (!cancelled) setPiecesReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPage, viewsReady]);

  // --- Page preview render -------------------------------------------------
  useEffect(() => {
    if (!file || pageCount === 0 || !pageDisp) return;
    let cancelled = false;
    void (async () => {
      const thumb = await renderPdfThumbnail(file, {
        pageIndex: selectedPage,
        maxDim: Math.min(2800, Math.round(PREVIEW_MAX_DIM * zoom * 2)),
      });
      if (cancelled) return;
      const bitmap = await createImageBitmap(thumb.blob);
      if (cancelled) return;
      setFailed(false);
      setBase({ bitmap, dispW: pageDisp.w, dispH: pageDisp.h });
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [file, pageCount, selectedPage, zoom, pageDisp]);

  // Actual rendered page width is not needed — every overlay child is
  // percentage-positioned, so no render-scale tracking is required.

  // --- Selection + tools ----------------------------------------------------
  const [tool, setTool] = useState<AnnoToolId>("highlight");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [opacity, setOpacity] = useState(DEFAULT_OPACITY);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Suppresses the marker click that follows a completed note drag. */
  const noteDraggedRef = useRef(false);

  const pageAnnos = useMemo(
    () => annos.filter((a) => a.page === selectedPage),
    [annos, selectedPage]
  );
  const editingNote = useMemo(
    () =>
      editingNoteId !== null
        ? (annos.find(
            (a) => a.id === editingNoteId && a.kind === "note"
          ) as NoteAnno | undefined) ?? null
        : null,
    [annos, editingNoteId]
  );
  const touchedPages = useMemo(
    () => new Set(annos.map((a) => a.page)),
    [annos]
  );

  const runGated = !viewsReady || pageError !== null;
  useEffect(() => {
    setRunBlocked(
      runGated ? "ann.notReady" : annos.length === 0 ? "ann.noAnnos" : null
    );
  }, [runGated, annos.length, setRunBlocked]);

  // --- Annotation actions -----------------------------------------------------
  const patchAnno = useCallback(
    (id: string, patch: Partial<Annotation>, history = true): void => {
      applyAnnos(
        annosRef.current.map((a) =>
          a.id === id ? ({ ...a, ...patch } as Annotation) : a
        ),
        `patch:${id}`,
        history
      );
    },
    [applyAnnos]
  );

  const removeAnno = useCallback(
    (id: string): void => {
      applyAnnos(
        annosRef.current.filter((a) => a.id !== id),
        `remove:${id}`
      );
      if (selectedId === id) setSelectedId(null);
      if (editingNoteId === id) setEditingNoteId(null);
    },
    [applyAnnos, selectedId, editingNoteId]
  );

  // Recolour / re-opacity the selected annotation when the controls move.
  const onColor = useCallback(
    (next: string): void => {
      setColor(next);
      if (selectedId !== null) patchAnno(selectedId, { color: next });
    },
    [patchAnno, selectedId]
  );

  const onOpacity = useCallback(
    (next: number): void => {
      setOpacity(next);
      if (selectedId !== null) patchAnno(selectedId, { opacity: next });
    },
    [patchAnno, selectedId]
  );

  const commitNoteBlur = useCallback((): void => {
    const note = annosRef.current.find(
      (a) => a.id === editingNoteId
    ) as NoteAnno | undefined;
    if (note && note.kind === "note" && note.text.trim().length === 0) {
      // An empty note never survives blur.
      applyAnnos(
        annosRef.current.filter((a) => a.id !== editingNoteId),
        `remove:${editingNoteId}`
      );
    }
    setEditingNoteId(null);
  }, [applyAnnos, editingNoteId]);

  // Leaving the page / switching tools commits the open note bubble.
  // NOTE: commitNoteBlur is intentionally outside the deps.
  useEffect(() => {
    if (editingNoteId !== null) commitNoteBlur();
  }, [selectedPage, tool]);

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
    const pos = displayPos(event);
    if (tool === "select") {
      setSelectedId(null);
      if (editingNoteId !== null) commitNoteBlur();
      return;
    }
    if (tool === "note") {
      const note = makeNote(
        selectedPage,
        pos.x,
        pos.y,
        currentView,
        color,
        Date.now()
      );
      applyAnnos([...annosRef.current, note], `add:${note.id}`);
      setSelectedId(note.id);
      setEditingNoteId(note.id);
      event.preventDefault();
      return;
    }
    // Markup tools: drag a band over the text.
    try {
      overlayRef.current?.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic pointers */
    }
    setSelectedId(null);
    if (editingNoteId !== null) commitNoteBlur();
    setGesture({ type: "drag", x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y });
    event.preventDefault();
  };

  const handleOverlayPointerMove = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    if (!gesture || !pageDisp || !currentView) return;
    const pos = displayPos(event);
    if (gesture.type === "drag") {
      setGesture({ ...gesture, x1: pos.x, y1: pos.y });
      return;
    }
    const note = annosRef.current.find(
      (a) => a.id === gesture.id
    ) as NoteAnno | undefined;
    if (!note || note.kind !== "note") {
      setGesture(null);
      return;
    }
    const nx = clampN(pos.x - gesture.grabDx, 0, pageDisp.w);
    const ny = clampN(pos.y - gesture.grabDy, 0, pageDisp.h);
    const anchor = displayToPdfPoint(nx, ny, currentView);
    patchAnno(
      gesture.id,
      { x: roundPt(anchor.x), y: roundPt(anchor.y) } as Partial<Annotation>
    );
  };

  const handleOverlayPointerUp = (): void => {
    if (!gesture || !currentView) {
      setGesture(null);
      return;
    }
    if (gesture.type === "drag") {
      const x0 = Math.min(gesture.x0, gesture.x1);
      const x1 = Math.max(gesture.x0, gesture.x1);
      const y0 = Math.min(gesture.y0, gesture.y1);
      const y1 = Math.max(gesture.y0, gesture.y1);
      setGesture(null);
      if (x1 - x0 < 4 && y1 - y0 < 4) return; // a stray click, not a drag
      const anno = buildMarkupFromDrag(
        selectedPage,
        { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
        pieces,
        currentView,
        tool as MarkupKind,
        color,
        opacity,
        Date.now()
      );
      if (anno) {
        applyAnnos([...annosRef.current, anno], `add:${anno.id}`);
        setSelectedId(anno.id);
        if (anno.fallback) {
          toast({ title: t("ann.scannedToast") });
        }
      }
      return;
    }
    setGesture(null);
  };

  const handleNotePointerDown = (note: NoteAnno) => (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    if (!base || !currentView || event.button !== 0) return;
    event.stopPropagation();
    noteDraggedRef.current = false;
    setSelectedId(note.id);
    if (tool === "note") {
      if (editingNoteId !== null && editingNoteId !== note.id) commitNoteBlur();
      setEditingNoteId(note.id);
      event.preventDefault();
      return;
    }
    if (tool !== "select" || editingNoteId === note.id) return;
    try {
      overlayRef.current?.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic pointers */
    }
    const pos = displayPos(event);
    const anchor = noteDisplayPoint(note, currentView);
    setGesture({
      type: "noteMove",
      id: note.id,
      grabDx: pos.x - anchor.x,
      grabDy: pos.y - anchor.y,
    });
    event.preventDefault();
  };

  // --- Keyboard shortcuts -----------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      const inField = tag === "TEXTAREA" || tag === "INPUT";
      if (editingNoteId !== null && inField) {
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
      if (mod) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedId !== null) {
          event.preventDefault();
          removeAnno(selectedId);
        }
        return;
      }
      if (event.key === "Escape") {
        setSelectedId(null);
        if (editingNoteId !== null) commitNoteBlur();
        return;
      }
      switch (key) {
        case "v":
          setTool("select");
          break;
        case "h":
          setTool("highlight");
          break;
        case "u":
          setTool("underline");
          break;
        case "s":
          setTool("strikeout");
          break;
        case "n":
          setTool("note");
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
    commitNoteBlur,
    editingNoteId,
    redo,
    removeAnno,
    selectedId,
    undo,
  ]);

  // --- Guards -----------------------------------------------------------------
  if (!file) return null;

  if (pageError === "password") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-card border border-border bg-card p-8 text-center">
        <TriangleAlert className="size-8 text-amber-500" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">
          {t("ann.passwordProtected")}
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          {t("ann.passwordHint")}
        </p>
      </div>
    );
  }

  if (pageError === "corrupt") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-card border border-border bg-card p-8 text-center">
        <TriangleAlert className="size-8 text-amber-500" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">
          {t("ann.corruptTitle")}
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          {t("ann.corruptHint")}
        </p>
      </div>
    );
  }

  const dragPreview =
    gesture?.type === "drag" && pageDisp
      ? {
          left: `${(Math.min(gesture.x0, gesture.x1) / pageDisp.w) * 100}%`,
          top: `${(Math.min(gesture.y0, gesture.y1) / pageDisp.h) * 100}%`,
          width: `${(Math.abs(gesture.x1 - gesture.x0) / pageDisp.w) * 100}%`,
          height: `${(Math.abs(gesture.y1 - gesture.y0) / pageDisp.h) * 100}%`,
        }
      : null;

  const hintKey =
    tool === "select"
      ? "ann.hintSelect"
      : tool === "note"
        ? "ann.hintNote"
        : piecesReady && pieces.length === 0
          ? "ann.hintNoText"
          : "ann.hintHighlight";

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
            {t("ann.truncated", { pages: EDITOR_MAX_PAGES })}
          </p>
        </div>
      ) : null}

      <AnnoToolbar
        tool={tool}
        onTool={setTool}
        annoCount={annos.length}
        color={color}
        onColor={onColor}
        opacity={opacity}
        onOpacity={onOpacity}
      />

      <div className="flex flex-col gap-3 lg:flex-row">
        {/* Canvas column */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <AnnoHeader
            page={selectedPage}
            pages={pageCount}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
            zoom={zoom}
            onZoom={setZoom}
            markedCount={pageAnnos.length}
          />

          {pageCount > 1 ? (
            <PreviewPageStrip
              file={file}
              pageCount={Math.min(pageCount, EDITOR_MAX_PAGES)}
              selected={selectedPage}
              onSelect={setSelectedPage}
              markedSet={touchedPages}
            />
          ) : null}

          {base && !failed && pageDisp && currentView ? (
            <div className="relative mx-auto w-fit max-w-full overflow-hidden rounded-card border border-border bg-card shadow-sm">
              <canvas
                className="block max-w-full"
                style={{ width: `${pageDisp.w * zoom}px` }}
                aria-label={t("ann.canvasLabel")}
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
                      : tool === "note"
                        ? "copy"
                        : "crosshair",
                }}
                onPointerDown={handleOverlayPointerDown}
                onPointerMove={handleOverlayPointerMove}
                onPointerUp={handleOverlayPointerUp}
                onPointerLeave={handleOverlayPointerUp}
                onContextMenu={(event) => event.preventDefault()}
                role="presentation"
              >
                {/* Markups: purely visual bands + an invisible selection
                    hit-area over the union rect (clicks select). */}
                {pageAnnos.map((anno) => {
                  if (anno.kind === "note") return null;
                  const m = anno as MarkupAnno;
                  const bands = m.fallback
                    ? [pdfRectToDisplay(m.rect, currentView)]
                    : m.quads.map((q) => quadToDisplayRect(q, currentView));
                  const hit = pdfRectToDisplay(m.rect, currentView);
                  const isSel = selectedId === m.id;
                  return (
                    <div key={m.id} className="pointer-events-none absolute inset-0">
                      {bands.map((band, i) => {
                        const base: React.CSSProperties = {
                          left: `${(band.x / pageDisp.w) * 100}%`,
                          top: `${(band.y / pageDisp.h) * 100}%`,
                          width: `${(band.w / pageDisp.w) * 100}%`,
                          height: `${(band.h / pageDisp.h) * 100}%`,
                        };
                        const selCls = isSel
                          ? "outline outline-2 outline-offset-1 outline-foreground"
                          : "";
                        if (m.kind === "underline") {
                          const th = Math.max(1.5, band.h * 0.08);
                          return (
                            <div
                              key={i}
                              className={selCls}
                              style={{
                                ...base,
                                top: `${((band.y + band.h - th) / pageDisp.h) * 100}%`,
                                height: `${(th / pageDisp.h) * 100}%`,
                                backgroundColor: m.color,
                              }}
                            />
                          );
                        }
                        if (m.kind === "strikeout") {
                          const th = Math.max(1.5, band.h * 0.08);
                          return (
                            <div
                              key={i}
                              className={selCls}
                              style={{
                                ...base,
                                top: `${((band.y + band.h / 2 - th / 2) / pageDisp.h) * 100}%`,
                                height: `${(th / pageDisp.h) * 100}%`,
                                backgroundColor: m.color,
                              }}
                            />
                          );
                        }
                        return (
                          <div
                            key={i}
                            className={`rounded-[2px] ${selCls}`}
                            style={{
                              ...base,
                              backgroundColor: m.color,
                              opacity: m.opacity,
                            }}
                          />
                        );
                      })}
                      <button
                        type="button"
                        className="absolute cursor-default bg-transparent"
                        style={{
                          left: `${(hit.x / pageDisp.w) * 100}%`,
                          top: `${(hit.y / pageDisp.h) * 100}%`,
                          width: `${(hit.w / pageDisp.w) * 100}%`,
                          height: `${(Math.max(hit.h, 14) / pageDisp.h) * 100}%`,
                        }}
                        onClick={() => {
                          if (tool === "select") setSelectedId(m.id);
                        }}
                        aria-label={
                          m.text.length > 0 ? m.text : t("ann.kindHighlight")
                        }
                        tabIndex={tool === "select" ? 0 : -1}
                      />
                    </div>
                  );
                })}

                {/* Notes: draggable sticky-note markers. */}
                {pageAnnos.map((anno) => {
                  if (anno.kind !== "note") return null;
                  const note = anno as NoteAnno;
                  const pt = noteDisplayPoint(note, currentView);
                  const isSel = selectedId === note.id;
                  return (
                    <div
                      key={note.id}
                      role="button"
                      tabIndex={0}
                      className="absolute z-10 flex size-11 -translate-x-1/2 -translate-y-1/2 cursor-pointer touch-manipulation items-center justify-center rounded-full outline-none transition-transform hover:scale-110 focus-visible:ring-[3px] focus-visible:ring-ring/50 md:size-9"
                      style={{
                        left: `${(pt.x / pageDisp.w) * 100}%`,
                        top: `${(pt.y / pageDisp.h) * 100}%`,
                        backgroundColor: note.color,
                        opacity: 0.92,
                      }}
                      onPointerDown={handleNotePointerDown(note)}
                      onPointerMove={() => {
                        if (gesture?.type === "noteMove") noteDraggedRef.current = true;
                      }}
                      onClick={() => {
                        if (tool === "select" && noteDraggedRef.current) {
                          noteDraggedRef.current = false;
                          return;
                        }
                        if (tool === "select") {
                          setSelectedId(note.id);
                          setEditingNoteId(note.id);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedId(note.id);
                          setEditingNoteId(note.id);
                        }
                      }}
                      aria-label={`${t("ann.kindNote")}: ${note.text.slice(0, 60)}`}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className="size-5 text-black/70"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                      {isSel ? (
                        <span className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-foreground" />
                      ) : null}
                    </div>
                  );
                })}

                {/* Live drag preview (markup tools). */}
                {dragPreview ? (
                  <div
                    className="pointer-events-none absolute border-2 border-dashed"
                    style={{
                      ...dragPreview,
                      borderColor: color,
                      backgroundColor: `${color}33`,
                    }}
                    aria-hidden="true"
                  />
                ) : null}

                {/* Sticky-note popup bubble. */}
                {editingNote && pageDisp ? (
                  <NoteBubble
                    note={editingNote}
                    value={editingNote.text}
                    onChange={(next) =>
                      patchAnno(editingNote.id, {
                        text: next,
                      } as Partial<Annotation>)
                    }
                    onClose={commitNoteBlur}
                    leftPct={
                      (noteDisplayPoint(editingNote, currentView).x /
                        pageDisp.w) *
                      100
                    }
                    topPct={
                      (noteDisplayPoint(editingNote, currentView).y /
                        pageDisp.h) *
                      100
                    }
                  />
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center rounded-card border border-border bg-card">
              {failed ? (
                <p className="text-xs text-muted-foreground">
                  {t("ann.renderError")}
                </p>
              ) : (
                <>
                  <Loader2
                    className="size-5 animate-spin text-primary"
                    aria-hidden="true"
                  />
                  <span className="sr-only">{t("ann.loading")}</span>
                </>
              )}
            </div>
          )}

          <p className="text-xs leading-relaxed text-muted-foreground">
            {t(hintKey)}
          </p>
        </div>

        {/* Right rail: comments list */}
        <div className="flex w-full shrink-0 flex-col gap-3 lg:w-80">
          <CommentsRail
            annos={annos}
            selectedId={selectedId}
            onSelect={(id, page) => {
              setSelectedId(id);
              if (page !== selectedPage) setSelectedPage(page);
            }}
            onEditNote={(id) => {
              setSelectedId(id);
              setEditingNoteId(id);
              const anno = annos.find((a) => a.id === id);
              if (anno && anno.page !== selectedPage)
                setSelectedPage(anno.page);
            }}
            onDelete={removeAnno}
          />
        </div>
      </div>
    </div>
  );
}
