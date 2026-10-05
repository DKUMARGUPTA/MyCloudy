import { BLOB_STORE, idbClear, idbDelete, idbGet, idbPut } from "./idb";

/**
 * Working-copy storage: OPFS first, IndexedDB Blobs as fallback (PRD §2.4).
 *
 * A "working file" is the in-flight copy of a user file that a tool is
 * currently processing. Rule (PRD §2.4): deleted right after the tool run
 * or on "Clear" — never persisted across sessions for its own sake.
 * Result files written here live only until chaining finishes or the user
 * leaves the tool.
 *
 * Nothing in this module ever touches the network.
 */

const WORK_DIR = "work";

export interface StorageEstimateInfo {
  usage: number;
  quota: number;
  /** True when less than ~10% quota or the estimate is unavailable. */
  lowSpace: boolean;
}

export function isOpfsAvailable(): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      navigator.storage !== undefined &&
      typeof navigator.storage.getDirectory === "function"
    );
  } catch {
    return false;
  }
}

async function workDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(WORK_DIR, { create: true });
}

/** Streams a Blob into OPFS without holding extra full-file copies. */
async function writeOpfs(id: string, blob: Blob): Promise<void> {
  const dir = await workDir();
  const handle = await dir.getFileHandle(id, { create: true });
  const writable = await handle.createWritable();
  await blob.stream().pipeTo(writable);
}

async function readOpfs(id: string): Promise<Blob | null> {
  try {
    const dir = await workDir();
    const handle = await dir.getFileHandle(id);
    return await handle.getFile();
  } catch {
    return null;
  }
}

async function deleteOpfs(id: string): Promise<void> {
  try {
    const dir = await workDir();
    await dir.removeEntry(id);
  } catch {
    /* already gone */
  }
}

/** Writes a working copy; OPFS when available, otherwise IndexedDB Blobs. */
export async function writeWorkingFile(id: string, blob: Blob): Promise<void> {
  if (isOpfsAvailable()) {
    await writeOpfs(id, blob);
    return;
  }
  await idbPut(BLOB_STORE, blob, id);
}

/** Reads a working copy back (null when it was already cleared). */
export async function readWorkingFile(id: string): Promise<Blob | null> {
  if (isOpfsAvailable()) {
    const blob = await readOpfs(id);
    if (blob) return blob;
  }
  return (await idbGet<Blob>(BLOB_STORE, id)) ?? null;
}

/** Deletes one working copy from whichever store holds it. */
export async function deleteWorkingFile(id: string): Promise<void> {
  if (isOpfsAvailable()) await deleteOpfs(id);
  await idbDelete(BLOB_STORE, id);
}

/**
 * Clears every working copy (after a run, on "Clear all", on cancel).
 * The recent-files store is untouched — it is metadata-only by design.
 */
export async function clearWorkingFiles(): Promise<void> {
  if (isOpfsAvailable()) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(WORK_DIR, { recursive: true });
    } catch {
      /* directory missing — nothing to clean */
    }
  }
  await idbClear(BLOB_STORE);
}

/**
 * Storage estimate check (PRD §2.4: warn before accepting when space is low).
 */
export async function getStorageEstimate(): Promise<StorageEstimateInfo | null> {
  try {
    if (navigator.storage?.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return {
        usage,
        quota,
        lowSpace: quota === 0 || usage / quota > 0.9,
      };
    }
  } catch {
    /* estimate unavailable */
  }
  return null;
}
