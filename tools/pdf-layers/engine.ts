import {
  PdfError,
  type PdfRef,
  asDict,
  arrItems,
  catalogDict,
  decodeTextString,
  name,
  parsePdf,
  ref,
  resolve,
  rewriteDocument,
  type PdfObj,
  type ParsedPdf,
} from "@/lib/own/pdf";

/**
 * PDF layers engine (PHASE-3 batch 4) — Optional Content Groups (OCG)
 * surgery on OUR OWN parser + rewriter. Pure data functions so the smoke
 * drives them in Node; the surface reads the tree, the worker is the
 * authority for writes.
 *
 *  READ : catalog /OCProperties → /D config dict → /OCGs list + /Order
 *         display tree + /ON /OFF /Locked visibility sets. Layer names
 *         come from each OCG's /Name (UTF-16/latin1 TextString).
 *  WRITE: rewriteDocument with a rebuilt /D dict — toggles move refs
 *         between /ON and /OFF, adds append fresh OCG objects to /OCGs
 *         and /Order (child adds nest under the parent's Order slot),
 *         deletes strip the ref everywhere it appears.
 */

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

/** One layer as the UI sees it (a node in the /Order display tree). */
export interface LayerNode {
  /** Object number of the OCG dict — the stable id across the session. */
  num: number;
  name: string;
  visible: boolean;
  locked: boolean;
  depth: number;
  children: LayerNode[];
}

export interface LayerDoc {
  /** Display tree in /Order sequence (empty when the PDF has no OCGs). */
  tree: LayerNode[];
  /** Every OCG object number, including ones outside /Order. */
  all: number[];
}

export interface LayerOps {
  /** OCG object number → new visibility. */
  toggles?: Array<{ num: number; visible: boolean }>;
  /** New layers: top-level, or nested under a parent OCG number. */
  adds?: Array<{ name: string; parent?: number }>;
  /** OCG object numbers to remove entirely. */
  deletes?: number[];
}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

/** Decode a PDF TextString (the /Name of an OCG). */
function layerName(obj: PdfObj | undefined): string {
  if (obj?.k === "str" || obj?.k === "lstr" || obj?.k === "hstr") {
    try {
      return decodeTextString(obj.b).trim();
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * Flatten an /Order item (OCG ref or nested array) into tree nodes.
 * Nested arrays repeat the parent as their first element (PDF 32000-1
 * §8.11.2 /Order tree): when that parent was already emitted at an outer
 * level, its children attach to the EXISTING node instead of duplicating.
 */
function readOrderItem(
  doc: ParsedPdf,
  item: PdfObj,
  off: ReadonlySet<number>,
  locked: ReadonlySet<number>,
  depth: number,
  out: LayerNode[],
  seen: Set<number>,
  byNum: Map<number, LayerNode>
): void {
  if (depth > 16) return;
  if (item.k === "arr") {
    const items = item.items;
    if (items.length === 0) return;
    const head = items[0]!;
    let parent: LayerNode | null = null;
    if (head.k === "ref" && byNum.has(head.num)) {
      parent = byNum.get(head.num)!; // repeated parent — attach, don't dup
    } else {
      parent = readNode(head, doc, off, locked, depth, seen);
      if (parent !== null) {
        byNum.set(parent.num, parent);
        out.push(parent);
      }
    }
    if (parent === null) return;
    for (let i = 1; i < items.length; i += 1) {
      readOrderItem(doc, items[i]!, off, locked, depth + 1, parent.children, seen, byNum);
    }
    return;
  }
  const node = readNode(item, doc, off, locked, depth, seen);
  if (node !== null) {
    byNum.set(node.num, node);
    out.push(node);
  }
}

function readNode(
  item: PdfObj,
  doc: ParsedPdf,
  off: ReadonlySet<number>,
  locked: ReadonlySet<number>,
  depth: number,
  seen: Set<number>
): LayerNode | null {
  if (item.k !== "ref") return null;
  if (seen.has(item.num)) return null; // duplicate /Order entry — keep first
  const ocg = asDict(resolve(doc, item));
  if (ocg === null || ocg === undefined) return null;
  // Order slots may hold OCMD membership dicts — only real /OCG entries
  // are layers (lax files without /Type stay allowed via the /Name check).
  const type = ocg.get("Type");
  if (type?.k === "name" && type.v !== "OCG") return null;
  seen.add(item.num);
  return {
    num: item.num,
    name: layerName(ocg.get("Name")) || `Layer ${item.num}`,
    // OFF wins over ON for the initial state; not listed = default on.
    visible: !off.has(item.num),
    locked: locked.has(item.num),
    depth,
    children: [],
  };
}

/** Read the whole layer structure. Unknown/corrupt shapes degrade to []. */
export function readLayers(bytes: Uint8Array): LayerDoc {
  const doc = parsePdf(bytes);
  const catalog = catalogDict(doc);
  if (!catalog) return { tree: [], all: [] };
  const ocp = asDict(resolve(doc, catalog.get("OCProperties")));
  if (!ocp) return { tree: [], all: [] };

  const d = asDict(resolve(doc, ocp.get("D")));
  const ocgsArr = arrItems(ocp.get("OCGs")) ?? [];
  const allNums = ocgsArr
    .filter((o): o is PdfRef => o.k === "ref")
    .map((o) => o.num);

  const numSet = (key: string): Set<number> => {
    const out = new Set<number>();
    if (d === null) return out;
    const items = arrItems(d?.get(key)) ?? [];
    for (const item of items) {
      if (item.k === "ref") out.add(item.num);
    }
    return out;
  };
  const off = numSet("OFF");
  const on = numSet("ON");
  const locked = numSet("Locked");

  const tree: LayerNode[] = [];
  const seen = new Set<number>();
  const byNum = new Map<number, LayerNode>();
  const orderItems = arrItems(d?.get("Order")) ?? [];
  for (const item of orderItems) {
    readOrderItem(doc, item, off, locked, 0, tree, seen, byNum);
  }

  // OCGs outside /Order still show (flat, at the end) — honest completeness.
  for (const n of allNums) {
    if (!seen.has(n)) {
      const node = readNode(
        ref(n),
        doc,
        off,
        locked,
        0,
        new Set<number>()
      );
      if (node !== null) {
        seen.add(n);
        tree.push(node);
      }
    }
  }

  return { tree, all: allNums };
}

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

/** Rebuild the /Order array with adds + deletes applied (adds pre-numbered). */
function rebuildOrder(
  items: PdfObj[],
  deletes: ReadonlySet<number>,
  adds: ReadonlyArray<{ name: string; parent?: number }>,
  addNums: ReadonlyMap<string, number>
): PdfObj[] {
  const rewrite = (list: PdfObj[]): PdfObj[] => {
    const result: PdfObj[] = [];
    for (const item of list) {
      if (item.k === "arr") {
        const inner = rewrite(item.items);
        if (inner.length > 0) result.push({ k: "arr", items: inner });
        continue;
      }
      if (item.k === "ref" && deletes.has(item.num)) continue;
      result.push(item);
      // Child adds nest under this parent: spec format [parent, child] —
      // the repeated parent is what the /Order tree semantics expect.
      for (const add of adds) {
        if (item.k === "ref" && add.parent === item.num) {
          const n = addNums.get(`${add.name}::${add.parent}`);
          if (n !== undefined) result.push({ k: "arr", items: [item, ref(n)] });
        }
      }
    }
    return result;
  };

  const rewritten = rewrite(items);

  // Top-level adds (no parent, or a parent not present in the tree).
  const parentsInTree = new Set<number>();
  const collect = (list: PdfObj[]): void => {
    for (const item of list) {
      if (item.k === "arr") collect(item.items);
      else if (item.k === "ref") parentsInTree.add(item.num);
    }
  };
  collect(rewritten);
  for (const add of adds) {
    if (add.parent === undefined || !parentsInTree.has(add.parent)) {
      const n = addNums.get(`${add.name}::top`);
      if (n !== undefined) rewritten.push(ref(n));
    }
  }

  return rewritten;
}

export interface LayerWriteResult {
  bytes: Uint8Array;
  toggled: number;
  added: number;
  deleted: number;
}

/** Apply layer ops to the document (worker + smoke entry point). */
export function applyLayerOps(
  bytes: Uint8Array,
  ops: LayerOps
): LayerWriteResult {
  const doc = parsePdf(bytes);
  const catalog = catalogDict(doc);
  if (catalog === null) {
    throw new PdfError("corrupt", "no readable catalog");
  }

  const ocpRaw = asDict(resolve(doc, catalog.get("OCProperties")));
  const hadLayers = ocpRaw !== null;

  // Validate the ops against reality.
  const toggles = (ops.toggles ?? []).filter(
    (t) => Number.isInteger(t.num) && t.num >= 1 && t.num <= 5_000_000
  );
  const deletes = (ops.deletes ?? []).filter(
    (n) => Number.isInteger(n) && n >= 1 && n <= 5_000_000
  );
  const adds = (ops.adds ?? [])
    .map((a) => ({
      name:
        typeof a.name === "string"
          ? a.name.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120)
          : "",
      parent: a.parent,
    }))
    .filter((a) => a.name.length > 0);

  if (toggles.length === 0 && deletes.length === 0 && adds.length === 0) {
    throw new Error("pl.errorNothingToDo");
  }

  // Existing state (empty doc shapes are fine — adds can CREATE layers).
  const ocp = ocpRaw ?? new Map<string, PdfObj>();
  const dRaw = asDict(resolve(doc, ocp.get("D")));
  const d = dRaw ?? new Map<string, PdfObj>();

  const ocgsItems = arrItems(ocp.get("OCGs")) ?? [];
  const known = new Set(
    ocgsItems
      .filter((o): o is PdfRef => o.k === "ref")
      .map((o) => o.num)
  );
  const orderItems = arrItems(d?.get("Order")) ?? [];

  // Numbering above every existing object.
  let maxNum = 0;
  for (const n of doc.entries.keys()) {
    if (n > maxNum) maxNum = n;
  }
  const nextNum = { value: maxNum + 1 };

  const extraObjects: Array<{ num: number; obj: PdfObj }> = [];
  const addNums = new Map<string, number>();
  const deleteSet = new Set(deletes);

  // Pre-number every add (top-level keyed ::top, children keyed ::parent).
  const parentsInOrder = new Set<number>();
  {
    const collect = (list: PdfObj[]): void => {
      for (const item of list) {
        if (item.k === "arr") collect(item.items);
        else if (item.k === "ref") parentsInOrder.add(item.num);
      }
    };
    collect(orderItems);
  }
  for (const add of adds) {
    const key =
      add.parent !== undefined && parentsInOrder.has(add.parent)
        ? `${add.name}::${add.parent}`
        : `${add.name}::top`;
    if (!addNums.has(key)) {
      addNums.set(key, nextNum.value++);
    }
  }

  // Fresh OCG objects for the adds (visible by default: no /OFF entry).
  for (const add of adds) {
    const key =
      add.parent !== undefined && parentsInOrder.has(add.parent)
        ? `${add.name}::${add.parent}`
        : `${add.name}::top`;
    const use = addNums.get(key)!;
    extraObjects.push({
      num: use,
      obj: {
        k: "dict",
        m: new Map<string, PdfObj>([
          ["Type", name("OCG")],
          ["Name", { k: "str", b: new TextEncoder().encode(add.name) }],
        ]),
      },
    });
    known.add(use);
    ocgsItems.push(ref(use));
  }

  // Rebuild /Order with adds + deletes.
  const newOrder = rebuildOrder(orderItems, deleteSet, adds, addNums);

  // Visibility: rebuild /ON + /OFF from the requested toggles.
  const asRefSet = (key: string): number[] => {
    const items = arrItems(d?.get(key)) ?? [];
    return items
      .filter((o): o is PdfRef => o.k === "ref")
      .map((o) => o.num);
  };
  const onNums = new Set(asRefSet("ON"));
  const offNums = new Set(asRefSet("OFF"));
  let toggled = 0;
  for (const t of toggles) {
    if (t.visible) {
      if (!onNums.has(t.num)) toggled += 1;
      onNums.add(t.num);
      offNums.delete(t.num);
    } else {
      if (!offNums.has(t.num)) toggled += 1;
      offNums.add(t.num);
      onNums.delete(t.num);
    }
  }
  for (const n of deleteSet) {
    onNums.delete(n);
    offNums.delete(n);
  }
  const mkArr = (nums: Iterable<number>): PdfObj => ({
    k: "arr",
    items: Array.from(nums, (n) => ref(n)),
  });

  // New /D dict — preserve unknown keys (AS, Usage, RBGroups…) as-is.
  const newD = new Map<string, PdfObj>(d ?? []);
  newD.set("Order", { k: "arr", items: newOrder.length > 0 ? newOrder : orderItems });
  if (onNums.size > 0) newD.set("ON", mkArr(onNums));
  else newD.delete("ON");
  if (offNums.size > 0) newD.set("OFF", mkArr(offNums));
  else newD.delete("OFF");
  // Locked list survives (minus deleted).

  const newOcp = new Map<string, PdfObj>(ocp);
  newOcp.set("OCGs", { k: "arr", items: ocgsItems.filter((o) => !(o.k === "ref" && deleteSet.has(o.num))) });
  newOcp.set("D", ref(nextNum.value++));
  extraObjects.push({
    num: nextNum.value - 1,
    obj: { k: "dict", m: newD },
  });

  // Catalog replacement.
  const rootObj = doc.trailer.get("Root");
  if (!rootObj || rootObj.k !== "ref") {
    throw new PdfError("corrupt", "no catalog ref");
  }
  const newCatalog = new Map<string, PdfObj>(catalog);
  if (hadLayers || newOcp.size > 2 || ocgsItems.length > 0) {
    const ocpNum = nextNum.value++;
    extraObjects.push({
      num: ocpNum,
      obj: { k: "dict", m: newOcp },
    });
    newCatalog.set("OCProperties", ref(ocpNum));
  } else {
    newCatalog.delete("OCProperties");
  }

  const replacements = new Map<number, PdfObj>();
  replacements.set(rootObj.num, { k: "dict", m: newCatalog });

  const saved = rewriteDocument(doc, { replacements, extraObjects });
  return {
    bytes: saved,
    toggled,
    added: adds.length,
    deleted: deletes.length,
  };
}

/* ------------------------------------------------------------------ */
/* Fixture crafting (smoke + E2E) — a raw PDF with 2 OCGs              */
/* ------------------------------------------------------------------ */

/** A minimal but valid 1-page PDF with 2 OCGs (one hidden). */
export function craftOcgFixture(): Uint8Array {
  const parts: string[] = [];
  const add = (body: string): number => {
    parts.push(body);
    return parts.length; // object number
  };

  // Reserve numbers by appending in order (1..9).
  add(""); // 1 catalog (filled below)
  add(""); // 2 pages
  add(""); // 3 page
  add("<< /Length 44 >>\nstream\nq 1 0 0 1 100 700 cm 0 0 1 rg 0 0 200 100 re f Q\nendstream"); // 4 content
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"); // 5 font
  add("<< /Type /OCG /Name (Background) >>"); // 6 OCG 1
  add("<< /Type /OCG /Name (Annotations) >>"); // 7 OCG 2
  add("<< /Name (Annotations) /Type /OCMD >>"); // 8 OCMD (membership)
  add("<< /ON [6 0 R] /OFF [7 0 R] /Order [6 0 R [8 0 R]] >>"); // 9 D dict

  parts[0] =
    "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [6 0 R 7 0 R] /D 9 0 R >> >>";
  parts[1] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  parts[2] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>";

  let out = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    offsets[i] = out.length;
    out += `${i + 1} 0 obj\n${parts[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${parts.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    out += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${parts.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Array.from(out, (ch) => ch.charCodeAt(0) & 0xff));
}

/** Count /OFF occurrences helper for smokes (visibility assertions). */
export function offContains(
  bytes: Uint8Array,
  decoder: (b: Uint8Array) => string,
  ocgNum: number
): boolean {
  return decoder(bytes).includes(`/OFF [${ocgNum} 0 R]`);
}

