/**
 * One-time DocoPDF → Sidocs storage migration (rebrand, v1.1.0).
 *
 * Copies every localStorage key that starts with the legacy "docopdf"
 * prefix to its "sidocs" twin (only when the new key is absent), then
 * removes the old key. Covers all key styles in the codebase:
 * "docopdf-favorites", "docopdf:locale-change" events are runtime-only
 * (not storage) and simply renamed in code; storage keys like
 * "docopdf.fill-profile" migrate via the same prefix swap.
 *
 * Safety:
 *  - Idempotent: re-running finds no legacy keys.
 *  - Runs at chunk-eval time (side-effect import in page.tsx), which is
 *    before the first React render — every store in this codebase reads
 *    localStorage lazily (getSnapshot / read helpers), never at module
 *    eval, so no read can race the migration.
 *  - Best-effort: private-mode storage failures just start fresh keys.
 */
if (typeof window !== "undefined") {
  try {
    const LEGACY_PREFIX = "docopdf";
    const NEXT_PREFIX = "sidocs";
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(LEGACY_PREFIX)) continue;
      const nextKey = NEXT_PREFIX + key.slice(LEGACY_PREFIX.length);
      if (window.localStorage.getItem(nextKey) === null) {
        const value = window.localStorage.getItem(key);
        if (value !== null) window.localStorage.setItem(nextKey, value);
      }
      toRemove.push(key);
    }
    for (const key of toRemove) window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable (private mode / quota) — fresh keys start empty */
  }
}
