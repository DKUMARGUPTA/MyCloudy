/**
 * First-party page-view tracker (R42) — fire-and-forget POST
 * /api/analytics/view on the initial load and every hash-route change.
 *
 * Privacy (mirrors usage-beacon.ts): aggregate metadata only. The visitor
 * id is the SAME anonymous localStorage id the usage beacon and the limit
 * system use (no new identifier, no cookies, no cross-site tracking).
 * Device is a coarse class (matchMedia), the referrer is bucketed from
 * document.referrer, and the path is the normalized app route — no query
 * strings, so searches ("/tools?q=…") collapse to "/tools" and no free
 * text ever leaves the browser.
 *
 * Owner-only surfaces (/admin, /accounting) are skipped client-side and
 * rejected server-side: the owner's own sessions never pollute the data.
 */

import { readAnonId } from "@/lib/usage-beacon";

const DEVICES = ["mobile", "tablet", "desktop"] as const;
type Device = (typeof DEVICES)[number];

/** Coarse device class — no UA string, no fingerprinting. */
function deviceClass(): Device {
  try {
    if (window.matchMedia("(pointer: coarse) and (max-width: 767px)").matches)
      return "mobile";
    if (window.matchMedia("(min-width: 768px) and (max-width: 1023px)").matches)
      return "tablet";
    if (window.matchMedia("(min-width: 1024px)").matches) return "desktop";
  } catch {
    /* matchMedia unavailable — fall through */
  }
  return "desktop";
}

/** Bucket document.referrer to a label — the raw URL never leaves. */
function referrerBucket(): "direct" | "search" | "social" | "internal" | "other" {
  try {
    const ref = document.referrer;
    if (!ref) return "direct";
    const url = new URL(ref, window.location.origin);
    if (url.origin === window.location.origin) return "internal";
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (/google|bing|duckduckgo|yahoo|ecosia|brave|yandex|baidu/.test(host)) {
      return "search";
    }
    if (
      /facebook|instagram|twitter|x\.com|linkedin|reddit|pinterest|t\.co|whatsapp|telegram|youtube|quora|threads/.test(
        host
      )
    ) {
      return "social";
    }
    return "other";
  } catch {
    return "other";
  }
}

/**
 * Normalize a routeKey to the tracked path: strip the query, strip the
 * legacy "#/…" hash form, strip the /hi locale mirror prefix (locale is
 * its own column), collapse a trailing slash.
 */
export function normalizedPath(routeKey: string): string {
  let path = routeKey.split("?")[0];
  if (path.includes("#/")) path = path.slice(path.indexOf("#/") + 1);
  if (path === "" || path === "#") path = "/";
  if (path.startsWith("/hi")) path = path.slice(3) || "/";
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (!path.startsWith("/")) path = "/" + path;
  return path.slice(0, 120);
}

/** Module-level last-path: one row per route, not per re-render. */
let lastTracked: string | null = null;

/** Owner-only surfaces — never tracked. */
function isOwnerSurface(path: string): boolean {
  return path === "/admin" || path === "/accounting";
}

/** Send one page view; safe to call anywhere (never throws). */
export function trackPageView(routeKey: string, locale: "en" | "hi"): void {
  if (typeof window === "undefined") return;
  try {
    const path = normalizedPath(routeKey);
    if (path === lastTracked || isOwnerSurface(path)) return;
    lastTracked = path;
    void fetch("/api/analytics/view", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path,
        locale,
        device: deviceClass(),
        referrer: referrerBucket(),
        visitorId: readAnonId(),
      }),
      keepalive: true,
      cache: "no-store",
    }).catch(() => undefined);
  } catch {
    /* storage/network unavailable — analytics is best-effort only */
  }
}
