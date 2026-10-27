/**
 * Output-format specs for the PDF → images family (pdf-to-jpg,
 * pdf-to-png, pdf-to-webp, pdf-to-tiff, pdf-to-svg) — pure data + pure
 * helpers, shared by tools/pdf-to-images/worker.ts and the family's smokes.
 *
 * Kept free of any DOM/worker global so smokes can import it under Bun.
 */

/** One output format — fixed by the tool identity, not an option. */
export interface OutputFormatSpec {
  /** MIME handed to OffscreenCanvas.convertToBlob. */
  mime: string;
  /** File extension for the output names. */
  ext: string;
  /** Target keeps an alpha channel (transparent renders allowed). */
  alpha: boolean;
  /** Encoder takes a quality value (JPG, WebP — not PNG). */
  lossy: boolean;
  /**
   * convertToBlob can SILENTLY fall back to PNG for types the browser
   * can't encode (older Safari + image/webp): the worker probes the
   * capability up front and verifies every returned blob's MIME, then
   * refuses honestly instead of shipping misnamed files.
   */
  verifyMime?: boolean;
  /**
   * Clean-room encoder formats (pdf-to-tiff): the worker pulls the
   * rendered page with getImageData and encodes it with our own
   * TIFF encoder (../pdf-to-tiff/tiff-encode.ts) instead of asking
   * convertToBlob — TIFF is verified by magic bytes, not MIME.
   */
  tiff?: boolean;
  /**
   * SVG-wrapped format (pdf-to-svg): the worker PNG-encodes the
   * rendered page (convertToBlob, lossless) and wraps those bytes in
   * a scalable SVG shell (../pdf-to-svg/svg-emit.ts) at the PDF's own
   * point size — each page ships as a standalone .svg whose viewBox
   * preserves the page geometry. Verified by the embedded PNG magic.
   */
  svg?: boolean;
  /**
   * Parses the tool's quality option (raw OptionValues value) into the
   * 0..1 encoder value. Formats parse their own scale: pdf-to-jpg a
   * 40..100 percent, pdf-to-webp a 0.7..0.9 select value. Lossless
   * formats without a quality option (TIFF) simply omit it.
   */
  parseQuality?: (raw: string | number | boolean | undefined) => number;
}

/**
 * pdf-to-jpg quality: a 40..100 percent number (option default 85).
 * Byte-identical to the inline math this replaces — including the
 * NaN pass-through for garbage inputs, so live behaviour never shifts.
 */
export function parsePercentQuality(
  raw: string | number | boolean | undefined
): number {
  return Math.max(0.4, Math.min(1, Number(raw ?? 85) / 100));
}

/**
 * pdf-to-webp quality: a 0..1 select value ("0.9" | "0.85" | "0.8" |
 * "0.7", default 0.85). Garbage/NaN falls back to the default instead
 * of poisoning convertToBlob with NaN.
 */
export function parseWebpQuality(
  raw: string | number | boolean | undefined
): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0.85;
  return Math.max(0.5, Math.min(1, value));
}

/** Format table keyed by tool id (the family's single source of truth). */
export const FORMAT_SPECS: Record<string, OutputFormatSpec> = {
  "pdf-to-jpg": {
    mime: "image/jpeg",
    ext: "jpg",
    alpha: false,
    lossy: true,
    parseQuality: parsePercentQuality,
  },
  "pdf-to-png": {
    mime: "image/png",
    ext: "png",
    alpha: true,
    lossy: false,
    parseQuality: parsePercentQuality,
  },
  "pdf-to-webp": {
    mime: "image/webp",
    ext: "webp",
    alpha: true,
    lossy: true,
    verifyMime: true,
    parseQuality: parseWebpQuality,
  },
  "pdf-to-tiff": {
    mime: "image/tiff",
    ext: "tif",
    alpha: false,
    lossy: false,
    tiff: true,
  },
  "pdf-to-svg": {
    mime: "image/svg+xml",
    ext: "svg",
    alpha: true,
    lossy: false,
    svg: true,
  },
};

export function getFormatSpec(toolId: string): OutputFormatSpec {
  return FORMAT_SPECS[toolId] ?? FORMAT_SPECS["pdf-to-jpg"];
}

/** Strip the .pdf extension + path-illegal chars (worker's old inline code). */
export function pdfBaseName(fileName: string): string {
  return fileName
    .replace(/\.(pdf)$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .slice(0, 120);
}

/** Single selected page → base.ext; multi → base_pageN.ext (1-based). */
export function pageOutputName(
  base: string,
  pageNumber: number,
  totalPages: number,
  ext: string
): string {
  return totalPages === 1
    ? `${base}.${ext}`
    : `${base}_page${pageNumber}.${ext}`;
}
