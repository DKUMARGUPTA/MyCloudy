"use client";

/**
 * Install-prompt store (Phase 7 PWA) — same module-store pattern as the
 * cookie banner: a custom event + useSyncExternalStore-friendly snapshot
 * helpers. `canInstall()` is true only when the browser fired
 * `beforeinstallprompt` (Chrome/Edge/Android; iOS Safari never fires it,
 * so the button simply stays hidden there — the honest path).
 */

const INSTALL_EVENT = "docopdf:pwa-change";

let deferredPrompt: Event | null = null;
let installed = false;

export function canInstall(): boolean {
  return deferredPrompt !== null && !installed;
}

export function isInstalled(): boolean {
  return installed;
}

export function subscribeToPwa(callback: () => void): () => void {
  window.addEventListener(INSTALL_EVENT, callback);
  return () => window.removeEventListener(INSTALL_EVENT, callback);
}

function emit(): void {
  window.dispatchEvent(new Event(INSTALL_EVENT));
}

/** Called by the PWA provider when the browser offers an install. */
export function captureInstallPrompt(event: Event): void {
  deferredPrompt = event;
  installed = false;
  emit();
}

/** Called when the app is installed (any heuristics path). */
export function markInstalled(): void {
  installed = true;
  deferredPrompt = null;
  emit();
}

/** Show the browser install dialog. Returns false if unavailable. */
export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  };
  await prompt.prompt();
  const choice = await prompt.userChoice;
  if (choice.outcome === "accepted") {
    markInstalled();
    return true;
  }
  deferredPrompt = null; // dismissed — hide the button until next offer
  emit();
  return false;
}
