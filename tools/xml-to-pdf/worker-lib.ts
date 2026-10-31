/**
 * XML to PDF (P3-b / R56) — the PURE XML → table engine.
 *
 * Two honest modes, auto-detected:
 *
 *  1. RECORDS (the data-feed case): the deepest element that has
 *     two or more like-named element children is the record parent;
 *     those repeated elements become the rows (an RSS <item>, a
 *     sitemap <url>, a <product> feed). Columns = the records' child
 *     element names (first-seen union) + the record's own attributes
 *     as @attr columns. Nested children render as their compact XML.
 *
 *  2. LEAVES (the config-file case): when no repetition exists
 *     anywhere, every text leaf becomes a Path / Value row — the
 *     flattened view every settings file deserves.
 *
 * Parsing reuses our own hand-rolled namespace-aware parser
 * (tools/xml-invoice-to-pdf/xml.ts — UBL/CII-grade well-formedness:
 * prolog, comments, CDATA, DOCTYPE skip, entity decoding, prefixed +
 * default namespaces, BOM). Malformed input throws xinv.errorXml,
 * which the worker maps to the honest corrupt error.
 *
 * No DOM, no workers, no network — bun-testable pure functions only.
 */

import type { XmlNode } from "../xml-invoice-to-pdf/xml";
import type { DataTable } from "../data-table-common/render";

/** Honest clamps — anything beyond is cut AND reported. */
export const XML_MAX_COLS = 100;
export const XML_MAX_ROWS = 2000;

export type XmlTableMode = "records" | "leaves";

export interface XmlTable {
  table: DataTable;
  mode: XmlTableMode;
  /** the repeated element's local name (records mode). */
  recordName?: string;
  /** columns dropped by the clamp (0 = none). */
  colsDropped: number;
  /** rows dropped by the clamp (0 = none). */
  rowsDropped: number;
}

/* ------------------------------------------------------------------ */
/* Compact XML serialization (nested child cells)                       */
/* ------------------------------------------------------------------ */

/** Minimal attribute escape. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

/** A node → its compact XML text (attributes included, no pretty ws). */
export function nodeToCompactXml(node: XmlNode): string {
  const attrText = node.attrList
    .map((a) => ` ${a.name}="${esc(a.value)}"`)
    .join("");
  if (node.children.length === 0) {
    return node.text === ""
      ? `<${node.name}${attrText}/>`
      : `<${node.name}${attrText}>${esc(node.text)}</${node.name}>`;
  }
  const inner =
    esc(node.text) +
    node.children.map((c) => nodeToCompactXml(c)).join("");
  return `<${node.name}${attrText}>${inner}</${node.name}>`;
}

/* ------------------------------------------------------------------ */
/* Record-parent detection                                              */
/* ------------------------------------------------------------------ */

/** The deepest element with ≥2 like-named element children (pre-order). */
export function findRecordParent(
  root: XmlNode
): { parent: XmlNode; name: string; records: XmlNode[] } | null {
  let best: {
    parent: XmlNode;
    name: string;
    records: XmlNode[];
    depth: number;
  } | null = null;

  const visit = (node: XmlNode, depth: number): void => {
    const groups = new Map<string, XmlNode[]>();
    for (const child of node.children) {
      const list = groups.get(child.name) ?? [];
      list.push(child);
      groups.set(child.name, list);
    }
    let local: { name: string; records: XmlNode[] } | null = null;
    for (const [name, records] of groups) {
      if (records.length >= 2 && (local === null || records.length > local.records.length)) {
        local = { name, records };
      }
    }
    if (local !== null) {
      // deeper wins; ties keep the first (document order)
      if (best === null || depth > best.depth) {
        best = { parent: node, name: local.name, records: local.records, depth };
      }
    }
    for (const child of node.children) {
      visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return best;
}

/* ------------------------------------------------------------------ */
/* The table builds                                                     */
/* ------------------------------------------------------------------ */

/** A record node → its cell text for one column source. */
function recordCell(node: XmlNode): string {
  if (node.children.length === 0) return node.text.trim();
  if (node.text.trim() === "") return nodeToCompactXml(node);
  // text AND children (rare) — the compact form keeps both visible
  return nodeToCompactXml(node);
}

function recordsTable(
  records: XmlNode[],
  recordName: string,
  title: string,
  showAttributes: boolean
): XmlTable {
  // Column sources in first-seen order: the record's own attributes
  // (@name) then its child element names.
  const attrKeys = new Map<string, true>();
  const childKeys = new Map<string, true>();
  for (const record of records) {
    if (showAttributes) {
      for (const a of record.attrList) {
        if (!attrKeys.has(`@${a.name}`)) attrKeys.set(`@${a.name}`, true);
      }
    }
    for (const child of record.children) {
      if (!childKeys.has(child.name)) childKeys.set(child.name, true);
    }
  }
  const attrCols = [...attrKeys.keys()];
  const childCols = [...childKeys.keys()];
  // a text-only record (no element children) uses its own name as the
  // single column when there are no attribute columns either
  const textCol =
    childCols.length === 0 && attrCols.length === 0 ? recordName : null;

  const allCols =
    textCol !== null
      ? [textCol]
      : [...attrCols, ...childCols];
  const useCols = allCols.slice(0, XML_MAX_COLS);
  const attrSet = new Set(attrCols);
  const childSet = new Set(childCols);

  const rows = records.slice(0, XML_MAX_ROWS).map((record) => {
    return useCols.map((col) => {
      if (textCol !== null) return record.text.trim();
      if (attrSet.has(col)) {
        const attr = record.attrList.find((a) => `@${a.name}` === col);
        return attr ? attr.value : "";
      }
      if (childSet.has(col)) {
        // last child with that name wins (document order)
        let hit: XmlNode | undefined;
        for (const child of record.children) {
          if (child.name === col) hit = child;
        }
        return hit ? recordCell(hit) : "";
      }
      return "";
    });
  });

  return {
    table: { title, header: useCols, rows },
    mode: "records",
    recordName,
    colsDropped: Math.max(0, allCols.length - XML_MAX_COLS),
    rowsDropped: Math.max(0, records.length - XML_MAX_ROWS),
  };
}

function leavesTable(root: XmlNode, title: string): XmlTable {
  const rows: string[][] = [];
  const visit = (node: XmlNode, path: string): void => {
    if (rows.length > XML_MAX_ROWS) return;
    const here = path === "" ? node.name : `${path}/${node.name}`;
    if (node.children.length === 0 && node.text.trim() !== "") {
      rows.push([here, node.text.trim()]);
      return;
    }
    for (const child of node.children) {
      visit(child, here);
    }
  };
  visit(root, "");
  return {
    table: { title, header: ["Path", "Value"], rows },
    mode: "leaves",
    colsDropped: 0,
    rowsDropped: Math.max(0, rows.length - XML_MAX_ROWS),
  };
}

/**
 * The auto-detected table: records mode when a record parent exists,
 * the flattened leaf view otherwise.
 */
export function xmlToTable(
  root: XmlNode,
  title: string,
  showAttributes: boolean
): XmlTable {
  const found = findRecordParent(root);
  if (found !== null) {
    return recordsTable(found.records, found.name, title, showAttributes);
  }
  return leavesTable(root, title);
}

/* ------------------------------------------------------------------ */
/* File-level helpers                                                   */
/* ------------------------------------------------------------------ */

/** "feed.xml" → "feed" (no path, no double extension). */
export function xmlBaseName(fileName: string): string {
  const noPath = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = noPath.lastIndexOf(".");
  const base = dot > 0 ? noPath.slice(0, dot) : noPath;
  return base.trim() !== "" ? base : "xml-data";
}
