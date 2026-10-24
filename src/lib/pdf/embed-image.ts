/**
 * Shared image-embed helper for the document→PDF converters (audit R4-a).
 *
 * markdown-to-pdf (images dropped alongside the .md), word-to-pdf (docx
 * media/* parts) and epub-to-pdf (chapter images) all need the same
 * "resolve bytes → embed into pdf-lib → honest result" flow, so it lives
 * here once instead of three diverging copies:
 *
 *  - sniffEmbedKind: PNG / JPEG magic only — GIF/SVG/WebP/BMP are NOT
 *    embeddable by pdf-lib and return null (callers count an honest skip;
 *    no network, no canvas polyfills, on-device promise kept).
 *  - embedDocumentImage: embeds the ORIGINAL bytes (zero re-encode
 *    quality loss) and only re-encodes when the source exceeds
 *    MAX_EMBED_PIXELS on its long edge — the imagegrid downscale recipe
 *    (createImageBitmap + OffscreenCanvas, EXIF "from-image", JPEG 0.92
 *    for photos / PNG for graphics). The canvas path exists only in
 *    browser workers; under bun (smokes) the original bytes embed as-is,
 *    which keeps every smoke deterministic.
 *
 * Every failure mode returns null — never throws — so a corrupt or
 * unsupported image degrades to the caller's honest fallback text.
 */

import type { PDFDocument, PDFImage } from "pdf-lib";

import { readJpegOrientation } from "../images/jpeg-exif";

/** Long-edge pixel cap before an image is re-encoded (imagegrid's cap). */
export const MAX_EMBED_PIXELS = 2048;

export type EmbedKind = "png" | "jpg";

export interface EmbeddedImage {
  image: PDFImage;
  /** Intrinsic pixel dims of the EMBEDDED bitmap (post downscale). */
  width: number;
  height: number;
  /** true when the source was re-encoded (oversized / EXIF-rotated). */
  downscaled: boolean;
}

/** PNG (\x89PNG) or JPEG (\xFF\xD8\xFF) magic; null for anything else. */
export function sniffEmbedKind(bytes: Uint8Array): EmbedKind | null {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  return null;
}

interface Canvas2D {
  fillStyle?: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(source: unknown, dx: number, dy: number, dw: number, dh: number): void;
}

/** Browser worker canvas APIs — absent under bun/node smokes. */
function canvasApis():
  | {
      createImageBitmap: (blob: Blob, opts: { imageOrientation: string }) => Promise<ImageBitmap>;
      OffscreenCanvas: new (w: number, h: number) => {
        getContext(kind: "2d"): Canvas2D | null;
        convertToBlob(opts: { type: string; quality?: number }): Promise<Blob>;
      };
    }
  | null {
  const g = globalThis as {
    createImageBitmap?: unknown;
    OffscreenCanvas?: unknown;
  };
  if (typeof g.createImageBitmap !== "function" || typeof g.OffscreenCanvas !== "function") {
    return null;
  }
  return {
    createImageBitmap: g.createImageBitmap as never,
    OffscreenCanvas: g.OffscreenCanvas as never,
  };
}

/**
 * Downscale + re-encode an oversized bitmap (imagegrid recipe: EXIF
 * "from-image", fit inside the pixel cap, JPEG 0.92 for photos, PNG for
 * graphics). Returns null when anything fails — the caller then keeps
 * the already-embedded original bytes.
 */
async function downscale(
  bytes: Uint8Array,
  kind: EmbedKind
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  const apis = canvasApis();
  if (apis === null) return null;
  try {
    const blob = new Blob([bytes as unknown as BlobPart], {
      type: kind === "png" ? "image/png" : "image/jpeg",
    });
    const bitmap = await apis.createImageBitmap(blob, { imageOrientation: "from-image" });
    const scale = Math.min(
      1,
      MAX_EMBED_PIXELS / Math.max(1, bitmap.width),
      MAX_EMBED_PIXELS / Math.max(1, bitmap.height)
    );
    const outW = Math.max(1, Math.round(bitmap.width * scale));
    const outH = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new apis.OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext("2d");
    if (ctx === null) return null;
    if (kind === "jpg") {
      // JPEG has no alpha — flatten onto white like imagegrid does.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, outW, outH);
    }
    ctx.drawImage(bitmap, 0, 0, outW, outH);
    const out = await canvas.convertToBlob({
      type: kind === "png" ? "image/png" : "image/jpeg",
      quality: kind === "png" ? undefined : 0.92,
    });
    return {
      bytes: new Uint8Array(await out.arrayBuffer()),
      width: outW,
      height: outH,
    };
  } catch {
    return null;
  }
}

/**
 * Embeds one sniffed image into `doc`. Returns null when the bytes are
 * not PNG/JPEG or pdf-lib rejects them (corrupt) — the caller's honest
 * skip. Oversized sources are downscaled only when the browser canvas
 * APIs exist; otherwise the original bytes embed untouched.
 */
export async function embedDocumentImage(
  doc: PDFDocument,
  bytes: Uint8Array
): Promise<EmbeddedImage | null> {
  const kind = sniffEmbedKind(bytes);
  if (kind === null) return null;
  let image: PDFImage;
  try {
    image = kind === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch {
    return null;
  }
  if (image.width <= 0 || image.height <= 0) return null;

  // EXIF-rotated JPEGs embed sideways — bake the rotation when the
  // decode path exists (same rule as the imagegrid fast path).
  const rotatedJpeg = kind === "jpg" && readJpegOrientation(bytes) !== 1;
  if (
    (Math.max(image.width, image.height) > MAX_EMBED_PIXELS || rotatedJpeg) &&
    canvasApis() !== null
  ) {
    const smaller = await downscale(bytes, kind);
    if (smaller !== null) {
      try {
        const re = kind === "png" ? await doc.embedPng(smaller.bytes) : await doc.embedJpg(smaller.bytes);
        if (re.width > 0 && re.height > 0) {
          return { image: re, width: re.width, height: re.height, downscaled: true };
        }
      } catch {
        /* keep the original embed below */
      }
    }
  }
  return {
    image,
    width: image.width,
    height: image.height,
    downscaled: false,
  };
}
