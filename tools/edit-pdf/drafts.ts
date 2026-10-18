/**
 * Edit PDF — autosave drafts (P8.6, PRD §8.2 "autosave").
 *
 * Persists the editor's OBJECTS JSON (never file bytes — no OPFS blob
 * copies) into a private IndexedDB, keyed by the file's identity
 * (name + size + lastModified hash). Debounced ~1.5s by the surface.
 * Image objects reference assets by name only — a resumed draft needs the
 * same images re-added (the surface says so honestly).
 *
 * The store is schema-versioned: decodeDraft() refuses anything that is
 * not the current shape, so an old draft can never crash the editor.
 */

import type { EditorObject } from "./model";

/** Bump on any wire change — old drafts are rejected (decode → null). */
export const DRAFT_SCHEMA_VERSION = 1;
/** Drafts older than this are ignored + deleted (stale sessions). */
export const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface EditDraft {
  v: number;
  savedAt: number;
  objects: EditorObject[];
  page: number;
  zoom: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (bun-testable)
// ---------------------------------------------------------------------------

/** 32-bit FNV-1a of the file identity → stable draft key. */
export function draftKeyFor(
  name: string,
  size: number,
  lastModified: number
): string {
  const id = `${name}|${size}|${lastModified}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `d${(h >>> 0).toString(36)}`;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Serialises a draft (the exact wire format the store holds). */
export function encodeDraft(
  objects: EditorObject[],
  page: number,
  zoom: number
): string {
  return JSON.stringify({
    v: DRAFT_SCHEMA_VERSION,
    savedAt: Date.now(),
    objects,
    page,
    zoom,
  });
}

/**
 * Parses a stored draft. null for: garbage JSON, wrong schema version,
 * missing/non-array objects, absurd page/zoom or a stale save.
 */
export function decodeDraft(
  raw: string | undefined | null,
  now = Date.now()
): EditDraft | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o.v !== DRAFT_SCHEMA_VERSION) return null;
  if (!isFiniteNumber(o.savedAt)) return null;
  if (now - o.savedAt > DRAFT_MAX_AGE_MS) return null;
  if (!Array.isArray(o.objects) || o.objects.length === 0) return null;
  const page = isFiniteNumber(o.page) ? Math.max(0, Math.trunc(o.page)) : 0;
  const zoom = isFiniteNumber(o.zoom)
    ? Math.min(3, Math.max(0.75, o.zoom))
    : 1;
  return {
    v: DRAFT_SCHEMA_VERSION,
    savedAt: o.savedAt,
    objects: o.objects as EditorObject[],
    page,
    zoom,
  };
}

/** True when the draft carries image objects (assets must be re-added). */
export function draftHasImages(draft: EditDraft): boolean {
  return draft.objects.some((o) => o && o.kind === "image");
}

// ---------------------------------------------------------------------------
// IndexedDB (own tiny DB — no shared-store migration risk)
// ---------------------------------------------------------------------------

const DB_NAME = "docopdf-edit-drafts";
const DB_VERSION = 1;
const STORE = "drafts";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const request = run(db.transaction(STORE, mode).objectStore(STORE));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      })
  );
}

/** Persists the encoded draft (silent no-op when IDB is unavailable). */
export async function saveDraft(
  key: string,
  encoded: string
): Promise<void> {
  await tx("readwrite", (store) => store.put(encoded, key));
}

/** Loads + decodes a draft; null when absent/garbage/stale. */
export async function loadDraft(key: string): Promise<EditDraft | null> {
  const raw = await tx<string>("readonly", (store) => store.get(key));
  if (typeof raw !== "string") return null;
  return decodeDraft(raw);
}

/** Deletes a draft (Discard button, empty-object cleanup). */
export async function deleteDraft(key: string): Promise<void> {
  await tx("readwrite", (store) => store.delete(key));
}
