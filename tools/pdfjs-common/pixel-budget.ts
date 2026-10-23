/**
 * Shared rendered-pixel RAM budget for pdf.js raster pipelines (ENH-1).
 *
 * The pdf-to-images family (pdf-to-jpg/-png/-webp/-tiff) accumulates
 * EVERY output page before the result step — encoded blobs, or raw RGBA
 * strips inside the TIFF writer — and pdf-to-powerpoint's images mode
 * holds every PNG page in RAM until the .pptx is zipped. A 300-page
 * document at high DPI walks a phone straight into an OOM tab crash.
 *
 * The budget counts the SUM of rendered pixels across the whole run
 * (width × height per page, every file) and is checked BEFORE each page
 * render: once the next page would push the run past the cap, the
 * worker refuses with the honest typed error `tool.errorRenderBudget`
 * ("too many pages at this resolution — lower DPI or split first")
 * instead of dying mid-zip with a browser crash.
 *
 * ~250 MP ≈ 119 letter pages at 150 DPI, or ~30 at 300 DPI — far above
 * normal conversions, comfortably below what a mid-range phone can
 * hold as in-flight page data.
 */

/** Default cap: total rendered pixels per run (250 megapixels). */
export const RENDER_PIXEL_BUDGET = 250_000_000;

export class RenderPixelBudget {
  readonly cap: number;
  #used = 0;

  constructor(cap: number = RENDER_PIXEL_BUDGET) {
    this.cap = Math.max(0, Math.round(cap));
  }

  /** Pixels accounted so far. */
  get consumed(): number {
    return this.#used;
  }

  /** Pixels still allowed (never negative). */
  get remaining(): number {
    return Math.max(0, this.cap - this.#used);
  }

  /**
   * Accounts a w×h page against the budget — call BEFORE rendering it.
   * Returns false (and consumes nothing) when the page would exceed the
   * remaining budget or has no finite positive area.
   */
  tryConsume(width: number, height: number): boolean {
    const pixels =
      Math.max(0, Math.round(width)) * Math.max(0, Math.round(height));
    if (!Number.isFinite(pixels) || pixels <= 0) return false;
    if (this.#used + pixels > this.cap) return false;
    this.#used += pixels;
    return true;
  }
}
