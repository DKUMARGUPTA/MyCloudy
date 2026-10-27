/**
 * WebP encode capability probe + blob verification for the PDF → images
 * family (pdf-to-webp, TOOLS-B1-a).
 *
 * REALITY CHECK this module exists for: OffscreenCanvas.convertToBlob is
 * the intended WebP encoder, but some browsers (older Safari) SILENTLY
 * fall back to PNG when asked for image/webp — no error, just a PNG blob
 * with the wrong bytes for a .webp name. The worker therefore
 *   1. probes the capability once BEFORE rendering (fail fast instead
 *      of after minutes of page renders), and
 *   2. verifies every returned blob's MIME (the authoritative check).
 * Either failure surfaces as the honest error code below — the UI shows
 * error codes nicely via the i18n key webpOut.errorUnsupported.
 *
 * Pure + injectable canvas: no top-level DOM/worker globals, so Bun
 * smokes import it and pass mocked canvas factories. iOS-safe: no
 * matchAll/replaceAll, no regex lookbehind, no Object.hasOwn/
 * structuredClone anywhere in here.
 */

/** The MIME we ask convertToBlob for and require back. */
export const WEBP_MIME = "image/webp";

/** Error code posted by the worker when WebP encoding isn't possible. */
export const WEBP_UNSUPPORTED_CODE = "webpOut.errorUnsupported";

/**
 * Minimal 2D context surface the probe needs — structurally satisfied by
 * OffscreenCanvasRenderingContext2D and by smoke mocks (whose fillStyle
 * is a plain string, which the union happily accepts).
 */
export interface ProbeContext2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
}

/**
 * Minimal canvas surface the probe needs — structurally satisfied by
 * OffscreenCanvas, and by mocks in the smoke.
 */
export interface ProbeCanvas {
  width: number;
  height: number;
  getContext(type: "2d"): ProbeContext2D | null;
  convertToBlob(options: {
    type: string;
    quality?: number;
  }): Promise<Blob>;
}

export type ProbeCanvasFactory = () => ProbeCanvas;

/** Default factory — real OffscreenCanvas (worker runtime only). */
export function defaultWebpProbeCanvas(): ProbeCanvas {
  return new OffscreenCanvas(1, 1);
}

export interface WebpProbe {
  /** True only when the browser really encoded image/webp. */
  supported: boolean;
  /**
   * What the browser actually produced instead ("image/png" on the
   * silent-PNG fallback, "none" for an empty type, "error"/"no-2d-context"
   * for hard failures) — used as the error detail.
   */
  observed: string;
}

/**
 * Authoritative blob check, single source of truth for "is this really
 * a WebP": both the probe and the worker's per-page verification call it.
 */
export type WebpVerify =
  | { ok: true; blob: Blob }
  | { ok: false; code: typeof WEBP_UNSUPPORTED_CODE; detail: string };

export function verifyWebpBlob(blob: Blob): WebpVerify {
  if (blob.type === WEBP_MIME) return { ok: true, blob };
  return {
    ok: false,
    code: WEBP_UNSUPPORTED_CODE,
    detail: blob.type && blob.type.length > 0 ? blob.type : "none",
  };
}

/** Encode one tiny 1×1 canvas as WebP and check what came back. */
export async function probeWebpEncode(
  makeCanvas: ProbeCanvasFactory = defaultWebpProbeCanvas
): Promise<WebpProbe> {
  try {
    const canvas = makeCanvas();
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) return { supported: false, observed: "no-2d-context" };
    context.fillStyle = "#806a52";
    context.fillRect(0, 0, 1, 1);
    const blob = await canvas.convertToBlob({ type: WEBP_MIME, quality: 0.8 });
    const verdict = verifyWebpBlob(blob);
    return verdict.ok
      ? { supported: true, observed: WEBP_MIME }
      : { supported: false, observed: verdict.detail };
  } catch {
    return { supported: false, observed: "error" };
  }
}
