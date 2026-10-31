/**
 * Limits client (R28) — the UX pre-check layer of the free-tier daily
 * task counter (docs/rules/16-BILLING-RESEARCH.md §4, decision D3).
 *
 * Design notes:
 *  - Module-level cache (30s TTL) — ToolShell mounts fetch once, not per
 *    tool switch. `bumpLocalUsage()` increments the cached counter after a
 *    successful run (optimistic; the beacon POST is the server truth).
 *  - Nudges are once-per-day per kind ("near" at ≥80%, "at" at 100%) via a
 *    dated localStorage flag — never nagging.
 *  - Shadow mode: while `hard` is false (no payment provider keys) nothing
 *    ever blocks; the "at" nudge is informational (beta = unlimited), the
 *    "near" nudge primes Pro pricing. The blocked path is only exercised
 *    when hard is true (auto-flips when Razorpay/Stripe keys land).
 * All failures are silent — limits must never break a tool run.
 */

import { readAnonId } from "@/lib/usage-beacon";

export interface LimitsSnapshot {
  plan: "free" | "pro";
  usedToday: number;
  maxToday: number;
  remaining: number;
  hard: boolean;
}

export type NudgeKind = "near" | "at";

let cache: { data: LimitsSnapshot; at: number } | null = null;
const CACHE_TTL_MS = 30_000;

const NEAR_FLAG = "sidocs-limit-nudge";

export async function fetchLimits(force = false): Promise<LimitsSnapshot | null> {
  if (typeof window === "undefined") return null;
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  try {
    const res = await fetch(`/api/limits?anonId=${encodeURIComponent(readAnonId())}`, {
      cache: "no-store",
    });
    if (!res.ok) return cache?.data ?? null;
    const data = (await res.json()) as LimitsSnapshot;
    cache = { data, at: Date.now() };
    return data;
  } catch {
    return cache?.data ?? null;
  }
}

/** After a successful run: optimistically count it and mark the cache for
 * refresh on the next fetch (server truth arrives with the next mount). */
export function bumpLocalUsage(): void {
  if (!cache) return;
  cache = {
    data: {
      ...cache.data,
      usedToday: cache.data.usedToday + 1,
      remaining: Math.max(0, cache.data.remaining - 1),
    },
    at: 0, // force refetch next time
  };
}

/** Which nudge (if any) applies to this snapshot. */
export function nudgeKind(snap: LimitsSnapshot | null): NudgeKind | null {
  if (!snap || snap.plan === "pro") return null;
  if (snap.usedToday >= snap.maxToday) return "at";
  if (snap.usedToday >= Math.ceil(snap.maxToday * 0.8)) return "near";
  return null;
}

/** One nudge per kind per UTC day (the counter's day boundary). */
export function markNudgeDone(kind: NudgeKind): void {
  try {
    const day = new Date().toISOString().slice(0, 10);
    window.localStorage.setItem(`${NEAR_FLAG}-${kind}`, day);
  } catch {
    /* storage unavailable — nudges may repeat; harmless */
  }
}

export function nudgeAlreadyShown(kind: NudgeKind): boolean {
  try {
    const day = new Date().toISOString().slice(0, 10);
    return window.localStorage.getItem(`${NEAR_FLAG}-${kind}`) === day;
  } catch {
    return false;
  }
}

/** Hard gate for startRun: true only when enforcement is live AND the free
 * quota is exhausted. Dormant in shadow mode by construction. */
export function runBlockedByLimits(snap: LimitsSnapshot | null): boolean {
  return Boolean(snap?.hard && snap.plan === "free" && snap.usedToday >= snap.maxToday);
}
