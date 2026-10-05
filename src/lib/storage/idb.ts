/**
 * Minimal promise-based IndexedDB wrapper (PRD §2.4).
 *
 * Object stores:
 * - "blobs":  id -> Blob   (working-copy fallback when OPFS is unavailable)
 * - "recent": id -> RecentFileEntry (metadata + thumbnail, max 20, 30 days)
 *
 * All data stays on the user's device — this store is never synced anywhere.
 */

const DB_NAME = "docopdf";
const DB_VERSION = 1;

export const BLOB_STORE = "blobs";
export const RECENT_STORE = "recent";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(BLOB_STORE)) {
          db.createObjectStore(BLOB_STORE);
        }
        if (!db.objectStoreNames.contains(RECENT_STORE)) {
          db.createObjectStore(RECENT_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB open failed"));
    });
  }
  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return requestToPromise(
    db.transaction(store, "readonly").objectStore(store).get(key)
  ) as Promise<T | undefined>;
}

export async function idbPut(
  store: string,
  value: unknown,
  key?: IDBValidKey
): Promise<IDBValidKey> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  const objectStore = tx.objectStore(store);
  return requestToPromise(
    key === undefined ? objectStore.put(value) : objectStore.put(value, key)
  );
}

export async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  await requestToPromise(
    db.transaction(store, "readwrite").objectStore(store).delete(key)
  );
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDb();
  return requestToPromise(
    db.transaction(store, "readonly").objectStore(store).getAll()
  ) as Promise<T[]>;
}

export async function idbClear(store: string): Promise<void> {
  const db = await openDb();
  await requestToPromise(
    db.transaction(store, "readwrite").objectStore(store).clear()
  );
}

/** Runtime feature detection (Safari 10+ has IDB; private mode may throw). */
export function isIdbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined";
  } catch {
    return false;
  }
}
