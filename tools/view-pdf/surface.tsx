"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
} from "pdfjs-dist";
import type { TextLayer as PdfTextLayer } from "pdfjs-dist";
import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  Download,
  FileText,
  Keyboard,
  List,
  ListTree,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Moon,
  PanelLeft,
  Presentation,
  Printer,
  RotateCw,
  Rows3,
  Search,
  Share2,
  Square,
  StretchHorizontal,
  TriangleAlert,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { PDF_DOC_PARAMS, loadPdfjs } from "@/lib/pdf/pdfjs";
import { formatBytes } from "@/lib/storage/recent-files";
import { cn } from "@/lib/utils";

/**
 * View PDF live surface (PRD §6.5) — a full viewer rendered right in the
 * ToolShell workspace. Everything happens on-device with the self-hosted
 * pdf.js: lazy page rendering (only pages near the viewport stay in
 * memory), a selectable text layer, full-text search with on-page
 * highlight boxes, thumbnails + outline sidebar (the outline tab is
 * HIDDEN entirely when the document has no bookmarks — no empty-state
 * noise), zoom 25-400% with fit-width / fit-page, single-page and
 * two-page spread, 90° view rotation, a dark reading mode and a
 * presentation mode (one fitted page at a time, fullscreen with a
 * fixed-overlay fallback, arrow/click advance, auto-hiding controls).
 * Printing and downloading act on the ORIGINAL file bytes; the password
 * prompt for encrypted files is resolved entirely in the browser.
 */

/* ------------------------------ constants ------------------------------ */

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
];
/** Sidebar thumbnail max edge (CSS px, before DPR). */
const THUMB_MAX_DIM = 108;
/** Page paddings inside the scroll column (per side). */
const VIEWPORT_PADDING = 24;
const SPREAD_GAP = 12;
/** Presentation controls hide after this much mouse silence (ms). */
const PRES_CONTROLS_HIDE_MS = 2500;
/** Breathing room around the fitted page inside the presentation stage. */
const PRES_STAGE_PADDING = 28;

type LayoutMode = "continuous" | "single" | "spread";
type ZoomMode = "fit-width" | "fit-page" | number;
type DocStatus = "loading" | "ready" | "password" | "error";

/** One search hit: the matched range inside one text item. */
interface SearchMatch {
  id: number;
  pageIndex: number;
  itemIndex: number;
  start: number;
  end: number;
  context: string;
}

/** Flattened outline row (bookmarks keep their nesting depth). */
interface OutlineRow {
  title: string;
  page: number;
  depth: number;
}

/** Display geometry of one text item, in device px at the current scale. */
interface ItemBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One text item's geometry, keyed by its ORIGINAL pdf.js items[] index
 *  (search matches index the raw array — skipped/empty items must not
 *  compact the numbering or matches point at the wrong item). */
interface GeoItem extends ItemBox {
  itemIndex: number;
  str: string;
}

interface HighlightBox extends ItemBox {
  matchId: number;
}

/* --------------------------- geometry helpers -------------------------- */

/** Display size (px at `scale`) of a page with the viewer rotation applied.
 *  `base` is the UNROTATED media size + the page's native /Rotate. */
function displaySize(
  base: { w: number; h: number; rot: number },
  scale: number,
  rotation: number
): { w: number; h: number } {
  const swap = (base.rot + rotation) % 180 === 90;
  const w = (swap ? base.h : base.w) * scale;
  const h = (swap ? base.w : base.h) * scale;
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function nextZoomStep(current: number, dir: 1 | -1): number {
  if (dir === 1) {
    for (const step of ZOOM_STEPS) {
      if (step > current + 0.001) return step;
    }
    return MAX_ZOOM;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    if (ZOOM_STEPS[i] < current - 0.001) return ZOOM_STEPS[i];
  }
  return MIN_ZOOM;
}

/* ------------------------------ ViewerPage ----------------------------- */

interface ViewerPageProps {
  pageNumber: number;
  docRef: React.RefObject<PDFDocumentProxy | null>;
  /** Bumped whenever a new document is opened (forces full re-render). */
  docEpoch: number;
  scale: number;
  rotation: number;
  /** Page media size at scale 1 (rotation 0) + native /Rotate — sizes
   *  the slot, which is the layout authority. */
  base: { w: number; h: number; rot: number };
  dark: boolean;
  /** Search matches that live on THIS page (sorted by item). */
  matches: SearchMatch[];
  activeMatchId: number | null;
  /** Register the page slot element for scroll math (stable callback). */
  registerSlot: (page: number, el: HTMLElement | null) => void;
  /** Element that clips + scrolls the pages (IntersectionObserver root). */
  scrollRootRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * One lazily rendered page: an IntersectionObserver keeps it mounted only
 * while it is near the viewport (about ±2 pages at typical zooms); the
 * canvas + text layer are rebuilt whenever scale/rotation/doc change.
 */
function ViewerPage({
  pageNumber,
  docRef,
  docEpoch,
  scale,
  rotation,
  base,
  dark,
  matches,
  activeMatchId,
  registerSlot,
  scrollRootRef,
}: ViewerPageProps): React.JSX.Element {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerHostRef = useRef<HTMLDivElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  /** Text-item geometry of the last completed render (device px, this scale). */
  const [geo, setGeo] = useState<{
    items: GeoItem[];
    renderKey: string;
  } | null>(null);
  const renderKey = `${docEpoch}:${scale.toFixed(4)}:${rotation}`;
  /** The slot is the layout authority: exact display px at this scale. */
  const disp = displaySize(base, scale, rotation);

  const setSlotRef = useCallback(
    (el: HTMLDivElement | null) => {
      slotRef.current = el;
      registerSlot(pageNumber, el);
    },
    [pageNumber, registerSlot]
  );

  // Lazy mount/unmount near the viewport (PRD §6.5 "visible ±2 pages").
  useEffect(() => {
    const slot = slotRef.current;
    const root = scrollRootRef.current;
    if (!slot || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setVisible(entry.isIntersecting);
      },
      { root, rootMargin: "200% 0px 200% 0px" }
    );
    observer.observe(slot);
    return () => observer.disconnect();
  }, [scrollRootRef]);

  // Canvas + text layer render. Cancelled through the `cancelled` flag +
  // renderTask.cancel() whenever deps change or the page unmounts.
  useEffect(() => {
    if (!visible) return;
    const doc = docRef.current;
    if (!doc) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null =
      null;
    let textLayer: PdfTextLayer | null = null;
    const key = renderKey;

    void (async () => {
      const pdfjs = await loadPdfjs();
      const page: PDFPageProxy = await doc.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({
        scale,
        rotation: (page.rotate + rotation) % 360,
      });

      const canvas = canvasRef.current;
      if (canvas) {
        const dpr = Math.min(
          typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
          2
        );
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.style.width = `${Math.max(1, Math.round(viewport.width))}px`;
        canvas.style.height = `${Math.max(1, Math.round(viewport.height))}px`;
        const context = canvas.getContext("2d");
        if (context) {
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
          const task = page.render({
            canvasContext: context,
            viewport,
            transform,
          });
          renderTask = task;
          await task.promise;
          if (cancelled) return;
        }
      }

      // Text content: geometry for search highlights + the TextLayer.
      // itemIndex keys stay aligned with the RAW content.items order.
      const content = await page.getTextContent();
      if (cancelled) return;
      const items: GeoItem[] = [];
      for (let i = 0; i < content.items.length; i += 1) {
        const raw = content.items[i] as {
          str?: unknown;
          width?: unknown;
          transform?: unknown;
        };
        if (typeof raw.str !== "string" || raw.str.length === 0) continue;
        if (!Array.isArray(raw.transform) || typeof raw.width !== "number") {
          continue;
        }
        const tx = pdfjs.Util.transform(
          viewport.transform,
          raw.transform as number[]
        );
        items.push({
          itemIndex: i,
          str: raw.str,
          left: tx[4],
          top: tx[5],
          width: raw.width * viewport.scale,
          height: Math.hypot(tx[2], tx[3]),
        });
      }
      setGeo({ items, renderKey: key });

      // Selectable text layer (PRD §6.5 "text select aur copy").
      const host = textLayerHostRef.current;
      if (host) {
        host.replaceChildren();
        host.style.setProperty("--scale-factor", String(viewport.scale));
        const layer = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container: host,
          viewport,
        });
        textLayer = layer;
        await layer.render();
        if (cancelled) return;
      }
    })().catch((error: unknown) => {
      const name =
        error !== null && typeof error === "object" && "name" in error
          ? String((error as { name: unknown }).name)
          : "";
      // Cancelled renders resolve quietly; real failures surface as a
      // blank page slot with the placeholder number still showing.
      if (cancelled || name === "RenderingCancelledException") return;
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      const host = textLayerHostRef.current;
      if (host) host.replaceChildren();
    };
  }, [visible, scale, rotation, docEpoch, pageNumber, docRef, renderKey]);

  // Search highlight boxes for THIS page — a pure derivation from the
  // cached item geometry + the page's matches (proportional char ranges
  // inside each item; the canvas is NOT re-rendered for search).
  const boxes: HighlightBox[] = useMemo(() => {
    if (!geo || geo.renderKey !== renderKey || matches.length === 0) {
      return EMPTY_BOXES;
    }
    const out: HighlightBox[] = [];
    for (const match of matches) {
      const item = geo.items.find((x) => x.itemIndex === match.itemIndex);
      if (!item) continue;
      const len = item.str.length;
      if (len === 0) continue;
      const startFrac = clamp(match.start / len, 0, 1);
      const endFrac = clamp(match.end / len, 0, 1);
      const left = item.left + startFrac * item.width;
      const width = Math.max(4, (endFrac - startFrac) * item.width);
      out.push({
        matchId: match.id,
        left,
        top: item.top - item.height,
        width,
        height: Math.max(item.height, 6),
      });
    }
    return out;
  }, [geo, matches, renderKey]);

  return (
    <div
      ref={setSlotRef}
      data-viewer-page={pageNumber}
      style={{ width: disp.w, height: disp.h }}
      className="relative shrink-0 overflow-hidden rounded-sm bg-white shadow-md ring-1 ring-border/60 dark:bg-neutral-100"
      aria-label={t("view.a11yPage", {
        page: pageNumber,
      })}
    >
      {visible ? (
        <>
          <canvas
            ref={canvasRef}
            className={cn(
              "block",
              dark && "[filter:invert(0.92)_hue-rotate(180deg)]"
            )}
          />
          <div ref={textLayerHostRef} className="pdf-textLayer" />
          {boxes.map((box) => (
            <div
              key={box.matchId}
              className={cn(
                "pointer-events-none absolute rounded-[2px]",
                box.matchId === activeMatchId
                  ? "bg-primary/45 ring-2 ring-primary"
                  : "bg-primary/25"
              )}
              style={{
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
              }}
            />
          ))}
        </>
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-muted/50">
          <span className="text-xs font-medium text-muted-foreground/70">
            {pageNumber}
          </span>
        </div>
      )}
    </div>
  );
}

/* ----------------------------- ViewerThumb ----------------------------- */

interface ViewerThumbProps {
  pageNumber: number;
  active: boolean;
  docRef: React.RefObject<PDFDocumentProxy | null>;
  docEpoch: number;
  onGo: (page: number) => void;
  scrollRootRef: React.RefObject<HTMLDivElement | null>;
}

/** Lazy sidebar thumbnail rendered straight from the open document. */
function ViewerThumb({
  pageNumber,
  active,
  docRef,
  docEpoch,
  onGo,
  scrollRootRef,
}: ViewerThumbProps): React.JSX.Element {
  const { t } = useI18n();
  const wrapRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [done, setDone] = useState(-1);

  useEffect(() => {
    const el = wrapRef.current;
    const root = scrollRootRef.current;
    if (!el || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setVisible(entry.isIntersecting);
      },
      { root, rootMargin: "120% 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollRootRef]);

  useEffect(() => {
    if (!visible || done === docEpoch) return;
    const doc = docRef.current;
    if (!doc) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null =
      null;
    void (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(
        typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
        2
      );
      const base = page.getViewport({ scale: 1 });
      const scale = (THUMB_MAX_DIM * dpr) / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale });
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      canvas.style.width = `${Math.round(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.round(viewport.height / dpr)}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      const task = page.render({ canvasContext: context, viewport });
      renderTask = task;
      await task.promise;
      if (cancelled) return;
      setDone(docEpoch);
    })().catch(() => {
      /* thumbnail failure is cosmetic — the page itself still renders */
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.removeAttribute("style");
        canvas.removeAttribute("width");
        canvas.removeAttribute("height");
      }
    };
  }, [visible, done, docEpoch, pageNumber, docRef]);

  return (
    <button
      type="button"
      ref={wrapRef}
      onClick={() => onGo(pageNumber)}
      aria-label={t("view.a11yThumb", { page: pageNumber })}
      aria-current={active ? "true" : undefined}
      className={cn(
        "group flex w-full flex-col items-center gap-1 rounded-card p-1.5 outline-none transition-colors",
        "hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active && "bg-primary/10"
      )}
    >
      <span
        className={cn(
          "relative flex items-center justify-center overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-border/70",
          active ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : ""
        )}
      >
        <canvas ref={canvasRef} className="block" />
      </span>
      <span
        className={cn(
          "text-[10px] font-medium tabular-nums",
          active ? "text-primary" : "text-muted-foreground"
        )}
      >
        {pageNumber}
      </span>
    </button>
  );
}

/* ------------------------------ ViewSurface ---------------------------- */

export function ViewSurface({
  files,
  onChain,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const { toast } = useToast();
  const file = files[0]?.file ?? null;

  /* ---- document state ---- */
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const [docEpoch, setDocEpoch] = useState(0);
  const [status, setStatus] = useState<DocStatus>("loading");
  const [wrongPassword, setWrongPassword] = useState(false);
  const [password, setPassword] = useState("");
  /** Retry counter — resubmitting the SAME wrong password still re-runs
   *  the open attempt (deps [file, password, pwTry]). */
  const [pwTry, setPwTry] = useState(0);
  const [passwordInput, setPasswordInput] = useState("");
  const [pageSizes, setPageSizes] = useState<
    { w: number; h: number; rot: number }[]
  >([]);
  const [outline, setOutline] = useState<OutlineRow[]>([]);

  /* ---- view preferences ---- */
  const [layout, setLayout] = useState<LayoutMode>("continuous");
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit-width");
  const [rotation, setRotation] = useState(0);
  const [dark, setDark] = useState(false);
  const [sidebar, setSidebar] = useState<"thumbs" | "outline" | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  /* ---- search state ---- */
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<{
    query: string;
    matches: SearchMatch[];
  } | null>(null);
  const [activeMatch, setActiveMatch] = useState(0);
  const [searchState, setSearchState] = useState<"idle" | "searching" | "done">(
    "idle"
  );
  const [searchedPages, setSearchedPages] = useState(0);

  /* ---- presentation mode state ---- */
  const [presenting, setPresenting] = useState(false);
  const [presPage, setPresPage] = useState(1);
  const [presControls, setPresControls] = useState(true);
  const [presSize, setPresSize] = useState({ w: 0, h: 0 });
  const presStageRef = useRef<HTMLDivElement | null>(null);
  const presHideTimer = useRef<number | null>(null);
  /** Page to land the viewer on once the stage unmounts (set by exit). */
  const presLandingRef = useRef<number | null>(null);

  /* ---- refs ---- */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const slotEls = useRef(new Map<number, HTMLElement>());
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  const numPages = pageSizes.length;

  /* ---- view-state reset when the file or password changes ----
     React's documented "adjust state during render" pattern: when the
     input identity changes, reset the view BEFORE the doc effect runs —
     no synchronous setState cascade inside the effect itself. */
  const [openedFor, setOpenedFor] = useState<{ file: File | null; password: string }>(
    () => ({ file, password })
  );
  if (openedFor.file !== file || openedFor.password !== password) {
    setOpenedFor({ file, password });
    setStatus("loading");
    setWrongPassword(false);
    setPageSizes([]);
    setOutline([]);
    setCurrentPage(1);
    setSearchResult(null);
    setActiveMatch(0);
    setPresenting(false);
  }

  /* ---- open the document (password aware, retry on password) ---- */
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      const pdfjs = await loadPdfjs();
      const data = new Uint8Array(await file.arrayBuffer());
      const doc = await pdfjs.getDocument({
        data,
        ...(password ? { password } : {}),
        ...PDF_DOC_PARAMS,
      }).promise;
      if (cancelled) {
        void doc.destroy().catch(() => undefined);
        return;
      }
      docRef.current = doc;

      const sizes: { w: number; h: number; rot: number }[] = [];
      for (let i = 1; i <= doc.numPages; i += 1) {
        const page = await doc.getPage(i);
        // Media size (rotation: 0) + native /Rotate — the slot math composes
        // both with the viewer rotation exactly like pdf.js viewports do.
        const viewport = page.getViewport({ scale: 1, rotation: 0 });
        sizes.push({
          w: viewport.width,
          h: viewport.height,
          rot: ((page.rotate % 360) + 360) % 360,
        });
      }
      if (cancelled) return;
      setPageSizes(sizes);
      setStatus("ready");
      setDocEpoch((epoch) => epoch + 1);

      // Outline (bookmarks) flattened with depth, resolved to pages.
      try {
        const raw = await doc.getOutline();
        if (!raw || raw.length === 0) return;
        const rows: OutlineRow[] = [];
        const walk = async (
          items: typeof raw,
          depth: number
        ): Promise<void> => {
          for (const item of items) {
            let page = 0;
            try {
              const dest =
                typeof item.dest === "string"
                  ? await doc.getDestination(item.dest)
                  : item.dest;
              if (Array.isArray(dest) && dest.length > 0) {
                page = (await doc.getPageIndex(dest[0] as never)) + 1;
              }
            } catch {
              page = 0;
            }
            const title = (item.title ?? "").trim();
            if (page > 0) {
              rows.push({
                title: title.length > 0 ? title : `Bookmark ${rows.length + 1}`,
                page,
                depth,
              });
            }
            if (item.items && item.items.length > 0 && depth < 3) {
              await walk(item.items, depth + 1);
            }
          }
        };
        await walk(raw, 0);
        if (!cancelled) setOutline(rows.slice(0, 200));
      } catch {
        /* no outline — the tab stays hidden (no empty state) */
      }
    })().catch((error: unknown) => {
      if (cancelled) return;
      const name =
        error !== null && typeof error === "object" && "name" in error
          ? String((error as { name: unknown }).name)
          : "";
      if (name === "PasswordException") {
        setStatus("password");
        setWrongPassword(password !== "");
        docRef.current = null;
        return;
      }
      setStatus("error");
      docRef.current = null;
    });
    return () => {
      cancelled = true;
      const doc = docRef.current;
      docRef.current = null;
      if (doc) void doc.destroy().catch(() => undefined);
    };
  }, [file, password, pwTry]);

  /* ---- container size (fit modes) — measured by the ResizeObserver,
     which always fires once right after observe(), so no sync setState ---- */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [status]);

  /* ---- effective scale ---- */
  const scale = useMemo(() => {
    if (pageSizes.length === 0) return 1;
    const { w, h } = containerSize;
    if (w <= 0) return 1;
    let maxW = 0;
    let maxH = 0;
    for (const size of pageSizes) {
      const disp = displaySize(size, 1, rotation);
      maxW = Math.max(maxW, disp.w);
      maxH = Math.max(maxH, disp.h);
    }
    const room = Math.max(80, w - VIEWPORT_PADDING * 2);
    if (zoomMode === "fit-width") {
      const divisor = layout === "spread" ? maxW * 2 + SPREAD_GAP : maxW;
      return clamp(room / divisor, 0.05, 8);
    }
    if (zoomMode === "fit-page") {
      const roomH = Math.max(120, h - VIEWPORT_PADDING * 2);
      const divisor = layout === "spread" ? maxW * 2 + SPREAD_GAP : maxW;
      return clamp(Math.min(room / divisor, roomH / maxH), 0.05, 8);
    }
    return clamp(zoomMode, MIN_ZOOM, MAX_ZOOM);
  }, [containerSize, pageSizes, rotation, zoomMode, layout]);

  const zoomStep = useCallback(
    (dir: 1 | -1) => {
      setZoomMode(nextZoomStep(scale, dir));
    },
    [scale]
  );

  /* ---- page slot registration (stable) ---- */
  const registerSlot = useCallback((page: number, el: HTMLElement | null) => {
    if (el) slotEls.current.set(page, el);
    else slotEls.current.delete(page);
  }, []);

  /* ---- current page tracking while scrolling ---- */
  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const top = container.scrollTop;
    let best = 1;
    let bestTop = -1;
    for (const [page, el] of slotEls.current) {
      if (el.offsetTop <= top + 32 && el.offsetTop >= bestTop) {
        best = page;
        bestTop = el.offsetTop;
      }
    }
    setCurrentPage((prev) => (prev === best ? prev : best));
  }, []);

  const scrollToPage = useCallback(
    (page: number, smooth = true) => {
      const container = scrollRef.current;
      const el = slotEls.current.get(page);
      if (!container || !el) return;
      const top =
        el.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop -
        10;
      container.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
    },
    []
  );

  const goToPage = useCallback(
    (page: number) => {
      const target = clamp(Math.round(page), 1, Math.max(1, numPages));
      setCurrentPage(target);
      if (layout === "single") return;
      scrollToPage(target);
    },
    [layout, numPages, scrollToPage]
  );

  /* ---- search ----
     The result object carries its query so stale results from a previous
     query never render (pure derivation, no sync setState in the effect). */
  const needle = query.trim().toLocaleLowerCase();
  const queryValid = searchOpen && needle.length >= 2;

  useEffect(() => {
    if (status !== "ready" || !queryValid) return;
    const doc = docRef.current;
    if (!doc) return;
    let cancelled = false;
    void (async () => {
      setSearchState("searching");
      setSearchedPages(0);
      const found: SearchMatch[] = [];
      let id = 0;
      for (let i = 0; i < doc.numPages; i += 1) {
        if (cancelled) return;
        try {
          const page = await doc.getPage(i + 1);
          const content = await page.getTextContent();
          for (let j = 0; j < content.items.length; j += 1) {
            const str = (content.items[j] as { str?: unknown }).str;
            if (typeof str !== "string" || str.length === 0) continue;
            const hay = str.toLocaleLowerCase();
            let at = hay.indexOf(needle);
            while (at !== -1 && found.length < 500) {
              found.push({
                id: (id += 1),
                pageIndex: i,
                itemIndex: j,
                start: at,
                end: at + needle.length,
                context: str.trim().slice(0, 90),
              });
              at = hay.indexOf(needle, at + needle.length);
            }
          }
        } catch {
          /* unreadable page — skip */
        }
        setSearchedPages(i + 1);
      }
      if (cancelled) return;
      setSearchResult({ query: needle, matches: found });
      setActiveMatch(found.length > 0 ? 1 : 0);
      setSearchState("done");
      // Land on the first match right away (PRD §6.5 "jump to each match").
      if (found.length > 0) goToPage(found[0].pageIndex + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [needle, queryValid, status, goToPage]);

  /** Only the result of the CURRENT query is ever shown. */
  const visibleMatches =
    searchResult !== null && searchResult.query === needle
      ? searchResult.matches
      : EMPTY_MATCHES;
  const searchingNow = queryValid && searchState === "searching";

  const matchesByPage = useMemo(() => {
    const map = new Map<number, SearchMatch[]>();
    for (const match of visibleMatches) {
      const list = map.get(match.pageIndex);
      if (list) list.push(match);
      else map.set(match.pageIndex, [match]);
    }
    return map;
  }, [visibleMatches]);

  const activeMatchId =
    activeMatch > 0 && activeMatch <= visibleMatches.length
      ? visibleMatches[activeMatch - 1].id
      : null;

  const focusMatch = useCallback(
    (index: number) => {
      if (visibleMatches.length === 0) return;
      const next =
        ((index - 1) % visibleMatches.length + visibleMatches.length) %
          visibleMatches.length +
        1;
      setActiveMatch(next);
      const match = visibleMatches[next - 1];
      goToPage(match.pageIndex + 1);
    },
    [goToPage, visibleMatches]
  );

  /* ---- presentation mode (fullscreen one-page stage) ----
     The stage is a fixed overlay covering the viewport; when the
     Fullscreen API is available the stage itself goes fullscreen (same
     UI either way), otherwise it stays a plain fixed overlay — iPhone
     Safari and locked-down iframes get the identical experience. The
     underlying viewer chrome stays mounted but `inert`, so exiting
     restores it exactly as it was. */

  const armPresHide = useCallback((): void => {
    if (presHideTimer.current !== null) window.clearTimeout(presHideTimer.current);
    presHideTimer.current = window.setTimeout(() => {
      setPresControls(false);
    }, PRES_CONTROLS_HIDE_MS);
  }, []);

  const exitPresentation = useCallback((): void => {
    if (presHideTimer.current !== null) {
      window.clearTimeout(presHideTimer.current);
      presHideTimer.current = null;
    }
    setPresenting(false);
    // If we own the native fullscreen, hand it back (the change event
    // re-runs this — idempotent; overlay-only runs never entered it).
    if (typeof document !== "undefined" && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
    // Land the viewer on the last presented page. The SCROLL is deferred
    // (presLandingRef + the effect below): while the stage is still
    // fullscreen the viewer behind it is laid out at the fullscreen
    // dimensions (screen ≠ viewport → fit-width scale differs → slot
    // rects collapse), so a scroll computed now would target the wrong
    // position once the normal layout returns.
    const target = clamp(presPage, 1, Math.max(1, numPages));
    setCurrentPage((prev) => (prev === target ? prev : target));
    presLandingRef.current = target;
  }, [numPages, presPage]);

  // Deferred landing: once the stage is gone, scroll the viewer onto the
  // last presented page. Retried (rAF + two timeouts) because the layout
  // only settles back AFTER the asynchronous fullscreen exit — each
  // attempt is idempotent, and overlay-only exits land on the first one.
  // Also hands focus back to the viewer root (the dialog that swallowed
  // it is gone).
  useEffect(() => {
    if (presenting) return;
    const page = presLandingRef.current;
    if (page === null) return;
    presLandingRef.current = null;
    if (!scrollRef.current) return;
    scrollToPage(page, false);
    const raf = requestAnimationFrame(() => scrollToPage(page, false));
    const retry1 = window.setTimeout(() => scrollToPage(page, false), 250);
    const retry2 = window.setTimeout(() => scrollToPage(page, false), 600);
    rootRef.current?.focus();
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(retry1);
      window.clearTimeout(retry2);
    };
  }, [presenting, scrollToPage]);

  const enterPresentation = useCallback((): void => {
    setPresPage(clamp(currentPage, 1, Math.max(1, numPages)));
    setPresControls(true);
    setPresenting(true);
    armPresHide();
  }, [armPresHide, currentPage, numPages]);

  const presAdvance = useCallback(
    (dir: 1 | -1): void => {
      setPresPage((prev) => clamp(prev + dir, 1, Math.max(1, numPages)));
    },
    [numPages]
  );

  const presGo = useCallback(
    (page: number): void => {
      setPresPage(clamp(Math.round(page), 1, Math.max(1, numPages)));
    },
    [numPages]
  );

  // Enter: request fullscreen (fallback = stay a fixed overlay) + focus
  // the stage so keydown events originate inside it. On teardown (exit,
  // file switched mid-presentation, unmount) hand native fullscreen back
  // — guarded to the stage WE own so a foreign element is never touched.
  useEffect(() => {
    if (!presenting) return;
    const stage = presStageRef.current;
    if (stage) {
      if (
        typeof document !== "undefined" &&
        document.fullscreenEnabled &&
        typeof stage.requestFullscreen === "function"
      ) {
        void stage.requestFullscreen().catch(() => undefined);
      }
      stage.focus();
    }
    return () => {
      if (
        typeof document !== "undefined" &&
        document.fullscreenElement === presStageRef.current
      ) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, [presenting]);

  // Native Esc exit: the browser leaves fullscreen → leave presentation
  // with it (overlay-only mode never fires fullscreenchange).
  useEffect(() => {
    if (!presenting) return;
    const onFullscreenChange = (): void => {
      if (!document.fullscreenElement) exitPresentation();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [presenting, exitPresentation]);

  // Controls auto-hide: any mouse movement or pointer press (touch taps
  // included) shows the strip again and restarts the timer. Keyboard users
  // never lose it — focus-within keeps the strip visible (CSS below).
  useEffect(() => {
    if (!presenting) return;
    const bump = (): void => {
      setPresControls(true);
      armPresHide();
    };
    window.addEventListener("mousemove", bump);
    window.addEventListener("pointerdown", bump);
    return () => {
      window.removeEventListener("mousemove", bump);
      window.removeEventListener("pointerdown", bump);
    };
  }, [presenting, armPresHide]);

  // No stray hide-timer past unmount (a late fire would setState on a
  // dead component for nothing).
  useEffect(
    () => () => {
      if (presHideTimer.current !== null) {
        window.clearTimeout(presHideTimer.current);
        presHideTimer.current = null;
      }
    },
    []
  );

  // Stage size (fit math) — measured by the ResizeObserver, which always
  // fires once right after observe(), so no sync setState.
  useEffect(() => {
    if (!presenting) return;
    const stage = presStageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => {
      setPresSize({ w: stage.clientWidth, h: stage.clientHeight });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [presenting]);

  const presScale = useMemo(() => {
    const base = pageSizes[presPage - 1];
    if (!base || presSize.w <= 0 || presSize.h <= 0) return 1;
    const disp = displaySize(base, 1, rotation);
    return clamp(
      Math.min(
        (presSize.w - PRES_STAGE_PADDING * 2) / disp.w,
        (presSize.h - PRES_STAGE_PADDING * 2) / disp.h
      ),
      0.05,
      8
    );
  }, [pageSizes, presPage, presSize, rotation]);

  const handlePresKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      // Focus trap: Tab cycles inside the stage while presenting (the
      // chrome behind it is inert).
      if (event.key === "Tab") {
        const root = presStageRef.current;
        const focusables = root
          ? Array.from(
              root.querySelectorAll<HTMLElement>(
                "button:not([disabled]), [href], input:not([disabled])"
              )
            )
          : [];
        if (focusables.length === 0) {
          event.preventDefault();
        } else {
          const active = document.activeElement as HTMLElement | null;
          const index = active ? focusables.indexOf(active) : -1;
          const next = event.shiftKey
            ? index <= 0
              ? focusables.length - 1
              : index - 1
            : index === focusables.length - 1
              ? 0
              : index + 1;
          event.preventDefault();
          focusables[next].focus();
        }
        event.stopPropagation();
        return;
      }
      // Space belongs to a focused control (button activation), never
      // to page advance.
      const target = event.target as HTMLElement | null;
      const onControl =
        target !== null &&
        (target.tagName === "BUTTON" ||
          target.tagName === "A" ||
          target.tagName === "INPUT");
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          exitPresentation();
          break;
        case "ArrowRight":
        case "PageDown":
          event.preventDefault();
          presAdvance(1);
          break;
        case "ArrowLeft":
        case "PageUp":
          event.preventDefault();
          presAdvance(-1);
          break;
        case "Home":
          event.preventDefault();
          presGo(1);
          break;
        case "End":
          event.preventDefault();
          presGo(numPages);
          break;
        case " ":
          if (!onControl) {
            event.preventDefault();
            presAdvance(1);
          }
          break;
        default:
          break;
      }
      // Every key stops here — the viewer's own shortcuts (G, ±, R,
      // Ctrl+F) stay inert until presentation mode exits cleanly.
      event.stopPropagation();
    },
    [exitPresentation, numPages, presAdvance, presGo]
  );

  const handlePresClick = useCallback((): void => {
    // Click the stage → next page; a fresh text selection never advances.
    const selection =
      typeof window !== "undefined" ? window.getSelection() : null;
    if (selection && selection.toString().length > 0) return;
    presAdvance(1);
  }, [presAdvance]);

  /** Presentation pages never touch the viewer's slot registry. */
  const noopRegisterSlot = useCallback((): void => undefined, []);

  /* ---- actions ---- */
  const printFile = useCallback(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.position = "fixed";
    frame.style.inset = "auto 0 0 0";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "0";
    frame.src = url;
    frame.addEventListener("load", () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        window.open(url, "_blank", "noopener");
      }
    });
    document.body.appendChild(frame);
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
      frame.remove();
    }, 60_000);
  }, [file]);

  const downloadFile = useCallback(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name || "document.pdf";
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
  }, [file]);

  const shareFile = useCallback(async () => {
    if (!file || typeof navigator === "undefined" || !navigator.canShare) {
      return;
    }
    try {
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: file.name });
      } else {
        toast({ title: t("view.shareUnsupported") });
      }
    } catch {
      /* user dismissed the share sheet — not an error */
    }
  }, [file, t, toast]);

  const canShare =
    typeof navigator !== "undefined" &&
    typeof navigator.canShare === "function";

  /* ---- keyboard (PRD §6.5) ---- */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      const inField =
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (event.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setQuery("");
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 30);
        return;
      }
      if (inField) return;
      switch (event.key) {
        case "ArrowRight":
        case "PageDown":
          // PRD §6.5: arrows/pages move by PAGE in every layout (continuous
          // mode jump-scrolls to the slot, keeping the page indicator honest).
          event.preventDefault();
          goToPage(Math.min(numPages, currentPage + 1));
          break;
        case "ArrowLeft":
        case "PageUp":
          event.preventDefault();
          goToPage(Math.max(1, currentPage - 1));
          break;
        case "+":
        case "=":
          event.preventDefault();
          zoomStep(1);
          break;
        case "-":
          event.preventDefault();
          zoomStep(-1);
          break;
        case "0":
          event.preventDefault();
          setZoomMode("fit-width");
          break;
        case "g":
        case "G":
          event.preventDefault();
          pageInputRef.current?.focus();
          pageInputRef.current?.select();
          break;
        case "r":
        case "R":
          event.preventDefault();
          setRotation((deg) => (deg + 90) % 360);
          break;
        default:
          break;
      }
    },
    [
      currentPage,
      goToPage,
      numPages,
      searchOpen,
      zoomStep,
    ]
  );

  /* ---- derived rows for spread layout ---- */
  const spreadRows = useMemo(() => {
    const rows: { first: number; second: number | null }[] = [];
    if (layout !== "spread") return rows;
    for (let i = 0; i < numPages; i += 2) {
      rows.push({ first: i + 1, second: i + 1 < numPages ? i + 2 : null });
    }
    return rows;
  }, [layout, numPages]);

  /* ---- guard: no file (shell renders the surface only with files) ---- */
  if (!file) return null;

  /* ============================ loading ============================= */
  if (status === "loading") {
    return (
      <div className="flex h-[70vh] min-h-96 flex-col items-center justify-center gap-4 rounded-card border border-border bg-card">
        <Loader2 className="size-8 animate-spin text-primary" aria-hidden="true" />
        <div className="text-center">
          <p className="text-sm font-semibold text-foreground">
            {t("view.loadingTitle")}
          </p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {t("view.loadingBody")}
          </p>
        </div>
        <p className="flex items-center gap-1.5 rounded-chip bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
          <Lock className="size-3" aria-hidden="true" />
          {t("view.privateChip")}
        </p>
      </div>
    );
  }

  /* ============================ password ============================= */
  if (status === "password") {
    return (
      <div className="flex h-[70vh] min-h-96 items-center justify-center rounded-card border border-border bg-card p-6">
        <form
          className="w-full max-w-sm"
          onSubmit={(event) => {
            event.preventDefault();
            setPassword(passwordInput);
            setPwTry((n) => n + 1);
          }}
        >
          <div className="flex size-11 items-center justify-center rounded-card bg-primary/10">
            <Lock className="size-5 text-primary" aria-hidden="true" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-foreground">
            {t("view.passwordTitle")}
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {t("view.passwordBody")}
          </p>
          <Input
            type="password"
            value={passwordInput}
            onChange={(event) => setPasswordInput(event.target.value)}
            placeholder={t("view.passwordPlaceholder")}
            autoComplete="off"
            autoFocus
            className="mt-4"
            aria-label={t("view.passwordPlaceholder")}
          />
          {wrongPassword ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
              {t("view.passwordWrong")}
            </p>
          ) : null}
          <Button type="submit" size="touch" className="mt-4 w-full rounded-btn font-semibold">
            {t("view.passwordUnlock")}
          </Button>
          <p className="mt-3 text-center text-[11px] text-muted-foreground">
            {t("view.passwordNote")}
          </p>
        </form>
      </div>
    );
  }

  /* ============================= error ============================== */
  if (status === "error") {
    return (
      <div className="flex h-[70vh] min-h-96 items-center justify-center rounded-card border border-border bg-card p-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto flex size-11 items-center justify-center rounded-card bg-amber-500/10">
            <TriangleAlert
              className="size-5 text-amber-500"
              aria-hidden="true"
            />
          </div>
          <h2 className="mt-4 text-base font-semibold text-foreground">
            {t("view.errorTitle")}
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {t("view.errorBody")}
          </p>
        </div>
      </div>
    );
  }

  /* ============================= ready ============================== */
  const singleMode = layout === "single";
  const spreadMode = layout === "spread";

  const pageNode = (pageNumber: number): React.JSX.Element => {
    const base = pageSizes[pageNumber - 1] ?? { w: 612, h: 792, rot: 0 };
    return (
      <ViewerPage
        key={pageNumber}
        pageNumber={pageNumber}
        docRef={docRef}
        docEpoch={docEpoch}
        scale={scale}
        rotation={rotation}
        base={base}
        dark={dark}
        matches={matchesByPage.get(pageNumber - 1) ?? EMPTY_MATCHES}
        activeMatchId={activeMatchId}
        registerSlot={registerSlot}
        scrollRootRef={scrollRef}
      />
    );
  };

  const iconBtn =
    "size-9 shrink-0 rounded-btn outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40";

  /** Effective sidebar tab. The outline tab is only rendered for documents
   *  that actually have bookmarks, so a stale "outline" selection (file
   *  switched to a bookmark-less one) falls back to thumbnails here —
   *  derived during render, no setState cascade. */
  const activeTab: "thumbs" | "outline" | null =
    sidebar === "outline" && outline.length === 0
      ? "thumbs"
      : sidebar;

  /** Presentation chrome: prev / indicator / exit, floating + auto-hide. */
  const presCtrlBtn =
    "flex size-10 items-center justify-center rounded-full text-white/85 outline-none transition-colors hover:bg-white/15 focus-visible:ring-[3px] focus-visible:ring-white/60 disabled:pointer-events-none disabled:opacity-40";

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="flex flex-col overflow-hidden rounded-card border border-border bg-card outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      role="application"
      aria-label={t("view.a11yViewer")}
    >
      {/* display:contents keeps the flex layout; `inert` blanks the whole
          viewer (focus + a11y + pointer) while the presentation stage is
          up — exiting restores everything exactly as it was. */}
      <div className="contents" inert={presenting || undefined}>
      {/* ---------------- file meta strip ---------------- */}
      <div className="flex items-center gap-2.5 border-b border-border bg-muted/40 px-3 py-2">
        <FileText className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          {file.name}
        </p>
        <span className="hidden shrink-0 rounded-chip bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline">
          {formatBytes(file.size)}
        </span>
        <span className="shrink-0 rounded-chip bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          {t("view.pagesCount", { count: numPages })}
        </span>
        <span className="hidden shrink-0 items-center gap-1 rounded-chip bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 sm:flex dark:text-emerald-400">
          <Lock className="size-3" aria-hidden="true" />
          {t("view.privateChip")}
        </span>
      </div>

      {/* ---------------- toolbar ---------------- */}
      <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border px-2 py-1.5 scrollbar-none max-sm:flex-nowrap sm:flex-wrap">
        <button
          type="button"
          onClick={() =>
            setSidebar((prev) => (prev === null ? "thumbs" : null))
          }
          title={t("view.toolbarSidebar")}
          aria-label={t("view.toolbarSidebar")}
          aria-pressed={sidebar !== null}
          className={cn(iconBtn, "grid shrink-0 place-items-center", sidebar !== null && "bg-muted")}
        >
          <PanelLeft className="size-4" aria-hidden="true" />
        </button>

        <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" />

        {/* page navigation */}
        <button
          type="button"
          onClick={() => goToPage(currentPage - 1)}
          disabled={currentPage <= 1}
          title={t("view.toolbarPrev")}
          aria-label={t("view.toolbarPrev")}
          className={cn(iconBtn, "grid shrink-0 place-items-center")}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium tabular-nums text-foreground">
          <input
            ref={pageInputRef}
            type="number"
            min={1}
            max={numPages || 1}
            value={currentPage}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(parsed)) setCurrentPage(parsed);
            }}
            onBlur={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              goToPage(Number.isFinite(parsed) ? parsed : currentPage);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                const parsed = Number.parseInt(
                  (event.target as HTMLInputElement).value,
                  10
                );
                goToPage(Number.isFinite(parsed) ? parsed : currentPage);
                (event.target as HTMLInputElement).blur();
              }
            }}
            aria-label={t("view.goToPage")}
            className="h-7 w-11 rounded-md border border-border bg-background px-1.5 text-center tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <span className="text-muted-foreground">/ {numPages}</span>
        </span>
        <button
          type="button"
          onClick={() => goToPage(currentPage + 1)}
          disabled={currentPage >= numPages}
          title={t("view.toolbarNext")}
          aria-label={t("view.toolbarNext")}
          className={cn(iconBtn, "grid shrink-0 place-items-center")}
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>

        <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" />

        {/* zoom */}
        <button
          type="button"
          onClick={() => zoomStep(-1)}
          disabled={scale <= MIN_ZOOM + 0.001}
          title={t("view.zoomOut")}
          aria-label={t("view.zoomOut")}
          className={cn(iconBtn, "grid shrink-0 place-items-center")}
        >
          <ZoomOut className="size-4" aria-hidden="true" />
        </button>
        <span
          className="w-11 shrink-0 text-center text-xs font-medium tabular-nums text-foreground"
          aria-live="polite"
        >
          {Math.round(scale * 100)}%
        </span>
        <button
          type="button"
          onClick={() => zoomStep(1)}
          disabled={scale >= MAX_ZOOM - 0.001}
          title={t("view.zoomIn")}
          aria-label={t("view.zoomIn")}
          className={cn(iconBtn, "grid shrink-0 place-items-center")}
        >
          <ZoomIn className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setZoomMode("fit-width")}
          title={t("view.fitWidth")}
          aria-label={t("view.fitWidth")}
          aria-pressed={zoomMode === "fit-width"}
          className={cn(
            iconBtn,
            "hidden shrink-0 place-items-center sm:grid",
            zoomMode === "fit-width" && "bg-muted"
          )}
        >
          <StretchHorizontal className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setZoomMode("fit-page")}
          title={t("view.fitPage")}
          aria-label={t("view.fitPage")}
          aria-pressed={zoomMode === "fit-page"}
          className={cn(
            iconBtn,
            "hidden shrink-0 place-items-center sm:grid",
            zoomMode === "fit-page" && "bg-muted"
          )}
        >
          <Maximize2 className="size-4" aria-hidden="true" />
        </button>

        <span className="mx-0.5 hidden h-5 w-px bg-border sm:block" aria-hidden="true" />

        {/* layout modes */}
        <ToggleGroup
          type="single"
          value={layout}
          onValueChange={(value) => {
            if (value) setLayout(value as LayoutMode);
          }}
          className="flex items-center gap-0.5"
          aria-label={t("view.layoutLabel")}
        >
          <ToggleGroupItem
            value="continuous"
            title={t("view.layoutContinuous")}
            aria-label={t("view.layoutContinuous")}
            className="size-8 rounded-btn p-0"
          >
            <Rows3 className="size-4" aria-hidden="true" />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="single"
            title={t("view.layoutSingle")}
            aria-label={t("view.layoutSingle")}
            className="size-8 rounded-btn p-0"
          >
            <Square className="size-4" aria-hidden="true" />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="spread"
            title={t("view.layoutSpread")}
            aria-label={t("view.layoutSpread")}
            className="size-8 rounded-btn p-0"
          >
            <Columns2 className="size-4" aria-hidden="true" />
          </ToggleGroupItem>
        </ToggleGroup>

        <button
          type="button"
          onClick={() => setRotation((deg) => (deg + 90) % 360)}
          title={t("view.rotate")}
          aria-label={t("view.rotate")}
          className={cn(iconBtn, "grid shrink-0 place-items-center")}
        >
          <RotateCw className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setDark((prev) => !prev)}
          title={t("view.darkMode")}
          aria-label={t("view.darkMode")}
          aria-pressed={dark}
          className={cn(
            iconBtn,
            "grid shrink-0 place-items-center",
            dark && "bg-muted text-primary"
          )}
        >
          <Moon className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={enterPresentation}
          title={t("view.present")}
          aria-label={t("view.present")}
          className={cn(iconBtn, "grid shrink-0 place-items-center")}
        >
          <Presentation className="size-4" aria-hidden="true" />
        </button>

        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setSearchOpen(true);
              window.setTimeout(() => searchInputRef.current?.focus(), 30);
            }}
            title={t("view.search")}
            aria-label={t("view.search")}
            className={cn(iconBtn, "grid shrink-0 place-items-center", searchOpen && "bg-muted")}
        >
          <Search className="size-4" aria-hidden="true" />
        </button>
          <span className="hidden items-center text-[10px] text-muted-foreground md:flex" title={t("view.keysHint")}>
            <Keyboard className="mr-1 size-3.5" aria-hidden="true" />
            {t("view.keysHint")}
          </span>
          {canShare ? (
            <button
              type="button"
              onClick={() => void shareFile()}
              title={t("view.share")}
              aria-label={t("view.share")}
              className={cn(iconBtn, "hidden shrink-0 place-items-center sm:grid")}
            >
              <Share2 className="size-4" aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={printFile}
            title={t("view.print")}
            aria-label={t("view.print")}
            className={cn(iconBtn, "grid shrink-0 place-items-center")}
          >
            <Printer className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={downloadFile}
            title={t("view.download")}
            aria-label={t("view.download")}
            className={cn(iconBtn, "grid shrink-0 place-items-center")}
          >
            <Download className="size-4" aria-hidden="true" />
          </button>
        </span>
      </div>

      {/* ---------------- search bar ---------------- */}
      {searchOpen ? (
        <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                focusMatch(
                  event.shiftKey ? activeMatch - 1 : activeMatch + 1
                );
              }
            }}
            placeholder={t("view.searchPlaceholder")}
            aria-label={t("view.search")}
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          {searchingNow ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {t("view.searchProgress", {
                done: searchedPages,
                total: numPages,
              })}
            </span>
          ) : queryValid ? (
            <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
              {visibleMatches.length === 0
                ? t("view.searchEmpty")
                : t("view.searchCount", {
                    current: activeMatch,
                    total: visibleMatches.length,
                  })}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => focusMatch(activeMatch - 1)}
            disabled={visibleMatches.length === 0}
            title={t("view.searchPrev")}
            aria-label={t("view.searchPrev")}
            className={cn(iconBtn, "grid place-items-center")}
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => focusMatch(activeMatch + 1)}
            disabled={visibleMatches.length === 0}
            title={t("view.searchNext")}
            aria-label={t("view.searchNext")}
            className={cn(iconBtn, "grid place-items-center")}
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => {
              setSearchOpen(false);
              setQuery("");
            }}
            title={t("view.searchClose")}
            aria-label={t("view.searchClose")}
            className={cn(iconBtn, "grid place-items-center")}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {/* ---------------- sidebar + pages ---------------- */}
      <div className="relative flex min-h-[70vh]">
        {/* sidebar (thumbnails / outline). The outline tab only exists when
            the document actually HAS bookmarks — hidden entirely otherwise
            (no empty-state noise). While a doc with an outline is being
            replaced by one without, `activeTab` falls back to thumbs. */}
        {sidebar !== null ? (
          <aside
            className="absolute inset-y-0 left-0 z-20 flex w-44 flex-col border-r border-border bg-background/95 backdrop-blur md:static md:z-auto md:w-48 md:bg-transparent md:backdrop-blur-none"
            aria-label={t("view.sidebarLabel")}
          >
            <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
              <button
                type="button"
                onClick={() => setSidebar("thumbs")}
                aria-pressed={activeTab === "thumbs"}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1 rounded-btn px-2 py-1.5 text-[11px] font-semibold outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  activeTab === "thumbs"
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground"
                )}
              >
                <List className="size-3.5" aria-hidden="true" />
                {t("view.thumbsTab")}
              </button>
              {outline.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setSidebar("outline")}
                  aria-pressed={activeTab === "outline"}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-1 rounded-btn px-2 py-1.5 text-[11px] font-semibold outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    activeTab === "outline"
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground"
                  )}
                >
                  <ListTree className="size-3.5" aria-hidden="true" />
                  {t("view.outlineTab")}
                </button>
              ) : null}
            </div>
            {activeTab === "thumbs" ? (
              <div className="flex-1 overflow-y-auto p-2 scrollbar-thin">
                <div className="grid grid-cols-1 gap-1.5">
                  {Array.from({ length: numPages }, (_, i) => (
                    <ViewerThumb
                      key={i + 1}
                      pageNumber={i + 1}
                      active={currentPage === i + 1}
                      docRef={docRef}
                      docEpoch={docEpoch}
                      onGo={(page) => goToPage(page)}
                      scrollRootRef={scrollRef}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-2 scrollbar-thin">
                <ul className="space-y-0.5">
                  {outline.map((row, index) => (
                    <li key={`${row.page}-${index}`}>
                      <button
                        type="button"
                        onClick={() => goToPage(row.page)}
                        className="flex w-full items-baseline gap-1.5 rounded-btn px-2 py-1.5 text-left text-[11px] leading-snug outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        style={{ paddingLeft: `${8 + row.depth * 12}px` }}
                      >
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                          {row.title}
                        </span>
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                          {row.page}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </aside>
        ) : null}

        {/* pages */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={cn(
            "relative h-[70vh] min-h-96 flex-1 overflow-auto bg-neutral-100 scrollbar-thin dark:bg-neutral-900",
            dark && "bg-neutral-900 dark:bg-black"
          )}
        >
          {singleMode ? (
            <div className="flex min-h-full items-start justify-center p-6">
              {pageNode(clamp(currentPage, 1, numPages))}
            </div>
          ) : spreadMode ? (
            <div className="flex flex-col items-center gap-4 p-6">
              {spreadRows.map((row) => (
                <div
                  key={row.first}
                  className="flex items-start justify-center gap-3"
                >
                  {pageNode(row.first)}
                  {row.second !== null ? pageNode(row.second) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 p-6">
              {Array.from({ length: numPages }, (_, i) => pageNode(i + 1))}
            </div>
          )}
        </div>
      </div>

      {/* ---------------- search results drawer ---------------- */}
      {searchOpen && visibleMatches.length > 0 ? (
        <div className="border-t border-border bg-muted/30">
          <p className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("view.searchResults", { count: visibleMatches.length })}
          </p>
          <ul className="max-h-40 overflow-y-auto px-2 py-2 scrollbar-thin">
            {visibleMatches.slice(0, 100).map((match, index) => (
              <li key={match.id}>
                <button
                  type="button"
                  onClick={() => {
                    setActiveMatch(index + 1);
                    goToPage(match.pageIndex + 1);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left text-[11px] outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    index + 1 === activeMatch
                      ? "bg-primary/10"
                      : "bg-transparent"
                  )}
                >
                  <span className="shrink-0 rounded-chip bg-background px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-primary">
                    {match.pageIndex + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {match.context}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ---------------- continue with ---------------- */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/40 px-3 py-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("view.continueTitle")}
        </p>
        {(["merge-pdf", "split-pdf", "rotate-pdf-pages", "fill-out-pdf"] as const).map(
          (toolId) => (
            <button
              key={toolId}
              type="button"
              onClick={() => onChain?.(toolId)}
              className="rounded-chip border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground outline-none transition-colors hover:border-primary/50 hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {t(`view.continue.${toolId}`)}
            </button>
          )
        )}
      </div>
      </div>

      {/* ---------------- presentation stage ----------------
          One page at a time, fitted to the screen. Native fullscreen when
          the browser allows it, a fixed overlay otherwise; Esc exits both.
          All viewer chrome is inert above; this stage owns every key. */}
      {presenting ? (
        <div
          ref={presStageRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={t("view.presStage")}
          onKeyDown={handlePresKeyDown}
          onClick={handlePresClick}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black outline-none"
        >
          <ViewerPage
            key="pres-page"
            pageNumber={clamp(presPage, 1, Math.max(1, numPages))}
            docRef={docRef}
            docEpoch={docEpoch}
            scale={presScale}
            rotation={rotation}
            base={pageSizes[presPage - 1] ?? { w: 612, h: 792, rot: 0 }}
            dark={dark}
            matches={EMPTY_MATCHES}
            activeMatchId={null}
            registerSlot={noopRegisterSlot}
            scrollRootRef={presStageRef}
          />

          {/* floating control strip — auto-hides, focus-within keeps it */}
          <div
            onClick={(event) => event.stopPropagation()}
            className={cn(
              "absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-white/15 bg-black/75 px-2 py-1.5 text-white shadow-lg backdrop-blur transition-opacity duration-300",
              "focus-within:pointer-events-auto focus-within:opacity-100",
              presControls
                ? "opacity-100"
                : "pointer-events-none opacity-0"
            )}
          >
            <button
              type="button"
              onClick={() => presAdvance(-1)}
              disabled={presPage <= 1}
              title={t("view.toolbarPrev")}
              aria-label={t("view.toolbarPrev")}
              className={presCtrlBtn}
            >
              <ChevronLeft className="size-5" aria-hidden="true" />
            </button>
            <span
              aria-live="polite"
              aria-label={t("view.presPageOf", {
                page: clamp(presPage, 1, Math.max(1, numPages)),
                pages: numPages,
              })}
              className="min-w-16 px-1.5 text-center text-xs font-semibold tabular-nums"
            >
              {clamp(presPage, 1, Math.max(1, numPages))} / {numPages}
            </span>
            <button
              type="button"
              onClick={() => presAdvance(1)}
              disabled={presPage >= numPages}
              title={t("view.toolbarNext")}
              aria-label={t("view.toolbarNext")}
              className={presCtrlBtn}
            >
              <ChevronRight className="size-5" aria-hidden="true" />
            </button>
            <span
              className="mx-1 hidden h-5 w-px bg-white/20 sm:block"
              aria-hidden="true"
            />
            <span className="hidden pr-1 text-[10px] text-white/60 sm:inline">
              {t("view.presHint")}
            </span>
            <button
              type="button"
              onClick={exitPresentation}
              title={t("view.presExit")}
              aria-label={t("view.presExit")}
              className={presCtrlBtn}
            >
              <Minimize2 className="size-4.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const EMPTY_MATCHES: SearchMatch[] = [];
const EMPTY_BOXES: HighlightBox[] = [];
