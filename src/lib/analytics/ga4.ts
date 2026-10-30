/**
 * GA4 analytics (P7-SEO Phase 6) — consent-gated, privacy-first.
 *
 * Design (master-plan rules):
 *  - ZERO network before consent: the gtag.js script is injected ONLY after
 *    the user accepts analytics in the cookie banner. Before that, only a
 *    local dataLayer shim exists (plain JS, no requests).
 *  - Google Consent Mode v2: analytics_storage / ad_storage / ad_user_data /
 *    ad_personalization all DEFAULT DENIED; flipped to granted on accept
 *    (and back to denied if consent is revoked later).
 *  - No PII ever: events carry only tool_slug / category / locale / mode and
 *    coarse buckets (size_bucket, duration_bucket, error_code) — never file
 *    names, file contents, extracted text or anything the user types.
 *  - Measurement ID: the production property G-ZP89M3KQDB is wired as the
 *    DEFAULT (owner-created, 2025-11). A GA id is a public identifier — it
 *    is visible in the HTML of every GA-enabled site — so it is safe in git.
 *    NEXT_PUBLIC_GA_ID still overrides it (set it in Vercel → Settings →
 *    Environment Variables to swap or kill the property without a redeploy).
 *    Set NEXT_PUBLIC_GA_ID=0 to explicitly disable analytics in a build.
 *  - No ad personalization, no Google signals — pure measurement.
 */

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
 * locally (no network, no dataLayer) and flushed ONLY if consent resolves
 * to granted; a denial discards them.
 */
type ConsentState = "unknown" | "granted" | "denied";
let consentState: ConsentState = "unknown";
const pendingEvents: { event: string; params: TrackParams }[] = [];
let scriptLoaded = false;
/* Production measurement ID (G-ZP89M3KQDB) unless overridden by env:
 * "0" disables analytics entirely; any other G-XXXX value wins. */
const GA_ID =
  process.env.NEXT_PUBLIC_GA_ID === undefined || process.env.NEXT_PUBLIC_GA_ID === ""
    ? "G-ZP89M3KQDB"
    : process.env.NEXT_PUBLIC_GA_ID === "0"
      ? undefined
      : process.env.NEXT_PUBLIC_GA_ID;

function loadGtagScript(): void {
  if (scriptLoaded || !GA_ID) return;
  scriptLoaded = true;
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);
  gtag("js", new Date());
  gtag("config", GA_ID, {
    anonymize_ip: true,
    send_page_view: true,
  });
}

function applyConsent(granted: boolean): void {
  consentState = granted ? "granted" : "denied";
  const value = granted ? "granted" : "denied";
  /* Consent Mode v2 — all four fields, always explicit. */
  gtag("consent", "update", {
    analytics_storage: value,
    ad_storage: value,
    ad_user_data: value,
    ad_personalization: value,
  });
  if (granted) {
    loadGtagScript();
    /* Flush events buffered while consent was still being restored (they
     * were never exposed to dataLayer, so a denial below discards them
     * without any trace ever leaving the page). */
    for (const buffered of pendingEvents.splice(0)) {
      gtag("event", buffered.event, buffered.params);
    }
  } else {
    pendingEvents.length = 0;
  }
}

/**
 * Boot GA4: install the consent-default (all denied), wire the cookie-banner
 * consent store, and — when analytics was already granted on a previous
 * visit — load gtag.js immediately.
 *
 * Call exactly once from <Ga4Boot /> (client). Safe to call when
 * NEXT_PUBLIC_GA_ID is unset — everything degrades to a no-op.
 */
export async function initGa4(): Promise<void> {
  if (!GA_ID) return;

  /* Default state — denied until the visitor opts in. */
  gtag("consent", "default", {
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    wait_for_update: 500,
  });

  /* Subscribe to the cookie-banner consent store (single owner of the
   * consent storage contract — dynamic import keeps this module free of
   * React component-graph side effects). */
  const consent = await import("@/components/doco/cookie-banner");
  const read = (): ConsentShape | null => consent.readConsent();
  consent.subscribeToConsent(() => applyConsent(read()?.analytics === true));

  /* Restore a previous grant (repeat visitor who already accepted). */
  if (read()?.analytics === true) {
    applyConsent(true);
  }
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

/** Whether GA4 is live in this build (env id present) — for smokes/debug. */
export function ga4Enabled(): boolean {
  return Boolean(GA_ID);
}
