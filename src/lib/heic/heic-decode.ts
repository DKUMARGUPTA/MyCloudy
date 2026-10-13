/**
 * Worker-side HEIC/HEIF decoding (PRD §8.6 HEIC tools + §2.3 stack).
 *
 * Self-hosted libheif (Emscripten WASM build, libheif-js 1.23.5) is copied
 * UNMODIFIED to /public/libheif/libheif-bundle.mjs (wasm embedded inside
 * the module — single file, no runtime fetches, CDN-free per PRD §2.2).
 *
 * License: libheif is LGPL-3.0 — the license text ships alongside the
 * bundle in /public/libheif/LICENSE-LGPL-3.0 and the library is used
 * unmodified from npm, satisfying LGPL §4 (corresponding source is the
 * published libheif-js release this file was copied from).
 *
 * The module lazy-loads once per worker, then decodes images to raw RGBA:
 *   decodeHeic(bytes) -> { width, height, rgba: Uint8ClampedArray }
 *   decodeHeicToBitmap(bytes) -> ImageBitmap (plugs into canvas pipelines)
 *
 * Errors throw with a marker used by callers to map to honest i18n keys:
 * empty decode result → corrupt/unsupported; display() failing → damaged.
 */

interface LibheifImage {
  get_width(): number;
  get_height(): number;
  display(
    imageData: { data: Uint8ClampedArray; width: number; height: number },
    callback: (data: unknown) => void
  ): void;
}

interface LibheifModule {
  HeifDecoder: new () => {
    decode(data: ArrayBuffer | Uint8Array): LibheifImage[];
  };
}

let modulePromise: Promise<LibheifModule> | null = null;

// Variable URL — same pattern as the self-hosted pdf.js loader: keeps TS
// from resolving the public asset as a module and Turbopack from bundling
// it (turbopackIgnore comments above the import).
const LIBHEIF_URL = "/libheif/libheif-bundle.mjs";

function loadLibheif(): Promise<LibheifModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const factory = (
        (await import(
          /* webpackIgnore: true */ /* turbopackIgnore: true */
          LIBHEIF_URL
        )) as { default: (options?: unknown) => Promise<LibheifModule> }
      ).default;
      return await factory();
    })();
    // A failed load (e.g. dev server restart mid-request) must not poison
    // the cache — drop it so the next decode retries cleanly.
    modulePromise.catch(() => {
      modulePromise = null;
    });
  }
  return modulePromise;
}

export interface HeicRgba {
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

/** Decode the primary image of a HEIC/HEIF file into raw RGBA pixels. */
export async function decodeHeic(bytes: Uint8Array): Promise<HeicRgba> {
  const libheif = await loadLibheif();
  const decoder = new libheif.HeifDecoder();
  let images: LibheifImage[];
  try {
    images = decoder.decode(bytes);
  } catch {
    throw new Error("heic-decode-failed");
  }
  if (!images || images.length === 0) {
    // libheif signals "not a HEIF / unsupported codec" as an empty array.
    throw new Error("heic-decode-failed");
  }
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  if (!width || !height || width * height > 268_435_456) {
    // >1 gigapixel is never a real photo — guard the allocation.
    throw new Error("heic-decode-failed");
  }

  const data = new Uint8ClampedArray(width * height * 4);
  await new Promise<void>((resolve, reject) => {
    try {
      image.display({ data, width, height }, (displayData: unknown) => {
        if (!displayData) reject(new Error("heic-display-failed"));
        else resolve();
      });
    } catch {
      reject(new Error("heic-display-failed"));
    }
  });
  return { width, height, rgba: data };
}

/** Decode HEIC to an ImageBitmap for canvas pipelines (rotate/re-encode). */
export async function decodeHeicToBitmap(bytes: Uint8Array): Promise<ImageBitmap> {
  const { width, height, rgba } = await decodeHeic(bytes);
  const imageData = new ImageData(rgba, width, height);
  return await createImageBitmap(imageData);
}
