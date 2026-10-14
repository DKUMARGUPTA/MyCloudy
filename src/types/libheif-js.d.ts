/**
 * Ambient types for the self-contained libheif wasm bundle shipped by the
 * `libheif-js` npm package. We only use the classic HeifDecoder wrapper —
 * the raw emscripten module surface is intentionally opaque here.
 *
 * The bundle embeds the .wasm binary (base64) and exports a factory that
 * resolves with the module once WebAssembly is ready.
 */
declare module "libheif-js/libheif-wasm/libheif-bundle.mjs" {
  /** One top-level image inside a HEIF container (a handle before decode). */
  interface LibheifImage {
    get_width(): number;
    get_height(): number;
    is_primary(): boolean;
    has_alpha_channel(): boolean;
    /**
     * Decodes into the caller-provided RGBA buffer. Async via callback —
     * the wrapper runs the decode on a timeout and calls back with the
     * same object (data filled) or null on failure.
     */
    display(
      data: { data: Uint8ClampedArray; width: number; height: number },
      callback: (displayData: unknown) => void
    ): void;
  }

  interface LibheifDecoder {
    /** Accepts raw HEIF bytes (Uint8Array). Returns [] on parse errors. */
    decode(data: Uint8Array): LibheifImage[];
  }

  interface LibheifModule {
    HeifDecoder: new () => LibheifDecoder;
    heif_get_version?(): string;
  }

  export default function createLibheif(options?: unknown): Promise<LibheifModule>;
}
