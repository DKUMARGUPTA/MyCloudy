import {
  arr,
  catalogDict,
  listPages,
  name,
  newDict,
  num,
  parsePdf,
  pdfInfoText,
  PdfError,
  ref,
  rewriteDocument,
  type PdfObj,
  type ParsedPdf,
  type PdfPageInfo,
} from "@/lib/own/pdf";

/**
 * Bookmark PDF engine (PRD §7.1 / §8.1, Organize) — the outline tree model
 * (PURE) + the outline writer (OWN ENGINE low-level objects, no browser
 * APIs) so the same code runs in the worker and under bun in
 * scripts/smoke-bookmark.ts.
 *
 * The PDF outline (PDF 32000-1 §12.3.3) is a tree of item dictionaries
 * linked through /First /Last /Prev /Next /Parent, owned by an /Outlines
 * root referenced from the catalog. The writer below builds the
 * dictionaries directly on the preserve-numbers rewriter seam (the
 * facturx-attach / meta-common precedents), including:
 *   /Title  <FEFF…> UTF-16BE hex (Unicode-safe: Devanagari works),
 *   /Dest   [pageRef /XYZ null top null] (top of the destination page,
 *           zoom retained — what "jump to page" means in every viewer),
 *   /Count  positive = open (root: total items; item: visible descendants).
 * The catalog also gets /PageMode /UseOutlines so viewers OPEN the
 * bookmarks panel on load.
 *
 * REPLACE semantics: the existing outline (if any) is walked and its
 * objects deleted (rewriteDocument deletions — object-level removal) so
 * the output carries exactly the tree the user built — no orphan bloat,
 * no mixed old/new items. New items ride extraObjects ABOVE the source
 * numbering; output packs object streams (pdf-lib save parity).
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
/* The own-engine outline writer (worker + smoke share this)           */
/* ------------------------------------------------------------------ */

export interface OutlineWriteReport {
  /** Items written (total nodes). */
  written: number;
  /** Objects of the replaced outline that were deleted. */
  removed: number;
  /** Root /Count (total items). */
  rootCount: number;
}

/** writeOutline result — the rewritten bytes + the honest report. */
export interface OutlineWriteResult {
  bytes: Uint8Array;
  report: OutlineWriteReport;
  pageCount: number;
}

/**
 * The document's page count (worker pre-pass — the tree normalizer needs
 * the REAL count before anything is written). Typed refusals match the
 * writer: encrypted → PdfError("encrypted"), broken trees → corrupt.
 */
export function outlinePageCount(pdfBytes: Uint8Array): number {
  return listPages(parsePdf(pdfBytes)).length;
}

/**
 * Collects the item OBJECT NUMBERS reachable from an existing /Outlines
 * root (First child chains + Next sibling chains) so the rewrite can
 * delete them before installing the new tree. Cycle-safe (visited set) —
 * corrupt outlines never loop.
 */
function collectOutlineObjects(
  doc: ParsedPdf,
  rootValue: PdfObj | undefined
): Set<number> {
  const dead = new Set<number>();
  const visit = (obj: PdfObj | undefined): void => {
    if (!obj || (obj.k !== "dict" && obj.k !== "stream")) return;
    for (const key of ["First", "Next"] as const) {
      const link = obj.m.get(key);
      if (!link || link.k !== "ref") continue;
      if (dead.has(link.num)) continue;
      dead.add(link.num);
      visit(doc.getObject(link.num));
    }
  };
  if (rootValue && rootValue.k === "ref") {
    dead.add(rootValue.num);
    visit(doc.getObject(rootValue.num));
  } else {
    visit(rootValue);
  }
  return dead;
}

/** Top of the page's visible area (CropBox preferred, else MediaBox). */
function pageTop(page: PdfPageInfo): number {
  const [, y0, , y1] = page.cropBox;
  return Math.max(y1, y0);
}

/** The null object (arr member form). */
const NULL: PdfObj = { k: "null" };

/**
 * Writes `tree` as the document's outline, REPLACING any existing one
 * (old item objects deleted via rewriteDocument deletions), and sets
 * /PageMode /UseOutlines so viewers open the bookmarks panel.
 *
 * Every item points at the TOP of its destination page with the zoom
 * retained (/XYZ null top null) — the universal "go to page" behavior.
 * Parse is strict: encrypted sources refuse with the typed PdfError
 * (classifyBookmarkError maps it to tool.errorEncrypted).
 */
export function writeOutline(
  pdfBytes: Uint8Array,
  tree: BookmarkNode[]
): OutlineWriteResult {
  const doc = parsePdf(pdfBytes);
  const catalog = catalogDict(doc);
  if (catalog === null) {
    throw new PdfError("corrupt", "source has no readable catalog");
  }
  const pages = listPages(doc);
  const pageCount = pages.length;

  // 1. Remove the existing outline root + every reachable item.
  const deletions = collectOutlineObjects(doc, catalog.get("Outlines"));
  const report: OutlineWriteReport = {
    written: 0,
    removed: deletions.size,
    rootCount: 0,
  };
  if (tree.length === 0 || pageCount === 0) {
    catalog.delete("Outlines");
    catalog.delete("PageMode");
    return {
      bytes: rewriteDocument(doc, { deletions, objectStreams: true }),
      report,
      pageCount,
    };
  }

  // 2. Build items depth-first as extraObjects ABOVE the source numbering
  //    (sibling links patched per level once every child exists — item i's
  //    /Prev is item i-1's ref).
  let nextNum = 0;
  for (const numKey of doc.entries.keys()) nextNum = Math.max(nextNum, numKey);
  nextNum += 1;
  const extras: Array<{ num: number; obj: PdfObj }> = [];

  const outlinesDict = newDict([["Type", name("Outlines")]]);
  const outlinesNum = nextNum++;
  extras.push({ num: outlinesNum, obj: outlinesDict });
  const outlinesRef = ref(outlinesNum);

  /** Depth-first build; returns the item's dict + TOTAL descendant count
   *  (the /Count a viewer shows — all levels, the pdf-lib writer's exact
   *  semantics). */
  const buildItem = (
    node: BookmarkNode,
    parentRef: PdfObj
  ): { itemNum: number; itemDict: { k: "dict"; m: Map<string, PdfObj> }; count: number } => {
    const page = pages[Math.min(Math.max(node.page, 1), pageCount) - 1]!;
    const dest = arr(page.ref, name("XYZ"), NULL, num(pageTop(page)), NULL);
    const itemNum = nextNum++;
    const itemDict = newDict([
      ["Title", pdfInfoText(node.title)],
      ["Dest", dest],
      ["Parent", parentRef],
    ]);
    extras.push({ num: itemNum, obj: itemDict });
    report.written += 1;

    let count = 0;
    if (node.children.length > 0) {
      const childNums: number[] = [];
      const childDicts: Array<Map<string, PdfObj>> = [];
      const childCounts: number[] = [];
      for (const child of node.children) {
        const built = buildItem(child, ref(itemNum));
        childNums.push(built.itemNum);
        childDicts.push(built.itemDict.m);
        childCounts.push(built.count);
      }
      for (let i = 0; i < childNums.length; i += 1) {
        if (i > 0) childDicts[i]!.set("Prev", ref(childNums[i - 1]!));
        if (i < childNums.length - 1) {
          childDicts[i]!.set("Next", ref(childNums[i + 1]!));
        }
        count += 1 + childCounts[i]!;
      }
      itemDict.m.set("First", ref(childNums[0]!));
      itemDict.m.set("Last", ref(childNums[childNums.length - 1]!));
      itemDict.m.set("Count", num(count));
    }
    return { itemNum, itemDict, count };
  };

  // 3. Root level: items + the /Outlines root wiring.
  const rootNums: number[] = [];
  const rootDicts: Array<Map<string, PdfObj>> = [];
  for (const node of tree) {
    const built = buildItem(node, outlinesRef);
    rootNums.push(built.itemNum);
    rootDicts.push(built.itemDict.m);
  }
  for (let i = 0; i < rootNums.length; i += 1) {
    if (i > 0) rootDicts[i]!.set("Prev", ref(rootNums[i - 1]!));
    if (i < rootNums.length - 1) {
      rootDicts[i]!.set("Next", ref(rootNums[i + 1]!));
    }
  }
  outlinesDict.m.set("First", ref(rootNums[0]!));
  outlinesDict.m.set("Last", ref(rootNums[rootNums.length - 1]!));
  report.rootCount = report.written;
  outlinesDict.m.set("Count", num(report.written));

  catalog.set("Outlines", outlinesRef);
  catalog.set("PageMode", name("UseOutlines"));

  return {
    bytes: rewriteDocument(doc, { deletions, extraObjects: extras, objectStreams: true }),
    report,
    pageCount,
  };
}

/** Maps any worker failure to the i18n key the UI shows. */
export function classifyBookmarkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/encrypt/i.test(message)) return "tool.errorEncrypted";
  if (/bad-?tree|empty-?tree/i.test(message)) return "bm.errorEmptyTree";
  return "tool.errorCorrupt";
}
