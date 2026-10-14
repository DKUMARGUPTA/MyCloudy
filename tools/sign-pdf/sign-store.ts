/**
 * In-memory signature store for the Sign PDF tool (PRD §7.6 "Sign PDF").
 *
 * The PANEL creates a normalized PNG File (drawn / typed / uploaded —
 * every path re-encodes to PNG before landing here); the preview SURFACE
 * mirrors it for the draggable overlay; the worker receives it as a run
 * ASSET (config.collectAssets). Same bridge as the watermark logo-store.
 *
 * Memory only: the signature never touches OPFS/IndexedDB/network and
 * dies with the tab (§2.2) — a signature is a secret you draw once.
 */

const SIG_EVENT = "docopdf:sign-signature-change";

let current: File | null = null;

export function setSignatureFile(file: File | null): void {
  current = file;
  try {
    window.dispatchEvent(new Event(SIG_EVENT));
  } catch {
    /* no window (SSR) — nothing to notify */
  }
}

export function getSignatureFile(): File | null {
  return current;
}

export function subscribeToSignature(callback: () => void): () => void {
  window.addEventListener(SIG_EVENT, callback);
  return () => window.removeEventListener(SIG_EVENT, callback);
}
