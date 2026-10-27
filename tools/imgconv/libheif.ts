/**
 * Shared libheif (HEIC/HEIF → RGBA) loader for Web Workers.
 *
 * The decoder is libheif (LGPL-3.0) compiled to WebAssembly by the
 * libheif-js project, VENDORED at /public/vendor/libheif/ (same
 * self-hosting rule as pdf.js and qpdf, PRD §2.3 — no CDN, nothing
 * leaves the device). The 2 MB single-file ESM bundle (glue + inlined
 * wasm) is fetched ONLY when a HEIC decode actually runs — it is never
 * part of any app or worker chunk.
 *
 * Import it (dynamic, turbopack-ignored) → default export is a factory
 * that compiles the inlined wasm synchronously and returns the module.
 * We then drive the low-level `heif_js_decode_image2` API ourselves so
 * the CHANNEL's width/height/stride are the truth — those are the
 * post-irot/imir (iPhone EXIF-style rotation) dimensions, unlike the
 * stored handle dimensions.
 */

/** Interleaved RGBA channel as produced for colorspace_RGB/interleaved_RGBA. */
interface HeifChannel {
  id: unknown;
  width: number;
  height: number;
  stride: number;
  data: Uint8Array;
}

interface HeifDecodeResult {
  code?: number;
  subcode?: number;
  message?: string;
  image?: unknown;
  channels?: HeifChannel[];
}

interface HeifImageHandle {
  get_width(): number;
  get_height(): number;
  has_alpha_channel(): boolean;
  /** Raw embind handle — what heif_js_decode_image2 wants. */
  handle: unknown;
}

interface LibheifModule {
  HeifDecoder: new () => {
    /** Returns the file's top-level images ([] when not parseable). */
    decode(bytes: Uint8Array): HeifImageHandle[];
  };
  heif_colorspace: { heif_colorspace_RGB: unknown };
  heif_chroma: { heif_chroma_interleaved_RGBA: unknown };
  heif_channel: { heif_channel_interleaved: unknown };
  heif_js_decode_image2(
    handle: unknown,
    colorspace: unknown,
    chroma: unknown
  ): Promise<HeifDecodeResult>;
  heif_image_release(image: unknown): void;
}

type LibheifFactory = (options?: Record<string, unknown>) => LibheifModule;

const LIBHEIF_URL = "/vendor/libheif/libheif-bundle.mjs";

/**
 * Absolute URL for a same-origin path, seen from inside the worker.
 *
 * Turbopack's dev server spins workers up on blob: URLs where a plain
 * fetch("/path") (and module resolution) has no base to resolve against.
 * The blob URL embeds the real origin, so strip the scheme and resolve
 * against the inner http(s) URL. Production workers load from real
 * chunk URLs where self.location already resolves the same way.
 */
function workerAbsoluteUrl(path: string): string {
  const href =
    typeof self !== "undefined" && self.location ? self.location.href : "";
  let base = href;
  if (base.startsWith("blob:")) base = base.slice("blob:".length);
  try {
    return new URL(path, base).href;
  } catch {
    return path;
  }
}

let modulePromise: Promise<LibheifModule> | null = null;

/** Test-only override: injects the vendored factory directly (Node/Bun
 * have no same-origin URL space for the dynamic import). */
let factoryOverride: LibheifFactory | null = null;

export function injectLibheifFactory(
  factory: (options?: Record<string, unknown>) => unknown
): void {
  factoryOverride = factory as LibheifFactory;
}

async function loadLibheif(): Promise<LibheifModule> {
  if (factoryOverride) return factoryOverride();
  if (!modulePromise) {
    modulePromise = (async () => {
      const factory = (
        (await import(
          /* webpackIgnore: true */ /* turbopackIgnore: true */ workerAbsoluteUrl(
            LIBHEIF_URL
          )
        )) as { default: LibheifFactory }
      ).default;
      if (typeof factory !== "function") {
        throw new Error("imgconv\0tool.imgconv.errorEngine");
      }
      // Factory compiles the inlined wasm synchronously (Emscripten
      // single-file build, WASM_ASYNC_COMPILATION=0 — the same shape
      // heic2any relies on in the wild).
      return factory();
    })();
    // A failed fetch/compile must not poison the pool slot forever.
    modulePromise.catch(() => {
      modulePromise = null;
    });
  }
  return modulePromise;
}

/**
 * ISOBMFF brand sniff: 'ftyp' box at offset 4 and a HEIF-family major
 * brand at offset 8. Covers Apple photos (heic/heix), generic HEIF
 * image files (mif1/mif2 — the libheif example fixtures use these),
 * sequences (msf1/heim/heis/hevm/hevs) and AVIF-in-HEIF (avic).
 */
const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "mif2",
  "msf1",
  "avic",
]);

function ascii4(head: Uint8Array, offset: number): string {
  return String.fromCharCode(
    head[offset],
    head[offset + 1],
    head[offset + 2],
    head[offset + 3]
  );
}

export function isHeifBytes(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  if (ascii4(head, 4) !== "ftyp") return false;
  return HEIF_BRANDS.has(ascii4(head, 8));
}

export function isWebpBytes(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  return ascii4(head, 0) === "RIFF" && ascii4(head, 8) === "WEBP";
}

/** Honest guard: a 48 MP photo is ~800 MB as RGBA in the wasm heap. */
export const HEIF_MAX_PIXELS = 80_000_000;

export interface RgbaImage {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  /** Any non-opaque pixel present (drives the JPEG flatten choice). */
  hasAlpha: boolean;
}

/**
 * Decodes the FIRST top-level image of a HEIC/HEIF file to RGBA.
 * Channel dims are the post-transform truth (irot/imir applied).
 * Throws `imgconv\0<i18n-key>` errors:
 *   tool.imgconv.errorNotHeif   — bytes are not a HEIF file
 *   tool.imgconv.errorCorrupt   — parse/decode failed (truncated…)
 *   tool.imgconv.errorTooLarge  — beyond HEIF_MAX_PIXELS
 */
export async function decodeHeifRgba(bytes: Uint8Array): Promise<RgbaImage> {
  if (!isHeifBytes(bytes.slice(0, 16))) {
    throw new Error("imgconv\0tool.imgconv.errorNotHeif");
  }
  const libheif = await loadLibheif();
  let images: HeifImageHandle[];
  try {
    images = new libheif.HeifDecoder().decode(bytes);
  } catch {
    throw new Error("imgconv\0tool.imgconv.errorNotHeif");
  }
  if (!images || images.length === 0) {
    throw new Error("imgconv\0tool.imgconv.errorNotHeif");
  }
  const image = images[0];

  let result: HeifDecodeResult;
  try {
    result = await libheif.heif_js_decode_image2(
      image.handle,
      libheif.heif_colorspace.heif_colorspace_RGB,
      libheif.heif_chroma.heif_chroma_interleaved_RGBA
    );
  } catch {
    throw new Error("imgconv\0tool.imgconv.errorCorrupt");
  }
  if (!result || result.code) {
    // image was never produced on failure paths — nothing to release.
    throw new Error("imgconv\0tool.imgconv.errorCorrupt");
  }

  try {
    const channel = (result.channels ?? []).find(
      (entry) =>
        entry.id === libheif.heif_channel.heif_channel_interleaved &&
        entry.width > 0 &&
        entry.height > 0
    );
    if (!channel) {
      throw new Error("imgconv\0tool.imgconv.errorCorrupt");
    }
    if (channel.width * channel.height > HEIF_MAX_PIXELS) {
      throw new Error("imgconv\0tool.imgconv.errorTooLarge");
    }

    // Row-wise copy honoring stride (rows can be padded) — copies out
    // of the wasm heap BEFORE heif_image_release frees it.
    const width = channel.width;
    const height = channel.height;
    const stride = channel.stride || width * 4;
    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      out.set(
        channel.data.subarray(y * stride, y * stride + width * 4),
        y * width * 4
      );
    }

    let hasAlpha = false;
    for (let i = 3; i < out.length; i += 4) {
      if (out[i] !== 255) {
        hasAlpha = true;
        break;
      }
    }
    return { data: out, width, height, hasAlpha };
  } finally {
    if (result.image !== undefined) {
      libheif.heif_image_release(result.image);
    }
  }
}
