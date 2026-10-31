/**
 * P12 usage beacon — fire-and-forget POST /api/usage when a tool run
 * finishes (success or failure). Feeds the admin dashboard's usage
 * counters + top-tools chart; never blocks or surfaces errors.
 *
 * Privacy (PRD §14): metadata only — tool id, mode, success, duration
 * bucket inputs and an anonymous per-browser id. No file names, no
 * user id, no IP-based joins.
 */

const ANON_KEY = "sidocs-anon-id";

function anonId(): string {
  try {
    const existing = window.localStorage.getItem(ANON_KEY);
    if (existing && existing.length >= 8) return existing;
    const fresh =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(ANON_KEY, fresh);
    return fresh;
  } catch {
    return "anonymous";
  }
}

/** The shared anonymous id (R28 limit system) — same key the beacon uses,
 * so /api/limits counts exactly the runs /api/usage recorded. */
export function readAnonId(): string {
  return anonId();
}

function sizeBucket(bytes: number): "tiny" | "small" | "medium" | "large" {
  if (bytes < 1_048_576) return "tiny"; // < 1 MB
  if (bytes < 5_242_880) return "small"; // < 5 MB
  if (bytes < 26_214_400) return "medium"; // < 25 MB
  return "large";
}

/** Send one usage event; safe to call anywhere (never throws). */
export function sendUsageBeacon(params: {
  toolId: string;
  mode: "D" | "S";
  success: boolean;
  durationMs: number;
  inputBytes: number;
}): void {
  if (typeof window === "undefined") return;
  try {
    void fetch("/api/usage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolId: params.toolId,
        mode: params.mode,
        success: params.success,
        durationMs: Math.max(0, Math.min(600000, Math.round(params.durationMs))),
        sizeBucket: sizeBucket(params.inputBytes),
        anonId: anonId(),
      }),
      keepalive: true,
      cache: "no-store",
    }).catch(() => undefined);
  } catch {
    /* storage/network unavailable — analytics is best-effort only */
  }
}
