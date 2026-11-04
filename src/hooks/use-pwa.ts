"use client";

import { useEffect, useSyncExternalStore } from "react";

import {
  ensurePwaListeners,
  getPwaServerSnapshot,
  getPwaSnapshot,
  subscribePwa,
  type PwaSnapshot,
} from "@/components/sidocs/pwa/pwa-store";

/**
 * Live PWA state (online/offline + install availability).
 * Also arms the window listeners on first use.
 */
export function usePwa(): PwaSnapshot {
  useEffect(() => {
    ensurePwaListeners();
  }, []);

  return useSyncExternalStore(subscribePwa, getPwaSnapshot, getPwaServerSnapshot);
}
