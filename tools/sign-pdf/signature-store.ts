/**
 * Sign PDF — signature library store.
 *
 * Drawn/typed/uploaded signatures persist in localStorage
 * ("docopdf.signatures") — the device only, exactly like the fill tool's
 * auto-fill profile (PRD §2.2: nothing ever leaves the browser). Quick
 * stamps (date/name/initials/checkmark) are session-only: they live for
 * the tab, so a shared computer never accumulates someone's "signed on"
 * dates.
 *
 * The store is the single source of truth for the tray UI (event bus like
 * the watermark logo store) AND for the run assets (config.collectAssets
 * ships each used signature to the worker as a PNG File named
 * "sig-<id>.png" — no data URLs in the options payload).
 */

export type SignatureKind = "draw" | "type" | "upload" | "stamp";

export interface StoredSignature {
  id: string;
  kind: SignatureKind;
  /** Tray label (the typed text, "Drawn", the file name, the stamp text). */
  label: string;
  dataUrl: string;
  /** Intrinsic pixel size of the PNG. */
  w: number;
  h: number;
  createdAt: number;
}

const KEY = "docopdf.signatures";
const EVENT = "docopdf:signatures-change";
const MAX_SAVED = 8;
/** ~1.2 MB of PNG payloads max — past that we drop the oldest. */
const MAX_STORE_CHARS = 1_200_000;

let savedCache: StoredSignature[] | null = null;
let sessionStamps: StoredSignature[] = [];
let seq = 0;

function readSaved(): StoredSignature[] {
  if (savedCache !== null) return savedCache;
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) {
      savedCache = [];
      return savedCache;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      savedCache = [];
      return savedCache;
    }
    const out: StoredSignature[] = [];
    for (const row of parsed) {
      if (typeof row !== "object" || row === null) continue;
      const r = row as Record<string, unknown>;
      if (
        typeof r.id !== "string" ||
        typeof r.dataUrl !== "string" ||
        !r.dataUrl.startsWith("data:image/png;base64,")
      ) {
        continue;
      }
      if (typeof r.w !== "number" || typeof r.h !== "number") continue;
      const kind =
        r.kind === "draw" || r.kind === "type" || r.kind === "upload" ? r.kind : "draw";
      out.push({
        id: r.id.slice(0, 40),
        kind,
        label: typeof r.label === "string" ? r.label.slice(0, 80) : "",
        dataUrl: r.dataUrl,
        w: Math.max(1, Math.round(r.w)),
        h: Math.max(1, Math.round(r.h)),
        createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
      });
    }
    savedCache = out;
    return savedCache;
  } catch {
    savedCache = [];
    return savedCache;
  }
}

function persist(): void {
  if (typeof window === "undefined") return;
  try {
    let list = [...readSaved()].sort((a, b) => a.createdAt - b.createdAt);
    while (list.length > MAX_SAVED) list.shift();
    let payload = JSON.stringify(list);
    while (payload.length > MAX_STORE_CHARS && list.length > 1) {
      list.shift();
      payload = JSON.stringify(list);
    }
    window.localStorage.setItem(KEY, payload);
    savedCache = list;
  } catch {
    // Quota/private mode: keep the in-memory copy — this tab still works.
  }
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (SSR) — nothing to notify */
  }
}

/** Session stamps first (most recent at hand), then saved signatures. */
export function listSignatures(): StoredSignature[] {
  return [...sessionStamps, ...readSaved()];
}

export function getSignature(id: string): StoredSignature | undefined {
  return listSignatures().find((sig) => sig.id === id);
}

export function addSignature(
  sig: Omit<StoredSignature, "id" | "createdAt">,
  opts: { persist?: boolean } = {}
): StoredSignature {
  const stored: StoredSignature = {
    ...sig,
    id: `s${Date.now().toString(36)}${(seq += 1).toString(36)}`,
    createdAt: Date.now(),
  };
  if (opts.persist === false) {
    sessionStamps = [stored, ...sessionStamps.slice(0, 7)];
    try {
      window.dispatchEvent(new Event(EVENT));
    } catch {
      /* SSR — nothing to notify */
    }
  } else {
    const saved = readSaved();
    savedCache = [stored, ...saved];
    persist();
  }
  return stored;
}

export function removeSignature(id: string): void {
  const saved = readSaved();
  const next = saved.filter((sig) => sig.id !== id);
  if (next.length !== saved.length) {
    savedCache = next;
    persist();
  } else {
    const nextStamps = sessionStamps.filter((sig) => sig.id !== id);
    if (nextStamps.length !== sessionStamps.length) {
      sessionStamps = nextStamps;
      try {
        window.dispatchEvent(new Event(EVENT));
      } catch {
        /* SSR — nothing to notify */
      }
    }
  }
}

export function subscribeSignatures(callback: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(EVENT, callback);
  return () => window.removeEventListener(EVENT, callback);
}

/**
 * Every library signature as a run asset File (used by collectAssets).
 * Only PNGs survive here — every creation path already rasterizes to PNG.
 */
export function signatureAssetFiles(): File[] {
  if (typeof window === "undefined") return [];
  const files: File[] = [];
  for (const sig of listSignatures()) {
    try {
      const base64 = sig.dataUrl.slice("data:image/png;base64,".length);
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      files.push(new File([bytes], `sig-${sig.id}.png`, { type: "image/png" }));
    } catch {
      // One unreadable entry never blocks the run.
    }
  }
  return files;
}
