"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CornerDownRight,
  IndentDecrease,
  IndentIncrease,
  ListTree,
  Loader2,
  Plus,
  TriangleAlert,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import type { ToolSurfaceProps } from "@/lib/tools/panel-types";
import { PDF_DOC_PARAMS, loadPdfjs } from "@/lib/pdf/pdfjs";
import { cn } from "@/lib/utils";
import { PreviewFileHeader } from "../stamp-common/preview-parts";
import {
  AUTO_MAX_PAGES,
  MAX_DEPTH,
  MAX_TITLE_LENGTH,
  appendChild,
  appendRoot,
  countNodes,
  findNode,
  indentNode,
  insertAfterNode,
  moveNode,
  outdentNode,
  removeNode,
  serializeTree,
  treeDepth,
  treeValid,
  updatePage,
  updateTitle,
  type BookmarkNode,
} from "./engine";

/**
 * Bookmark PDF surface (PRD §7.1 / §8.1) — the outline editor.
 *
 * A read-only pdf.js probe (the unlock-pdf pattern) loads the file's page
 * count and any existing outline into the editable tree; the user adds,
 * renames, nests (≤ MAX_DEPTH), reorders and deletes items; the tree
 * serializes to the "tree" option and the worker is the authority for
 * writing it (normalizeTree re-validates everything there).
 *
 * State writes follow the codebase rules: form controls write from event
 * handlers; the probe writes inside promise callbacks; the serialization
 * and run-gating effects mirror the extract-images surface.
 */

/** Import cap — a book-scale outline is unusable as rows anyway. */
const IMPORT_MAX_NODES = 300;

const BM_IDS = { tree: "tree" } as const;

type ProbeStatus = "working" | "done" | "error";

interface ProbeState {
  file: File;
  status: ProbeStatus;
  pageCount: number;
  imported: number;
  skippedLinks: number;
  truncated: boolean;
}

/** Breadth-first flattening so the cap keeps whole shallow levels. */
function collectOutline(
  items: Array<{ title: string | null; dest: unknown; items: unknown[] }>,
  resolvePage: (dest: unknown) => Promise<number | null>,
  cap: number
): Promise<{
  nodes: BookmarkNode[];
  imported: number;
  skippedLinks: number;
  truncated: boolean;
}> {
  return (async () => {
    let nextId = 1;
    let imported = 0;
    let skippedLinks = 0;
    let truncated = false;

    const walk = async (
      list: Array<{ title: string | null; dest: unknown; items: unknown[] }>,
      depth: number
    ): Promise<BookmarkNode[]> => {
      const out: BookmarkNode[] = [];
      for (const item of list) {
        if (imported >= cap) {
          truncated = true;
          break;
        }
        const page = await resolvePage(item.dest);
        if (page === null) {
          skippedLinks += 1;
          continue;
        }
        const node: BookmarkNode = {
          id: `i${nextId++}`,
          title: (item.title ?? "").slice(0, MAX_TITLE_LENGTH),
          page,
          children: [],
        };
        imported += 1;
        node.children =
          depth < MAX_DEPTH - 1 && Array.isArray(item.items)
            ? await walk(item.items as typeof list, depth + 1)
            : [];
        out.push(node);
      }
      return out;
    };

    const nodes = await walk(items, 0);
    return { nodes, imported, skippedLinks, truncated };
  })();
}

export function BookmarkSurface({
  files,
  values,
  onChange,
  setFileOrder,
  setRunBlocked,
}: ToolSurfaceProps): React.JSX.Element | null {
  const { t } = useI18n();
  const { toast } = useToast();
  const fileMeta = files[0];
  const file = fileMeta?.file ?? null;

  const [probe, setProbe] = useState<ProbeState | null>(null);
  const [tree, setTree] = useState<BookmarkNode[]>([]);
  /** Collapsed node ids (children hidden). */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const nextIdRef = useRef(1);

  /* ---------------- probe: page count + existing outline ---------------- */

  useEffect(() => {
    if (!file) return;
    let cancelled = false;

    void (async () => {
      // Reset first (microtask — never synchronously in the effect body).
      await Promise.resolve();
      if (cancelled) return;
      setProbe({ file, status: "working", pageCount: 0, imported: 0, skippedLinks: 0, truncated: false });
      try {
        const pdfjs = await loadPdfjs();
        const data = new Uint8Array(await file.arrayBuffer());
        const doc = await pdfjs.getDocument({ data, ...PDF_DOC_PARAMS }).promise;
        if (cancelled) {
          void doc.destroy().catch(() => undefined);
          return;
        }
        const pageCount = doc.numPages;
        let outline: Array<{ title: string | null; dest: unknown; items: unknown[] }> = [];
        try {
          outline = (await doc.getOutline()) ?? [];
        } catch {
          outline = []; // corrupt outline — start fresh, the run still works
        }

        const resolvePage = async (dest: unknown): Promise<number | null> => {
          try {
            let target = dest;
            if (typeof target === "string") {
              target = await doc.getDestination(target);
            }
            if (!Array.isArray(target) || target.length === 0) return null;
            const index = await doc.getPageIndex(target[0]);
            return index + 1;
          } catch {
            return null;
          }
        };

        const collected = await collectOutline(outline, resolvePage, IMPORT_MAX_NODES);
        await doc.destroy().catch(() => undefined);
        if (cancelled) return;

        // Only untitled roots get a real name; everything else keeps its title.
        const named = collected.nodes.map((node) => ({
          ...node,
          title: node.title.length > 0 ? node.title : t("bm.untitled"),
        }));

        nextIdRef.current = collected.imported + 1;
        setTree(named);
        setCollapsed(new Set());
        setProbe({
          file,
          status: "done",
          pageCount,
          imported: collected.imported,
          skippedLinks: collected.skippedLinks,
          truncated: collected.truncated,
        });
      } catch {
        if (cancelled) return;
        setProbe({ file, status: "error", pageCount: 0, imported: 0, skippedLinks: 0, truncated: false });
        // The worker may still load it (pdf-lib is laxer than pdf.js) —
        // leave the run enabled with an empty tree the user can build on.
      }
    })();

    return () => {
      cancelled = true;
    };
    // t is stable per locale; excluded to avoid re-probing on language flips.
  }, [file]);

  const activeProbe = probe !== null && probe.file === file ? probe : null;
  const pageCount = activeProbe?.pageCount ?? 0;
  const busy = activeProbe?.status === "working";

  /* ---------------- serialization + run gating ---------------- */

  useEffect(() => {
    onChange(BM_IDS.tree, serializeTree(tree));
  }, [tree, onChange]);

  const valid = treeValid(tree, Math.max(pageCount, 1));
  const blockedKey =
    tree.length === 0 ? "bm.ctaNothing" : !valid ? "bm.ctaInvalid" : null;
  useEffect(() => {
    setRunBlocked(blockedKey);
    return () => setRunBlocked(null);
  }, [blockedKey, setRunBlocked]);

  /* ---------------- tree operations ---------------- */

  const newNode = useCallback(
    (page: number, title: string): BookmarkNode => {
      const id = `u${nextIdRef.current++}`;
      return { id, title, page, children: [] };
    },
    []
  );

  const addRoot = useCallback((): void => {
    const page = Math.min(Math.max(1, tree.length + 1), Math.max(1, pageCount));
    setTree((prev) => appendRoot(prev, newNode(page, t("bm.newTitle"))));
  }, [tree.length, pageCount, newNode, t]);

  const addChild = useCallback(
    (id: string): void => {
      const parent = findNode(tree, id);
      const page = parent
        ? Math.min(parent.page + 1, Math.max(1, pageCount))
        : 1;
      setTree((prev) => appendChild(prev, id, newNode(page, t("bm.newTitle"))));
      // New children start visible: un-collapse the parent.
      setCollapsed((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [tree, pageCount, newNode, t]
  );

  const addAfter = useCallback(
    (id: string): void => {
      const anchor = findNode(tree, id);
      const page = anchor ? anchor.page : 1;
      setTree((prev) => insertAfterNode(prev, id, newNode(page, t("bm.newTitle"))));
    },
    [tree, newNode, t]
  );

  const onePerPage = useCallback((): void => {
    if (pageCount === 0) return;
    const capped = Math.min(pageCount, AUTO_MAX_PAGES);
    if (pageCount > AUTO_MAX_PAGES) {
      toast({ title: t("bm.autoCapped", { count: AUTO_MAX_PAGES }) });
    }
    setTree((prev) => {
      let next = prev;
      for (let page = 1; page <= capped; page += 1) {
        next = appendRoot(next, newNode(page, t("bm.autoTitle", { page })));
      }
      return next;
    });
  }, [pageCount, newNode, t, toast]);

  const clearAll = useCallback((): void => {
    setTree([]);
    setCollapsed(new Set());
  }, []);

  const toggleCollapse = useCallback((id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const removeFile = useCallback((): void => {
    setFileOrder([]);
  }, [setFileOrder]);

  const expandAll = useCallback((): void => setCollapsed(new Set()), []);
  const collapseAll = useCallback((): void => {
    const ids = new Set<string>();
    const walk = (list: BookmarkNode[]): void => {
      for (const node of list) {
        if (node.children.length > 0) ids.add(node.id);
        walk(node.children);
      }
    };
    walk(tree);
    setCollapsed(ids);
  }, [tree]);

  if (!file) return null;

  const total = countNodes(tree);
  const depth = treeDepth(tree);

  return (
    <section
      aria-label={t("bm.surfaceLabel")}
      className="flex flex-col gap-3"
    >
      <PreviewFileHeader
        file={file}
        pageCount={pageCount}
        onRemove={removeFile}
      />

      {/* Probe status */}
      <div aria-live="polite">
        {busy ? (
          <p
            role="status"
            className="flex items-center gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground"
          >
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            {t("bm.reading")}
          </p>
        ) : activeProbe?.status === "error" ? (
          <p className="flex items-start gap-2 rounded-card border border-border bg-muted/40 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t("bm.probeError")}
          </p>
        ) : null}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-card p-3">
        <Button
          type="button"
          className="h-11 min-h-11 rounded-btn px-4 text-xs font-semibold"
          onClick={addRoot}
          disabled={busy}
        >
          <Plus className="size-4" aria-hidden="true" />
          {t("bm.addRoot")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11 min-h-11 rounded-btn px-4 text-xs font-medium"
          onClick={onePerPage}
          disabled={busy || pageCount === 0}
        >
          <ListTree className="size-4" aria-hidden="true" />
          {t("bm.onePerPage")}
        </Button>
        <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="rounded-chip bg-cat-organize/10 px-2.5 py-1 font-semibold text-cat-organize">
            {t("bm.countChip", { count: total })}
          </span>
          {total > 0 ? (
            <span className="rounded-chip bg-muted px-2.5 py-1 font-medium">
              {t("bm.depthChip", { depth })}
            </span>
          ) : null}
          {total > 0 ? (
            <>
              <button
                type="button"
                onClick={expandAll}
                className="rounded-btn px-2 py-1 font-medium outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {t("bm.expandAll")}
              </button>
              <button
                type="button"
                onClick={collapseAll}
                className="rounded-btn px-2 py-1 font-medium outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {t("bm.collapseAll")}
              </button>
              <button
                type="button"
                onClick={clearAll}
                className="rounded-btn px-2 py-1 font-medium text-destructive outline-none hover:text-destructive/80 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {t("bm.clearAll")}
              </button>
            </>
          ) : null}
        </span>
      </div>

      {/* Imported honesty notes */}
      {activeProbe?.status === "done" && activeProbe.imported > 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("bm.importedNote", { count: activeProbe.imported })}
          {activeProbe.skippedLinks > 0
            ? ` ${t("bm.skippedLinksNote", { count: activeProbe.skippedLinks })}`
            : ""}
          {activeProbe.truncated
            ? ` ${t("bm.truncatedNote", { count: IMPORT_MAX_NODES })}`
            : ""}
        </p>
      ) : null}
      {activeProbe?.status === "done" && activeProbe.imported === 0 && !busy ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("bm.noOutlineNote")}
        </p>
      ) : null}

      {/* The tree */}
      <ol
        className="flex flex-col gap-1.5"
        aria-label={t("bm.treeLabel")}
        aria-busy={busy}
      >
        {tree.map((node, index) => (
          <BookmarkRow
            key={node.id}
            node={node}
            index={index}
            siblings={tree.length}
            pageCount={Math.max(pageCount, 1)}
            depth={0}
            collapsed={collapsed}
            tree={tree}
            setTree={setTree}
            onToggle={toggleCollapse}
            onAddChild={addChild}
            onAddAfter={addAfter}
          />
        ))}
      </ol>

      {tree.length === 0 && !busy ? (
        <p className="rounded-card border border-dashed border-border bg-muted/20 px-4 py-6 text-center text-xs text-muted-foreground">
          {t("bm.emptyTree")}
        </p>
      ) : null}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t("bm.replaceNote")}
      </p>
    </section>
  );
}

export default BookmarkSurface;

/* ------------------------------ row ------------------------------ */

interface RowProps {
  node: BookmarkNode;
  index: number;
  siblings: number;
  pageCount: number;
  depth: number;
  collapsed: ReadonlySet<string>;
  tree: BookmarkNode[];
  setTree: React.Dispatch<React.SetStateAction<BookmarkNode[]>>;
  onToggle: (id: string) => void;
  onAddChild: (id: string) => void;
  onAddAfter: (id: string) => void;
}

function BookmarkRow({
  node,
  index,
  siblings,
  pageCount,
  depth,
  collapsed,
  tree,
  setTree,
  onToggle,
  onAddChild,
  onAddAfter,
}: RowProps): React.JSX.Element {
  const { t } = useI18n();
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  const titleOk = node.title.trim().length > 0;
  const pageOk =
    Number.isInteger(node.page) && node.page >= 1 && node.page <= pageCount;
  const canIndent = index > 0 && depth < MAX_DEPTH - 1;
  const canOutdent = depth > 0;

  return (
    <li
      className={cn("list-none", depth > 0 && "ml-4 border-l border-border pl-2 sm:ml-6")}
    >
      <div
        className={cn(
          "flex flex-wrap items-center gap-1.5 rounded-card border bg-card p-2 transition-colors",
          titleOk && pageOk
            ? "border-border"
            : "border-destructive/50 bg-destructive/[0.04]"
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.id)}
            aria-label={isCollapsed ? t("bm.expandLabel", { title: node.title }) : t("bm.collapseLabel", { title: node.title })}
            aria-expanded={!isCollapsed}
            className="flex size-9 min-h-9 shrink-0 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {isCollapsed ? (
              <ChevronRight className="size-4" aria-hidden="true" />
            ) : (
              <ChevronDown className="size-4" aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className="w-4 shrink-0 sm:w-4" aria-hidden="true" />
        )}

        <Input
          value={node.title}
          onChange={(e) => setTree((prev) => updateTitle(prev, node.id, e.target.value))}
          placeholder={t("bm.titlePlaceholder")}
          maxLength={MAX_TITLE_LENGTH}
          aria-label={t("bm.titleLabel", { index: index + 1 })}
          aria-invalid={!titleOk}
          className="h-10 min-h-10 min-w-[140px] flex-1 rounded-btn text-sm"
        />

        <span className="flex items-center gap-1">
          <Input
            type="number"
            min={1}
            max={pageCount}
            value={Number.isFinite(node.page) ? node.page : 1}
            onChange={(e) => {
              const value = e.target.valueAsNumber;
              if (Number.isFinite(value)) {
                setTree((prev) => updatePage(prev, node.id, Math.round(value)));
              }
            }}
            aria-label={t("bm.pageLabel", { title: node.title })}
            aria-invalid={!pageOk}
            className={cn(
              "h-10 min-h-10 w-[4.5rem] rounded-btn text-center text-sm tabular-nums",
              !pageOk && "border-destructive focus-visible:ring-destructive/30"
            )}
          />
          <span className="text-[10px] text-muted-foreground" aria-hidden="true">
            /{pageCount}
          </span>
        </span>

        <span className="flex items-center gap-0.5">
          <IconBtn
            label={t("bm.addAfterLabel", { title: node.title })}
            onClick={() => onAddAfter(node.id)}
          >
            <Plus className="size-4" aria-hidden="true" />
          </IconBtn>
          <IconBtn
            label={t("bm.addChildLabel", { title: node.title })}
            onClick={() => onAddChild(node.id)}
            disabled={depth >= MAX_DEPTH - 1}
          >
            <CornerDownRight className="size-4" aria-hidden="true" />
          </IconBtn>
          <IconBtn
            label={t("bm.moveUpLabel", { title: node.title })}
            onClick={() => setTree((prev) => moveNode(prev, node.id, -1))}
            disabled={index === 0}
          >
            <ChevronUp className="size-4" aria-hidden="true" />
          </IconBtn>
          <IconBtn
            label={t("bm.moveDownLabel", { title: node.title })}
            onClick={() => setTree((prev) => moveNode(prev, node.id, 1))}
            disabled={index === siblings - 1}
          >
            <ChevronDown className="size-4" aria-hidden="true" />
          </IconBtn>
          <IconBtn
            label={t("bm.indentLabel", { title: node.title })}
            onClick={() => setTree((prev) => indentNode(prev, node.id))}
            disabled={!canIndent}
          >
            <IndentIncrease className="size-4" aria-hidden="true" />
          </IconBtn>
          <IconBtn
            label={t("bm.outdentLabel", { title: node.title })}
            onClick={() => setTree((prev) => outdentNode(prev, node.id))}
            disabled={!canOutdent}
          >
            <IndentDecrease className="size-4" aria-hidden="true" />
          </IconBtn>
          <IconBtn
            label={t("bm.deleteLabel", { title: node.title })}
            onClick={() => setTree((prev) => removeNode(prev, node.id))}
            danger
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </IconBtn>
        </span>
      </div>

      {hasChildren && !isCollapsed ? (
        <ol className="mt-1.5 flex flex-col gap-1.5">
          {node.children.map((child, childIndex) => (
            <BookmarkRow
              key={child.id}
              node={child}
              index={childIndex}
              siblings={node.children.length}
              pageCount={pageCount}
              depth={depth + 1}
              collapsed={collapsed}
              tree={tree}
              setTree={setTree}
              onToggle={onToggle}
              onAddChild={onAddChild}
              onAddAfter={onAddAfter}
            />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "flex size-9 min-h-9 shrink-0 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
        danger
          ? "hover:bg-destructive/10 hover:text-destructive"
          : "hover:bg-accent hover:text-foreground",
        disabled && "cursor-not-allowed opacity-35 hover:bg-transparent"
      )}
    >
      {children}
    </button>
  );
}
