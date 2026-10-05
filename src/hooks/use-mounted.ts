"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * Returns true after hydration, false during SSR and the hydration render.
 * Canonical replacement for the setState-in-effect "mounted" pattern
 * (react-hooks/set-state-in-effect) — based on useSyncExternalStore.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}
