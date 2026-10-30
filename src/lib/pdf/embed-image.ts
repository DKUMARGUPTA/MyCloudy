/**
 * Shared image-sniffing helper for the document→PDF converters
 * (audit R4-a; P6-END trimmed to the pure core).
 *
 * markdown-to-pdf, word-to-pdf and epub-to-pdf all need the same
 * "is this embeddable?" answer, so it lives here once:
 *
 *  - sniffEmbedKind: PNG / JPEG magic only — GIF/SVG/WebP/BMP are NOT
 *    embeddable and return null (callers count an honest skip; no
 *    network, no canvas polyfills, on-device promise kept).
 *  - MAX_EMBED_PIXELS: the imagegrid long-edge cap, shared with the
 *    embed twin.
 *
 * The EMBEDDING side lives in embed-image-own.ts (the own-engine twin,
 * P6-m) — this module is deliberately pdf-lib-free and pure so bun smokes
 * stay deterministic.
 */

/** Long-edge pixel cap before an image is re-encoded (imagegrid's cap). */
export const MAX_EMBED_PIXELS = 2048;

export type EmbedKind = "png" | "jpg";

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
