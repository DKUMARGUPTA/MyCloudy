/**
 * In-memory sliding-window rate limiter (P12). Same pattern as the inline
 * limiter in /api/feedback — shared here for auth + admin + report routes.
 *
 * Per-instance only (fine for the single Next server + future single-node
 * deploy); swap for an edge/Redis limiter if the app ever scales out.
 */

type Timestamps = number[];

const buckets = new Map<string, Timestamps>();

export interface RateResult {
  ok: boolean;
  /** Seconds until the oldest hit leaves the window (0 when ok). */
  retryAfterSec: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateResult {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((ts) => now - ts < windowMs);
  if (hits.length >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000));
    buckets.set(key, hits);
    return { ok: false, retryAfterSec };
  }
  hits.push(now);
  buckets.set(key, hits);
  // Opportunistic sweep so the map cannot grow unbounded.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.every((ts) => now - ts >= windowMs)) buckets.delete(k);
    }
  }
  return { ok: true, retryAfterSec: 0 };
}

/** Best-effort client IP (gateway/proxy aware). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}
