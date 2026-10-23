"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
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
} from "@dnd-kit/sortable";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  CopyPlus,
  FileText,
  Files,
  Loader2,
  MousePointerClick,
  RotateCcw,
  RotateCw,
  Redo2,
  SquarePlus,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps, ToolFileRef } from "@/lib/tools/panel-types";
import {
  detectBlankPages,
  getPdfPageAspect,
  getPdfPageCount,
} from "@/lib/pdf/thumbnails";
import { formatBytes } from "@/lib/storage/recent-files";
import { cn } from "@/lib/utils";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { GridCell } from "./grid-cell";
import { useGridHistory } from "./use-grid-history";
import {
  VIRTUALIZE_ABOVE,
  createInitialGrid,
  deleteIndices,
  duplicateIndices,
  evenIndices,
  gridStats,
  gridThumbMaxDim,
  insertBlankAfter,
  moveEntry,
  moveSelectionByOne,
  oddIndices,
  parseGridOption,
  parseGridRange,
  parseNumberListOption,
  rotateIndices,
  serializeGrid,
  type GridPage,
  type GridPreset,
} from "./model";

/**
 * PageGrid surface (PRD §8.1 "Rotate / Rearrange / Remove / Extract
 * (Page-grid family)") — ONE shared interactive page grid, preset-tuned:
 *
 * - common actions: select (click / shift-click / Ctrl+A / range input),
 *   drag reorder, rotate 90 L/R per page or scope, delete, duplicate,
 *   insert blank, undo/redo, zoom slider
 * - rotate preset adds odd/even scope buttons + live thumbnail rotation
 * - remove preset adds "remove blank pages" auto-detect
 * - extract preset keeps the grid as the picker (selection = pages out)
 * - large docs (>VIRTUALIZE_ABOVE pages) render virtualized rows with lazy
 *   thumbnails; drag swaps for the always-available move buttons
 *
 * The edited page list is synced to the tool options ("grid" / "selected")
 * after every action, so the shared worker always sees the exact state.
 */

const ZOOM_MIN = 88;
const ZOOM_MAX = 168;
const ZOOM_STEP = 16;
const ZOOM_DEFAULT = 120;
const CELL_GAP = 12;
const CELL_FOOTER = 0; // cells size themselves via aspect-ratio
const OVERSCAN_ROWS = 2;
const DEFAULT_ASPECT = 0.707; // A4 portrait while the real aspect loads
/** Batch cap — mirrors maxFiles in the four family tool configs. */
const GRID_MAX_FILES = 20;

/** Toolbar buttons stay 44px touch targets (a11y hard rule). */
const TOOL_BTN =
  "h-11 min-h-11 gap-1.5 rounded-btn px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50";

type ScopeId = "all" | "selected" | "odd" | "even";

export function GridSurface({
  preset,
  files,
  onChange,
  setFileOrder,
  setRunBlocked,
  addFiles,
}: ToolSurfaceProps & { preset: GridPreset }) {
  const { t } = useI18n();
  const { toast } = useToast();
  // Batch (R2-a — rotate was the pattern-setter, now the whole family):
  // every PageGrid preset keeps ONE edited grid per workspace file (and,
  // for extract, ONE selection per file). The list UI appears at 2+ files.
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const activeIndex = Math.min(
    activeFileIndex,
    Math.max(0, files.length - 1)
  );
  const activeRef = files.length > 0 ? files[activeIndex] : null;
  const activeId = activeRef?.id ?? null;
  const file = activeRef?.file ?? null;
  /** Batch list UI appears once there IS a batch (2+ files). */
  const showBatchList = files.length > 1;

  const {
    pages,
    canUndo,
    canRedo,
    commit,
    reset,
    undo,
    redo,
  } = useGridHistory([]);

  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [focusIndex, setFocusIndex] = useState(0);
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [scope, setScope] = useState<ScopeId>("all");
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  const [rangeText, setRangeText] = useState("");
  const [blankScan, setBlankScan] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [docInfo, setDocInfo] = useState<{
    file: File;
    count: number;
    aspect: number;
  } | null>(null);

  /* ---- batch per-file stores ----
     Refs are the source of truth: async detection completions must never
     clobber grids edited in between; `batchTick` forces the file-list
     re-render (rows read the refs during render, after the tick).
     `selectionsByFileRef` mirrors the pattern for the extract preset —
     one serialized selection ("[0,2]" wire string) per file. */
  const gridsByFileRef = useRef<Record<string, string>>({});
  const selectionsByFileRef = useRef<Record<string, string>>({});
  const docInfoByFileRef = useRef<
    Record<string, { count: number; aspect: number }>
  >({});
  const [batchTick, setBatchTick] = useState(0);
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(480);
  const [containerW, setContainerW] = useState(0);

  const virtualized = pages.length > VIRTUALIZE_ABOVE;
  const thumbDim = gridThumbMaxDim();
  const aspect = docInfo?.file === file ? docInfo.aspect : DEFAULT_ASPECT;

  /* ---------------- CTA gating (event-context sync, no effect-setState) */

  /** Batch gate: every workspace file needs a stored, non-empty grid —
   *  and (extract only) its own selection with at least one page. */
  const syncBatchBlocked = useCallback(
    (currentFiles: ToolFileRef[]) => {
      for (const item of currentFiles) {
        const stored = gridsByFileRef.current[item.id];
        if (stored === undefined) {
          setRunBlocked("grid.detecting");
          return;
        }
        const storedGrid = parseGridOption(stored);
        if (storedGrid === null || storedGrid.length === 0) {
          setRunBlocked("grid.ctaAllRemoved");
          return;
        }
        if (preset === "extract") {
          const selected = parseNumberListOption(
            selectionsByFileRef.current[item.id]
          );
          if (selected.length === 0) {
            setRunBlocked("grid.ctaSelectPages");
            return;
          }
        }
      }
      setRunBlocked(null);
    },
    [preset, setRunBlocked]
  );

  /* ---------------- Serialization helpers ---------------- */

  const serializeSelection = (next: ReadonlySet<number>): string =>
    JSON.stringify([...next].sort((a, b) => a - b));

  /* ---------------- Document detection (page count + aspect) ---------------- */

  useEffect(() => {
    if (!file) return;
    let cancelled = false;

    const install = (
      initial: GridPage[],
      count: number,
      fileAspect: number,
      initialSelection: ReadonlySet<number>
    ): void => {
      reset(initial);
      setDocInfo({ file, count, aspect: fileAspect });
      setSelection(new Set(initialSelection));
      setFocusIndex(0);
      setAnchorIndex(null);
      onChange("grid", serializeGrid(initial));
      onChange("selected", serializeSelection(initialSelection));
      onChange("originalCount", count);
      syncBatchBlocked(filesRef.current);
    };

    // Switch back to a known file → synchronous restore, no spinner.
    const cached =
      activeId !== null ? docInfoByFileRef.current[activeId] : undefined;
    if (activeId !== null && cached !== undefined) {
      const stored = gridsByFileRef.current[activeId] ?? "[]";
      const storedSelection = selectionsByFileRef.current[activeId];
      install(
        parseGridOption(stored) ?? createInitialGrid(cached.count),
        cached.count,
        cached.aspect,
        new Set(
          storedSelection !== undefined
            ? parseNumberListOption(storedSelection)
            : []
        )
      );
      return () => {
        cancelled = true;
      };
    }

    void Promise.all([getPdfPageCount(file), getPdfPageAspect(file)])
      .then(([count, fileAspect]) => {
        if (cancelled) return;
        if (activeId !== null) {
          docInfoByFileRef.current[activeId] = { count, aspect: fileAspect };
          if (gridsByFileRef.current[activeId] === undefined) {
            gridsByFileRef.current[activeId] =
              count >= 1 ? serializeGrid(createInitialGrid(count)) : "[]";
            onChange("grids", JSON.stringify(gridsByFileRef.current));
          }
          if (
            preset === "extract" &&
            selectionsByFileRef.current[activeId] === undefined
          ) {
            selectionsByFileRef.current[activeId] = "[]";
            onChange(
              "selections",
              JSON.stringify(selectionsByFileRef.current)
            );
          }
          setBatchTick((tick) => tick + 1);
          syncBatchBlocked(filesRef.current);
        }
        if (count < 1) {
          setDocInfo({ file, count: 0, aspect: DEFAULT_ASPECT });
          syncBatchBlocked(filesRef.current);
          return;
        }
        const storedNow =
          activeId !== null ? gridsByFileRef.current[activeId] : undefined;
        const initial =
          storedNow !== undefined
            ? parseGridOption(storedNow) ?? createInitialGrid(count)
            : createInitialGrid(count);
        const selectionNow =
          preset === "extract" && activeId !== null
            ? selectionsByFileRef.current[activeId]
            : undefined;
        install(
          initial,
          count,
          fileAspect,
          new Set(
            selectionNow !== undefined
              ? parseNumberListOption(selectionNow)
              : []
          )
        );
      })
      .catch(() => {
        if (cancelled) return;
        if (activeId !== null) {
          docInfoByFileRef.current[activeId] = {
            count: 0,
            aspect: DEFAULT_ASPECT,
          };
          if (gridsByFileRef.current[activeId] === undefined) {
            gridsByFileRef.current[activeId] = "[]";
            onChange("grids", JSON.stringify(gridsByFileRef.current));
          }
          if (
            preset === "extract" &&
            selectionsByFileRef.current[activeId] === undefined
          ) {
            selectionsByFileRef.current[activeId] = "[]";
            onChange(
              "selections",
              JSON.stringify(selectionsByFileRef.current)
            );
          }
          setBatchTick((tick) => tick + 1);
          syncBatchBlocked(filesRef.current);
        }
        setDocInfo({ file, count: 0, aspect: DEFAULT_ASPECT });
        syncBatchBlocked(filesRef.current);
      });
    return () => {
      cancelled = true;
    };
  }, [file, activeId, preset, onChange, reset, syncBatchBlocked]);

  /* ---------------- Batch: detect every file + prune on add/remove ------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const item of files) {
        if (cancelled) return;
        if (docInfoByFileRef.current[item.id] !== undefined) continue;
        let count = 0;
        let fileAspect = DEFAULT_ASPECT;
        try {
          [count, fileAspect] = await Promise.all([
            getPdfPageCount(item.file),
            getPdfPageAspect(item.file),
          ]);
        } catch {
          count = 0;
          fileAspect = DEFAULT_ASPECT;
        }
        if (cancelled) return;
        docInfoByFileRef.current[item.id] = { count, aspect: fileAspect };
        if (gridsByFileRef.current[item.id] === undefined) {
          gridsByFileRef.current[item.id] =
            count >= 1 ? serializeGrid(createInitialGrid(count)) : "[]";
          onChange("grids", JSON.stringify(gridsByFileRef.current));
        }
        if (
          preset === "extract" &&
          selectionsByFileRef.current[item.id] === undefined
        ) {
          selectionsByFileRef.current[item.id] = "[]";
          onChange("selections", JSON.stringify(selectionsByFileRef.current));
        }
        setBatchTick((tick) => tick + 1);
        syncBatchBlocked(filesRef.current);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [files, preset, onChange, syncBatchBlocked]);

  // Files added/removed: prune per-file state for the ones that are gone,
  // keep options.grids / options.selections aligned, and re-run the batch
  // gate (a fresh file blocks the CTA as "detecting" until its grid is
  // stored).
  useEffect(() => {
    const ids = new Set(files.map((item) => item.id));
    let pruned = false;
    for (const id of Object.keys(gridsByFileRef.current)) {
      if (!ids.has(id)) {
        delete gridsByFileRef.current[id];
        delete docInfoByFileRef.current[id];
        pruned = true;
      }
    }
    for (const id of Object.keys(selectionsByFileRef.current)) {
      if (!ids.has(id)) {
        delete selectionsByFileRef.current[id];
        pruned = true;
      }
    }
    if (pruned) {
      // Deferred via microtask (house pattern): synchronous setState in an
      // effect body trips react-hooks/set-state-in-effect.
      queueMicrotask(() => {
        onChange("grids", JSON.stringify(gridsByFileRef.current));
        if (preset === "extract") {
          onChange(
            "selections",
            JSON.stringify(selectionsByFileRef.current)
          );
        }
        setBatchTick((tick) => tick + 1);
      });
    }
    syncBatchBlocked(files);
  }, [files, preset, onChange, syncBatchBlocked]);

  /* ---------------- Viewport measurement (virtualization) ---------------- */

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setViewportH(el.clientHeight);
      setContainerW(el.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  /* ---------------- Mutations (all flow through apply/commit) ---------------- */

  /** Batch: persist the ACTIVE file's grid into the per-file store (the
   *  whole-batch gate re-runs via syncBatchBlocked in every caller).
   *  Skipped while this file's detection is still in flight — a transient
   *  grid from the previously active file must never land under this id. */
  const syncActiveGrid = (next: GridPage[]): void => {
    if (activeId === null) return;
    if (docInfoByFileRef.current[activeId] === undefined) return;
    gridsByFileRef.current[activeId] = serializeGrid(next);
    onChange("grids", JSON.stringify(gridsByFileRef.current));
    setBatchTick((tick) => tick + 1);
  };

  /** Extract batch: persist the ACTIVE file's selection into the per-file
   *  store (same in-flight guard as syncActiveGrid — a transient selection
   *  from the previously active file must never land under this id). */
  const syncActiveSelection = (next: ReadonlySet<number>): void => {
    if (preset !== "extract" || activeId === null) return;
    if (docInfoByFileRef.current[activeId] === undefined) return;
    selectionsByFileRef.current[activeId] = serializeSelection(next);
    onChange("selections", JSON.stringify(selectionsByFileRef.current));
    setBatchTick((tick) => tick + 1);
  };

  /** Batch: drop one workspace file (per-file state is pruned by the
   *  files-change effect) and keep the active index sane. */
  const removeBatchFile = (id: string): void => {
    const index = files.findIndex((item) => item.id === id);
    const next = files.filter((item) => item.id !== id);
    setFileOrder(next);
    if (index >= 0) {
      setActiveFileIndex(Math.max(0, Math.min(index, next.length - 1)));
    }
  };

  const apply = (next: GridPage[], nextSelection?: Set<number>) => {
    const clamped =
      nextSelection ??
      new Set([...selection].filter((index) => index < next.length));
    commit(next);
    setSelection(clamped);
    setFocusIndex((prev) => Math.min(prev, Math.max(0, next.length - 1)));
    onChange("grid", serializeGrid(next));
    onChange("selected", serializeSelection(clamped));
    syncActiveGrid(next);
    syncActiveSelection(clamped);
    syncBatchBlocked(filesRef.current);
  };

  const changeSelection = (next: Set<number>) => {
    setSelection(next);
    onChange("selected", serializeSelection(next));
    syncActiveSelection(next);
    syncBatchBlocked(filesRef.current);
  };

  const selectedIndices = useMemo(
    () => [...selection].sort((a, b) => a - b),
    [selection]
  );

  const scopeIndices = (): number[] => {
    if (scope === "odd") return oddIndices(pages);
    if (scope === "even") return evenIndices(pages);
    if (scope === "selected") return selectedIndices;
    return pages.map((_, index) => index);
  };

  const rotate = (delta: number) => {
    const targets = scopeIndices();
    if (targets.length === 0) return;
    apply(rotateIndices(pages, targets, delta));
  };

  const deleteSelected = () => {
    if (selection.size === 0) return;
    apply(deleteIndices(pages, selectedIndices), new Set());
  };

  const duplicateSelected = () => {
    if (selection.size === 0) return;
    apply(duplicateIndices(pages, selectedIndices));
  };

  const insertBlank = () => {
    apply(insertBlankAfter(pages, selectedIndices));
  };

  const moveSelected = (direction: -1 | 1) => {
    if (selection.size === 0) return;
    apply(moveSelectionByOne(pages, selectedIndices, direction));
  };

  const handleUndo = () => {
    const restored = undo();
    if (restored === null) {
      toast({ title: t("grid.toastNoUndo") });
      return;
    }
    const clamped = new Set(
      [...selection].filter((index) => index < restored.length)
    );
    setSelection(clamped);
    onChange("grid", serializeGrid(restored));
    onChange("selected", serializeSelection(clamped));
    syncActiveGrid(restored);
    syncActiveSelection(clamped);
    syncBatchBlocked(filesRef.current);
  };

  const handleRedo = () => {
    const redone = redo();
    if (redone === null) {
      toast({ title: t("grid.toastNoRedo") });
      return;
    }
    const clamped = new Set(
      [...selection].filter((index) => index < redone.length)
    );
    setSelection(clamped);
    onChange("grid", serializeGrid(redone));
    onChange("selected", serializeSelection(clamped));
    syncActiveGrid(redone);
    syncActiveSelection(clamped);
    syncBatchBlocked(filesRef.current);
  };

  /* ---------------- Selection interactions ---------------- */

  const toggleCell = (
    index: number,
    event: ReactMouseEvent<HTMLButtonElement>
  ) => {
    const additive = event.ctrlKey || event.metaKey;
    if (event.shiftKey && anchorIndex !== null) {
      const from = Math.min(anchorIndex, index);
      const to = Math.max(anchorIndex, index);
      const next = new Set<number>();
      for (let i = from; i <= to; i += 1) next.add(i);
      changeSelection(next);
      return;
    }
    setAnchorIndex(index);
    if (additive) {
      const next = new Set(selection);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      changeSelection(next);
      return;
    }
    if (selection.size === 1 && selection.has(index)) {
      changeSelection(new Set());
      return;
    }
    changeSelection(new Set([index]));
  };

  const selectAll = () => {
    changeSelection(new Set(pages.map((_, index) => index)));
  };

  const clearSelection = () => {
    changeSelection(new Set());
    setAnchorIndex(null);
  };

  const applyRange = () => {
    const parsed = parseGridRange(rangeText, pages.length);
    if (parsed === null) {
      toast({ title: t("grid.rangeInvalid"), variant: "destructive" });
      return;
    }
    changeSelection(new Set(parsed));
    setAnchorIndex(parsed.length > 0 ? parsed[0] : null);
  };

  /* ---------------- Remove-blanks auto-detect (remove preset) ---------------- */

  const removeBlanks = () => {
    if (!file || blankScan !== null) return;
    setBlankScan({ done: 0, total: docInfo?.count ?? 0 });
    void detectBlankPages(file, (progress) => {
      setBlankScan({ done: progress.done, total: progress.total });
    })
      .then((blanks) => {
        setBlankScan(null);
        if (blanks.length === 0) {
          toast({ title: t("grid.removeBlanksNone") });
          return;
        }
        const blankSources = new Set(blanks.map((page) => page - 1));
        const targets = pages
          .map((entry, index) =>
            entry.source >= 0 && blankSources.has(entry.source) ? index : -1
          )
          .filter((index) => index >= 0);
        apply(deleteIndices(pages, targets), new Set());
        toast({ title: t("grid.removeBlanksFound", { count: blanks.length }) });
      })
      .catch(() => {
        setBlankScan(null);
        toast({
          title: t("tool.errorTitle"),
          description: t("tool.errorCorrupt"),
          variant: "destructive",
        });
      });
  };

  /* ---------------- Keyboard (scoped to the surface) ---------------- */

  const onRootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    const inField = tag === "input" || tag === "textarea" || tag === "select";
    if (event.key === "Escape") {
      if (selection.size > 0) {
        clearSelection();
        event.preventDefault();
      }
      return;
    }
    if (inField) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAll();
      return;
    }
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) handleRedo();
      else handleUndo();
      return;
    }
    if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      handleRedo();
      return;
    }
    if (
      (event.key === "Delete" || event.key === "Backspace") &&
      selection.size > 0
    ) {
      event.preventDefault();
      deleteSelected();
    }
  };

  /* ---------------- Grid geometry (virtualization math) ---------------- */

  const cellW = zoom;
  const cellH = Math.round(cellW / aspect) + CELL_FOOTER;
  const cols = Math.max(
    1,
    Math.floor((containerW + CELL_GAP) / (cellW + CELL_GAP))
  );
  const rowCount = Math.ceil(pages.length / cols);
  const rowH = cellH + CELL_GAP;
  const firstRow = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN_ROWS);
  const lastRow = Math.min(
    rowCount - 1,
    Math.ceil((scrollTop + viewportH) / rowH) + OVERSCAN_ROWS
  );
  const windowedPages = virtualized
    ? pages.slice(firstRow * cols, (lastRow + 1) * cols)
    : pages;
  const windowOffset = virtualized ? firstRow * cols : 0;

  const scopeOptions: { id: ScopeId; key: string }[] = [
    { id: "all", key: "grid.scopeAll" },
    { id: "selected", key: "grid.scopeSelected" },
  ];
  if (preset === "rotate") {
    scopeOptions.push(
      { id: "odd", key: "grid.scopeOdd" },
      { id: "even", key: "grid.scopeEven" }
    );
  }

  /* ---------------- Drag reorder (only when fully mounted) ---------------- */

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = pages.findIndex((page) => page.uid === active.id);
    const to = pages.findIndex((page) => page.uid === over.id);
    if (from < 0 || to < 0) return;
    apply(moveEntry(pages, from, to));
  };

  /* ---------------- Cells ---------------- */

  const cells = windowedPages.map((entry, offset) => {
    const index = windowOffset + offset;
    return (
      <GridCell
        key={entry.uid}
        entry={entry}
        index={index}
        file={file}
        aspect={aspect}
        selected={selection.has(index)}
        focusable={index === focusIndex}
        sortable={!virtualized}
        thumbDim={thumbDim}
        onToggle={toggleCell}
        onFocusCell={setFocusIndex}
        onRotate={(cellIndex, delta) =>
          apply(rotateIndices(pages, [cellIndex], delta))
        }
        onDelete={(cellIndex) =>
          apply(deleteIndices(pages, [cellIndex]), new Set())
        }
      />
    );
  });

  /* ---------------- Batch list rows (family multi-file) ---------------- */

  // batchTick is a dependency on purpose: the refs are the storage, the
  // tick re-syncs this state after every store mutation. Ref reads happen
  // inside the effect (never during render) — react-hooks/refs compliant.
  // The per-file badge is preset-tuned: rotate → rotated pages, rearrange
  // → pages not in their original position, remove → removed pages,
  // extract → selected pages.
  const [batchRows, setBatchRows] = useState<
    Array<{
      id: string;
      name: string;
      size: number;
      info: { count: number; aspect: number } | undefined;
      badge: { count: number; key: string; titleKey: string } | null;
      isActive: boolean;
    }>
  >([]);
  useEffect(() => {
    void batchTick;
    setBatchRows(
      files.map((item, index) => {
        const info = docInfoByFileRef.current[item.id];
        const stored = gridsByFileRef.current[item.id];
        const grid =
          stored !== undefined ? parseGridOption(stored) : null;
        let badge: { count: number; key: string; titleKey: string } | null =
          null;
        if (preset === "rotate") {
          const rotated = grid
            ? grid.filter((page) => page.rotation !== 0).length
            : 0;
          if (rotated > 0) {
            badge = {
              count: rotated,
              key: "grid.batchRotated",
              titleKey: "grid.batchRotatedTitle",
            };
          }
        } else if (preset === "rearrange") {
          const moved = grid
            ? grid.filter((page, i) => page.source !== i).length
            : 0;
          if (moved > 0) {
            badge = {
              count: moved,
              key: "grid.batchMoved",
              titleKey: "grid.batchMovedTitle",
            };
          }
        } else if (preset === "remove") {
          const removed =
            grid && info ? gridStats(grid, info.count).removed : 0;
          if (removed > 0) {
            badge = {
              count: removed,
              key: "grid.batchRemoved",
              titleKey: "grid.batchRemovedTitle",
            };
          }
        } else {
          const storedSelection = selectionsByFileRef.current[item.id];
          const selected =
            storedSelection !== undefined
              ? parseNumberListOption(storedSelection).length
              : 0;
          if (selected > 0) {
            badge = {
              count: selected,
              key: "grid.batchSelected",
              titleKey: "grid.batchSelectedTitle",
            };
          }
        }
        return {
          id: item.id,
          name: item.file.name,
          size: item.file.size,
          info,
          badge,
          isActive: index === activeIndex,
        };
      })
    );
  }, [files, batchTick, activeIndex, preset]);

  /* ---------------- Render ---------------- */

  const selectionLabel =
    selection.size === 0
      ? t("grid.selectionNone")
      : t("grid.selectionCount", {
          count: selection.size,
          total: pages.length,
        });

  return (
    <section
      ref={rootRef}
      aria-label={t("grid.surfaceLabel")}
      onKeyDown={onRootKeyDown}
      className="flex flex-col gap-3"
    >
      {/* File header — the surface replaces the FileList for grid tools.
          Batch mode (2+ files) swaps it for the per-file switcher list. */}
      {showBatchList ? (
        <div className="flex flex-col gap-2 rounded-card border border-border bg-card p-3">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Files
                className="size-4 shrink-0 text-cat-organize"
                aria-hidden="true"
              />
              {t("grid.batchTitle", { count: files.length })}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {t("grid.batchHint")}
            </p>
          </div>
          <ul className="scrollbar-thin flex max-h-56 flex-col gap-1.5 overflow-y-auto">
            {batchRows.map((row) => (
              <li key={row.id} className="relative">
                <button
                  type="button"
                  onClick={() => {
                    const index = files.findIndex(
                      (item) => item.id === row.id
                    );
                    if (index >= 0) setActiveFileIndex(index);
                  }}
                  aria-current={row.isActive ? "true" : undefined}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-2.5 rounded-btn border py-1.5 pl-2.5 pr-11 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    row.isActive
                      ? "border-primary/60 bg-primary/5"
                      : "border-border bg-background hover:bg-accent"
                  )}
                >
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-btn",
                      row.isActive
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground"
                    )}
                    aria-hidden="true"
                  >
                    {row.info && row.info.count === 0 ? (
                      <TriangleAlert className="size-4" />
                    ) : (
                      <FileText className="size-4" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-xs font-medium text-foreground"
                      title={row.name}
                    >
                      {row.name}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {row.info === undefined
                        ? t("grid.detecting")
                        : row.info.count === 0
                          ? t("tool.errorCorrupt")
                          : `${formatBytes(row.size)} · ${t("tool.pageCount", {
                              count: row.info.count,
                            })}`}
                    </span>
                  </span>
                  {row.badge ? (
                    <span
                      className="shrink-0 rounded-chip bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
                      title={t(row.badge.titleKey)}
                    >
                      {t(row.badge.key, { count: row.badge.count })}
                    </span>
                  ) : null}
                  {row.isActive ? (
                    <span className="shrink-0 rounded-chip bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                      {t("grid.batchEditing")}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  onClick={() => removeBatchFile(row.id)}
                  aria-label={t("tool.removeFile")}
                  title={t("tool.removeFile")}
                  className="absolute right-1.5 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-card border border-border bg-card p-3">
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-btn bg-cat-organize/10 text-cat-organize"
            aria-hidden="true"
          >
            <FileText className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p
              className="truncate text-sm font-semibold text-foreground"
              title={file?.name}
            >
              {file?.name}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {file
                ? `${formatBytes(file.size)}${
                    docInfo?.file === file && docInfo.count > 0
                      ? ` · ${t("tool.pageCount", { count: docInfo.count })}`
                      : ""
                  }`
                : ""}
            </p>
          </div>
          {file ? (
            <Button
              type="button"
              variant="outline"
              className="h-11 min-h-11 rounded-btn px-3 text-xs"
              onClick={() => setFileOrder([])}
            >
              {t("tool.removeFile")}
            </Button>
          ) : null}
        </div>
      )}

      {/* Toolbar — selection row */}
      <div className="flex flex-col gap-3 rounded-card border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-chip px-2.5 py-1 text-[11px] font-semibold",
              selection.size > 0
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground"
            )}
          >
            {selectionLabel}
          </span>
          <div className="flex min-w-44 flex-1 items-center gap-1.5">
            <Input
              value={rangeText}
              onChange={(event) => setRangeText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyRange();
                }
              }}
              placeholder={t("grid.rangePlaceholder")}
              aria-label={t("grid.rangeLabel")}
              spellCheck={false}
              autoComplete="off"
              className="h-11 rounded-btn text-xs font-medium"
            />
            <Button
              type="button"
              variant="outline"
              className={TOOL_BTN}
              onClick={applyRange}
              aria-label={t("grid.rangeLabel")}
            >
              <MousePointerClick className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t("grid.rangeApply")}</span>
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              className={TOOL_BTN}
              onClick={selectAll}
            >
              {t("grid.selectAll")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className={TOOL_BTN}
              onClick={clearSelection}
              disabled={selection.size === 0}
            >
              {t("grid.clearSelection")}
            </Button>
          </div>
        </div>

        {/* Toolbar — actions row */}
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Rotate scope (PRD rotate preset: all / selected / odd / even) */}
          <div
            role="radiogroup"
            aria-label={t("grid.scopeLabel")}
            className="flex overflow-hidden rounded-btn border border-border"
          >
            {scopeOptions.map((option) => {
              const active = scope === option.id;
              const disabled = option.id === "selected" && selection.size === 0;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={disabled}
                  onClick={() => setScope(option.id)}
                  className={cn(
                    "min-h-11 px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "bg-background text-foreground hover:bg-accent",
                    disabled && "cursor-not-allowed opacity-50"
                  )}
                >
                  {t(option.key)}
                </button>
              );
            })}
          </div>

          <Button
            type="button"
            variant="outline"
            className={TOOL_BTN}
            onClick={() => rotate(-90)}
            aria-label={t("grid.rotateLeft")}
            title={t("grid.rotateLeft")}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            className={TOOL_BTN}
            onClick={() => rotate(90)}
            aria-label={t("grid.rotateRight")}
            title={t("grid.rotateRight")}
          >
            <RotateCw className="size-4" aria-hidden="true" />
          </Button>

          <span
            aria-hidden="true"
            className="mx-1 hidden h-6 w-px bg-border sm:block"
          />

          <Button
            type="button"
            variant="outline"
            className={TOOL_BTN}
            onClick={duplicateSelected}
            disabled={selection.size === 0}
            aria-label={t("grid.duplicateLabel")}
            title={t("grid.duplicateLabel")}
          >
            <CopyPlus className="size-4" aria-hidden="true" />
            <span className="hidden md:inline">{t("grid.duplicate")}</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            className={TOOL_BTN}
            onClick={insertBlank}
            aria-label={t("grid.insertBlankLabel")}
            title={t("grid.insertBlankLabel")}
          >
            <SquarePlus className="size-4" aria-hidden="true" />
            <span className="hidden md:inline">{t("grid.insertBlank")}</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            className={cn(
              TOOL_BTN,
              "hover:border-destructive/40 hover:text-destructive"
            )}
            onClick={deleteSelected}
            disabled={selection.size === 0}
            aria-label={t("grid.deleteLabel")}
            title={t("grid.deleteLabel")}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            <span className="hidden md:inline">{t("grid.delete")}</span>
          </Button>

          {preset === "remove" ? (
            <Button
              type="button"
              variant="outline"
              className={cn(
                TOOL_BTN,
                "border-amber-500/40 text-amber-600 hover:border-amber-500/60 dark:text-amber-400"
              )}
              onClick={removeBlanks}
              disabled={blankScan !== null || !file}
              aria-label={t("grid.removeBlanks")}
              title={t("grid.removeBlanks")}
            >
              {blankScan !== null ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  <span className="hidden md:inline">
                    {t("grid.removeBlanksDetecting", {
                      percent: Math.round(
                        (blankScan.done / Math.max(1, blankScan.total)) * 100
                      ),
                    })}
                  </span>
                </>
              ) : (
                <>
                  <Trash2 className="size-4" aria-hidden="true" />
                  <span className="hidden md:inline">
                    {t("grid.removeBlanks")}
                  </span>
                </>
              )}
            </Button>
          ) : null}

          <span
            aria-hidden="true"
            className="mx-1 hidden h-6 w-px bg-border sm:block"
          />

          {/* Move — the always-available reorder path (keyboard + large docs) */}
          <Button
            type="button"
            variant="outline"
            className={TOOL_BTN}
            onClick={() => moveSelected(-1)}
            disabled={selection.size === 0}
            aria-label={t("grid.moveEarlier")}
            title={t("grid.moveEarlier")}
          >
            <ArrowLeftToLine className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            className={TOOL_BTN}
            onClick={() => moveSelected(1)}
            disabled={selection.size === 0}
            aria-label={t("grid.moveLater")}
            title={t("grid.moveLater")}
          >
            <ArrowRightToLine className="size-4" aria-hidden="true" />
          </Button>

          {/* History + zoom */}
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              className={TOOL_BTN}
              onClick={handleUndo}
              disabled={!canUndo}
              aria-label={t("grid.undo")}
              title={t("grid.undo")}
            >
              <Undo2 className="size-4" aria-hidden="true" />
              <span className="hidden lg:inline">{t("grid.undo")}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              className={TOOL_BTN}
              onClick={handleRedo}
              disabled={!canRedo}
              aria-label={t("grid.redo")}
              title={t("grid.redo")}
            >
              <Redo2 className="size-4" aria-hidden="true" />
              <span className="hidden lg:inline">{t("grid.redo")}</span>
            </Button>
            <div className="hidden items-center gap-1 sm:flex">
              <Button
                type="button"
                variant="outline"
                className={TOOL_BTN}
                onClick={() =>
                  setZoom((prev) => Math.max(ZOOM_MIN, prev - ZOOM_STEP))
                }
                aria-label={t("grid.zoomOut")}
                title={t("grid.zoomOut")}
              >
                <ZoomOut className="size-4" aria-hidden="true" />
              </Button>
              <Slider
                value={[zoom]}
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                step={ZOOM_STEP}
                onValueChange={(value) => setZoom(value[0] ?? ZOOM_DEFAULT)}
                aria-label={t("grid.zoomLabel")}
                className="w-24"
              />
              <Button
                type="button"
                variant="outline"
                className={TOOL_BTN}
                onClick={() =>
                  setZoom((prev) => Math.min(ZOOM_MAX, prev + ZOOM_STEP))
                }
                aria-label={t("grid.zoomIn")}
                title={t("grid.zoomIn")}
              >
                <ZoomIn className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </div>

        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-relaxed text-muted-foreground">
          <span>{t("grid.howSelect")}</span>
          {virtualized ? (
            <span className="font-medium text-amber-600 dark:text-amber-400">
              {t("grid.virtualHint")}
            </span>
          ) : (
            <span>{t("grid.howDrag")}</span>
          )}
        </p>
      </div>

      {/* The grid itself */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={cn(
          "scrollbar-thin relative overflow-y-auto rounded-card border border-border bg-muted/20 p-3",
          virtualized ? "max-h-[60vh]" : "max-h-[70vh]"
        )}
      >
        {docInfo === null || docInfo.file !== file ? (
          <p className="flex items-center justify-center gap-2 px-2 py-10 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t("grid.detecting")}
          </p>
        ) : docInfo.count === 0 ? (
          <p className="px-2 py-10 text-center text-xs font-medium text-destructive">
            {t("tool.errorCorrupt")}
          </p>
        ) : pages.length === 0 ? (
          <p className="px-2 py-10 text-center text-xs text-muted-foreground">
            {t("grid.allDeleted")}
          </p>
        ) : virtualized ? (
          <div
            role="grid"
            aria-label={t("grid.gridLabel")}
            className="relative"
            style={{ height: rowCount * rowH }}
          >
            <div
              className="absolute inset-x-0 top-0 grid"
              style={{
                gridTemplateColumns: `repeat(${cols}, ${cellW}px)`,
                gap: CELL_GAP,
                transform: `translateY(${firstRow * rowH}px)`,
              }}
            >
              {cells}
            </div>
          </div>
        ) : (
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
              <div
                role="grid"
                aria-label={t("grid.gridLabel")}
                className="grid"
                style={{
                  gridTemplateColumns: `repeat(auto-fill, minmax(${cellW}px, 1fr))`,
                  gap: CELL_GAP,
                }}
              >
                {cells}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Batch add-more — same compact zone + full shell pipeline
          as the image grid surfaces. With a single file this is the only
          way to grow the batch without going back to the landing. */}
      <DropZone
        labelKey="grid.addMore"
        multiple
        maxFiles={GRID_MAX_FILES}
        acceptKind="pdf"
        onAccept={addFiles}
        currentCount={files.length}
        className="py-2"
      />
    </section>
  );
}
