/**
 * Stable getSnapshot factory for localStorage-backed stores used with
 * useSyncExternalStore (PRD §6.2 patterns).
 *
 * WHY THIS EXISTS (P3.1 lesson): a naive `() => JSON.parse(localStorage…)`
 * getSnapshot returns a NEW reference on every call → React detects an
 * infinite render loop. The fix: cache the parsed value keyed on the RAW
 * storage string — the same raw string always yields the same reference,
 * and only a real storage change (re-read returning a different raw)
 * produces a new object.
 *
 * Also guards:
 * - SSR / no window → returns the caller's fallback (referentially stable).
 * - localStorage throws (privacy mode, quota) → treated as "missing".
 * - parse throws on corrupt JSON → the caller's fallback.
 */

export function createLocalSnapshot<T>(
  key: string,
  parse: (raw: string) => T,
  fallback: T
): () => T {
  let cachedRaw: string | null = null;
  let cachedValue: T = fallback;
  let hasRead = false;

  return function localSnapshot(): T {
    if (typeof window === "undefined") {
      return fallback;
    }

    let raw: string | null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      raw = null;
    }

    if (!hasRead || raw !== cachedRaw) {
      hasRead = true;
      cachedRaw = raw;
      if (raw === null) {
        cachedValue = fallback;
      } else {
        try {
          cachedValue = parse(raw);
        } catch {
          cachedValue = fallback;
        }
      }
    }

    return cachedValue;
  };
}
