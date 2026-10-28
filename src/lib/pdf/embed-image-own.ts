/**
 * Shared image-embed helper for the OWN-engine document→PDF converters
 * (P6-m) — the pdf-lib-free twin of embed-image.ts (audit R4-a):
 *
 * word-to-pdf (docx media/* parts) needs the same "resolve bytes →
 * embed into the doc → honest result" flow on OUR CreateContext, so it
 * lives here once instead of a diverging copy:
 *
 *  - sniffEmbedKind (re-exported from the pdf-lib twin — it is pure
 *    byte-magic sniffing, zero pdf-lib surface);
 *  - embedDocumentImageOwn: embeds the ORIGINAL bytes (zero re-encode
 *    quality loss) and only re-encodes when the source exceeds
 *    MAX_EMBED_PIXELS on its long edge or carries a non-trivial EXIF
 *    orientation — the imagegrid downscale recipe (createImageBitmap +
 *    OffscreenCanvas, EXIF "from-image", JPEG 0.92 for photos / PNG for
 *    graphics). The canvas path exists only in browser workers; under
 *    bun (smokes) the original bytes embed as-is, which keeps every
 *    smoke deterministic.
 *
 * Every failure mode returns null — never throws — so a corrupt or
 * unsupported image degrades to the caller's honest fallback text.
 * Embeds are SYNC on our engine (the P6-k imagegrid recipe).
 */

import type { CreateContext, CreateImage } from "@/lib/own/pdf";

import { readJpegOrientation } from "../images/jpeg-exif";
import { MAX_EMBED_PIXELS, sniffEmbedKind, type EmbedKind } from "./embed-image";

export { MAX_EMBED_PIXELS, sniffEmbedKind };
export type { EmbedKind };

export interface EmbeddedImageOwn {
  image: CreateImage;
  /** Intrinsic pixel dims of the EMBEDDED bitmap (post downscale). */
  width: number;
  height: number;
  /** true when the source was re-encoded (oversized / EXIF-rotated). */
  downscaled: boolean;
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
 * Embeds one sniffed image into `doc` (SYNC embeds — our engine).
 * Returns null when the bytes are not PNG/JPEG or the engine rejects
 * them (corrupt) — the caller's honest skip. Oversized sources are
 * downscaled only when the browser canvas APIs exist; otherwise the
 * original bytes embed untouched.
 */
export async function embedDocumentImageOwn(
  doc: CreateContext,
  bytes: Uint8Array
): Promise<EmbeddedImageOwn | null> {
  const kind = sniffEmbedKind(bytes);
  if (kind === null) return null;
  let image: CreateImage;
  try {
    image = kind === "png" ? doc.embedPng(bytes) : doc.embedJpeg(bytes);
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
        const re = kind === "png" ? doc.embedPng(smaller.bytes) : doc.embedJpeg(smaller.bytes);
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
