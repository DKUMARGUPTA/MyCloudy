/**
 * In-memory logo store for the watermark tool (PRD §8.2 "image/logo").
 *
 * The custom PANEL owns the upload button; the preview SURFACE needs the
 * same File for its canvas overlay, and the worker receives it as a run
 * ASSET (config.collectAssets) — this tiny store is the shared bridge.
 *
 * Memory only: the logo never touches OPFS/IndexedDB/network and dies with
 * the tab, exactly like the privacy rules demand (§2.2).
 */

const LOGO_EVENT = "docopdf:wm-logo-change";

let current: File | null = null;

export function setLogoFile(file: File | null): void {
  current = file;
  try {
    window.dispatchEvent(new Event(LOGO_EVENT));
  } catch {
    /* no window (SSR) — nothing to notify */
  }
}

export function getLogoFile(): File | null {
  return current;
}

export function subscribeToLogo(callback: () => void): () => void {
  window.addEventListener(LOGO_EVENT, callback);
  return () => window.removeEventListener(LOGO_EVENT, callback);
}
