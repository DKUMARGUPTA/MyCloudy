import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  type PDFContext,
  type PDFDocument,
  type PDFRef,
} from "pdf-lib";

// PDFRef is also used as a value (instanceof checks) — alias for clarity.
const isRef = (obj: unknown): obj is PDFRef =>
  typeof obj === "object" && obj !== null && "objectNumber" in obj;

/**
 * Compress PDF engine (PRD §7.5, device mode).
 *
 * Strategy: the file's embedded PHOTOS are re-encoded as JPEG at a chosen
 * quality + max pixel size; text, fonts and vector art are untouched, so
 * selectable text stays selectable. Stream replacement is object-level:
 * each image XObject's indirect object is swapped for a new PDFRawStream
 * (DCTDecode) with updated /Width /Height /ColorSpace — the page content
 * stream's cm matrix stretches the image into the same drawn box, so
 * dimension changes are safe.
 *
 * This module is the PURE part (no canvas/browser APIs) so scripts can
 * unit-probe it under bun:
 *   - preset → params resolution + clamping
 *   - image discovery + decode-strategy classification
 *   - replacement dict building
 * The worker owns the impure decode/encode (OffscreenCanvas etc.).
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
  ref: PDFRef;
  stream: PDFRawStream;
  width: number;
  height: number;
  strategy: ImageStrategy;
  /** Component count for raw-* strategies (1/3/4). */
  components: number;
  /** Original compressed stream size (bytes). */
  sourceBytes: number;
}

const DECODABLE_FILTERS = new Set([
  PDFName.of("FlateDecode"),
  PDFName.of("LZWDecode"),
  PDFName.of("ASCII85Decode"),
  PDFName.of("ASCIIHexDecode"),
  PDFName.of("RunLengthDecode"),
]);
const DCT = PDFName.of("DCTDecode");

function dictNumber(dict: PDFDict, key: string): number | null {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFNumber ? value.asNumber() : null;
}

/** Resolved /Filter chain as pooled names (empty when none). */
function filterNames(dict: PDFDict): PDFName[] {
  const filter = dict.lookup(PDFName.of("Filter"));
  if (filter instanceof PDFName) return [filter];
  if (filter instanceof PDFArray) {
    const names: PDFName[] = [];
    for (let i = 0; i < filter.size(); i += 1) {
      const item = filter.lookup(i);
      if (item instanceof PDFName) names.push(item);
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
export function classifyImage(
  dict: PDFDict,
  stream: PDFRawStream
): ImageStrategy {
  if (dictNumber(dict, "ImageMask") === 1) return "skip";

  const filters = filterNames(dict);
  if (filters.length === 0) return "skip";
  if (filters.length === 1 && filters[0] === DCT) {
    return "jpeg";
  }
  if (filters.includes(DCT)) return "skip"; // e.g. Flate(DCT(...)) — rare, skip
  if (!filters.every((f) => DECODABLE_FILTERS.has(f))) {
    return "skip"; // JPX / CCITT / JBIG2 …
  }

  // Losslessly-decoded pixels: interpret the colorspace.
  const bpc = dictNumber(dict, "BitsPerComponent") ?? 8;
  if (bpc !== 8) return "skip"; // 1/2/4-bit handled only via Indexed below

  const colorSpace = dict.lookup(PDFName.of("ColorSpace"));
  if (colorSpace instanceof PDFName) {
    const cs = colorSpace;
    if (
      cs === PDFName.of("DeviceGray") ||
      cs === PDFName.of("CalGray")
    )
      return "raw-gray";
    if (
      cs === PDFName.of("DeviceRGB") ||
      cs === PDFName.of("CalRGB")
    )
      return "raw-rgb";
    if (cs === PDFName.of("DeviceCMYK")) return "raw-cmyk";
    return "skip"; // Lab, Separation, …
  }
  if (colorSpace instanceof PDFArray) {
    const family = colorSpace.lookup(0);
    if (family instanceof PDFName) {
      if (family === PDFName.of("Indexed")) return "indexed";
      if (
        family === PDFName.of("ICCBased") ||
        family === PDFName.of("CalRGB") ||
        family === PDFName.of("CalGray")
      ) {
        const n = colorSpace.lookup(1);
        if (n instanceof PDFNumber) {
          if (n.asNumber() === 1) return "raw-gray";
          if (n.asNumber() === 3) return "raw-rgb";
          if (n.asNumber() === 4) return "raw-cmyk";
        }
        return "skip";
      }
    }
  }
  return "skip";
}

/**
 * Collects compressible image XObjects from the whole document — every
 * indirect object that is a stream with /Subtype /Image — excluding the
 * /SMask + /Mask objects referenced by other images (their bytes are alpha
 * data whose colorspace belongs to the parent — re-encoding them as
 * lossy RGB JPEG would corrupt the parent's transparency).
 */
export function collectImageCandidates(doc: PDFDocument): ImageCandidate[] {
  const context = doc.context;
  const protectedRefs = new Set<string>();

  // Pass 1: find every image object + remember the alpha-mask ones.
  const images: { ref: PDFRef; stream: PDFRawStream; dict: PDFDict }[] = [];
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    const subtype = dict.lookup(PDFName.of("Subtype"));
    if (!(subtype instanceof PDFName) || subtype !== PDFName.of("Image")) {
      continue;
    }
    images.push({ ref, stream: obj, dict });
    for (const key of ["SMask", "Mask"]) {
      const mask = dict.get(PDFName.of(key));
      if (isRef(mask)) protectedRefs.add(`$${mask.objectNumber}`);
    }
  }

  // Pass 2: classify (drop alpha-mask objects).
  const candidates: ImageCandidate[] = [];
  for (const { ref, stream, dict } of images) {
    if (protectedRefs.has(`$${ref.objectNumber}`)) continue;
    const width = dictNumber(dict, "Width");
    const height = dictNumber(dict, "Height");
    if (!width || !height || width < 8 || height < 8) continue; // bullets, dots
    const strategy = classifyImage(dict, stream);
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
      ref,
      stream,
      width,
      height,
      strategy,
      components,
      sourceBytes: stream.contents.length,
    });
  }
  return candidates;
}

/**
 * Builds the replacement image stream dict for a re-encoded JPEG and
 * assigns it to the original ref. Keys carried over: /SMask, /Mask, /Name
 * (legacy viewers) and /Interpolate (viewer smoothing).
 */
export function replaceImageStream(
  context: PDFContext,
  candidate: ImageCandidate,
  jpegBytes: Uint8Array,
  newWidth: number,
  newHeight: number
): void {
  const old = candidate.stream.dict;
  const dict = PDFDict.withContext(context);
  dict.set(PDFName.of("Type"), PDFName.of("XObject"));
  dict.set(PDFName.of("Subtype"), PDFName.of("Image"));
  dict.set(PDFName.of("Width"), PDFNumber.of(newWidth));
  dict.set(PDFName.of("Height"), PDFNumber.of(newHeight));
  // The canvas JPEG encoder always emits 3-component YCbCr; the alpha
  // channel (if any) lives in the preserved /SMask, so this is always RGB.
  // (Grayscale luminance is still stored as 3 identical channels — safe
  // and universally supported; a true 1-component encoder isn't available.)
  dict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
  dict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
  dict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
  for (const key of ["SMask", "Mask", "Name", "Interpolate"]) {
    const carried = old.get(PDFName.of(key));
    if (carried !== undefined) dict.set(PDFName.of(key), carried);
  }
  context.assign(candidate.ref, PDFRawStream.of(dict, jpegBytes));
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

/** Component count for a /Indexed base colorspace name (null = unsupported). */
export function indexedBaseComponents(base: PDFName): number | null {
  if (base === PDFName.of("DeviceGray") || base === PDFName.of("CalGray"))
    return 1;
  if (base === PDFName.of("DeviceRGB") || base === PDFName.of("CalRGB"))
    return 3;
  if (base === PDFName.of("DeviceCMYK")) return 4;
  return null;
}

export interface PaletteInfo {
  baseComponents: number;
  palette: Uint8Array;
}

/**
 * Palette lookup for /Indexed images: resolves [/Indexed base hival lookup]
 * to a base-component count + a flat palette. Returns null when the palette
 * is stored as a stream (the worker resolves that case) or the base
 * colorspace is unsupported.
 */
export function indexedPalette(
  dict: PDFDict
): PaletteInfo | null {
  const colorSpace = dict.lookup(PDFName.of("ColorSpace"));
  if (!(colorSpace instanceof PDFArray) || colorSpace.size() < 4) return null;
  const base = colorSpace.lookup(1);
  if (!(base instanceof PDFName)) return null;
  const baseComponents = indexedBaseComponents(base);
  if (baseComponents === null) return null;
  const lookup = colorSpace.lookup(3);
  if (lookup instanceof PDFString) {
    return {
      baseComponents,
      palette: new Uint8Array(lookup.asBytes()),
    };
  }
  return null; // stream-backed palettes are handled by the worker
}
