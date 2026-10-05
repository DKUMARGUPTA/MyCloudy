import { RECENT_STORE, idbClear, idbDelete, idbGetAll, idbPut } from "./idb";

/**
 * Recent files (PRD §2.4 + §6.1): metadata + thumbnail only, in IndexedDB.
 * Max 20 entries, 30-day TTL, user "Clear" — and NO file contents: we keep
 * the label the user saw and a tiny first-page thumbnail so the home strip is
 * useful, while the actual bytes live only while a tool is running.
 */

export const MAX_RECENT_FILES = 20;
export const RECENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type RecentKind = "pdf" | "image" | "other";

export interface RecentFileEntry {
  /** uuid — also the key in the "recent" store. */
  id: string;
  addedAt: number;
  kind: RecentKind;
  /** Display label, device-only — never sent to any server. */
  label: string;
  size: number;
  pageCount?: number;
  /** Tool this file was last used with (for the "continue" shortcut). */
  toolId?: string;
  /** Small page-1 render (Blob), shown as the thumbnail. */
  thumbnail?: Blob;
}

const CHANGE_EVENT = "docopdf:recent-change";

/** Stable empty reference — getSnapshot must never return a fresh array. */
const EMPTY_ENTRIES: RecentFileEntry[] = [];

function emitChange(): void {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(callback: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

let cached: RecentFileEntry[] | null = null;

function cacheSnapshot(): RecentFileEntry[] {
  return cached ?? EMPTY_ENTRIES;
}

/** Loads (once), prunes expired entries, then returns the list. */
export async function ensureRecentFiles(): Promise<RecentFileEntry[]> {
  const all = await idbGetAll<RecentFileEntry>(RECENT_STORE);
  const cutoff = Date.now() - RECENT_TTL_MS;
  const fresh = all.filter((entry) => entry.addedAt > cutoff);
  const expired = all.filter((entry) => entry.addedAt <= cutoff);
  for (const entry of expired) await idbDelete(RECENT_STORE, entry.id);
  fresh.sort((a, b) => b.addedAt - a.addedAt);
  cached = fresh;
  return fresh;
}

/** External-store subscription for React (hydration-safe: empty until loaded). */
export function subscribeRecentFiles(callback: () => void): () => void {
  return subscribe(callback);
}

export function getRecentFilesSnapshot(): RecentFileEntry[] {
  return cacheSnapshot();
}

/**
 * Adds/refreshes an entry, evicts past the 20 cap, and notifies listeners.
 * If an entry with the same label + size exists it is replaced (no dupes).
 * All mutations pass through a serialized write queue so concurrent calls
 * (React StrictMode double-mounts, rapid drops) can never race past the
 * dedupe and create duplicate entries.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueueWrite(operation: () => Promise<void>): Promise<void> {
  const run = writeQueue.then(operation, operation);
  writeQueue = run.catch(() => undefined);
  return run;
}

export function addRecentFile(
  entry: Omit<RecentFileEntry, "addedAt">
): Promise<void> {
  return enqueueWrite(async () => {
    const existing = await ensureRecentFiles();
    const deduped = existing.filter(
      (item) => !(item.label === entry.label && item.size === entry.size)
    );
    const next = [
      { ...entry, addedAt: Date.now() },
      ...deduped,
    ].slice(0, MAX_RECENT_FILES);
    for (const item of next) await idbPut(RECENT_STORE, item);
    cached = next;
    emitChange();
  });
}

export function removeRecentFile(id: string): Promise<void> {
  return enqueueWrite(async () => {
    await idbDelete(RECENT_STORE, id);
    cached = (await ensureRecentFiles()).filter((item) => item.id !== id);
    emitChange();
  });
}

/**
 * Removes every recent entry matching one of the given file metas
 * (label + size) — used by "Remove from device" for a tool run's inputs.
 */
export function removeRecentFilesByMeta(
  meta: { label: string; size: number }[]
): Promise<void> {
  if (meta.length === 0) return Promise.resolve();
  return enqueueWrite(async () => {
    const keys = new Set(meta.map((m) => `${m.label}|${m.size}`));
    const all = await ensureRecentFiles();
    const removed = all.filter((x) => keys.has(`${x.label}|${x.size}`));
    if (removed.length === 0) return;
    for (const entry of removed) await idbDelete(RECENT_STORE, entry.id);
    cached = all.filter((x) => !keys.has(`${x.label}|${x.size}`));
    emitChange();
  });
}

export function clearRecentFiles(): Promise<void> {
  return enqueueWrite(async () => {
    await idbClear(RECENT_STORE);
    cached = EMPTY_ENTRIES;
    emitChange();
  });
}

/** Refresh after an out-of-band change (e.g. another tab). */
export async function refreshRecentFiles(): Promise<void> {
  await ensureRecentFiles();
  emitChange();
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
