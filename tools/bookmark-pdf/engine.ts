import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  type PDFDocument,
  type PDFPage,
} from "pdf-lib";

/**
 * Bookmark PDF engine (PRD §7.1 / §8.1, Organize) — the outline tree model
 * (PURE, zero pdf-lib imports) + the outline writer (pdf-lib low-level
 * objects, no browser APIs) so the same code runs in the worker and under
 * bun in scripts/smoke-bookmark.ts.
 *
 * The PDF outline (PDF 32000-1 §12.3.3) is a tree of item dictionaries
 * linked through /First /Last /Prev /Next /Parent, owned by an /Outlines
 * root referenced from the catalog. pdf-lib has no outline API — the writer
 * below builds the dictionaries directly, including:
 *   /Title  PDFHexString (Unicode-safe: Devanagari works),
 *   /Dest   [pageRef /XYZ null top null] (top of the destination page,
 *           zoom retained — what "jump to page" means in every viewer),
 *   /Count  positive = open (root: total items; item: visible descendants).
 * The catalog also gets /PageMode /UseOutlines so viewers OPEN the
 * bookmarks panel on load.
 *
 * REPLACE semantics: the existing outline (if any) is walked and its
 * objects deleted from the context so the output carries exactly the tree
 * the user built — no orphan bloat, no mixed old/new items.
 */

/* ------------------------------------------------------------------ */
/* Tree model                                                          */
/* ------------------------------------------------------------------ */

export interface BookmarkNode {
  /** Stable identity for React keys and tree edits (never serialized). */
  id: string;
  /** Display title, 1..MAX_TITLE_LENGTH after trim. */
  title: string;
  /** 1-based destination page, clamped 1..pageCount by normalizeTree. */
  page: number;
  children: BookmarkNode[];
}

/** UI depth cap — viewers nest arbitrarily; editors get confusing past 6. */
export const MAX_DEPTH = 6;
export const MAX_TITLE_LENGTH = 200;
/** "One per page" cap — beyond this the editor becomes a wall of rows. */
export const AUTO_MAX_PAGES = 100;

/* ------------------------------------------------------------------ */
/* Pure tree operations (immutable — every op returns a new tree)       */
/* ------------------------------------------------------------------ */

/** Total nodes in the tree. */
export function countNodes(nodes: BookmarkNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += 1 + countNodes(node.children);
  }
  return total;
}

/** Root = depth 1. */
export function treeDepth(nodes: BookmarkNode[]): number {
  let max = 0;
  for (const node of nodes) {
    max = Math.max(max, 1 + treeDepth(node.children));
  }
  return max;
}

/** The node with `id`, or null. */
export function findNode(
  nodes: BookmarkNode[],
  id: string
): BookmarkNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findNode(node.children, id);
    if (hit !== null) return hit;
  }
  return null;
}

export function updateTitle(
  nodes: BookmarkNode[],
  id: string,
  title: string
): BookmarkNode[] {
  return nodes.map((node) =>
    node.id === id
      ? { ...node, title: title.slice(0, MAX_TITLE_LENGTH) }
      : { ...node, children: updateTitle(node.children, id, title) }
  );
}

export function updatePage(
  nodes: BookmarkNode[],
  id: string,
  page: number
): BookmarkNode[] {
  return nodes.map((node) =>
    node.id === id
      ? { ...node, page }
      : { ...node, children: updatePage(node.children, id, page) }
  );
}

/** Removes the node + its whole subtree. */
export function removeNode(nodes: BookmarkNode[], id: string): BookmarkNode[] {
  const out: BookmarkNode[] = [];
  for (const node of nodes) {
    if (node.id === id) continue;
    out.push({ ...node, children: removeNode(node.children, id) });
  }
  return out;
}

/** Appends `node` as the LAST child of the node with `id`. */
export function appendChild(
  nodes: BookmarkNode[],
  id: string,
  node: BookmarkNode
): BookmarkNode[] {
  return nodes.map((current) =>
    current.id === id
      ? { ...current, children: [...current.children, node] }
      : { ...current, children: appendChild(current.children, id, node) }
  );
}

/** Appends `node` at the ROOT level (bottom of the list). */
export function appendRoot(
  nodes: BookmarkNode[],
  node: BookmarkNode
): BookmarkNode[] {
  return [...nodes, node];
}

/** Inserts `node` directly after the anchor node (its next sibling). */
export function insertAfterNode(
  nodes: BookmarkNode[],
  anchorId: string,
  node: BookmarkNode
): BookmarkNode[] {
  const out: BookmarkNode[] = [];
  for (const current of nodes) {
    if (current.id === anchorId) {
      out.push({ ...current, children: [...current.children] });
      out.push(node);
    } else {
      out.push({
        ...current,
        children: insertAfterNode(current.children, anchorId, node),
      });
    }
  }
  return out;
}

/**
 * Moves the node with `id` one slot up/down within its parent's children.
 * No-op at the list boundary.
 */
export function moveNode(
  nodes: BookmarkNode[],
  id: string,
  dir: -1 | 1
): BookmarkNode[] {
  const index = nodes.findIndex((node) => node.id === id);
  if (index !== -1) {
    const target = index + dir;
    if (target < 0 || target >= nodes.length) return nodes;
    const next = [...nodes];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    return next;
  }
  let changed = false;
  const out = nodes.map((node) => {
    const children = moveNode(node.children, id, dir);
    if (children !== node.children) changed = true;
    return changed && children !== node.children
      ? { ...node, children }
      : { ...node, children };
  });
  return changed ? out : nodes;
}

/**
 * Indent: the node becomes the LAST CHILD of its previous sibling (so the
 * visual order never changes). No-op without a previous sibling or when
 * the parent is already at MAX_DEPTH.
 */
export function indentNode(
  nodes: BookmarkNode[],
  id: string,
  depth = 0
): BookmarkNode[] {
  const index = nodes.findIndex((node) => node.id === id);
  if (index > 0) {
    if (depth >= MAX_DEPTH - 1) return nodes; // child would exceed cap
    const previous = nodes[index - 1];
    const moved = nodes[index];
    const out = nodes.filter((_, i) => i !== index);
    out[index - 1] = {
      ...previous,
      children: [...previous.children, moved],
    };
    return out;
  }
  let changed = false;
  const out = nodes.map((node) => {
    if (node.children.some((child) => child.id === id) || true) {
      const children = indentNode(node.children, id, depth + 1);
      if (children !== node.children) {
        changed = true;
        return { ...node, children };
      }
    }
    return node;
  });
  return changed ? out : nodes;
}

/**
 * Outdent: the node becomes the NEXT SIBLING of its parent (visual order
 * kept). No-op at the root level.
 */
export function outdentNode(nodes: BookmarkNode[], id: string): BookmarkNode[] {
  const out: BookmarkNode[] = [];
  for (const node of nodes) {
    const childIndex = node.children.findIndex(
      (child) => child.id === id
    );
    if (childIndex !== -1) {
      const moved = node.children[childIndex];
      const keptChildren = node.children.filter(
        (_, i) => i !== childIndex
      );
      const shrunk = { ...node, children: keptChildren };
      out.push(shrunk);
      out.push(moved);
      continue;
    }
    out.push({ ...node, children: outdentNode(node.children, id) });
  }
  return out;
}

/** True when every node has a non-empty title and a page in 1..pageCount. */
export function treeValid(nodes: BookmarkNode[], pageCount: number): boolean {
  const check = (list: BookmarkNode[]): boolean => {
    for (const node of list) {
      if (node.title.trim().length === 0) return false;
      if (
        !Number.isInteger(node.page) ||
        node.page < 1 ||
        node.page > pageCount
      ) {
        return false;
      }
      if (!check(node.children)) return false;
    }
    return true;
  };
  return check(nodes);
}

/* ------------------------------------------------------------------ */
/* Serialization (the tree rides the options payload)                  */
/* ------------------------------------------------------------------ */

interface SerializedNode {
  t: string;
  p: number;
  c: SerializedNode[];
}

/** Compact JSON: {"v":1,"n":[{t,p,c}]}. */
export function serializeTree(nodes: BookmarkNode[]): string {
  const pack = (list: BookmarkNode[]): SerializedNode[] =>
    list.map((node) => ({
      t: node.title,
      p: node.page,
      c: pack(node.children),
    }));
  return JSON.stringify({ v: 1, n: pack(nodes) });
}

/**
 * Parses + validates a serialized tree. Unreadable input, bad shapes,
 * empty titles and out-of-range pages are DROPPED (the worker never ships
 * a bookmark a viewer would ignore). Depth is clamped to MAX_DEPTH.
 * Fresh ids are assigned — the ids never leave the surface.
 */
export function normalizeTree(
  raw: unknown,
  pageCount: number
): BookmarkNode[] {
  const pages = Math.max(1, Math.floor(pageCount));
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : "");
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const root = parsed as { n?: unknown };
  if (!Array.isArray(root.n)) return [];
  let nextId = 1;
  const unpack = (list: unknown[], depth: number): BookmarkNode[] => {
    const out: BookmarkNode[] = [];
    for (const entry of list) {
      if (entry === null || typeof entry !== "object") continue;
      const { t, p, c } = entry as { t?: unknown; p?: unknown; c?: unknown };
      const title =
        typeof t === "string" ? t.trim().slice(0, MAX_TITLE_LENGTH) : "";
      if (title.length === 0) continue;
      let page = typeof p === "number" ? Math.round(p) : 1;
      if (!Number.isFinite(page) || page < 1) page = 1;
      if (page > pages) page = pages;
      const children =
        depth < MAX_DEPTH - 1 && Array.isArray(c)
          ? unpack(c, depth + 1)
          : [];
      out.push({ id: `n${nextId++}`, title, page, children });
    }
    return out;
  };
  return unpack(root.n, 0);
}

/* ------------------------------------------------------------------ */
/* The pdf-lib outline writer (worker + smoke share this)               */
/* ------------------------------------------------------------------ */

export interface OutlineWriteReport {
  /** Items written (total nodes). */
  written: number;
  /** Objects of the replaced outline that were deleted. */
  removed: number;
  /** Root /Count (total items). */
  rootCount: number;
}

/**
 * Collects the item dict REFS reachable from an existing /Outlines root
 * (First child chains + Next sibling chains) so the writer can delete
 * them before installing the new tree. Cycle-safe (visited set) —
 * corrupt outlines never loop.
 */
function collectOutlineItems(
  context: { lookup(ref: unknown): unknown },
  rootRef: unknown
): PDFRef[] {
  const refs: PDFRef[] = [];
  const seen = new Set<number>();
  const visitDict = (dict: PDFDict): void => {
    for (const key of ["First", "Next"] as const) {
      const link = dict.get(PDFName.of(key));
      if (!(link instanceof PDFRef)) continue;
      if (seen.has(link.objectNumber)) continue;
      seen.add(link.objectNumber);
      refs.push(link);
      const child = context.lookup(link);
      if (child instanceof PDFDict) visitDict(child);
    }
  };
  const root = rootRef instanceof PDFRef ? context.lookup(rootRef) : rootRef;
  if (root instanceof PDFDict) visitDict(root);
  return refs;
}

/** Top of the page's visible area (CropBox preferred, else MediaBox). */
function pageTop(page: PDFPage): number {
  for (const key of ["CropBox", "MediaBox"] as const) {
    const box = page.node.lookupMaybe(PDFName.of(key), PDFArray);
    if (box === undefined || box.size() < 4) continue;
    const top = box.lookupMaybe(3, PDFNumber);
    const bottom = box.lookupMaybe(1, PDFNumber);
    if (top !== undefined && bottom !== undefined) {
      return Math.max(top.asNumber(), bottom.asNumber());
    }
  }
  return 842; // A4 fallback
}

/**
 * Writes `tree` as the document's outline, REPLACING any existing one
 * (old item objects are deleted from the context), and sets
 * /PageMode /UseOutlines so viewers open the bookmarks panel.
 *
 * Every item points at the TOP of its destination page with the zoom
 * retained (/XYZ null top null) — the universal "go to page" behavior.
 */
export function writeOutline(
  doc: PDFDocument,
  tree: BookmarkNode[]
): OutlineWriteReport {
  const context = doc.context;
  const pages = doc.getPages();
  const pageCount = pages.length;

  // 1. Remove the existing outline root + every reachable item.
  let removed = 0;
  const existingRootRef = doc.catalog.get(PDFName.of("Outlines"));
  if (existingRootRef !== undefined) {
    for (const ref of collectOutlineItems(context, existingRootRef)) {
      context.delete(ref);
      removed += 1;
    }
    if (existingRootRef instanceof PDFRef) {
      context.delete(existingRootRef);
      removed += 1;
    }
  }

  const report: OutlineWriteReport = {
    written: 0,
    removed,
    rootCount: 0,
  };
  if (tree.length === 0 || pageCount === 0) {
    doc.catalog.delete(PDFName.of("Outlines"));
    doc.catalog.delete(PDFName.of("PageMode"));
    return report;
  }

  // 2. Build items depth-first; sibling links are patched per level once
  //    every child exists (item i's /Prev is item i-1's ref).
  const buildItem = (
    node: BookmarkNode,
    parentRef: PDFRef
  ): { ref: PDFRef; count: number } => {
    const page =
      pages[Math.min(Math.max(node.page, 1), pageCount) - 1];
    const dest = context.obj([
      page.ref,
      PDFName.of("XYZ"),
      null,
      pageTop(page),
      null,
    ]);
    const dict = context.obj({
      Title: PDFHexString.fromText(node.title),
      Dest: dest,
      Parent: parentRef,
    });
    const ref = context.register(dict);
    report.written += 1;

    let count = 0;
    if (node.children.length > 0) {
      const childRefs: { ref: PDFRef; count: number }[] = [];
      for (const child of node.children) {
        childRefs.push(buildItem(child, ref));
      }
      for (let i = 0; i < childRefs.length; i += 1) {
        const childDict = context.lookup(childRefs[i].ref, PDFDict);
        if (i > 0) childDict.set(PDFName.of("Prev"), childRefs[i - 1].ref);
        if (i < childRefs.length - 1) {
          childDict.set(PDFName.of("Next"), childRefs[i + 1].ref);
        }
        count += 1 + childRefs[i].count;
      }
      const parentDict = context.lookup(ref, PDFDict);
      parentDict.set(PDFName.of("First"), childRefs[0].ref);
      parentDict.set(
        PDFName.of("Last"),
        childRefs[childRefs.length - 1].ref
      );
      parentDict.set(PDFName.of("Count"), PDFNumber.of(count));
    }
    return { ref, count };
  };

  // 3. Root level + the /Outlines root dict.
  const outlinesDict = context.obj({ Type: PDFName.of("Outlines") });
  const outlinesRef = context.register(outlinesDict);

  const rootRefs: { ref: PDFRef; count: number }[] = [];
  for (const node of tree) {
    rootRefs.push(buildItem(node, outlinesRef));
  }
  for (let i = 0; i < rootRefs.length; i += 1) {
    const itemDict = context.lookup(rootRefs[i].ref, PDFDict);
    if (i > 0) itemDict.set(PDFName.of("Prev"), rootRefs[i - 1].ref);
    if (i < rootRefs.length - 1) {
      itemDict.set(PDFName.of("Next"), rootRefs[i + 1].ref);
    }
  }
  outlinesDict.set(PDFName.of("First"), rootRefs[0].ref);
  outlinesDict.set(PDFName.of("Last"), rootRefs[rootRefs.length - 1].ref);
  report.rootCount = report.written;
  outlinesDict.set(PDFName.of("Count"), PDFNumber.of(report.written));

  doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
  return report;
}

/** Maps any worker failure to the i18n key the UI shows. */
export function classifyBookmarkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/encrypt/i.test(message)) return "tool.errorEncrypted";
  if (/bad-?tree|empty-?tree/i.test(message)) return "bm.errorEmptyTree";
  return "tool.errorCorrupt";
}
