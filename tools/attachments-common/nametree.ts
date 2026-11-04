import {
  arrItems,
  asArr,
  asDict,
  asName,
  asNum,
  catalogDict,
  dget,
  type ParsedPdf,
  type PdfObj,
  resolveTrailerRef,
} from "@/lib/own/pdf";

/**
 * Embedded-files name-tree reader (P3-d) — PURE own-engine traversal,
 * no browser APIs (runs in tool workers AND bun smokes, the
 * facturx-attach precedent lineage).
 *
 * The PDF spec keeps document-level embedded files in TWO catalog
 * places, and real files use them inconsistently:
 *
 *   1. /Names /EmbeddedFiles — a NAME TREE. Root node holds either a
 *      flat /Names array [ key1, filespecRef1, key2, … ] (the common
 *      single-leaf shape) or /Kids nodes that each carry their own
 *      flat slice (the split shape; keys sorted, /Limits on the
 *      intermediates).
 *   2. /AF — a flat array of filespec refs (PDF 2.0's associated-file
 *      list). Frequently present WITHOUT the name tree (Office
 *      exports) and frequently DUPLICATING name-tree entries.
 *
 * This module walks BOTH, dedupes by filespec object number, and
 * returns honest per-attachment info (decoded key, display name,
 * description, MIME, size) so extract/remove tools can act on the
 * same inventory.
 */

/** One document-level embedded file (post-dedupe inventory entry). */
export interface AttachmentInfo {
  /** Name-tree key when the entry came from the tree; /AF display otherwise. */
  key: string;
  /** Display name: filespec /UF (or /F) — extension intact. */
  name: string;
  /** filespec /Desc, decoded, when present. */
  desc?: string;
  /** Stream /Subtype MIME, decoded ("image/png"), when present. */
  mime?: string;
  /** Stream /Params /Size (uncompressed bytes), when present. */
  size?: number;
  /** Stream /Params /ModDate, when present. */
  modDate?: string;
  /** The filespec object number — dedupe identity. */
  filespecNum: number;
  /** The parsed filespec dict (mutable view into the parse). */
  spec: Map<string, PdfObj>;
  /** Where this entry was discovered (both = tree + /AF shared spec). */
  sources: ("tree" | "af")[];
}

/** Depth guard for pathological /Kids chains (spec trees are 2 levels). */
const MAX_TREE_DEPTH = 8;

/**
 * Collects every document-level embedded file from the catalog:
 * the /Names /EmbeddedFiles tree (recursively through /Kids) plus
 * the /AF array, deduped by filespec object number. Order: tree
 * order first (sorted by key in well-formed files), then /AF-only
 * extras — stable so remove/extract report the same inventory.
 */
export function collectAttachments(doc: ParsedPdf): AttachmentInfo[] {
  const out: AttachmentInfo[] = [];
  const byNum = new Map<number, AttachmentInfo>();

  const catalog = catalogDict(doc);
  if (catalog === null) return out;

  const pushEntry = (
    key: string,
    specValue: PdfObj,
    source: "tree" | "af"
  ): void => {
    if (specValue.k !== "ref") return;
    const existing = byNum.get(specValue.num);
    if (existing !== undefined) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    const spec = asDict(resolveTrailerRef(doc, specValue));
    if (spec === undefined) return;
    const info = buildInfo(doc, key, specValue.num, spec, source);
    if (info === null) return;
    byNum.set(specValue.num, info);
    out.push(info);
  };

  /* ---- 1. the name tree ------------------------------------------ */
  const namesDict = asDict(resolveTrailerRef(doc, catalog.get("Names")));
  const root = namesDict !== undefined
    ? asDict(resolveTrailerRef(doc, namesDict.get("EmbeddedFiles")))
    : undefined;
  if (root !== undefined) walkTreeNode(doc, root, 0, pushEntry);

  /* ---- 2. the /AF array ------------------------------------------ */
  const af = asArr(catalog.get("AF"));
  if (af !== undefined) {
    for (const item of af) {
      if (item.k !== "ref") continue;
      const spec = asDict(resolveTrailerRef(doc, item));
      if (spec === undefined) continue;
      const name = filespecName(spec) ?? `file-${item.num}`;
      pushEntry(name, item, "af");
    }
  }

  return out;
}

/** Recursively walks a name-tree node: /Kids first, then flat /Names. */
function walkTreeNode(
  doc: ParsedPdf,
  node: Map<string, PdfObj>,
  depth: number,
  visit: (key: string, spec: PdfObj, source: "tree") => void
): void {
  if (depth > MAX_TREE_DEPTH) return;
  const kids = asArr(resolveTrailerRef(doc, node.get("Kids")));
  if (kids !== undefined) {
    for (const kid of kids) {
      const kidDict = asDict(resolveTrailerRef(doc, kid));
      if (kidDict !== undefined) {
        walkTreeNode(doc, kidDict, depth + 1, visit);
      }
    }
    return;
  }
  const flat = arrItems(node.get("Names"));
  if (flat === null) return;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const key = decodePdfText(flat[i]!);
    if (key === undefined) continue;
    visit(key, flat[i + 1]!, "tree");
  }
}

/** Builds one inventory entry from a filespec dict (null when unusable). */
function buildInfo(
  doc: ParsedPdf,
  key: string,
  filespecNum: number,
  spec: Map<string, PdfObj>,
  source: "tree" | "af"
): AttachmentInfo | null {
  // A filespec without /EF cannot yield bytes — extract skips it via
  // the null stream; remove still removes the entry. Keep it listed
  // so the inventory is honest about what the file claims.
  const stream = embeddedFileStream(doc, spec);
  const params = stream !== undefined
    ? asDict(dget({ k: "dict", m: stream.m }, "Params"))
    : undefined;
  const mime = stream !== undefined
    ? decodeNameValue(asName(stream.m.get("Subtype")))
    : undefined;
  const modDate = params !== undefined
    ? decodePdfText(params.get("ModDate"))
    : undefined;
  const info: AttachmentInfo = {
    key,
    name: filespecName(spec) ?? key,
    filespecNum,
    spec,
    sources: [source],
  };
  const desc = decodePdfText(spec.get("Desc"));
  if (desc !== undefined && desc.length > 0) info.desc = desc;
  if (mime !== undefined) info.mime = mime;
  const size = params !== undefined ? asNum(params.get("Size")) : undefined;
  if (size !== undefined) info.size = size;
  if (modDate !== undefined) info.modDate = modDate;
  return info;
}

/** The filespec's /EF embedded stream (resolved through the doc), when present. */
export function embeddedFileStream(
  doc: ParsedPdf,
  spec: Map<string, PdfObj>
): { m: Map<string, PdfObj>; raw: Uint8Array } | undefined {
  const ef = asDict(spec.get("EF"));
  if (ef === undefined) return undefined;
  const candidates = [ef.get("F"), ef.get("UF")];
  for (const candidate of candidates) {
    const resolved = resolveTrailerRef(doc, candidate);
    if (resolved !== undefined && resolved.k === "stream") {
      return { m: resolved.m, raw: resolved.raw };
    }
  }
  return undefined;
}

/** The filespec /EF stream object NUMBERS (for deletion planning). */
export function embeddedFileStreamNums(spec: Map<string, PdfObj>): number[] {
  const ef = asDict(spec.get("EF"));
  if (ef === undefined) return [];
  const nums: number[] = [];
  for (const key of ["F", "UF"]) {
    const candidate = ef.get(key);
    if (candidate !== undefined && candidate.k === "ref") nums.push(candidate.num);
  }
  return nums;
}

/** Display name: /UF text, /F fallback — decoded, raw (no sanitizing). */
function filespecName(spec: Map<string, PdfObj>): string | undefined {
  const uf = decodePdfText(spec.get("UF"));
  if (uf !== undefined && uf.length > 0) return uf;
  const f = decodePdfText(spec.get("F"));
  if (f !== undefined && f.length > 0) return f;
  return undefined;
}

/**
 * Decodes a PDF TEXT string object (hex `hstr` or literal `str`/`lstr`):
 * UTF-16BE when the BOM says so, else latin1 (PDFDocEncoding's ASCII
 * subset round-trips; non-ASCII latin1 is the tolerant fallback).
 */
export function decodePdfText(o: PdfObj | undefined): string | undefined {
  if (o === undefined) return undefined;
  if (o.k !== "str" && o.k !== "lstr" && o.k !== "hstr") return undefined;
  const b = o.b;
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < b.length; i += 2) {
      out += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
    }
    return out;
  }
  let out = "";
  for (let i = 0; i < b.length; i += 1) out += String.fromCharCode(b[i]!);
  return out;
}

/** "image#2Fpng"-style parsed names → "image/png" (lexer already unescaped). */
function decodeNameValue(v: string | undefined): string | undefined {
  return v !== undefined && v.length > 0 ? v : undefined;
}
