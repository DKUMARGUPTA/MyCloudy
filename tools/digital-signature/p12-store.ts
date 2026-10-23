/**
 * In-memory certificate store for the Digital signature tool
 * (RB6-FIN-a4).
 *
 * The SURFACE picks the user's .pfx/.p12 File; the WORKER receives it as
 * a run ASSET (config.collectAssets → request.assets) — the sign-store
 * / watermark logo-store bridge. Same-origin structured clone only.
 *
 * Memory only: the certificate and its password never touch
 * OPFS/IndexedDB/localStorage and die with the tab (mode D) — a signing
 * key is a secret you keep for exactly as long as you use it.
 */

const P12_EVENT = "docopdf:ds-p12-change";

let current: File | null = null;

export function setP12File(file: File | null): void {
  current = file;
  try {
    window.dispatchEvent(new Event(P12_EVENT));
  } catch {
    /* no window (SSR) — nothing to notify */
  }
}

export function getP12File(): File | null {
  return current;
}

/** Every picked certificate as a run asset File (collectAssets). */
export function p12AssetFiles(): File[] {
  return current !== null ? [current] : [];
}

export function subscribeToP12(callback: () => void): () => void {
  window.addEventListener(P12_EVENT, callback);
  return () => window.removeEventListener(P12_EVENT, callback);
}
