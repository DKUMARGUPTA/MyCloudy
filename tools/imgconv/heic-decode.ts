/**
 * HEIC/HEIF decoding for the image conversion engine (PRD §7.10).
 *
 * Browsers other than Safari cannot decode HEIC natively, so we ship the
 * official libheif compiled to WebAssembly (`libheif-js`). The bundle is
 * ~2 MB with the .wasm embedded — it is imported LAZILY, only when a file
 * with a HEIF-family brand actually needs it, so WEBP→JPG/PNG runs never
 * download a byte of it.
 *
 * Device-only (PRD D mode): bytes go in, RGBA pixels come out, nothing
 * touches the network. HEVC, grid ("high efficiency" iPhone bursts) and
 * irot/imir orientation are handled inside libheif.
 */

import type { OptionValues } from "@/lib/tools/config-types";

/** Same code/detail contract the shared workers speak (see protocol.ts). */
export type DecodeFail = (code: string, detail: string) => never;

/** Minimal module shape we consume from the wasm bundle (typed in src/types). */
type LibheifModule = Awaited<
  ReturnType<
    typeof import("libheif-js/libheif-wasm/libheif-bundle.mjs")["default"]
  >
>;

let libheifPromise: Promise<LibheifModule> | null = null;

function loadLibheif(): Promise<LibheifModule> {
  if (!libheifPromise) {
    libheifPromise = import(
      /* turbopackIgnore: false */ "libheif-js/libheif-wasm/libheif-bundle.mjs"
    ).then((mod) => mod.default());
  }
  return libheifPromise;
}

/** RGBA pixels straight out of the wasm decoder (ImageData-free so the
 * module also runs under bun for machine smoke tests — workers wrap this
 * into a real ImageData next to createImageBitmap). */
export interface RgbaImage {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/** Fails a whole run with the shared "decoder could not start" code. */
export async function decodeHeicToRgba(
  bytes: Uint8Array,
  fileName: string,
  fail: DecodeFail
): Promise<RgbaImage> {
  let libheif: LibheifModule;
  try {
    libheif = await loadLibheif();
  } catch {
    fail("tool.images.errorDecoderInit", fileName);
  }

  const images = new libheif.HeifDecoder().decode(bytes);
  if (!images || images.length === 0) {
    fail("tool.images.errorDecode", fileName);
  }
  // iPhone HEICs often contain the photo plus a thumbnail as separate
  // top-level items — always stamp the PRIMARY image, never the thumbnail.
  const image = images.find((entry) => entry.is_primary()) ?? images[0];

  const width = image.get_width();
  const height = image.get_height();
  if (width <= 0 || height <= 0) {
    fail("tool.images.errorDecode", fileName);
  }

  const data = new Uint8ClampedArray(width * height * 4);
  const shown = await new Promise<boolean>((resolve) => {
    image.display({ data, width, height }, (displayData) => {
      resolve(displayData !== null && displayData !== undefined);
    });
  });
  if (!shown) {
    fail("tool.images.errorDecode", fileName);
  }
  return { data, width, height };
}

/**
 * Sniff the container family from magic bytes. Returns "heif" for every
 * ISO-BMFF brand libheif understands (heic/heix/heim/heis/hevm/hevs/mif1/
 * msf1 — avif/avis are handled by the browser's own decoder first and
 * only fall back to libheif when that fails).
 */
export function sniffImageFamily(
  head: Uint8Array
): "jpeg" | "png" | "gif" | "webp" | "heif" | "unknown" {
  const has = (bytes: number[], offset = 0) =>
    bytes.every((byte, i) => head[offset + i] === byte);
  if (has([0xff, 0xd8, 0xff])) return "jpeg";
  if (has([0x89, 0x50, 0x4e, 0x47])) return "png";
  if (has([0x47, 0x49, 0x46, 0x38])) return "gif";
  if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8)) {
    return "webp";
  }
  if (head.length >= 12 && has([0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(
      head[8],
      head[9],
      head[10],
      head[11]
    );
    if (
      ["heic", "heix", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "avif", "avis"].includes(
        brand
      )
    ) {
      return "heif";
    }
    return "unknown";
  }
  return "unknown";
}

/** Are these bytes any HEIF container (used after canvas decode fails)? */
export function isHeifFamily(head: Uint8Array): boolean {
  return sniffImageFamily(head) === "heif";
}

/**
 * Long-edge downscale target. Returns the ORIGINAL size when longEdge is
 * "original"/0 or the image already fits — we never upscale.
 */
export function scaleTarget(
  width: number,
  height: number,
  longEdge: number
): { width: number; height: number } {
  const cap = Math.max(0, Math.floor(longEdge));
  if (cap === 0) return { width, height };
  const maxEdge = Math.max(width, height);
  if (maxEdge <= cap) return { width, height };
  const scale = cap / maxEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Clamp helper for worker option numbers. */
export function numOption(
  options: OptionValues,
  id: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = Number(options[id]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
