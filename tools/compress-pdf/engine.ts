import {
  asName,
  asNum,
  decodeStreamBytes,
  listPages,
  type ParsedPdf,
  type PdfObj,
} from "@/lib/own/pdf";

/**
 * Compress PDF engine (PRD §7.5, device mode) — OWN-engine port (P6-r).
 *
 * Strategy: the file's embedded PHOTOS are re-encoded as JPEG at a chosen
 * quality + max pixel size; text, fonts and vector art are untouched, so
 * selectable text stays selectable. Stream replacement is object-level:
 * each image XObject's indirect object is swapped for a replacement
 * (DCTDecode) stream with updated /Width /Height /ColorSpace — the page
 * content stream's cm matrix stretches the image into the same drawn box,
 * so dimension changes are safe.
 *
 * This module is the PURE part (no canvas/browser APIs) so scripts can
 * unit-probe it under bun. The worker owns the impure decode/encode
 * (OffscreenCanvas etc.); saving happens through the engine's
 * preserve-numbers whole-document rewriter (rewriteDocument).
 */

export interface CompressParams {
  /** JPEG quality 0..1 for re-encoded photos. */
  quality: number;
  /** Cap for the longest image side, in pixels (0 = no cap). */
  maxDim: number;
  /** Convert photos to grayscale luminance. */
  grayscale: boolean;
  /** Drop the Info dict + XMP block too. */
  stripMetadata: boolean;
}

export const COMPRESS_PRESETS: Record<
  "light" | "recommended" | "strong",
  { quality: number; maxDim: number }
> = {
  light: { quality: 0.82, maxDim: 2400 },
  recommended: { quality: 0.65, maxDim: 1600 },
  strong: { quality: 0.45, maxDim: 1200 },
};

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));

/** Worker option values → clamped params (custom preset wins when set). */
export function resolveParams(
  options: Record<string, unknown>
): CompressParams {
  const preset = String(options.preset ?? "recommended");
  const base =
    preset === "light" || preset === "recommended" || preset === "strong"
      ? COMPRESS_PRESETS[preset]
      : null;
  const quality = base
    ? base.quality
    : clamp(Number(options.quality ?? 65) / 100, 0.2, 0.97);
  const maxDim = base
    ? base.maxDim
    : Math.round(clamp(Number(options.maxDim ?? 1600), 200, 8000));
  return {
    quality,
    maxDim,
    grayscale: options.grayscale === true,
    stripMetadata: options.stripMetadata === true,
  };
}

/** How the worker should decode an image XObject. */
export type ImageStrategy =
  | "jpeg" // DCTDecode — the browser decodes it natively
  | "raw-gray" // decodable filters + 1 component, 8bpc
  | "raw-rgb" // decodable filters + 3 components, 8bpc
  | "raw-cmyk" // decodable filters + 4 components, 8bpc (naive convert)
  | "indexed" // [/Indexed base hival palette] — palette expansion
  | "skip"; // anything we can't decode losslessly enough to re-encode

export interface ImageCandidate {
  /** Source object number (the replacement maps onto it). */
  num: number;
  /** The stream object — `raw` is the ORIGINAL compressed body. */
  stream: PdfObj & { k: "stream" };
  width: number;
  height: number;
  strategy: ImageStrategy;
  /** Component count for raw-* strategies (1/3/4). */
  components: number;
  /** Original compressed stream size (bytes). */
  sourceBytes: number;
  /** /Indexed images only: palette resolved at collection time. */
  palette?: PaletteInfo | null;
}

const DECODABLE_FILTERS = new Set([
  "FlateDecode",
  "LZWDecode",
  "ASCII85Decode",
  "ASCIIHexDecode",
  "RunLengthDecode",
]);

/** Resolve refs through the doc when a dict value is indirect. */
function resolveDirect(
  doc: ParsedPdf | null,
  v: PdfObj | undefined,
): PdfObj | undefined {
  if (!v) return undefined;
  if (v.k === "ref" && doc !== null) return doc.getObject(v.num);
  return v;
}

/** Dict number read with indirect /Width-style resolution. */
function dictNumber(
  doc: ParsedPdf | null,
  m: Map<string, PdfObj>,
  key: string
): number | null {
  const v = resolveDirect(doc, m.get(key));
  const n = v && v.k === "num" ? v.n : null;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Resolved /Filter chain as names (empty when none/malformed). */
function filterNames(
  doc: ParsedPdf | null,
  m: Map<string, PdfObj>
): string[] {
  const filter = resolveDirect(doc, m.get("Filter"));
  if (filter && filter.k === "name") return [filter.v];
  if (filter && filter.k === "arr") {
    const names: string[] = [];
    for (const item of filter.items) {
      const v = resolveDirect(doc, item);
      if (v && v.k === "name") names.push(v.v);
      else return []; // unknown filter object — bail
    }
    return names;
  }
  return [];
}

/**
 * Classifies one image dict. /SMask and stencil /Mask image objects must be
 * pre-excluded by the caller (they are listed in `protectedRefs`) — their
 * colorspaces are meaningful to their parent image, not to us.
 */
export function classifyImage(m: Map<string, PdfObj>): ImageStrategy {
  if (dictNumber(null, m, "ImageMask") === 1) return "skip";

  const filters = filterNames(null, m);
  if (filters.length === 0) return "skip";
  if (filters.length === 1 && filters[0] === "DCTDecode") {
    return "jpeg";
  }
  if (filters.includes("DCTDecode")) return "skip"; // e.g. Flate(DCT(...)) — rare, skip
  if (!filters.every((f) => DECODABLE_FILTERS.has(f))) {
    return "skip"; // JPX / CCITT / JBIG2 …
  }

  // Losslessly-decoded pixels: interpret the colorspace.
  const bpc = dictNumber(null, m, "BitsPerComponent") ?? 8;
  if (bpc !== 8) return "skip"; // 1/2/4-bit handled only via Indexed below

  const colorSpace = m.get("ColorSpace");
  if (colorSpace && colorSpace.k === "name") {
    const cs = colorSpace.v;
    if (cs === "DeviceGray" || cs === "CalGray") return "raw-gray";
    if (cs === "DeviceRGB" || cs === "CalRGB") return "raw-rgb";
    if (cs === "DeviceCMYK") return "raw-cmyk";
    return "skip"; // Lab, Separation, …
  }
  if (colorSpace && colorSpace.k === "arr" && colorSpace.items.length > 0) {
    const family = colorSpace.items[0]!;
    const fam = family.k === "name" ? family.v : "";
    if (fam === "Indexed") return "indexed";
    if (fam === "ICCBased" || fam === "CalRGB" || fam === "CalGray") {
      const n = colorSpace.items[1];
      const nn = n && n.k === "num" ? n.n : null;
      if (nn === 1) return "raw-gray";
      if (nn === 3) return "raw-rgb";
      if (nn === 4) return "raw-cmyk";
      return "skip";
    }
  }
  return "skip";
}

/** Component count for a /Indexed base colorspace name (null = unsupported). */
export function indexedBaseComponents(base: string): number | null {
  if (base === "DeviceGray" || base === "CalGray") return 1;
  if (base === "DeviceRGB" || base === "CalRGB") return 3;
  if (base === "DeviceCMYK") return 4;
  return null;
}

export interface PaletteInfo {
  baseComponents: number;
  palette: Uint8Array;
}

/**
 * Palette lookup for /Indexed images: resolves [/Indexed base hival lookup]
 * to a base-component count + a flat palette. Handles BOTH inline strings
 * and stream-backed lookups (our pure decodeStreamBytes — no worker
 * round-trip needed, unlike the pdf-lib split).
 */
export function indexedPalette(
  doc: ParsedPdf,
  m: Map<string, PdfObj>
): PaletteInfo | null {
  const colorSpace = m.get("ColorSpace");
  if (!colorSpace || colorSpace.k !== "arr" || colorSpace.items.length < 4) {
    return null;
  }
  const base = resolveDirect(doc, colorSpace.items[1]);
  if (!base || base.k !== "name") return null;
  const baseComponents = indexedBaseComponents(base.v);
  if (baseComponents === null) return null;
  const lookup = resolveDirect(doc, colorSpace.items[3]);
  if (!lookup) return null;
  if (lookup.k === "str" || lookup.k === "hstr" || lookup.k === "lstr") {
    if (lookup.b.length === 0) return null;
    return { baseComponents, palette: lookup.b };
  }
  if (lookup.k === "stream") {
    try {
      const palette = decodeStreamBytes(lookup.raw, lookup.m);
      if (palette.length > 0) return { baseComponents, palette };
    } catch {
      return null;
    }
  }
  return null;
}

/** The image objects of a document (used by candidates + dedupe). */
export function* walkImageStreams(
  doc: ParsedPdf,
  replacements?: Map<number, PdfObj> | null
): Generator<{ num: number; obj: PdfObj & { k: "stream" } }> {
  for (const [num, entry] of doc.entries) {
    if (entry.type === 0) continue;
    let obj: PdfObj | undefined;
    const replacement = replacements?.get(num);
    if (replacement !== undefined) {
      obj = replacement;
    } else {
      const parsed = doc.getObject(num);
      if (!parsed) continue;
      // Source ObjStm/XRef containers are structural, never content.
      const t = asName(parsed.k === "stream" ? parsed.m.get("Type") : undefined);
      if (t === "ObjStm" || t === "XRef") continue;
      obj = parsed;
    }
    if (!obj || obj.k !== "stream") continue;
    const subtype = resolveDirect(doc, obj.m.get("Subtype"));
    if (!subtype || subtype.k !== "name" || subtype.v !== "Image") continue;
    yield { num, obj };
  }
}

/**
 * Collects compressible image XObjects from the whole document — every
 * object that is a stream with /Subtype /Image — excluding the /SMask +
 * /Mask objects referenced by other images (their bytes are alpha data
 * whose colorspace belongs to the parent — re-encoding them as lossy RGB
 * JPEG would corrupt the parent's transparency).
 *
 * `replacements` is consulted first: the to-size ladder re-collects
 * candidates after each rung so later rungs re-encode the ALREADY
 * re-encoded JPEGs (compounding, exactly like the pdf-lib flow).
 */
export function collectImageCandidates(
  doc: ParsedPdf,
  replacements?: Map<number, PdfObj> | null
): ImageCandidate[] {
  const protectedRefs = new Set<number>();

  // Pass 1: find every image object + remember the alpha-mask ones.
  const images: { num: number; obj: PdfObj & { k: "stream" } }[] = [];
  for (const { num, obj } of walkImageStreams(doc, replacements)) {
    images.push({ num, obj });
    for (const key of ["SMask", "Mask"]) {
      const mask = obj.m.get(key);
      if (mask && mask.k === "ref") protectedRefs.add(mask.num);
    }
  }

  // Pass 2: classify (drop alpha-mask objects).
  const candidates: ImageCandidate[] = [];
  for (const { num, obj } of images) {
    if (protectedRefs.has(num)) continue;
    const width = dictNumber(doc, obj.m, "Width");
    const height = dictNumber(doc, obj.m, "Height");
    if (!width || !height || width < 8 || height < 8) continue; // bullets, dots
    const strategy = classifyImage(obj.m);
    if (strategy === "skip") continue;
    const components =
      strategy === "raw-gray"
        ? 1
        : strategy === "raw-cmyk"
          ? 4
          : strategy === "indexed"
            ? 1 // expanded via palette before use
            : 3;
    candidates.push({
      num,
      stream: obj,
      width,
      height,
      strategy,
      components,
      sourceBytes: obj.raw.length,
      // /Indexed palettes resolve EAGERLY (pure decode — inline strings and
      // stream-backed lookups both) so the worker's canvas path stays simple.
      palette: strategy === "indexed" ? indexedPalette(doc, obj.m) : undefined,
    });
  }
  return candidates;
}

/**
 * Builds the replacement image stream object for a re-encoded JPEG — the
 * entry that goes into rewriteDocument's replacements map. Keys carried
 * over: /SMask, /Mask, /Name (legacy viewers) and /Interpolate (viewer
 * smoothing).
 */
export function imageReplacement(
  candidate: ImageCandidate,
  jpegBytes: Uint8Array,
  newWidth: number,
  newHeight: number,
  components: 1 | 3 = 3
): [number, PdfObj & { k: "stream" }] {
  const old = candidate.stream.m;
  const m = new Map<string, PdfObj>();
  m.set("Type", { k: "name", v: "XObject" });
  m.set("Subtype", { k: "name", v: "Image" });
  m.set("Width", { k: "num", n: newWidth });
  m.set("Height", { k: "num", n: newHeight });
  // The canvas JPEG encoder emits 3-component YCbCr; a true 1-component
  // encoder (the gray plane) writes DeviceGray.
  m.set(
    "ColorSpace",
    { k: "name", v: components === 1 ? "DeviceGray" : "DeviceRGB" }
  );
  m.set("BitsPerComponent", { k: "num", n: 8 });
  m.set("Filter", { k: "name", v: "DCTDecode" });
  for (const key of ["SMask", "Mask", "Name", "Interpolate"]) {
    const carried = old.get(key);
    if (carried !== undefined) m.set(key, carried);
  }
  return [candidate.num, { k: "stream", m, raw: jpegBytes }];
}

/**
 * Target pixel size after the maxDim cap (never upscales). Returns the
 * original size when already within the cap.
 */
export function targetSize(
  width: number,
  height: number,
  maxDim: number
): { width: number; height: number } {
  if (maxDim <= 0) return { width, height };
  const longest = Math.max(width, height);
  if (longest <= maxDim) return { width, height };
  const scale = maxDim / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Luminance (Rec. 601) conversion of ImageData RGB bytes, in place. */
export function grayscaleImageData(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const v = y > 255 ? 255 : y < 0 ? 0 : y;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
}

/* ------------------------------------------------------------------ */
/* Duplicate image dedupe (R4-b)                                       */
/* ------------------------------------------------------------------ */

export interface DedupeResult {
  /** Duplicate image objects that were removed (groups contribute n−1). */
  mergedCount: number;
  /** Groups that actually had ≥2 byte-identical members. */
  mergedGroups: number;
  /** Sum of the removed duplicates' raw stream bytes (honest lower bound —
   *  the saved file also drops each duplicate's dict + xref entry). */
  bytesSaved: number;
  /** Object number of the shared keeper per removed duplicate (debug/tests). */
  keeperOf: Map<number, number>;
  /** Object numbers to omit from the rewrite (the removed duplicates). */
  deletions: Set<number>;
}

/** Canonical signature of a value tree, refs rendered as "R:num:gen". */
function signatureOf(value: PdfObj): string {
  switch (value.k) {
    case "name":
      return `/${value.v}`;
    case "num":
      return `#${value.n}`;
    case "str":
    case "hstr":
    case "lstr": {
      let hex = "";
      for (let i = 0; i < value.b.length; i += 1) {
        hex += value.b[i]!.toString(16).padStart(2, "0");
      }
      return `(${hex})`;
    }
    case "arr":
      return `[${value.items.map(signatureOf).join(",")}]`;
    case "dict":
    case "stream": {
      const entries = [...value.m.entries()].sort((a, b) =>
        a[0] < b[0] ? -1 : 1
      );
      return `<<${entries.map(([key, inner]) => `/${key}=${signatureOf(inner)}`).join(",")}>>`;
    }
    case "ref":
      return `R:${value.num}:${value.gen}`;
    case "bool":
      return value.b ? "true" : "false";
    case "null":
      return "null";
    case "newref":
      return `N:${value.num}`;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Deep-walks every in-use object and rewrites ref values that point at a
 * removed duplicate onto the keeper's ref. Values live in dict/array
 * slots; a visited set guards cyclic page-tree shapes.
 */
function retargetRefs(
  doc: ParsedPdf,
  replacements: Map<number, PdfObj> | null | undefined,
  keeperOf: Map<number, number>
): void {
  const seen = new Set<unknown>();

  const walkValue = (value: PdfObj, replace: (next: PdfObj) => void): void => {
    if (value.k === "ref") return; // leaf — rewriting happens in the parent
    if (value.k === "dict" || value.k === "stream" || value.k === "arr") {
      if (seen.has(value)) return;
      seen.add(value);
    }
    if (value.k === "dict" || value.k === "stream") {
      for (const [key, inner] of value.m) {
        if (inner.k === "ref" && keeperOf.has(inner.num)) {
          value.m.set(key, { k: "ref", num: keeperOf.get(inner.num)!, gen: 0 });
        } else {
          walkValue(inner, () => undefined);
        }
      }
      return;
    }
    if (value.k === "arr") {
      for (let i = 0; i < value.items.length; i += 1) {
        const inner = value.items[i]!;
        if (inner.k === "ref" && keeperOf.has(inner.num)) {
          value.items[i] = { k: "ref", num: keeperOf.get(inner.num)!, gen: 0 };
        } else {
          walkValue(inner, () => undefined);
        }
      }
    }
  };

  for (const [num, entry] of doc.entries) {
    if (entry.type === 0) continue;
    const replacement = replacements?.get(num);
    const obj = replacement !== undefined ? replacement : doc.getObject(num);
    if (!obj) continue;
    walkValue(obj, () => undefined);
  }
}

/**
 * Merges byte-identical image XObjects onto ONE shared object (R4-b).
 *
 * Files that stamp the same logo/photo on every page (letterheads,
 * watermarks, form scans) embed one copy PER PAGE; the bytes are identical
 * and all but the first copy are pure waste. Detection: group image streams
 * by a canonical dict signature (every entry except /Length, with refs
 * kept distinct so images never share a foreign /SMask) + raw stream
 * length, then CONFIRM with a full byte compare — a hash alone never
 * merges. Groups with a single member are untouched; the keeper is the
 * lowest object number; duplicates are omitted from the rewrite after
 * every reference was retargeted onto the keeper.
 *
 * Runs on ANY image XObject — including ones the JPEG re-encode must skip
 * (masks, odd colorspaces) — so dedupe is orthogonal to re-encoding, and
 * running it FIRST means unique images re-encode exactly once.
 */
export function dedupeImageXObjects(
  doc: ParsedPdf,
  replacements?: Map<number, PdfObj> | null
): DedupeResult {
  const images: { num: number; obj: PdfObj & { k: "stream" }; signature: string }[] =
    [];
  for (const { num, obj } of walkImageStreams(doc, replacements)) {
    // /Length is stream-machinery (it equals raw.length); everything else
    // in the dict must agree before two images are merge candidates.
    const shadow = new Map<string, PdfObj>();
    for (const [key, value] of obj.m) {
      if (key === "Length") continue;
      shadow.set(key, value);
    }
    images.push({ num, obj, signature: signatureOf({ k: "dict", m: shadow }) });
  }

  const groups = new Map<string, typeof images>();
  for (const image of images) {
    const key = `${image.signature}#${image.obj.raw.length}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(image);
    else groups.set(key, [image]);
  }

  const keeperOf = new Map<number, number>();
  let bytesSaved = 0;
  let mergedGroups = 0;
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue; // cap safety: only ≥2 identical copies
    bucket.sort((a, b) => a.num - b.num);
    const keeper = bucket[0]!;
    let mergedAny = false;
    for (let i = 1; i < bucket.length; i += 1) {
      const dup = bucket[i]!;
      // The signature is necessary but not sufficient — compare the raw
      // bytes so no hash/length collision can ever corrupt a document.
      if (!bytesEqual(keeper.obj.raw, dup.obj.raw)) continue;
      keeperOf.set(dup.num, keeper.num);
      bytesSaved += dup.obj.raw.length;
      mergedAny = true;
    }
    if (mergedAny) mergedGroups += 1;
  }
  if (keeperOf.size === 0) {
    return {
      mergedCount: 0,
      mergedGroups: 0,
      bytesSaved: 0,
      keeperOf: new Map(),
      deletions: new Set(),
    };
  }

  retargetRefs(doc, replacements, keeperOf);
  const deletions = new Set(keeperOf.keys());
  return {
    mergedCount: keeperOf.size,
    mergedGroups,
    bytesSaved,
    keeperOf,
    deletions,
  };
}

/* ------------------------------------------------------------------ */
/* Metadata strip (own engine; the meta-common port lands later)       */
/* ------------------------------------------------------------------ */

export interface StripReport {
  /** Raw Info-dict keys that were present and removed (e.g. "Title"). */
  removedFields: string[];
  removedXmp: boolean;
  /** Pages whose /PieceInfo dictionary was removed (private app data). */
  removedPieceInfo: number;
  removedPageMetadata: number;
  /** Annotation /M timestamps removed. */
  removedAnnotationDates: number;
  /** Object numbers to omit from the rewrite (Info, XMP, page-level). */
  deletions: Set<number>;
  /** The trailer /Info must be dropped too. */
  dropInfo: boolean;
}

/**
 * stripAllMetadata(doc, true) on the own engine — Info + catalog XMP +
 * page-level /PieceInfo //Metadata + annotation /M dates. Mutates the
 * parsed graphs; the deletions feed rewriteDocument.
 */
export function stripAllMetadataOwn(doc: ParsedPdf): StripReport {
  const report: StripReport = {
    removedFields: [],
    removedXmp: false,
    removedPieceInfo: 0,
    removedPageMetadata: 0,
    removedAnnotationDates: 0,
    deletions: new Set(),
    dropInfo: false,
  };

  // Info dict (trailer /Info ref).
  const info = doc.trailer.get("Info");
  if (info && info.k === "ref") {
    const infoObj = doc.getObject(info.num);
    if (infoObj && (infoObj.k === "dict" || infoObj.k === "stream")) {
      for (const [key] of infoObj.m) report.removedFields.push(key);
    }
    report.deletions.add(info.num);
    report.dropInfo = true;
  }

  // Catalog /Metadata (the XMP stream object).
  const root = doc.trailer.get("Root");
  if (root && root.k === "ref") {
    const catalog = doc.getObject(root.num);
    if (catalog && (catalog.k === "dict" || catalog.k === "stream")) {
      const meta = catalog.m.get("Metadata");
      if (meta !== undefined) {
        if (meta.k === "ref") report.deletions.add(meta.num);
        catalog.m.delete("Metadata");
        report.removedXmp = true;
      }
    }
  }

  // Page level: /PieceInfo, /Metadata, annotation /M timestamps.
  for (const page of listPages(doc)) {
    const dropRefKey = (key: string): boolean => {
      const value = page.dict.get(key);
      if (value === undefined) return false;
      if (value.k === "ref") report.deletions.add(value.num);
      page.dict.delete(key);
      return true;
    };
    if (dropRefKey("PieceInfo")) report.removedPieceInfo += 1;
    if (dropRefKey("Metadata")) report.removedPageMetadata += 1;
    const annots = page.dict.get("Annots");
    if (annots && annots.k === "arr") {
      for (const entry of annots.items) {
        const annot = resolveDirect(doc, entry);
        if (annot && (annot.k === "dict" || annot.k === "stream")) {
          if (annot.m.has("M")) {
            annot.m.delete("M");
            report.removedAnnotationDates += 1;
          }
        }
      }
    }
  }

  return report;
}

export { asNum };
