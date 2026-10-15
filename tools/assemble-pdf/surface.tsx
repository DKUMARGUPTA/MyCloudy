"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  FileStack,
  Loader2,
  Plus,
  Redo2,
  SquarePlus,
  Trash2,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropZone } from "@/components/doco/tool/drop-zone";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { getPdfPageCount, renderPdfThumbnail } from "@/lib/pdf/thumbnails";
import { cn } from "@/lib/utils";
import {
  addDoc,
  asmStats,
  createDocFromFile,
  createEmptyDoc,
  deletePages,
  movePageWithinDoc,
  removeDoc,
  renameDoc,
  reverseDocPages,
  serializeAssemble,
  transferPage,
  type AsmDoc,
  type AsmPageRef,
} from "./model";

/**
 * Assemble PDF workspace surface (PRD §8.1 "Assemble PDF").
 *
 * Multiple documents as side-by-side COLUMNS — pages drag between
 * documents (the PRD core action), "new document" columns can be
 * created, per-column rename / reverse / clear / delete, undo/redo,
 * and lazy per-page thumbnails. The edited columns serialize into the
 * "assemble" option on every change so the shared worker (and its
 * zipper/reverse/separate planning) always sees the exact state.
 *
 * PRD a11y hard rule: cross-column moves are ALSO buttons (44px) —
 * keyboard users never depend on pointer drag.
 *
 * NOTE: no DragOverlay here (grid-cell pattern) — with an overlay,
 * dnd-kit's collision detection keeps using the active item's STATIC
 * rect, so cross-column drops resolve against the SOURCE column. The
 * sortable cell itself must follow the pointer for closestCenter to
 * target the hovered column (verified in QA).
 */

const THUMB_DIM = 128;
const MAX_HISTORY = 100;
const MAX_FILES = 20;

const TOOL_BTN =
  "h-11 min-h-11 gap-1.5 rounded-btn px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50";

/* ------------------------- undo/redo history ------------------------- */

interface HistoryState {
  past: AsmDoc[][];
  docs: AsmDoc[];
  future: AsmDoc[][];
}

type HistoryAction =
  | { type: "commit"; docs: AsmDoc[] }
  /** Replaces the state WITHOUT an undo entry (renames keep history). */
  | { type: "replace"; docs: AsmDoc[] }
  | { type: "undo" }
  | { type: "redo" };

function historyReducer(
  state: HistoryState,
  action: HistoryAction
): HistoryState {
  switch (action.type) {
    case "commit":
      return {
        past: [...state.past.slice(-(MAX_HISTORY - 1)), state.docs],
        docs: action.docs,
        future: [],
      };
    case "replace":
      return { ...state, docs: action.docs };
    case "undo": {
      if (state.past.length === 0) return state;
      const past = [...state.past];
      const docs = past.pop() as AsmDoc[];
      return {
        past,
        docs,
        future: [state.docs, ...state.future].slice(0, MAX_HISTORY),
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const [docs, ...future] = state.future;
      return {
        past: [...state.past.slice(-(MAX_HISTORY - 1)), state.docs],
        docs,
        future,
      };
    }
  }
}

/* ------------------------------ surface ------------------------------ */

export function AssembleSurface({
  files,
  onChange,
  setRunBlocked,
  addFiles,
}: ToolSurfaceProps) {
  const { t } = useI18n();
  const { toast } = useToast();

  const [history, dispatch] = useReducer(historyReducer, {
    past: [],
    docs: [],
    future: [],
  });
  const docs = history.docs;

  /** Mirror of `docs` for async producers (page counts land late). */
  const docsRef = useRef<AsmDoc[]>([]);
  useEffect(() => {
    // Safety net: apply()/undo/redo also sync it synchronously; this keeps
    // the mirror exact even for reducer paths added later.
    if (docsRef.current !== docs) docsRef.current = docs;
  }, [docs]);

  /** Files whose column was created (idempotent across StrictMode). */
  const knownFilesRef = useRef<Set<string>>(new Set());
  const [reading, setReading] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 10 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  /* ---------------- options + CTA sync (single honest mirror) ---------------- */

  useEffect(() => {
    onChange("assemble", serializeAssemble(docs));
    setRunBlocked(
      reading !== null
        ? "asm.ctaReading"
        : docs.every((doc) => doc.pages.length === 0)
          ? "asm.ctaNoPages"
          : null
    );
  }, [docs, onChange, reading, setRunBlocked]);

  /**
   * Applies the next docs state. `record` pushes undo history — structural
   * changes do; renames replace silently (per-keystroke entries would
   * flood the stack).
   */
  const apply = useCallback(
    (updater: (prev: AsmDoc[]) => AsmDoc[], record: boolean) => {
      const next = updater(docsRef.current);
      docsRef.current = next;
      dispatch({ type: record ? "commit" : "replace", docs: next });
    },
    []
  );

  /* ---------------- workspace files → document columns ---------------- */

  useEffect(() => {
    const known = knownFilesRef.current;
    const fresh = files.filter((item) => !known.has(item.id));
    if (fresh.length === 0) return;
    // Mark synchronously so a StrictMode double-run adds nothing twice.
    for (const item of fresh) known.add(item.id);

    setReading({ done: 0, total: fresh.length });

    void (async () => {
      const created: AsmDoc[] = [];
      for (const item of fresh) {
        let count = 0;
        try {
          count = Math.max(0, await getPdfPageCount(item.file));
        } catch {
          count = 0; // honest empty column; shell sniffing rejected junk already
        }
        created.push(createDocFromFile(item.file.name, item.id, count));
        setReading((prev) =>
          prev ? { ...prev, done: prev.done + 1 } : prev
        );
      }
      setReading(null);
      // No cleanup cancellation: the known-set makes this idempotent.
      apply((prev) => [...prev, ...created], true);
    })();
  }, [files, apply]);

  /* ---------------- drag & drop (multi-column) ---------------- */

  const findPage = useCallback(
    (uid: number): { docId: number; index: number } | null => {
      for (const doc of docsRef.current) {
        const index = doc.pages.findIndex((page) => page.uid === uid);
        if (index >= 0) return { docId: doc.id, index };
      }
      return null;
    },
    []
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (over === null) return;
      const activeId = Number(active.id);
      if (activeId === over.id) return; // dropped on itself

      const from = findPage(activeId);
      if (from === null) return;

      const dropId = over.id;
      if (typeof dropId === "number" || /^\d+$/.test(String(dropId))) {
        // Dropped onto a page → same column reorder / cross-column insert.
        const target = findPage(Number(dropId));
        if (target === null) return;
        apply(
          (prev) =>
            from.docId === target.docId
              ? movePageWithinDoc(prev, from.docId, from.index, target.index)
              : transferPage(
                  prev,
                  from.docId,
                  from.index,
                  target.docId,
                  target.index
                ),
          true
        );
        return;
      }

      // Dropped onto a column body → append to that document.
      const match = /^col-drop-(\d+)$/.exec(String(dropId));
      if (match === null) return;
      const toDocId = Number.parseInt(match[1], 10);
      if (toDocId === from.docId) return;
      apply(
        (prev) => transferPage(prev, from.docId, from.index, toDocId, -1),
        true
      );
    },
    [apply, findPage]
  );

  /* ---------------- toolbar actions ---------------- */

  const onUndo = useCallback(() => {
    const prev = history.past[history.past.length - 1];
    if (prev === undefined) {
      toast({ title: t("grid.toastNoUndo") });
      return;
    }
    docsRef.current = prev; // keep the mirror exact for the next action
    dispatch({ type: "undo" });
  }, [history.past, toast, t]);

  const onRedo = useCallback(() => {
    const next = history.future[0];
    if (next === undefined) {
      toast({ title: t("grid.toastNoRedo") });
      return;
    }
    docsRef.current = next; // keep the mirror exact for the next action
    dispatch({ type: "redo" });
  }, [history.future, toast, t]);

  const onAddDoc = useCallback(() => {
    const name = t("asm.newDocName", { n: docsRef.current.length + 1 });
    apply((prev) => addDoc(prev, createEmptyDoc(name)), true);
  }, [apply, t]);

  /** Cross-column button moves (the a11y path — no pointer drag needed). */
  const onMoveToNeighbor = useCallback(
    (docId: number, fromIndex: number, direction: -1 | 1) => {
      const list = docsRef.current;
      const position = list.findIndex((doc) => doc.id === docId);
      if (position < 0) return;
      const target = list[position + direction];
      if (target === undefined) return;
      apply(
        (prev) => transferPage(prev, docId, fromIndex, target.id, -1),
        true
      );
    },
    [apply]
  );

  const stats = useMemo(() => asmStats(docs), [docs]);

  /* ---------------- render ---------------- */

  if (files.length === 0) {
    return (
      <section
        aria-label={t("asm.surfaceLabel")}
        className="flex flex-1 flex-col"
      >
        <DropZone
          labelKey="asm.dropFiles"
          multiple
          maxFiles={MAX_FILES}
          acceptKind="pdf"
          onAccept={addFiles}
          currentCount={0}
        />
      </section>
    );
  }

  return (
    <section
      aria-label={t("asm.surfaceLabel")}
      className="flex flex-1 flex-col gap-3"
    >
      {/* Toolbar: stats + undo/redo + new document */}
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <FileStack className="size-3.5" aria-hidden="true" />
          {t("asm.panelTitle")}
        </h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {t("asm.statDocs", { count: stats.nonEmptyDocs })}
          {" · "}
          {t("asm.statPages", { count: stats.pages })}
        </span>
        {reading !== null ? (
          <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            {t("asm.reading", { done: reading.done, total: reading.total })}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onUndo}
            disabled={history.past.length === 0}
            className={TOOL_BTN}
          >
            <Undo2 className="size-3.5" aria-hidden="true" />
            {t("grid.undo")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRedo}
            disabled={history.future.length === 0}
            className={TOOL_BTN}
          >
            <Redo2 className="size-3.5" aria-hidden="true" />
            {t("grid.redo")}
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={onAddDoc}
            className={TOOL_BTN}
          >
            <SquarePlus className="size-3.5" aria-hidden="true" />
            {t("asm.newDoc")}
          </Button>
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t("asm.hint")}
      </p>

      {/* Columns workspace */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <div
          className="scrollbar-thin flex min-h-72 flex-1 items-stretch gap-3 overflow-x-auto rounded-xl border border-border bg-muted/20 p-3"
          role="group"
          aria-label={t("asm.columnsLabel")}
        >
          {docs.map((doc, docIndex) => (
            <DocColumn
              key={doc.id}
              doc={doc}
              docIndex={docIndex}
              docCount={docs.length}
              files={files}
              onRename={(name) =>
                apply((prev) => renameDoc(prev, doc.id, name), false)
              }
              onReverse={() =>
                apply((prev) => reverseDocPages(prev, doc.id), true)
              }
              onClear={() =>
                apply(
                  (prev) =>
                    deletePages(
                      prev,
                      doc.id,
                      doc.pages.map((_, index) => index)
                    ),
                  true
                )
              }
              onDelete={() =>
                apply((prev) => removeDoc(prev, doc.id), true)
              }
              onMoveToNeighbor={(fromIndex, direction) =>
                onMoveToNeighbor(doc.id, fromIndex, direction)
              }
              onDeletePage={(index) =>
                apply((prev) => deletePages(prev, doc.id, [index]), true)
              }
            />
          ))}

          {/* New document column (always-last affordance) */}
          <button
            type="button"
            onClick={onAddDoc}
            className="flex w-40 shrink-0 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-background/40 text-muted-foreground outline-none transition-colors hover:border-primary/50 hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-44"
          >
            <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Plus className="size-5" aria-hidden="true" />
            </span>
            <span className="px-3 text-center text-xs font-medium">
              {t("asm.newDoc")}
            </span>
          </button>
        </div>
      </DndContext>

      <DropZone
        labelKey="asm.addMore"
        multiple
        maxFiles={MAX_FILES}
        acceptKind="pdf"
        onAccept={addFiles}
        currentCount={files.length}
        className="py-2"
      />
    </section>
  );
}

/* ------------------------------ column ------------------------------ */

function DocColumn({
  doc,
  docIndex,
  docCount,
  files,
  onRename,
  onReverse,
  onClear,
  onDelete,
  onMoveToNeighbor,
  onDeletePage,
}: {
  doc: AsmDoc;
  docIndex: number;
  docCount: number;
  files: { id: string; file: File }[];
  onRename: (name: string) => void;
  onReverse: () => void;
  onClear: () => void;
  onDelete: () => void;
  onMoveToNeighbor: (fromIndex: number, direction: -1 | 1) => void;
  onDeletePage: (index: number) => void;
}) {
  const { t } = useI18n();

  const columnDropId = `col-drop-${doc.id}`;
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: columnDropId,
  });

  return (
    <div
      className="flex w-40 shrink-0 flex-col rounded-xl border border-border bg-background shadow-sm sm:w-44"
      role="group"
      aria-label={t("asm.docLabel", {
        name: doc.name,
        count: doc.pages.length,
      })}
    >
      {/* Header: editable name + count + column actions */}
      <div className="flex flex-col gap-1 border-b border-border px-2 pb-1.5 pt-2">
        <Input
          type="text"
          value={doc.name}
          spellCheck={false}
          autoComplete="off"
          maxLength={60}
          onChange={(event) => onRename(event.target.value)}
          aria-label={t("asm.docNameLabel", { name: doc.name })}
          className="h-8 rounded-md border-transparent bg-transparent px-1.5 text-xs font-semibold focus-visible:border-primary/40 focus-visible:bg-background"
        />
        <div className="flex items-center justify-between gap-1">
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {t("asm.docPageCount", { count: doc.pages.length })}
          </span>
          <div className="flex items-center gap-0.5">
            <ColumnAction
              label={t("asm.reverseDoc", { name: doc.name })}
              onClick={onReverse}
              disabled={doc.pages.length < 2}
            >
              <Redo2 className="size-3.5 scale-x-[-1]" aria-hidden="true" />
            </ColumnAction>
            <ColumnAction
              label={t("asm.clearDoc", { name: doc.name })}
              onClick={onClear}
              disabled={doc.pages.length === 0}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </ColumnAction>
            <ColumnAction
              label={t("asm.deleteDoc", { name: doc.name })}
              danger
              onClick={onDelete}
            >
              <span className="text-[13px] font-bold leading-none">×</span>
            </ColumnAction>
          </div>
        </div>
      </div>

      {/* Pages (droppable column body — catches drops even when empty) */}
      <SortableContext
        items={doc.pages.map((page) => page.uid)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setDropRef}
          className={cn(
            "scrollbar-thin flex min-h-40 flex-1 flex-col gap-2 overflow-y-auto p-2 transition-colors",
            isOver && "bg-primary/5 ring-1 ring-inset ring-primary/30"
          )}
        >
          {doc.pages.length === 0 ? (
            <p className="m-auto max-w-28 text-center text-[11px] leading-relaxed text-muted-foreground">
              {t("asm.emptyDoc")}
            </p>
          ) : (
            doc.pages.map((page, index) => (
              <AsmCell
                key={page.uid}
                page={page}
                index={index}
                total={doc.pages.length}
                docName={doc.name}
                file={
                  files.find((item) => item.id === page.fileId)?.file ?? null
                }
                sourcePage={page.page}
                hasPrevDoc={docIndex > 0}
                hasNextDoc={docIndex < docCount - 1}
                onMoveToNeighbor={onMoveToNeighbor}
                onDeletePage={onDeletePage}
              />
            ))
          )}
        </div>
      </SortableContext>
    </div>
  );
}

/** 32px column-header action (grid-cell CellAction precedent). */
function ColumnAction({
  label,
  danger,
  disabled,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-40",
        danger
          ? "text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

/* ------------------------------ page cell ------------------------------ */

function AsmCell({
  page,
  index,
  total,
  docName,
  file,
  sourcePage,
  hasPrevDoc,
  hasNextDoc,
  onMoveToNeighbor,
  onDeletePage,
}: {
  page: AsmPageRef;
  index: number;
  total: number;
  docName: string;
  file: File | null;
  sourcePage: number;
  hasPrevDoc: boolean;
  hasNextDoc: boolean;
  onMoveToNeighbor: (fromIndex: number, direction: -1 | 1) => void;
  onDeletePage: (index: number) => void;
}) {
  const { t } = useI18n();

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: page.uid });

  const label = t("asm.pageLabel", {
    page: index + 1,
    total,
    doc: docName,
    source: sourcePage + 1,
    file: file?.name ?? "",
  });

  return (
    <div
      ref={setNodeRef}
      data-asm-uid={page.uid}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "relative flex w-full touch-none select-none flex-col",
        isDragging && "z-20 scale-[1.03]"
      )}
      {...attributes}
      {...listeners}
      aria-label={label}
      title={label}
    >
      <div
        className={cn(
          "relative w-full overflow-hidden rounded-lg border border-border bg-background transition-colors",
          "cursor-grab hover:border-primary/40 hover:ring-1 hover:ring-primary/20 active:cursor-grabbing",
          isDragging && "shadow-xl ring-2 ring-primary/40"
        )}
        style={{ aspectRatio: 0.707 }}
      >
        <PageThumb file={file} pageIndex={sourcePage} />

        {/* Position badge (1-based inside this document) */}
        <span className="absolute left-1.5 top-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-background/90 px-1.5 text-[10px] font-bold text-foreground/80 shadow-sm backdrop-blur-sm">
          {index + 1}
        </span>
      </div>

      {/* Cross-column moves + delete — the a11y path (PRD hard rule) */}
      <div className="mt-1 flex items-center justify-between gap-0.5">
        <button
          type="button"
          aria-label={t("asm.moveLeft", { page: index + 1, doc: docName })}
          title={t("asm.moveLeft", { page: index + 1, doc: docName })}
          disabled={!hasPrevDoc}
          onClick={(event) => {
            event.stopPropagation();
            onMoveToNeighbor(index, -1);
          }}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-30"
        >
          <ArrowLeftToLine className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t("asm.cellDelete", { page: index + 1, doc: docName })}
          title={t("asm.cellDelete", { page: index + 1, doc: docName })}
          onClick={(event) => {
            event.stopPropagation();
            onDeletePage(index);
          }}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/60"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t("asm.moveRight", { page: index + 1, doc: docName })}
          title={t("asm.moveRight", { page: index + 1, doc: docName })}
          disabled={!hasNextDoc}
          onClick={(event) => {
            event.stopPropagation();
            onMoveToNeighbor(index, 1);
          }}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-30"
        >
          <ArrowRightToLine className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ thumbnail ------------------------------ */

/** Lazy page thumbnail: renders only while near the viewport (IO). */
function PageThumb({
  file,
  pageIndex,
}: {
  file: File | null;
  pageIndex: number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (file === null) return;
    const box = boxRef.current;
    if (box === null) return;

    let cancelled = false;
    let objectUrl: string | null = null;
    let observer: IntersectionObserver | null = null;

    const load = () => {
      void renderPdfThumbnail(file, {
        pageIndex,
        maxDim: THUMB_DIM,
      })
        .then((thumb) => {
          if (cancelled) return;
          objectUrl = URL.createObjectURL(thumb.blob);
          setUrl(objectUrl);
        })
        .catch(() => {
          /* unreadable page → placeholder stays */
        });
    };

    if (typeof IntersectionObserver === "undefined") {
      load();
      return () => {
        cancelled = true;
        if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
      };
    }

    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer?.disconnect();
          load();
        }
      },
      { rootMargin: "240px" }
    );
    observer.observe(box);

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [file, pageIndex]);

  return (
    <div
      ref={boxRef}
      className="absolute inset-0 flex items-center justify-center bg-muted/40"
    >
      {url !== null ? (
        <img
          src={url}
          alt=""
          draggable={false}
          className="size-full object-contain"
          loading="lazy"
        />
      ) : (
        <FileStack
          className="size-6 text-muted-foreground/50"
          aria-hidden="true"
        />
      )}
    </div>
  );
}
