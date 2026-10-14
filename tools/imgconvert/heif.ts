import { rgbToRgba } from "./engine";

/**
 * libheif glue for the HEIC/HEIF image converters (PRD §7.10).
 *
 * The decoder is the self-hosted libheif wasm bundle deployed at
 * /heic/libheif-bundle.mjs (LGPL — NOTICE.txt + license sit beside it) and
 * is loaded ONCE per worker with the established self-hosted-asset pattern
 * (non-literal dynamic import + bundler ignore comments, like
 * tools/pdf-to-images/worker.ts loads pdf.js). Only the PRIMARY image of a
 * multi-image file (bursts, live-photo stills) is decoded — that is what
 * heic-to-jpg sites do.
 *
 * decodeHeicWithModule keeps the whole call sequence pure-module so the bun
 * smoke test can drive the EXACT production decode with a directly
 * imported copy of the same bundle.
 */

/** One decoded plane as returned by heif_js_decode_image2. */
export interface HeifChannel {
  id: unknown;
  stride: number;
  data: Uint8Array;
  width: number;
  height: number;
  bits_per_pixel: number;
}

/** heif_js_decode_image2 success shape (embind objects stay opaque). */
export interface HeifDecodedImage {
  width: number;
  height: number;
  channels: HeifChannel[];
  image: unknown;
}

/** embind heif_error-ish object: code/subcode are enum wrappers (or numbers). */
export interface HeifErrorLike {
  code?: { value?: number } | number;
  message?: string;
}

/** The slice of the bundle the converters actually call. */
export interface HeifModule {
  heif_context_alloc(): unknown;
  heif_context_read_from_memory(
    context: unknown,
    data: ArrayBuffer
  ): HeifErrorLike | null;
  heif_js_context_get_primary_image_handle(context: unknown): unknown;
  heif_js_decode_image2(
    handle: unknown,
    colorspace: unknown,
    chroma: unknown
  ): HeifDecodedImage;
  heif_image_release(image: unknown): void;
  heif_image_handle_release(handle: unknown): void;
  heif_context_free(context: unknown): void;
  readonly heif_colorspace_RGB: unknown;
  readonly heif_chroma_interleaved_RGB: unknown;
  readonly heif_chroma_interleaved_RGBA: unknown;
}

let heifPromise: Promise<HeifModule> | null = null;

async function getLibheif(): Promise<HeifModule> {
  if (!heifPromise) {
    heifPromise = (async () => {
      const url = "/heic/libheif-bundle.mjs";
      const mod = (await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ url
      )) as { default: () => Promise<HeifModule> | HeifModule };
      const maybe = mod.default();
      // The bundle may hand back a promise (first boot) or the already
      // initialized module — accept both.
      return maybe &&
        typeof (maybe as { then?: unknown }).then === "function"
        ? ((await maybe) as HeifModule)
        : maybe;
    })();
  }
  return heifPromise;
}

/** Normalize an embind error code (enum wrapper or plain number) — 0 = OK. */
function heifErrorCode(error: HeifErrorLike | null | undefined): number {
  if (error === null || error === undefined) return 0;
  const code = error.code;
  if (typeof code === "number") return code;
  if (code && typeof code === "object" && typeof code.value === "number") {
    return code.value;
  }
  return 0;
}

/**
 * Distinguish a returned error object ({ code, subcode, message }) from a
 * real handle / decode result: embind handles expose none of those, while
 * decode results carry `channels`.
 */
function isHeifError(value: unknown): value is HeifErrorLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    !("channels" in value)
  );
}

/** Decoded HEIC pixels in ImageData layout (RGBA, alpha preserved). */
export interface HeicImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * Decode the PRIMARY image of an HEIC/HEIF buffer to RGBA ImageData layout.
 * Rows are read honoring the plane `stride`; an RGB plane (requested RGBA
 * not honored for some file) is expanded with alpha 255. Cleanup releases
 * image, handle and context in try/catch — a cleanup failure must never
 * kill a finished decode.
 *
 * Throws Error("imgconv:heic") for anything undecodable; the worker maps
 * that onto the honest i18n error.
 */
export function decodeHeicWithModule(
  libheif: HeifModule,
  buffer: ArrayBuffer
): HeicImageData {
  const context = libheif.heif_context_alloc();
  let handle: unknown = null;
  let decoded: HeifDecodedImage | null = null;
  try {
    try {
      const readError = libheif.heif_context_read_from_memory(
        context,
        buffer
      );
      if (heifErrorCode(readError) !== 0) throw new Error("imgconv:heic");

      handle = libheif.heif_js_context_get_primary_image_handle(context);
      if (isHeifError(handle)) throw new Error("imgconv:heic");

      const result = libheif.heif_js_decode_image2(
        handle,
        libheif.heif_colorspace_RGB,
        libheif.heif_chroma_interleaved_RGBA
      );
      decoded = result;
      if (
        !Array.isArray(result.channels) ||
        result.channels.length === 0 ||
        !Number.isInteger(result.width) ||
        !Number.isInteger(result.height) ||
        result.width <= 0 ||
        result.height <= 0
      ) {
        throw new Error("imgconv:heic");
      }
    } catch (error) {
      // Anything embind throws (bad bindings, empty buffers, decode
      // failures) collapses into the one honest tagged error — the worker
      // maps it to a single i18n message.
      if (error instanceof Error && error.message === "imgconv:heic") {
        throw error;
      }
      throw new Error("imgconv:heic");
    }

    const { width, height } = decoded;
    const channel = decoded.channels[0];
    if (
      !(channel.data instanceof Uint8Array) ||
      channel.stride < width ||
      channel.data.length < (height - 1) * channel.stride + channel.stride
    ) {
      throw new Error("imgconv:heic");
    }

    // Component count from the plane we actually got: exact stride match
    // first, total length as the padded-stride fallback.
    const components =
      channel.stride === width * 4
        ? 4
        : channel.stride === width * 3
          ? 3
          : channel.data.length >= width * height * 4
            ? 4
            : 3;

    if (components === 3) {
      return {
        width,
        height,
        data: rgbToRgba(channel.data, width, height, channel.stride),
      };
    }
    const out = new Uint8ClampedArray(
      new ArrayBuffer(width * height * 4)
    );
    for (let y = 0; y < height; y += 1) {
      const src = y * channel.stride;
      out.set(
        channel.data.subarray(src, src + width * 4),
        y * width * 4
      );
    }
    return { width, height, data: out };
  } finally {
    try {
      if (decoded) libheif.heif_image_release(decoded.image);
    } catch {
      // Cleanup must never mask a finished decode or its error.
    }
    try {
      if (handle) libheif.heif_image_handle_release(handle);
    } catch {
      // see above
    }
    try {
      if (context) libheif.heif_context_free(context);
    } catch {
      // see above
    }
  }
}

/** Worker-facing decode: loads the wasm bundle once, then decodes. */
export async function decodeToImageData(
  buffer: ArrayBuffer
): Promise<HeicImageData> {
  const libheif = await getLibheif();
  return decodeHeicWithModule(libheif, buffer);
}
