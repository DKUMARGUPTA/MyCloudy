import type { OptionValues } from "@/lib/tools/config-types";
import {
  type PdfObj,
  type ParsedPdf,
  type PdfRef,
  asDict,
  asName,
  dget,
} from "@/lib/own/pdf";

/**
 * Sanitize PDF planning (PHASE-1 Batch A): compute the object-graph
 * surgery that removes active content from a parsed document —
 *
 *   stripJavaScript   → catalog /Names /JavaScript tree (every reachable
 *                       indirect object of that subtree is collected for
 *                       deletion so nothing rides along dead).
 *   stripEmbeddedFiles→ catalog /Names /EmbeddedFiles tree + catalog /AF.
 *   stripActions      → catalog /OpenAction + catalog /AA + every page's
 *                       /AA + annotation /A & /AA whose /S is an external
 *                       or script subtype (Launch/URI/Sound/Movie/
 *                       JavaScript/SubmitForm/ImportData/GoToR/GoToE).
 *                       Internal /GoTo and /Named survive.
 *   stripMetadata     → catalog /Metadata (XMP stream) collected for
 *                       deletion; the trailer /Info is dropped by the
 *                       rewriteDocument `dropInfo` option.
 *
 * The plan is { replacements, deletions, dropInfo, findings } — the worker
 * feeds it straight into rewriteDocument. Pure planning over the parsed
 * doc: no byte writes here, fully smoke-testable.
 */

export const SZ_IDS = {
  stripJavaScript: "stripJavaScript",
  stripEmbeddedFiles: "stripEmbeddedFiles",
  stripActions: "stripActions",
  stripMetadata: "stripMetadata",
} as const;

export interface SanitizeOptions {
  stripJavaScript: boolean;
  stripEmbeddedFiles: boolean;
  stripActions: boolean;
  stripMetadata: boolean;
}

export const SANITIZE_DEFAULTS: SanitizeOptions = {
  stripJavaScript: true,
  stripEmbeddedFiles: true,
  stripActions: true,
  stripMetadata: false,
};

export function resolveSanitizeOptions(
  values: OptionValues
): SanitizeOptions {
  return {
    stripJavaScript: values[SZ_IDS.stripJavaScript] !== false,
    stripEmbeddedFiles: values[SZ_IDS.stripEmbeddedFiles] !== false,
    stripActions: values[SZ_IDS.stripActions] !== false,
    stripMetadata: values[SZ_IDS.stripMetadata] === true,
  };
}

export interface SanitizeFindings {
  /** Document-level JavaScript entries found (name-tree leaves). */
  javascript: number;
  /** Embedded files found. */
  embeddedFiles: number;
  /** External/trigger actions removed (OpenAction, /AA, annot /A). */
  actions: number;
  /** True when the XMP metadata stream and/or /Info were removed. */
  metadata: boolean;
  /** Per-page annotation actions kept internal (informational). */
  pagesTouched: number;
}

export interface SanitizePlan {
  /** Object number → replacement object (cleaned dicts). */
  replacements: Map<number, PdfObj>;
  /** Object numbers to omit from the output entirely. */
  deletions: Set<number>;
  /** Drop the trailer /Info (metadata strip). */
  dropInfo: boolean;
  findings: SanitizeFindings;
}

/** Annotation action subtypes considered external/active. */
const DANGEROUS_ACTIONS = new Set([
  "Launch",
  "URI",
  "Sound",
  "Movie",
  "JavaScript",
  "SubmitForm",
  "ResetForm",
  "ImportData",
  "GoToR",
  "GoToE",
  "Hide",
  "SetOCGState",
  "Thread",
]);

/** Best-effort latin1 string of raw bytes (name-tree keys). */
function latin1Str(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]!);
  return s;
}

function isRef(o: PdfObj | undefined): o is PdfRef {
  return !!o && o.k === "ref";
}

function cloneDictDrop(
  source: Map<string, PdfObj>,
  drop: string[]
): Map<string, PdfObj> {
  const m = new Map<string, PdfObj>(source);
  for (const key of drop) m.delete(key);
  return m;
}

/**
 * Walk a PDF name tree (or name-node dict) and call `visit(key, value)` for
 * every leaf pair. Collects every INDIRECT ref encountered on the way
 * (Kids chains + leaf values) into `refs` for deletion planning.
 */
function walkNameTree(
  doc: ParsedPdf,
  node: PdfObj,
  visit: (key: string | undefined, value: PdfObj) => void,
  refs: Set<number>,
  depth: number
): void {
  if (depth > 32) return;
  const dict = asDict(node);
  if (!dict) return;
  const kids = dict.get("Kids");
  if (kids?.k === "arr") {
    for (const kid of kids.items) {
      if (isRef(kid)) {
        refs.add(kid.num);
        const resolved = doc.getObject(kid.num);
        if (resolved) {
          walkNameTree(doc, resolved, visit, refs, depth + 1);
        }
      }
    }
    return;
  }
  const names = dict.get("Names");
  if (names?.k === "arr") {
    for (let i = 0; i + 1 < names.items.length; i += 2) {
      const key = names.items[i];
      const value = names.items[i + 1]!;
      visit(key?.k === "str" ? latin1Str(key.b) : undefined, value);
      if (isRef(value)) refs.add(value.num);
    }
  }
}

/**
 * Collect every indirect object number reachable from a root object via
 * dict/array/ref recursion (bounded) — used to fully excise the
 * JavaScript and EmbeddedFiles subtrees.
 */
function collectReachable(
  doc: ParsedPdf,
  obj: PdfObj,
  refs: Set<number>,
  seen: Set<number>,
  depth: number
): void {
  if (depth > 24) return;
  if (isRef(obj)) {
    if (refs.has(obj.num)) return;
    refs.add(obj.num);
    if (seen.has(obj.num)) return;
    seen.add(obj.num);
    const resolved = doc.getObject(obj.num);
    if (resolved) collectReachable(doc, resolved, refs, seen, depth + 1);
    return;
  }
  if (obj.k === "arr") {
    for (const item of obj.items) {
      collectReachable(doc, item, refs, seen, depth);
    }
    return;
  }
  if (obj.k === "dict" || obj.k === "stream") {
    for (const value of obj.m.values()) {
      collectReachable(doc, value, refs, seen, depth);
    }
  }
}

/** Count leaf pairs of a name tree (for findings). */
function countNameTreeLeaves(
  doc: ParsedPdf,
  node: PdfObj,
  depth: number
): number {
  if (depth > 32) return 0;
  const dict = asDict(node);
  if (!dict) return 0;
  const kids = dict.get("Kids");
  if (kids?.k === "arr") {
    let total = 0;
    for (const kid of kids.items) {
      if (isRef(kid)) {
        const resolved = doc.getObject(kid.num);
        if (resolved) total += countNameTreeLeaves(doc, resolved, depth + 1);
      }
    }
    return total;
  }
  const names = dict.get("Names");
  if (names?.k === "arr") {
    return Math.floor(names.items.length / 2);
  }
  return 0;
}

/**
 * Build the whole sanitize plan for a parsed document.
 * `pages` is the engine's page list (listPages output) and `pageDicts`
 * maps page object number → its own dict (from PdfPageInfo).
 */
export function planSanitize(
  doc: ParsedPdf,
  pages: Array<{ ref: PdfRef; dict: Map<string, PdfObj> }>,
  opts: SanitizeOptions
): SanitizePlan {
  const replacements = new Map<number, PdfObj>();
  const deletions = new Set<number>();
  const findings: SanitizeFindings = {
    javascript: 0,
    embeddedFiles: 0,
    actions: 0,
    metadata: false,
    pagesTouched: 0,
  };

  const rootObj = doc.trailer.get("Root");
  if (!isRef(rootObj) && rootObj?.k !== "dict" && rootObj?.k !== "stream") {
    return { replacements, deletions, dropInfo: false, findings };
  }
  const catalogNum = isRef(rootObj) ? rootObj.num : null;
  const catalogRaw = isRef(rootObj)
    ? doc.getObject(rootObj.num)
    : rootObj;
  if (!catalogRaw || (catalogRaw.k !== "dict" && catalogRaw.k !== "stream")) {
    return { replacements, deletions, dropInfo: false, findings };
  }

  // The catalog clone we will edit (or the original dict when the catalog
  // is inline — rare but legal).
  let catalogMap: Map<string, PdfObj>;
  let catalogDirty = false;
  if (catalogRaw.k === "stream") {
    catalogMap = new Map<string, PdfObj>(catalogRaw.m);
  } else {
    catalogMap = new Map<string, PdfObj>(catalogRaw.m);
  }

  /* ── Names trees (JavaScript / EmbeddedFiles) ──────────────────── */
  const namesEntry = catalogMap.get("Names");
  if (namesEntry !== undefined) {
    const namesObj = isRef(namesEntry)
      ? doc.getObject(namesEntry.num)
      : namesEntry;
    const namesDict = asDict(namesObj);
    if (namesDict) {
      const namesDrop: string[] = [];
      const treeRefs = new Set<number>();

      if (opts.stripJavaScript && namesDict.has("JavaScript")) {
        namesDrop.push("JavaScript");
        const jsTree = namesDict.get("JavaScript")!;
        if (isRef(jsTree)) treeRefs.add(jsTree.num);
        const jsResolved = isRef(jsTree) ? doc.getObject(jsTree.num) : jsTree;
        if (jsResolved) {
          findings.javascript = countNameTreeLeaves(doc, jsResolved, 0);
          collectReachable(doc, jsResolved, treeRefs, new Set(), 0);
        }
      }
      if (opts.stripEmbeddedFiles && namesDict.has("EmbeddedFiles")) {
        namesDrop.push("EmbeddedFiles");
        const efTree = namesDict.get("EmbeddedFiles")!;
        if (isRef(efTree)) treeRefs.add(efTree.num);
        const efResolved = isRef(efTree) ? doc.getObject(efTree.num) : efTree;
        if (efResolved) {
          findings.embeddedFiles = countNameTreeLeaves(doc, efResolved, 0);
          collectReachable(doc, efResolved, treeRefs, new Set(), 0);
        }
      }

      if (namesDrop.length > 0) {
        for (const num of treeRefs) deletions.add(num);
        const cleanedNames = cloneDictDrop(namesDict, namesDrop);
        if (isRef(namesEntry)) {
          replacements.set(namesEntry.num, { k: "dict", m: cleanedNames });
        } else {
          catalogMap.set("Names", { k: "dict", m: cleanedNames });
          catalogDirty = true;
        }
        if (cleanedNames.size === 0 && isRef(namesEntry)) {
          // The names dict is now empty — remove it from the catalog too.
          catalogMap.delete("Names");
          catalogDirty = true;
          deletions.add(namesEntry.num);
        }
      }
    }
  }

  /* ── Catalog-level action/metadata entries ─────────────────────── */
  if (opts.stripActions) {
    if (catalogMap.has("OpenAction")) {
      // Count + collect the action graph for deletion.
      const oa = catalogMap.get("OpenAction")!;
      if (isRef(oa)) deletions.add(oa.num);
      findings.actions += 1;
      catalogMap.delete("OpenAction");
      catalogDirty = true;
    }
    if (catalogMap.has("AA")) {
      const aa = catalogMap.get("AA")!;
      if (isRef(aa)) deletions.add(aa.num);
      findings.actions += 1;
      catalogMap.delete("AA");
      catalogDirty = true;
    }
  }
  if (opts.stripEmbeddedFiles && catalogMap.has("AF")) {
    const af = catalogMap.get("AF")!;
    const afRefs = new Set<number>();
    collectReachable(doc, af, afRefs, new Set(), 0);
    for (const num of afRefs) deletions.add(num);
    catalogMap.delete("AF");
    catalogDirty = true;
  }
  if (opts.stripMetadata && catalogMap.has("Metadata")) {
    const md = catalogMap.get("Metadata")!;
    if (isRef(md)) deletions.add(md.num);
    catalogMap.delete("Metadata");
    findings.metadata = true;
    catalogDirty = true;
  }

  /* ── Pages: /AA + annotation actions ───────────────────────────── */
  if (opts.stripActions) {
    for (const page of pages) {
      let pageDirty = false;
      const pageMap = new Map<string, PdfObj>(page.dict);

      if (pageMap.has("AA")) {
        const aa = pageMap.get("AA")!;
        if (isRef(aa)) deletions.add(aa.num);
        pageMap.delete("AA");
        pageDirty = true;
        findings.actions += 1;
      }

      const annots = pageMap.get("Annots");
      if (annots?.k === "arr") {
        const cleanedAnnots: PdfObj[] = [];
        let annotsChanged = false;
        for (const annot of annots.items) {
          // Inline annot dicts are cloned; indirect annots are replaced
          // via their own object number.
          const annotObj = isRef(annot) ? doc.getObject(annot.num) : annot;
          const annotDict = asDict(annotObj);
          if (!annotDict) {
            cleanedAnnots.push(annot);
            continue;
          }
          let cleaned = annotDict;
          let annotChanged = false;
          for (const key of ["A", "AA"] as const) {
            const action = cleaned.get(key);
            if (action === undefined) continue;
            // /A action dict — dangerous subtype?
            const actionObj = isRef(action)
              ? doc.getObject(action.num)
              : action;
            const actionDict = asDict(actionObj);
            const s = actionDict ? asName(actionDict.get("S")) : undefined;
            if (s === undefined || DANGEROUS_ACTIONS.has(s)) {
              if (isRef(action)) deletions.add(action.num);
              if (!annotChanged) {
                cleaned = new Map<string, PdfObj>(cleaned);
                annotChanged = true;
              }
              cleaned.delete(key);
              findings.actions += 1;
            }
          }
          if (annotChanged) {
            annotsChanged = true;
            if (isRef(annot)) {
              replacements.set(annot.num, { k: "dict", m: cleaned });
              cleanedAnnots.push(annot);
            } else {
              cleanedAnnots.push({ k: "dict", m: cleaned });
            }
          } else {
            cleanedAnnots.push(annot);
          }
        }
        if (annotsChanged) {
          pageMap.set("Annots", { k: "arr", items: cleanedAnnots });
          pageDirty = true;
        }
      }

      if (pageDirty) {
        findings.pagesTouched += 1;
        replacements.set(page.ref.num, { k: "dict", m: pageMap });
      }
    }
  }

  /* ── Ship the catalog replacement ──────────────────────────────── */
  if (catalogDirty && catalogNum !== null) {
    replacements.set(catalogNum, { k: "dict", m: catalogMap });
  }

  return {
    replacements,
    deletions,
    dropInfo: opts.stripMetadata,
    findings,
  };
}
