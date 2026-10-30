/**
 * GA4 analytics (P7-SEO) — Google Consent Mode v2, consent-gated measurement.
 *
 * HOW THE TAG IS LOADED (2026-11 rework — the "tag not found" fix):
 *  - The Google tag (consent-default inline + gtag.js + config inline) is
 *    SERVER-RENDERED in src/app/layout.tsx, so it appears in the raw HTML of
 *    every page — exactly the placement Google's installation wizard scans
 *    for. The previous "inject the script only after consent" approach was
 *    invisible to that scan (GA4 kept emailing "we haven't found a Google
 *    tag"). This is Google's standard Consent Mode v2 pattern.
 *  - PRIVACY IS UNCHANGED IN SUBSTANCE: the consent default is DENIED on all
 *    four fields, so before opt-in the tag runs cookieless — no _ga cookies,
 *    no measured hits (Google discards GA4 hits fired while analytics_storage
 *    is denied). The ad_* fields stay denied FOREVER — we run no ads.
 *  - Returning visitors who already granted consent are restored by a
 *    synchronous inline script BEFORE gtag.js executes, so their first
 *    page_view is measured with no race and no double-count.
 *
 * THIS MODULE handles the dynamic half:
 *  - subscribing to the cookie-banner consent store;
 *  - pushing consent updates when the visitor decides (or revokes later);
 *  - buffering events that fire before the consent state is known, flushing
 *    them on grant, discarding them on denial (see the track() docblock —
 *    this is what saves the mount-time tool_view on direct tool landings);
 *  - re-sending page_view when consent is granted mid-session (the
 *    config-time one fired while denied and was discarded by Google);
 *  - deleting GA cookies on revoke (consent hygiene — Google keeps the
 *    cookies otherwise).
 *
 * Everything no-ops when GA_MEASUREMENT_ID is unset.
 */

import { GA_MEASUREMENT_ID } from "@/lib/analytics/ga4-id";

/* ----------------------------- gtag shim ----------------------------- */

type GtagArgs = [command: string, ...rest: unknown[]];

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: GtagArgs) => void;
  }
}

function gtag(...args: GtagArgs): void {
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push(args);
}

/* ----------------------------- consent ------------------------------- */

interface ConsentShape {
  analytics: boolean;
  savedAt: number;
}

/*
 * Consent race fix: track() can fire BEFORE initGa4() has finished reading
 * the stored consent (its cookie-banner import is async). A direct landing
 * on /tool/<id> from Google fires tool_view within the first effects —
 * without buffering, that event (the site's most valuable one) was silently
 * dropped. Events captured while consent is still "unknown" are buffered
 * locally (no network exposure) and flushed ONLY if consent resolves to
 * granted; a denial discards them.
 */
type ConsentState = "unknown" | "granted" | "denied";
let consentState: ConsentState = "unknown";
const pendingEvents: { event: string; params: TrackParams }[] = [];

const GA_ID = GA_MEASUREMENT_ID;

function flushPending(): void {
  for (const buffered of pendingEvents.splice(0)) {
    gtag("event", buffered.event, buffered.params);
  }
}

/** Delete any _ga* cookies Google set (revoke hygiene — they are path=/). */
function clearGaCookies(): void {
  if (typeof document === "undefined") return;
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]?.trim() ?? "";
    if (!/^_ga/.test(name)) continue;
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

/**
 * Boot GA4: mirror the stored consent into the internal state and subscribe
 * to live consent changes from the cookie banner.
 *
 * The SSR'd inline scripts in layout.tsx have already (a) queued the consent
 * default (all denied) and (b) restored a returning visitor's grant BEFORE
 * gtag.js executed — so this function never needs to push a boot-time
 * consent update; it only syncs `consentState` so track() routes correctly
 * and flushes anything buffered during the async-import window.
 *
 * Call exactly once from <Ga4Boot /> (client). No-op when the measurement
 * id is unset (e.g. NEXT_PUBLIC_GA_ID=0).
 */
export async function initGa4(): Promise<void> {
  if (!GA_ID) return;

  const consent = await import("@/components/doco/cookie-banner");
  const read = (): ConsentShape | null => consent.readConsent();

  const stored = read();
  if (stored === null) {
    /* Fresh visitor — banner decision pending: keep buffering. */
    consentState = "unknown";
  } else {
    consentState = stored.analytics ? "granted" : "denied";
    if (consentState === "granted") flushPending();
  }

  /* Live changes: banner accept / reject, or a revoke from the footer
   * "Privacy settings" link (same tab event) or another tab (storage). */
  consent.subscribeToConsent(() => {
    const wasGranted = consentState === "granted";
    const granted = read()?.analytics === true;
    consentState = granted ? "granted" : "denied";
    /* Only analytics_storage ever flips — ad_* stay denied (no ads, ever). */
    gtag("consent", "update", {
      analytics_storage: granted ? "granted" : "denied",
    });
    if (granted) {
      flushPending();
      /* Re-send the page view ONLY on a real grant transition (not on a
       * no-op re-save of an existing grant): the config-time page_view fired
       * while denied and was discarded by Google, so this is what counts
       * the accepted session's landing page. */
      if (!wasGranted) {
        gtag("event", "page_view", {
          page_title: document.title,
          page_location: window.location.href,
        });
      }
    } else {
      pendingEvents.length = 0;
      clearGaCookies();
    }
  });
}

/* ------------------------------ events ------------------------------- */

/** Event parameter values — primitives only, never PII. */
export type TrackParams = Record<string, string | number | boolean>;

/**
 * Push an analytics event.
 *
 *  - consent "granted"  → pushed to dataLayer immediately.
 *  - consent "unknown"  → buffered locally (initGa4 has not finished reading
 *    the stored choice yet); flushed on grant, discarded on denial. This is
 *    what saves the mount-time tool_view on direct tool-page landings.
 *  - consent "denied"   → silently dropped (so a revoked banner also
 *    silences mid-session events).
 */
export function track(event: string, params: TrackParams = {}): void {
  if (!GA_ID) return;
  if (consentState === "denied") return;
  if (consentState === "unknown") {
    pendingEvents.push({ event, params });
    return;
  }
  gtag("event", event, params);
}

/** Whether GA4 is live in this build (id present) — for smokes/debug. */
export function ga4Enabled(): boolean {
  return Boolean(GA_ID);
}
