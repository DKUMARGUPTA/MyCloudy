import { unzlibSync, zlibSync } from "@/lib/own/zip";
import {
  asDict,
  asName,
  catalogDict,
  dget,
  listPages,
  parsePdf,
  resolveTrailerRef,
  rewriteDocument,
  type ParsedPdf,
  type PdfObj,
} from "@/lib/own/pdf";

/**
 * Web optimize PDF engine (RB3-b, PRD §7 "optimize" family, device mode) —
 * OWN-ENGINE port (P6-z). HONEST scope — this tool restructures a PDF for
 * the web; it NEVER rewrites the meaning of "fast web view" by stamping a
 * fake /Linearized flag:
 *
 *  1. Object stream packing — the engine rewriter's `objectStreams` pass
 *     packs every loose non-stream object into compressed /ObjStm containers
 *     and writes a cross-reference stream (a major structural win on
 *     xref-heavy files). Toggleable.
 *  2. Content stream recompression — every /Filter /FlateDecode stream is
 *     inflated (our own zip engine's unzlibSync) and re-deflated at level 9;
 *     the stream is REPLACED ONLY when the new bytes are genuinely smaller
 *     (a rewriteDocument replacement — /Length is recomputed by the
 *     writer). Text, fonts, vector art and images keep their exact decoded
 *     bytes.
 *  3. Metadata strip (opt-in) — drops the catalog /Metadata XMP packet and
 *     the Info dict's app-generated /Producer + /Creator leftovers while
 *     KEEPING Title/Author/Subject/Keywords (useful, user-owned data).
 *  4. Unreferenced object removal — a reachability walk from the document
 *     root (Catalog → Pages tree → page resources, plus the trailer's Info)
 *     finds objects nothing points at; they ride the rewrite deletions so
 *     the rewritten file carries none of them. The count is reported
 *     honestly in the run detail. The parser consumes the source xref/ObjStm
 *     wrappers itself (structural containers — never counted, never
 *     written).
 *
 * This module is the PURE part (no browser APIs) so scripts can unit-probe
 * it under bun. The worker owns loading, progress and the final rewrite.
 */

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export const WOPT_IDS = {
  objectStreams: "objectStreams",
  recompress: "recompress",
  stripMetadata: "stripMetadata",
} as const;

export interface WebOptParams {
  /** Pack loose objects into compressed /ObjStm containers on save. */
  objectStreams: boolean;
  /** Re-deflate every FlateDecode stream at max level (replace-if-smaller). */
  recompress: boolean;
  /** Drop XMP /Metadata + Info Producer/Creator (keep Title/Author). */
  stripMetadata: boolean;
}

/** Worker option values → params (defaults: object streams + recompress on). */
export function resolveParams(
  options: Record<string, unknown>
): WebOptParams {
  return {
    objectStreams: options[WOPT_IDS.objectStreams] !== false,
    recompress: options[WOPT_IDS.recompress] !== false,
    stripMetadata: options[WOPT_IDS.stripMetadata] === true,
  };
}

/* ------------------------------------------------------------------ */
/* The loaded-document seam (parse once, worker drives the passes)     */
/* ------------------------------------------------------------------ */

/**
 * Strict parse + honest page count. Encrypted sources refuse with the
 * typed PdfError("encrypted") (classifyWebOptError → tool.errorEncrypted);
 * broken trees refuse "corrupt".
 */
export function loadWebOpt(bytes: Uint8Array): ParsedPdf {
  const doc = parsePdf(bytes);
  if (listPages(doc).length < 1) throw new Error("pdf has no pages");
  return doc;
}

/** In-use, non-structural indirect objects (the pdf-lib enumerate parity). */
function inUseRealObjects(doc: ParsedPdf): number {
  let count = 0;
  for (const [num, entry] of doc.entries) {
    if (entry.type === 0) continue;
    const obj = doc.getObject(num);
    if (!obj) continue;
    if (isStructuralContainer(obj)) continue;
    count += 1;
  }
  return count;
}

/** /Type /ObjStm or /Type /XRef stream — consumed by the rewrite itself. */
function isStructuralContainer(obj: PdfObj | undefined): boolean {
  if (!obj || obj.k !== "stream") return false;
  const t = asName(obj.m.get("Type"));
  return t === "ObjStm" || t === "XRef";
}

/* ------------------------------------------------------------------ */
/* 2. Content stream recompression                                     */
/* ------------------------------------------------------------------ */

/** Streams with an inflated body above this cap are skipped (memory guard). */
const MAX_STREAM_INFLATED = 64 * 1024 * 1024;

export interface RecompressReport {
  /** FlateDecode streams found in the document. */
  streamsFound: number;
  /** Streams whose level-9 re-deflate was strictly smaller and replaced. */
  streamsRecompressed: number;
  /** Streams kept as-is (inflate failed, oversize, or not smaller). */
  streamsKept: number;
  /** Sum of original sizes of the replaced streams. */
  bytesBefore: number;
  /** Sum of replacement sizes of the replaced streams. */
  bytesAfter: number;
}

/**
 * Re-deflates every single-filter /FlateDecode stream at level 9. A stream
 * is replaced ONLY when the new bytes are strictly smaller — output can
 * never grow stream-by-stream. Filter arrays, non-Flate filters and
 * inflate failures are skipped honestly (counted in streamsKept). The
 * replacement reuses the stream's own dict, so /Filter, /DecodeParms
 * (predictors) and every other entry survive untouched; the rewriter
 * recalculates /Length from the new raw bytes.
 */
export function recompressFlateStreams(
  doc: ParsedPdf
): { report: RecompressReport; replacements: Map<number, PdfObj> } {
  const report: RecompressReport = {
    streamsFound: 0,
    streamsRecompressed: 0,
    streamsKept: 0,
    bytesBefore: 0,
    bytesAfter: 0,
  };
  const replacements = new Map<number, PdfObj>();
  for (const [num, entry] of doc.entries) {
    if (entry.type === 0) continue;
    const obj = doc.getObject(num);
    if (!obj || obj.k !== "stream") continue;
    if (asName(obj.m.get("Filter")) !== "FlateDecode") {
      continue; // filter arrays / other filters: out of honest scope
    }
    report.streamsFound += 1;
    const original = obj.raw;
    if (original.length === 0 || original.length > MAX_STREAM_INFLATED) {
      report.streamsKept += 1;
      continue;
    }
    let inflated: Uint8Array;
    try {
      inflated = unzlibSync(original);
    } catch {
      report.streamsKept += 1; // not valid zlib — leave the file's bytes alone
      continue;
    }
    if (inflated.length > MAX_STREAM_INFLATED) {
      report.streamsKept += 1;
      continue;
    }
    let redeflated: Uint8Array;
    try {
      redeflated = zlibSync(inflated, { level: 9 });
    } catch {
      report.streamsKept += 1;
      continue;
    }
    if (redeflated.length < original.length) {
      replacements.set(num, { k: "stream", m: obj.m, raw: redeflated });
      report.streamsRecompressed += 1;
      report.bytesBefore += original.length;
      report.bytesAfter += redeflated.length;
    } else {
      report.streamsKept += 1;
    }
  }
  return { report, replacements };
}

/* ------------------------------------------------------------------ */
/* 3. Metadata strip (XMP + app junk; Title/Author survive)             */
/* ------------------------------------------------------------------ */

export interface MetaStripReport {
  xmpRemoved: boolean;
  producerRemoved: boolean;
  creatorRemoved: boolean;
  /**
   * The Info dict emptied out — the caller must drop the trailer /Info
   * (no dangling `/Info << >>`).
   */
  dropInfo: boolean;
}

/**
 * Removes the catalog /Metadata XMP stream (object bytes included — the
 * rewrite deletions set) and the Info dict's /Producer + /Creator — the
 * app-generated junk. /Title, /Author, /Subject, /Keywords and the dates
 * are KEPT: they are user data that browsers and search tools can use. An
 * Info dict left empty by the strip is dropped entirely via dropInfo.
 */
export function stripWebMetadata(
  doc: ParsedPdf,
  deletions: Set<number>
): MetaStripReport {
  const report: MetaStripReport = {
    xmpRemoved: false,
    producerRemoved: false,
    creatorRemoved: false,
    dropInfo: false,
  };

  // XMP packet: catalog /Metadata (same object-level removal the smoke locks)
  const catalog = catalogDict(doc);
  if (catalog !== null) {
    const metaObj = catalog.get("Metadata");
    if (metaObj !== undefined) {
      if (metaObj.k === "ref") deletions.add(metaObj.num);
      catalog.delete("Metadata");
      report.xmpRemoved = true;
    }
  }

  // Info: app-generated entries only (edits mutate the parsed dict in
  // place — the rewriter serializes the same graph).
  const info = asDict(resolveTrailerRef(doc, dget({ k: "dict", m: doc.trailer }, "Info")));
  if (info) {
    if (info.has("Producer")) {
      info.delete("Producer");
      report.producerRemoved = true;
    }
    if (info.has("Creator")) {
      info.delete("Creator");
      report.creatorRemoved = true;
    }
    if (info.size === 0) {
      const infoRef = dget({ k: "dict", m: doc.trailer }, "Info");
      if (infoRef && infoRef.k === "ref") deletions.add(infoRef.num);
      report.dropInfo = true;
    }
  }
  return report;
}

/* ------------------------------------------------------------------ */
/* 4. Unreferenced object walk (+ safe removal)                        */
/* ------------------------------------------------------------------ */

export interface GarbageReport {
  /** Real indirect objects in the loaded document (containers excluded). */
  totalObjects: number;
  /** Objects reachable from the roots (Root + trailer Info). */
  liveObjects: number;
  /** Unreferenced objects found — they ride the rewrite deletions. */
  removed: number;
  /** The object numbers to omit from the rewrite. */
  deletions: Set<number>;
}

/**
 * Reachability walk from the document root: the Catalog (with its Pages
 * tree, page resources, annotations, outlines — every dict/array edge is
 * followed) plus the trailer's Info dict. Any indirect object the walk
 * never reaches is unreferenced: nothing in the file points at it, so it
 * cannot affect rendering and is safely omitted by the rewrite.
 *
 * The parser consumes the source xref/object-stream wrappers itself (they
 * never appear in the output), so the walk only ever marks real document
 * objects — structural containers are excluded from every count.
 */
export function collectUnreferencedObjects(
  doc: ParsedPdf
): GarbageReport {
  const visited = new Set<number>();

  const visitNum = (num: number): void => {
    if (visited.has(num)) return;
    visited.add(num);
    const stack: PdfObj[] = [];
    const obj = doc.getObject(num);
    if (obj !== undefined) stack.push(obj);
    while (stack.length > 0) {
      const current = stack.pop()!;
      switch (current.k) {
        case "ref":
          if (!visited.has(current.num)) {
            visited.add(current.num);
            const resolved = doc.getObject(current.num);
            if (resolved !== undefined) stack.push(resolved);
          }
          break;
        case "arr":
          for (const item of current.items) stack.push(item);
          break;
        case "dict":
        case "stream":
          for (const value of current.m.values()) stack.push(value);
          break;
        default:
          break; // leaf types carry no references
      }
    }
  };

  const root = dget({ k: "dict", m: doc.trailer }, "Root");
  if (root && root.k === "ref") visitNum(root.num);
  else if (root && (root.k === "dict" || root.k === "stream")) {
    // Direct catalog (no /Root ref — rare degenerate files): walk its edges.
    for (const value of root.m.values()) {
      if (value.k === "ref") visitNum(value.num);
    }
  }
  const info = dget({ k: "dict", m: doc.trailer }, "Info");
  if (info && info.k === "ref") visitNum(info.num);

  const total = inUseRealObjects(doc);
  const deletions = new Set<number>();
  for (const [num, entry] of doc.entries) {
    if (entry.type === 0) continue;
    if (visited.has(num)) continue;
    if (isStructuralContainer(doc.getObject(num))) continue; // structural
    deletions.add(num);
  }

  return {
    totalObjects: total,
    liveObjects: visited.size,
    removed: deletions.size,
    deletions,
  };
}

/* ------------------------------------------------------------------ */
/* The whole pass (worker + smoke drive this — one place, no drift)    */
/* ------------------------------------------------------------------ */

export interface WebOptOutcome {
  bytes: Uint8Array;
  pageCount: number;
  garbage: GarbageReport;
  recompress: RecompressReport | null;
  metadataStripped: boolean;
}

/**
 * The full pipeline on one parsed document: garbage walk → optional
 * metadata strip → optional recompress → rewrite. `objectStreams` selects
 * the PDF 1.5 compressed form (pdf-lib save({useObjectStreams}) parity).
 */
export function rewriteWebOpt(
  doc: ParsedPdf,
  params: WebOptParams
): WebOptOutcome {
  const pageCount = listPages(doc).length;

  // 1. Unreferenced objects: reachability walk + safe removal.
  const garbage = collectUnreferencedObjects(doc);
  const deletions = new Set(garbage.deletions);

  // 2. Optional metadata strip (XMP + Info producer/creator).
  let metadataStripped = false;
  let dropInfo = false;
  if (params.stripMetadata) {
    const strip = stripWebMetadata(doc, deletions);
    dropInfo = strip.dropInfo;
    metadataStripped =
      strip.xmpRemoved || strip.producerRemoved || strip.creatorRemoved;
  }

  // 3. Flate stream recompression (replace-if-smaller, level 9).
  let recompress: RecompressReport | null = null;
  let replacements: Map<number, PdfObj> | undefined;
  if (params.recompress) {
    const r = recompressFlateStreams(doc);
    recompress = r.report;
    replacements = r.replacements;
  }

  // 4. Rewrite — object stream packing per the switch.
  const bytes = rewriteDocument(doc, {
    deletions,
    replacements,
    dropInfo,
    objectStreams: params.objectStreams,
  });

  return { bytes, pageCount, garbage, recompress, metadataStripped };
}

/* ------------------------------------------------------------------ */
/* Output inspection (honest post-save numbers)                        */
/* ------------------------------------------------------------------ */

const OBJSTM_BYTES = [0x2f, 0x4f, 0x62, 0x6a, 0x53, 0x74, 0x6d]; // "/ObjStm"

/** Counts /ObjStm objects in saved bytes (the smoke's raw-scan oracle). */
export function countObjectStreams(bytes: Uint8Array): number {
  let count = 0;
  const n = bytes.length;
  const m = OBJSTM_BYTES.length;
  outer: for (let i = 0; i + m <= n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      if (bytes[i + j] !== OBJSTM_BYTES[j]) continue outer;
    }
    count += 1;
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* Error classification (worker + smoke share the exact mapping)        */
/* ------------------------------------------------------------------ */

/** Maps a load/run failure to the honest i18n error code. */
export function classifyWebOptError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/password|encrypt/i.test(message)) return "tool.errorEncrypted";
  return "tool.errorCorrupt";
}
