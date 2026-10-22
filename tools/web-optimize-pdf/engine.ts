import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFDocument,
} from "pdf-lib";
import { unzlibSync, zlibSync } from "fflate";

/**
 * Web optimize PDF engine (RB3-b, PRD §7 "optimize" family, device mode).
 *
 * HONEST scope — this tool restructures a PDF for the web; it NEVER rewrites
 * the meaning of "fast web view" by stamping a fake /Linearized flag:
 *
 *  1. Object stream packing — pdf-lib's save({ useObjectStreams: true })
 *     packs every loose non-stream object into compressed /ObjStm containers
 *     and writes a cross-reference stream (a major structural win on
 *     xref-heavy files). Toggleable.
 *  2. Content stream recompression — every /Filter /FlateDecode stream is
 *     inflated (fflate unzlibSync) and re-deflated at level 9; the stream is
 *     REPLACED ONLY when the new bytes are genuinely smaller. Text, fonts,
 *     vector art and images keep their exact decoded bytes.
 *  3. Metadata strip (opt-in) — drops the catalog /Metadata XMP packet and
 *     the Info dict's app-generated /Producer + /Creator leftovers while
 *     KEEPING Title/Author/Subject/Keywords (useful, user-owned data).
 *  4. Unreferenced object removal — a reachability walk from the document
 *     root (Catalog → Pages tree → page resources, plus the trailer's Info)
 *     finds objects nothing points at; they are deleted from the context so
 *     the rewritten file carries none of them. The count is reported
 *     honestly in the run detail. (Probe-verified: pdf-lib's parser drops
 *     the source xref/ObjStm wrappers, so the walk sees only real objects.)
 *
 * This module is the PURE part (no browser APIs) so scripts can unit-probe
 * it under bun. The worker owns loading, progress and saving.
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
/* Shared pdf-lib helpers (local — deliberately not imported from      */
/* meta-common; this engine keeps Title/Author, unlike that stripper)  */
/* ------------------------------------------------------------------ */

const isRef = (obj: unknown): obj is PDFRef =>
  typeof obj === "object" && obj !== null && "objectNumber" in obj;

/** The live Info dict, or undefined when the doc has none. Never creates. */
function infoDict(doc: PDFDocument): PDFDict | undefined {
  return doc.context.lookupMaybe(
    doc.context.trailerInfo.Info as never,
    PDFDict
  );
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
 * inflate failures are skipped honestly (counted in streamsKept).
 *
 * The replacement reuses the stream's own dict, so /Filter, /DecodeParms
 * (predictors) and every other entry survive untouched; pdf-lib's writer
 * recalculates /Length from the new contents on save.
 */
export function recompressFlateStreams(doc: PDFDocument): RecompressReport {
  const report: RecompressReport = {
    streamsFound: 0,
    streamsRecompressed: 0,
    streamsKept: 0,
    bytesBefore: 0,
    bytesAfter: 0,
  };
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const filter = obj.dict.get(PDFName.of("Filter"));
    if (!(filter instanceof PDFName) || filter !== PDFName.of("FlateDecode")) {
      continue; // filter arrays / other filters: out of honest scope
    }
    report.streamsFound += 1;
    const original = obj.contents;
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
      doc.context.assign(ref, PDFRawStream.of(obj.dict, redeflated));
      report.streamsRecompressed += 1;
      report.bytesBefore += original.length;
      report.bytesAfter += redeflated.length;
    } else {
      report.streamsKept += 1;
    }
  }
  return report;
}

/* ------------------------------------------------------------------ */
/* 3. Metadata strip (XMP + app junk; Title/Author survive)             */
/* ------------------------------------------------------------------ */

export interface MetaStripReport {
  xmpRemoved: boolean;
  producerRemoved: boolean;
  creatorRemoved: boolean;
}

/**
 * Removes the catalog /Metadata XMP stream (object bytes included) and the
 * Info dict's /Producer + /Creator — the app-generated junk. /Title,
 * /Author, /Subject, /Keywords and the dates are KEPT: they are user data
 * that browsers and search tools can use. An Info dict left empty by the
 * strip is dropped entirely (no dangling `/Info << >>` in the trailer).
 */
export function stripWebMetadata(doc: PDFDocument): MetaStripReport {
  const report: MetaStripReport = {
    xmpRemoved: false,
    producerRemoved: false,
    creatorRemoved: false,
  };

  // XMP packet: catalog /Metadata (same object-level removal the smoke locks)
  const metaObj = doc.catalog.get(PDFName.of("Metadata"));
  if (metaObj !== undefined) {
    const ref = isRef(metaObj) ? metaObj : null;
    doc.catalog.delete(PDFName.of("Metadata"));
    if (ref) doc.context.delete(ref);
    report.xmpRemoved = true;
  }

  // Info: app-generated entries only. Snapshot BEFORE deleting — pdf-lib's
  // getters lazily re-create an empty Info dict, so nothing may read it after.
  const info = infoDict(doc);
  if (info) {
    if (info.get(PDFName.of("Producer")) !== undefined) {
      info.delete(PDFName.of("Producer"));
      report.producerRemoved = true;
    }
    if (info.get(PDFName.of("Creator")) !== undefined) {
      info.delete(PDFName.of("Creator"));
      report.creatorRemoved = true;
    }
    if (info.entries().length === 0) {
      const ref = isRef(doc.context.trailerInfo.Info)
        ? doc.context.trailerInfo.Info
        : null;
      if (ref) doc.context.delete(ref);
      doc.context.trailerInfo.Info = undefined;
    }
  }
  return report;
}

/* ------------------------------------------------------------------ */
/* 4. Unreferenced object walk (+ safe removal)                        */
/* ------------------------------------------------------------------ */

export interface GarbageReport {
  /** Indirect objects in the loaded document. */
  totalObjects: number;
  /** Objects reachable from the roots (Root + trailer Info). */
  liveObjects: number;
  /** Unreferenced objects found and deleted from the context. */
  removed: number;
}

/**
 * Reachability walk from the document root: the Catalog (with its Pages
 * tree, page resources, annotations, outlines — every dict/array edge is
 * followed) plus the trailer's Info dict. Any indirect object the walk
 * never reaches is unreferenced: nothing in the file points at it, so it
 * cannot affect rendering and is safely deleted before the rewrite.
 *
 * pdf-lib's parser does not register the source xref/object-stream
 * wrappers as context objects (probe-verified), so the walk only ever
 * marks real document objects. Old-style /Type /XRef and /Type /ObjStm
 * streams are additionally treated as structural and never counted.
 */
export function collectUnreferencedObjects(
  doc: PDFDocument
): GarbageReport {
  const context = doc.context;
  const entries = context.enumerateIndirectObjects();
  const visited = new Set<string>();

  const visitRef = (ref: PDFRef): void => {
    const key = `${ref.objectNumber}:${ref.generationNumber}`;
    if (visited.has(key)) return;
    visited.add(key);
    const stack: unknown[] = [context.lookup(ref)];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current instanceof PDFRef) {
        const refKey = `${current.objectNumber}:${current.generationNumber}`;
        if (!visited.has(refKey)) {
          visited.add(refKey);
          stack.push(context.lookup(current));
        }
        continue;
      }
      if (current instanceof PDFStream) {
        // covers PDFRawStream and every pdf-lib stream subclass
        for (const [, value] of current.dict.entries()) stack.push(value);
        continue;
      }
      if (current instanceof PDFDict) {
        for (const [, value] of current.entries()) stack.push(value);
        continue;
      }
      if (current instanceof PDFArray) {
        for (let i = 0; i < current.size(); i += 1) stack.push(current.get(i));
      }
      // leaf types (names, numbers, strings, bools) carry no references
    }
  };

  const root = context.trailerInfo.Root;
  if (isRef(root)) visitRef(root);
  const info = context.trailerInfo.Info;
  if (isRef(info)) visitRef(info);

  let removed = 0;
  for (const [ref, obj] of entries) {
    const key = `${ref.objectNumber}:${ref.generationNumber}`;
    if (visited.has(key)) continue;
    const type = obj instanceof PDFStream
      ? String(obj.dict.get(PDFName.of("Type")))
      : "";
    if (type === "/XRef" || type === "/ObjStm") continue; // structural
    context.delete(ref);
    removed += 1;
  }

  return {
    totalObjects: entries.length,
    liveObjects: visited.size,
    removed,
  };
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
