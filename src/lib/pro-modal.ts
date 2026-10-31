/**
 * Pro modal opener (R28) — a tiny pub/sub so deep surfaces (tool limit
 * nudges, future upsells) can open the pricing modal without prop-drilling
 * an onGetPro callback through the whole tree. app-shell subscribes once.
 */

const EVENT = "docopdf:open-pro";

export function openProModal(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function subscribeOpenPro(callback: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = () => callback();
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
