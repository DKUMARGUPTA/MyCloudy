"use client";

/**
 * Shared PWA client state (P7-PWA).
 *
 * A tiny external store (useSyncExternalStore) shared by the renderless
 * <ServiceWorkerRegister /> (toasts) and <PwaStatus /> (footer UI), so the
 * `beforeinstallprompt` event — which fires at most once per page load and
 * cannot be re-requested — is captured no matter which component mounts
 * first.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface PwaSnapshot {
  /** navigator.onLine (mirrored via online/offline events). */
  online: boolean;
  /** Captured install prompt, if the browser offered one. */
  installPrompt: BeforeInstallPromptEvent | null;
  /** Install flow in progress (prompt() is showing). */
  installing: boolean;
  /** App was installed via this prompt during this page session. */
  installed: boolean;
}

const SERVER_SNAPSHOT: PwaSnapshot = {
  online: true,
  installPrompt: null,
  installing: false,
  installed: false,
};

let snapshot: PwaSnapshot = SERVER_SNAPSHOT;
const listeners = new Set<() => void>();
let started = false;

function emit() {
  for (const listener of listeners) listener();
}

function set(patch: Partial<PwaSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  emit();
}

/** Idempotent — call from every consumer's mount effect. */
export function ensurePwaListeners(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  snapshot = { ...snapshot, online: window.navigator.onLine };

  window.addEventListener("online", () => set({ online: true }));
  window.addEventListener("offline", () => set({ online: false }));

  window.addEventListener("beforeinstallprompt", (event) => {
    // Suppress Chrome's mini-infobar — we show our own footer button.
    event.preventDefault();
    set({ installPrompt: event as BeforeInstallPromptEvent });
  });

  window.addEventListener("appinstalled", () => {
    set({ installPrompt: null, installed: true, installing: false });
  });
}

export function subscribePwa(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function getPwaSnapshot(): PwaSnapshot {
  return snapshot;
}

export function getPwaServerSnapshot(): PwaSnapshot {
  return SERVER_SNAPSHOT;
}

/**
 * Show the native install prompt. Returns the user's choice
 * ("accepted" | "dismissed") or "unavailable" if the event was consumed.
 */
export async function promptInstall(): Promise<
  "accepted" | "dismissed" | "unavailable"
> {
  const event = snapshot.installPrompt;
  if (!event) return "unavailable";
  set({ installing: true });
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
  } catch {
    return "unavailable";
  } finally {
    set({ installing: false });
  }
}
